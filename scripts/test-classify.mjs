// Table test for src/classify.mjs: node scripts/test-classify.mjs
import os from 'node:os';
import { classifyWhy } from '../src/classify.mjs';

const H = os.homedir();
const CASES = [
  // dotfiles: any leading-dot name whose extension is not in the table is config
  ['.env', 'config', 'dotfile'], ['.env.local', 'config', 'dotfile'], ['.env.production', 'config', 'dotfile'], ['.env.development', 'config', 'dotfile'], ['app/.gitignore', 'config', 'dotfile'], ['.npmrc', 'config', 'dotfile'],
  ['.env.example', 'infra', 'env:example'], ['.eslintrc.cjs', 'code', 'ext:cjs'], ['.eslintrc.json', 'config', 'ext:json'], ['foo.csv', 'other', 'unmatched'], ['LICENSE', 'docs', 'name:docs'],
  // role before extension
  [`${H}/.claude/CLAUDE.md`, 'infra', 'agent:file'], ['repo/.coord/micro/STATE.md', 'infra', 'agent:dir'], ['repo/scripts/deploy.mjs', 'infra', 'shell:dir'], ['repo/scripts/README.md', 'docs', 'ext:md'], ['repo/src/x.ts', 'code', 'ext:ts'], ['repo/vercel.json', 'infra', 'ops:deploy'],
  // a Claude Code worktree is judged from its own root, not from the .claude directory that holds it
  [`${H}/Developer/app/.claude/worktrees/a/src/x.ts`, 'code', 'ext:ts'], ['/Users/x/app/.claude/worktrees/a/db/m.sql', 'code', 'ext:sql'], ['/Users/x/app/.claude/worktrees/a/README.md', 'docs', 'ext:md'],
  ['/Users/x/app/.claude/worktrees/a/.claude/hooks/h.mjs', 'infra', 'agent:dir'], ['/Users/x/app/.claude/worktrees/a/supabase/migrations/1.sql', 'infra', 'ops:db'], ['/Users/x/app/.claude/settings.json', 'infra', 'agent:dir'],
];
let bad = 0;
for (const [f, cls, rule] of CASES) { const g = classifyWhy(f); if (g.cls !== cls || g.rule !== rule) { bad++; console.log(`FAIL ${f} -> ${g.cls}/${g.rule}, want ${cls}/${rule}`); } }
console.log(bad ? `${bad} failed` : `ok (${CASES.length} cases)`);
process.exit(bad ? 1 : 0);
