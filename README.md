# sigrank-otel

A local OpenTelemetry receiver for Claude Code, plus a dashboard that scores your usage the way SigRank does (C:I:O pillars, Υ, class). Claude Code sends its telemetry to `127.0.0.1:4318`, the receiver writes it to a file on your machine, and the dashboard reads that file.

Status: working prototype (v0.1.0). Known issues are listed in [`docs/audit-2026-10-20.md`](docs/audit-2026-10-20.md).

## Install

Needs Node 18 or newer.

```
npx github:SunrisesIllNeverSee/sigrank-otel-public setup --dry-run   # shows what it would change, writes nothing
npx github:SunrisesIllNeverSee/sigrank-otel-public setup             # does it
npx github:SunrisesIllNeverSee/sigrank-otel-public doctor            # checks everything works
```

From a clone, `npm install` and then `node src/cli.mjs <command>` works the same way. If the package is installed, the command is `sigrank-otel-cc`.

`setup` does three things:

1. Backs up `~/.claude/settings.json` once, as `settings.json.sigrank-otel-backup`.
2. Adds the telemetry keys Claude Code needs to that file's `env` block. Your other settings are not touched.
3. Starts the receiver at every login: a macOS LaunchAgent (`com.sigrank.otel-cc`) or a Linux `systemd --user` service.

Then restart Claude Code once and open http://127.0.0.1:4318/.

| Command | What it does |
|---|---|
| `setup [--dry-run]` | Settings + autostart + prints the dashboard link |
| `doctor` | Is the receiver up, are the settings in place, how old is the last event, is token-cascade found |
| `start` | Run the receiver in this terminal (no autostart) |
| `uninstall [--env]` | Remove autostart. `--env` also removes the telemetry settings (and restores any values the backup had) |

## What it stores and sends

**Stored locally.** Everything goes to `~/.local/share/sigrank-otel/otel.jsonl`. Before a record is written, the receiver drops identity and content fields: `user.*` (email, account id), `organization.id`, prompt text, response text, and system prompt previews (`src/receiver.mjs`, the `DROP` pattern). Session ids, token counts, costs, tool names and timings are kept.

**Sent off the machine.** Only two outbound calls exist:

| Call | When | What goes out |
|---|---|---|
| `POST https://signalaf.com/api/plugins/sigrank/mcp` | When the dashboard's Board view is open (cached 5 min) | A read-only leaderboard query. None of your telemetry is sent. |
| `POST https://signalaf.com/api/v1/snapshots` | Only when you press Submit, **and** `allowSubmit` is on in config, **and** you have a sigrank-mcp identity | A signed snapshot of your window totals. Without `allowSubmit` this is a preview that sends nothing. |

Nothing else leaves the machine. The receiver listens on loopback only.

**Read-only guard.** If you expose the dashboard through a tunnel or proxy, any request that isn't from loopback (non-loopback `Host`, or a `CF-Connecting-IP` / `X-Forwarded-For` header) can only `GET` the dashboard and `/api/*`. It cannot submit, write, or read `/api/config` (`src/receiver.mjs`, `isLocal`).

## Settings (all optional)

Settings live in `~/.config/sigrank-otel/config.json`. An environment variable overrides the file.

| Setting | Environment variable | Default |
|---|---|---|
| `port` | `SIGRANK_OTEL_PORT` | 4318 |
| `dataDir` | `SIGRANK_OTEL_DATA_DIR` | `~/.local/share/sigrank-otel` |
| `codename` | `SIGRANK_OTEL_CODENAME` | none (your row on the public board is not highlighted) |
| `cascadePath` | `SIGRANK_OTEL_CASCADE_PATH` | automatic |
| `retentionDays` | `SIGRANK_OTEL_RETENTION_DAYS` | keep everything |
| `allowSubmit` | `SIGRANK_OTEL_ALLOW_SUBMIT=1` | off |
| `mcpPath` | `SIGRANK_OTEL_MCP_PATH` | a local sigrank-mcp checkout (needed only for Submit and the SigRank row) |

`node src/receiver.mjs <port> <file>` overrides the port and output file.

token-cascade (the scoring library) comes from this package's own dependency. If it's missing, the receiver tries `cascadePath` and then a local sigrank-mcp checkout.

## Layout

| File | Role |
|---|---|
| `src/receiver.mjs` | OTLP/HTTP receiver (JSON and protobuf), scrubs records, serves the dashboard and `/api/*` |
| `src/score.mjs` | Pillars, cascade, board rows |
| `src/sessions.mjs` | Per-session list and popup (rank, percentiles, median comparison) |
| `src/history.mjs` | Daily log (a day ends at 05:00) and milestones |
| `src/usage.mjs` | Per-model usage windows |
| `src/extras.mjs` | Υ calculator, model detail, deltas, SVG card, board submit |
| `src/backfill.mjs` | Imports Claude Code transcripts from before telemetry started (no cost or tool timings, since transcripts don't carry them) |
| `src/export.mjs` | Builds a single static HTML snapshot of the dashboard with personal fields removed |
| `src/cli.mjs` | `setup` / `doctor` / `start` / `uninstall` |
| `src/dashboard.html` | The dashboard (Board · Sessions · Daily · Milestones views) |

## Docs

- [`docs/audit-2026-10-20.md`](docs/audit-2026-10-20.md): independent audit of labels, numbers and pipeline. This is the known-issues list.
- [`docs/dashboard-map.md`](docs/dashboard-map.md): what each dashboard surface reads.
- [`docs/TODO.md`](docs/TODO.md): open work.
- [`docs/superpowers/specs/2026-10-15-claude-otel-destination-design.md`](docs/superpowers/specs/2026-10-15-claude-otel-destination-design.md): original design.

## Not in this repo

This is a public snapshot of a private working repo. Internal planning notes, multi-agent coordination files and private research stay in the private repo.
