// git-local collector (shadow mode): counts YOUR commits' lines from local git history, beside the reported OTel counters.
// Read-only (git log / rev-parse / for-each-ref / check-attr / config --get). Rules as built: docs/git-counting-rules.md.
// Never blocks a request: gitStatus() answers from cache and refreshes in the background.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { classify as classOf, CLASSES, CLASSIFIER_VERSION, classifierSignature } from './classify.mjs';

export const RULES_VERSION = 'git-local/3';

// Exclusions live here and only here (the doc mirrors this block). Matched on the commit's NEW path.
export const EXCLUDE = {
  lockfiles: ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'Cargo.lock', 'poetry.lock',
    'Pipfile.lock', 'uv.lock', 'pdm.lock', 'composer.lock', 'Gemfile.lock', 'go.sum', 'Podfile.lock', 'flake.lock', 'mix.lock', 'pubspec.lock',
    'packages.lock.json', 'gradle.lockfile'],        // exact file names, any directory
  vendoredDirs: ['node_modules', 'vendor', 'third_party', 'dist', 'build'], // any path segment above the file name
  minified: /\.min\.[^/]*$/i,                         // *.min.* (file name only)
  data: /\.(tiktoken|csv|tsv|jsonl|ndjson|parquet)$/i, // data and vocab files: loaded, not written (file name only)
  attrs: ['linguist-generated', 'linguist-vendored'], // current .gitattributes: set / true excludes
  binary: 'numstat reports "-" for added/deleted',
};
const excludedBy = (p) => {
  const segs = p.split('/'), base = segs.pop();
  if (EXCLUDE.lockfiles.includes(base)) return 'lockfile';
  if (segs.some((s) => EXCLUDE.vendoredDirs.includes(s))) return 'vendored';
  if (EXCLUDE.minified.test(base)) return 'minified';
  if (EXCLUDE.data.test(base)) return 'data';
  return null;
};

const HOME = os.homedir(), ROOT = path.join(HOME, '.claude/projects');
const SLACK = 7 * 864e5;            // git --since can stop early on skewed commit dates: walk wider, filter exactly in JS
const TTL = 60e3;                   // how often a served window re-checks its repos in the background (cheap when nothing moved)
const hourOf = (ms) => Math.floor(ms / 36e5) * 36e5;
const sha = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);

// --- git runner: bounded concurrency, timeout, locks off (read-only) ---
let busy = 0; const waiting = [];
const slot = () => new Promise((r) => (busy < 3 ? (busy++, r()) : waiting.push(r)));
const free = () => { const n = waiting.shift(); if (n) n(); else busy--; };
async function git(dir, args, { input, timeout = 120e3, maxBytes = 512 << 20 } = {}) {
  await slot();
  try {
    return await new Promise((resolve, reject) => {
      const p = spawn('git', ['-C', dir, '-c', 'core.quotepath=off', ...args], { stdio: ['pipe', 'pipe', 'ignore'],
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } });
      const out = []; let n = 0, done = false;
      const end = (f, v) => { if (!done) { done = true; clearTimeout(t); f(v); } };
      const t = setTimeout(() => { p.kill('SIGKILL'); end(reject, new Error('timeout')); }, timeout);
      p.stdout.on('data', (c) => { n += c.length; if (n > maxBytes) { p.kill('SIGKILL'); end(reject, new Error('too large')); } else out.push(c); });
      p.on('error', () => end(reject, new Error('git unavailable')));
      p.on('close', (code) => (code === 0 ? end(resolve, Buffer.concat(out).toString('utf8')) : end(reject, new Error(`git exit ${code}`))));
      p.stdin.on('error', () => {}); p.stdin.end(input ?? '');
    });
  } finally { free(); }
}

