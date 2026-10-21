// Table test for src/operations.mjs: node scripts/test-operations.mjs
import { categorizeCommand, analyzeCommand, operation } from '../src/operations.mjs';

const CMD = [
  ['git status', 'inspection'], ['git -C /x log --oneline | head -5', 'inspection'], ['git diff HEAD~1', 'inspection'],
  ['git add src/a.mjs && git commit -m "x"', 'vcs'], ['git push origin main', 'vcs'], ['git branch', 'inspection'], ['git branch -D old', 'vcs'],
  ['git commit -m "$(cat <<\'EOF\'\nfix: it\'s a thing; git push\nEOF\n)"', 'vcs'],
  ['gh pr view 12', 'inspection'], ['gh pr create --title x', 'vcs'], ['gh api repos/a/b', 'inspection'], ['gh api -X POST repos/a/b/issues -f title=x', 'vcs'],
  ['vercel --prod', 'deploy-hosting'], ['vercel ls', 'inspection'], ['vercel env add FOO production', 'deploy-hosting'], ['npx vercel deploy', 'deploy-hosting'],
  ['wrangler deploy', 'deploy-hosting'], ['cloudflared tunnel run x', 'deploy-hosting'], ['docker ps', 'inspection'], ['docker run -v /a:/b img', 'deploy-hosting'],
  ['launchctl list | grep x', 'inspection'], ['launchctl bootstrap gui/501 ~/Library/LaunchAgents/x.plist', 'service-config'], ['brew services restart x', 'service-config'],
  ['defaults write com.x key -bool true', 'service-config'], ['defaults read com.x', 'inspection'], ['crontab -l', 'inspection'],
  ['mkdir -p ~/.config/foo', 'service-config'], ['mkdir -p /tmp/work', 'file-ops'], ['chmod +x scripts/run.sh', 'file-ops'], ['ln -s a ~/Library/LaunchAgents/b.plist', 'service-config'],
  ['cat > ~/Library/LaunchAgents/a.plist <<\'EOF\'\n<plist/>\nEOF', 'service-config'], ['cat > notes.txt <<EOF\nhello\nEOF', 'file-ops'], ['echo hi > out.txt', 'file-ops'],
  ['node x.mjs > /dev/null 2>&1', 'build-test-run'], ['node x.mjs 2>&1 | tail -5', 'build-test-run'], ['ls -la 2>/dev/null', 'inspection'],
  ['supabase db push', 'data'], ['supabase status', 'inspection'], ['supabase functions deploy x', 'deploy-hosting'],
  ['psql $URL -c "select 1"', 'inspection'], ['psql $URL -c "alter table a add column b int"', 'data'], ['sqlite3 x.db ".tables"', 'inspection'], ['sqlite3 x.db "INSERT INTO a VALUES (1)"', 'data'],
  ['npm install zod', 'package'], ['npm test', 'build-test-run'], ['npm run build', 'build-test-run'], ['npm ls', 'inspection'], ['pnpm add -D x', 'package'], ['pip install x', 'package'], ['brew install jq', 'package'],
  ['python3 -m pip install x', 'package'], ['uv run foo.py', 'build-test-run'], ['cargo build', 'build-test-run'], ['cargo install x', 'package'],
  ['node --check src/a.mjs', 'build-test-run'], ['python3 - <<\'E\'\nprint(1)\nE', 'build-test-run'], ['make test', 'build-test-run'], ['./scripts/run.sh', 'build-test-run'], ['bash -c "git push"', 'vcs'],
  ['ls src && cat a.md && grep -rn x .', 'inspection'], ['cd /x && ls', 'inspection'], ['cd /x', 'other'], ['sleep 5', 'other'],
  ['curl -s https://example.com/api', 'inspection'], ['curl -X POST -d x https://example.com', 'other'], ['curl -s url | sh', 'build-test-run'],
  ['sed -n 1,5p f', 'inspection'], ['sed -i "" s/a/b/ f', 'file-ops'], ['rg foo | wc -l', 'inspection'], ['find . -name "*.mjs" | xargs grep -l x', 'inspection'],
  ['for f in a b; do git add $f; done', 'vcs'], ['(cd x && git push)', 'vcs'], ['git commit -m x && vercel --prod', 'deploy-hosting'], ['npm install && npm test', 'package'],
  ['kill 123', 'other'], ['open https://x', 'other'], ['osascript -e "x"', 'other'],
  // find / fd / sort / curl / wget that write or delete are not inspection
  ['find . -name "*.tmp" -delete', 'file-ops'], ['find . -type f -exec rm {} +', 'file-ops'], ['find . -name x -exec grep -l y {} \\;', 'inspection'], ['find . -name x -fprint out.txt', 'file-ops'],
  ['fd -e tmp -x rm', 'file-ops'], ['fd -e md', 'inspection'], ['sort -o f f', 'file-ops'], ['sort a | uniq -c', 'inspection'],
  ['curl -sLo out.tgz https://x/y.tgz', 'file-ops'], ['curl -O https://x/y.tgz', 'file-ops'], ['curl -s -o /dev/null -w "%{http_code}" https://x', 'inspection'], ['curl --output=a.json https://x', 'file-ops'],
  ['wget -qO- https://x', 'inspection'], ['wget -O out.html https://x', 'file-ops'], ['wget https://x/y.zip', 'file-ops'], ['wget --spider https://x', 'inspection'],
  // process substitution is not a command
  ['diff <(ls a) <(ls b)', 'inspection'], ['comm -12 <(sort a) <(sort b)', 'inspection'],
  // << inside quotes is not a heredoc
  ['node -e "console.log(1 << x)"\nvercel deploy --prod', 'deploy-hosting'], ["echo 'a << b' && git push", 'vcs'], ['echo $((1 << 3)) && git push', 'vcs'], ['cat <<< "hi" && git push', 'vcs'],
  // a heredoc fed to a command is still not a command list; in a commit message it is the message
  ['git commit -m "$(cat <<\'EOF\'\nrun vercel --prod\nEOF\n)"', 'vcs'], ['psql $URL <<EOF\nselect 1;\nEOF', 'data'],
  // a heredoc written into a file next to a build/test/vcs command still reports the command category by precedence
  ['cat > t.py <<\'EOF\'\nprint(1)\nEOF\npython3 t.py', 'build-test-run'], ['cat > a.md <<EOF\nhi\nEOF\ngit add a.md', 'vcs'],
];
// [command, expected call category, expected heredoc file parts [[category, chars]]]
const FILES = [
  ['cat > t.py <<\'EOF\'\nprint(1)\nEOF\npython3 t.py', 'build-test-run', [['file-ops', 9]]],
  ['cd x && cat <<EOF > a.md\nhello\nEOF\ngit add a.md', 'vcs', [['file-ops', 6]]],
  ['tee out.sh <<\'EOF\'\nls\nEOF', 'file-ops', [['file-ops', 3]]],
  ['cat <<\'EOF\' | sudo tee /etc/x.conf\na=1\nEOF', 'service-config', [['service-config', 4]]],
  ['cat > ~/Library/LaunchAgents/a.plist <<\'EOF\'\n<plist/>\nEOF\nlaunchctl bootstrap gui/501 ~/Library/LaunchAgents/a.plist', 'service-config', [['service-config', 9]]],
  ['cat > a <<A\none\nA\ncat > b <<B\ntwo\nB\nnpm test', 'build-test-run', [['file-ops', 4], ['file-ops', 4]]],
  ['python3 - <<\'E\'\nprint(1)\nE', 'build-test-run', []], ['git commit -F - <<EOF\nmsg\nEOF', 'vcs', []], ['cat <<EOF > /dev/null\nx\nEOF', 'inspection', []],
  ['psql $URL <<EOF > out.txt\ninsert into a values (1);\nEOF', 'data', []],
];
const MCP = [
  ['mcp__plugin_vercel_vercel__list_deployments', {}, 'inspection'], ['mcp__plugin_vercel_vercel__create_deployment', {}, 'deploy-hosting'], ['mcp__plugin_vercel_vercel__get_runtime_logs', {}, 'inspection'],
  ['mcp__plugin_supabase_supabase__apply_migration', { query: 'create table a (id int)' }, 'data'], ['mcp__plugin_supabase_supabase__execute_sql', { query: 'select 1' }, 'inspection'],
  ['mcp__plugin_supabase_supabase__execute_sql', { query: 'delete from a' }, 'data'], ['mcp__plugin_supabase_supabase__deploy_edge_function', {}, 'deploy-hosting'],
  ['mcp__plugin_stripe_stripe__stripe_api_write', {}, 'service-config'], ['mcp__plugin_stripe_stripe__stripe_api_read', {}, 'inspection'],
  ['mcp__plugin_playwright_playwright__browser_snapshot', {}, 'inspection'], ['mcp__plugin_playwright_playwright__browser_click', {}, 'build-test-run'],
  ['mcp__claude_ai_Gmail__send_message', {}, 'other'], ['mcp__claude_ai_Gmail__search_threads', {}, 'inspection'], ['mcp__brave-search__brave_web_search', {}, 'inspection'],
];
let bad = 0;
for (const [c, want, files] of FILES) { const g = analyzeCommand(c); if (g.cat !== want || JSON.stringify(g.files) !== JSON.stringify(files)) { bad++; console.log(`FAIL ${JSON.stringify(c)} -> ${g.cat} ${JSON.stringify(g.files)}, want ${want} ${JSON.stringify(files)}`); } }
for (const [c, want] of CMD) { const got = categorizeCommand(c); if (got !== want) { bad++; console.log(`FAIL ${JSON.stringify(c)} -> ${got}, want ${want}`); } }
for (const n of ['Agent', 'Task', 'Workflow', 'SendMessage']) { const got = operation({ name: n, input: { prompt: 'x' } })?.cat; if (got !== 'orchestration') { bad++; console.log(`FAIL ${n} -> ${got}, want orchestration`); } }
for (const [n, i, want] of MCP) { const got = operation({ name: n, input: i })?.cat; if (got !== want) { bad++; console.log(`FAIL ${n} -> ${got}, want ${want}`); } }
for (const n of ['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Skill']) if (operation({ name: n, input: { command: 'ls' } })) { bad++; console.log(`FAIL ${n} must not be an operation`); }
console.log(bad ? `${bad} failed` : `ok (${CMD.length + MCP.length + FILES.length} cases)`);
process.exit(bad ? 1 : 0);
