#!/usr/bin/env node
// Backfill history from Claude Code transcripts (~/.claude/projects/**/*.jsonl) into the receiver's row format.
// Emits api_request, user_prompt and tool_result rows for everything BEFORE live telemetry began, so nothing double counts.
// Usage: node backfill.mjs [live=../data/otel.jsonl] [out=../data/backfill.jsonl]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig();
const live = path.resolve(process.argv[2] || cfg.out);
const out = path.resolve(process.argv[3] || path.join(cfg.dataDir, 'backfill.jsonl'));
const root = path.join(os.homedir(), '.claude/projects');

// Gap-fill against the live stream instead of a hard time cutoff:
// - API requests are skipped only if OTel already has that request_id (sessions started before telemetry
//   was enabled, or batches lost during receiver restarts, never reach OTel).
// - Prompts/tool calls come from transcripts before the first live event, or from sessions OTel never saw.
let cutoff = Infinity; const liveReq = new Set(), liveSess = new Set();
for (const l of fs.readFileSync(live, 'utf8').split('\n')) {
  if (!l) continue;
  try {
    const r = JSON.parse(l); const ms = Number(BigInt(r.time || r.end || 0) / 1000000n); if (ms) cutoff = Math.min(cutoff, ms);
    if (r.attrs?.request_id) liveReq.add(r.attrs.request_id);
    if (r.attrs?.['session.id']) liveSess.add(r.attrs['session.id']);
  } catch {}
}

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p); else if (e.name.endsWith('.jsonl')) yield p;
  }
}
// Typed user text: skip meta, tool results, slash-command and harness wrappers (same rules as words.py).
function typed(rec) {
  if (rec.isMeta || rec.isCompactSummary) return null;
  const c = rec.message?.content;
  let t;
  if (typeof c === 'string') t = c;
  else if (Array.isArray(c)) {
    if (c.some((b) => b?.type === 'tool_result')) return null;
    t = c.filter((b) => b?.type === 'text').map((b) => b.text || '').join(' ');
  } else return null;
  const s = t.trimStart();
  if (!t.trim() || ['<command-', '<local-command', '<task-notification', '<system-reminder', 'Caveat:'].some((p) => s.startsWith(p))) return null;
  return t;
}
const nano = (ms) => (BigInt(Math.round(ms)) * 1000000n).toString();

const rows = []; let files = 0, skippedTests = 0;
// Resumed/forked sessions copy earlier records into new files: dedupe globally.
const seenReq = new Set(), seenPrompt = new Set(), seenTool = new Set();
for (const f of walk(root)) {
  files++;
  const last = new Map(); const prompts = []; const toolUses = new Map(); let sid = null, test = false;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    sid ||= r.sessionId;
    if (r.entrypoint === 'sdk-cli') test = true;
    const ms = Date.parse(r.timestamp || '');
    if (!ms) continue;
    const early = ms < cutoff || !liveSess.has(r.sessionId);
    if (r.type === 'user' && !r.isSidechain && early) {
      const t = typed(r);
      if (t && !seenPrompt.has(r.uuid)) { seenPrompt.add(r.uuid); prompts.push({ ms, chars: t.length }); }
    }
    if (r.type === 'assistant' && r.message?.usage && r.message?.id && !liveReq.has(r.requestId)) {
      last.set(r.message.id, { r, ms });
      if (early) for (const b of r.message.content || []) if (b?.type === 'tool_use') toolUses.set(b.id, { ms, name: b.name });
    }
  }
  if (test) { skippedTests++; continue; }  // investigation `claude -p` runs, not your work
  const base = (ms) => ({ 'session.id': sid || path.basename(f, '.jsonl'), 'event.timestamp': new Date(ms).toISOString(), backfill: true });
  for (const [id, { r, ms }] of last) {
    const u = r.message.usage, m = r.message.model;
    if (!m || m === '<synthetic>' || seenReq.has(id)) continue;
    seenReq.add(id);
    rows.push({ kind: 'logs', name: 'claude_code.api_request', time: nano(ms), attrs: { ...base(ms), model: m,
      input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0, cache_read_tokens: u.cache_read_input_tokens || 0,
      cache_creation_tokens: u.cache_creation_input_tokens || 0, cost_usd: r.costUSD || 0, request_id: r.requestId,
      query_source: r.isSidechain ? 'agent:backfill' : 'repl_main_thread' } });
  }
  for (const p of prompts) rows.push({ kind: 'logs', name: 'claude_code.user_prompt', time: nano(p.ms), attrs: { ...base(p.ms), prompt_length: p.chars } });
  for (const [id, t] of toolUses) if (!seenTool.has(id) && seenTool.add(id)) rows.push({ kind: 'logs', name: 'claude_code.tool_result', time: nano(t.ms), attrs: { ...base(t.ms), tool_name: t.name, success: 'true' } });
}
rows.sort((a, b) => (BigInt(a.time) < BigInt(b.time) ? -1 : 1));
fs.writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const c = (n) => rows.filter((r) => r.name === n).length;
console.log(`transcripts ${files} (skipped ${skippedTests} test runs) · live from ${new Date(cutoff).toISOString()} · gap-fill vs ${liveReq.size} live requests`);
console.log(`wrote ${rows.length} rows → ${out}: ${c('claude_code.api_request')} requests, ${c('claude_code.user_prompt')} prompts, ${c('claude_code.tool_result')} tool calls`);
