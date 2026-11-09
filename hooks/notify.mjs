#!/usr/bin/env node
// Hook relay: forwards CLI lifecycle hook payloads to the workbench server.
// Usage: node notify.mjs <agent> <event>
// No-op unless the CLI was launched by the workbench (WORKBENCH_SESSION_ID set),
// so it is safe to register in global hook configs.
const [agent = 'unknown', event = 'unknown'] = process.argv.slice(2);
const { WORKBENCH_SESSION_ID: sessionId, WORKBENCH_PORT: port, WORKBENCH_HOOK_TOKEN: token } = process.env;

// agy expects a JSON object on stdout; Claude and Codex accept "{}" as a no-op.
const finish = () => {
  if (agent === 'agy') process.stdout.write('{}');
  process.exit(0);
};

if (!sessionId || !port || !token) finish();

const readStdin = () =>
  new Promise(resolve => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    const timer = setTimeout(() => resolve(data), 1500);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(data); });
  });

try {
  const raw = await readStdin();
  let payload = null;
  try { payload = raw ? JSON.parse(raw) : null; } catch { payload = { raw }; }
  await fetch(`http://127.0.0.1:${port}/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ sessionId, agent, event, at: Date.now(), payload }),
    signal: AbortSignal.timeout(2000),
  });
} catch (err) {
  process.stderr.write(`[workbench-hook] ${err?.message ?? err}\n`);
}
finish();
