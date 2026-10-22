// All-time history views (ignore the window selector): BlitzStars-style daily sessions log + Recent Milestones.
// A "day" ends at 05:00 the next morning, so late-night work counts toward the evening it started.
import { cascade, typedTokens, rowSource, mixSource, isHarness, rowGrade, gradeFields } from './score.mjs';
import { rowCostEst } from './pricing.mjs';

const DAY_END_HOUR = 5;
const msOf = (r) => Number(BigInt(r.time || r.end || 0) / 1000000n) || Date.parse(r.attrs?.['event.timestamp'] || '') || 0;
const dayKey = (ms) => {
  const d = new Date(ms - DAY_END_HOUR * 3600e3);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const blank = () => ({ requests: 0, prompts: 0, typed: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costEst: 0,
  added: 0, removed: 0, tools: 0, commits: 0, models: {}, sessions: new Set(), src: new Set(), gr: new Set(), first: 0, last: 0 });
const tokens = (t) => t.input + t.output + t.cacheRead + t.cacheWrite;
const score = (t) => (t.input > 0 || t.output > 0 ? cascade(t.input, t.output, t.cacheWrite, t.cacheRead) : null);

const TOTAL_STEPS = [1e6, 1e7, 1e8, 1e9, 5e9, 1e10, 5e10, 1e11];
const MODEL_TOKEN_STEPS = [1e8, 1e9, 1e10];
const COUNT_STEPS = { requests: [1e3, 1e4, 5e4, 1e5], prompts: [100, 1000, 5000], tools: [1e4, 1e5], commits: [10, 100, 1000] };
const STREAKS = [7, 14, 30, 60, 100, 365];
const big = (n) => (n >= 1e9 ? `${+(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}K` : `${n}`);

let memo = { n: -1, out: null };
export function history(rows) {
  if (rows.length === memo.n) return memo.out;
  const evs = rows.map((r) => [msOf(r), r]).filter(([ms]) => ms).sort((a, b) => a[0] - b[0]);
  const days = new Map(); const run = blank(); const runModel = {}; const ms_ = []; let commits = 0;
  const push = (ms, kind, label, detail = '') => ms_.push({ ms, kind, label, detail });
  const cross = (before, after, steps) => steps.filter((s) => before < s && after >= s);

  for (const [ms, r] of evs) {
    const a = r.attrs || {}; const k = dayKey(ms);
    const d = days.get(k) || days.set(k, blank()).get(k);
    d.first ||= ms; d.last = ms; d.src.add(rowSource(r)); d.gr.add(rowGrade(r)); if (a['session.id']) d.sessions.add(a['session.id']);
    if (r.name === 'claude_code.api_request' && !isHarness(a.query_source)) {
      const x = { i: +a.input_tokens || 0, o: +a.output_tokens || 0, cr: +a.cache_read_tokens || 0, cw: +a.cache_creation_tokens || 0 };
      const n = x.i + x.o + x.cr + x.cw; const m = (a.model || 'unknown').replace('claude-', ''), ce = rowCostEst(a);
      for (const t of [d, run]) { t.requests++; t.input += x.i; t.output += x.o; t.cacheRead += x.cr; t.cacheWrite += x.cw; t.cost += +a.cost_usd || 0; t.costEst += ce; }
      d.models[m] = (d.models[m] || 0) + n;
      const before = tokens(run) - n;
      for (const s of cross(before, before + n, TOTAL_STEPS)) push(ms, 'tokens', `${big(s)} tokens`, 'all-time Σ');
      for (const s of cross(run.requests - 1, run.requests, COUNT_STEPS.requests)) push(ms, 'count', `${big(s)} requests`);
      const rm = runModel[m] ??= { n: 0, req: 0 };
      if (!rm.req) push(ms, 'first', `First ${m}`, 'new model');
      rm.req++; for (const s of cross(rm.n, rm.n + n, MODEL_TOKEN_STEPS)) push(ms, 'tokens', `${big(s)} on ${m}`); rm.n += n;
    } else if (r.name === 'claude_code.user_prompt') {
      const t = typedTokens(+a.prompt_length || 0);
      d.prompts++; d.typed += t; run.prompts++; run.typed += t;
      for (const s of cross(run.prompts - 1, run.prompts, COUNT_STEPS.prompts)) push(ms, 'count', `${big(s)} prompts`);
    } else if (r.name === 'claude_code.tool_result') {
      d.tools++; run.tools++;
      for (const s of cross(run.tools - 1, run.tools, COUNT_STEPS.tools)) push(ms, 'count', `${big(s)} tool calls`);
    } else if (r.name === 'claude_code.lines_of_code.count') {
      d[a.type === 'removed' ? 'removed' : 'added'] += Number(r.value) || 0;
    } else if (r.name === 'claude_code.commit.count') {
      const v = Number(r.value) || 0; d.commits += v;
      for (const s of cross(commits, commits + v, COUNT_STEPS.commits)) push(ms, 'count', `${big(s)} commits`);
      commits += v;
    }
  }

  // Day-level milestones: personal bests, class promotions, streaks.
  const dailies = []; const best = { output: 0, y: 0, requests: 0, lines: 0, tokens: 0 };
  const cum = blank(); let cls = null; let streak = 0; let prevDate = null;
  for (const [k, d] of [...days.entries()].sort()) {
    if (!d.requests && !d.prompts) continue;
    const s = score(d); const lines = d.added + d.removed; const tk = tokens(d);
    const row = { day: k, source: mixSource(d.src), ...gradeFields(d.gr), ms: d.last, requests: d.requests, prompts: d.prompts, typed: d.typed, input: d.input, output: d.output,
      cacheRead: d.cacheRead, cacheWrite: d.cacheWrite, total: tk, cost: d.cost, costEst: d.costEst, added: d.added, removed: d.removed, tools: d.tools,
      commits: d.commits, sessions: d.sessions.size, activeMin: (d.last - d.first) / 60000,
      models: Object.entries(d.models).sort((p, q) => q[1] - p[1]).map(([m, n]) => ({ m, n })),
      yield: s?.yield ?? null, cls: s?.class ?? null, cio: d.input ? `${(d.cacheRead / d.input).toFixed(0)}:1:${(d.output / d.input).toFixed(2)}` : '—' };
    dailies.push(row);
    const seasoned = dailies.length > 3;  // don't celebrate "bests" on day one
    const pb = (key, v, label, fmt) => { if (seasoned && v > best[key] && best[key] > 0) push(d.last, 'best', label, `${fmt(v)} · prev ${fmt(best[key])}`); best[key] = Math.max(best[key], v); };
    pb('tokens', tk, 'Best day · Σ tokens', big); pb('output', d.output, 'Best day · output', big);
    pb('requests', d.requests, 'Best day · requests', big); pb('lines', lines, 'Best day · lines changed', big);
    if (s && d.prompts >= 5) pb('y', s.yield, 'Best day · Υ', (v) => (v >= 1e4 ? `${(v / 1e3).toFixed(1)}K` : v.toFixed(1)));
    // Running class (all-time to date; score() reads logged input, so it must accumulate).
    for (const f of ['typed', 'input', 'output', 'cacheRead', 'cacheWrite']) cum[f] += d[f];
    const c = score(cum)?.class;
    if (c && cls && c !== cls) push(d.last, 'class', `Class → ${c}`, `from ${cls}`);
    if (c) cls = c;
    // Streak of consecutive session-days.
    const date = new Date(`${k}T12:00:00`);
    streak = prevDate && Math.round((date - prevDate) / 864e5) === 1 ? streak + 1 : 1; prevDate = date;
    if (STREAKS.includes(streak)) push(d.last, 'streak', `${streak}-day streak`);
  }

  memo = { n: rows.length, out: { dailies: dailies.reverse().slice(0, 180), milestones: ms_.sort((p, q) => q.ms - p.ms).slice(0, 200), dayEndsHour: DAY_END_HOUR } };
  return memo.out;
}
