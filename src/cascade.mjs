// Finds token-cascade: own dependency first, then configured path, then the sigrank-mcp checkout.
import os from 'node:os';
import { loadConfig } from './config.mjs';

export async function resolveCascade() {
  const tries = [['package', 'token-cascade'], ['config', loadConfig().cascadePath], ['env', process.env.TOKEN_CASCADE],
    ['sigrank-mcp', `${os.homedir()}/Developer/active/SigRank-repos/_02_sigrank-mcp/node_modules/token-cascade/dist/index.js`]];
  for (const [from, spec] of tries) {
    if (!spec) continue;
    try { const m = await import(spec); if (m.cascade) return { cascade: m.cascade, from }; } catch {}
  }
  throw new Error('token-cascade not found. Run "npm install" in the sigrank-otel folder, or set cascadePath in ~/.config/sigrank-otel/config.json');
}
