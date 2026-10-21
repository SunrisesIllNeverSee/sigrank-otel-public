# Git counting rules (`git-local`, rules version `git-local/3`)

This is what `src/git.mjs` does today. It is a shadow measurement: it sits beside Claude Code's own OpenTelemetry counters (`reported`) and replaces nothing. It is not a SigRank metric and has no effect on any score, class or board submission.

A `git-local` number is counted from local git history on this computer. Anyone with the same clones, the same identity list and these rules gets the same number.

## What is counted

Your commits, in repos your Claude Code sessions worked in, anchored to commit time:

- commits, lines added, lines deleted, net (added minus deleted), and files touched, after the exclusions below.
- Nothing else. Churn (lines added and then deleted inside the window) is not computed: it needs per-line history, which `--numstat` does not give. The API returns `churn: null`.

These are all of your commits in those repos, not only lines Claude wrote. Hand-written commits, other tools' commits and Claude's commits count the same. The dashboard's "committed net lines / 1K output" divides all of them by Claude's reported output tokens, so read it as a volume ratio and an upper bound.

### Claude co-authored subset

Inside the counted commits, a commit whose `Co-authored-by:` trailers include one naming Claude (the trailer value contains `noreply@anthropic.com`, or starts with `Claude`) is also counted in `claude` (commits, added, removed, net, after the same exclusions). Claude Code adds that trailer to the commits it makes, so this is the like-for-like numerator: "Claude co-authored net lines / 1K output" divides it by Claude's reported output tokens. It undercounts when a trailer was removed or a commit was made by hand from Claude's edits, so it is the conservative number; the all-commits ratio is the generous one.

## Which repos

1. Working directories come from Claude Code transcripts: every `"cwd"` value found in the first and last 64 KB of each top-level `~/.claude/projects/<project>/<session>.jsonl` whose file was modified inside the window. A session that changed directory in the middle of a long transcript can be missed. Sessions that ran in a parent folder of several repos find none of them.
2. Each directory resolves with `git rev-parse --show-toplevel --git-common-dir`. Repos are deduplicated by common git dir, so a repo and its worktrees count once. Directories that are not in a repo are skipped.
3. Default scope: repos whose checkout is under your home folder. Scratch directories under `/private/tmp` fall out here.
4. `~/.config/sigrank-otel/config.json` can narrow or widen that:

```json
{
  "git": {
    "enabled": true,
    "allow": ["~/Developer"],
    "deny": ["~/Developer/day-job"],
    "authors": ["me@example.com"],
    "coAuthored": false
  }
}
```

- `deny` always wins. A repo is denied if any of its checkout paths, or its main checkout, is inside a denied path.
- If `allow` is non-empty, only repos inside an allowed path count, and the home-folder default no longer applies.
- `enabled: false`, or the environment variable `SIGRANK_OTEL_GIT=0`, turns the collector off. The API then answers `status: "disabled"`.
- Paths accept a leading `~`.

## Which commits

- `git log --branches HEAD --no-merges` in each repo: every local branch, plus the checked-out HEAD, once each. Remote-tracking refs are not read. Merge commits are skipped.
- Author scope: the commit's author email (`%ae`) must equal, ignoring case, your `git config user.email` in that repo or an address in `git.authors`. A repo with neither is skipped (counted under `skipped["no-identity"]`). `.mailmap` is not consulted.
- With `"coAuthored": true`, a `Co-authored-by:` trailer carrying one of your addresses also counts the commit. Default is off.
- Window: a commit counts when its committer time (`%ct`) is inside the window. The start is the exact window start (the same instant the OTel numbers use, to the minute); the end is the moment of the count. Git is asked for a week of extra history and the exact test is made in code, because `--since` can stop early on out-of-order dates.

### Window-drift caveat

The OTel counters count a line when Claude Code writes it. Git counts it when you commit. A line written on Monday and committed on Wednesday is in Monday's OTel window and Wednesday's git window, and an edit that is never committed is in OTel only. Short windows (24h, 7d) can disagree for that reason alone. Longer windows converge.

### Telemetry-paired span

