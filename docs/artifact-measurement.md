# Artifact measurement (`derived`, rules version `artifact-derived/4`)

This is what `src/artifact.mjs` and `src/operations.mjs` do today. They answer one question: of the output tokens Claude produced, how many became text written into files, how many went into commands and tool calls, and what is left over. It is a dashboard measurement. It is not a SigRank metric and has no effect on any score, class or board submission.

The artifact lane shows four tiers, each with its own provenance grade:

| Tier | Grade | What it is |
| --- | --- | --- |
| 1 | `reported` | Claude Code's own OpenTelemetry counters: lines added and removed, commits, pull requests, edit decisions by language. Counted by the provider. |
| 2 | `derived` | The text Claude generated into files, read from the edit payloads in your local transcripts. Chars and lines are exact counts of that text. Tokens are chars times a rate fit from your own data. |
| 2b | `derived` | The text of the shell commands and MCP calls Claude made (work done by commands, not by file edits), sorted into categories. Counts are exact. Tokens are chars times the same fitted rate as tier 2. |
| 3 | `estimated` (label: residual · by difference) | Reported output tokens minus the tier-2 tokens minus the tier-2b tokens. Not measured. |

## Tier 2: what is counted

Only generated text, from `tool_use` blocks in `~/.claude/projects/**/*.jsonl` (the same transcripts the backfill reads, including subagent transcripts):

| Tool | Counted | Never counted |
| --- | --- | --- |
| `Edit` | `new_string` | `old_string`, the file path |
| `Write` | `content` | the file path |
| `MultiEdit` | every `edits[].new_string` | every `old_string` |
| `NotebookEdit` | `new_source` (nothing for `edit_mode: delete`) | the notebook path |

Per edit the module keeps: session id, time, class, chars (JavaScript string length) and lines (newline count, a trailing newline does not start a line). The text itself and the file path are read at compute time, used to pick the class, and dropped. Nothing is written to disk by this module. The API serves class × day counts and window totals, and never content, paths, file names, repo names or any identity.

Transcripts are read in the background and re-read incrementally (only appended bytes). A transcript that Claude Code has deleted or rotated is gone from the numbers. Records copied into resumed or forked sessions are counted once, by `tool_use_id`.

## Which edits count (the join)

Each edit carries a `tool_use_id`. Claude Code's telemetry emits a `claude_code.tool_decision` event with the same id and a `decision` of `accept` or `reject`. The join works like this:

1. The edit has a decision in OTel: it is **joined**. A `reject` is dropped. An `accept` counts.
2. The edit has no decision in OTel: it is **not joined**. This is expected for everything before telemetry began, and for edits made after the receiver stopped hearing from Claude Code. It still counts, because the transcript shows the tool ran.
3. Joined or not, an edit whose transcript `tool_result` has `is_error: true` is dropped as **failed** (the file text never landed). A rejected edit is counted as rejected, not as failed.
4. An edit with no `tool_result` at all is counted. Interrupted edits are rare, and none were seen when this was built.

The API reports `seen`, `joined`, `unjoined`, `rejected`, `failed`, `counted`, `countedJoined` and `countedUnjoined`. Join coverage is `joined / seen`, shown as raw counts, never rounded into a claim. Edits that only exist in transcripts because the OTel copy being read is older than the transcripts also show as not joined.

## Classes (shared classifier, `src/classify.mjs`)

The class comes from the shared classifier: path role first (agent and coordination scaffolding, ops and deploy files, shell and automation scripts, `~/.config`), file extension second. Classes are `code`, `infra`, `docs`, `config`, `other`. The full rule tables, the ambiguous cases and the operator override format are in [docs/classification.md](classification.md). A `NotebookEdit` cell is docs when `cell_type` is `markdown` and code otherwise.

Tier 2 classifies the transcript's absolute path, so a role directory above the repo (a repo kept under a folder named `ops`, `deploy`, `scripts` or `.config`) counts for the files in it, while git-local classifies repo-relative paths and does not see it. The one exception handled is a Claude Code worktree (`<repo>/.claude/worktrees/<name>/...`): roles are judged from the worktree root down in both. The classifier version is `classify/2` and is reported at the top level of `/api/artifact`.

