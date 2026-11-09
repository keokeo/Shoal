// M0 probe: run one native agent CLI inside node-pty, inject per-launch hooks,
// send a prompt via bracketed paste, and record hook events + rendered screens.
// Usage: node spikes/probe.mjs <claude|codex|agy> [--resume <id>] [--prompt "..."] [--tag name]
import pty from 'node-pty';
import xtermHeadless from '@xterm/headless';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const { Terminal } = xtermHeadless;
const ROOT = path.resolve(import.meta.dirname, '..');
const NOTIFY = path.join(ROOT, 'hooks', 'notify.mjs').replaceAll('\\', '/');
const APPDATA_NPM = path.join(process.env.APPDATA, 'npm');

const argv = process.argv.slice(2);
const agent = argv[0];
const opt = name => { const i = argv.indexOf(`--${name}`); return i > 0 ? argv[i + 1] : undefined; };
const prompt = opt('prompt') ?? 'Reply with exactly the single word PONG and nothing else. Do not use any tools.';
const resumeId = opt('resume');
const tag = opt('tag') ?? (resumeId ? 'resume' : 'new');
const cwd = opt('cwd') ?? path.join(ROOT, '.tmp', 'm0', 'sandbox');
const outDir = path.join(ROOT, '.tmp', 'm0', `${agent}-${tag}`);
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(cwd, { recursive: true });

const t0 = Date.now();
const events = [];
const logLine = (...a) => { const s = `[${((Date.now() - t0) / 1000).toFixed(1)}s] ${a.join(' ')}`; console.log(s); fs.appendFileSync(path.join(outDir, 'probe.log'), s + '\n'); };

// --- hook receiver -------------------------------------------------------
const token = crypto.randomBytes(16).toString('hex');
const sessionId = crypto.randomUUID();
const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/hook' || req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403).end(); return; }
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    try {
      const ev = JSON.parse(body);
      ev.t = (Date.now() - t0) / 1000;
      events.push(ev);
      const p = ev.payload ?? {};
      logLine('HOOK', ev.agent, ev.event, JSON.stringify({ sid: p.session_id ?? p.conversationId, reason: p.terminationReason ?? p.notification_type ?? p.hook_event_name, last: (p.last_assistant_message ?? '').slice?.(0, 80) }));
    } catch (e) { logLine('bad hook body', e.message); }
    res.writeHead(204).end();
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// --- per-launch hook config + command line -------------------------------
const hookCmd = ev => `node "${NOTIFY}" ${agent} ${ev}`;
let file, args;
if (agent === 'claude') {
  file = path.join(APPDATA_NPM, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  const settings = { hooks: {} };
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'Notification', 'PermissionRequest']) {
    settings.hooks[ev] = [{ hooks: [{ type: 'command', command: hookCmd(ev), timeout: 5 }] }];
  }
  const settingsFile = path.join(outDir, 'claude-hooks.json');
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  args = resumeId ? ['--resume', resumeId] : ['--session-id', sessionId];
  args.push('--settings', settingsFile);
} else if (agent === 'codex') {
  file = process.execPath;
  const codexJs = path.join(APPDATA_NPM, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  const hookToml = ev => `hooks.${ev}=[{hooks=[{type="command",command='${hookCmd(ev)}',timeout=5}]}]`;
  args = [codexJs];
  // Never let a probe keystroke land on the startup update prompt.
  const noUpdate = ['-c', 'check_for_update_on_startup=false'];
  if (resumeId) args.push('resume', resumeId);
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'Stop', 'PermissionRequest']) args.push('-c', hookToml(ev));
  args.push(...noUpdate);
  if (!argv.includes('--no-bypass')) args.push('--dangerously-bypass-hook-trust');
} else if (agent === 'agy') {
  file = path.join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe');
  // --settings rejects "hooks"; try a workspace dir added via --add-dir that only holds .agents/hooks.json.
  args = resumeId ? ['--conversation', resumeId] : [];
  const hookDir = opt('agy-hook-dir');
  if (hookDir) args.push('--add-dir', hookDir);
  args.push('--log-file', path.join(outDir, 'agy.log'));
} else {
  console.error('unknown agent'); process.exit(2);
}

// Strip variables inherited from the parent Claude Code session.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT|CODEX_SANDBOX|CODEX_THREAD|AGY_SESSION)/.test(k)));
Object.assign(env, { TERM: 'xterm-256color', COLORTERM: 'truecolor', WORKBENCH_SESSION_ID: sessionId, WORKBENCH_PORT: String(port), WORKBENCH_HOOK_TOKEN: token });

const cols = 120, rows = 36;
const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 2000 });
logLine('spawn', file, JSON.stringify(args).slice(0, 400));
const p = pty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd, env });
const rawLog = fs.createWriteStream(path.join(outDir, 'raw.log'));
let lastOutput = Date.now();
let bracketedPaste = false;
p.onData(d => {
  rawLog.write(d);
  term.write(d);
  lastOutput = Date.now();
  if (d.includes('\x1b[?2004h')) bracketedPaste = true;
  if (d.includes('\x1b[?2004l')) bracketedPaste = false;
});
let exited = null;
p.onExit(e => { exited = e; logLine('pty exit', JSON.stringify(e)); });

