// Extra API views: period deltas, per-model detail, Υ calculator, operator card, submit preview.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { cascade, summarize, typedTokens, rowSource, mixSource, isHarness } from './score.mjs';
import { msOf, projectOf } from './sessions.mjs';

const PERIODS = { d30: 30, d60: 60, d90: 90, career: 0 };
const num = (x) => (x == null || !isFinite(x) ? null : x);
const dayKey = (ms) => { const d = new Date(ms - 5 * 3600e3); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// Pull the comparable numbers out of one summarize() result. Volumes are per day so windows compare fairly.
function vals(s, wd = s.windowDays || 1) {
  const t = s.total; const b = t.board.typed;
  return { yield: num(b?.yield), velocity: num(b?.velocity), leverage: num(b?.leverage), snr: num(b?.snr),
    output: t.output / wd, requests: t.requests / wd, typed: t.typed / wd };
}

const DELTA_ROWS = [['yield', 'Υ Yield'], ['velocity', 'Velocity (O/I)'], ['leverage', 'Leverage (CR/I)'], ['snr', 'SNR'],
  ['output', 'Output / day'], ['requests', 'Requests / day'], ['typed', 'Typed input / day']];

export function deltas(rows) {
  const per = {}; const now = Date.now();
  const car = summarize(rows, { windowDays: 0 }); per.career = vals(car);
  // A window longer than your history only spans the history, so per-day volumes divide by the days that exist.
  for (const [k, n] of Object.entries(PERIODS)) if (n) per[k] = vals(summarize(rows, { sinceMs: now - n * 864e5, windowDays: n }), Math.min(n, car.windowDays));
  const diff = (a, b) => (a == null || b == null ? null : a - b);
  return {
    periods: { d30: per.d30, d60: per.d60, d90: per.d90, career: per.career },
    rows: DELTA_ROWS.map(([k, label]) => ({ k, label, d30: diff(per.d30[k], per.career[k]), d60: diff(per.d60[k], per.career[k]),
      d90: diff(per.d90[k], per.career[k]), career: per.career[k] })),
  };
}

// Per-model view. Typed input is credited to the model that answered the prompt (next request in that session).
export function modelDetail(rows, name, { sinceMs = 0, windowDays = 0 } = {}) {
  const evs = rows.map((r) => [msOf(r), r]).filter(([ms]) => ms >= sinceMs && ms).sort((a, b) => a[0] - b[0]);
  // Accept short names ('opus-5-5') as well as full ones ('claude-opus-5-5').
  const known = new Set(evs.map(([, r]) => r.attrs?.model).filter(Boolean));
  if (!known.has(name) && known.has(`claude-${name}`)) name = `claude-${name}`;
  const M = {}; const pending = new Map(); const sess = {};
  const blank = () => ({ requests: 0, typed: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, src: new Set() });
  const days = new Map();
  for (const [ms, r] of evs) {
    const a = r.attrs || {}; const sid = a['session.id'];
    if (r.name === 'claude_code.user_prompt') { pending.set(sid, (pending.get(sid) || 0) + typedTokens(+a.prompt_length || 0)); continue; }
    if (r.name !== 'claude_code.api_request' || isHarness(a.query_source)) continue;
    const m = (a.model || 'unknown'); const x = M[m] ??= blank();
    const d = { requests: 1, input: +a.input_tokens || 0, output: +a.output_tokens || 0, cacheRead: +a.cache_read_tokens || 0,
      cacheWrite: +a.cache_creation_tokens || 0, cost: +a.cost_usd || 0, typed: pending.get(sid) || 0 };
    pending.delete(sid);
    for (const k of Object.keys(d)) x[k] += d[k];
    x.src.add(rowSource(r));
    if (m !== name) continue;
    const dd = days.get(dayKey(ms)) ?? days.set(dayKey(ms), { ...blank(), total: 0 }).get(dayKey(ms));
    for (const k of Object.keys(d)) dd[k] += d[k]; dd.total += d.input + d.output + d.cacheRead + d.cacheWrite; dd.src.add(rowSource(r));
    const s = sess[sid] ??= { id: sid, ...blank(), total: 0, first: ms, last: ms };
    for (const k of Object.keys(d)) s[k] += d[k]; s.total += d.input + d.output + d.cacheRead + d.cacheWrite; s.last = ms; s.src.add(rowSource(r));
  }
  const mine = M[name]; if (!mine) return null;
  const all = Object.values(M).reduce((t, v) => { for (const k of Object.keys(v)) if (k !== 'src') t[k] = (t[k] || 0) + v[k]; return t; }, {});
  const sc = (t) => (t.input > 0 || t.output > 0 ? cascade(t.input, t.output, t.cacheWrite, t.cacheRead) : null);
  const tot = (t) => t.input + t.output + t.cacheRead + t.cacheWrite;
  const f = (t) => { const c = sc(t); return { yield: num(c?.yield), velocity: num(c?.velocity), leverage: num(c?.leverage), snr: num(c?.snr), cls: c?.class ?? null,
    output: t.output, requests: t.requests, typed: t.typed, total: tot(t), cost: t.cost,
    hitRate: t.cacheRead + t.cacheWrite + t.input ? t.cacheRead / (t.cacheRead + t.cacheWrite + t.input) : null }; };
  // "All models" uses the board's own totals (all typed input), so it matches the headline Υ.
  all.typed = summarize(rows, { sinceMs }).total.typed;
  const a = f(all); const m = f(mine);
  const LABELS = [['yield', 'Υ Yield'], ['velocity', 'Velocity (O/I)'], ['leverage', 'Leverage (CR/I)'], ['snr', 'SNR'], ['output', 'Output'],
    ['requests', 'Requests'], ['typed', 'Typed input'], ['total', 'Σ Tokens'], ['hitRate', 'Cache hit rate'], ['cost', 'Cost $']];
  const order = Object.entries(M).sort((p, q) => tot(q[1]) - tot(p[1])).map(([k]) => k); const i = order.indexOf(name);
  return {
    name, source: mixSource(mine.src), windowDays,
    stats: LABELS.map(([k, label]) => ({ k, label, model: m[k], all: a[k], diff: m[k] != null && a[k] != null ? m[k] - a[k] : null })),
    totals: { ...m, input: mine.input, cacheRead: mine.cacheRead, cacheWrite: mine.cacheWrite, share: tot(all) ? tot(mine) / tot(all) : 0 },
    daily: [...days.entries()].sort().map(([day, d]) => { const c = sc(d); return { day, source: mixSource(d.src), requests: d.requests, output: d.output,
      total: d.total, typed: d.typed, yield: num(c?.yield) }; }),
    sessions: Object.values(sess).sort((p, q) => q.total - p.total).slice(0, 10).map(({ src, ...s }) => { const c = sc(s);
      return { ...s, source: mixSource(src), project: projectOf(s.id), yield: num(c?.yield), cls: c?.class ?? null }; }),
    prev: order[i - 1] || null, next: order[i + 1] || null,
  };
}

// Υ = cacheRead·output / input². What does each lever need, alone, to hit the target? (typed input)
export function calc(rows, target, { sinceMs = 0 } = {}) {
  const t = summarize(rows, { sinceMs }).total; const I = t.typed, O = t.output, CR = t.cacheRead;
  const y = I > 0 ? (CR * O) / (I * I) : null;
  const ok = I > 0 && O > 0 && CR > 0 && target > 0;
  return { target: target || null, current: { input: I, output: O, cacheRead: CR, yield: y },
    needs: ok ? { output_needed: (target * I * I) / CR, cacheRead_needed: (target * I * I) / O, input_max: Math.sqrt((CR * O) / target) } : null,
    note: 'Each lever alone, others held fixed. Input uses typed tokens (local-only).' };
}

// ---- Operator card (468x100 SVG) ----
const THEMES = { dark: { bg: '#0b0d10', fg: '#e8eaed', mute: '#8b929a', line: '#262b31', acc: '#7dd3a8' },
  light: { bg: '#fafaf7', fg: '#16181b', mute: '#6a7078', line: '#d9dbd6', acc: '#0f8a5f' } };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const big = (n) => (n >= 1e9 ? `${+(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}K` : `${Math.round(n)}`);
const MIX = ['#7dd3a8', '#6aa8f0', '#e6b455', '#d98aa8', '#9a8cf0'];

export function card(rows, daily, { days = 0, theme = 'dark', name = null } = {}) {
  const T = THEMES[theme] || THEMES.dark;
  const s = summarize(rows, { sinceMs: days ? Date.now() - days * 864e5 : 0, windowDays: days }); const b = s.total.board.typed;
  const sum = s.total.input + s.total.output + s.total.cacheRead + s.total.cacheWrite;
  const yv = b ? (b.yield >= 1e4 ? `${(b.yield / 1e3).toFixed(1)}K` : b.yield.toFixed(1)) : '–';
  const label = days ? `${days}d` : 'all time';
  // model mix bar (x 14..224)
  const ms = Object.entries(s.models).map(([k, v]) => [k.replace('claude-', ''), v.input + v.output + v.cacheRead + v.cacheWrite]).sort((p, q) => q[1] - p[1]);
  const mt = ms.reduce((t, [, n]) => t + n, 0) || 1; let x = 14; const bars = [];
  ms.slice(0, 5).forEach(([k, n], i) => { const w = Math.max(1, (n / mt) * 210); bars.push(`<rect x="${x.toFixed(1)}" y="80" width="${w.toFixed(1)}" height="6" fill="${MIX[i]}"><title>${esc(k)} ${(100 * n / mt).toFixed(0)}%</title></rect>`); x += w; });
  // sparkline of daily Υ (x 250..454, y 54..90), oldest -> newest
  const pts = daily.filter((d) => d.yield != null && d.yield > 0).slice(0, days || 60).reverse().map((d) => Math.log10(1 + d.yield));
  let spark = '';
  if (pts.length > 1) {
    const lo = Math.min(...pts), hi = Math.max(...pts) || 1; const sp = hi - lo || 1;
    spark = `<polyline fill="none" stroke="${T.acc}" stroke-width="1.5" stroke-linejoin="round" points="${pts.map((v, i) => `${(250 + (i / (pts.length - 1)) * 204).toFixed(1)},${(90 - ((v - lo) / sp) * 34).toFixed(1)}`).join(' ')}"/>`;
  }
  const ff = `font-family="ui-monospace,SFMono-Regular,Menlo,monospace"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="468" height="100" viewBox="0 0 468 100" role="img" aria-label="SigRank operator card">
<rect width="468" height="100" rx="6" fill="${T.bg}" stroke="${T.line}"/>
<text x="14" y="22" ${ff} font-size="12" font-weight="700" fill="${T.fg}">${esc(name || 'operator')}</text>
<text x="454" y="22" ${ff} font-size="9" text-anchor="end" fill="${T.mute}">SigRank · ${esc(label)}</text>
<text x="14" y="52" ${ff} font-size="26" font-weight="700" fill="${T.acc}">Υ ${esc(yv)}</text>
<text x="130" y="40" ${ff} font-size="10" fill="${T.mute}">CLASS</text><text x="130" y="53" ${ff} font-size="12" font-weight="700" fill="${T.fg}">${esc(b?.class || '–')}</text>
<text x="180" y="40" ${ff} font-size="10" fill="${T.mute}">C:I:O</text><text x="180" y="53" ${ff} font-size="11" fill="${T.fg}">${esc(b?.cio || '–')}</text>
<text x="14" y="72" ${ff} font-size="10" fill="${T.mute}">Σ ${esc(big(sum))} tokens</text>
<text x="250" y="40" ${ff} font-size="9" fill="${T.mute}">daily Υ</text>
${bars.join('')}${spark}
</svg>`;
}

// ---- Board submit (preview only unless config allows) ----
const WINDOW = { 7: '7d', 30: '30d', 90: '90d', 0: 'all' };
export async function submit(rows, cfg, { days = 0, dryRun = true } = {}) {
  const mcp = cfg.mcpPath;
  if (!(days in WINDOW)) return { status: 400, body: { error: `The board has no ${days === 1 ? '24-hour' : days + '-day'} window. Pick 7D, 30D, 90D or All to submit` } };
  let sub, sign, ks;
  const load = async (d) => [await import(`${d}/submit/index.mjs`), await import(`${d}/identity/sign.mjs`), await import(`${d}/identity/keystore.mjs`)];
  try {
    try { [sub, sign, ks] = await load(mcp); }
    catch (e) { // checkout on another branch: fall back to a clean copy of its main branch
      const d = path.join(os.tmpdir(), 'sigrank-otel-mcp-main');
      if (!fs.existsSync(`${d}/submit/index.mjs`)) {
        fs.mkdirSync(d, { recursive: true });
        execFileSync('sh', ['-c', 'git -C "$1" archive main | tar -x -C "$2"', 'sh', mcp, d], { stdio: 'ignore' });
      }
      try { [sub, sign, ks] = await load(d); } catch { throw e; }
    }
  } catch (e) { return { status: 501, body: { error: `Could not load sigrank-mcp from ${mcp}. If that folder is on a different git branch than main, switch it back to main (or set mcpPath in the config to a clean copy)`, detail: e.message } }; }
  const wk = WINDOW[days];
  const t = summarize(rows, { sinceMs: days ? Date.now() - days * 864e5 : 0, windowDays: days }).total;
  // Logged (not typed) input: typed input stays local-only.
  const pillars = { input: t.input, output: t.output, cacheCreate: t.cacheWrite, cacheRead: t.cacheRead };
  const id = ks.loadIdentity();
  const identity = { codename: id?.codename || cfg.codename || 'unenrolled', device_id: id?.device_id || 'unenrolled',
    agent_version: id?.agent_version || 'sigrank-otel-cc', public_key: id?.public_key || '', operator_id: id?.operator_id };
  const payload = sub.buildPayload(wk, pillars, t.requests, identity, 'claude');
  payload.metadata = { source: 'otel-cc' };
  payload.agent.snapshot_hash = ''; payload.agent.snapshot_hash = sign.snapshotHash(payload);
  const base = { window: wk, enrolled: !!(id?.codename && id?.operator_id), payload };
  if (dryRun || !cfg.allowSubmit) {
    return { status: 200, body: { ...base, status: 'dry_run', sent: false,
      reason: dryRun ? 'dryRun requested' : 'sending is off (set allowSubmit in the config)',
      would_post: 'https://signalaf.com/api/v1/snapshots' } };
  }
  if (!base.enrolled || !id.private_key_pkcs8_b64) return { status: 409, body: { ...base, status: 'not_enrolled', sent: false, detail: 'Run `npx sigrank-mcp enroll` first.' } };
  const signature = sign.signPayload(payload, id.private_key_pkcs8_b64);
  try {
    const r = await fetch(`${process.env.SIGRANK_API_BASE || 'https://signalaf.com'}/api/v1/snapshots`, { method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-agent-signature': signature }, body: JSON.stringify(payload) });
    return { status: r.ok ? 200 : 502, body: { window: wk, status: r.ok ? 'sent' : 'rejected', sent: r.ok, http: r.status, ack: await r.json().catch(() => null) } };
  } catch (e) { return { status: 502, body: { window: wk, status: 'error', sent: false, detail: e.message } }; }
}
