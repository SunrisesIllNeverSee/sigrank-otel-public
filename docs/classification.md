# File classification (`classify/2`)

This is what `src/classify.mjs` does today. One classifier is shared by tier 2 of the artifact lane (`derived`, `src/artifact.mjs`) and by the git-local collector (`src/git.mjs`), so a file lands in the same class in both, with one difference: tier 2 sees the absolute path from a transcript and git-local a repo-relative one, so a role directory above the repo root (a repo kept under a folder named `ops`, `scripts`, `deploy` or `.config`) counts in tier 2 only. A Claude Code worktree (`<repo>/.claude/worktrees/<name>/`) is handled: roles are judged from the worktree root down, in both. It is a label that splits a count. It does not weigh one class above another, and it has no effect on any SigRank score, class threshold or board submission.

`classify(path)` returns one of `code`, `infra`, `docs`, `config`, `other`. Path **role** rules run first, the file extension second.

## Why infra is its own class

Agent and coordination scaffolding, skills, hooks, settings, CI, deploy and database config and automation scripts are real work and are not code, docs or config in the usual sense. Classed by extension alone they scatter into docs (`CLAUDE.md`, scratchpads) and config (`.json`, `.yaml`, `.plist`), and work done by shell commands never shows up as a file at all. The `infra` class keeps the first kind together so it can be read next to code.

## Order of evaluation

1. Operator overrides from `~/.config/sigrank-otel/config.json` (below).
2. Role rules. First match wins. A **strong** role takes every file under it, Markdown included. A **weak** role leaves docs-extension files (`md`, `mdx`, `markdown`, `txt`, `rst`, `adoc`, `asciidoc`, `tex`, `org`) as docs, so `scripts/README.md` stays docs while `scripts/deploy.mjs` is infra.
3. Extension table.
4. Extension-less file names, then dotfiles (config), then `other`.

A path under `.claude/worktrees/<name>/` is judged from that worktree root, so `<repo>/.claude/worktrees/a/src/x.ts` is code, not `agent:dir`; a `.claude` directory inside the worktree still counts. Paths are lowercased only for the extension. A leading home folder is stripped first, so `~/.claude/...` and `~/.config/...` match the same rules as a repo's `.claude/...`. Paths are used in memory to pick a class and are never stored, served or exported.

## Role rules (infra)

