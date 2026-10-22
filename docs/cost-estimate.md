# Cost estimate for transcript days (`estimated`, rules version `cost-est/1`)

This is what `src/pricing.mjs` and `src/score.mjs` do today.

## Why there are two cost numbers

Claude Code's live telemetry reports a dollar cost on every API call (`cost_usd`). That is the **reported** cost. Transcript history (the backfilled days before live telemetry started) records the same token counts but no cost, so those days showed no cost at all and every window longer than the live stream showed the same figure.

Transcript days now get an **estimated** cost. It is kept apart from the reported cost everywhere: the Cost tile shows the reported amount with `+ ≈$X est.` beside it and a `mixed` badge, per-day and per-model rows mark estimates with `≈`, and the hover gives the split and the total. Cost per active hour and $/1M stay reported-only.

## Method

For each transcript API request:

```
cost = (input × in + output × out + cache_write × write + cache_read × read) / 1,000,000
```

with the model's rates in $ per million tokens:

| Model | Input | Output | Cache write | Cache read | Source |
| --- | --- | --- | --- | --- | --- |
| claude-fable-5-1 | 10 | 50 | 12.50 | 0.25 | matches reported cost exactly |
| claude-opus-5-5 | 4 | 20 | 5 | 0.20 | within 1.3% of reported cost |
| claude-sonnet-5-5 | 2 | 10 | 2.50 | 0.10 | rates implied by reported cost (see below) |
| claude-haiku-5-5 | 0.10 | 0.50 | 0.125 | 0.01 | published; prompts over 100K tokens at 0.50 / 2.50 / 0.625 / 0.05 |
| claude-fable-5 | 10 | 50 | 12.50 | 1.00 | published list price |
| claude-opus-4-8 | 5 | 25 | 6.25 | 0.50 | published list price |
| claude-opus-4-7 | 5 | 25 | 6.25 | 0.50 | published list price |
| claude-sonnet-4-6 | 3 | 15 | 3.75 | 0.30 | published list price |
| claude-haiku-4-5 | 1 | 5 | 1.25 | 0.10 | published list price |

- **Cache writes** are priced at the 5-minute rate (1.25× input). Checked against live telemetry: with 5-minute writes, the formula reproduces reported cost for Fable 5.1 exactly and for Opus 5.5 to 1.3%; 1-hour writes (2× input) overshoot by 16–39%.
- **Models seen in live telemetry** use the rates their reported cost implies. A per-request least-squares fit on Sonnet 5.5 gives $2.00 / $10.01 / $2.50 / $0.0999, and those rates reproduce the reported total to within $0.08. The published Sonnet 5.5 cache-read rate is $0.20. The estimate follows what Claude Code reports, so the reported and estimated numbers are on the same basis.
- **Models only in transcript history** use published list prices. They cannot be checked against reported cost.
- **Local models** (any model id not starting with `claude-`) cost $0.
- **Unknown Claude models** are not priced. Their tokens are counted as `unpriced` and the hover says how many were left out.
- Dated model ids (`claude-haiku-4-5-20251001`) match their base id.

## Limits

- An estimate is only as good as the transcript token counts. Some transcript records keep the start-of-stream usage, so their output tokens are low (see the backfill undercount note); their estimated cost is low by the same amount.
- Claude Code may have used different cache settings in earlier versions. The 5-minute rate is checked only on the live days.
- Prices are the API-equivalent cost Claude Code reports, not what a subscription plan bills.

## What the API serves

`/api/summary` adds `costEst` (estimated $) and `unpriced` (tokens with no known price) beside `cost` (reported $) on the totals, per model, per source, per day and per session. `cost` is never changed by the estimate.
