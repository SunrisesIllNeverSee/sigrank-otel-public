// Tier-2 artifact measurement ("derived"): how much of Claude's output was generated file text, from transcript tool payloads.
// Counts ONLY generated text: Edit new_string (never old_string), Write content, MultiEdit edits[].new_string, NotebookEdit new_source.
// Transcripts are read at compute time; only per-edit numbers (class, day, chars, lines) are kept. Never content, paths or file names.
// Tier 2b (operations): Bash/Monitor commands and MCP calls are categorized in memory by src/operations.mjs; only category, day, call count and char count are kept.
// Method, class mapping and constants: docs/artifact-measurement.md. Never blocks a request: artifactView() answers from cache.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sourceOf, rowGrade, msOf } from './score.mjs';
import { classify, CLASSES, CLASSIFIER_VERSION } from './classify.mjs';
import { operation, CATEGORIES, OPS_VERSION } from './operations.mjs';

export const RULES_VERSION = 'artifact-derived/4';
export { CLASSES };
export const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

// The class of a file comes from the shared classifier (src/classify.mjs, docs/classification.md): path role first, extension second.

// Fallback tokens per character when the operator's own data cannot support a fit: the slope already used for typed prompts (score.mjs typedTokens).
export const FALLBACK_TPC = 0.454;
const MIN_FIT_N = 30, MIN_FIT_R2 = 0.5, MIN_GEN = 200, DOMINANT = 0.9, NONGEN_MAX = 0.1;

const ROOT = path.join(os.homedir(), '.claude/projects');
const TTL = 60e3;
const str = (v) => (typeof v === 'string' ? v : '');
const nlines = (s) => { if (!s) return 0; let n = 1; for (let i = 0; i < s.length - 1; i++) if (s.charCodeAt(i) === 10) n++; return n; };  // a trailing newline does not start a line
const localDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// Generated text of one tool_use block: { cls, chars, lines } or null. The file path is read only to pick the class, then dropped.
function generated(b) {
  const i = b.input || {}; let texts;
  if (b.name === 'Edit') texts = [str(i.new_string)];
  else if (b.name === 'Write') texts = [str(i.content)];
  else if (b.name === 'MultiEdit') texts = (Array.isArray(i.edits) ? i.edits : []).map((e) => str(e?.new_string));
  else if (b.name === 'NotebookEdit') texts = i.edit_mode === 'delete' ? [] : [str(i.new_source)];
  else return null;
  const cls = b.name === 'NotebookEdit' ? (i.cell_type === 'markdown' ? 'docs' : 'code') : classify(i.file_path);
  return { cls, chars: texts.reduce((n, t) => n + t.length, 0), lines: texts.reduce((n, t) => n + nlines(t), 0) };
}

// --- transcript scan: per-file state, parsed incrementally (only appended bytes are read again) ---
const files = new Map();   // file -> { offset, first, edits: Map(id -> edit), ops: Map(id -> operation), reqs: Map(requestId -> { g, nonGen }) }
const state = { status: 'pending', at: 0, running: false, version: 0, error: null, scanned: 0, merged: null };

