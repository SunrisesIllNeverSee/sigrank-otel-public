// The owner's SigRank numbers, computed by sigrank itself (tokenpull + token-cascade), not re-derived here.
// Refreshed in the background every 60s; the dashboard shows these as the primary row.
import { loadConfig } from './config.mjs';
import { cascade } from './score.mjs';

const WIN = { 1: '7d', 7: '7d', 30: '30d', 90: '90d', 0: 'all' };
let state = { at: 0, windows: null, error: null }; let running = false;

async function refresh() {
  if (running) return; running = true;
  try {
    const { tokenpull } = await import(`${loadConfig().mcpPath}/tokenpull.mjs`);
    const r = await tokenpull();
    state = { at: Date.now(), error: null, windows: Object.fromEntries(r.windows.map((w) => [w.window, w])) };
  } catch (e) { state = { ...state, error: e.message }; console.error(`[sigrank] ${e.message}`); }
  finally { running = false; }
}
refresh(); setInterval(refresh, 60000).unref();

// Same row shape as score.mjs boardRow so the dashboard renders it unchanged.
export function sigrankRow(days) {
  const win = WIN[days] ?? '7d', w = state.windows?.[win];
  if (!w) return { window: win, row: null, error: state.error, at: state.at };
  const p = w.pillars, c = cascade(p.input, p.output, p.cacheCreate, p.cacheRead), total = c.pillars.total;
  const wd = { '7d': 7, '30d': 30, '90d': 90 }[win];
  return { window: win, at: state.at, error: state.error, messages: w.messages,
    t: { output: p.output, cacheRead: p.cacheRead, cacheWrite: p.cacheCreate, requests: w.messages, cost: 0 },
    row: { ...c, input: p.input, total, perDay: wd ? total / wd : null, scaleV: total > 0 ? Math.log10(total) : 0,
      construction: p.cacheRead > 0 ? p.cacheCreate / p.cacheRead : 0, costPer1M: 0,
      hitRate: (p.cacheRead + p.cacheCreate + p.input) > 0 ? p.cacheRead / (p.cacheRead + p.cacheCreate + p.input) : 0,
      cio: `${(p.cacheRead / Math.max(p.input, 1)).toFixed(1)}:1:${(p.output / Math.max(p.input, 1)).toFixed(2)}` } };
}
