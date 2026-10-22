#!/usr/bin/env node
// Minimal OTLP/HTTP JSON receiver for Claude Code telemetry.
// Appends every metric datapoint, span, and log record to a JSONL file.
// Usage: node receiver.mjs [port] [out]  (defaults from src/config.mjs)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { summarize, otelSpan } from './score.mjs';
import { decodeOtlp } from './protobuf.mjs';
import { rotate, prune, reader } from './store.mjs';
import { history as hist } from './history.mjs';
import { sigrankRow } from './sigrank.mjs';
import { sessionsList, sessionDetail } from './sessions.mjs';
import { loadConfig } from './config.mjs';
import { configureClassifier } from './classify.mjs';
import { usage } from './usage.mjs';
import { deltas, modelDetail, calc, card, submit } from './extras.mjs';
import { gitStatus, gitView } from './git.mjs';
import { artifactView, artifactScan } from './artifact.mjs';

const cfg = loadConfig();
configureClassifier(cfg.classify);

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || cfg.port);
const out = path.resolve(process.argv[3] || cfg.out);
fs.mkdirSync(path.dirname(out), { recursive: true });
// History from transcripts (node backfill.mjs), all strictly before live telemetry began.
const history = path.join(path.dirname(out), 'backfill.jsonl');

// OTLP JSON attribute list -> plain object
const attrs = (list = []) => Object.fromEntries(list.map(({ key, value = {} }) => {
  const v = value.stringValue ?? value.boolValue ?? value.doubleValue ??
    (value.intValue !== undefined ? Number(value.intValue) : undefined) ??
    (value.arrayValue ? value.arrayValue.values : value.kvlistValue);
  return [key, v];
}));
// Identity and content never get written: keep session.id, drop account/email/prompt text.
const DROP = /^(user\.|organization\.id$|prompt$|prompt_text$|response\.model_output|system_prompt_preview)/;
const scrub = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !DROP.test(k)));
const num = (p) => p.asDouble ?? (p.asInt !== undefined ? Number(p.asInt) : undefined);

function flatten(kind, body) {
  const rows = [];
  if (kind === 'metrics') {
    for (const rm of body.resourceMetrics || []) {
      const res = attrs(rm.resource?.attributes);
      for (const sm of rm.scopeMetrics || []) for (const m of sm.metrics || []) {
        const data = m.sum || m.gauge || m.histogram || {};
        for (const p of data.dataPoints || []) rows.push({
          kind, name: m.name, value: num(p) ?? p.sum, temporality: data.aggregationTemporality,
          start: p.startTimeUnixNano, time: p.timeUnixNano, attrs: scrub(attrs(p.attributes)), res: scrub(res),
        });
      }
    }
  } else if (kind === 'traces') {
    for (const rs of body.resourceSpans || []) {
      const res = attrs(rs.resource?.attributes);
      for (const ss of rs.scopeSpans || []) for (const s of ss.spans || []) rows.push({
        kind, name: s.name, trace: s.traceId, span: s.spanId, parent: s.parentSpanId,
        start: s.startTimeUnixNano, end: s.endTimeUnixNano, attrs: scrub(attrs(s.attributes)),
        events: (s.events || []).map((e) => ({ name: e.name, attrs: scrub(attrs(e.attributes)) })), res: scrub(res),
      });
    }
  } else if (kind === 'logs') {
    for (const rl of body.resourceLogs || []) {
      const res = attrs(rl.resource?.attributes);
      for (const sl of rl.scopeLogs || []) for (const r of sl.logRecords || []) rows.push({
        kind, name: r.body?.stringValue, time: r.timeUnixNano, attrs: scrub(attrs(r.attributes)), res: scrub(res),
      });
    }
  }
  return rows;
}