const screen = () => {
  const buf = term.buffer.active; const lines = [];
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
  return lines.join('\n').replace(/\n+$/, '');
};
const viewport = () => {
  const buf = term.buffer.active; const lines = [];
  for (let i = buf.viewportY; i < buf.viewportY + rows; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
  return lines.join('\n');
};
const snap = name => fs.writeFileSync(path.join(outDir, `screen-${name}.txt`), viewport());
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitQuiet = async (quietMs, maxMs) => { const end = Date.now() + maxMs; while (Date.now() < end) { if (Date.now() - lastOutput > quietMs) return true; await sleep(200); } return false; };

// --- drive -----------------------------------------------------------------
const waitOutputAfter = async (since, maxMs) => { const end = Date.now() + maxMs; while (Date.now() < end && lastOutput <= since) await sleep(100); };
await waitQuiet(3000, 60000);
// Accept a folder-trust dialog only inside the probe sandbox. Move the cursor to the
// "trust/yes" option first: Claude defaults to "No, exit".
for (let i = 0; i < 3; i++) {
  const v = viewport();
  if (!/trust (this|the files)|Do you trust|trust this folder|Trust folder/i.test(v)) break;
  snap(`trust-${i}`);
  const cursorLine = v.split('\n').find(l => /^\s*[❯›>]/.test(l)) ?? '';
  const keys = /\bno\b/i.test(cursorLine) ? ['\x1b[B', '\r'] : ['\r'];
  logLine('trust dialog detected; cursor line:', JSON.stringify(cursorLine.trim()), 'keys:', JSON.stringify(keys));
  const before = Date.now();
  for (const k of keys) { p.write(k); await sleep(300); }
  await waitOutputAfter(before, 10000);
  await waitQuiet(3000, 30000);
}
// Optional keys before the prompt (e.g. drive a startup panel), each followed by a snapshot.
const preKeys = opt('pre-keys');
if (preKeys) for (const [i, k] of JSON.parse(preKeys).entries()) { p.write(k); await sleep(1200); await waitQuiet(1000, 8000); snap(`pre-${i}`); }
if (argv.includes('--no-prompt')) { snap('ready'); fs.writeFileSync(path.join(outDir, 'events.json'), JSON.stringify(events, null, 2)); try { p.write('\x03'); await sleep(500); p.write('\x03'); await sleep(1500); } catch {} server.close(); setTimeout(() => process.exit(0), 300); await sleep(1e9); }
snap('ready');
logLine('ready; bracketedPaste=', bracketedPaste);

const submitAt = Date.now();
const pasteModeAtSubmit = bracketedPaste;
p.write('\x1b[I');
p.write(bracketedPaste ? `\x1b[200~${prompt}\x1b[201~` : prompt.replace(/\s*\n\s*/g, ' '));
await sleep(400);
p.write('\r');
logLine('prompt submitted');

// Optional: interrupt the running turn with one Ctrl+C and check the CLI survives it.
const interruptAfter = opt('interrupt-after');
if (interruptAfter) {
  await sleep(Number(interruptAfter) * 1000);
  snap('before-interrupt');
  const at = Date.now();
  p.write('\x03');
  logLine('sent Ctrl+C');
  await waitOutputAfter(at, 5000);
  await waitQuiet(2000, 15000);
  snap('after-interrupt');
  logLine('after interrupt: alive=', !exited, 'events since:', JSON.stringify(events.filter(e => e.t * 1000 + t0 >= at).map(e => e.event)));
}
const stopEvents = new Set(['Stop', 'StopFailure']);
const deadline = Date.now() + Number(opt('stop-timeout') ?? 180) * 1000;
while (Date.now() < deadline && !exited && !events.some(e => stopEvents.has(e.event) && e.t * 1000 + t0 > submitAt)) await sleep(250);
const stopped = events.find(e => stopEvents.has(e.event) && e.t * 1000 + t0 > submitAt);
logLine(stopped ? `STOP hook after ${((stopped.t * 1000 + t0 - submitAt) / 1000).toFixed(1)}s` : 'NO stop hook within timeout');
await waitQuiet(1500, 10000);
snap('after');
const quietAfterSubmit = (lastOutput - submitAt) / 1000;

// Native session id as reported by hooks.
const nativeId = events.map(e => e.payload?.session_id ?? e.payload?.conversationId).find(Boolean);

fs.writeFileSync(path.join(outDir, 'events.json'), JSON.stringify(events, null, 2));
fs.writeFileSync(path.join(outDir, 'scrollback.txt'), screen());
const summary = { agent, tag, args, cwd, workbenchSessionId: sessionId, nativeSessionId: nativeId ?? null, bracketedPaste: pasteModeAtSubmit, hookEvents: events.map(e => `${e.event}@${e.t.toFixed(1)}s`), stopHookSeconds: stopped ? +((stopped.t * 1000 + t0 - submitAt) / 1000).toFixed(1) : null, lastOutputAfterSubmitSeconds: +quietAfterSubmit.toFixed(1), screenHasPONG: viewport().split('\n').some(l => /PONG/.test(l) && !/Reply with/.test(l)), exited };
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
logLine('SUMMARY', JSON.stringify(summary));

// Optional extra keys after the turn (e.g. open a warnings panel), each followed by a snapshot.
const afterKeys = opt('after-keys');
if (afterKeys) for (const [i, k] of JSON.parse(afterKeys).entries()) { p.write(k); await sleep(1500); await waitQuiet(1000, 8000); snap(`key-${i}`); }

// Exit politely, then force.
try { p.write('\x03'); await sleep(500); p.write('\x03'); await sleep(1500); } catch {}
if (!exited) { try { p.kill(); } catch {} }
server.close();
setTimeout(() => process.exit(0), 300);
