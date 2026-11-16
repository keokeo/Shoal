#!/usr/bin/env node
// Zero-dependency, strictly read-only Stdio MCP server for Antigravity CLI (agy).
// Provides fast_search (ripgrep-backed with pure-Node fallback), fast_glob, fast_tree, and read_files_batch.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SUPPORTED_PROTOCOLS = new Set(['2025-06-18', '2025-03-26', '2024-11-05']);
const DEFAULT_PROTOCOL = '2025-03-26';
const DEFAULT_MAX_CHARS = Math.min(48_000, Math.max(4_000, Number(process.env.MAX_OUTPUT_CHARS) || 24_000));
const SEARCH_TIMEOUT_MS = 10_000;
const IGNORED_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', '.next', '.nuxt', '.svelte-kit',
  'target', 'coverage', '.turbo', '.cache', '__pycache__', '.venv', 'venv',
]);

const activeChildren = new Set();
const activeRequests = new Map(); // requestId -> AbortController

function isFileSafe(filePath) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function resolveRgPath() {
  const envRg = process.env.RG_PATH;
  if (envRg) {
    if (envRg === '__NONE__') return null;
    if (isFileSafe(envRg)) return envRg;
  }

  const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const pathEnv = process.env.PATH || '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, exe);
    if (isFileSafe(full)) return full;
  }

  const home = os.homedir();
  const portableCandidates = [
    path.join(home, '.kimi-code', 'bin', exe),
    path.join(home, '.cargo', 'bin', exe),
  ];
  for (const candidate of portableCandidates) {
    if (isFileSafe(candidate)) return candidate;
  }

  return null;
}

const RG_BIN = resolveRgPath();

const clampInt = (val, def, min, max) => {
  const n = Number(val);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : def;
};

const toPosix = (p) => p.replaceAll('\\', '/');

