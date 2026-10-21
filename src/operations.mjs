// Tier 2b "operations" categorizer (derived): what kind of work a non-file-writing tool call was. ONE module, used by src/artifact.mjs.
// Input is a transcript tool_use block (name + input). Output is a category label and the generated-argument char count. A label, never a weight:
// nothing here ranks one category above another. Command text and MCP inputs are read in memory to pick the category and are never kept.
// Rules as built: docs/artifact-measurement.md ("Tier 2b") mirrors the tables below.
import path from 'node:path';

export const OPS_VERSION = 'operations/3';
// Precedence for a compound command, first match wins ("most consequential category present"). Inspection is last: it wins only when nothing else is present.
export const PRECEDENCE = ['deploy-hosting', 'data', 'service-config', 'package', 'vcs', 'build-test-run', 'file-ops', 'orchestration', 'other', 'inspection'];
export const CATEGORIES = PRECEDENCE;
export const ORCH_TOOLS = ['Agent', 'Task', 'Workflow', 'SendMessage'];  // delegation: subagent prompts, workflow scripts, messages to running agents
export const OPS_TOOLS = ['Bash', 'Monitor'];  // built-in tools whose input.command is a shell command; MCP tools are every name starting mcp__

const set = (s) => new Set(s.split(' '));
const str = (v) => (typeof v === 'string' ? v : '');
const rank = (c) => PRECEDENCE.indexOf(c);

