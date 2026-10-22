// Aggregate captured Claude Code telemetry into pillars + SigRank board metrics.
import fs from 'node:fs';
// Same metric code the TUI and leaderboard use (token-cascade → tteop-spec).
import { resolveCascade } from './cascade.mjs';
import { estimateCost } from './pricing.mjs';
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

// Provenance grade per row, decided here (the view never guesses). A row can name its own grade (attrs.provenance) or flag
// attrs.estimated; otherwise backfill rows are 'logged', claude_code.* OTel rows are 'reported', anything else is 'unknown'.
export const GRADES = ['reported', 'computed', 'logged', 'estimated', 'native-log', 'git-local', 'derived'];
export function rowGrade(r) {
  const a = r.attrs || {};
  if (GRADES.includes(a.provenance)) return a.provenance;
  if (a.estimated === true || a.estimated === 'true') return 'estimated';
  if (a.backfill) return 'logged';
  return String(r.name || '').startsWith('claude_code.') ? 'reported' : 'unknown';
}
// One grade for an aggregate: the single grade, 'mixed' when several, 'unknown' when empty. gradeList names the members.
export const gradeOf = (set) => (!set || !set.size ? 'unknown' : set.size > 1 ? 'mixed' : [...set][0]);
export const gradeList = (set) => [...(set || [])].sort();
export const gradeFields = (set) => ({ grade: gradeOf(set), grades: gradeList(set) });

const blank = () => ({ requests: 0, prompts: 0, chars: 0, typed: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costTokens: 0, costEst: 0, unpriced: 0 });
const gblank = () => ({ ...blank(), gr: new Set() });  // + the set of provenance grades that fed it

// Where OTel starts, from data: first non-backfill row vs first row of any kind (memoized per row count).
let covMemo = { n: -1 };
export function otelSpan(rows) {
  if (covMemo.n === rows.length) return covMemo;
  let otel = Infinity, any = Infinity;
  for (const r of rows) { const ms = msOf(r); if (!ms) continue; if (ms < any) any = ms; if (!r.attrs?.backfill && ms < otel) otel = ms; }
  return (covMemo = { n: rows.length, otel, any });
}
const add = (a, b) => { for (const k of Object.keys(blank())) a[k] += b[k] || 0; return a; };
export const msOf = (r) => Number(BigInt(r.time || r.end || 0) / 1000000n) || Date.parse(r.attrs?.['event.timestamp'] || '') || 0;

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

// OTel coverage of a window, from data: days of the window that fall on or after the first live OTel event.
function coverage(rows, sinceMs, windowDays) {
  const { otel, any } = otelSpan(rows), now = Date.now(), start = sinceMs || any;
  if (!isFinite(start)) return { otelStartMs: null, spanDays: 0, otelDays: 0, full: false, otelOnly: false };
  const span = Math.max(1, Math.ceil((now - start) / 864e5)), from = Math.max(start, otel);
  return { otelStartMs: isFinite(otel) ? otel : null, spanDays: windowDays || span, otelDays: isFinite(otel) ? Math.min(windowDays || span, Math.floor((now - from) / 864e5)) : 0,  // whole days only: never round a partial day up into coverage
    full: isFinite(otel) && otel <= start, otelOnly: isFinite(otel) && otel <= any };
}

// Provider-reported edit decisions by language: top 12 by volume, a longer tail folded into 'other'. Counts only.
function editLangRows(m) {
  const rows = Object.entries(m).map(([language, c]) => ({ language, ...c })).sort((p, q) => (q.accept + q.reject) - (p.accept + p.reject));
  const cut = rows.length > 13 ? 12 : rows.length, top = rows.slice(0, cut), rest = rows.slice(cut);
  if (rest.length) top.push({ language: 'other', accept: rest.reduce((n, x) => n + x.accept, 0), reject: rest.reduce((n, x) => n + x.reject, 0), langs: rest.length });
  return top;
}