`infra` is a label that splits the count, not a ranking. A `CLAUDE.md` or a skill file is infra, where extension alone would call it docs. A `.plist` or `vercel.json` is infra, where extension alone would call it config. Tier 2 reads only `Edit`/`Write`-style payloads. Infra done by commands (`gh`, `launchctl`, `vercel`, `supabase`, `cloudflared`, MCP calls) is measured in tier 2b below, by category.

## Chars to tokens: fit from your own data

Transcripts give characters. Telemetry gives reported `output_tokens` per API request (`claude_code.api_request`, joined to the transcript by request id). The module finds the rate from both:

1. Take every request that has reported output tokens and generated at least 200 chars of file text.
2. Keep requests that are almost all generated file text: all other text in the request (assistant text, other tool inputs, tool names) is at most 10% of the generated chars. This keeps planning prose and shell commands from diluting the rate.
3. Fit `output_tokens = a + b × chars` by ordinary least squares. The slope `b` is tokens per char. The intercept `a` absorbs per-request overhead (the tool-call wrapper, thinking), so overhead is not charged to the file text.
4. Fit per class (code, infra, docs, config, other) on requests where one class is at least 90% of the generated chars. A class needs at least 30 requests (infra often does not yet, and then uses the pooled fit; `ratio.source.infra` says which), a positive slope and R² of at least 0.5 to use its own rate. Otherwise it uses the pooled fit over all kept requests (same minimums). If even that fails it uses a constant of 0.454 tokens per char, the slope already used for typed prompts in `score.mjs` (`typedTokens`).

The fit uses all the history it has, not only the window, so the rate does not move when you change windows. The API returns the rate used per class (`ratio.tokensPerChar`, `ratio.charsPerToken`), where each came from (`ratio.source`: `class fit`, `pooled fit` or `constant`), and each fit's request count, R² and intercept.

Read it as: the rate is an estimate with a good fit, not a tokenizer count. Generated text costs more tokens per char than ordinary prose here (roughly 2 to 2.5 chars per token), because tool arguments travel as escaped JSON. It differs by class and can drift with the model. Tokens carry a `≈` in the dashboard.

## Tier 2b: operations (`operations/2`, `src/operations.mjs`)

Tier 2 sees files. A lot of infrastructure work is done by commands and tool calls instead: a deploy, a `launchctl bootstrap`, a migration, a `gh pr create`, a Vercel MCP call. Tier 2b measures those from the same transcripts. It is a label that splits a count. It never ranks one category above another, and it never ranks operations against code or infra files.

**Which tool calls are operations.**

| Tool | In tier 2b | What is counted |
| --- | --- | --- |
| `Bash` | yes | `input.command`, the command string, heredoc bodies included. `description`, `timeout` and the JSON wrapper are not counted |
| `Monitor` | yes | `input.command`, same rules as `Bash` |
| any `mcp__<server>__<tool>` | yes | the length of the call's input JSON |
| `Edit`, `Write`, `MultiEdit`, `NotebookEdit` | no | tier 2 counts these |
| `Read`, `Grep`, `Glob`, `LS`, `WebFetch`, `WebSearch`, `TodoWrite` | no | pure reads; they generate almost no output |
| `Agent`, `Task`, `Workflow`, `SendMessage` | yes, as `orchestration` | the whole input as JSON (subagent prompt, workflow script, message): delegation is generated work |
| everything else (`Skill`, `Artifact`, `ToolSearch`, `StructuredOutput`, `AskUserQuestion`, cron and wakeup tools and so on) | no | not measured; their arguments stay in the residual |

**Categories.** One category per call, chosen in memory by `src/operations.mjs`. The command text and MCP input are read to pick the category and dropped. Only the category, day, call count and char count are kept.