// Public leaderboard via the SignalAF MCP endpoint (read-only), cached 5 min per window.
const BOARD_URL = 'https://signalaf.com/api/plugins/sigrank/mcp';
const MY_CODENAME = cfg.codename;
const boardCache = new Map();
async function board(win) {
  const hit = boardCache.get(win);
  if (hit && Date.now() - hit.at < 300000) return hit.data;
  try { return await boardFetch(win); }
  catch (e) { if (hit) return hit.data; throw e; } // upstream slow or down: serve the last good copy
}
async function boardFetch(win) {
  const r = await fetch(BOARD_URL, { method: 'POST', signal: AbortSignal.timeout(30000),
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_leaderboard', arguments: { window: win, limit: 25, view: 'total' } } }) });
  const text = await r.text();
  const line = text.split('\n').find((l) => l.startsWith('data:')) || text;
  const payload = JSON.parse(JSON.parse(line.replace(/^data:\s*/, '')).result.content[0].text);
  const entries = (payload.data?.entries || []).map((e) => ({
    rank: e.rank, name: e.display_name, codename: e.codename, cls: e.class_tier, archetype: e.archetype,
    pillars: e.pillars, metrics: e.metrics, ratio: e.operating_ratio,
    you: !!MY_CODENAME && e.codename === MY_CODENAME, observedAt: e.provenance?.observed_at || null, // day-level board snapshot date
  }));
  const data = { window: win, field: entries.length, top: entries[0] || null, you: entries.find((e) => e.you) || null, entries };
  boardCache.set(win, { at: Date.now(), data });
  return data;
}

// Monthly rollover (never deletes) at start and daily; retention only if retentionDays is set.
const maintain = () => { try { rotate(out); prune(out, cfg.retentionDays); } catch (e) { console.error(`[maintain] ${e.message}`); } };
maintain(); setInterval(maintain, 36e5).unref();

const json = (res, code, d) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(d));
const allRows = reader(history, out);
// Cache responses per URL; recompute only when the row count changed (entries also expire after 60s (windows) or 10 min).
const memo = new Map();
function cached(res, u, make) {
  const local = isLocal(res.req);
  const rows = allRows(), days = Number(u.searchParams.get('days') || 0), k = u.pathname + u.search + (local ? '' : '|public'), hit = memo.get(k);
  let r = hit && hit.n === rows.length && Date.now() - hit.at < (days ? 6e4 : 6e5) ? hit.r : null;
  if (!r) { r = make(rows); if (!local && r[1] === J) r = [r[0], r[1], maskProjects(r[2])]; if (memo.size > 200) memo.clear(); memo.set(k, { n: rows.length, at: Date.now(), r }); }
  res.writeHead(r[0], r[1]).end(r[2]);
}
// Off this machine, project names (cwd folder = repo name) become stable per-process aliases: same project, same alias, no name.
const PROJECT_KEY = crypto.randomBytes(16);
const projectAlias = (p) => (p === 'unknown' ? p : 'project ' + crypto.createHmac('sha256', PROJECT_KEY).update(String(p)).digest('hex').slice(0, 4));
const maskProjects = (body) => JSON.stringify(JSON.parse(body), (k, v) => (k === 'project' && typeof v === 'string' ? projectAlias(v) : v));
// git-local shadow counts (src/git.mjs): answered from cache, never waits on git. Same window and OTel-paired span as the dashboard.
let spanMemo = { at: 0 };
const dataSpan = () => { if (Date.now() - spanMemo.at > 6e4) spanMemo = { at: Date.now(), ...otelSpan(allRows()) }; return spanMemo; };
function gitWindows(days) {
  const now = Date.now(), sp = dataSpan(), since = days ? now - days * 864e5 : (isFinite(sp.any) ? sp.any : now - 90 * 864e5);
  const paired = isFinite(sp.otel) && sp.otel > since ? sp.otel : since;  // OTel counters exist only from here; the paired git span matches them
  return { since, paired };
}
const WINDOWS = [0, 1, 7, 30, 90];  // the dashboard's windows: /api/git and /api/artifact start background work per window, so nothing else is accepted
const J = { 'content-type': 'application/json' };
const ok = (d, code = 200) => [code, J, JSON.stringify(d)];

// Read-only from anywhere but this machine: a tunnel or proxy (Host not loopback) gets the dashboard and GET /api/*
// only. No OTLP ingest, no submit, no config. Claude Code always posts to 127.0.0.1, so local ingest is unaffected.
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const isLocal = (req) => LOCAL_HOST.test(req.headers.host || '') && !req.headers['cf-connecting-ip'] && !req.headers['x-forwarded-for'];

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (!isLocal(req) && (req.method !== 'GET' || u.pathname === '/api/config')) { req.resume(); return json(res, 403, { error: 'read-only outside localhost' }); }
  if (req.method === 'POST' && u.pathname === '/api/submit') {
    try { const r = await submit(allRows(), cfg, { days: Number(u.searchParams.get('days') || 0), dryRun: u.searchParams.get('dryRun') !== '0' }); json(res, r.status, r.body); }
    catch (e) { console.error(`[submit] ${e.stack}`); json(res, 500, { error: e.message }); }
    req.resume(); return;
  }
  if (req.method === 'GET') {
    const days = Number(u.searchParams.get('days') || 0);
    const sinceMs = days ? Date.now() - days * 864e5 : 0;
    try {
      if (u.pathname === '/api/deltas') return cached(res, u, (rows) => ok(deltas(rows)));
      if (u.pathname === '/api/model') return cached(res, u, (rows) => {
        const d = modelDetail(rows, u.searchParams.get('name') || '', { sinceMs, windowDays: days });
        return ok(d || {}, d ? 200 : 404);
      });
      if (u.pathname === '/api/calc') return cached(res, u, (rows) => ok(calc(rows, Number(u.searchParams.get('target')) || 0, { sinceMs })));
      if (u.pathname === '/card.svg') return cached(res, u, (rows) => [200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=60' },
        card(rows, hist(rows).dailies, { days, theme: u.searchParams.get('theme'), name: cfg.codename })]);
      if (u.pathname === '/api/sessions' || u.pathname === '/api/session') return cached(res, u, (rows) => {
        const d = u.pathname === '/api/sessions' ? sessionsList(rows, { sinceMs }) : sessionDetail(rows, u.searchParams.get('id'), { sinceMs });
        return ok(d || {}, d ? 200 : 404);
      });
      if (u.pathname === '/api/sigrank') {
        if (days !== 1) return json(res, 200, sigrankRow(days));
        const t = summarize(allRows(), { sinceMs, windowDays: 1 }).total;
        return json(res, 200, { window: '24h', grade: 'computed', inputs: t.grade, inputGrades: t.grades, row: t.board.logged, t: { output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite, requests: t.requests, cost: t.cost } });
      }
      if (u.pathname === '/api/git') {
        if (!WINDOWS.includes(days)) return json(res, 400, { error: 'days must be one of 0, 1, 7, 30, 90' });
        const w = gitWindows(days), local = isLocal(req), whole = gitStatus(cfg, w.since, `w${days}`), same = w.paired === w.since;
        return json(res, 200, { grade: 'git-local', rules: 'docs/git-counting-rules.md', days, window: gitView(whole, { local }),
          paired: { same, ...(same ? gitView(whole, { local }) : gitView(gitStatus(cfg, w.paired, `p${days}`), { local })) } });
      }
      // Tier-2 derived artifact measurement (src/artifact.mjs): class x day aggregates from transcript edit payloads. Answers from cache, never waits on the scan.
      if (u.pathname === '/api/artifact') {
        if (!WINDOWS.includes(days)) return json(res, 400, { error: 'days must be one of 0, 1, 7, 30, 90' });
        const w = gitWindows(days); return json(res, 200, { days, ...artifactView(allRows(), { since: w.since, paired: w.paired }) }); }
      // Claude Code's own /usage panel numbers, reproduced from transcripts.
      if (u.pathname === '/api/usage') return json(res, 200, usage(days));
      if (u.pathname === '/api/summary') return cached(res, u, (rows) => ok({ ...summarize(rows, { sinceMs, windowDays: days }), ...hist(rows) }));
      // Board-comparable pillars for sigrank-mcp's `otel` source (logged input; harness calls excluded, like transcripts).
      if (u.pathname === '/api/pillars') return cached(res, u, (rows) => {
        const window = u.searchParams.get('window') || '7d'; const wd = { '7d': 7, '30d': 30, '90d': 90, all: 0 }[window];
        if (wd === undefined) return ok({ error: 'window must be 7d|30d|90d|all' }, 400);
        const since = wd ? Date.now() - wd * 864e5 : null, S = summarize(rows, { sinceMs: since || 0, windowDays: wd });
        const pick = (t) => ({ input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite, requests: t.requests });
        return ok({ source: 'otel-cc', window, sinceMs: since, grade: S.total.grade, grades: S.total.grades, total: pick(S.total), models: Object.fromEntries(Object.entries(S.models).map(([k, v]) => [k, pick(v)])) });
      });
      if (u.pathname === '/api/config') return json(res, 200, { port, dataDir: cfg.dataDir, out, codename: cfg.codename, cascadePath: cfg.cascadePath,
        retentionDays: cfg.retentionDays, allowSubmit: cfg.allowSubmit });
    } catch (e) { console.error(`[${u.pathname}] ${e.stack}`); return json(res, 500, { error: e.message }); }
    if (u.pathname === '/api/board') {
      const win = { 1: '7d', 7: '7d', 30: '30d', 90: '90d', 0: 'all' }[u.searchParams.get('days') || '7'] || '7d';
      try { const d = await board(win); res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(d)); }
      catch (e) { console.error(`[board] ${e.message}`); res.writeHead(502).end('{}'); }
      return;
    }
    if (['/docs/git-counting-rules.md', '/docs/artifact-measurement.md', '/docs/classification.md', '/docs/cost-estimate.md'].includes(u.pathname)) {
      try { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(fs.readFileSync(path.join(here, '..', 'docs', path.basename(u.pathname)))); }
      catch { res.writeHead(404).end(); }
      return;
    }
    if (u.pathname === '/' || u.pathname === '/dashboard') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });  // always revalidate: the page changes with the code
      res.end(fs.readFileSync(path.join(here, 'dashboard.html')));
      return;
    }
  }
  const kind = { '/v1/metrics': 'metrics', '/v1/traces': 'traces', '/v1/logs': 'logs' }[req.url];
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (!kind || req.method !== 'POST') { res.writeHead(404).end(); return; }
    const type = req.headers['content-type'] || '', proto = /protobuf/.test(type);
    if (!proto && !type.includes('json')) {
      console.error(`[${kind}] got ${type}; use http/json or http/protobuf`);
      res.writeHead(415).end(); return;
    }
    try {
      let body = Buffer.concat(chunks);
      const enc = (req.headers['content-encoding'] || '').toLowerCase();
      if (enc === 'gzip' || enc === 'x-gzip') body = zlib.gunzipSync(body, { maxOutputLength: 256 << 20 });
      else if (enc === 'deflate') body = zlib.inflateSync(body, { maxOutputLength: 256 << 20 });
      else if (enc && enc !== 'identity') { res.writeHead(415).end(); return; }
      const rows = flatten(kind, proto ? decodeOtlp(kind, body) : JSON.parse(body.toString('utf8')));
      // Hook/plugin bookkeeping is ~40% of volume and unused by scoring; skip it.
      const keep = rows.filter((r) => !/claude_code\.(hook_|plugin_loaded|mcp_server_connection|managed_settings)/.test(r.name || ''));
      if (keep.length) fs.appendFileSync(out, keep.map((r) => JSON.stringify(r)).join('\n') + '\n');
      proto ? res.writeHead(200, { 'content-type': 'application/x-protobuf' }).end() : res.writeHead(200, J).end('{}');
    } catch (e) {
      console.error(`[${kind}] bad payload: ${e.message}`);
      res.writeHead(400).end();
    }
  });
}).listen(port, '127.0.0.1', () => {
  console.log(`tokenpull-otel receiver on http://127.0.0.1:${port} (dashboard at /) -> ${out}`);
  setTimeout(() => { try { gitStatus(cfg, gitWindows(7).since, 'w7'); artifactScan(); } catch {} }, 2000).unref();  // warm the 7d git count in the background
});
