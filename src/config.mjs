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
    // git-local collector (src/git.mjs): { enabled, allow: [paths], deny: [paths], authors: [emails], coAuthored }. SIGRANK_OTEL_GIT=0 turns it off.
    git: { ...(user.git && typeof user.git === 'object' ? user.git : {}), ...(env.SIGRANK_OTEL_GIT === '0' ? { enabled: false } : {}) },
    // role-based classifier overrides (src/classify.mjs): { infra: [glob], code: [glob], docs: [glob], config: [glob], other: [glob] }
    classify: user.classify && typeof user.classify === 'object' ? user.classify : {},
    // backfill (src/backfill.mjs): fixStreamingUsage (default off) estimates output_tokens for messages whose transcript usage is streaming-start
    // (docs/backfill-output-undercount.md); roots lists the transcript folders to read (default ~/.claude/projects). Env: SIGRANK_OTEL_BACKFILL_FIX_STREAMING_USAGE=1, SIGRANK_OTEL_BACKFILL_ROOTS=a:b
    backfill: {
      fixStreamingUsage: env.SIGRANK_OTEL_BACKFILL_FIX_STREAMING_USAGE === '1' || (env.SIGRANK_OTEL_BACKFILL_FIX_STREAMING_USAGE == null && user.backfill?.fixStreamingUsage === true),
      roots: (env.SIGRANK_OTEL_BACKFILL_ROOTS ? env.SIGRANK_OTEL_BACKFILL_ROOTS.split(':') : Array.isArray(user.backfill?.roots) ? user.backfill.roots : []).filter(Boolean),
    },
    mcpPath: env.SIGRANK_OTEL_MCP_PATH || user.mcpPath || `${os.homedir()}/Developer/active/SigRank-repos/_02_sigrank-mcp`,
  };
}