| Category | Matches (first word of a command segment, and for some tools the subcommand) |
| --- | --- |
| `deploy-hosting` | `vercel`, `wrangler`, `cloudflared`, `netlify`, `fly`/`flyctl`, `docker`/`docker-compose`/`podman`, `kubectl`, `helm`, `terraform`/`tofu`, `heroku`, `railway`, `aws`, `gcloud`, `az`, `firebase`, `ngrok`, `pulumi`, `serverless`, `doctl`; `supabase functions deploy`; Vercel MCP write tools |
| `data` | `supabase` (other than functions deploy), `psql`, `sqlite3`, `mysql`, `duckdb` when the SQL writes (or cannot be read as a plain select), `pg_dump`, `pg_restore`, `redis-cli` writes, `prisma`, `drizzle-kit`, `alembic`, `knex`; Supabase MCP writes, `apply_migration`, and `execute_sql` that contains a write statement |
| `service-config` | `launchctl`, `systemctl`, `crontab`, `defaults` (write, delete), `brew services` (not list or info), `pmset`, `scutil`, `networksetup`, `dscl`, `pm2`, `caddy`, `nginx`, `plutil` (not read-only); any file operation or redirect aimed at a system path (`LaunchAgents`, `LaunchDaemons`, `/etc`, `~/.config`, `~/.claude`, `~/.local/share`, `~/.ssh`, `/usr/local`, `/opt/homebrew`, `/Library`, shell profiles, `.gitconfig`); Stripe MCP writes |
| `package` | `npm`/`pnpm`/`yarn`/`bun` install, add, remove, update, link, publish, `audit fix`; `pip`/`pip3`/`python -m pip` install and uninstall; `uv`, `poetry`, `conda` installs; `cargo install/add`, `go get/install/mod`, `gem`, `bundle install`, `brew install/upgrade/update/tap`, `apt`, `nvm`, `asdf` and similar |
| `vcs` | `git` and `gh` commands that change something: `add`, `commit`, `push`, `pull`, `fetch`, `checkout`, `merge`, `rebase`, `clone`, `stash push`, `gh pr create`, `gh api` with a non-GET method or fields |
| `build-test-run` | `node`, `deno`, `python`, `pytest`, `tsc`, `eslint`, `vite`, `next`, `make`, `cargo build/test/run`, `go build/run/test`, `npm run`/`test`/`start`, `bash script.sh`, `./script`, `bash -c` (judged by the inner command), inline scripts (`node -e`, `python - <<EOF`); MCP calls that drive a browser (click, type, evaluate, run code) |
| `file-ops` | `mkdir`, `rm`, `mv`, `cp`, `touch`, `ln`, `chmod`, `chown`, `rsync`, `tar` create or extract, `sed -i`, `sort -o`, `tee`, `mktemp`, `find` with `-delete` or `-fprint`, `find -exec` / `fd -x` running a file operation, `curl -o/-O/-J` and `wget` (which saves to a file unless `-O -` or `--spider`), and any command whose output is redirected into a file (`echo x > f`), outside system paths. The text of a heredoc written into a file (`cat > f <<EOF`, `cat <<EOF > f`, `tee f <<EOF`) is counted here by its own rule, see **Heredoc file text** |
| `orchestration` | `Agent` and `Task` subagent prompts, `Workflow` scripts, `SendMessage` messages to running agents. Never from a shell command, so it takes no part in compound-command precedence |
| `other` | a command that matches nothing above (`open`, `kill`, `osascript`, `ssh`), a command made only of shell glue (`cd`, `sleep`, variable assignments), `curl` with a write method or body, MCP writes on servers with no category (Gmail send, Figma writes) |
| `inspection` | `ls`, `cat`, `head`, `tail`, `grep`, `rg`, `find` (without `-delete`, `-fprint` or a writing `-exec`), `wc`, `stat`, `ps`, `lsof`, `jq`, `diff`, `echo` and `printf` without a redirect, `git status/log/diff/show/blame`, `git branch` (list), `git remote -v`, `gh pr view/list/status`, `gh api` GET, `curl` GET without an output file or `wget --spider`, `sed` and `awk` without `-i`, read verbs of the deploy, data and service CLIs (`vercel ls`, `docker ps`, `launchctl list`, `defaults read`, `crontab -l`, `kubectl get`), and MCP `get`/`list`/`search`/`read`/`query` calls, including browser snapshots and screenshots |

