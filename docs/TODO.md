---
type: Backlog
title: sigrank-otel dashboard — TODO
timestamp: 2026-10-15
---

# Dashboard TODO (from docs/dashboard-map.md)

## 1. Understanding
- [x] Plain-language tooltips for every metric: Υ, SNR, Velocity, Leverage, 10×Dev, Scale V, C:I:O, Class, Construction, hit rate, typed vs logged input
- [x] One-line note under each view header (Board, Sessions, Daily, Milestones, readout, ship, tools, feed)
- [x] Explain the two YOU rows (typed vs logged input) in the table itself
- [x] Four Degrees ladder legend (AA / Center / Power / Top)
- [x] First-run state: no data yet → setup checklist + "waiting for your first prompt" + what will appear
- [x] Owner change: per-day bar chart → **line graph**

## 2. Verified vs estimated
- [x] Mark transcript-sourced (pre-OTel) history in Daily, Sessions, popup and the per-day chart

## 3. Portability
- [x] Config file (`~/.config/sigrank-otel/config.json` + env overrides): port, data dir, codename, token-cascade path
- [x] Resolve token-cascade from the package's own dependency, fallback to configured path
- [x] `setup` command: writes the Claude Code env block to user settings (with backup), installs autostart (macOS LaunchAgent; Linux systemd user unit), opens the dashboard
- [x] `package.json` with bin `sigrank-otel-cc`; `doctor` command (receiver up, telemetry env present, last event age)

## 4. Board connection
- [x] Submit button → scores through sigrank-mcp's existing snapshot path, with `source: otel-cc` metadata (no new canon)

## 5. BlitzStars set
- [x] 30/60/90-day change vs career table
- [x] Υ calculator (what change reaches a target Υ)
- [x] Operator card image (PNG/SVG, like the BlitzStars signature)
- [x] Model popup (like the session popup, per model)

## 6. Hardening
- [x] Log rotation / retention setting for data/otel.jsonl
- [x] Accept OTLP protobuf + gzip
- [x] Incremental scoring (no full rescan per poll)
- [x] Shareable session link (`#session=<id>` deep link)

## Reminders
- [ ] **Owner: "a different chart from BlitzStars — remind me later"** (ask which one when work is done)