async function readFrom(file, start, onLines) {
  let rest = Buffer.alloc(0), consumed = 0;
  for await (const chunk of fs.createReadStream(file, { start })) {
    const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk, cut = buf.lastIndexOf(10);
    if (cut < 0) { rest = buf; continue; }
    onLines(buf.subarray(0, cut).toString('utf8').split('\n')); consumed += cut + 1; rest = buf.subarray(cut + 1);
  }
  return start + consumed;
}
function parseLines(f, lines) {
  for (const line of lines) {
    if (!line) continue;
    if ((f.edits.size || f.ops.size) && line.includes('"type":"user"') && line.includes('"tool_result"')) {  // a result line always follows its tool_use; only a failed result needs parsing
      if (line.includes('"is_error":true')) {
        try { for (const b of JSON.parse(line).message?.content || []) if (b?.type === 'tool_result' && b.is_error) { const e = f.edits.get(b.tool_use_id) || f.ops.get(b.tool_use_id); if (e) e.err = true; } } catch {}
      }
      continue;
    }
    if (!line.includes('"type":"assistant"')) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r.type !== 'assistant' || !Array.isArray(r.message?.content)) continue;
    const ms = Date.parse(r.timestamp || ''); if (ms < f.first) f.first = ms;
    const q = r.requestId ? (f.reqs.get(r.requestId) ?? { g: Object.fromEntries(CLASSES.map((c) => [c, 0])), nonGen: 0 }) : null;
    for (const b of r.message.content) {
      if (b?.type === 'text') { if (q) q.nonGen += str(b.text).length; continue; }
      if (b?.type !== 'tool_use') continue;
      const g = generated(b);
      if (!g) {
        if (q) q.nonGen += JSON.stringify(b.input ?? {}).length + str(b.name).length;  // the fit still treats every non-file-text argument as non-generated, so tier 2b cannot move the rate
        const o = ms && !f.ops.has(b.id) ? operation(b) : null;  // tier 2b: command or MCP input text is read here, classed in memory, and only the category and length are kept
        if (o) f.ops.set(b.id, { sid: r.sessionId || '', ms, cat: o.cat, via: o.via, chars: o.chars, fp: o.files?.length ? o.files : null, err: false });
        continue;
      }
      if (!ms || f.edits.has(b.id)) continue;
      f.edits.set(b.id, { sid: r.sessionId || '', ms, cls: g.cls, chars: g.chars, lines: g.lines, err: false });
      if (q) q.g[g.cls] += g.chars;
    }
    if (q) f.reqs.set(r.requestId, q);
  }
}
async function* walk(dir) {
  let ents; try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) { const p = path.join(dir, e.name); if (e.isDirectory()) yield* walk(p); else if (e.name.endsWith('.jsonl')) yield p; }
}
async function scanAll() {
  const seen = new Set();
  for await (const file of walk(ROOT)) {
    seen.add(file);
    let st; try { st = await fs.promises.stat(file); } catch { continue; }
    let f = files.get(file);
    if (!f || st.size < f.offset) { f = { offset: 0, first: Infinity, edits: new Map(), ops: new Map(), reqs: new Map() }; files.set(file, f); }
    if (st.size > f.offset) { try { f.offset = await readFrom(file, f.offset, (ls) => parseLines(f, ls)); } catch {} }
  }
  for (const k of [...files.keys()]) if (!seen.has(k)) files.delete(k);
  // Merge across files: resumed and forked sessions copy earlier records into new files, so de-duplicate by id.
  const edits = new Map(), ops = new Map(), reqs = new Map(); let first = Infinity;
  for (const f of files.values()) {
    if (f.first < first) first = f.first;
    for (const [id, e] of f.edits) { const o = edits.get(id); if (!o) edits.set(id, { ...e }); else o.err ||= e.err; }
    for (const [id, e] of f.ops) { const o = ops.get(id); if (!o) ops.set(id, { ...e }); else o.err ||= e.err; }
    for (const [id, q] of f.reqs) { const o = reqs.get(id), tot = (x) => CLASSES.reduce((n, c) => n + x.g[c], 0); if (!o || tot(q) > tot(o)) reqs.set(id, q); }
  }
  state.merged = { edits, ops, reqs, first: isFinite(first) ? first : null }; state.scanned = files.size; state.version++;
}
// Starts a background refresh when the cache is older than TTL. Safe to call on every request.
export function artifactScan() {
  if (state.running || Date.now() - state.at < TTL) return;
  state.running = true;
  scanAll().then(() => { state.status = 'ready'; state.error = null; }).catch((e) => { state.error = e.message; if (!state.merged) state.status = 'error'; })
    .finally(() => { state.running = false; state.at = Date.now(); });
}