**Compound commands.** The command is split on `&&`, `||`, `;`, `|`, `&`, newlines, subshells and backticks, outside quotes. Heredoc bodies are removed before splitting (they are text, not commands, and do not vote on the category), and a `<<` inside quotes (`node -e "1 << x"`) or arithmetic is not a heredoc. Process substitution (`<(...)`, `>(...)`) is a nested command, not a segment of its own. Their length still counts, see **Heredoc file text**. Each part gets a category, glue such as `cd`, `export`, `sleep`, `for` and `if` is skipped, and the **most consequential category present** is the call's category. Precedence, highest first: `deploy-hosting`, `data`, `service-config`, `package`, `vcs`, `build-test-run`, `file-ops`, `other`, `inspection`. So `git commit && vercel --prod` is `deploy-hosting`, `npm install && npm test` is `package`, and `ls && cat x | head` is `inspection`. Wrappers (`sudo`, `env`, `nohup`, `timeout`, `xargs`, `npx`, `bash -c`) are stripped and the command they run is judged. A `>` redirect to a real file makes an otherwise read-only or unknown command `file-ops`; redirects to `/dev/null` and `2>&1` do not.

The categorizer is a table of rules, not a parser. A command it cannot place is `other`. Cases it gets wrong in either direction (a path held in a variable, a `curl | sh`, a shell function defined earlier) land in the category the rules give. The categories are a label, so a miss moves a count, not a score. `scripts/test-operations.mjs` checks the rule table against a list of cases.

**The join and failures.** Same as tier 2. Each call carries a `tool_use_id`, and the OTel `claude_code.tool_decision` event with that id says `accept` or `reject`. Rejected calls are dropped. A call whose transcript `tool_result` has `is_error: true` is dropped as **failed**, and the API reports the count and the estimated tokens of those arguments (`failedTokens`). Those tokens were still generated, so they stay in the residual. Claude Code marks any non-zero exit as an error, so a `grep` with no match or a failing test counts as failed; the transcript does not say which. A call with no OTel decision is **not joined** but is counted, since the transcript shows it ran. For MCP calls OTel names the tool generically, so the id is the only join. The API reports `seen`, `joined`, `unjoined`, `rejected`, `failed`, `counted`, `countedJoined`, `countedUnjoined`. Join coverage is `joined / seen` as raw counts.

**Tokens.** Tokens = chars × the **pooled** fit from the chars-to-tokens section above (not a per-class rate), disclosed as `ratio.operations`. Per-call overhead (the tool-call wrapper, the tool name, JSON keys) is not charged to the command text, so it stays in the residual. The rate is the same for every category and does not change the fit tier 2 uses. A one-off check on 2026-10-21 (not computed by the code) regressed reported output tokens on `Bash` command chars alone, over 6,093 requests that were almost all one `Bash` command, and got 0.495 tokens per char (R² 0.61) against a pooled 0.451. So tier 2b tokens for shell commands are probably about 10% low.

**Inspection is overhead, not work.** The model generates inspection commands too, so they come out of the output total. They are shown on their own row, labeled "overhead, not artifact", and are never added into the operations subtotal (`work`). `total` is the two together.

**Heredoc file text.** A command is one category, chosen by precedence, so `cat > watcher/notices.py <<'EOF' ... EOF` followed by `python3 -m pytest` is `build-test-run`, and the heredoc body is often most of its characters. So a heredoc whose body is written into a file is split off: `cat > f <<EOF`, `cat <<EOF > f`, `cat <<EOF >> f` and `tee f <<EOF`, with `sudo` allowed and a `| tee f` after the marker allowed, but not `> /dev/null` and not a heredoc fed to another command (`python3 - <<EOF`, `psql <<EOF`, a commit message). Those body characters are counted under the write: `file-ops`, or `service-config` when the write lands on a system path (a LaunchAgent plist, `~/.config`). The rest of the command's characters stay in the call's own category, and the call is counted once, in that category. Characters are conserved. The consequence is that the `file-ops` call count is the number of commands whose main action was a file operation, while its characters and tokens include file text written by commands that did something else too. The API reports that part separately as `heredocFiles` (calls, chars, tokens), which is already inside the category rows and is not added again. This is still a command, not a file edit: the body is not classed code, infra or docs, and it is not in tier 2. `build-test-run` is the command text that is not a file write, git, deploy and the like, so the row is not only tests and builds.