function globSegmentToRegExp(pat) {
  let re = '';
  for (let i = 0; i < pat.length; i++) {
    const ch = pat[i];
    if (ch === '*') {
      if (pat[i + 1] === '*') {
        if (pat[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if (ch === '{') {
      const close = pat.indexOf('}', i + 1);
      if (close > i + 1 && !pat.slice(i + 1, close).includes('{')) {
        const alts = pat.slice(i + 1, close).split(',').map((s) => globSegmentToRegExp(s));
        re += `(?:${alts.join('|')})`;
        i = close;
      } else {
        re += '\\{';
      }
    } else if ('\\.^$+()[]{}|'.includes(ch)) {
      re += '\\' + ch;
    } else {
      re += ch;
    }
  }
  return re;
}

function globToRegExp(glob) {
  let pat = toPosix(String(glob || '**/*').trim());
  if (!pat.includes('/') && !pat.startsWith('**')) pat = `**/${pat}`;
  return new RegExp(`^${globSegmentToRegExp(pat)}$`, process.platform === 'win32' ? 'i' : '');
}

function killChild(child) {
  if (!child || child.killed) return;
  try {
    child.kill();
  } catch { /* ignore */ }
}

async function runFastSearchRg(rgBin, opts, signal) {
  const { query, targetPath, isFile, literal, caseSensitive, include, exclude, maxResults, contextLines } = opts;
  const args = ['--json', '--line-number', '--color', 'never', '--max-filesize', '2M'];
  if (literal) args.push('--fixed-strings');
  if (caseSensitive === true) args.push('--case-sensitive');
  else if (caseSensitive === false) args.push('--ignore-case');
  else args.push('--smart-case');
  if (contextLines > 0) args.push('-C', String(contextLines));
  if (!isFile) {
    for (const d of IGNORED_DIRS) args.push('-g', `!**/${d}/**`);
    if (include) args.push('-g', String(include));
    if (exclude) args.push('-g', `!${String(exclude).replace(/^!/, '')}`);
  }
  args.push('--', query, targetPath);

  return new Promise((resolve, reject) => {
    let settled = false;
    let truncated = false;
    let timedOut = false;
    let stdoutRest = '';
    let stderrText = '';
    const lines = [];
    let totalChars = 0;
    let matchCount = 0;

    const child = spawn(rgBin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    activeChildren.add(child);

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      activeChildren.delete(child);
      if (err) return reject(err);
      resolve({ lines, matchCount, truncated, timedOut, stderrText: stderrText.trim() });
    };

    const onAbort = () => {
      killChild(child);
      finish(new Error('Search cancelled'));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      timedOut = true;
      truncated = true;
      killChild(child);
    }, SEARCH_TIMEOUT_MS);

    const handleJsonLine = (rawLine) => {
      if (!rawLine || truncated) return;
      let msg;
      try { msg = JSON.parse(rawLine); } catch { return; }
      if (msg.type !== 'match' && msg.type !== 'context') return;
      const d = msg.data;
      const fileText = d?.path?.text ?? '';
      const rel = isFile ? path.basename(targetPath) : toPosix(path.relative(targetPath, fileText) || fileText);
      const lineNo = d?.line_number ?? 0;
      const text = String(d?.lines?.text ?? '').replace(/\r?\n$/, '');
      const trimmed = text.length > 320 ? `${text.slice(0, 320)}…` : text;
      const sep = msg.type === 'match' ? ':' : '-';
      if (msg.type === 'match') {
        if (matchCount >= maxResults) {
          truncated = true;
          killChild(child);
          return;
        }
        matchCount++;
      }
      const formatted = `${rel}${sep}${lineNo}${sep} ${trimmed}`;
      if (totalChars + formatted.length > DEFAULT_MAX_CHARS) {
        truncated = true;
        killChild(child);
        return;
      }
      lines.push(formatted);
      totalChars += formatted.length + 1;
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (truncated) return;
      const combined = stdoutRest + chunk;
      const parts = combined.split('\n');
      stdoutRest = parts.pop() ?? '';
      for (const p of parts) {
        handleJsonLine(p.trim());
        if (truncated) break;
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (stderrText.length < 2048) stderrText += chunk;
    });

    child.on('error', (err) => finish(err));
    child.on('close', (code) => {
      if (!truncated && stdoutRest.trim()) handleJsonLine(stdoutRest.trim());
      if (code === 2 && !truncated && matchCount === 0 && stderrText.trim()) {
        return finish(new Error(stderrText.trim()));
      }
      finish(null);
    });
  });
}

async function runFastSearchFallback(opts, signal) {
  const { query, targetPath, isFile, literal, caseSensitive, include, exclude, maxResults } = opts;
  const flags = caseSensitive === true ? '' : caseSensitive === false ? 'i' : /[A-Z]/.test(query) ? '' : 'i';
  const esc = literal ? query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : query;
  const matcher = new RegExp(esc, flags);
  const incRe = include ? globToRegExp(include) : null;
  const excRe = exclude ? globToRegExp(String(exclude).replace(/^!/, '')) : null;
  const files = [];

  if (isFile) {
    files.push(targetPath);
  } else {
    const queue = [targetPath];
    while (queue.length && files.length < 2000) {
      if (signal?.aborted) throw new Error('Search cancelled');
      const dir = queue.shift();
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        const rel = toPosix(path.relative(targetPath, full));
        if (ent.isDirectory()) {
          if (!IGNORED_DIRS.has(ent.name)) queue.push(full);
        } else if (ent.isFile()) {
          if (incRe && !incRe.test(rel) && !incRe.test(ent.name)) continue;
          if (excRe && (excRe.test(rel) || excRe.test(ent.name))) continue;
          files.push(full);
        }
      }
    }
  }

  const lines = [];
  let matchCount = 0;
  let totalChars = 0;
  let truncated = false;
  for (const file of files) {
    if (signal?.aborted) throw new Error('Search cancelled');
    let stat;
    try { stat = await fsp.stat(file); } catch { continue; }
    if (stat.size > 2 * 1024 * 1024) continue;
    let buf;
    try { buf = await fsp.readFile(file); } catch { continue; }
    if (buf.subarray(0, Math.min(4096, buf.length)).includes(0)) continue;
    const fileLines = buf.toString('utf8').split(/\r?\n/);
    const rel = isFile ? path.basename(targetPath) : toPosix(path.relative(targetPath, file));
    for (let i = 0; i < fileLines.length; i++) {
      if (!matcher.test(fileLines[i])) continue;
      if (matchCount >= maxResults) { truncated = true; break; }
      matchCount++;
      const trimmed = fileLines[i].length > 320 ? `${fileLines[i].slice(0, 320)}…` : fileLines[i];
      const formatted = `${rel}:${i + 1}: ${trimmed}`;
      if (totalChars + formatted.length > DEFAULT_MAX_CHARS) { truncated = true; break; }
      lines.push(formatted);
      totalChars += formatted.length + 1;
    }
    if (truncated) break;
  }
  return { lines, matchCount, truncated, timedOut: false, stderrText: '' };
}

async function toolFastSearch(args, signal) {
  const query = typeof args?.query === 'string' ? args.query : '';
  if (!query) throw new Error('`query` is required and must be a non-empty string.');
  const targetPath = path.resolve(typeof args?.path === 'string' && args.path.trim() ? args.path.trim() : process.cwd());
  let stat;
  try { stat = await fsp.stat(targetPath); } catch { throw new Error(`Path does not exist: ${targetPath}`); }
  const opts = {
    query,
    targetPath,
    isFile: stat.isFile(),
    literal: args?.literal === true,
    caseSensitive: typeof args?.caseSensitive === 'boolean' ? args.caseSensitive : undefined,
    include: typeof args?.include === 'string' && args.include.trim() ? args.include.trim() : undefined,
    exclude: typeof args?.exclude === 'string' && args.exclude.trim() ? args.exclude.trim() : undefined,
    maxResults: clampInt(args?.maxResults, 80, 1, 200),
    contextLines: clampInt(args?.contextLines, 0, 0, 3),
  };

  const res = RG_BIN ? await runFastSearchRg(RG_BIN, opts, signal) : await runFastSearchFallback(opts, signal);
  if (res.lines.length === 0) {
    return `No matches found for ${JSON.stringify(query)} in ${toPosix(targetPath)}.`;
  }
  const footer = [];
  if (res.timedOut) footer.push(`[Stopped at ${SEARCH_TIMEOUT_MS}ms timeout]`);
  else if (res.truncated) footer.push(`[Truncated at ${res.matchCount} matches / output cap; narrow query or include glob]`);
  else footer.push(`[${res.matchCount} match(es)]`);
  return [...res.lines, ...footer].join('\n');
}

async function toolFastGlob(args, signal) {
  const root = path.resolve(typeof args?.path === 'string' && args.path.trim() ? args.path.trim() : process.cwd());
  let stat;
  try { stat = await fsp.stat(root); } catch { throw new Error(`Directory does not exist: ${root}`); }
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${root}`);
  const pattern = typeof args?.pattern === 'string' && args.pattern.trim() ? args.pattern.trim() : '**/*';
  const includeIgnored = args?.includeIgnored === true;
  const maxEntries = clampInt(args?.maxEntries, 200, 1, 500);
  const re = globToRegExp(pattern);

  const matches = [];
  let truncated = false;
  const queue = [root];
  while (queue.length) {
    if (signal?.aborted) throw new Error('Glob cancelled');
    const dir = queue.shift();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const subdirs = [];
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const rel = toPosix(path.relative(root, full));
      if (ent.isDirectory()) {
        if (includeIgnored || !IGNORED_DIRS.has(ent.name)) subdirs.push(full);
      } else if (ent.isFile() || ent.isSymbolicLink()) {
        if (re.test(rel) || (!pattern.includes('/') && re.test(ent.name))) {
          matches.push(rel);
          if (matches.length >= maxEntries) {
            truncated = true;
            break;
          }
        }
      }
    }
    if (truncated) break;
    queue.push(...subdirs);
  }
  if (!matches.length) return `No files matched ${JSON.stringify(pattern)} under ${toPosix(root)}.`;
  const note = truncated ? `\n[Truncated at ${maxEntries} files; refine pattern or path]` : `\n[${matches.length} file(s)]`;
  return matches.join('\n') + note;
}

async function toolFastTree(args, signal) {
  const root = path.resolve(typeof args?.path === 'string' && args.path.trim() ? args.path.trim() : process.cwd());
  let stat;
  try { stat = await fsp.stat(root); } catch { throw new Error(`Directory does not exist: ${root}`); }
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${root}`);
  const maxDepth = clampInt(args?.maxDepth, 3, 1, 6);
  const maxEntries = clampInt(args?.maxEntries, 200, 1, 500);
  const includeIgnored = args?.includeIgnored === true;

  const out = [`${toPosix(root)}/`];
  let count = 0;
  let truncated = false;

  async function walk(dir, depth, prefix) {
    if (depth > maxDepth || truncated) return;
    if (signal?.aborted) throw new Error('Tree cancelled');
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
    for (let i = 0; i < entries.length; i++) {
      if (count >= maxEntries) { truncated = true; return; }
      const ent = entries[i];
      const last = i === entries.length - 1;
      const branch = last ? '└── ' : '├── ';
      const nextPrefix = prefix + (last ? '    ' : '│   ');
      count++;
      if (ent.isDirectory()) {
        if (!includeIgnored && IGNORED_DIRS.has(ent.name)) {
          out.push(`${prefix}${branch}${ent.name}/ [ignored]`);
        } else {
          out.push(`${prefix}${branch}${ent.name}/`);
          if (depth < maxDepth) await walk(path.join(dir, ent.name), depth + 1, nextPrefix);
        }
      } else {
        out.push(`${prefix}${branch}${ent.name}`);
      }
      if (truncated) return;
    }
  }

  await walk(root, 1, '');
  if (truncated) out.push(`[Truncated at ${maxEntries} entries]`);
  return out.join('\n');
}

async function readSingleSlice(item, perFileCap) {
  const rawPath = typeof item?.path === 'string' ? item.path.trim() : '';
  if (!rawPath) return '=== [invalid item: missing path] ===';
  const abs = path.resolve(rawPath);
  let stat;
  try { stat = await fsp.stat(abs); } catch { return `=== ${toPosix(abs)} [missing] ===`; }
  if (!stat.isFile()) return `=== ${toPosix(abs)} [not a regular file] ===`;
  if (stat.size > 4 * 1024 * 1024) return `=== ${toPosix(abs)} [too large: ${stat.size} bytes; use read_file with StartLine/EndLine] ===`;
  let buf;
  try { buf = await fsp.readFile(abs); } catch (e) { return `=== ${toPosix(abs)} [read error: ${e.message}] ===`; }
  if (buf.subarray(0, Math.min(4096, buf.length)).includes(0)) {
    return `=== ${toPosix(abs)} [binary file, ${stat.size} bytes] ===`;
  }
  const allLines = buf.toString('utf8').split(/\r?\n/);
  const totalLines = allLines.length;
  const start = clampInt(item.startLine, 1, 1, Math.max(1, totalLines));
  const end = clampInt(item.endLine, Math.min(totalLines, start + 399), start, Math.max(start, totalLines));
  const slice = allLines.slice(start - 1, end);
  const body = [];
  let chars = 0;
  let actualEnd = start - 1;
  for (let i = 0; i < slice.length; i++) {
    const numbered = `${start + i}: ${slice[i]}`;
    if (chars + numbered.length > perFileCap && body.length > 0) break;
    body.push(numbered);
    chars += numbered.length + 1;
    actualEnd = start + i;
  }
  const truncNote = actualEnd < end ? ` (truncated at char cap; total ${totalLines} lines)` : ` (of ${totalLines})`;
  return `=== ${toPosix(abs)} [lines ${start}-${Math.max(start, actualEnd)}${truncNote}] ===\n${body.join('\n')}`;
}

async function toolReadFilesBatch(args) {
  const list = Array.isArray(args?.files) ? args.files : [];
  if (!list.length) throw new Error('`files` must be a non-empty array of { path, startLine?, endLine? }.');
  if (list.length > 20) throw new Error('`files` supports at most 20 files per batch.');
  const maxTotalChars = clampInt(args?.maxTotalChars, 36_000, 4_000, 48_000);
  const perFileCap = Math.max(2_500, Math.floor(maxTotalChars / Math.min(list.length, 4)));
  const sections = await Promise.all(list.map((it) => readSingleSlice(it, perFileCap)));

  const out = [];
  let used = 0;
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    if (used + sec.length > maxTotalChars && out.length > 0) {
      const rem = maxTotalChars - used;
      if (rem > 256) out.push(sec.slice(0, rem) + '\n...[batch output budget reached]');
      else out.push(`...[skipped ${sections.length - i} remaining file(s): batch output budget ${maxTotalChars} chars reached]`);
      break;
    }
    out.push(sec);
    used += sec.length + 2;
  }
  return out.join('\n\n');
}

