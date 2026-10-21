---
type: Design
title: SigRank as a Claude OTel destination
status: draft — awaiting owner review
timestamp: 2026-10-15
---

# SigRank as a Claude OTel destination

> **REVISION 2026-10-15 (owner):** Name is `sigrank-otel-cc` (suffix = source; `-platform` etc. later). Data never leaves the machine except as scores — same model as sigrank-mcp → signalaf.com. The local collector + dashboard is the product; the hosted ingest/rollup service below (§1–§3) is **dropped for `-cc`**. Platform (needs a public HTTPS endpoint) gets its own decision in phase 2: no-store relay vs self-hosted collector. Sections below are kept for provenance and will be rewritten in the implementation plan.

## Goal

**The dashboard is the product.** Anyone using Claude points their OpenTelemetry at SigRank and immediately gets the live operator dashboard (Board · Sessions · Daily · Milestones · session popup) — the thing that makes SigRank understandable — plus a place on the leaderboard: **"Point your Claude OTel at SigRank. See yourself operate. Get ranked."**
The ingest endpoint is plumbing that feeds the dashboard; ranking is the hook that brings people back.

## What the owner decided (session 2026-10-15)

- tokenpull-otel is its own Claude-specific package; sigrank-mcp may use it but does not contain it (CAND-001).
- Micro detail stays out of signalaf.com until the site is built for it; the prototype is kept as-is until this design is agreed (CAND-002).
- Build **both** sources into **one endpoint**: Claude Code OTel first, Claude Platform OTel ("Custom" destination, public beta 2026-10-14) second.
- **A with a B option:** hosted endpoint is the default; self-host collector for people who want data to stay local.
- **The dashboard is everything** (owner, 2026-10-15): people barely understand SigRank as-is; the dashboard is how they will. Phase 1 ships the hosted dashboard, not just a board score.
- Full-content mode is supported (owner: turn it on) — used only to derive counts such as lines of code; text is discarded at the edge.

## Two sources, one endpoint

| | Claude Code OTel | Claude Platform OTel |
|---|---|---|
| Who | people coding in Claude Code (Pro/Max/API) | people building on the API, Agent SDK, Managed Agents |
| Setup | env block in `~/.claude/settings.json` + SigRank token | Console → OpenTelemetry → Custom → URL + header |
| Wire | OTLP/HTTP json or protobuf; logs + metrics (+ traces with beta) | OTLP/HTTP **protobuf**, gzip, **traces** with GenAI semantic conventions; HTTPS hostname :443; 5 s timeouts; at-least-once |
| Signals we use | `api_request`, `user_prompt`, `tool_result`, `lines_of_code.count`, `commit.count`, `active_time.total` | LLM spans: model, token usage (input/output/cache), tool spans; full-content mode → edits for LOC |
| Granularity | one operator per token | one Console org per token; members split by span identity (see Open questions) |

## Architecture

```
Claude Code ─┐                         ┌─> rollups (per operator · day · model · session)
             ├─ HTTPS OTLP ─> ingest ──┤
Platform  ───┘   otel.signalaf.com     └─> scorer (token-cascade) ─> /api/v1/snapshots ─> board
                 (Cloudflare Worker)      └─> HOSTED DASHBOARD otel.signalaf.com/<operator>  (same views as src/dashboard.html)
self-host (B): local receiver ─> local dashboard ─> scorer ─> /api/v1/snapshots
```

### 1. Ingest (`apps/ingest`, Cloudflare Worker at `otel.signalaf.com`)
- Routes `POST /v1/logs`, `/v1/metrics`, `/v1/traces`; accepts `application/json` and `application/x-protobuf`, gzip.
- Auth: `Authorization: Bearer <sigrank-otel-token>` (Claude Code via `OTEL_EXPORTER_OTLP_HEADERS`; Platform via the Console header list). Unknown token → 401. Answers in < 1 s; heavy work is queued.
- **Scrub at the edge:** the receiver's DROP rules (identity, prompt text, model output, system prompt) plus, in full-content mode, extract derived counts (LOC from edit/write tool inputs, prompt character length) and drop the text before anything is stored.
- Dedupe by `request_id` / span id (24 h window) — Platform delivery is at-least-once.

### 2. Normalizer (`packages/normalize`, shared by ingest and local receiver)
One record shape for both sources:
`{ operator, member?, source: 'claude-code'|'platform', ts, session, model, input, output, cacheRead, cacheWrite, cost, tools, toolFail, linesAdded, linesRemoved, promptChars? }`
- Claude Code: the mapping already in `src/receiver.mjs` + `src/score.mjs`.
- Platform: GenAI semconv span attributes (`gen_ai.request.model`, `gen_ai.usage.*`) → same fields.