// ---------- word tables ----------
const GLUE = set('cd pushd popd export unset set alias unalias readonly declare local typeset let return exit break continue shift trap umask wait sleep true false : fg bg jobs clear hash ulimit for in do done case esac function select read [ [[ test then else elif fi if while until { } ! time');
const INSPECT = set('ls ll la l cat bat head tail less more grep egrep fgrep rg ag ack find fd fdfind wc stat file tree du df pwd which whereis type realpath readlink basename dirname date env printenv whoami uname hostname id uptime ps pgrep pidof lsof top htop diff cmp comm sort uniq cut tr jq yq xxd hexdump od strings md5 md5sum shasum sha256sum cksum openssl nslookup dig host ping traceroute whois netstat ss ifconfig ipconfig arp mdfind mdls ioreg sw_vers sysctl system_profiler vm_stat man help tldr column nl fold paste join expand tac rev seq echo printf pbpaste tput locale getconf nc ncat lsb_release groups finger last w who users');
const FILE_OPS = set('mkdir rm rmdir mv cp touch ln chmod chown chgrp install rsync ditto zip gzip gunzip truncate dd patch tee mktemp unlink');
const RUNNERS = set('node nodejs deno python python3 py pytest tsc tsx ts-node eslint prettier biome vite next nuxt astro webpack rollup esbuild turbo nx make cmake ninja gcc g++ clang cc rustc swift swiftc xcodebuild xcrun jest vitest mocha playwright cypress ruby rake rails php java javac mvn gradle lua perl dotnet ruff mypy black flake8 pylint tox bats shellcheck hugo jekyll sass tailwindcss postcss lighthouse electron expo');
const DEPLOY = set('vercel wrangler cloudflared netlify fly flyctl docker docker-compose podman kubectl helm terraform tofu heroku railway aws gcloud az firebase ngrok pulumi serverless sam cdk doctl');
const SERVICE = set('launchctl systemctl crontab defaults pmset scutil networksetup dscl pm2 caddy nginx service dseditgroup');
const SQL = set('psql sqlite3 mysql duckdb');
const DATA_CLI = set('supabase pg_dump pg_restore pg_dumpall mysqldump redis-cli mongosh mongo prisma drizzle-kit alembic knex sequelize typeorm');
const PKG_MGR = set('npm pnpm yarn bun');
const READ_VERBS = set('ls list get show status logs log inspect describe whoami view info version help search ps images top events history diff validate plan output outputs tail doctor config-get check explain');
const isRead = (t) => READ_VERBS.has(t) || /^(describe|list|get|show)-/.test(t);
const WRITE_SQL = /\b(insert\s+into|update\s+[\w"`.]+\s+set|delete\s+from|create\s+(or\s+replace\s+)?(table|index|unique|view|function|trigger|policy|schema|extension|type|sequence|database|role)|drop\s+(table|index|view|function|trigger|policy|schema|extension|type|sequence|database|role)|alter\s+(table|policy|role|database|schema|view|function)|truncate|replace\s+into|grant\s|revoke\s|vacuum|reindex|attach\s+database|pragma\s+\w+\s*=|\.import|\.read|enable\s+row\s+level|comment\s+on)\b/i;
const READ_SQL = /\bselect\b|\bexplain\b|\bshow\s|\.(tables|schema|dump|headers|mode|indexes|databases)\b|\\(d|dt|l|dn|df|du)\b|\bpragma\s+table_info/i;
const SYSTEM_PATH = /(LaunchAgents|LaunchDaemons|(^|[\s='"])\/etc\/|(~|\$HOME|\$\{HOME\}|\/Users\/[^/\s'"]+|\/home\/[^/\s'"]+)\/(\.config|\.claude|\.local\/share|\.ssh)\b|\/usr\/local\/|\/opt\/homebrew\/|(^|[\s='"])\/Library\/|~\/Library|\.zshrc|\.zprofile|\.zshenv|\.bashrc|\.bash_profile|\.gitconfig)/;

// ---------- shell text -> segments ----------
// Heredoc bodies are not commands: drop them (the `<<TAG` marker stays so a redirect before it is still seen). The scan is quote-aware, so a `<<` inside a
// quoted string (`node -e "1 << x"`) is not a heredoc, while one inside `"$( ... )"` (a commit message) is. Returns the text without bodies and, for each body,
// the line that opens it and the body length: the caller decides whether that body is text written into a file.
const HEREDOC = /<<-?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/y;
function stripHeredocs(s) {
  const bodies = [];
  if (!s.includes('<<')) return { text: s, bodies };
  let out = '', pos = 0; const stack = [];
  const skipArith = (i) => { let d = 0; for (let k = i + 1; k < s.length; k++) { if (s[k] === '(') d++; else if (s[k] === ')' && --d === 0) return k; } return s.length; };  // $(( ... )): arithmetic, not a command
  for (let i = 0; i < s.length; i++) {
    const c = s[i], n = s[i + 1], t = stack[stack.length - 1] || 'top';
    if (t === 'sq') { if (c === "'") stack.pop(); continue; }
    if (c === '\\') { i++; continue; }
    if (c === '$' && n === '(') { if (s[i + 2] === '(') i = skipArith(i + 1); else { stack.push('sub'); i++; } continue; }
    if (t === 'dq') { if (c === '"') stack.pop(); continue; }
    if (c === "'") stack.push('sq');
    else if (c === '"') stack.push('dq');
    else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) { const e = s.indexOf('\n', i); if (e < 0) break; i = e - 1; }
    else if (c === '(') stack.push('paren');
    else if (c === ')') { if (t === 'sub' || t === 'paren') stack.pop(); }
    else if (c === '<' && n === '<') {
      if (s[i + 2] === '<') { i += 2; continue; }  // here-string
      HEREDOC.lastIndex = i; const m = HEREDOC.exec(s);
      if (!m) { i++; continue; }
      const eol = s.indexOf('\n', i + m[0].length);
      if (eol < 0) { i += m[0].length - 1; continue; }
      let a = eol + 1, end = s.length, bodyEnd = s.length;
      while (a <= s.length) {
        let j = s.indexOf('\n', a); if (j < 0) j = s.length;
        if (s.slice(a, j).trim() === m[2]) { end = j; bodyEnd = a; break; }
        if (j >= s.length) break;
        a = j + 1;
      }
      bodies.push({ line: s.slice(s.lastIndexOf('\n', i) + 1, eol), len: bodyEnd - (eol + 1) });
      out += s.slice(pos, eol); pos = end; i = end - 1;
    }
  }
  return { text: out + s.slice(pos), bodies };
}
// Quote-aware split on unquoted && || ; | & newline, backticks and $( ... ). Each segment notes whether it redirects output into a real file.
function split(cmd) {
  const segs = []; let cur = '', q = null, redir = false;
  const push = () => { const t = cur.trim(); if (t && !/^[<>&]+$/.test(t)) segs.push({ t, redir }); cur = ''; redir = false; };  // a lone `<` or `>` is a left-over of `<(...)`, not a command
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i], n = cmd[i + 1];
    if (q) { cur += c; if (c === '\\' && q === '"') cur += cmd[++i] ?? ''; else if (c === q) q = null; continue; }
    if (c === '\\') { cur += c + (cmd[++i] ?? ''); continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === '#' && (cur === '' || /\s$/.test(cur))) { while (i < cmd.length && cmd[i] !== '\n') i++; push(); continue; }
    if (c === '$' && n === '{') { const e = cmd.indexOf('}', i); const t = e < 0 ? cmd.slice(i) : cmd.slice(i, e + 1); cur += t; i += t.length - 1; continue; }
    if ((c === '<' || c === '>') && n === '(') continue;  // process substitution <(...) >(...): the ( starts a nested command
    if (c === '`' || c === '(' || c === ')' || (c === '$' && n === '(')) { push(); if (c === '$') i++; continue; }
    if (c === '\n' || c === ';') { push(); continue; }
    if (c === '&' && n === '&') { push(); i++; continue; }
    if (c === '|') { push(); if (n === '|') i++; continue; }
    if (c === '&' && n !== '>' && cmd[i - 1] !== '>') { push(); continue; }
    if (c === '>' || (c === '&' && n === '>')) {
      let j = c === '&' ? i + 2 : i + 1; if (cmd[j] === '>') j++;
      while (cmd[j] === ' ') j++;
      if (cmd[j] === '&') { cur += cmd.slice(i, j + 1); i = j; continue; }  // 2>&1: a descriptor, not a file
      let e = j; while (e < cmd.length && !/[\s;&|)]/.test(cmd[e])) e++;
      const target = cmd.slice(j, e);
      if (target && !/^\/dev\/(null|stdout|stderr|tty)$/.test(target)) redir = true;
      cur += cmd.slice(i, e); i = e - 1; continue;
    }
    cur += c;
  }
  push();
  return segs;
}
// Shell words with quotes removed (enough to read a command word and its first arguments).
function words(t) {
  const out = []; let w = '', q = null, has = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '\\' && q === '"' && i + 1 < t.length) { w += t[++i]; continue; } if (c === q) q = null; else w += c; continue; }
    if (c === "'" || c === '"') { q = c; has = true; continue; }
    if (c === '\\' && i + 1 < t.length) { w += t[++i]; has = true; continue; }
    if (/\s/.test(c)) { if (w || has) out.push(w); w = ''; has = false; continue; }
    w += c; has = true;
  }
  if (w || has) out.push(w);
  return out;
}
const nonFlags = (args, skipVal = set('')) => { const o = []; for (let i = 0; i < args.length; i++) { const a = args[i]; if (a.startsWith('-')) { if (skipVal.has(a)) i++; continue; } o.push(a); } return o; };
const hasFlag = (args, re) => args.some((a) => re.test(a));

