// M0 web terminal spike: xterm.js in the browser <-> WebSocket <-> node-pty running a native CLI.
// Usage: node spikes/web-term.mjs [port]   then open http://127.0.0.1:<port>/?agent=claude|codex|agy
import pty from 'node-pty';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.argv[2] ?? 47820);
const NPM = path.join(process.env.APPDATA, 'npm', 'node_modules');
const SANDBOX = path.join(ROOT, '.tmp', 'm0', 'sandbox');
const LOG = path.join(ROOT, '.tmp', 'm0', 'web-term.log');
const log = (...a) => fs.appendFileSync(LOG, `${new Date().toISOString()} ${a.join(' ')}\n`);

const launch = {
  claude: () => [path.join(NPM, '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'), []],
  codex: () => [process.execPath, [path.join(NPM, '@openai', 'codex', 'bin', 'codex.js'), '-c', 'check_for_update_on_startup=false']],
  agy: () => [path.join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe'), []],
};

const page = `<!doctype html><meta charset="utf-8"><title>web-term</title>
<link rel="stylesheet" href="/static/xterm/css/xterm.css">
<style>html,body{margin:0;height:100%;background:#1e1e1e}#t{height:100%}</style>
<div id="t"></div>
<script type="module">
import { Terminal } from '/static/xterm/lib/xterm.mjs';
import { FitAddon } from '/static/addon-fit/lib/addon-fit.mjs';
const agent = new URLSearchParams(location.search).get('agent') ?? 'claude';
const term = new Terminal({ fontFamily: 'Cascadia Mono, Consolas, "Microsoft YaHei Mono", monospace', fontSize: 14, cursorBlink: true });
const fit = new FitAddon(); term.loadAddon(fit); term.open(document.getElementById('t')); fit.fit();
const ws = new WebSocket('ws://' + location.host + '/pty?agent=' + agent + '&cols=' + term.cols + '&rows=' + term.rows);
ws.onmessage = e => term.write(e.data);
ws.onclose = () => term.write('\\r\\n[pty closed]\\r\\n');
term.onData(d => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'in', d })));
term.onResize(({ cols, rows }) => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'resize', cols, rows })));
addEventListener('resize', () => fit.fit());
window.__term = term; // test hook: read the rendered buffer from Playwright
term.focus();
</script>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page); return; }
  const m = url.pathname.match(/^\/static\/(xterm|addon-fit)\/(.+)$/);
  if (m) {
    const file = path.join(ROOT, 'node_modules', '@xterm', m[1], m[2]);
    if (!file.startsWith(path.join(ROOT, 'node_modules', '@xterm')) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
    const type = file.endsWith('.css') ? 'text/css' : 'text/javascript';
    res.writeHead(200, { 'content-type': type }).end(fs.readFileSync(file));
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server, path: '/pty' });
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const agent = url.searchParams.get('agent');
  if (!launch[agent]) { ws.close(); return; }
  const [file, args] = launch[agent]();
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT)/.test(k)));
  Object.assign(env, { TERM: 'xterm-256color', COLORTERM: 'truecolor' });
  const p = pty.spawn(file, args, { name: 'xterm-256color', cols: Number(url.searchParams.get('cols')) || 120, rows: Number(url.searchParams.get('rows')) || 36, cwd: SANDBOX, env });
  log('spawn', agent, p.pid);
  p.onData(d => ws.readyState === 1 && ws.send(d));
  p.onExit(e => { log('exit', agent, JSON.stringify(e)); ws.close(); });
  ws.on('message', raw => {
    const msg = JSON.parse(raw);
    if (msg.t === 'in') { log('in', agent, JSON.stringify(msg.d)); p.write(msg.d); }
    else if (msg.t === 'resize') p.resize(msg.cols, msg.rows);
  });
  ws.on('close', () => { try { p.kill(); } catch {} });
});

fs.mkdirSync(SANDBOX, { recursive: true });
server.listen(PORT, '127.0.0.1', () => console.log(`web-term on http://127.0.0.1:${PORT}`));
