#!/usr/bin/env node
// sigrank-otel-cc: setup | doctor | start | uninstall
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const receiver = path.join(here, 'receiver.mjs');
const [cmd, ...flags] = process.argv.slice(2);
const has = (f) => flags.includes(f);
const cfg = loadConfig();
const home = os.homedir();
const settingsFile = path.join(home, '.claude/settings.json');
const backupFile = settingsFile + '.sigrank-otel-backup';
const LABEL = 'com.sigrank.otel-cc';
const plist = path.join(home, 'Library/LaunchAgents', `${LABEL}.plist`);
const unit = path.join(home, '.config/systemd/user/sigrank-otel-cc.service');
const url = `http://127.0.0.1:${cfg.port}`;
// Only talk to launchctl/systemctl when HOME is the real home (keeps dry runs in a temp HOME harmless).
const realHome = (() => { try { return os.userInfo().homedir === home; } catch { return false; } })();

const envBlock = () => ({
  CLAUDE_CODE_ENABLE_TELEMETRY: '1', CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
  OTEL_METRICS_EXPORTER: 'otlp', OTEL_LOGS_EXPORTER: 'otlp', OTEL_TRACES_EXPORTER: 'otlp',
  OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json', OTEL_EXPORTER_OTLP_ENDPOINT: url,
  OTEL_METRIC_EXPORT_INTERVAL: '10000', OTEL_LOGS_EXPORT_INTERVAL: '5000',
});
const readSettings = () => { try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw new Error(`Cannot read ${settingsFile}: ${e.message}`); } };
const run = (bin, args) => { try { execFileSync(bin, args, { stdio: 'pipe' }); return true; } catch { return false; } };
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

function plistText() {
  const log = path.join(cfg.dataDir, 'receiver.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array><string>${process.execPath}</string><string>${receiver}</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${log}</string><key>StandardErrorPath</key><string>${log}</string>
</dict></plist>
`;
}
const unitText = () => `[Unit]
Description=SigRank OTel receiver (Claude Code telemetry)

[Service]
ExecStart=${process.execPath} ${receiver}
Restart=always

[Install]
WantedBy=default.target
`;

function setup() {
  const dry = has('--dry-run');
  const say = (m) => console.log(dry ? `[dry run] ${m}` : m);
  const cur = readSettings() || {};
  const block = envBlock();
  const changes = Object.entries(block).filter(([k, v]) => cur.env?.[k] !== v);
  say(`${settingsFile}: ${changes.length ? `set ${changes.map(([k]) => k).join(', ')}` : 'telemetry settings already in place'} (other keys untouched)`);
  if (!dry && changes.length) {
    if (fs.existsSync(settingsFile) && !fs.existsSync(backupFile)) { fs.copyFileSync(settingsFile, backupFile); console.log(`Backup saved: ${backupFile}`); }
    write(settingsFile, JSON.stringify({ ...cur, env: { ...cur.env, ...block } }, null, 2) + '\n');
  }
  if (dry) say(`data folder: ${cfg.dataDir}`); else fs.mkdirSync(cfg.dataDir, { recursive: true });
  if (process.platform === 'darwin') {
    say(`autostart: write ${plist}`);
    if (!dry) {
      write(plist, plistText());
      if (realHome) { run('launchctl', ['unload', plist]); say(run('launchctl', ['load', plist]) ? 'receiver started (runs at every login)' : `could not start it; run: launchctl load ${plist}`); }
      else console.log('HOME is not your real home, so launchctl was skipped.');
    }
  } else if (process.platform === 'linux') {
    say(`autostart: write ${unit}`);
    if (!dry) {
      write(unit, unitText());
      if (realHome) say(run('systemctl', ['--user', 'daemon-reload']) && run('systemctl', ['--user', 'enable', '--now', 'sigrank-otel-cc.service']) ? 'receiver started (runs at every login)' : 'could not start it; run: systemctl --user enable --now sigrank-otel-cc.service');
      else console.log('HOME is not your real home, so systemctl was skipped.');
    }
  } else console.log(`No autostart for ${process.platform}. Start it yourself with: node ${receiver}`);
  console.log(dry ? '\n[dry run] Nothing was changed.' : `\nDone. Restart Claude Code once so it starts sending data.\nDashboard: ${url}/`);
}

function lastEventAge() {
  if (!fs.existsSync(cfg.out)) return null;
  const size = fs.statSync(cfg.out).size, n = Math.min(size, 65536), buf = Buffer.alloc(n), fd = fs.openSync(cfg.out, 'r');
  fs.readSync(fd, buf, 0, n, size - n); fs.closeSync(fd);
  const lines = buf.toString('utf8').split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { const r = JSON.parse(lines[i]); const t = Number(r.time || r.end || r.start); if (t) return Date.now() - t / 1e6; } catch {}
  }
  return null;
}
const ago = (ms) => ms < 6e4 ? `${Math.round(ms / 1e3)}s ago` : ms < 36e5 ? `${Math.round(ms / 6e4)} min ago` : ms < 864e5 ? `${(ms / 36e5).toFixed(1)} h ago` : `${Math.round(ms / 864e5)} days ago`;

async function doctor() {
  let bad = 0;
  const line = (ok, label, hint) => { if (!ok) bad++; console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${!ok && hint ? `\n       fix: ${hint}` : ''}`); };
  try { const r = await fetch(`${url}/`, { signal: AbortSignal.timeout(3000) }); line(r.ok, `Receiver answering at ${url}`, 'run: sigrank-otel-cc start (or sigrank-otel-cc setup)'); }
  catch { line(false, `Receiver answering at ${url}`, 'run: sigrank-otel-cc start (or sigrank-otel-cc setup)'); }
  let s = null; try { s = readSettings(); } catch (e) { console.log(e.message); }
  const want = envBlock(), env = s?.env || {};
  const missing = Object.keys(want).filter((k) => env[k] !== want[k]);
  line(!missing.length, `Claude Code telemetry settings in ${settingsFile}`, missing.length ? `run: sigrank-otel-cc setup (differs: ${missing.join(', ')})` : '');
  const age = lastEventAge();
  line(age != null, age != null ? `Last event ${ago(age)} (${cfg.out})` : `Last event: none yet (${cfg.out})`, 'start Claude Code after setup and send a prompt');
  try { const { resolveCascade } = await import('./cascade.mjs'); const c = await resolveCascade(); line(true, `token-cascade found (${c.from})`); }
  catch (e) { line(false, 'token-cascade found', e.message); }
  console.log(`\nData folder: ${cfg.dataDir}   Port: ${cfg.port}   Codename: ${cfg.codename || '(not set, board "you" row off)'}`);
  process.exit(bad ? 1 : 0);
}