// ---------- per-command rules ----------
const GIT_READ = set('status log diff show blame shortlog describe rev-parse rev-list ls-files ls-tree ls-remote cat-file grep reflog name-rev merge-base for-each-ref show-ref show-branch whatchanged check-ignore count-objects fsck diff-tree diff-files diff-index var help version cherry range-diff verify-commit verify-tag');
function git(args) {
  const rest = []; for (let i = 0; i < args.length; i++) { const a = args[i]; if (a === '-C' || a === '-c' || a === '--git-dir' || a === '--work-tree' || a === '--namespace') { i++; continue; } if (a.startsWith('-')) continue; rest.push(...args.slice(i)); break; }
  const sub = rest[0], more = rest.slice(1), flags = more.filter((a) => a.startsWith('-')), pos = more.filter((a) => !a.startsWith('-'));
  if (!sub) return 'inspection';
  if (GIT_READ.has(sub)) return 'inspection';
  if (sub === 'branch') return !pos.length && !flags.some((f) => /^-(d|D|m|M|c|C|u|-delete|-move|-copy|-set-upstream-to|-unset-upstream)/.test(f)) ? 'inspection' : 'vcs';
  if (sub === 'tag') return !pos.length || flags.some((f) => f === '-l' || f === '--list') ? 'inspection' : 'vcs';
  if (sub === 'remote') return !pos.length || pos[0] === 'show' || pos[0] === 'get-url' ? 'inspection' : 'vcs';
  if (sub === 'stash') return ['list', 'show'].includes(pos[0]) ? 'inspection' : 'vcs';
  if (sub === 'worktree') return pos[0] === 'list' ? 'inspection' : 'vcs';
  if (sub === 'submodule') return !pos.length || pos[0] === 'status' || pos[0] === 'summary' ? 'inspection' : 'vcs';
  if (sub === 'config') return flags.some((f) => /^--(get|list|get-all|show-origin|get-regexp)$|^-l$/.test(f)) || pos.length === 1 ? 'inspection' : 'vcs';
  if (sub === 'notes') return !pos.length || ['list', 'show'].includes(pos[0]) ? 'inspection' : 'vcs';
  return 'vcs';
}
const GH_READ = set('list view status checks diff comments watch search browse ls get');
function gh(args) {
  const nf = nonFlags(args, set('-R --repo -H --hostname'));
  if (nf[0] === 'api') {
    const method = (() => { for (let i = 0; i < args.length; i++) if (args[i] === '-X' || args[i] === '--method') return String(args[i + 1] || '').toUpperCase(); else if (/^-X./.test(args[i])) return args[i].slice(2).toUpperCase(); return ''; })();
    return (method && method !== 'GET') || hasFlag(args, /^(-f|-F|--field|--raw-field|--input)$/) ? 'vcs' : 'inspection';
  }
  return nf.slice(0, 2).some((t) => GH_READ.has(t)) || hasFlag(args, /^(--help|--version)$/) ? 'inspection' : 'vcs';
}
const SINK = /^(-|\/dev\/(null|stdout|stderr|tty))$/;  // an output target that is not a file
function curl(args, name) {
  if (name === 'wget') {  // wget saves what it fetches into a file unless told otherwise
    if (hasFlag(args, /^--(post|body|method)/)) return 'other';
    if (hasFlag(args, /^--spider$/)) return 'inspection';
    for (let i = 0; i < args.length; i++) {
      const a = args[i], m = /^--output-document=(.*)$|^-[A-Za-z]*O(.*)$/.exec(a);
      if (m) { const v = m[1] ?? (m[2] || args[i + 1] || ''); return SINK.test(v) ? 'inspection' : 'file-ops'; }
      if (a === '--output-document') return SINK.test(args[i + 1] ?? '') ? 'inspection' : 'file-ops';
    }
    return 'file-ops';
  }
  let target = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^(-d|--data.*|-F|--form.*|-T|--upload-file|--json)$/.test(a) || /^-[dFT]./.test(a)) return 'other';
    if (a === '-X' || a === '--request') { if (!/^(GET|HEAD)$/i.test(args[i + 1] || '')) return 'other'; }
    else if (/^-X./.test(a) && !/^-X(GET|HEAD)$/i.test(a)) return 'other';
    else if (a === '--output' || /^-[A-Za-z]*o$/.test(a)) target = args[i + 1] ?? '';
    else if (/^--output=/.test(a)) target = a.slice(9);
    else if (/^-o./.test(a)) target = a.slice(2);
    else if (/^--remote-name(-all)?$/.test(a) || /^-[A-Za-z]*[OJ][A-Za-z]*$/.test(a)) target = 'remote-name';
  }
  return target != null && !SINK.test(target) ? 'file-ops' : 'inspection';  // -o, -O, -J write a file; a GET without them only prints
}
// find / fd run commands (-exec, -x) and can delete or write (-delete, -fprint): judge what they do, not the word find.
function finder(cmd, args, depth) {
  if (cmd === 'find' && hasFlag(args, /^-(delete|fprint0?|fprintf|fls)$/)) return 'file-ops';
  const i = args.findIndex((a) => (cmd === 'find' ? /^-(exec|execdir|ok|okdir)$/.test(a) : /^(-x|-X|--exec|--exec-batch)$/.test(a)));
  if (i < 0) return 'inspection';
  const run = args.slice(i + 1), e = run.findIndex((a) => a === ';' || a === '+'), c = e < 0 ? run : run.slice(0, e);
  return c.length ? word(c[0], c.slice(1), '', depth + 1) ?? 'inspection' : 'inspection';
}
function sqlClient(text) { return WRITE_SQL.test(text) ? 'data' : READ_SQL.test(text) ? 'inspection' : 'data'; }
function generic(cat, args) {  // deploy / data / service CLIs: a read verb or a help/version flag makes it inspection
  if (hasFlag(args, /^(--help|--version)$/)) return 'inspection';  // -h and -v mean other things in docker, vercel and friends: not read here
  return nonFlags(args).slice(0, 2).some(isRead) ? 'inspection' : cat;
}
const PKG_WRITE = set('install i add remove rm uninstall un update up upgrade ci link unlink dedupe prune rebuild publish unpublish deprecate login logout adduser create init');
const PKG_READ = set('view info show ls list ll la outdated search whoami config get pack explain why ping doctor fund help root bin prefix version v -v');
const PKG_RUN = set('run run-script test t tst start stop restart build dev lint typecheck preview');
function pkgManager(cmd, args, depth) {
  const nf = nonFlags(args, set('--prefix --cwd -C --filter -F -w --workspace --registry --loglevel')), v = nf[0];
  if (!v) return cmd === 'yarn' ? 'package' : 'other';
  if (v === 'audit') return args.includes('fix') ? 'package' : 'inspection';
  if (PKG_WRITE.has(v)) return 'package';
  if (PKG_READ.has(v)) return 'inspection';
  if (v === 'exec' || v === 'dlx' || v === 'x') return runner(nf.slice(1).length ? args.slice(args.indexOf(v) + 1) : [], depth);
  return 'build-test-run';  // run, test, start, build, a script name, or `bun file.ts`
}
function runner(args, depth) {  // npx / bunx / pnpm dlx: judge the command it runs
  const a = args.filter((x) => !['-y', '--yes', '--no-install', '--no'].includes(x));
  const i = a.findIndex((x) => !x.startsWith('-'));
  return i < 0 ? 'build-test-run' : word(a[i], a.slice(i + 1), '', depth + 1) || 'build-test-run';
}
const pip = (args) => (nonFlags(args)[0] && ['freeze', 'list', 'show', 'check', 'config', 'debug', 'index', 'inspect', 'hash', 'help'].includes(nonFlags(args)[0]) ? 'inspection' : 'package');
function pkgOther(cmd, args) {
  const v = nonFlags(args)[0] || '';
  const W = { cargo: 'install add remove update publish yank', go: 'get install mod', gem: 'install uninstall update', bundle: 'install update add remove', brew: 'install reinstall uninstall remove upgrade update tap untap cleanup link unlink pin unpin fetch autoremove', conda: 'install remove create update', mamba: 'install remove create update', poetry: 'add install remove update lock', uv: 'add remove sync lock pip tool venv python', apt: 'install remove purge update upgrade autoremove', 'apt-get': 'install remove purge update upgrade autoremove', dnf: 'install remove update upgrade', yum: 'install remove update upgrade', nvm: 'install use uninstall alias', fnm: 'install use uninstall', volta: 'install uninstall pin', asdf: 'install uninstall plugin global local', pipx: 'install uninstall upgrade reinstall inject', corepack: 'enable disable prepare use' }[cmd];
  if (cmd === 'brew' && v === 'services') return nonFlags(args)[1] && !['list', 'info'].includes(nonFlags(args)[1]) ? 'service-config' : 'inspection';
  if (cmd === 'uv' && v === 'run') return 'build-test-run';
  if (cmd === 'uv' && v === 'pip') return nonFlags(args)[1] && ['list', 'freeze', 'show', 'check', 'tree'].includes(nonFlags(args)[1]) ? 'inspection' : 'package';
  if (cmd === 'poetry' && v === 'run') return 'build-test-run';
  if (set(W || '').has(v)) return 'package';
  if (['cargo', 'go', 'bundle', 'poetry'].includes(cmd) && ['build', 'run', 'test', 'check', 'clippy', 'fmt', 'bench', 'doc', 'vet', 'generate', 'exec', 'tidy'].includes(v)) return 'build-test-run';
  return 'inspection';
}
function systemCtl(cmd, args) {
  const v = nonFlags(args)[0] || '';
  if (cmd === 'launchctl') return ['list', 'print', 'print-cache', 'print-disabled', 'blame', 'error', 'help', 'version', 'managername', 'managerpid', 'manageruid', 'procinfo', 'hostinfo'].includes(v) ? 'inspection' : 'service-config';
  if (cmd === 'systemctl') return ['status', 'is-active', 'is-enabled', 'is-failed', 'list-units', 'list-unit-files', 'list-timers', 'cat', 'show', 'help'].includes(v) ? 'inspection' : 'service-config';
  if (cmd === 'crontab') return hasFlag(args, /^-l$/) ? 'inspection' : 'service-config';
  if (cmd === 'defaults') return ['read', 'read-type', 'domains', 'find', 'help'].includes(v) ? 'inspection' : 'service-config';
  return generic('service-config', args);
}

