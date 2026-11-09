import pty from 'node-pty';
const t0 = Date.now();
const log = (...a) => console.log(`[${Date.now() - t0}ms]`, ...a);
const p = pty.spawn('cmd.exe', ['/d', '/s', '/c', 'echo hello-pty && ver'], { cols: 100, rows: 20, cwd: process.cwd(), env: process.env });
log('spawned pid', p.pid);
let out = '';
p.onData(d => { out += d; });
p.onExit(e => { log('exit', JSON.stringify(e)); log('out', JSON.stringify(out.slice(-200))); setTimeout(() => process.exit(0), 100); });
setTimeout(() => { log('TIMEOUT, out so far', JSON.stringify(out.slice(-300))); process.exit(2); }, 10000);
