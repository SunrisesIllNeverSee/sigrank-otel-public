// Log storage: monthly rollover of otel.jsonl into otel-YYYY-MM.jsonl, optional retention, readers.
import fs from 'node:fs';
import path from 'node:path';
import { load, forget } from './score.mjs';

const MONTH = /^otel-\d{4}-\d{2}\.jsonl$/;
const rowMs = (r) => { const n = Number(r.time || r.end || r.start); return n ? n / 1e6 : Date.parse(r.attrs?.['event.timestamp']) || null; };
const ym = (ms) => new Date(ms).toISOString().slice(0, 7);
const parse = (l) => { try { return JSON.parse(l); } catch { return null; } };
export const monthFiles = (out) => {
  const dir = path.dirname(out);
  try { return fs.readdirSync(dir).filter((f) => MONTH.test(f)).sort().map((f) => path.join(dir, f)); } catch { return []; }
};
const write = (file, text) => { fs.writeFileSync(file + '.tmp', text); fs.renameSync(file + '.tmp', file); forget(file); };

// Move rows from before the current (UTC) month out of otel.jsonl into monthly files. Never deletes.
export function rotate(out, now = Date.now()) {
  if (!fs.existsSync(out)) return 0;
  const cur = ym(now), keep = [], by = new Map();
  for (const l of fs.readFileSync(out, 'utf8').split('\n')) {
    if (!l) continue;
    const t = parse(l), ms = t && rowMs(t), m = ms && ym(ms);
    if (!m || m >= cur) keep.push(l); else (by.get(m) || by.set(m, []).get(m)).push(l);
  }
  if (!by.size) return 0;
  let moved = 0;
  for (const [m, lines] of by) {
    fs.appendFileSync(path.join(path.dirname(out), `otel-${m}.jsonl`), lines.join('\n') + '\n'); moved += lines.length;
  }
  write(out, keep.length ? keep.join('\n') + '\n' : '');
  console.log(`[rotate] moved ${moved} rows into ${by.size} monthly file(s)`);
  return moved;
}

// Only when retentionDays is set: drop rows older than the cutoff from otel.jsonl and monthly files.
export function prune(out, days, now = Date.now()) {
  if (!days) return 0;
  const cut = now - days * 864e5; let dropped = 0;
  for (const f of [...monthFiles(out), out]) {
    if (!fs.existsSync(f)) continue;
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
    const keep = lines.filter((l) => { const t = parse(l), ms = t && rowMs(t); return ms == null || ms >= cut; });
    if (keep.length === lines.length) continue;
    dropped += lines.length - keep.length;
    if (!keep.length && f !== out) { fs.unlinkSync(f); forget(f); } else write(f, keep.length ? keep.join('\n') + '\n' : '');
  }
  if (dropped) console.log(`[retention] dropped ${dropped} rows older than ${days}d`);
  return dropped;
}

// All rows plus a cheap change signature (total row count) for caching.
export function reader(history, out) {
  return () => {
    const parts = [history, ...monthFiles(out), out].map(load);
    return parts.flat();
  };
}
