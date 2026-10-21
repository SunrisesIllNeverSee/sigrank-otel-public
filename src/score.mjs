// Aggregate captured Claude Code telemetry into pillars + SigRank board metrics.
import fs from 'node:fs';
// Same metric code the TUI and leaderboard use (token-cascade → tteop-spec).
import { resolveCascade } from './cascade.mjs';
const { cascade } = await resolveCascade();

// Typed chars -> tokens (fit from transcripts: N ≈ 0.454·chars − 188 for long prompts; ~3.6 chars/token short).
export const typedTokens = (chars) => (chars > 500 ? 0.454 * chars - 188 : chars / 3.6);

// Incremental JSONL loader: only parses bytes appended since the last call.
const cache = new Map();
export function load(file) {
  if (!fs.existsSync(file)) return [];
  const c = cache.get(file) || { offset: 0, rows: [], tail: '' };
  const size = fs.statSync(file).size;
  if (size < c.offset) Object.assign(c, { offset: 0, rows: [], tail: '' });
  if (size > c.offset) {
    const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(size - c.offset);
    fs.readSync(fd, buf, 0, buf.length, c.offset); fs.closeSync(fd);
    const lines = (c.tail + buf.toString('utf8')).split('\n'); c.tail = lines.pop();
    for (const l of lines) { if (!l) continue; try { c.rows.push(JSON.parse(l)); } catch {} }
    c.offset = size;
  }
  cache.set(file, c);
  return c.rows;
}

export const forget = (file) => cache.delete(file);

// Verified (live OTel) vs estimated (rebuilt from transcripts): backfill rows carry attrs.backfill.
export const rowSource = (r) => (r.attrs?.backfill ? 'transcript' : 'otel');
export const mixSource = (set) => (set.size > 1 ? 'mixed' : set.has('transcript') ? 'transcript' : 'otel');

const blank = () => ({ requests: 0, prompts: 0, chars: 0, typed: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costTokens: 0 });
const add = (a, b) => { for (const k of Object.keys(blank())) a[k] += b[k] || 0; return a; };
const msOf = (r) => Number(BigInt(r.time || r.end || 0) / 1000000n) || Date.parse(r.attrs?.['event.timestamp'] || '') || 0;

// Who issued an API call: you (main thread), a subagent, compaction, or other harness work.
export function sourceOf(q = '') {
  if (!q || q === 'main' || q === 'sdk' || q.startsWith('repl_main')) return 'you';
  // Real subagents report `agent:<type>` (e.g. agent:builtin:general-purpose); `agent_summary` is harness work.
  if (q.startsWith('agent:') || q.includes('subagent')) return 'subagents';
  if (q.includes('compact')) return 'compaction';
  return 'harness';
}
// Claude Code's own background calls (WebFetch/WebSearch summarizers, agent_summary, titles, suggestions)
// never appear in transcripts, so tokenpull and the board have never counted them. Keep them out of the
// scored pillars for parity; they are reported separately as sources.harness.
export const isHarness = (q) => sourceOf(q) === 'harness';

export function ratios(t) {
  const out = {};
  for (const [label, I] of [['logged', t.input], ['typed', t.typed]]) {
    out[label] = I > 0 ? {
      input: I, velocity: t.output / I, leverage: t.cacheRead / I,
      yield: (t.cacheRead * t.output) / (I * I), cio: `${(t.cacheRead / I).toFixed(1)}:1:${(t.output / I).toFixed(2)}`,
    } : null;
  }
  return out;
}

// Board row for one input definition: pillars + Υ, SNR, Lev, Vel, 10x, Class, Scale V, Σ/day, construction, $/1M.
function boardRow(t, I, windowDays) {
  if (!(I > 0)) return null;
  const c = cascade(I, t.output, t.cacheWrite, t.cacheRead);
  const total = c.pillars.total;
  return { ...c, input: I, total, perDay: total / windowDays, scaleV: total > 0 ? Math.log10(total) : 0,
    construction: t.cacheRead > 0 ? t.cacheWrite / t.cacheRead : 0, costPer1M: t.costTokens > 0 ? (t.cost / t.costTokens) * 1e6 : 0,
    hitRate: (t.cacheRead + t.cacheWrite + t.input) > 0 ? t.cacheRead / (t.cacheRead + t.cacheWrite + t.input) : 0,
    cio: `${(t.cacheRead / I).toFixed(1)}:1:${(t.output / I).toFixed(2)}` };
}

