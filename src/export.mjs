#!/usr/bin/env node
// Export a shareable, self-contained snapshot of the dashboard.
// Pulls every API response the page can ask for, scrubs it, and bakes it into
// one HTML file whose fetch() answers from the embedded data. No receiver needed.
//
//   node src/export.mjs [outDir] [--base http://127.0.0.1:4318]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const base = (args.includes('--base') ? args[args.indexOf('--base') + 1] : null) || 'http://127.0.0.1:4318';
const outDir = args.find((a) => !a.startsWith('--') && a !== base) || path.join(here, '..', 'export');
const WINDOWS = [1, 7, 30, 90, 0];

const get = async (p) => {
  const r = await fetch(base + p);
  if (!r.ok) return null;
  return r.json();
};

// Drop anything that identifies the machine, the person or the wallet; keep tokens and scores.
import os from 'node:os';
import { createHash } from 'node:crypto';
const USER = os.userInfo().username;
const hashId = (id) => 's-' + createHash('sha256').update(String(id)).digest('hex').slice(0, 12);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const scrub = (v, key = '') => {
  if (Array.isArray(v)) return v.map((x) => scrub(x, key));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (/cost/i.test(k)) { o[k] = null; continue; }
      if (['cwd', 'path', 'root', 'dataDir', 'cascadePath', 'out', 'codename', 'display_name', 'displayName', 'handle', 'bio'].includes(k)) continue;
      o[k] = scrub(x, k);
    }
    return o;
  }
  if (typeof v === 'string') {
    let t = v.replace(/\/(Users|home)\/[^/\s"']+/g, '~');
    if (key === 'project' && (t === USER || t === 'unknown')) t = 'home';
    if (key === 'id' || key === 'session' || key === 'sessionId') t = t.replace(UUID, (m) => hashId(m));
    else t = t.replace(UUID, (m) => hashId(m));
    if (/^mcp__/.test(t)) t = 'mcp · ' + t.split('__')[1];
    if (key === 'name' || key === 'tool' || key === 'who') t = t.replace(/^mcp__([^_]+)__.*/, 'mcp · $1');
    return t;
  }
  return v;
};

const snap = {};
const put = (url, data) => { if (data != null) snap[url.replace(UUID, (m) => hashId(m))] = scrub(data); };

console.error(`exporting from ${base}`);
put('/api/deltas', await get('/api/deltas'));
for (const d of WINDOWS) {
  const summary = await get(`/api/summary?days=${d}`);
  put(`/api/summary?days=${d}`, summary);
  put(`/api/sigrank?days=${d}`, await get(`/api/sigrank?days=${d}`));
  put(`/api/board?days=${d}`, await get(`/api/board?days=${d}`));
  put(`/api/usage?days=${d}`, await get(`/api/usage?days=${d}`));
  const list = await get(`/api/sessions?days=${d}`);
  put(`/api/sessions?days=${d}`, list);
  for (const s of list?.sessions || []) put(`/api/session?days=${d}&id=${encodeURIComponent(s.id)}`, await get(`/api/session?days=${d}&id=${encodeURIComponent(s.id)}`));
  for (const name of Object.keys(summary?.models || {})) put(`/api/model?days=${d}&name=${encodeURIComponent(name)}`, await get(`/api/model?days=${d}&name=${encodeURIComponent(name)}`));
  console.error(`  window ${d || 'all'}: ${(list?.sessions || []).length} sessions, ${Object.keys(summary?.models || {}).length} models`);
}

const exportedAt = new Date().toISOString();
const shim = `<script>
window.__SNAPSHOT = ${JSON.stringify({ exportedAt, data: snap })};
(() => {
  const S = window.__SNAPSHOT.data, real = window.fetch.bind(window);
  const reply = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  window.fetch = (u, o) => {
    const k = String(u).replace(/^.*?(?=\/api\/|\/card\.svg)/, '');
    if (k in S) return reply(S[k]);
    if (k.startsWith('/api/calc')) return reply({ snapshot: true, note: 'The Υ calculator needs the live receiver.' });
    if (k.startsWith('/api/submit')) return reply({ error: 'Submitting is disabled in a shared snapshot.' }, 403);
    if (k.startsWith('/api/')) return reply({}, 404);
    return real(u, o);
  };
  document.addEventListener('DOMContentLoaded', () => {
    const b = document.createElement('div');
    b.textContent = 'Snapshot · exported ' + new Date(window.__SNAPSHOT.exportedAt).toLocaleString() + ' · live dashboard runs on the operator\\'s machine';
    b.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;padding:4px 10px;font:11px ui-monospace,monospace;background:#111;color:#9aa;border-top:1px solid #333;text-align:center';
    document.body.appendChild(b);
  });
})();
</script>`;

let html = fs.readFileSync(path.join(here, 'dashboard.html'), 'utf8');
html = html.replace(/<title>[^<]*<\/title>/, '<title>SigRank OTel Snapshot</title>');
html = html.replace('<head>', `<head>\n${shim}`);
// Kill the live pollers and the card/submit buttons' live links; the shim already answers the fetches.
html = html.replace(/setInterval\([^;]*;/g, '');

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'index.html'), html);
// Artifact variant: no document wrapper (the host supplies it), title first so it is found, data last.
const src = fs.readFileSync(path.join(here, 'dashboard.html'), 'utf8');
const head = src.slice(src.indexOf('<head>') + 6, src.indexOf('</head>')).replace(/<meta[^>]*>\s*/g, '').replace(/<title>[^<]*<\/title>\s*/, '');
const body = src.slice(src.indexOf('<body>') + 6, src.indexOf('</body>')).replace(/setInterval\([^;]*;/g, '');
fs.writeFileSync(path.join(outDir, 'artifact.html'), `<title>SigRank OTel Snapshot</title>\n<style>:root{color-scheme:dark}</style>\n${head}\n${shim}\n${body}`);
fs.writeFileSync(path.join(outDir, 'data.json'), JSON.stringify({ exportedAt, data: snap }));
const kb = (f) => Math.round(fs.statSync(path.join(outDir, f)).size / 1024);
console.error(`wrote ${outDir}/index.html (${kb('index.html')} KB), data.json (${kb('data.json')} KB), ${Object.keys(snap).length} responses`);
