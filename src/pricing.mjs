// Estimated cost for transcript (logged) rows, which carry tokens but no cost. Method: docs/cost-estimate.md.
// Rates are $ per million tokens: [input, output, cache write, cache read]. Cache writes at the 5-minute rate (1.25x input),
// which is what Claude Code's own reported costs match. Models that appear in live OTel use the rates their reported cost implies
// (fitted per request; Sonnet 5.5 cache reads bill at $0.10 there, against $0.20 published). The rest use published list prices.
export const PRICING_VERSION = 'cost-est/1';

export const RATES = {
  'claude-fable-5-1':  { r: [10, 50, 12.5, 0.25], from: 'reported' },  // matches reported cost exactly
  'claude-opus-5-5':   { r: [4, 20, 5, 0.2], from: 'reported' },       // within 1.3% of reported cost
  'claude-sonnet-5-5': { r: [2, 10, 2.5, 0.1], from: 'reported' },     // reported cost reproduces only with $0.10 cache reads
  'claude-haiku-5-5':  { r: [0.1, 0.5, 0.125, 0.01], long: [0.5, 2.5, 0.625, 0.05], from: 'list' },  // long = prompts over 100K
  'claude-fable-5':    { r: [10, 50, 12.5, 1], from: 'list' },
  'claude-opus-4-8':   { r: [5, 25, 6.25, 0.5], from: 'list' },
  'claude-opus-4-7':   { r: [5, 25, 6.25, 0.5], from: 'list' },
  'claude-sonnet-4-6': { r: [3, 15, 3.75, 0.3], from: 'list' },
  'claude-haiku-4-5':  { r: [1, 5, 1.25, 0.1], from: 'list' },
};
const LONG = 100e3;

// Exact id first, then the longest known id the model starts with (dated ids like claude-haiku-4-5-20251001).
const rateOf = (model = '') => RATES[model] ?? RATES[Object.keys(RATES).filter((k) => model.startsWith(k)).sort((a, b) => b.length - a.length)[0]];

// null = no price known (the tokens stay unpriced); 0 = a local model, which has no API cost.
export function estimateCost(model, input, output, cacheWrite, cacheRead) {
  if (model && !model.startsWith('claude-')) return 0;
  const p = rateOf(model); if (!p) return null;
  const r = p.long && input + cacheWrite + cacheRead > LONG ? p.long : p.r;
  return (input * r[0] + output * r[1] + cacheWrite * r[2] + cacheRead * r[3]) / 1e6;
}

// Estimated $ for one api_request row: only transcript rows without a reported cost; unpriced models count 0 here.
export const rowCostEst = (a) => (a.backfill && !+a.cost_usd
  ? estimateCost(a.model, +a.input_tokens || 0, +a.output_tokens || 0, +a.cache_creation_tokens || 0, +a.cache_read_tokens || 0) ?? 0 : 0);
