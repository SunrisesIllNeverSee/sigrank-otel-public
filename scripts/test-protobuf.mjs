#!/usr/bin/env node
// Hand-encodes OTLP protobuf (logs, metrics, traces), posts them (plain + gzip) to a running receiver, checks rows landed.
// Usage: node scripts/test-protobuf.mjs [port=4319] [otel.jsonl path of that receiver]
import zlib from 'node:zlib';
import fs from 'node:fs';

const port = process.argv[2] || 4319, out = process.argv[3];
const vi = (n) => { n = BigInt(n); const b = []; do { let x = Number(n & 127n); n >>= 7n; if (n) x |= 128; b.push(x); } while (n); return Buffer.from(b); };
const len = (no, buf) => Buffer.concat([vi(no << 3 | 2), vi(buf.length), buf]);
const s = (no, t) => len(no, Buffer.from(t));
const v = (no, n) => Buffer.concat([vi(no << 3), vi(n)]);
const f64 = (no, n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return Buffer.concat([vi(no << 3 | 1), b]); };
const dbl = (no, n) => { const b = Buffer.alloc(8); b.writeDoubleLE(n); return Buffer.concat([vi(no << 3 | 1), b]); };
const sf64 = (no, n) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return Buffer.concat([vi(no << 3 | 1), b]); };
// KeyValue as a repeated field at `no` inside its parent
const kvf = (no, k, valueMsg) => len(no, Buffer.concat([s(1, k), len(2, valueMsg)]));
const res = len(1, kvf(1, 'service.name', s(1, 'claude-code')));
const T = '1790000000000000000'; // 2026-09, ns
const NOW = BigInt(Date.now()) * 1000000n;
const mark = `pbtest-${Date.now()}`;

const logs = len(1, Buffer.concat([res, len(2, len(2, Buffer.concat([
  f64(1, NOW), len(5, s(1, 'claude_code.api_request')),
  kvf(6, 'model', s(1, mark)), kvf(6, 'input_tokens', v(3, 123)), kvf(6, 'cost_usd', dbl(4, 0.5)), kvf(6, 'flag', v(2, 1)),
  kvf(6, 'session.id', s(1, 'pb-session')), kvf(6, 'user.email', s(1, 'secret@example.com')),
])))]));
const metrics = len(1, Buffer.concat([res, len(2, len(2, Buffer.concat([
  s(1, 'claude_code.token.usage'),
  len(7, Buffer.concat([len(1, Buffer.concat([kvf(7, 'type', s(1, 'output')), kvf(7, 'model', s(1, mark)), f64(2, NOW), f64(3, NOW), sf64(6, 777)])), v(2, 1)])),
])))]));
const traces = len(1, Buffer.concat([res, len(2, len(2, Buffer.concat([
  len(1, Buffer.from('0102030405060708090a0b0c0d0e0f10', 'hex')), len(2, Buffer.from('1112131415161718', 'hex')),
  s(5, 'claude_code.interaction'), f64(7, NOW), f64(8, NOW + 5000000n), kvf(9, 'model', s(1, mark)),
  len(11, Buffer.concat([f64(1, NOW), s(2, 'evt'), kvf(3, 'k', s(1, 'v'))])),
])))]));

let fail = 0;
const check = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fail++; };
async function post(path, body, gz) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body: gz ? zlib.gzipSync(body) : body,
    headers: { 'content-type': 'application/x-protobuf', ...(gz ? { 'content-encoding': 'gzip' } : {}) } });
  return r;
}
for (const gz of [false, true]) for (const [p, b] of [['/v1/logs', logs], ['/v1/metrics', metrics], ['/v1/traces', traces]]) {
  const r = await post(p, b, gz); check(r.status === 200, `${p} ${gz ? 'gzip ' : ''}-> ${r.status} (${r.headers.get('content-type')})`);
}
check((await post('/v1/logs', Buffer.from([0x0a, 0xff, 0xff, 0x7f]), false)).status === 400, 'truncated protobuf -> 400');
const jr = await fetch(`http://127.0.0.1:${port}/v1/logs`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
  body: zlib.gzipSync(JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: [{ timeUnixNano: String(NOW), body: { stringValue: 'claude_code.api_request' }, attributes: [{ key: 'model', value: { stringValue: mark } }] }] }] }] })) });
check(jr.status === 200, `gzip JSON -> ${jr.status}`);
if (out) {
  const rows = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => JSON.stringify(r).includes(mark));
  const by = (k) => rows.filter((r) => r.kind === k);
  check(by('logs').length === 3, `logs rows: ${by('logs').length} (2 protobuf + 1 gzip json)`);
  const l = by('logs')[0];
  check(l.name === 'claude_code.api_request' && l.attrs.input_tokens === 123 && l.attrs.cost_usd === 0.5 && l.attrs.flag === true && l.attrs['session.id'] === 'pb-session', 'log attrs decoded');
  check(!JSON.stringify(rows).includes('secret@example.com'), 'user.* attrs scrubbed');
  check(l.res['service.name'] === 'claude-code' && String(l.time) === String(NOW), 'resource + timestamp decoded');
  const m = by('metrics')[0]; check(by('metrics').length === 2 && m.name === 'claude_code.token.usage' && m.value === 777 && m.attrs.type === 'output' && m.temporality === 1, 'metric decoded');
  const t = by('traces')[0]; check(by('traces').length === 2 && t.trace === '0102030405060708090a0b0c0d0e0f10' && t.name === 'claude_code.interaction' && t.events[0].name === 'evt', 'trace decoded');
}
console.log(fail ? `${fail} FAILED` : 'all passed'); process.exit(fail ? 1 : 0);