function uninstall() {
  if (process.platform === 'darwin') {
    if (realHome) run('launchctl', ['unload', plist]);
    if (fs.existsSync(plist)) { fs.unlinkSync(plist); console.log(`Removed ${plist}`); } else console.log('No autostart to remove.');
  } else if (process.platform === 'linux') {
    if (realHome) run('systemctl', ['--user', 'disable', '--now', 'sigrank-otel-cc.service']);
    if (fs.existsSync(unit)) { fs.unlinkSync(unit); console.log(`Removed ${unit}`); } else console.log('No autostart to remove.');
  }
  if (has('--env')) {
    // Put back only the telemetry keys, so any other settings you changed since setup stay.
    const cur = readSettings(); if (!cur) return console.log('No settings file; nothing to restore.');
    let old = {}; try { old = JSON.parse(fs.readFileSync(backupFile, 'utf8')).env || {}; } catch {}
    const env = { ...cur.env };
    for (const k of Object.keys(envBlock())) { if (k in old) env[k] = old[k]; else delete env[k]; }
    const next = { ...cur, env }; if (!Object.keys(env).length) delete next.env;
    write(settingsFile, JSON.stringify(next, null, 2) + '\n');
    console.log(`Telemetry settings removed from ${settingsFile}. Restart Claude Code to stop sending data.`);
  } else console.log('Telemetry settings left in place. Add --env to remove them too.');
  console.log(`Your data stays in ${cfg.dataDir}.`);
}

if (cmd === 'setup') setup();
else if (cmd === 'doctor') await doctor();
else if (cmd === 'uninstall') uninstall();
else if (cmd === 'start') { process.argv.splice(2, 1); await import('./receiver.mjs'); }
else console.log(`sigrank-otel-cc <command>
  setup [--dry-run]   point Claude Code at the receiver and start it at login
  doctor              check receiver, settings, recent data, token-cascade
  start               run the receiver in this terminal
  uninstall [--env]   remove autostart (--env also removes the telemetry settings)`);