**Inline scripts.** A script written inline (`node -e`, `python3 - <<EOF`) is generated code, but a command runs it and it is not written to a file, so it lands in `build-test-run`, not in tier 2 `code`. A file written by `cat > f <<EOF` has its body counted in `file-ops` (see above). Neither is merged into the tier-2 file classes.

## Code share of output and the residual

Reported output tokens exist only from the first live telemetry event, so the ratio is taken over the **paired span** (from the later of the window start and the first live event), like the git counts. A whole-window line is shown separately when the two differ and has no share.

- **Code share of output** = tier-2 code tokens ÷ reported output tokens, over the paired span. Numerator and denominator come from the same sessions: only edits in sessions that have reported API rows in the span are counted. Reported output uses the same population as the dashboard's `ship.outputReported` (reported rows, harness calls excluded). Labelled `derived`, with the method in the hover and this doc one click away.
- **Per-class shares** (infra, docs, config, other) are computed the same way.
- **Residual · by difference** = reported output tokens − all tier-2 file-text tokens − all tier-2b operation tokens, inspection included. It holds planning, narration, retries, thinking, the arguments of tools not in tier 2b, the arguments of failed calls, and per-call wrappers, and it is not measured. It is never presented as thinking. If the estimates ever exceed reported output, the residual is floored at 0 and flagged `overrun`. The API also returns `residual.beforeOperations`, the tier-2-only residual, so the change is visible.
- **Operation shares** (`shares.operations`) are per category, plus `work` (everything but inspection), `inspection` and `total`, computed over the paired span with the same session pairing as tier 2.

Both shares are volume ratios of where output tokens went. They say nothing about quality, correctness or whether the text was kept.

## Limits

- Tier 2 reads `Edit`/`Write`-style payloads only. A file written by a shell command (`cat > file <<EOF`, `sed -i`, a code generator) is not an `Edit`/`Write` call: it is not in the tier-2 classes. The text of a heredoc written into a file is counted in tier 2b `file-ops` (see Heredoc file text); a file written by a program the command runs, or by a redirect of another command's output, is only the command's own text.
- A rewritten file counts again each time it is written. Churn is not netted out.
- File writes made by tools other than the four listed are not counted in tier 2. An MCP call that writes a file is in tier 2b, by its category.
- Tier 2b cannot see inside a script run by name (`./deploy.sh`, `make deploy`). It is `build-test-run`, whatever it does, and the text of that script was generated earlier as a file edit (tier 2, infra when it is a script).
- Output from sessions with no transcript on this machine is in the denominator and not in the numerator.
- Logged (transcript-built) output is a floor for subagent messages whose transcript usage was never finalized (about 9% of 2026-05 to 07 requests and most of 2026-10-11 to 10-14). The artifact lane reads reported rows only, so it is not affected. Evidence, estimate and the off-by-default fix: docs/backfill-output-undercount.md.
- Transcripts include `claude -p` test runs. Telemetry counts those too, so the span matches; the pre-telemetry backfill skips them.

## What the API serves

`GET /api/artifact?days=N` returns: status (`pending` until the first read finishes, then `ready`), the rate table (with `ratio.operations`), `operationsRules` (the categorizer version) `classifier` (the classifier version, at the top level, not per block) and two blocks (`window` and `paired`). Each block has edit join counts, class totals (edits, chars, lines, tokens) for all five classes and a per-day class table. Each block also has `operations`: call join counts, `via` (shell and MCP call counts), `categories` (calls, chars, tokens for each of the nine categories), `work`, `inspection` and `total` subtotals (`total` is the commands and MCP calls only, not every tool's arguments), `heredocFiles` and a per-day category table. `paired` also has `reportedOutput`, `shares` and `residual`. Tier 2b serves category × day counts only: no commands, paths, tool or server names, hostnames, project refs or environment variable names exist in the payload. `transcriptsFromMs` is the earliest transcript record on disk: edits before it are unknown, not zero, and the dashboard says so when a window starts earlier. `days` must be 0, 1, 7, 30 or 90 (anything else is a 400). The export snapshot keeps all of it (aggregates only).
