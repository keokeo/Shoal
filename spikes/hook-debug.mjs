// Debug hook: unconditionally logs invocation, cwd, WORKBENCH_* presence and stdin to a file.
import fs from 'node:fs';
const out = process.argv[2];
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { data += c; });
const done = () => {
  fs.appendFileSync(out, JSON.stringify({ at: new Date().toISOString(), argv: process.argv.slice(3), cwd: process.cwd(), wb: !!process.env.WORKBENCH_SESSION_ID, stdin: data.slice(0, 2000) }) + '\n');
  process.stdout.write('{}');
  process.exit(0);
};
process.stdin.on('end', done);
setTimeout(done, 1500);