// --- discovery: working directories the sessions actually used (transcripts carry "cwd" on their lines) ---
const fileCwds = new Map(); // file -> { mtime, size, cwds }
async function cwdsOf(file, st) {
  const hit = fileCwds.get(file);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.cwds;
  const cwds = new Set();
  try {
    const fh = await fs.promises.open(file, 'r');
    try {
      const W = 65536, b = Buffer.alloc(W);  // head and tail only: transcripts run to hundreds of MB
      for (const pos of new Set([0, Math.max(0, st.size - W)])) {
        const { bytesRead } = await fh.read(b, 0, W, pos);
        for (const m of b.toString('utf8', 0, bytesRead).matchAll(/"cwd":"((?:[^"\\]|\\.)*)"/g)) { try { cwds.add(JSON.parse(`"${m[1]}"`)); } catch {} }
      }
    } finally { await fh.close(); }
  } catch {}
  fileCwds.set(file, { mtime: st.mtimeMs, size: st.size, cwds });
  return cwds;
}
async function transcriptCwds(sinceMs) {
  const all = new Set();
  let dirs = []; try { dirs = (await fs.promises.readdir(ROOT, { withFileTypes: true })).filter((d) => d.isDirectory()); } catch { return all; }
  for (const d of dirs) {
    let files = []; try { files = await fs.promises.readdir(path.join(ROOT, d.name)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(ROOT, d.name, f);
      try { const st = await fs.promises.stat(file); if (st.mtimeMs >= sinceMs) for (const c of await cwdsOf(file, st)) all.add(c); } catch {}
    }
  }
  return all;
}

// cwd -> repo identity (git common dir, so a repo and its worktrees count once), cached 10 min
const cwdRepo = new Map();
async function repoOf(cwd) {
  const hit = cwdRepo.get(cwd);
  if (hit && Date.now() - hit.at < 6e5) return hit.v;
  let v = null;
  try {
    if (fs.existsSync(cwd)) {
      const [top, common] = (await git(cwd, ['rev-parse', '--show-toplevel', '--git-common-dir'], { timeout: 15e3 })).trim().split('\n');
      if (top && common) v = { top: fs.realpathSync(top), common: fs.realpathSync(path.resolve(cwd, common)) };
    }
  } catch {}
  cwdRepo.set(cwd, { at: Date.now(), v });
  return v;
}

// --- config: cfg.git = { enabled, allow, deny, authors, coAuthored } (see config.mjs) ---
const real = (p) => { const r = path.resolve(String(p).replace(/^~(?=$|\/)/, HOME)); try { return fs.realpathSync(r); } catch { return r; } };
const within = (p, root) => p === root || p.startsWith(root + path.sep);
function gitConfig(cfg) {
  const g = cfg?.git || {};
  return { enabled: g.enabled !== false, allow: (g.allow || []).map(real), deny: (g.deny || []).map(real),
    authors: (g.authors || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean), coAuthored: g.coAuthored === true };
}
function verdict(repo, gc) {  // 'ok' or the reason a repo is out
  const paths = [...repo.tops, path.basename(repo.common) === '.git' ? path.dirname(repo.common) : null].filter(Boolean);
  if (gc.deny.some((d) => paths.some((p) => within(p, d)))) return 'denied';
  if (gc.allow.length) return gc.allow.some((a) => paths.some((p) => within(p, a))) ? 'ok' : 'not-allowed';
  return paths.some((p) => within(p, HOME)) ? 'ok' : 'outside-home';
}

// --- per-repo collection ---
const repoCache = new Map(); // `${common}|${fingerprint}|${sinceMs}|${identities}` -> result (exact window start: the counts must cover the same span as the OTel numbers)
async function collectRepo(repo, sinceMs, untilMs, gc) {
  const top = [...repo.tops][0];
  let ids = new Set(gc.authors);
  try { const e = (await git(top, ['config', '--get', 'user.email'], { timeout: 15e3 })).trim().toLowerCase(); if (e) ids.add(e); } catch {}
  if (!ids.size) return { skipped: 'no-identity' };
  ids = [...ids].sort();
  const fp = sha((await git(top, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads'], { timeout: 30e3 }))
    + (await git(top, ['rev-parse', '--verify', '-q', 'HEAD'], { timeout: 15e3 }).catch(() => '')));
  const key = `${repo.common}|${fp}|${Math.floor(sinceMs / 6e4)}|${sha(ids.join(',') + gc.coAuthored + classifierSignature())}`;  // minute-exact start
  const hit = repoCache.get(key); if (hit) return hit;

  const args = ['log', '--branches', 'HEAD', '--no-merges', '--numstat', '-M', '-w', '-z', `--since=${new Date(sinceMs - SLACK).toISOString()}`,
    '--format=%x01%H%x1f%ct%x1f%ae%x1f%(trailers:key=Co-authored-by,valueonly,unfold,separator=%x1e)%x02'];
  if (!gc.coAuthored) args.push('--fixed-strings', '--regexp-ignore-case', ...ids.map((e) => `--author=${e}`)); // pushdown; exact match re-checked below
  const out = await git(top, args);

  let commits = 0, claudeCommits = 0; const files = new Map(); // new path -> { a, d, bin, ca, cd } (ca/cd: Claude co-authored commits only)
  for (const rec of out.split('\x01')) {
    const he = rec.indexOf('\x02'); if (he < 0) continue;
    const [, ct, ae, tr = ''] = rec.slice(0, he).split('\x1f'), ms = Number(ct) * 1000;
    if (!(ms >= sinceMs && ms <= untilMs)) continue;                 // anchored to COMMIT time, exact
    const mine = ids.includes((ae || '').trim().toLowerCase())
      || (gc.coAuthored && tr.split('\x1e').some((t) => { const m = /<([^>]+)>/.exec(t); return m && ids.includes(m[1].trim().toLowerCase()); }));
    if (!mine) continue;
    commits++;
    const claude = tr.split('\x1e').some(isClaudeTrailer); if (claude) claudeCommits++;
    const toks = rec.slice(he + 1).split('\0');
    for (let i = 0; i < toks.length; i++) {
      const m = /^\n?(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(toks[i]); if (!m) continue;
      let p = m[3]; if (p === '') { p = toks[i + 2] ?? ''; i += 2; }  // rename/copy under -z: "a\td\t" NUL old NUL new
      const f = files.get(p) ?? { a: 0, d: 0, bin: false, ca: 0, cd: 0 }; files.set(p, f);
      if (m[1] === '-' || m[2] === '-') f.bin = true; else { f.a += +m[1]; f.d += +m[2]; if (claude) { f.ca += +m[1]; f.cd += +m[2]; } }
    }
  }

  const ex = { binary: { files: 0, added: 0, removed: 0 }, lockfile: { files: 0, added: 0, removed: 0 }, vendored: { files: 0, added: 0, removed: 0 },
    minified: { files: 0, added: 0, removed: 0 }, data: { files: 0, added: 0, removed: 0 }, attr: { files: 0, added: 0, removed: 0 } };
  const live = [];
  for (const [p, f] of files) {
    const why = f.bin ? 'binary' : excludedBy(p);
    if (why) { const e = ex[why]; e.files++; e.added += f.a; e.removed += f.d; } else live.push([p, f]);
  }
  const marked = new Set();  // linguist-generated / linguist-vendored in the current .gitattributes
  if (live.length) {
    try {
      const ca = (await git(top, ['check-attr', '-z', '--stdin', ...EXCLUDE.attrs], { input: live.map(([p]) => p).join('\0') + '\0' })).split('\0');
      for (let i = 0; i + 2 < ca.length; i += 3) if (ca[i + 2] === 'set' || ca[i + 2] === 'true') marked.add(ca[i]);
    } catch {}
  }
  let added = 0, removed = 0, n = 0; const byClass = blankByClass(), claude = { commits: claudeCommits, added: 0, removed: 0 };
  for (const [p, f] of live) {
    if (marked.has(p)) { ex.attr.files++; ex.attr.added += f.a; ex.attr.removed += f.d; continue; }
    added += f.a; removed += f.d; n++; claude.added += f.ca; claude.removed += f.cd;
    const b = byClass[classOf(p)]; b.files++; b.added += f.a; b.removed += f.d;  // the path picks a class here and is dropped
  }
  const v = { commits, added, removed, files: n, byClass, claude, excluded: ex };
  if (repoCache.size > 300) repoCache.clear();
  repoCache.set(key, v);
  return v;
}

// --- one window, all repos ---
const blankByClass = () => Object.fromEntries(CLASSES.map((c) => [c, { files: 0, added: 0, removed: 0 }]));
const withNet = (b) => Object.fromEntries(Object.entries(b).map(([c, x]) => [c, { ...x, net: x.added - x.removed }]));
const zeroEx = () => ({ binary: 0, lockfile: 0, vendored: 0, minified: 0, data: 0, attr: 0 });
// A Co-authored-by trailer naming Claude (Claude Code writes "Claude <model> <noreply@anthropic.com>").
const isClaudeTrailer = (t) => /noreply@anthropic\.com/i.test(t) || /^\s*claude\b/i.test(t);
async function compute(gc, sinceMs, untilMs) {
  const repos = new Map(); let noRepo = 0;
  for (const cwd of await transcriptCwds(sinceMs)) {
    const r = await repoOf(cwd);
    if (!r) { noRepo++; continue; }
    (repos.get(r.common) ?? repos.set(r.common, { common: r.common, tops: new Set() }).get(r.common)).tops.add(r.top);
  }
  const skipped = { 'no-repo': noRepo, denied: 0, 'not-allowed': 0, 'outside-home': 0, 'no-identity': 0, error: 0 };
  const names = new Map(), rows = [];
  const t = { commits: 0, added: 0, removed: 0, files: 0, byClass: blankByClass(), claude: { commits: 0, added: 0, removed: 0 },
    excluded: { files: zeroEx(), added: zeroEx(), removed: zeroEx() } };
  for (const repo of repos.values()) {
    const why = verdict(repo, gc); if (why !== 'ok') { skipped[why]++; continue; }
    let v; try { v = await collectRepo(repo, sinceMs, untilMs, gc); } catch { skipped.error++; continue; }
    if (v.skipped) { skipped[v.skipped]++; continue; }
    t.commits += v.commits; t.added += v.added; t.removed += v.removed; t.files += v.files;
    for (const c of CLASSES) for (const f of ['files', 'added', 'removed']) t.byClass[c][f] += v.byClass[c][f];
    for (const f of ['commits', 'added', 'removed']) t.claude[f] += v.claude[f];
    for (const k of Object.keys(v.excluded)) for (const f of ['files', 'added', 'removed']) t.excluded[f][k] += v.excluded[k][f];
    let name = path.basename(path.basename(repo.common) === '.git' ? path.dirname(repo.common) : [...repo.tops][0]);
    const c = (names.get(name) || 0) + 1; names.set(name, c); if (c > 1) name += ` #${c}`;
    rows.push({ name, commits: v.commits, added: v.added, removed: v.removed, net: v.added - v.removed, files: v.files, byClass: withNet(v.byClass),
      claude: { ...v.claude, net: v.claude.added - v.claude.removed } });
  }
  rows.sort((a, b) => b.commits - a.commits);
  return { rules: RULES_VERSION, sinceMs, untilMs, computedAt: Date.now(), repoCount: rows.length, reposWithCommits: rows.filter((r) => r.commits).length,
    commits: t.commits, added: t.added, removed: t.removed, net: t.added - t.removed, files: t.files, byClass: withNet(t.byClass), claude: { ...t.claude, net: t.claude.added - t.claude.removed }, classifier: CLASSIFIER_VERSION, excluded: t.excluded, skipped, repos: rows,
    churn: null };  // churn (added then deleted inside the window) is parked: it needs per-line history, not numstat
}

// --- cached, non-blocking front door ---
// One entry per caller-named slot (e.g. "w7" = the 7d window), never per start time: the window slides, the slot does not, so a new hour
// cannot start from empty. A slot keeps serving its last value (refreshing: true) while the next count runs. Slots are capped.
const results = new Map(); // slot -> { value, at, p, err }
const MAX_SLOTS = 16, STALE_MAX = 2 * 36e5;
export function gitStatus(cfg, sinceMs, slot = String(hourOf(sinceMs))) {
  const gc = gitConfig(cfg);
  if (!gc.enabled) return { status: 'disabled', rules: RULES_VERSION };
  let e = results.get(slot);
  if (!e) { if (results.size >= MAX_SLOTS) results.delete(results.keys().next().value); results.set(slot, (e = { value: null, at: 0, p: null, err: null })); }
  if (!e.p && Date.now() - e.at > TTL) {
    e.p = compute(gc, sinceMs, Date.now()).then((v) => { e.value = v; e.err = null; }, (x) => { e.err = x.message === 'timeout' ? 'timeout' : 'git failed'; })
      .finally(() => { e.at = Date.now(); e.p = null; });
  }
  if (e.value && Date.now() - e.value.computedAt < STALE_MAX) return { status: 'ready', ...e.value, refreshing: !!e.p };
  return e.err ? { status: 'error', rules: RULES_VERSION, error: e.err } : { status: 'pending', rules: RULES_VERSION };
}

// What leaves the process: counts only. Per-repo rows (names, counts) go to localhost callers only; never paths, emails, hashes, messages.
export function gitView(s, { local = false } = {}) {
  if (!s || s.status !== 'ready') return s || { status: 'disabled' };
  const { repos, ...rest } = s;
  return local ? { ...rest, repos } : rest;
}

export const __test = { collectRepo, excludedBy, gitConfig };