// One command word + args -> category (null for shell glue).
function word(cmd0, args, text, depth = 0) {
  if (depth > 3) return 'other';
  let cmd = cmd0;
  if (cmd.startsWith('./') || cmd.startsWith('../') || cmd.startsWith('~/')) cmd = '__script';
  else cmd = path.basename(cmd);
  if (cmd === '__script') return 'build-test-run';
  if (GLUE.has(cmd)) return null;
  if (cmd === 'git') return git(args);
  if (cmd === 'gh' || cmd === 'hub' || cmd === 'glab') return gh(args);
  if (cmd === 'curl' || cmd === 'wget') return curl(args, cmd);
  if (cmd === 'find' || cmd === 'fd' || cmd === 'fdfind') return finder(cmd, args, depth);
  if (cmd === 'sort') return hasFlag(args, /^-[A-Za-z]*o$|^--output/) ? 'file-ops' : 'inspection';
  if (cmd === 'sed' || cmd === 'perl') return hasFlag(args, /^-[A-Za-z]*i|^--in-place/) ? 'file-ops' : cmd === 'sed' ? 'inspection' : 'build-test-run';
  if (cmd === 'awk' || cmd === 'gawk') return hasFlag(args, /inplace/) ? 'file-ops' : 'inspection';
  if (cmd === 'tar') return hasFlag(args, /^-?[A-Za-z]*t[A-Za-z]*$|^--list$/) && !hasFlag(args, /^-?[A-Za-z]*[cxu][A-Za-z]*$/) ? 'inspection' : 'file-ops';
  if (cmd === 'unzip') return hasFlag(args, /^-l$|^-Z/) ? 'inspection' : 'file-ops';
  if (cmd === 'plutil') return hasFlag(args, /^-(p|lint|type|extract)$/) ? 'inspection' : 'service-config';
  if (cmd === 'command') return hasFlag(args, /^-[vV]$/) ? 'inspection' : word(args[0] || '', args.slice(1), '', depth + 1);
  if (cmd === 'sudo' || cmd === 'nohup' || cmd === 'nice' || cmd === 'exec' || cmd === 'builtin' || cmd === 'caffeinate' || cmd === 'time') {
    const a = args.slice(); while (a[0] && (a[0].startsWith('-') || /^[A-Za-z_]\w*=/.test(a[0]))) a.shift();
    return a.length ? word(a[0], a.slice(1), '', depth + 1) : null;
  }
  if (cmd === 'env') { const a = args.filter((x) => !x.startsWith('-') && !/^[A-Za-z_]\w*=/.test(x)); return a.length ? word(a[0], a.slice(1), '', depth + 1) : 'inspection'; }
  if (cmd === 'timeout') { const a = args.filter((x) => !x.startsWith('-')); return a.length > 1 ? word(a[1], a.slice(2), '', depth + 1) : null; }
  if (cmd === 'xargs') { const a = args.slice(); while (a[0] && a[0].startsWith('-')) { const f = a.shift(); if (/^-[IndPLEJ]$/.test(f)) a.shift(); } return a.length ? word(a[0], a.slice(1), '', depth + 1) : 'inspection'; }
  if (cmd === 'bash' || cmd === 'sh' || cmd === 'zsh') {
    const ci = args.findIndex((a) => /^-[A-Za-z]*c$/.test(a));
    if (ci >= 0 && args[ci + 1] != null) return categorizeText(args[ci + 1], depth + 1) || 'build-test-run';
    return hasFlag(args, /^-n$/) ? 'inspection' : 'build-test-run';
  }
  if (cmd === 'npx' || cmd === 'bunx') return runner(args, depth);
  if (PKG_MGR.has(cmd)) return pkgManager(cmd, args, depth);
  if ((cmd === 'python' || cmd === 'python3' || /^python3\.\d+$/.test(cmd)) && args[0] === '-m' && args[1] === 'pip') return pip(args.slice(2));
  if (cmd === 'pip' || cmd === 'pip3') return pip(args);
  if (['cargo', 'go', 'gem', 'bundle', 'brew', 'conda', 'mamba', 'poetry', 'uv', 'apt', 'apt-get', 'dnf', 'yum', 'nvm', 'fnm', 'volta', 'asdf', 'pipx', 'corepack'].includes(cmd)) return pkgOther(cmd, args);
  if (cmd === 'supabase') return hasFlag(args, /^(--help|-h|--version)$/) || nonFlags(args).slice(0, 2).some(isRead) ? 'inspection' : nonFlags(args).slice(0, 2).includes('functions') && nonFlags(args).includes('deploy') ? 'deploy-hosting' : 'data';
  if (SQL.has(cmd)) return sqlClient(text);
  if (cmd === 'redis-cli') return /\b(get|mget|keys|scan|ttl|type|exists|info|dbsize|hget|hgetall|lrange|smembers|zrange|ping)\b/i.test(text) && !/\b(set|del|flush|expire|hset|lpush|rpush|sadd|zadd|incr)/i.test(text) ? 'inspection' : 'data';
  if (DATA_CLI.has(cmd)) return generic('data', args);
  if (DEPLOY.has(cmd)) return generic('deploy-hosting', args);
  if (cmd === 'launchctl' || cmd === 'systemctl' || cmd === 'crontab' || cmd === 'defaults' || SERVICE.has(cmd)) return systemCtl(cmd, args);
  if (RUNNERS.has(cmd) || /^python3?\.\d+$/.test(cmd)) return 'build-test-run';
  if (FILE_OPS.has(cmd)) return 'file-ops';
  if (INSPECT.has(cmd)) return 'inspection';
  return 'other';
}
const CONTROL = set('if then else elif do while until ! time { }');
function segment(t, redir, depth) {
  let w = words(t);
  while (w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]) || CONTROL.has(w[0]))) w = w.slice(1);
  if (!w.length) return null;
  let cat = word(w[0], w.slice(1), t, depth);
  if (cat == null) return null;
  if (redir && (cat === 'inspection' || cat === 'other')) cat = 'file-ops';  // a read command writing its output into a file
  if (cat === 'file-ops' && SYSTEM_PATH.test(t)) cat = 'service-config';
  return cat;
}
function categorizeText(cmd, depth = 0) {
  let best = null;
  for (const s of split(stripHeredocs(str(cmd)).text)) {
    const c = segment(s.t, s.redir, depth);
    if (c && (best == null || rank(c) < rank(best))) best = c;
  }
  return best;
}
// Text written into a file by a heredoc: `cat > f <<EOF`, `cat <<EOF > f`, `tee f <<EOF`, `cat <<EOF | tee f`. Returns the category of that write
// (file-ops, or service-config when it lands on a system path) or null when the heredoc is a script, SQL or a commit message fed to some other command.
const WRITERS = set('cat tee');
function heredocFile(line) {
  const segs = split(line), k = segs.findIndex((s) => s.t.includes('<<'));
  if (k < 0) return null;
  const head = (t) => { let w = words(t); while (w.length && (/^[A-Za-z_]\w*=/.test(w[0]) || CONTROL.has(w[0]) || w[0] === 'sudo')) w = w.slice(1); return w; };
  const teeFile = (w) => w.length > 0 && path.basename(w[0]) === 'tee' && nonFlags(w.slice(1)).some((a) => !a.startsWith('<<') && !SINK.test(a));
  const w = head(segs[k].t), bare = !w.length || /^[<>&]/.test(w[0]), w0 = bare ? '' : path.basename(w[0]);
  let at = null;
  if (segs[k].redir) { if (bare || WRITERS.has(w0)) at = segs[k].t; }
  else if (teeFile(w)) at = segs[k].t;
  else if (WRITERS.has(w0)) { const t = segs.slice(k + 1).find((s) => teeFile(head(s.t))); if (t) at = t.t; }
  return at == null ? null : SYSTEM_PATH.test(at) ? 'service-config' : 'file-ops';
}
// A whole command -> { cat, files }. `cat` is the category of the call by precedence (heredoc bodies are not commands and do not vote).
// `files` lists [category, chars] for each heredoc body that is text written into a file: those chars belong to the write, whatever else the same
// command runs (a test, a git add), so the caller counts them under the write's category and not under `cat`.
export function analyzeCommand(cmd) {
  const c = str(cmd), { text, bodies } = stripHeredocs(c);
  let best = null;
  for (const s of split(text)) { const x = segment(s.t, s.redir, 0); if (x && (best == null || rank(x) < rank(best))) best = x; }
  const files = [];
  for (const b of bodies) { const k = b.len > 0 ? heredocFile(b.line) : null; if (k) files.push([k, b.len]); }
  return { cat: best || 'other', files };
}
// Exported for tests: the category of one shell command string ('other' when it is only glue like `cd` or `sleep`).
export const categorizeCommand = (cmd) => analyzeCommand(cmd).cat;

