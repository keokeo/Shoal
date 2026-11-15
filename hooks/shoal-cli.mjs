#!/usr/bin/env node
// Zero-dependency CLI injected into Shoal workbench PTYs via <stateDir>/bin.
// Subcommands: `shoal peers`, `shoal send <target> ...`, `shoal ask <target> ...`.
import fs from 'node:fs';
import process from 'node:process';

const USAGE = [
  'Shoal 跨 CLI 同项目协作命令：',
  '  shoal peers [--json]',
  '  shoal send <target> [-m "短说明"] [--file <path>] [--stdin] [--new]',
  '  shoal ask  <target> [-m "短说明"] [--file <path>] [--stdin] [--new]',
  '',
  '提示：<target> 支持 #序号（如 #2）、taskId 前缀、任务标题或 agent 名（claude/codex/agy）。',
  '在 PowerShell 中请勿给目标加未加引号的 @ 前缀；多行正文请使用 --file 或 --stdin。',
].join('\n');

const port = process.env.WORKBENCH_PORT;
const token = process.env.WORKBENCH_PEER_TOKEN;

function fail(msg, code = 1) {
  process.stderr.write(`[shoal] ${msg}\n`);
  process.exit(code);
}

const args = process.argv.slice(2);
const cmd = (args[0] ?? 'help').toLowerCase();

if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

if (!port || !token) {
  fail('当前终端未在 Shoal 会话内运行（缺少 WORKBENCH_PORT / WORKBENCH_PEER_TOKEN）', 2);
}

const baseUrl = `http://127.0.0.1:${port}`;
const authHeader = { authorization: `Bearer ${token}` };

async function callJson(method, urlPath, body) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: body !== undefined
      ? { ...authHeader, 'content-type': 'application/json' }
      : authHeader,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  if (!res.ok) {
    fail(json?.error ?? `请求失败 (HTTP ${res.status})`, res.status === 401 || res.status === 403 ? 3 : 1);
  }
  return json;
}

if (cmd === 'peers') {
  const asJson = args.includes('--json');
  const data = await callJson('GET', '/api/peer/peers');
  if (asJson) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    process.exit(0);
  }
  process.stdout.write(`项目「${data.projectName}」同行任务（索引文件: ${data.peersFile}）：\n`);
  for (const t of data.tasks) {
    const mark = t.isSelf ? ' [当前]' : '';
    const reply = t.latestReplyFile ? ` -> ${t.latestReplyFile}` : '';
    process.stdout.write(`  #${t.index} [${t.agent}] ${t.title} (${t.status}/${t.phase})${mark}${reply}\n`);
  }
  process.exit(0);
}

if (cmd !== 'send' && cmd !== 'ask') {
  fail(`未知子命令：${cmd}\n\n${USAGE}`, 2);
}

let target = '';
let note = '';
let filePath = '';
let useStdin = false;
let createIfAgent = false;
const positionals = [];

for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === '-m' || a === '--message' || a === '--note') {
    if (i + 1 >= args.length) fail(`${a} 缺少参数值`, 2);
    note = note ? `${note}\n${args[++i]}` : args[++i];
  } else if (a === '--file' || a === '-f') {
    if (i + 1 >= args.length) fail(`${a} 缺少文件路径`, 2);
    filePath = args[++i];
  } else if (a === '--stdin') {
    useStdin = true;
  } else if (a === '--new') {
    createIfAgent = true;
  } else if (a.startsWith('-')) {
    fail(`未知参数：${a}`, 2);
  } else {
    positionals.push(a);
  }
}

target = (positionals[0] ?? '').replace(/^@+/, '');
if (!target) fail(`用法：shoal ${cmd} <target> [-m "内容"] [--file <path>] [--stdin]`, 2);
if (positionals.length > 1 && !note) {
  note = positionals.slice(1).join(' ');
}

let stdinText = '';
if (useStdin) {
  try {
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) stdinText += chunk;
  } catch (e) {
    fail(`读取 stdin 失败：${e?.message ?? e}`, 1);
  }
}

const result = await callJson('POST', '/api/peer/send', {
  target,
  ...(note ? { note } : {}),
  ...(filePath ? { filePath } : {}),
  ...(stdinText ? { stdinText } : {}),
  replyBack: cmd === 'ask',
  createIfAgent,
});

const verb = result.created ? '已新建协作任务并启动' : result.queued ? '已加入排队投递' : '已发送至';
if (result.replyBack) {
  process.stdout.write(
    `${verb}「${result.targetTitle}」(${result.targetAgent}, hop ${result.hop})。对方本轮完成后结果会自动回传到你的会话；请立即结束当前回合等待回传，勿轮询。\n`,
  );
} else {
  process.stdout.write(`${verb}「${result.targetTitle}」(${result.targetAgent}, hop ${result.hop})。\n`);
}
