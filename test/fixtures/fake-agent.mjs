// Fake interactive CLI for e2e tests: behaves like a real agent under ConPTY without using quota.
// Commands (typed line): `link <uri> [text]` (prints an OSC 8 hyperlink to <uri>, then a prompt), `sleep N`, `ask`, `quota`, `tui` (Claude-style hidden cursor),
// `osc52 <text>` (copies <text> like Claude's fullscreen selection does), `osc52?` (asks to read the clipboard),
// `fullscreen` (alternate screen + mouse reporting), `flood N` (prints N KB),`exit N`, `usage <model> <message id> <input> <output> <cache read> <cache write>`
// (writes a Claude-format usage line to the transcript), `/resume <id>` (switches to conversation <id> like claude's in-CLI
// /resume: not a prompt, prints `RESUMED <id>`, sends SessionStart source=resume with the new id); anything else is a 300 ms turn.
// Keeps its own transcript (one JSON line per turn) at <tmp>/shoal-fake/<native id>.jsonl and reports it as transcript_path.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NOTIFY = path.resolve(import.meta.dirname, '..', '..', 'hooks', 'notify.mjs');
const sid = process.env.WORKBENCH_SESSION_ID ?? 'no-session';
// `--resume <id>` reopens a conversation and keeps its native id, like the real CLIs.
const resumeId = process.argv[2] === '--resume' ? process.argv[3] : undefined;
let nativeId = resumeId ?? `fake-${sid}`;
const initialPrompt = resumeId ? undefined : process.argv[2];
const out = s => process.stdout.write(s);
const transcriptFor = id => path.join(os.tmpdir(), 'shoal-fake', `${id}.jsonl`);
let transcript = transcriptFor(nativeId);
fs.mkdirSync(path.dirname(transcript), { recursive: true });
const record = (role, text) => fs.appendFileSync(transcript, JSON.stringify({ role, text }) + '\n');

function hook(event, extra = {}) {
  const p = spawn(process.execPath, [NOTIFY, 'fake', event], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
  p.on('error', () => {});
  p.stdin.on('error', () => {});
  p.stdin.end(JSON.stringify({ session_id: nativeId, transcript_path: transcript, ...extra }));
}

let line = '';
let mode = 'idle'; // idle | working | ask
let queued = false; // Enter pressed while working
let workTimer = null;
let ctrlCAt = 0;

const showPrompt = () => out('\r\n> ' + line);

function finishTurn(text) {
  mode = 'idle';
  out(`\r\nreply: ${text}`);
  record('assistant', `reply: ${text}`);
  hook('Stop', { last_assistant_message: `reply: ${text}` });
  out('\r\n> ');
  if (queued) {
    queued = false;
    submit();
  }
}

function submit() {
  const text = line;
  line = '';
  out('\r\n');
  // Like claude's in-CLI /resume: switches conversation without being a prompt (no UserPromptSubmit, no log entry).
  const switchTo = /^\/resume\s+(\S+)$/.exec(text.trim())?.[1];
  if (switchTo) {
    nativeId = switchTo;
    transcript = transcriptFor(nativeId);
    out(`RESUMED ${nativeId}\r\n> `);
    hook('SessionStart', { source: 'resume' });
    return;
  }
  if (process.env.FAKE_AGENT_LOG) {
    fs.appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify({ sessionId: sid, line: text, at: Date.now() }) + '\n');
  }
  mode = 'working';
  record('user', text);
  hook('UserPromptSubmit', { prompt: text });
  const [cmd, arg, ...rest] = text.trim().split(/\s+/);
  if (cmd === 'quota') {
    workTimer = setTimeout(() => {
      const msg = "You've hit your session limit · resets 5pm";
      mode = 'idle';
      out(`\r\n${msg}`);
      hook('StopFailure', { error: 'rate_limit', last_assistant_message: msg });
      out('\r\n> ');
    }, 300);
  } else if (cmd === 'link') {
    out(`\x1b]8;;${arg}\x07${rest.join(' ') || arg}\x1b]8;;\x07`);
    mode = 'idle';
    out('\r\n> ');
  } else if (cmd === 'usage') {
    const [id, input, output, cacheRead, cacheWrite] = rest;
    const usage = { input_tokens: +input || 0, output_tokens: +output || 0, cache_read_input_tokens: +cacheRead || 0, cache_creation_input_tokens: +cacheWrite || 0 };
    fs.appendFileSync(transcript, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { id, model: arg, usage } }) + '\n');
    workTimer = setTimeout(() => finishTurn(text), 100);
  } else if (cmd === 'tui') {
    // Like Claude Code: hides the real cursor, paints its own as an inverse cell after `TUI> `, and keeps repainting a
    // status line below that leaves the real cursor at the right end of the input row.
    mode = 'tui';
    out('\x1b[?25lTUI> \x1b[7m \x1b[27m\r\n\x1b[1A\x1b[999C');
    let n = 0;
    setInterval(() => out(`\x1b[1B\r\x1b[Kstatus ${n++}\x1b[1A\x1b[999C`), 50);
  } else if (cmd === 'osc52' || cmd === 'osc52?') {
    const payload = cmd === 'osc52?' ? '?' : Buffer.from(text.trim().slice(6), 'utf8').toString('base64');
    out(`\x1b]52;c;${payload}\x07copied`);
    mode = 'idle';
    out('\r\n> ');
  } else if (cmd === 'fullscreen') {
    // Like Claude Code's fullscreen mode: alternate screen and SGR mouse reporting.
    out('\x1b[?1049h\x1b[?1000;1006h\x1b[HFULLSCREEN');
    mode = 'idle';
    out('\r\n> ');
  } else if (cmd === 'flood') {
    for (let i = 0; i < (Number(arg) || 1) * 16; i++) out(`\r\nflood ${i} ${'x'.repeat(56)}`);
    mode = 'idle';
    out('\r\nflooded\r\n> ');
  } else if (cmd === 'exit') {
    out('bye\r\n');
    process.exit(Number(arg) || 0);
  } else if (cmd === 'ask') {
    hook('PermissionRequest', { tool_name: 'Fake' });
    out('Allow? (y/n)');
    mode = 'ask';
    askText = text;
  } else {
    const ms = cmd === 'sleep' ? (Number(arg) || 0) * 1000 : 300;
    workTimer = setTimeout(() => finishTurn(text), ms);
  }
}
let askText = '';

