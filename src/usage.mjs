// Reproduces Claude Code's /usage panel: per-model In / Out / Cache read / Cache write,
// summed over every assistant line in ~/.claude/projects transcripts, excluding
// workflow-agent transcripts (projects/**/subagents/workflows/), same as the panel.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.join(os.homedir(), '.claude', 'projects');
const SKIP = `${path.sep}subagents${path.sep}workflows${path.sep}`;
const TTL = 60_000;
let memo = null;

function* files(dir) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (e.name.endsWith('.jsonl') && !p.includes(SKIP)) yield p;
  }
}

function scan() {
  const lines = [];
  for (const f of files(ROOT)) {
    let txt;
    try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const l of txt.split('\n')) {
      if (!l.includes('"usage"')) continue;
      let o; try { o = JSON.parse(l); } catch { continue; }
      const m = o.message, u = m?.usage;
      if (o.type !== 'assistant' || !u || !m.model || m.model === '<synthetic>') continue;
      lines.push({ t: Date.parse(o.timestamp) || 0, model: m.model, i: u.input_tokens || 0, o: u.output_tokens || 0,
        cr: u.cache_read_input_tokens || 0, cw: u.cache_creation_input_tokens || 0 });
    }
  }
  return lines;
}

export function usage(days = 0) {
  if (!memo || Date.now() - memo.at > TTL) memo = { at: Date.now(), lines: scan() };
  const since = days ? Date.now() - days * 86_400_000 : 0;
  const by = {};
  for (const r of memo.lines) {
    if (r.t < since) continue;
    const m = (by[r.model] ||= { model: r.model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    m.input += r.i; m.output += r.o; m.cacheRead += r.cr; m.cacheWrite += r.cw;
  }
  const models = Object.values(by);
  const tot = models.reduce((s, m) => s + m.input + m.output + m.cacheRead + m.cacheWrite, 0) || 1;
  for (const m of models) m.share = (m.input + m.output + m.cacheRead + m.cacheWrite) / tot;
  models.sort((a, b) => b.share - a.share);
  // Token counts come straight from local transcripts (logged); the share column is computed from them.
  return { source: 'claude-transcripts', grade: 'logged', shareGrade: 'computed', pipeline: 'computed · logs', window: days ? `${days}d` : 'all', models };
}
