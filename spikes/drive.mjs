// Interactive PTY driver for spikes: keeps one CLI alive and exposes
//   POST /keys  body = JSON string of keys  -> returns the rendered viewport after output settles
//   GET  /screen                            -> current viewport
//   POST /quit
// Usage: node spikes/drive.mjs <port> <file> [args...]   (args may be a single JSON array via --json '<array>')
import pty from 'node-pty';
import xtermHeadless from '@xterm/headless';
import http from 'node:http';

const { Terminal } = xtermHeadless;
const [portArg, file, ...rest] = process.argv.slice(2);
const args = rest[0] === '--json' ? JSON.parse(rest[1]) : rest;
const cols = 120, rows = 40;
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT)/.test(k)));
Object.assign(env, { TERM: 'xterm-256color', COLORTERM: 'truecolor' });
const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 2000 });
const p = pty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd: process.env.DRIVE_CWD ?? process.cwd(), env });
let lastOutput = Date.now();
let exited = null;
p.onData(d => { term.write(d); lastOutput = Date.now(); });
p.onExit(e => { exited = e; });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const settle = async () => { await sleep(400); const end = Date.now() + 8000; while (Date.now() < end && Date.now() - lastOutput < 800) await sleep(100); };
const viewport = () => {
  const buf = term.buffer.active; const lines = [];
  for (let i = buf.viewportY; i < buf.viewportY + rows; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
  return lines.join('\n').replace(/\n\s*$/g, '') + (exited ? `\n[exited ${JSON.stringify(exited)}]` : '');
};

http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  if (req.url === '/keys') {
    for (const k of JSON.parse(body)) { p.write(k); await sleep(250); }
    await settle();
  } else if (req.url === '/quit') {
    res.end('bye'); try { p.kill(); } catch {} setTimeout(() => process.exit(0), 300); return;
  }
  res.end(viewport());
}).listen(Number(portArg), '127.0.0.1');