// ---------- MCP tools: category by server and tool name (never by the server's identity beyond that) ----------
const MCP_WRITE_SERVER = [[/vercel/, 'deploy-hosting'], [/supabase/, 'data'], [/stripe/, 'service-config']];
const MCP_READ_VERBS = set('get list search read query find fetch describe show whoami check count aggregate status view download resolve help snapshot screenshot tabs navigate wait console network');
const MCP_READ_WORD = /(^|[_-])(search|fetch|get|list|read|query|find|lookup|scrape|details|analytics|planner|documentation)([_-]|$)/;
const MCP_READ_NAMES = set('generate_typescript_types search_docs web_fetch_vercel_url get_page_text browser_snapshot browser_take_screenshot browser_console_messages browser_network_requests browser_network_request browser_navigate browser_navigate_back browser_wait_for browser_tabs browser_find browser_close tabs_context_mcp list_connected_browsers');
const BROWSER_SERVER = /playwright|chrome|browser|puppeteer/;
function mcp(name, input) {
  const m = /^mcp__(.+?)__(.+)$/.exec(name); if (!m) return 'other';
  const server = m[1].toLowerCase(), tool = m[2].toLowerCase(), verb = tool.split(/[_-]/)[0];
  if (/supabase/.test(server) && tool === 'execute_sql') return sqlClient(JSON.stringify(input ?? {}));
  if (MCP_READ_NAMES.has(tool) || MCP_READ_VERBS.has(verb) || MCP_READ_WORD.test(tool)) return 'inspection';
  if (BROWSER_SERVER.test(server)) return 'build-test-run';  // driving the app under test: click, type, evaluate, run code
  if (/supabase/.test(server) && /deploy_edge_function/.test(tool)) return 'deploy-hosting';
  for (const [re, cat] of MCP_WRITE_SERVER) if (re.test(server)) return cat;
  return 'other';
}

// The one entry point: a transcript tool_use block -> { cat, chars, via } or null when the call is not an operation.
// chars = generated argument text: Bash/Monitor input.command, or the MCP call's input JSON. `files` (shell only) = [category, chars] for heredoc bodies written into a file. Reads (Read, Grep, Glob, LS, WebFetch, WebSearch, TodoWrite),
// agent spawns (Task/Agent), the four file-writing tools (tier 2) and every other harness tool are not operations: they are left in the residual.
export function operation(b) {
  const name = b?.name, i = b?.input && typeof b.input === 'object' ? b.input : {};
  if (OPS_TOOLS.includes(name)) { const c = str(i.command); if (!c) return null; const a = analyzeCommand(c); return { cat: a.cat, chars: c.length, via: 'shell', files: a.files }; }
  if (typeof name === 'string' && name.startsWith('mcp__')) return { cat: mcp(name, i), chars: JSON.stringify(i).length, via: 'mcp' };
  if (ORCH_TOOLS.includes(name)) return { cat: 'orchestration', chars: JSON.stringify(i).length, via: 'agent' };
  return null;
}
