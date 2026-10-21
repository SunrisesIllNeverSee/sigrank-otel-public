---
type: Assessment
title: sigrank-otel dashboard — what exists, what's strong, what's missing
timestamp: 2026-10-15
---

# Dashboard map: existing · strong · gaps

Scope: everything in `src/` as of commit 3f7cbe7, running on the owner's Mac. Numbers verified 2026-10-15 (raw recount = dashboard; cascade output = hand formulas; main-thread transcripts = OTel exactly).

## 1. Pipeline (data in → numbers out)

| Piece | What it does | Strong | Gap |
|---|---|---|---|
| **Receiver** `receiver.mjs` | OTLP/HTTP JSON on 127.0.0.1:4318; flattens logs/metrics/traces; scrubs identity + content; drops hook/plugin noise | Zero dependencies; privacy scrub at the door; verified no duplicates | JSON only (no protobuf/gzip); hard-coded port/paths/codename; no health/version endpoint |
| **Storage** `data/otel.jsonl` | Append-only event log | Simple, lossless, greppable | Grows forever (no rotation/retention); reparsed on restart |
| **History** `backfill.mjs` | Imports transcripts before telemetry; gap-fills by request_id; skips SDK runs (claude-mem) | Global dedupe; nothing double counted or dropped | Manual run; subagent output ~2.5× low in transcripts (not fixable); not labelled as transcript-sourced in UI |
| **Scoring** `score.mjs` | Sums pillars by window/model/source/day; calls token-cascade | Same metric code as TUI + board; verified exact | token-cascade path is hard-coded to sigrank-mcp's node_modules; whole-file rescan per poll |
| **History views** `history.mjs` | 05:00 dailies + milestones | Works all-time | Milestone thresholds fixed; no per-model or per-project milestones yet |
| **Sessions** `sessions.mjs` | Sessions as "tanks": rank, percentiles, median comparison, project from transcript cwd | The BlitzStars idea working on real data | Project name needs transcripts on disk; eligibility thresholds fixed |
| **Board proxy** | Pulls public SignalAF board via MCP endpoint, 5-min cache | Live comparison to #1 and your row | Read-only; can't submit; 24h maps to 7d |
| **Ops** LaunchAgent | Auto-start, auto-restart | Survives reboots | Mac-only; restarts lose in-flight batches (seen: a few requests) |

## 2. Screens

| View | Has | Strong | Gap |
|---|---|---|---|
| **Header** | Live dot, Board/Sessions/Daily/Milestones, Raw/Metrics, 24h–All | One switch for everything; remembers choices | No settings, no help, no "submit" |
| **Strip (8 tiles)** | Raw: totals/pillars/requests/cost · Metrics: Υ, SNR, Vel, Lev, 10x, Scale V, C:I:O, rank | Big-number glance | No explanations; typed vs logged input not explained |
| **Board table** | YOU typed / logged, board #1 + your row, sources, models | Looks like the real leaderboard | Two "YOU" rows confuse newcomers; columns unexplained |
| **Operator readout** | Big Υ, class, composition, vs #1, Four Degrees ladder | The "who am I" panel | Ladder meaning not explained |
| **Shipped · pace · cache** | Lines ±, commits/PRs, edit accept %, pace, cache hit, per-day bars | Shows work, not just tokens | Lines only since telemetry; empty for history |
| **Tools** | Calls, OK %, avg time, rejects | Real behaviour signal | No link to sessions; MCP names truncated |
| **Live feed / Sessions tab** | Every API/tool/prompt event, flashes new rows | The "it's alive" moment | Fast-scrolling noise; no filter |
| **Sessions view** | Ranked table, project filter, eligibility, decile colours | Strongest new screen | No search; no date range inside |
| **Session popup** | Median · This · Diff (18 stats), percentile bars, curve, models, tools, project top-10, prev/next | BlitzStars-grade depth | No shareable link/URL; curve has no axes labels beyond ends |
| **Daily** | 05:00 log, click → models | Familiar format | History days unmarked; no streak shown here |
| **Milestones** | 60 events, typed icons | Fun, motivating | No "new since last visit"; no notification |

## 3. Understanding (the owner's #1 concern)

- **Strong:** everything is visible in one screen; colours match the board; ranks and percentiles give context ("Top 44%").
- **Gaps:**
  - No plain-language explanation of Υ, Velocity, Leverage, SNR, 10×Dev, Scale V, class, C:I:O, Four Degrees.
  - No first-run state: a new user sees an empty grid.
  - Two input definitions shown side by side with no explanation.
  - No "what should I do to improve" guidance (the Υ calculator idea).

## 4. Portability (can someone else run it?)

- **Strong:** dependency-free Node; one folder; settings.json block documented in README.
- **Gaps:** hard-coded `$HOME` paths, hard-coded owner codename, token-cascade location, LaunchAgent plist; no installer (`npx sigrank-otel-cc setup`); no Windows/Linux autostart; no update path.

## 5. Board connection

- **Strong:** reads the live public board; same metric code.
- **Gaps:** no submit button (sigrank-mcp's snapshot path exists, not wired); no `source: otel-cc` metadata; operator identity is a hard-coded codename.

## 6. BlitzStars features (from FEATURE-INDEX.md)

| Done | Not yet |
|---|---|
| P2 overview · P10 dailies · P5 milestones · P11/P12 models table · P15 session popup (self side) · P7/P8 by-model breakdown | P3/P4 30-60-90 deltas · P16 Υ calculator · A4 operator card image · model popup · P13/P14 field ranks & norms (needs board data) · P17 decile colours on all metrics · P6 graded awards |

## Priority read

1. **Explain the numbers** (tooltips + one-line view notes) and **first-run state**: biggest gap vs the owner's goal.
2. **Mark transcript-sourced history** so verified vs estimated is clear.
3. **Portability + setup command**: needed before anyone else can use it.
4. **Submit to board** through the existing snapshot path.
5. **BlitzStars set:** 30/60/90 deltas, Υ calculator, operator card, model popup.
6. **Hardening:** log rotation, protobuf, faster incremental scoring.