export function summarize(rows, { sinceMs = 0, windowDays = 0 } = {}) {
  const sessions = {}; const models = {}; const sources = {}; const days = {}; const total = gblank(); const rep = blank();  // rep = reported (OTel) rows only
  const tools = {}; const feed = []; const ship = { added: 0, removed: 0, commits: 0, prs: 0, editAccept: 0, editReject: 0, outputReported: 0 }; const shipGr = new Set(), paceGr = new Set(), toolGr = new Set();
  const editLang = {}; const pace = { activeSec: 0, userSec: 0, ttft: [], dur: [], compactions: 0, subagents: 0, interactions: 0 };
  const sess = (sid, ms) => {
    const s = sessions[sid] ??= { id: sid, first: ms, last: ms, models: new Set(), src: new Set(), added: 0, removed: 0, tools: 0, compactions: 0, gr: new Set(), ...blank() };
    if (ms) { s.first = Math.min(s.first, ms); s.last = Math.max(s.last, ms); }
    return s;
  };
  const localDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const day = (ms) => days[localDay(ms)] ??= { ...blank(), src: new Set(), gr: new Set(), added: 0, removed: 0 };
  const tool = (n) => tools[n || 'unknown'] ??= { calls: 0, timed: 0, ok: 0, ms: 0, bytes: 0, accept: 0, reject: 0 };

  for (const r of rows) {
    const ms = msOf(r);
    if (ms < sinceMs) continue;
    const a = r.attrs || {}; const sid = a['session.id'] || 'unknown'; const rs = rowSource(r), rg = rowGrade(r);

    if (r.kind === 'metrics') {
      const v = Number(r.value) || 0, mg = rg;
      if (/lines_of_code|commit\.count|pull_request|code_edit_tool/.test(r.name)) shipGr.add(mg); else if (r.name === 'claude_code.active_time.total') paceGr.add(mg);
      if (r.name === 'claude_code.lines_of_code.count') {
        const k = a.type === 'removed' ? 'removed' : 'added';
        ship[k] += v; sess(sid, ms)[k] += v; day(ms)[k] += v;
      } else if (r.name === 'claude_code.commit.count') ship.commits += v;
      else if (r.name === 'claude_code.pull_request.count') ship.prs += v;
      else if (r.name === 'claude_code.active_time.total') { pace.activeSec += v; if (a.type === 'user') pace.userSec += v; }
      else if (r.name === 'claude_code.code_edit_tool.decision') {
        const rej = a.decision === 'reject'; ship[rej ? 'editReject' : 'editAccept'] += v;
        const L = (editLang[String(a.language || 'unknown').slice(0, 40)] ??= { accept: 0, reject: 0 }); L[rej ? 'reject' : 'accept'] += v;  // counts only; language is the provider's label
      }
      continue;
    }

    if (r.kind === 'traces') {
      if (r.name === 'claude_code.interaction') pace.interactions++;
      if (r.name.includes('subagent')) {
        pace.subagents++;
        feed.push({ ms, g: rg, kind: 'agent', sid, label: a.agent_type || a['subagent.type'] || 'subagent', detail: 'spawned' });
      }
      if (r.name.includes('compact')) { pace.compactions++; sess(sid, ms).compactions++; feed.push({ ms, g: rg, kind: 'compact', sid, label: 'compaction', detail: '' }); }
      continue;
    }

    if (r.kind !== 'logs') continue;
    let d = null;
    if (r.name === 'claude_code.api_request') {
      d = { requests: 1, input: +a.input_tokens || 0, output: +a.output_tokens || 0,
        cacheRead: +a.cache_read_tokens || 0, cacheWrite: +a.cache_creation_tokens || 0, cost: +a.cost_usd || 0 };
      if (d.cost) d.costTokens = d.input + d.output + d.cacheRead + d.cacheWrite;
      else if (a.backfill) {  // transcripts carry no cost: estimate it (src/pricing.mjs), kept apart from reported cost
        const e = estimateCost(a.model, d.input, d.output, d.cacheWrite, d.cacheRead);
        if (e == null) d.unpriced = d.input + d.output + d.cacheRead + d.cacheWrite; else d.costEst = e;
      }
      const src = sourceOf(a.query_source), gd = rg;
      add(sources[src] ??= gblank(), d); sources[src].gr.add(gd);
      if (src === 'harness') {
        feed.push({ ms, g: rg, kind: 'api', sid, src, label: (a.model || '').replace('claude-', ''),
          i: d.input, o: d.output, cr: d.cacheRead, cw: d.cacheWrite, dur: +a.duration_ms || 0, cost: d.cost });
        continue;
      }
      add(models[a.model || 'unknown'] ??= gblank(), d); models[a.model || 'unknown'].gr.add(gd);
      if (gd === 'reported') { add(rep, d); ship.outputReported += d.output; }
      if (src === 'compaction') { pace.compactions++; sess(sid, ms).compactions++; }
      if (+a.ttft_ms) { pace.ttft.push(+a.ttft_ms); paceGr.add(gd); }
      if (+a.duration_ms) pace.dur.push(+a.duration_ms);
      feed.push({ ms, g: rg, kind: 'api', sid, src, label: (a.model || '').replace('claude-', ''),
        i: d.input, o: d.output, cr: d.cacheRead, cw: d.cacheWrite, dur: +a.duration_ms || 0, cost: d.cost });
      if (a.model) sess(sid, ms).models.add(a.model);
    } else if (r.name === 'claude_code.user_prompt') {
      const c = +a.prompt_length || 0;
      d = { prompts: 1, chars: c, typed: typedTokens(c) };
      feed.push({ ms, g: rg, kind: 'prompt', sid, label: 'you', chars: c, typed: d.typed });
    } else if (r.name === 'claude_code.tool_result') {
      toolGr.add(rg); const t = tool(a.tool_name); const ok = a.success === 'true' || a.success === true;
      t.calls++; if (ok) t.ok++;
      if (a.duration_ms !== undefined) { t.timed++; t.ms += +a.duration_ms || 0; } t.bytes += +a.tool_result_size_bytes || 0;
      sess(sid, ms).tools++;
      feed.push({ ms, g: rg, kind: 'tool', sid, label: a.tool_name, dur: +a.duration_ms || 0, bytes: +a.tool_result_size_bytes || 0, fail: !ok });
      continue;
    } else if (r.name === 'claude_code.tool_decision') {
      tool(a.tool_name)[a.decision === 'reject' ? 'reject' : 'accept']++;
      continue;
    } else continue;
    const sx = sess(sid, ms), gx = rg; sx.src.add(rs); day(ms).src.add(rs); sx.gr.add(gx); day(ms).gr.add(gx); total.gr.add(gx);
    add(sx, d); add(day(ms), d); add(total, d);
  }

  const firstMs = Math.min(...Object.values(sessions).map((x) => x.first).filter(Boolean), Date.now());
  const wd = windowDays || Math.max(1, (Date.now() - firstMs) / 864e5);
  // Typed input belongs to you (main thread); subagent rows score on their own logged input.
  if (sources.you) Object.assign(sources.you, { prompts: total.prompts, chars: total.chars, typed: total.typed });
  const fin = ({ src, gr, ...o }) => ({ ...o, ...(src ? { source: mixSource(src) } : {}), ...gradeFields(gr), ratios: ratios(o), board: { typed: boardRow(o, o.input, wd), logged: boardRow(o, o.input, wd) } });
  const med = (xs) => { if (!xs.length) return 0; const s = [...xs].sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };
  const grand = rep.input + rep.output + rep.cacheRead + rep.cacheWrite;  // pace rates use OTel rows only (active time is OTel-only)
  const activeMin = pace.activeSec / 60;

  return {
    windowDays: wd,
    coverage: coverage(rows, sinceMs, windowDays),
    total: fin(total),
    models: Object.fromEntries(Object.entries(models).map(([k, v]) => [k, fin(v)])),
    sources: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, fin(v)])),
    days: Object.fromEntries(Object.entries(days).sort().map(([k, v]) => [k, fin(v)])),
    toolsMeta: gradeFields(toolGr),
    tools: Object.entries(tools).map(([name, t]) => ({ name, ...t, avgMs: t.timed ? t.ms / t.timed : 0 })).sort((p, q) => q.calls - p.calls),
    ship: { ...ship, editProposed: ship.editAccept + ship.editReject, editByLanguage: editLangRows(editLang), ...gradeFields(shipGr) },
    pace: {
      ...gradeFields(paceGr),
      activeSec: pace.activeSec, userSec: pace.userSec, interactions: pace.interactions,
      ttftMedMs: med(pace.ttft), durMedMs: med(pace.dur), compactions: pace.compactions, subagents: pace.subagents,
      costPerHour: activeMin > 0 ? rep.cost / (activeMin / 60) : 0,
      tokensPerMin: activeMin > 0 ? grand / activeMin : 0,
      outputPerMin: activeMin > 0 ? rep.output / activeMin : 0,
    },
    feed: feed.sort((p, q) => q.ms - p.ms).slice(0, 80),
    feedMeta: gradeFields(new Set(feed.slice(0, 80).map((e) => e.g))),  // feed is sorted newest-first just above
    sessionCount: Object.keys(sessions).length,
    sessions: Object.values(sessions).sort((x, y) => y.last - x.last).slice(0, 150).map((s) => fin({ ...s, models: [...s.models] })),
  };
}
export { cascade };