function interrupt() {
  clearTimeout(workTimer);
  queued = false;
  mode = 'idle';
  out('\r\nInterrupted');
  showPrompt();
}

function key(ch) {
  if (ch === '\x03') {
    if (mode !== 'idle') return interrupt();
    const now = Date.now();
    if (now - ctrlCAt < 1500) process.exit(0);
    ctrlCAt = now;
    out('\r\nPress Ctrl+C again to exit');
    return showPrompt();
  }
  if (mode === 'tui') {
    if (ch >= ' ') line += ch;
    out(`\r\x1b[KTUI> ${line}\x1b[7m \x1b[27m\x1b[999C`);
    return;
  }
  if (mode === 'ask') {
    if (ch === 'y' || ch === 'n') {
      out(ch);
      finishTurn(askText);
    }
    return;
  }
  // Like Codex on Windows: inside a paste only \n is a newline, \r still submits.
  if (inPaste && ch === '\n') {
    line += '\n';
    out('\r\n');
  } else if (ch === '\r' || ch === '\n') {
    if (mode === 'working') queued = true;
    else submit();
  } else if (ch === '\x7f' || ch === '\b') {
    const chars = Array.from(line);
    if (chars.length) {
      chars.pop();
      line = chars.join('');
      out('\b \b');
    }
  } else if (ch >= ' ') {
    line += ch;
    out(ch);
  }
}

let carry = '';
let inPaste = false; // between bracketed-paste markers \n is a newline in the input, not a submit
function feed(data) {
  const s = carry + data;
  carry = '';
  for (let i = 0; i < s.length; ) {
    if (s[i] === '\x1b') {
      if (i + 1 >= s.length) { carry = s.slice(i); break; }
      if (s[i + 1] === '[') {
        // CSI: params then a final byte in 0x40-0x7e (covers paste markers, arrows, focus events)
        let j = i + 2;
        while (j < s.length && !(s.charCodeAt(j) >= 0x40 && s.charCodeAt(j) <= 0x7e)) j++;
        if (j >= s.length) { carry = s.slice(i); break; }
        const seq = s.slice(i, j + 1);
        if (seq === '\x1b[200~') inPaste = true;
        else if (seq === '\x1b[201~') inPaste = false;
        i = j + 1;
      } else {
        // Meta key (Alt+x): echo it visibly so a leaked workbench shortcut shows up in tests.
        for (const c of `<M-${s[i + 1]}>`) key(c);
        i += 2;
      }
      continue;
    }
    const cp = s.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    key(ch);
  }
}

process.stdin.setEncoding('utf8');
process.stdin.setRawMode?.(true);
process.stdin.on('data', feed);
process.stdin.resume();

out('\x1b[?2004h'); // bracketed paste on, like the real CLIs
out(`FAKE AGENT ${sid.slice(0, 8)}${resumeId ? ` RESUMED ${resumeId}` : ''}\r\n> `);
hook('SessionStart', { source: resumeId ? 'resume' : 'startup' });
if (initialPrompt) {
  setTimeout(() => {
    line = initialPrompt;
    out(line);
    submit();
  }, 300);
}