### 3. Rollups (storage)
- Store **daily rollups**, not raw events: per operator × day × model × session (and × member for teams). Enough for 7d/30d/90d/all windows, dailies, sessions, milestones.
- Lives in the ingest service's own store (D1 or a separate Supabase schema) — **not** in the site's tables (CAND-002). Retention of rollups: indefinite; raw payloads: never stored.

### 4. Hosted dashboard (the product)
- `src/dashboard.html` ported as-is, served by the ingest service at `otel.signalaf.com/<operator>` (private link by default; signed-in view).
- Same API shape as the local receiver (`/api/summary`, `/api/sessions`, `/api/session`, board proxy) but read from rollups — so local (B) and hosted (A) are one codebase, one UI.
- Live: polls every few seconds; first event appears within seconds of connecting (the onboarding "aha").
- signalaf.com needs no change for this — it links to the dashboard and receives scores.

### 5. Scorer → existing submission path
- Hourly: rollups → `cascade(input, output, cacheWrite, cacheRead)` (token-cascade, same code as TUI/board) → snapshot submitted through the existing `/api/v1/snapshots` flow with a provenance label (e.g. `otel:claude-code`, `otel:platform`).
- The board needs no schema change for phase 1. A new provenance label is a canon/board decision → owner approval via Search Authority before launch.

### 6. Identity: operators, teams, members
- **Token = owner.** Personal token → personal operator row. Team token → team; spans split into members by identity attributes.
- Members can **claim** their member row and link it to their personal profile (BlitzStars player ↔ clan).
- One person can appear solo and in a team.

### 7. Onboarding (`signalaf.com/connect` + `npx tokenpull-otel setup`)
- Connect page: sign in → issue token → two tabs:
  - **Claude Code:** copy-paste env block (or run the setup command, which writes it to user settings — plugins cannot set OTel env).
  - **Claude Platform:** Console steps, URL, header, "turn on full content for lines of code".
- Live "first event received ✓" check on the page.

### 8. Option B — self-host
- Same normalizer + local receiver + dashboard (today's prototype). Submits **scores only** (same snapshot path), never events. Micro detail never leaves the machine.

## Phases

1. **Claude Code hosted + dashboard** — ingest (json + protobuf, logs/metrics), tokens, rollups, **hosted dashboard**, hourly snapshots, connect page, setup command. Done when someone pastes the env block, opens their link, and watches their session appear live — and shows up on the board.
2. **Platform** — traces + GenAI mapping, full-content LOC extraction, team tokens + member split + claim. Done when a Console "Custom" destination produces a team with members.
3. **Product + marketing** — team dashboards + public team board (opt-in), operator card/signature image, shareable session links, "Connect Claude OTel in 2 minutes" page/demo, then ask Anthropic for a named listing.

## Error handling

- Exporter-side failures are silent in Claude Code unless `CLAUDE_CODE_OTEL_DIAG_STDERR=1` → connect page shows last-event time and the setup command can run a test export.
- Ingest: 401 bad token, 413 oversize, 415 unknown content type, 429 per-token rate limit; never 3xx (Platform disables destinations on redirects).
- Platform disables a destination after 24 h of failures → alerting on ingest error rate.

## Testing

- Golden fixtures: captured Claude Code payloads (`data/otel-test1.jsonl`) and recorded Platform spans → normalizer unit tests.
- Parity test: hosted rollups vs local receiver on the same fixture produce identical cascade output.
- End-to-end: test token → export from a scratch Claude Code session → snapshot visible.

## Owner answers (2026-10-15)

- No canon change: OTel submits the same four pillars via the existing snapshot path; Υ math unchanged. Typed input stays local-dashboard only.
- 1 Member identity (Platform): user's choice. · 2 Relay infra if ever needed: Cloudflare. · 3 Board badge: not needed (stats identical); record `source: otel-cc` in submission metadata only. · 4 Team visibility: opt-in public.
- Hosted ingest/rollups was an agent assumption carried over from Platform's public-HTTPS requirement; not wanted for `-cc`.

## Open questions (historical — answered above)

1. Which span/resource attributes identify a member on Platform (API key id, workspace, agent, end user)? Needs a captured real span.
2. Storage choice for rollups: D1 (same Cloudflare account as the site) vs separate Supabase schema.
3. Provenance label + whether OTel-sourced snapshots rank on the same board or a flagged one (canon decision, owner + Search Authority).
4. Team board visibility default (private / opt-in public / public).
