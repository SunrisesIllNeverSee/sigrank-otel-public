#!/usr/bin/env node
// Score captured Claude Code telemetry: raw pillars + C:I:O with logged input vs typed-prompt input.
// Usage: node report.mjs [in=../data/otel.jsonl]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.resolve(process.argv[2] || path.join(here, '../data/otel.jsonl'));
const rows = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

// claude_code.token.usage is a delta counter by default; sum datapoints per model/type.
const tok = {};
for (const r of rows) if (r.kind === 'metrics' && r.name === 'claude_code.token.usage') {
  const m = r.attrs.model || 'unknown';
  tok[m] ??= { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  tok[m][r.attrs.type] = (tok[m][r.attrs.type] || 0) + (r.value || 0);
}

// Typed input: user_prompt_length (chars) on interaction spans, per session.
const prompts = rows.filter((r) => r.kind === 'traces' && r.attrs.user_prompt_length !== undefined);
const chars = prompts.reduce((s, r) => s + Number(r.attrs.user_prompt_length), 0);
const typedTokens = Math.max(0, Math.round(0.454 * chars - 188 * prompts.length)) || Math.round(chars / 3.6);

const fmt = (n) => Math.round(n).toLocaleString('en-US');
const total = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
console.log('RAW (claude_code.token.usage)');
console.log('model'.padEnd(24), 'input'.padStart(10), 'output'.padStart(10), 'cache read'.padStart(14), 'cache write'.padStart(13));
for (const [m, t] of Object.entries(tok)) {
  for (const k in total) total[k] += t[k] || 0;
  console.log(m.padEnd(24), fmt(t.input).padStart(10), fmt(t.output).padStart(10), fmt(t.cacheRead).padStart(14), fmt(t.cacheCreation).padStart(13));
}
console.log('TOTAL'.padEnd(24), fmt(total.input).padStart(10), fmt(total.output).padStart(10), fmt(total.cacheRead).padStart(14), fmt(total.cacheCreation).padStart(13));
console.log(`\ntyped prompts: ${prompts.length}  chars: ${fmt(chars)}  ≈ tokens: ${fmt(typedTokens)}`);

const metrics = (label, I) => {
  if (!I) return console.log(label.padEnd(26), '—');
  const { output: O, cacheRead: CR } = total;
  console.log(label.padEnd(26), `${(CR / I).toFixed(1)}:1:${(O / I).toFixed(3)}`.padStart(20),
    `O/I ${(O / I).toFixed(3)}`.padStart(12), `CR/I ${(CR / I).toFixed(1)}`.padStart(14), `Υ ${fmt(CR * O / I / I)}`.padStart(14));
};
console.log('\nMETRICS (C:I:O, O/I, CR/I, Υ = CR·O/I²)');
metrics('input as logged', total.input);
metrics('input = typed prompts', typedTokens);

const names = {};
for (const r of rows) names[`${r.kind}:${r.name}`] = (names[`${r.kind}:${r.name}`] || 0) + 1;
console.log('\nsignals captured:', names);