| Rule id | Strength | Matches |
| --- | --- | --- |
| `agent:file` | strong | file name `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `GEMINI.md`, `SKILL.md`, `.mcp.json`, `.claude.json`, `claude_desktop_config.json`, `.cursorrules`, `.windsurfrules`, `copilot-instructions.md` |
| `agent:dir` | strong | any directory segment `.claude`, `.coord`, `.repo`, `.proofpress`, `.devin`, `.claude-plugin`, `.codex-plugin`, `.cursor`, `.codex`, `.gemini`, `.agents`, `.windsurf` (skills, agents, commands, hooks, settings, plugin manifests, scratchpads, handoffs) |
| `env:example` | strong | `.env.example`, `.env.sample`, `.env.template`, `.env.dist`. Never `.env`: that stays `config`, and no file contents are read anyway |
| `shell:dotfile` | strong | `.zshrc`, `.zprofile`, `.zshenv`, `.zlogin`, `.bashrc`, `.bash_profile`, `.profile`, `.gitconfig`, `.tmux.conf`, `.vimrc`, `.inputrc` |
| `ops:container` | strong | `Dockerfile*`, `*.dockerfile`, `.dockerignore`, `docker-compose*.y(a)ml`, `compose.y(a)ml` |
| `ops:deploy` | strong | `vercel.json`, `wrangler.toml/json/jsonc`, `netlify.toml`, `fly.toml`, `render.y(a)ml`, `railway.json/toml`, `nixpacks.toml`, `serverless.y(a)ml`, `firebase.json`, `.vercelignore` |
| `ops:ci` | strong | `.gitlab-ci.yml`, `.travis.yml`, `azure-pipelines.yml`, `cloudbuild.yaml`, `buildspec.yml`, `bitbucket-pipelines.yml`, `dependabot.yml`, `renovate.json(5)`, `.pre-commit-config.yaml`, `lefthook.yml`, `taskfile.yml` |
| `ops:ci-dir` | weak | `.github/workflows/**` and `.github/actions/**`. Other `.github` files (issue templates, `CODEOWNERS`) fall through to their extension |
| `ops:proxy` | strong | `nginx.conf`, `Caddyfile`, `haproxy.cfg`, `cloudflared*.yml` |
| `ops:service` | strong | `*.plist`, `*.service`, `*.timer`, `*.socket`, anything under `Library/LaunchAgents` or `Library/LaunchDaemons` |
| `ops:terraform` | strong | `*.tf`, `*.tfvars`, `*.hcl` |
| `ops:db` | weak | `supabase/migrations/**`, `supabase/config.toml`, `supabase/seed.sql`, and any `*.sql` under a directory named `migrations`, `migration` or `migrate`. Other `.sql` files stay `code`. `supabase/functions/**` stays `code` |
| `ops:dir` | weak | any directory segment `.circleci`, `.husky`, `.devcontainer`, `.cloudflared`, `cloudflared`, `nginx`, `caddy`, `k8s`, `kubernetes`, `helm`, `terraform`, `ansible`, `docker`, `infra`, `infrastructure`, `deploy`, `deployment`, `devops`, `ops`, `launchd`, `launchagents`, `launchdaemons`, `systemd` |
| `env:config-dir` | weak | any directory segment `.config` (so `~/.config/**`) |
| `shell:dir` | weak | any directory segment `scripts`, `bin`, `cron` |

Extension-table infra (no role needed): `sh bash zsh fish command` (shell), `plist service timer socket`, `tf tfvars hcl`; extension-less `Makefile`, `Procfile`, `Brewfile`, `Caddyfile`, `Jenkinsfile`, `Justfile`, `Vagrantfile`.

## Extension table (after the roles)

| Class | Extensions |
| --- | --- |
| code | js mjs cjs jsx ts tsx mts cts py pyi rb go rs java kt kts swift c h cc cpp cxx hpp hh cs php ps1 sql css scss sass less html htm vue svelte astro lua r pl scala dart ex exs erl hs clj m mm graphql gql proto |
| docs | md mdx markdown txt rst adoc asciidoc tex org |
| config | json jsonc json5 yaml yml toml ini cfg conf env xml properties editorconfig |
| other | everything else, including csv, tsv, svg, jsonl, logs and unknown extensions |

Extension-less files by exact name: `Gemfile` is config; `README`, `LICENSE`, `CHANGELOG`, `NOTICE`, `AUTHORS`, `CONTRIBUTING` are docs. Any other file whose name starts with a dot and whose extension is not in the table above is config: `.gitignore`, `.npmrc`, `.env`, `.env.local`, `.env.production`, `.DS_Store`. A dotfile with a known extension follows it (`.eslintrc.cjs` is code), and `.env.example` and its siblings are infra. A `NotebookEdit` cell is docs when `cell_type` is `markdown` and code otherwise (tier 2 only).

## Ambiguous cases and where they land

- `scripts/*.mjs`, `bin/*.ts`, `*.sh`: infra. `scripts/README.md`: docs (weak role).
- `package.json`, `tsconfig.json`, `.gitignore`, other `*.json`/`*.yaml`: config, unless a role above matches (`vercel.json` is infra, `.mcp.json` is infra).
- `README.md`, `docs/**/*.md`, plans and notes: docs. The same file under `.claude/` or `.coord/` is infra (strong role).
- `src/**/*.ts`, tests, `src/hooks/useX.ts` (a React hook): code. The directory name `hooks` is not a role: it is too common in application code. Claude Code hooks live under `.claude/` and are infra by that.
- `skills/` or `agents/` outside `.claude`: only `SKILL.md` itself is infra by name. Other files there follow their extension.
- `.github/workflows/*.yml`: infra. `.github/ISSUE_TEMPLATE/*.md`: docs.
- A `.sql` file: code, except under a migrations directory (infra).
- A folder named `scripts`, `bin` or `deploy` inside application source is infra by name even when it holds product code. Use an override if that is wrong for you.

## Operator overrides

`~/.config/sigrank-otel/config.json` (read through `src/config.mjs`; the app never writes it):

```json
{
  "classify": {
    "infra": ["tools/agents/**", "*.runbook"],
    "code": ["scripts/keep-as-code/**"],
    "docs": [],
    "config": [],
    "other": []
  }
}
```

- Each key is a class, each value a list of glob patterns. Overrides run before every other rule. When two patterns match, the class listed first in the order `code`, `infra`, `docs`, `config`, `other` wins.
- `*` matches within one path part, `**` any depth, `?` one character. A pattern without `/` matches a file name anywhere. A pattern with `/` matches at any directory boundary; start it with `/` (repo-relative) or `~/` (home-relative) to anchor it. A trailing `/` means everything below.
- Read once at startup: restart the receiver to apply changes. The git cache key includes the override list, so git counts are recomputed after a change.

## What it does not see

- Work done by commands (`gh`, `launchctl`, `vercel`, `supabase`, `cloudflared`, MCP calls) leaves no file text in an `Edit` or `Write` payload. Tier 2 cannot count it; tier 2b (operations, in docs/artifact-measurement.md) measures it by category from the command and MCP call text. Git-local cannot count it.
- Files outside any git repository (`~/.claude`, `~/.config`, `~/Library/LaunchAgents`) are never in a git count. Tier 2 sees them when Claude edits them through `Edit`/`Write`.
- Classing is by path, not by content. A script that holds product logic is still infra when it lives in `scripts/`.
