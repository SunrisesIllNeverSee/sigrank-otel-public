// Settings: ~/.config/sigrank-otel/config.json, then env overrides (SIGRANK_OTEL_*).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const configPath = () => path.join(os.homedir(), '.config/sigrank-otel/config.json');

export function loadConfig() {
  const file = configPath();
  let user = {};
  try { user = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const env = process.env;
  const dataDir = path.resolve(env.SIGRANK_OTEL_DATA_DIR || user.dataDir || path.join(os.homedir(), '.local/share/sigrank-otel'));
  const days = Number(env.SIGRANK_OTEL_RETENTION_DAYS ?? user.retentionDays);
  return {
    file, dataDir,
    port: Number(env.SIGRANK_OTEL_PORT || user.port || 4318),
    out: path.join(dataDir, 'otel.jsonl'),
    codename: env.SIGRANK_OTEL_CODENAME || user.codename || null,
    cascadePath: env.SIGRANK_OTEL_CASCADE_PATH || user.cascadePath || null,
    retentionDays: days > 0 ? days : null,
    allowSubmit: env.SIGRANK_OTEL_ALLOW_SUBMIT === '1' || user.allowSubmit === true,
    mcpPath: env.SIGRANK_OTEL_MCP_PATH || user.mcpPath || `${os.homedir()}/Developer/active/SigRank-repos/_02_sigrank-mcp`,
  };
}
