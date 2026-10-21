// One classifier for tier 2 (src/artifact.mjs, derived) and git-local (src/git.mjs): classify(path) -> code | infra | docs | config | other.
// Path ROLE rules run first, extension second. Rules as built: docs/classification.md (that doc mirrors the tables below).
// A label, never a weight: nothing here ranks one class above another. Paths are used in memory to pick a class and are never kept.
import os from 'node:os';

export const CLASSIFIER_VERSION = 'classify/2';
export const CLASSES = ['code', 'infra', 'docs', 'config', 'other'];

// --- extension table (the pre-infra mapping, minus what moved to infra: shell scripts, plist, tf/tfvars/hcl, Dockerfile/Makefile/Procfile/Brewfile) ---
export const CLASS_EXT = {
  code: 'js mjs cjs jsx ts tsx mts cts py pyi rb go rs java kt kts swift c h cc cpp cxx hpp hh cs php ps1 sql css scss sass less html htm vue svelte astro lua r pl scala dart ex exs erl hs clj m mm graphql gql proto',
  infra: 'sh bash zsh fish command plist tf tfvars hcl service timer socket',
  docs: 'md mdx markdown txt rst adoc asciidoc tex org',
  config: 'json jsonc json5 yaml yml toml ini cfg conf env xml properties editorconfig',
};
export const CLASS_NAME = {  // extension-less files, by exact file name
  infra: ['Makefile', 'Procfile', 'Brewfile', 'Caddyfile', 'Jenkinsfile', 'Justfile', 'justfile', 'Vagrantfile'],
  config: ['Gemfile'],
  docs: ['README', 'LICENSE', 'CHANGELOG', 'NOTICE', 'AUTHORS', 'CONTRIBUTING'],
};
const EXT = new Map(); for (const [c, s] of Object.entries(CLASS_EXT)) for (const e of s.split(' ')) EXT.set(e, c);
const DOC_EXT = new Set(CLASS_EXT.docs.split(' '));

// --- role rules: [id, test]. `strong` roles take every file under them, markdown included. `weak` roles leave docs-extension files as docs. ---
const set = (s) => new Set(s.split(' '));
const AGENT_DIRS = set('.claude .coord .repo .proofpress .devin .claude-plugin .codex-plugin .cursor .codex .gemini .agents .windsurf');
const AGENT_FILES = set('CLAUDE.md CLAUDE.local.md AGENTS.md GEMINI.md SKILL.md .mcp.json .claude.json claude_desktop_config.json .cursorrules .windsurfrules copilot-instructions.md');
const SHELL_DOTFILES = set('.zshrc .zprofile .zshenv .zlogin .bashrc .bash_profile .profile .gitconfig .tmux.conf .vimrc .inputrc');
const ENV_EXAMPLE = /^\.env\.(example|sample|template|dist)$/i;
const OPS_FILES = [
  [/^dockerfile(\.[^/]*)?$|\.dockerfile$|^\.dockerignore$|^docker-compose[^/]*\.ya?ml$|^compose\.ya?ml$/i, 'ops:container'],
  [/^(vercel\.json|wrangler\.(toml|jsonc?)|netlify\.toml|fly\.toml|render\.ya?ml|railway\.(json|toml)|nixpacks\.toml|serverless\.ya?ml|firebase\.json|\.vercelignore)$/i, 'ops:deploy'],
  [/^(\.gitlab-ci\.ya?ml|\.travis\.ya?ml|azure-pipelines\.ya?ml|cloudbuild\.ya?ml|buildspec\.ya?ml|bitbucket-pipelines\.ya?ml|dependabot\.ya?ml|renovate\.json5?|\.pre-commit-config\.ya?ml|lefthook\.ya?ml|taskfile\.ya?ml)$/i, 'ops:ci'],
  [/^(nginx\.conf|caddyfile|haproxy\.cfg|cloudflared[^/]*\.ya?ml)$/i, 'ops:proxy'],
  [/\.(plist|service|timer|socket)$/i, 'ops:service'],
  [/\.tf(vars)?$|\.hcl$/i, 'ops:terraform'],
];
const OPS_DIRS = set('.circleci .husky .devcontainer .cloudflared cloudflared nginx caddy k8s kubernetes helm terraform ansible docker infra infrastructure deploy deployment devops ops launchd launchagents launchdaemons systemd');
const SHELL_DIRS = set('scripts bin cron');
const ENV_DIRS = set('.config');

