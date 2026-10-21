// Test for the streaming-start usage fix: node scripts/test-streaming-usage.mjs
// Unit checks of src/streaming-usage.mjs, then backfill.mjs over a throwaway transcript folder with the flag off and on.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isStreamingStart, newShape, addShape, estimateOutput, FIT } from '../src/streaming-usage.mjs';

let bad = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) { bad++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); } };
const yes = (name, v) => eq(name, !!v, true);

eq('null stop is streaming-start', isStreamingStart(null), true);
eq('undefined stop is streaming-start', isStreamingStart(undefined), true);
for (const s of ['tool_use', 'end_turn', 'stop_sequence', 'max_tokens']) eq(`${s} is final`, isStreamingStart(s), false);

const sh = newShape();
addShape(sh, [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text: 'hello' }, { type: 'tool_use', input: { a: 'bc' } }, null]);
eq('shape: blank thinking, text and tool_use input JSON', sh, { chars: 5 + JSON.stringify({ a: 'bc' }).length, blankThinking: 1 });
addShape(sh, [{ type: 'thinking', thinking: 'abcd' }]);
eq('shape: visible thinking text counts as chars, not as a blank block', sh.blankThinking, 1);
addShape(sh, 'not an array');
eq('shape: non-array content ignored', sh.blankThinking, 1);
eq('estimate of nothing is the base', estimateOutput(newShape()), FIT.base);
eq('estimate arithmetic', estimateOutput({ chars: 1000, blankThinking: 2 }), Math.round(FIT.base + FIT.perChar * 1000 + FIT.perThinkingBlock * 2));

// End to end over a fixture folder.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'streaming-usage-'));
const proj = path.join(tmp, 'projects', 'p'); fs.mkdirSync(proj, { recursive: true });
const rec = (id, req, stop, out, content, extra = {}) => JSON.stringify({ type: 'assistant', sessionId: 's1', timestamp: '2026-01-02T03:04:05.000Z', uuid: `${id}-${Math.random()}`, requestId: req,
  isSidechain: true, message: { id, model: 'claude-sonnet-5-5', stop_reason: stop, usage: { input_tokens: 2, output_tokens: out, cache_read_input_tokens: 10, cache_creation_input_tokens: 20 }, content }, ...extra });
const big = { file_path: '/x/a.md', content: 'z'.repeat(20000) };
fs.writeFileSync(path.join(proj, 's1.jsonl'), [
  rec('msg_stream', 'req_stream', null, 3, [{ type: 'thinking', thinking: '' }]),               // a Write streamed in two records, never finalized
  rec('msg_stream', 'req_stream', null, 3, [{ type: 'tool_use', id: 't1', name: 'Write', input: big }]),
  rec('msg_final', 'req_final', null, 20, [{ type: 'text', text: 'x'.repeat(100) }]),            // finished: the last record carries the final usage
  rec('msg_final', 'req_final', 'end_turn', 480, [{ type: 'text', text: 'y'.repeat(100) }]),
  rec('msg_live', 'req_live', null, 3, [{ type: 'tool_use', id: 't2', name: 'Write', input: big }]),  // OTel already has this request: backfill skips it
].join('\n') + '\n');
const live = path.join(tmp, 'otel.jsonl');
fs.writeFileSync(live, JSON.stringify({ kind: 'logs', name: 'claude_code.api_request', time: '1893456000000000000', attrs: { request_id: 'req_live', 'session.id': 'live' } }) + '\n');

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/backfill.mjs');
function run(flag) {
  const out = path.join(tmp, `out-${flag}.jsonl`);
  const env = { ...process.env, SIGRANK_OTEL_BACKFILL_ROOTS: path.join(tmp, 'projects'), SIGRANK_OTEL_BACKFILL_FIX_STREAMING_USAGE: flag, SIGRANK_OTEL_DATA_DIR: tmp };
  const log = execFileSync('node', [script, live, out], { env, encoding: 'utf8' });
  const rows = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.name === 'claude_code.api_request');
  return { log, by: Object.fromEntries(rows.map((r) => [r.attrs.request_id, r.attrs])), n: rows.length };
}
const off = run('0'), on = run('1');
eq('off: live-covered request skipped', [off.n, on.n], [2, 2]);
eq('off: streaming-start value kept as logged', off.by.req_stream.output_tokens, 3);
yes('off: no estimated flag', off.by.req_stream.estimated === undefined);
yes('off: detection still reported', /streaming-start usage \(stop_reason null\): 1 messages · recorded output 3 ·.*fixStreamingUsage off/.test(off.log));
yes('on: streamed Write estimated', on.by.req_stream.output_tokens > 5000 && on.by.req_stream.output_tokens < 12000);
eq('on: estimate follows the fit', on.by.req_stream.output_tokens, estimateOutput({ chars: JSON.stringify(big).length, blankThinking: 1 }));
eq('on: row says estimated and keeps the logged value', [on.by.req_stream.estimated, on.by.req_stream.output_tokens_logged], [true, 3]);
eq('on: finished message untouched', [on.by.req_final.output_tokens, on.by.req_final.estimated], [480, undefined]);
eq('on: input and cache fields untouched', [on.by.req_stream.input_tokens, on.by.req_stream.cache_read_tokens, on.by.req_stream.cache_creation_tokens], [2, 10, 20]);
yes('on: log says ON', /fixStreamingUsage ON/.test(on.log));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(bad ? `${bad} failed` : 'streaming-usage: all passed');
process.exit(bad ? 1 : 0);
