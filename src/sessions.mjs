// Sessions as "tanks": one row per Claude Code session, ranked against your other sessions.
// BlitzStars analog: tanks table + tank popup (Average · This · Diff, #X/N, percentile bands, history, top-10).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cascade, typedTokens, rowSource, mixSource, isHarness, rowGrade, gradeFields } from './score.mjs';

// Eligibility, like BlitzStars' battle minimums: tiny sessions don't get ranked or averaged.
export const ELIGIBLE = { prompts: 3, requests: 10 };
const ROOT = path.join(os.homedir(), '.claude/projects');
export const msOf = (r) => Number(BigInt(r.time || r.end || 0) / 1000000n) || Date.parse(r.attrs?.['event.timestamp'] || '') || 0;

// session.id -> project, from transcript location + recorded cwd. Rescanned at most every 30s on a miss.
const proj = new Map(); let scannedAt = 0;
function scanProjects() {
  if (Date.now() - scannedAt < 30000) return; scannedAt = Date.now();
  let dirs = []; try { dirs = fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return; }
  for (const d of dirs) {
    let files = []; try { files = fs.readdirSync(path.join(ROOT, d.name)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const sid = f.slice(0, -6); if (proj.has(sid)) continue;
      let cwd = null;
      try {
        const fd = fs.openSync(path.join(ROOT, d.name, f), 'r'); const b = Buffer.alloc(16384);
        const n = fs.readSync(fd, b, 0, b.length, 0); fs.closeSync(fd);
        cwd = /"cwd":"([^"]+)"/.exec(b.toString('utf8', 0, n))?.[1] || null;
      } catch {}
      proj.set(sid, { project: cwd ? path.basename(cwd) : d.name.replace(/^-Users-[^-]+-/, ''), cwd });
    }
  }
}
export const projectOf = (sid) => { if (!proj.has(sid)) scanProjects(); return proj.get(sid)?.project || 'unknown'; };

const blank = () => ({ requests: 0, prompts: 0, typed: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
  tools: 0, toolFail: 0, added: 0, removed: 0, commits: 0, compactions: 0, subReq: 0, models: {}, toolNames: {}, src: new Set(), gr: new Set(), first: 0, last: 0, curve: [] });

// Metrics compared in the popup. dir: +1 = higher is better, -1 = lower is better, 0 = neutral.
export const STATS = [
  ['yield', 'Υ Yield', 1], ['velocity', 'Velocity (O/I)', 1], ['leverage', 'Leverage (CR/I)', 1], ['snr', 'SNR', 1],
  ['typed', 'Typed input', 0], ['output', 'Output', 1], ['cacheRead', 'Cache read', 0], ['cacheWrite', 'Cache write', 0],
  ['total', 'Σ Tokens', 0], ['requests', 'Requests', 0], ['prompts', 'Prompts', 0], ['tools', 'Tool calls', 0],
  ['lines', 'Lines changed', 1], ['minutes', 'Duration (min)', 0], ['outPerMin', 'Output / min', 1], ['tokPerPrompt', 'Tokens / prompt', 0],
  ['hitRate', 'Cache hit rate', 1], ['cost', 'Cost $', -1],
];

let memo = { n: -1, all: null };
function build(rows) {
  if (rows.length === memo.n) return memo.all;
  const S = new Map();
  for (const r of rows) {
    const a = r.attrs || {}; const sid = a['session.id']; if (!sid) continue;
    const ms = msOf(r); const s = S.get(sid) || S.set(sid, blank()).get(sid); s.src.add(rowSource(r)); s.gr.add(rowGrade(r));
    if (ms) { s.first = s.first ? Math.min(s.first, ms) : ms; s.last = Math.max(s.last, ms); }
    if (r.name === 'claude_code.api_request' && !isHarness(a.query_source)) {
      const i = +a.input_tokens || 0, o = +a.output_tokens || 0, cr = +a.cache_read_tokens || 0, cw = +a.cache_creation_tokens || 0;
      s.requests++; s.input += i; s.output += o; s.cacheRead += cr; s.cacheWrite += cw; s.cost += +a.cost_usd || 0;
      const m = (a.model || 'unknown').replace('claude-', ''); s.models[m] = (s.models[m] || 0) + i + o + cr + cw;
      const q = a.query_source || ''; if (q.startsWith('agent') || q.includes('subagent')) s.subReq++;
      if (q.includes('compact')) s.compactions++;
      s.curve.push([ms, o, i + o + cr + cw]);
    } else if (r.name === 'claude_code.user_prompt') { s.prompts++; s.typed += typedTokens(+a.prompt_length || 0); }
    else if (r.name === 'claude_code.tool_result') {
      s.tools++; if (!(a.success === 'true' || a.success === true)) s.toolFail++;
      s.toolNames[a.tool_name || '?'] = (s.toolNames[a.tool_name || '?'] || 0) + 1;
    } else if (r.name === 'claude_code.lines_of_code.count') s[a.type === 'removed' ? 'removed' : 'added'] += Number(r.value) || 0;
    else if (r.name === 'claude_code.commit.count') s.commits += Number(r.value) || 0;
  }
  const all = [];
  for (const [sid, s] of S) {
    if (!s.requests && !s.prompts) continue;
    const total = s.input + s.output + s.cacheRead + s.cacheWrite;
    const c = s.input > 0 || s.output > 0 ? cascade(s.input, s.output, s.cacheWrite, s.cacheRead) : null;
    const minutes = Math.max(1, (s.last - s.first) / 60000);
    all.push({
      id: sid, source: mixSource(s.src), ...gradeFields(s.gr), project: projectOf(sid), first: s.first, last: s.last, minutes,
      requests: s.requests, prompts: s.prompts, typed: s.typed, input: s.input, output: s.output, cacheRead: s.cacheRead, cacheWrite: s.cacheWrite,
      total, cost: s.cost, tools: s.tools, toolFail: s.toolFail, added: s.added, removed: s.removed, lines: s.added + s.removed,
      commits: s.commits, compactions: s.compactions, subReq: s.subReq,
      yield: c?.yield ?? null, velocity: c?.velocity ?? null, leverage: c?.leverage ?? null, snr: c?.snr ?? null, cls: c?.class ?? null,
      outPerMin: s.output / minutes, tokPerPrompt: s.prompts ? total / s.prompts : null,
      hitRate: total ? s.cacheRead / (s.cacheRead + s.cacheWrite + s.input || 1) : null,
      models: Object.entries(s.models).sort((p, q) => q[1] - p[1]).map(([m, n]) => ({ m, n })),
      topTools: Object.entries(s.toolNames).sort((p, q) => q[1] - p[1]).slice(0, 8).map(([t, n]) => ({ t, n })),
      curve: s.curve.sort((p, q) => p[0] - q[0]),
      eligible: s.prompts >= ELIGIBLE.prompts && s.requests >= ELIGIBLE.requests,
    });
  }
  memo = { n: rows.length, all };
  return all;
}

