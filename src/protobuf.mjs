// Minimal OTLP protobuf decoder (only the fields flatten() reads). Output mirrors the OTLP JSON shape.
export function* fields(buf) {
  let i = 0;
  const varint = () => { let r = 0n, s = 0n, b; do { if (i >= buf.length) throw new Error('truncated varint'); b = buf[i++]; r |= BigInt(b & 127) << s; s += 7n; } while (b & 128); return r; };
  while (i < buf.length) {
    const tag = Number(varint()), no = tag >>> 3, wire = tag & 7;
    if (wire === 0) yield [no, wire, varint()];
    else if (wire === 1) { if (i + 8 > buf.length) throw new Error('truncated'); yield [no, wire, buf.subarray(i, i += 8)]; }
    else if (wire === 5) { if (i + 4 > buf.length) throw new Error('truncated'); yield [no, wire, buf.subarray(i, i += 4)]; }
    else if (wire === 2) { const n = Number(varint()); if (i + n > buf.length) throw new Error('truncated'); yield [no, wire, buf.subarray(i, i += n)]; }
    else throw new Error(`unsupported wire type ${wire}`);
  }
}
// h: {fieldNo: (value, o) => void}; o collects the object.
const msg = (buf, h) => { const o = {}; for (const [no, , v] of fields(buf)) h[no]?.(v, o); return o; };
const str = (b) => b.toString('utf8');
const u64 = (b) => b.readBigUInt64LE(0).toString();
const push = (k, f) => (v, o) => (o[k] ||= []).push(f(v));

const anyValue = (b) => {
  const o = {};
  for (const [no, , v] of fields(b)) {
    if (no === 1) o.stringValue = str(v);
    else if (no === 2) o.boolValue = v !== 0n;
    else if (no === 3) o.intValue = BigInt.asIntN(64, v).toString();
    else if (no === 4) o.doubleValue = v.readDoubleLE(0);
    else if (no === 5) o.arrayValue = { values: [...fields(v)].filter((f) => f[0] === 1).map((f) => anyValue(f[2])) };
    else if (no === 6) o.kvlistValue = { values: [...fields(v)].filter((f) => f[0] === 1).map((f) => kv(f[2])) };
  }
  return o;
};
const kv = (b) => msg(b, { 1: (v, o) => (o.key = str(v)), 2: (v, o) => (o.value = anyValue(v)) });
const attrs = push('attributes', kv);
const resource = (k) => (v, o) => (o[k] = msg(v, { 1: attrs }));

const numPoint = (b) => msg(b, { 7: attrs, 2: (v, o) => (o.startTimeUnixNano = u64(v)), 3: (v, o) => (o.timeUnixNano = u64(v)),
  4: (v, o) => (o.asDouble = v.readDoubleLE(0)), 6: (v, o) => (o.asInt = v.readBigInt64LE(0).toString()) });
const histPoint = (b) => msg(b, { 9: attrs, 2: (v, o) => (o.startTimeUnixNano = u64(v)), 3: (v, o) => (o.timeUnixNano = u64(v)),
  5: (v, o) => (o.sum = v.readDoubleLE(0)) });
const data = (pt) => (b) => msg(b, { 1: push('dataPoints', pt), 2: (v, o) => (o.aggregationTemporality = Number(v)) });
const metric = (b) => msg(b, { 1: (v, o) => (o.name = str(v)), 5: (v, o) => (o.gauge = data(numPoint)(v)),
  7: (v, o) => (o.sum = data(numPoint)(v)), 9: (v, o) => (o.histogram = data(histPoint)(v)) });
const logRecord = (b) => msg(b, { 1: (v, o) => (o.timeUnixNano = u64(v)), 5: (v, o) => (o.body = anyValue(v)), 6: attrs });
const event = (b) => msg(b, { 1: (v, o) => (o.timeUnixNano = u64(v)), 2: (v, o) => (o.name = str(v)), 3: attrs });
const span = (b) => msg(b, { 1: (v, o) => (o.traceId = v.toString('hex')), 2: (v, o) => (o.spanId = v.toString('hex')),
  4: (v, o) => (o.parentSpanId = v.toString('hex')), 5: (v, o) => (o.name = str(v)), 7: (v, o) => (o.startTimeUnixNano = u64(v)),
  8: (v, o) => (o.endTimeUnixNano = u64(v)), 9: attrs, 11: push('events', event) });

const level = (ck, ik, item) => (b) => msg(b, { 1: resource('resource'), 2: push(ck, (s) => msg(s, { 2: push(ik, item) })) });
const top = (rk, lvl) => (b) => msg(b, { 1: push(rk, lvl) });
const decoders = {
  logs: top('resourceLogs', level('scopeLogs', 'logRecords', logRecord)),
  metrics: top('resourceMetrics', level('scopeMetrics', 'metrics', metric)),
  traces: top('resourceSpans', level('scopeSpans', 'spans', span)),
};
export const decodeOtlp = (kind, buf) => decoders[kind](buf);