// --- OTel side: tool_decision events (by tool_use_id), reported api_request rows (output tokens by request_id, per time and session) ---
let idxMemo = { n: -1 };
function otelIndex(rows) {
  if (idxMemo.n === rows.length) return idxMemo;
  const dec = new Map(), out = new Map(), api = [];
  for (const r of rows) {
    const a = r.attrs || {};
    if (a.backfill) continue;
    if (r.name === 'claude_code.tool_decision') { if (a.tool_use_id) dec.set(a.tool_use_id, a.decision === 'reject' ? 'reject' : 'accept'); }  // by id only: for MCP calls OTel's tool_name is generic
    else if (r.name === 'claude_code.api_request' && rowGrade(r) === 'reported') {
      const o = +a.output_tokens || 0; if (a.request_id) out.set(a.request_id, o);
      if (sourceOf(a.query_source) !== 'harness') api.push({ ms: msOf(r), sid: a['session.id'] || '', out: o });  // same population as summarize().ship.outputReported
    }
  }
  return (idxMemo = { n: rows.length, dec, out, api });
}

// --- chars -> tokens: fit from the operator's own data ---
// Joins transcript requests (generated chars) to the reported output_tokens of the same request_id, keeps requests that are almost all
// generated file text, and fits output_tokens = a + b * chars by least squares. The slope b is tokens per character; the intercept absorbs
// per-request overhead (tool-call wrapper, thinking). Fit per class where a class has enough requests, else pooled, else the constant.
function ols(P) {
  const n = P.length; let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of P) { sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y; }
  const den = n * sxx - sx * sx; if (!(n > 1) || !den) return null;
  const b = (n * sxy - sx * sy) / den, a = (sy - b * sx) / n, my = sy / n;
  let ss = 0, res = 0; for (const p of P) { ss += (p.y - my) ** 2; res += (p.y - a - b * p.x) ** 2; }
  return { n, slope: b, intercept: a, r2: ss ? 1 - res / ss : 0 };
}
const usable = (f) => f && f.n >= MIN_FIT_N && f.slope > 0 && f.r2 >= MIN_FIT_R2;
let fitMemo = { k: '' };
function ratioFit(idx) {
  const k = `${state.version}|${idx.n}`;
  if (fitMemo.k === k) return fitMemo.v;
  const pts = { all: [], ...Object.fromEntries(CLASSES.map((c) => [c, []])) };
  for (const [id, q] of state.merged?.reqs || []) {
    const y = idx.out.get(id); if (y == null) continue;
    const gen = CLASSES.reduce((n, c) => n + q.g[c], 0);
    if (gen < MIN_GEN || q.nonGen > NONGEN_MAX * gen) continue;  // keep requests that are nearly all generated file text
    pts.all.push({ x: gen, y });
    for (const c of CLASSES) if (q.g[c] >= DOMINANT * gen) pts[c].push({ x: gen, y });
  }
  const pooled = ols(pts.all), tpc = {}, fit = {}, source = {};
  for (const c of CLASSES) {
    const f = ols(pts[c]); fit[c] = f && { n: f.n, r2: round(f.r2, 3), intercept: Math.round(f.intercept), tokensPerChar: round(f.slope, 4) };
    if (usable(f)) { tpc[c] = f.slope; source[c] = 'class fit'; }
    else if (usable(pooled)) { tpc[c] = pooled.slope; source[c] = 'pooled fit'; }
    else { tpc[c] = FALLBACK_TPC; source[c] = 'constant'; }
  }
  const ops = usable(pooled) ? { tpc: pooled.slope, source: 'pooled fit' } : { tpc: FALLBACK_TPC, source: 'constant' };  // tier 2b always uses the pooled rate
  const v = { tpc, source, fit, ops, pooled: pooled && { n: pooled.n, r2: round(pooled.r2, 3), intercept: Math.round(pooled.intercept), tokensPerChar: round(pooled.slope, 4) } };
  fitMemo = { k, v };
  return v;
}
const round = (x, d) => (x == null || !isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

// --- view ---
const blankClass = () => ({ edits: 0, chars: 0, lines: 0 });
const blankOp = () => ({ calls: 0, chars: 0 });
function block(idx, tpc, opsTpc, sinceMs, paired) {
  const cls = Object.fromEntries(CLASSES.map((c) => [c, blankClass()])), daily = {};
  const edits = { seen: 0, joined: 0, unjoined: 0, rejected: 0, failed: 0, counted: 0, countedJoined: 0, countedUnjoined: 0 };
  const ops = Object.fromEntries(CATEGORIES.map((c) => [c, blankOp()])), opsDaily = {}, via = { shell: 0, mcp: 0, agent: 0 }, heredoc = blankOp();
  const calls = { seen: 0, joined: 0, unjoined: 0, rejected: 0, failed: 0, failedChars: 0, counted: 0, countedJoined: 0, countedUnjoined: 0 };
  const sids = paired ? new Set(idx.api.filter((x) => x.ms >= sinceMs).map((x) => x.sid)) : null;  // numerator and denominator come from the same sessions
  for (const [id, e] of state.merged?.edits || []) {
    if (e.ms < sinceMs || (sids && !sids.has(e.sid))) continue;
    const d = idx.dec.get(id); edits.seen++; d ? edits.joined++ : edits.unjoined++;
    if (d === 'reject') { edits.rejected++; continue; }
    if (e.err) { edits.failed++; continue; }
    edits.counted++; d ? edits.countedJoined++ : edits.countedUnjoined++;
    const day = (daily[localDay(e.ms)] ??= Object.fromEntries(CLASSES.map((c) => [c, blankClass()])));
    for (const t of [cls[e.cls], day[e.cls]]) { t.edits++; t.chars += e.chars; t.lines += e.lines; }
  }
  for (const [id, e] of state.merged?.ops || []) {  // tier 2b: same filters as the edits above (paired sessions, rejected, failed), same join by tool_use_id
    if (e.ms < sinceMs || (sids && !sids.has(e.sid))) continue;
    const d = idx.dec.get(id); calls.seen++; d ? calls.joined++ : calls.unjoined++;
    if (d === 'reject') { calls.rejected++; continue; }
    if (e.err) { calls.failed++; calls.failedChars += e.chars; continue; }
    calls.counted++; d ? calls.countedJoined++ : calls.countedUnjoined++; via[e.via]++;
    const day = (opsDaily[localDay(e.ms)] ??= Object.fromEntries(CATEGORIES.map((c) => [c, blankOp()])));
    // Heredoc bodies written into a file are counted under the write (file-ops, or service-config on a system path), not under the call's own category:
    // `cat > t.py <<EOF ... EOF` followed by a test run is one call (build-test-run) whose file text is file-ops. Chars are conserved; the call is counted once.
    let moved = 0; for (const [c, n] of e.fp || []) { moved += n; for (const t of [ops[c], day[c]]) t.chars += n; }
    for (const t of [ops[e.cat], day[e.cat]]) { t.calls++; t.chars += e.chars - moved; }
    if (moved) { heredoc.calls++; heredoc.chars += moved; }
  }
  const tok = (o, c) => ({ ...o, tokens: Math.round(o.chars * tpc[c]) });
  const otok = (o) => ({ ...o, tokens: Math.round(o.chars * opsTpc) });
  const classes = Object.fromEntries(CLASSES.map((c) => [c, tok(cls[c], c)]));
  const sum = (f) => CLASSES.reduce((n, c) => n + f(classes[c]), 0);
  classes.total = { edits: sum((x) => x.edits), chars: sum((x) => x.chars), lines: sum((x) => x.lines), tokens: sum((x) => x.tokens) };
  const cats = Object.fromEntries(CATEGORIES.map((c) => [c, otok(ops[c])]));
  const osum = (cs) => { const t = cs.reduce((n, c) => ({ calls: n.calls + ops[c].calls, chars: n.chars + ops[c].chars }), blankOp()); return otok(t); };
  const work = CATEGORIES.filter((c) => c !== 'inspection');
  const operations = { calls: { ...calls, failedTokens: Math.round(calls.failedChars * opsTpc) }, via, categories: cats,
    work: osum(work), inspection: osum(['inspection']), total: osum(CATEGORIES), heredocFiles: otok(heredoc),
    daily: Object.entries(opsDaily).sort().map(([day, d]) => ({ day, ...Object.fromEntries(CATEGORIES.map((c) => [c, otok(d[c])])) })) };
  return { sinceMs, edits, classes, operations,
    daily: Object.entries(daily).sort().map(([day, d]) => ({ day, ...Object.fromEntries(CLASSES.map((c) => [c, tok(d[c], c)])) })) };
}

// win = { since, paired } (ms). `paired` starts where OTel exists: code share and the residual only make sense there, because
// reported output tokens exist only from then on. The whole window is shown separately, like the git counts.
export function artifactView(rows, win) {
  artifactScan();
  const base = { grade: 'derived', rules: 'docs/artifact-measurement.md', rulesVersion: RULES_VERSION, classifier: CLASSIFIER_VERSION, operationsRules: OPS_VERSION, status: state.status, error: state.error,
    scannedAt: state.at || null, transcripts: state.scanned };
  if (!state.merged) return base;
  const idx = otelIndex(rows), fit = ratioFit(idx), tpc = fit.tpc;
  const otpc = fit.ops.tpc, whole = block(idx, tpc, otpc, win.since, false), same = win.paired <= win.since;
  const p = same ? block(idx, tpc, otpc, win.since, true) : block(idx, tpc, otpc, win.paired, true);
  const out = idx.api.reduce((n, x) => (x.ms >= p.sinceMs ? n + x.out : n), 0);  // reported output tokens in the paired span
  const share = (t) => (out > 0 ? t / out : null), art = p.classes.total.tokens, O = p.operations, resid = out - art - O.total.tokens, before = out - art;
  const paired = { same, ...p, reportedOutput: out,
    shares: { ...Object.fromEntries(CLASSES.map((c) => [c, share(p.classes[c].tokens)])), artifact: share(art),
      operations: { ...Object.fromEntries(CATEGORIES.map((c) => [c, share(O.categories[c].tokens)])), work: share(O.work.tokens), inspection: share(O.inspection.tokens), total: share(O.total.tokens) } },
    // Tier 3: by difference, not measured. Reported output minus tier-2 file text minus ALL tier-2b operations (inspection included).
    // If the estimates overshoot reported output the residual is floored at 0 and flagged. `beforeOperations` is the old tier-2-only residual, for comparison.
    residual: { tokens: Math.max(0, resid), share: share(Math.max(0, resid)), overrun: resid < 0, beforeOperations: { tokens: Math.max(0, before), share: share(Math.max(0, before)) } } };
  return { ...base, ratio: { tokensPerChar: Object.fromEntries(CLASSES.map((c) => [c, round(tpc[c], 4)])), charsPerToken: Object.fromEntries(CLASSES.map((c) => [c, round(1 / tpc[c], 2)])),
      source: fit.source, fit: fit.fit, pooled: fit.pooled, fallback: FALLBACK_TPC,
      operations: { tokensPerChar: round(otpc, 4), charsPerToken: round(1 / otpc, 2), source: fit.ops.source },
      method: 'least squares of reported output_tokens on generated chars, per request_id, over requests that are nearly all generated file text' },
    // Earliest transcript record on disk: transcripts are not kept forever, so edits before this are unknown, not zero.
    transcriptsFromMs: state.merged.first,
    window: whole, paired };
}