OTel counters exist only from the first live telemetry event, so a 30d or 90d window holds OTel counters for fewer days than it holds git history. The dashboard therefore shows git twice when the two differ: a "paired" count over the span where OTel counters exist (the one used for side-by-side comparison and for "committed net lines / 1K output") and a whole-window count.

## Which lines (exclusions)

Lines come from `--numstat -M -w`: renames and copies are followed (a pure rename counts nothing), and whitespace-only changes are ignored. A file is dropped from adds, deletes and files touched when its new path matches any rule below. The first match is the one reported.

| Rule | Matches |
| --- | --- |
| binary | numstat reports `-` for the file |
| lockfile | file name is one of: `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`, `bun.lockb`, `Cargo.lock`, `poetry.lock`, `Pipfile.lock`, `uv.lock`, `pdm.lock`, `composer.lock`, `Gemfile.lock`, `go.sum`, `Podfile.lock`, `flake.lock`, `mix.lock`, `pubspec.lock`, `packages.lock.json`, `gradle.lockfile` (in any directory) |
| vendored | any directory segment above the file is `node_modules`, `vendor`, `third_party`, `dist` or `build` |
| minified | file name matches `*.min.*` |
| data | file name ends in `.tiktoken`, `.csv`, `.tsv`, `.jsonl`, `.ndjson` or `.parquet` (data and vocabulary files are loaded, not written) |
| attr | `git check-attr` reports `linguist-generated` or `linguist-vendored` as set (`set` or `true`) |

## Per-class split

After the exclusions, each remaining file is classed by the shared classifier ([docs/classification.md](classification.md)): `code`, `infra`, `docs`, `config`, `other`. The API adds `byClass` (files, added, removed, net per class; the classes sum to the totals) and the `classifier` version. A file's class comes from its new path. The path picks the class and is dropped. Files outside any git repo (`~/.claude`, `~/.config`, `~/Library/LaunchAgents`) are not in git and so not here; tier 2 of the artifact lane sees them when Claude edits them. Changing `classify` overrides in the config invalidates the git cache.

Consequences you should know:

- `dist` and `build` are matched by name anywhere in a path, so source in a folder called `build/` is excluded too.
- The `attr` rule reads the `.gitattributes` of the checkout now, not as of each commit.
- A commit whose files are all excluded still counts as a commit.
- No cap is applied to large commits. A one-time import of a big source tree counts in full.

The totals in the API also carry what each rule removed (`excluded.files`, `excluded.added`, `excluded.removed`), so the exclusions are visible.

## Reverts

Counted as they are. A commit and the revert of it both add and delete lines, and both count. Nothing nets them out.

## Squash merges, cherry-picks

Not deduplicated. Because every local branch is read, the same change committed on a feature branch and again as a squash or cherry-pick on `main` counts twice. Rebased branches that share no commit hashes with the old tip are not matched either.

## Caching and speed

- Results are cached per repo by branch tips + HEAD, window start (to the minute) and identity list. Nothing moved means no new `git log`.
- A served window is re-checked in the background at most once per minute, and keeps serving its last count (marked `refreshing`, never older than 2 hours) while the next one runs. The API answers from cache and never waits on git: before the first count finishes it reports `status: "pending"`.
- Each git call has a 2 minute limit; a repo that exceeds it is counted under `skipped.error`. At most 3 git processes run at once.
- Git is run read-only with `GIT_OPTIONAL_LOCKS=0`. Nothing in a repo is written.

## What the API serves

`GET /api/git?days=N` (N is 0, 1, 7, 30 or 90; anything else is a 400) returns, per window (`window`, and `paired` for the telemetry-paired span): status, window bounds, repo count, commits, added, removed, net, files, exclusions, skipped counts and the rules version.

- Anyone reaching the receiver from outside this computer gets aggregate counts only (including `byClass` totals).
- On localhost the response also lists per-repo counts (folder name, commits, added, removed, net, files, the same per-class split and the Claude co-authored subset).
- Never served or stored: file contents, file paths, absolute paths, branch names, commit hashes or messages, author names or emails.
- The export snapshot (`src/export.mjs`) keeps the aggregate counts and drops the per-repo list.