export function summarize(rows, { sinceMs = 0, windowDays = 0 } = {}) {
  const sessions = {}; const models = {}; const sources = {}; const days = {}; const total = blank();
  const tools = {}; const feed = []; const ship = { added: 0, removed: 0, commits: 0, prs: 0, editAccept: 0, editReject: 0 };
  const pace = { activeSec: 0, userSec: 0, ttft: [], dur: [], compactions: 0, subagents: 0, interactions: 0 };
  const sess = (sid, ms) => {
    const s = sessions[sid] ??= { id: sid, first: ms, last: ms, models: new Set(), src: new Set(), added: 0, removed: 0, tools: 0, compactions: 0, ...blank() };
    if (ms) { s.first = Math.min(s.first, ms); s.last = Math.max(s.last, ms); }
    return s;
  };
  const localDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const day = (ms) => days[localDay(ms)] ??= { ...blank(), src: new Set(), added: 0, removed: 0 };
  const tool = (n) => tools[n || 'unknown'] ??= { calls: 0, timed: 0, ok: 0, ms: 0, bytes: 0, accept: 0, reject: 0 };

  for (const r of rows) {
    const ms = msOf(r);
    if (ms < sinceMs) continue;
    const a = r.attrs || {}; const sid = a['session.id'] || 'unknown'; const rs = rowSource(r);

    if (r.kind === 'metrics') {
      const v = Number(r.value) || 0;
      if (r.name === 'claude_code.lines_of_code.count') {
        const k = a.type === 'removed' ? 'removed' : 'added';
        ship[k] += v; sess(sid, ms)[k] += v; day(ms)[k] += v;
      } else if (r.name === 'claude_code.commit.count') ship.commits += v;
      else if (r.name === 'claude_code.pull_request.count') ship.prs += v;
      else if (r.name === 'claude_code.active_time.total') { pace.activeSec += v; if (a.type === 'user') pace.userSec += v; }
      else if (r.name === 'claude_code.code_edit_tool.decision') ship[a.decision === 'reject' ? 'editReject' : 'editAccept'] += v;
      continue;
    }

    if (r.kind === 'traces') {
      if (r.name === 'claude_code.interaction') pace.interactions++;
      if (r.name.includes('subagent')) {
        pace.subagents++;
        feed.push({ ms, kind: 'agent', sid, label: a.agent_type || a['subagent.type'] || 'subagent', detail: 'spawned' });
      }
      if (r.name.includes('compact')) { pace.compactions++; sess(sid, ms).compactions++; feed.push({ ms, kind: 'compact', sid, label: 'compaction', detail: '' }); }
      continue;
    }

    if (r.kind !== 'logs') continue;
    let d = null;
    if (r.name === 'claude_code.api_request') {
      d = { requests: 1, input: +a.input_tokens || 0, output: +a.output_tokens || 0,
        cacheRead: +a.cache_read_tokens || 0, cacheWrite: +a.cache_creation_tokens || 0, cost: +a.cost_usd || 0 };
      if (d.cost) d.costTokens = d.input + d.output + d.cacheRead + d.cacheWrite;
      const src = sourceOf(a.query_source);
      add(sources[src] ??= blank(), d);
      if (src === 'harness') {
        feed.push({ ms, kind: 'api', sid, src, label: (a.model || '').replace('claude-', ''),
          i: d.input, o: d.output, cr: d.cacheRead, cw: d.cacheWrite, dur: +a.duration_ms || 0, cost: d.cost });
        continue;
      }
      add(models[a.model || 'unknown'] ??= blank(), d);
      if (src === 'compaction') { pace.compactions++; sess(sid, ms).compactions++; }
      if (+a.ttft_ms) pace.ttft.push(+a.ttft_ms);
      if (+a.duration_ms) pace.dur.push(+a.duration_ms);
      feed.push({ ms, kind: 'api', sid, src, label: (a.model || '').replace('claude-', ''),
        i: d.input, o: d.output, cr: d.cacheRead, cw: d.cacheWrite, dur: +a.duration_ms || 0, cost: d.cost });
      if (a.model) sess(sid, ms).models.add(a.model);
    } else if (r.name === 'claude_code.user_prompt') {
      const c = +a.prompt_length || 0;
      d = { prompts: 1, chars: c, typed: typedTokens(c) };
      feed.push({ ms, kind: 'prompt', sid, label: 'you', chars: c, typed: d.typed });
    } else if (r.name === 'claude_code.tool_result') {
      const t = tool(a.tool_name); const ok = a.success === 'true' || a.success === true;
      t.calls++; if (ok) t.ok++;
      if (a.duration_ms !== undefined) { t.timed++; t.ms += +a.duration_ms || 0; } t.bytes += +a.tool_result_size_bytes || 0;
      sess(sid, ms).tools++;
      feed.push({ ms, kind: 'tool', sid, label: a.tool_name, dur: +a.duration_ms || 0, bytes: +a.tool_result_size_bytes || 0, fail: !ok });
      continue;
    } else if (r.name === 'claude_code.tool_decision') {
      tool(a.tool_name)[a.decision === 'reject' ? 'reject' : 'accept']++;
      continue;
    } else continue;
    const sx = sess(sid, ms); sx.src.add(rs); day(ms).src.add(rs);
    add(sx, d); add(day(ms), d); add(total, d);
  }

  const firstMs = Math.min(...Object.values(sessions).map((x) => x.first).filter(Boolean), Date.now());
  const wd = windowDays || Math.max(1, (Date.now() - firstMs) / 864e5);
  // Typed input belongs to you (main thread); subagent rows score on their own logged input.
  if (sources.you) Object.assign(sources.you, { prompts: total.prompts, chars: total.chars, typed: total.typed });
  const fin = ({ src, ...o }) => ({ ...o, ...(src ? { source: mixSource(src) } : {}), ratios: ratios(o), board: { typed: boardRow(o, o.input, wd), logged: boardRow(o, o.input, wd) } });
  const med = (xs) => { if (!xs.length) return 0; const s = [...xs].sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };
  const grand = total.input + total.output + total.cacheRead + total.cacheWrite;
  const activeMin = pace.activeSec / 60;

  return {
    windowDays: wd,
    total: fin(total),
    models: Object.fromEntries(Object.entries(models).map(([k, v]) => [k, fin(v)])),
    sources: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, fin(v)])),
    days: Object.fromEntries(Object.entries(days).sort().map(([k, v]) => [k, fin(v)])),
    tools: Object.entries(tools).map(([name, t]) => ({ name, ...t, avgMs: t.timed ? t.ms / t.timed : 0 })).sort((p, q) => q.calls - p.calls),
    ship,
    pace: {
      activeSec: pace.activeSec, userSec: pace.userSec, interactions: pace.interactions,
      ttftMedMs: med(pace.ttft), durMedMs: med(pace.dur), compactions: pace.compactions, subagents: pace.subagents,
      costPerHour: activeMin > 0 ? total.cost / (activeMin / 60) : 0,
      tokensPerMin: activeMin > 0 ? grand / activeMin : 0,
      outputPerMin: activeMin > 0 ? total.output / activeMin : 0,
    },
    feed: feed.sort((p, q) => q.ms - p.ms).slice(0, 80),
    sessionCount: Object.keys(sessions).length,
    sessions: Object.values(sessions).sort((x, y) => y.last - x.last).slice(0, 150).map((s) => fin({ ...s, models: [...s.models] })),
  };
}
export { cascade };