// Lines come only from live OTel counters: a session with no reported rows never measured them, so it is null (not 0) and stays out of medians.
const sv = (x, k) => (k === 'lines' && Array.isArray(x.grades) && !x.grades.includes('reported') ? null : x[k]);
// Rank + percentile within the eligible pool (the "field" is your own sessions in the window).
function rankPool(pool) {
  const out = {};
  for (const [k] of STATS) {
    const vals = pool.map((s) => sv(s, k)).filter((v) => v != null && isFinite(v)).sort((p, q) => p - q);
    out[k] = vals;
  }
  return out;
}
const pctOf = (sorted, v) => { if (v == null || !sorted.length) return null; let lo = 0; while (lo < sorted.length && sorted[lo] <= v) lo++; return lo / sorted.length; };
// Median, not mean: Υ is heavy-tailed and a few tiny-input sessions would swamp an average.
const mean = (xs) => { if (!xs.length) return null; const s = [...xs].sort((p, q) => p - q), h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };

export function sessionsList(rows, { sinceMs = 0 } = {}) {
  const all = build(rows).filter((s) => s.last >= sinceMs);
  const pool = all.filter((s) => s.eligible);
  const byY = [...pool].sort((p, q) => (q.yield ?? -1) - (p.yield ?? -1));
  const rank = new Map(byY.map((s, i) => [s.id, i + 1]));
  const projects = {};
  for (const s of all) { const p = projects[s.project] ??= { project: s.project, sessions: 0, total: 0, output: 0 }; p.sessions++; p.total += s.total; p.output += s.output; }
  const lite = ({ curve, topTools, ...s }) => ({ ...s, rank: rank.get(s.id) || null, models: s.models.slice(0, 3) });
  return { field: pool.length, eligibleRule: ELIGIBLE, projects: Object.values(projects).sort((p, q) => q.total - p.total),
    sessions: all.sort((p, q) => q.last - p.last).map(lite) };
}

export function sessionDetail(rows, id, { sinceMs = 0 } = {}) {
  const all = build(rows).filter((s) => s.last >= sinceMs || s.id === id);
  const s = all.find((x) => x.id === id); if (!s) return null;
  const pool = all.filter((x) => x.eligible);
  const sorted = rankPool(pool);
  const byY = [...pool].sort((p, q) => (q.yield ?? -1) - (p.yield ?? -1));
  const r = byY.findIndex((x) => x.id === id);
  const stats = STATS.map(([k, label, dir]) => {
    const avg = mean(pool.map((x) => sv(x, k)).filter((v) => v != null && isFinite(v))), val = sv(s, k);
    return { k, label, dir, avg, val, diff: val != null && avg != null ? val - avg : null, pct: pctOf(sorted[k], val) };
  });
  // Downsample the request curve to ≤120 cumulative points.
  let co = 0, ct = 0; const cum = s.curve.map(([ms, o, t]) => [ms, (co += o), (ct += t)]);
  const step = Math.max(1, Math.ceil(cum.length / 120)); const curve = cum.filter((_, i) => i % step === 0 || i === cum.length - 1);
  const sameProject = pool.filter((x) => x.project === s.project).sort((p, q) => (q.yield ?? -1) - (p.yield ?? -1));
  const ids = all.sort((p, q) => q.last - p.last).map((x) => x.id); const i = ids.indexOf(id);
  return {
    ...s, curve, stats, field: pool.length, rank: r >= 0 ? r + 1 : null, top: r >= 0 ? (r + 1) / pool.length : null,
    eligibleRule: ELIGIBLE,
    projectRank: sameProject.findIndex((x) => x.id === id) + 1 || null, projectField: sameProject.length,
    projectTop: sameProject.slice(0, 10).map((x) => ({ id: x.id, first: x.first, yield: x.yield, cls: x.cls, output: x.output, prompts: x.prompts, lines: x.lines, minutes: x.minutes })),
    prev: ids[i - 1] || null, next: ids[i + 1] || null,
  };
}
