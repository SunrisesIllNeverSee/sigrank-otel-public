import assert from 'node:assert/strict';
import uri from 'fast-uri';
import Ajv from 'ajv';
import { buildEnvelope } from 'tteop-spec/builder';
import { validateEnvelope } from 'tteop-spec';
import { resolveCascade } from '../src/cascade.mjs';

assert.match(uri.parse('htt%70://example.com').error, /scheme/i);
assert.match(uri.parse('http://exa<mple.com').error, /host/i);
assert.equal(uri.normalize('./a:b'), './a:b');
assert.equal(uri.resolve('https://example.com/root/', 'a/../b'), 'https://example.com/root/b');
assert.equal(uri.serialize({ path: 'a:b' }, { reference: 'suffix' }), 'a%3Ab');

const ajv = new Ajv();
ajv.addSchema({ $id: 'https://example.com/schemas/count', type: 'integer', minimum: 0 });
const validate = ajv.compile({ type: 'object', properties: { input: { $ref: 'https://example.com/schemas/count' } }, required: ['input'] });
assert.equal(validate({ input: 100 }), true);
assert.equal(validate({ input: -1 }), false);

const pillars = { input: 1_251_211, output: 11_296_121, cache_write: 128_196_310, cache_read: 2_555_179_769 };
const envelope = buildEnvelope(pillars, { provider: 'test', model: 'test', tool: 'dependency-check' });
assert.equal(validateEnvelope(envelope).valid, true);
const { cascade, from } = await resolveCascade();
assert.equal(from, 'package');
assert.equal(cascade(pillars.input, pillars.output, pillars.cache_write, pillars.cache_read).yield, 18436.98);
console.log('URI security, Ajv references, TTEOP envelope and cascade loading passed');