const TOOLS = [
  {
    name: 'fast_search',
    description: 'Fast read-only regex or literal text search across files (ripgrep-backed, zero PowerShell startup overhead, auto-excludes .git/node_modules/dist). Prefer over run_command with Select-String, rg, or node -e.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Regex pattern or literal text to search for.' },
        path: { type: 'string', description: 'Directory or file path to search (defaults to workspace cwd).' },
        literal: { type: 'boolean', description: 'Treat query as literal fixed string instead of regex.' },
        caseSensitive: { type: 'boolean', description: 'Force case sensitivity (omit for smart-case).' },
        include: { type: 'string', description: 'Optional include glob filter (e.g. "*.ts" or "server/**").' },
        exclude: { type: 'string', description: 'Optional exclude glob filter.' },
        maxResults: { type: 'integer', description: 'Maximum matches to return across all files (default 80, max 200).' },
        contextLines: { type: 'integer', description: 'Context lines around each match (0-3, default 0).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'fast_glob',
    description: 'Fast read-only file globbing by path/name pattern without PowerShell Get-ChildItem overhead (auto-excludes .git/node_modules/dist).',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.tsx", "*session*", "server/*.test.ts").' },
        path: { type: 'string', description: 'Root directory to search from (defaults to workspace cwd).' },
        includeIgnored: { type: 'boolean', description: 'Include ignored directories such as node_modules/dist.' },
        maxEntries: { type: 'integer', description: 'Maximum matching file paths to return (default 200, max 500).' },
      },
    },
  },
  {
    name: 'fast_tree',
    description: 'Bounded read-only directory tree overview in a single call (replaces multi-turn list_dir or tree commands).',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Root directory path (defaults to workspace cwd).' },
        maxDepth: { type: 'integer', description: 'Maximum directory recursion depth (default 3, max 6).' },
        maxEntries: { type: 'integer', description: 'Maximum entries to emit (default 200, max 500).' },
        includeIgnored: { type: 'boolean', description: 'Expand ignored directories such as node_modules/dist.' },
      },
    },
  },
  {
    name: 'read_files_batch',
    description: 'Read multiple files or line slices concurrently in one read-only tool call (prevents serial read_file turns and avoids inline node -e scripts).',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          description: 'Up to 20 file slices to read concurrently.',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Absolute or workspace-relative file path.' },
              startLine: { type: 'integer', description: '1-based start line (inclusive).' },
              endLine: { type: 'integer', description: '1-based end line (inclusive).' },
            },
            required: ['path'],
          },
        },
        maxTotalChars: { type: 'integer', description: 'Combined character budget across the batch (default 36000, max 48000).' },
      },
      required: ['files'],
    },
  },
];

let useContentLength = false;

function sendMessage(msg) {
  const payload = JSON.stringify(msg);
  if (useContentLength) {
    const byteLen = Buffer.byteLength(payload, 'utf8');
    process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${payload}`);
  } else {
    process.stdout.write(`${payload}\n`);
  }
}

function sendResult(id, result) {
  sendMessage({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  sendMessage({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleRequest(msg) {
  if (!msg || typeof msg !== 'object') return;
  const { id, method, params } = msg;

  if (method === 'notifications/initialized') return;
  if (method === 'notifications/cancelled') {
    const reqId = params?.requestId;
    if (reqId !== undefined && activeRequests.has(reqId)) {
      activeRequests.get(reqId).abort();
      activeRequests.delete(reqId);
    }
    return;
  }

  if (id === undefined) return; // other notifications

  if (method === 'initialize') {
    const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '';
    const protocolVersion = SUPPORTED_PROTOCOLS.has(requested) ? requested : DEFAULT_PROTOCOL;
    return sendResult(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'fast-tools', version: '1.0.0' },
    });
  }

  if (method === 'ping') return sendResult(id, {});
  if (method === 'tools/list') return sendResult(id, { tools: TOOLS });
  if (method === 'resources/list') return sendResult(id, { resources: [] });
  if (method === 'prompts/list') return sendResult(id, { prompts: [] });

  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments ?? {};
    const ac = new AbortController();
    activeRequests.set(id, ac);
    try {
      let text;
      if (name === 'fast_search') text = await toolFastSearch(args, ac.signal);
      else if (name === 'fast_glob') text = await toolFastGlob(args, ac.signal);
      else if (name === 'fast_tree') text = await toolFastTree(args, ac.signal);
      else if (name === 'read_files_batch') text = await toolReadFilesBatch(args);
      else return sendError(id, -32602, `Unknown tool: ${String(name)}`);
      sendResult(id, { content: [{ type: 'text', text }], isError: false });
    } catch (err) {
      if (!ac.signal.aborted) {
        sendResult(id, { content: [{ type: 'text', text: `Error: ${err?.message ?? String(err)}` }], isError: true });
      }
    } finally {
      activeRequests.delete(id);
    }
    return;
  }

  sendError(id, -32601, `Method not found: ${String(method)}`);
}

// Dual-framing reader: supports standard MCP newline-delimited JSON-RPC (go-sdk default) and arbitrary ordered headers (Content-Type + Content-Length).
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
let rawBuf = Buffer.alloc(0);

function drainBuffer() {
  while (rawBuf.length > 0) {
    // Skip leading CR/LF/space/tab between messages when not in mid-header
    let start = 0;
    while (
      start < rawBuf.length &&
      (rawBuf[start] === 0x0d || rawBuf[start] === 0x0a || rawBuf[start] === 0x20 || rawBuf[start] === 0x09)
    ) {
      start++;
    }
    if (start > 0) rawBuf = rawBuf.subarray(start);
    if (rawBuf.length === 0) break;

    if (rawBuf.length > MAX_FRAME_BYTES * 2) {
      rawBuf = Buffer.alloc(0);
      sendError(null, -32600, 'Frame buffer exceeded safety limit');
      break;
    }

    const firstByte = rawBuf[0];
    const isJsonStart = firstByte === 0x7b /* { */ || firstByte === 0x5b /* [ */;
    const headSample = rawBuf.subarray(0, Math.min(128, rawBuf.length)).toString('ascii');
    if (!isJsonStart && /^[A-Za-z][A-Za-z0-9-]*\s*:/.test(headSample)) {
      const sepIdx = rawBuf.indexOf('\r\n\r\n');
      const lfSepIdx = sepIdx < 0 ? rawBuf.indexOf('\n\n') : -1;
      if (sepIdx < 0 && lfSepIdx < 0) break;
      const bodyStart = sepIdx >= 0 ? sepIdx + 4 : lfSepIdx + 2;
      const header = rawBuf.subarray(0, sepIdx >= 0 ? sepIdx : lfSepIdx).toString('ascii');
      const m = header.match(/Content-Length\s*:\s*(\d+)/i);
      if (!m) {
        rawBuf = rawBuf.subarray(bodyStart);
        continue;
      }
      useContentLength = true;
      const len = Number(m[1]);
      if (!Number.isFinite(len) || len < 0 || len > MAX_FRAME_BYTES) {
        rawBuf = Buffer.alloc(0);
        sendError(null, -32600, `Invalid Content-Length: ${m[1]}`);
        break;
      }
      if (rawBuf.length < bodyStart + len) break;
      const jsonStr = rawBuf.subarray(bodyStart, bodyStart + len).toString('utf8');
      rawBuf = rawBuf.subarray(bodyStart + len);
      try {
        void handleRequest(JSON.parse(jsonStr));
      } catch (e) {
        sendError(null, -32700, `Parse error: ${e.message}`);
      }
      continue;
    }

    const nlIdx = rawBuf.indexOf(0x0a);
    if (nlIdx < 0) break;
    if (nlIdx > MAX_FRAME_BYTES) {
      rawBuf = rawBuf.subarray(nlIdx + 1);
      sendError(null, -32600, 'JSON line exceeded safety limit');
      continue;
    }
    const line = rawBuf.subarray(0, nlIdx).toString('utf8').trim();
    rawBuf = rawBuf.subarray(nlIdx + 1);
    if (!line) continue;
    try {
      void handleRequest(JSON.parse(line));
    } catch (e) {
      sendError(null, -32700, `Parse error: ${e.message}`);
    }
  }
}

function shutdown() {
  for (const ac of activeRequests.values()) ac.abort();
  activeRequests.clear();
  for (const child of activeChildren) killChild(child);
  activeChildren.clear();
  process.exit(0);
}

process.stdin.on('data', (chunk) => {
  rawBuf = rawBuf.length === 0 ? chunk : Buffer.concat([rawBuf, chunk]);
  drainBuffer();
});
process.stdin.on('end', shutdown);
process.stdin.on('close', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