// Returns the matched role rule id, or null. `rel` is the path with the home folder stripped; `strong` is true for agent scaffolding.
function role(segs, base, rel) {
  const dirs = segs.slice(0, -1);
  if (AGENT_FILES.has(base)) return ['agent:file', true];
  for (const d of dirs) if (AGENT_DIRS.has(d)) return ['agent:dir', true];
  if (ENV_EXAMPLE.test(base)) return ['env:example', true];
  if (SHELL_DOTFILES.has(base)) return ['shell:dotfile', true];
  for (let i = 0; i < dirs.length; i++) {  // GitHub Actions, composite actions and Dependabot config; other .github files fall through to their extension
    if (dirs[i] === '.github' && (dirs[i + 1] === 'workflows' || dirs[i + 1] === 'actions')) return ['ops:ci-dir', false];
  }
  for (const [re, id] of OPS_FILES) if (re.test(base)) return [id, true];
  if (/(^|\/)supabase\/(migrations\/|config\.toml$|seed\.sql$)/.test(rel)) return ['ops:db', false];
  if (base.endsWith('.sql') && dirs.some((d) => d === 'migrations' || d === 'migrate' || d === 'migration')) return ['ops:db', false];
  if (/^Library\/(LaunchAgents|LaunchDaemons)\//.test(rel)) return ['ops:service', true];
  for (const d of dirs) if (OPS_DIRS.has(d)) return ['ops:dir', false];
  for (const d of dirs) if (ENV_DIRS.has(d)) return ['env:config-dir', false];
  for (const d of dirs) if (SHELL_DIRS.has(d)) return ['shell:dir', false];
  return null;
}
const ext = (base) => { const i = base.lastIndexOf('.'); return i > 0 ? base.slice(i + 1).toLowerCase() : ''; };

// --- operator overrides: config.classify = { infra: [glob], code: [glob], docs: [...], config: [...], other: [...] } ---
// Glob: `*` any run inside one path part, `**` any depth, `?` one character. A pattern with no `/` matches a file name anywhere. With a `/` it matches
// at any directory boundary; start it with `/` or `~/` to anchor it at the repo (git) or home folder (transcripts). A trailing `/` means everything under it.
function globRe(g) {
  let s = String(g).trim(), anchored = false;
  if (s.startsWith('~/')) { s = s.slice(2); anchored = true; } else if (s.startsWith('/')) { s = s.slice(1); anchored = true; }
  if (s.endsWith('/')) s += '**';
  if (!s.includes('/')) s = '**/' + s;
  const body = s.split(/(\*\*\/|\*\*|\*|\?)/).map((t) => (t === '**/' ? '(?:.*/)?' : t === '**' ? '.*' : t === '*' ? '[^/]*' : t === '?' ? '[^/]' : t.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('');
  return new RegExp(`${anchored ? '^' : '(?:^|/)'}${body}$`);
}
let overrides = [], overrideSig = '';
export function configureClassifier(c) {
  overrides = []; const sig = [];
  if (c && typeof c === 'object') for (const cls of CLASSES) {
    const list = Array.isArray(c[cls]) ? c[cls].filter((g) => typeof g === 'string' && g.trim()) : [];
    for (const g of list) { try { overrides.push([globRe(g), cls]); sig.push(`${cls}:${g}`); } catch {} }
  }
  overrideSig = sig.join('|');
}
export const classifierSignature = () => `${CLASSIFIER_VERSION}|${overrideSig}`;  // folded into the git cache key

const HOME = os.homedir().replace(/\\/g, '/');
// A Claude Code worktree lives INSIDE the repo it belongs to (<repo>/.claude/worktrees/<name>/...). Roles are judged from that boundary down, as git-local
// does with repo-relative paths: the `.claude` above it is where the worktree is kept, not a role of the files in it.
const WORKTREE = /(?:^|\/)\.claude\/worktrees\/[^/]+\/(.+)$/;
// classifyWhy(path) -> { cls, rule }. `rule` is an id like "agent:dir" or "ext:js" (for tallies by rule, never for display of paths).
export function classifyWhy(file) {
  let p = String(file || '').replace(/\\/g, '/');
  if (p.startsWith(HOME + '/')) p = p.slice(HOME.length + 1);
  else if (p.startsWith('/')) p = p.replace(/^\/+/, '');
  const full = p.split('/').filter((s) => s && s !== '.').join('/');
  const wt = WORKTREE.exec(full);
  const segs = (wt ? wt[1] : full).split('/'), base = segs[segs.length - 1] || '', rel = segs.join('/');
  if (!base) return { cls: 'other', rule: 'none' };
  for (const [re, cls] of overrides) if (re.test(rel) || (wt && re.test(full))) return { cls, rule: `override:${cls}` };
  const r = role(segs, base, rel);
  if (r && (r[1] || !DOC_EXT.has(ext(base)))) return { cls: 'infra', rule: r[0] };
  const e = ext(base);
  if (e && EXT.has(e)) return { cls: EXT.get(e), rule: `ext:${e}` };
  if (!e) for (const [c, names] of Object.entries(CLASS_NAME)) if (names.includes(base)) return { cls: c, rule: `name:${c}` };
  if (base.startsWith('.') && base.length > 1) return { cls: 'config', rule: 'dotfile' };  // .gitignore, .npmrc, .env, .env.local, .env.production: a dotfile whose extension is not in the table
  return { cls: 'other', rule: 'unmatched' };
}
export const classify = (file) => classifyWhy(file).cls;
