import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MobileAdminStatus, MobilePairClaimResult } from '../shared/protocol.ts';
import { ROOT } from './agents.ts';
import { AgyOptimizeError, applyAgyOptimization, getAgyOptimizeStatus } from './agyOptimize.ts';
import { createApp } from './http.ts';
import { SessionManager } from './sessions.ts';
import { createFileStore } from './store.ts';
import { createUsage } from './usage.ts';

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

describe('agyOptimize & fast-tools MCP', () => {
  let tmpRoot = '';
  const prevHome = process.env.AGY_HOME_DIR;
  const prevCfg = process.env.AGY_CONFIG_DIR;
  const prevFake = process.env.WORKBENCH_FAKE_AGENT;
  const cleanups: (() => Promise<void>)[] = [];

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shoal-agy-opt-'));
    process.env.AGY_HOME_DIR = tmpRoot;
    process.env.AGY_CONFIG_DIR = path.join(tmpRoot, 'antigravity-cli');
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.AGY_HOME_DIR;
    else process.env.AGY_HOME_DIR = prevHome;
    if (prevCfg === undefined) delete process.env.AGY_CONFIG_DIR;
    else process.env.AGY_CONFIG_DIR = prevCfg;
    if (prevFake === undefined) delete process.env.WORKBENCH_FAKE_AGENT;
    else process.env.WORKBENCH_FAKE_AGENT = prevFake;

    while (cleanups.length) {
      await cleanups.pop()!();
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('optimizes an empty agy home from scratch', () => {
    const initial = getAgyOptimizeStatus();
    expect(initial.optimized).toBe(false);
    expect(initial.cliSettings.optimized).toBe(false);
    expect(initial.outputRule.optimized).toBe(false);
    expect(initial.outputRule.source).toBe('none');
    expect(initial.fastToolsMcp.optimized).toBe(false);

    const applied = applyAgyOptimization();
    expect(applied.optimized).toBe(true);
    expect(applied.cliSettings.optimized).toBe(true);
    expect(applied.outputRule.optimized).toBe(true);
    expect(applied.outputRule.source).toBe('rule_file');
    expect(applied.fastToolsMcp.optimized).toBe(true);
    expect(applied.appliedChanges).toEqual(['cliSettings', 'outputRule', 'fastToolsMcp']);
    expect(applied.backupsCreated).toEqual([]);

    const settings = JSON.parse(fs.readFileSync(applied.cliSettings.path, 'utf8'));
    expect(settings.verbosity).toBe('low');
    expect(settings.colorScheme).toBe('tokyo night');
    expect(settings.model).toBe('Gemini 4 Carbon (Medium)');

    const ruleText = fs.readFileSync(applied.outputRule.path, 'utf8');
    expect(ruleText).toContain('trigger: always_on');
    expect(ruleText).toContain('终端清爽排版规范');

    const mcp = JSON.parse(fs.readFileSync(applied.fastToolsMcp.path, 'utf8'));
    const ft = mcp.mcpServers['fast-tools'];
    expect(fs.existsSync(ft.args[0])).toBe(true);
    for (const toolName of ['fast_search', 'fast_glob', 'fast_tree', 'read_files_batch']) {
      expect(ft.tools[toolName]?.eager).toBe(true);
    }
  });

  it('preserves custom model, trustedWorkspaces, UTF-8 BOM, and creates .shoal.bak once', () => {
    const settingsPath = path.join(process.env.AGY_CONFIG_DIR!, 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const origContent = '\uFEFF' + JSON.stringify({
      model: 'Gemini 4 Carbon (High)',
      trustedWorkspaces: ['G:/Repo'],
      permissions: { allow: ['read'] },
      verbosity: 'high',
    }, null, 2);
    fs.writeFileSync(settingsPath, origContent, 'utf8');

    const res = applyAgyOptimization();
    expect(res.optimized).toBe(true);
    expect(res.backupsCreated).toContain(`${settingsPath}.shoal.bak`);
    expect(fs.readFileSync(`${settingsPath}.shoal.bak`, 'utf8')).toBe(origContent);

    const updated = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(updated.model).toBe('Gemini 4 Carbon (High)');
    expect(updated.trustedWorkspaces).toEqual(['G:/Repo']);
    expect(updated.permissions).toEqual({ allow: ['read'] });
    expect(updated.verbosity).toBe('low');
    expect(updated.colorScheme).toBe('tokyo night');

    // Modify verbosity again and re-run: original .shoal.bak must NOT be overwritten.
    fs.writeFileSync(settingsPath, JSON.stringify({ ...updated, verbosity: 'medium' }), 'utf8');
    const res2 = applyAgyOptimization();
    expect(res2.backupsCreated).toEqual([]);
    expect(fs.readFileSync(`${settingsPath}.shoal.bak`, 'utf8')).toBe(origContent);
  });

  it('preserves existing valid fast-tools script path & other mcpServers while adding eager flags', () => {
    const customScript = path.join(tmpRoot, 'my-fast-tools.mjs');
    fs.writeFileSync(customScript, '// custom fast-tools\n', 'utf8');
    const mcpPath = path.join(tmpRoot, 'config', 'mcp_config.json');
    fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
    fs.writeFileSync(mcpPath, '\uFEFF' + JSON.stringify({
      mcpServers: {
        'other-mcp': { command: 'npx', args: ['-y', 'other'] },
        'fast-tools': {
          command: 'C:/custom/node.exe',
          args: [customScript],
          env: { MAX_OUTPUT_CHARS: '32000' },
          tools: { fast_search: { eager: false } },
        },
      },
    }, null, 2), 'utf8');

    const res = applyAgyOptimization();
    expect(res.fastToolsMcp.optimized).toBe(true);
    expect(res.backupsCreated).toContain(`${mcpPath}.shoal.bak`);

    const mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    expect(mcp.mcpServers['other-mcp']).toEqual({ command: 'npx', args: ['-y', 'other'] });
    expect(mcp.mcpServers['fast-tools'].command).toBe('C:/custom/node.exe');
    expect(mcp.mcpServers['fast-tools'].args).toEqual([customScript]);
    expect(mcp.mcpServers['fast-tools'].env).toEqual({ MAX_OUTPUT_CHARS: '32000' });
    for (const toolName of ['fast_search', 'fast_glob', 'fast_tree', 'read_files_batch']) {
      expect(mcp.mcpServers['fast-tools'].tools[toolName]?.eager).toBe(true);
    }
  });

  it('reuses GEMINI.md when it already contains the output style rule without duplicating rule file', () => {
    const geminiMd = path.join(tmpRoot, 'GEMINI.md');
    const origGemini = '# User Rules\n\n## 终端清爽排版规范\n\n- 一屏控长\n';
    fs.writeFileSync(geminiMd, origGemini, 'utf8');

    const status = getAgyOptimizeStatus();
    expect(status.outputRule.optimized).toBe(true);
    expect(status.outputRule.source).toBe('gemini_md');
    expect(status.outputRule.path).toBe(geminiMd);

    const res = applyAgyOptimization();
    expect(res.outputRule.optimized).toBe(true);
    expect(res.outputRule.source).toBe('gemini_md');
    expect(fs.readFileSync(geminiMd, 'utf8')).toBe(origGemini);
    expect(fs.existsSync(path.join(tmpRoot, 'config', 'rules', 'shoal-output-style.md'))).toBe(false);
  });

  it('throws 400 and refuses to overwrite corrupt settings.json or mcp_config.json', () => {
    const settingsPath = path.join(process.env.AGY_CONFIG_DIR!, 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '{ broken json', 'utf8');

    const status = getAgyOptimizeStatus();
    expect(status.cliSettings.optimized).toBe(false);

    expect(() => applyAgyOptimization()).toThrowError(AgyOptimizeError);
    try {
      applyAgyOptimization();
    } catch (e) {
      expect((e as AgyOptimizeError).status).toBe(400);
      expect((e as AgyOptimizeError).message).toContain('settings.json');
    }
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{ broken json');
  });

  it('hooks/fast-tools.mjs handles Stdio MCP initialize, tools/list, fast_search (fallback), and read_files_batch', async () => {
    const fixtureFile = path.join(tmpRoot, 'sample.ts');
    fs.writeFileSync(fixtureFile, 'export const magicToken = "SHOAL_FAST_TOOLS_OK";\nline2\n', 'utf8');

    const script = path.join(ROOT, 'hooks', 'fast-tools.mjs');
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, RG_PATH: '__NONE__' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    cleanups.push(async () => {
      if (!child.killed) child.kill();
    });

    const responses = new Map<number, Record<string, unknown>>();
    let buf = '';
    const waiters = new Map<number, (msg: Record<string, unknown>) => void>();

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (typeof msg.id === 'number') {
          responses.set(msg.id, msg);
          const w = waiters.get(msg.id);
          if (w) {
            waiters.delete(msg.id);
            w(msg);
          }
        }
      }
    });

    const rpc = (id: number, method: string, params?: unknown) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`RPC timeout for ${method}`)), 5000);
        waiters.set(id, (msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });

    const init = await rpc(1, 'initialize', { protocolVersion: '2025-03-26' });
    expect((init.result as { serverInfo: { name: string } }).serverInfo.name).toBe('fast-tools');

    const list = await rpc(2, 'tools/list');
    const tools = (list.result as { tools: { name: string }[] }).tools.map(t => t.name);
    expect(tools).toEqual(['fast_search', 'fast_glob', 'fast_tree', 'read_files_batch']);

    const search = await rpc(3, 'tools/call', {
      name: 'fast_search',
      arguments: { query: 'SHOAL_FAST_TOOLS_OK', path: tmpRoot, literal: true },
    });
    const searchText = (search.result as { content: { text: string }[] }).content[0].text;
    expect(searchText).toContain('sample.ts:1:');
    expect(searchText).toContain('SHOAL_FAST_TOOLS_OK');

    const batch = await rpc(4, 'tools/call', {
      name: 'read_files_batch',
      arguments: { files: [{ path: fixtureFile, startLine: 1, endLine: 2 }] },
    });
    const batchText = (batch.result as { content: { text: string }[] }).content[0].text;
    expect(batchText).toContain('1: export const magicToken = "SHOAL_FAST_TOOLS_OK";');
    expect(batchText).toContain('2: line2');

    child.stdin.end();
  });

  it('mobile gateway blocks GET and POST /api/agy/optimize with 403', async () => {
    process.env.WORKBENCH_FAKE_AGENT = '1';
    const stateDir = path.join(tmpRoot, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const mainPort = await getFreePort();
    const sessions = new SessionManager({ port: mainPort, token: 'tok', stateDir });
    const store = createFileStore(path.join(stateDir, 'state.json'));
    const usage = createUsage({
      stateDir,
      source: { sessions: () => sessions.list(), tasks: () => store.tasks(), projects: () => store.projects() },
    });
    const app = createApp({ port: mainPort, mobilePort: 0, token: 'tok', store, sessions, stateDir, usage });
    await new Promise<void>(resolve => app.server.listen(mainPort, '127.0.0.1', resolve));
    await app.mobile.ready();
    cleanups.push(async () => {
      await app.mobile.close();
      await sessions.killAll();
      await new Promise<void>(resolve => app.server.close(() => resolve()));
    });

    const baseMain = `http://127.0.0.1:${mainPort}`;
    const enableRes = await fetch(`${baseMain}/api/mobile/admin/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, lanEnabled: false }),
    });
    const mobStatus = (await enableRes.json()) as MobileAdminStatus;
    const mobOrigin = `http://127.0.0.1:${mobStatus.actualPort!}`;

    // Pair one mobile device to obtain a valid authenticated session cookie.
    const pairStart = (await (await fetch(`${baseMain}/api/mobile/admin/pair/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })).json()) as MobileAdminStatus;
    const pairToken = pairStart.activePair!.pairUrl.split('#pair=')[1];
    const claim = (await (await fetch(`${mobOrigin}/api/mobile/pair/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shoal-mobile': '1', origin: mobOrigin },
      body: JSON.stringify({ pairToken }),
    })).json()) as MobilePairClaimResult;

    await fetch(`${baseMain}/api/mobile/admin/pair/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: claim.code }),
    });

    const redeemRes = await fetch(`${mobOrigin}/api/mobile/pair/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shoal-mobile': '1', origin: mobOrigin },
      body: JSON.stringify({ claimId: claim.claimId, claimSecret: claim.claimSecret }),
    });
    const cookie = redeemRes.headers.get('set-cookie')!.split(';')[0];

    const getRes = await fetch(`${mobOrigin}/api/agy/optimize`, {
      headers: { cookie, origin: mobOrigin },
    });
    expect(getRes.status).toBe(403);

    const postRes = await fetch(`${mobOrigin}/api/agy/optimize`, {
      method: 'POST',
      headers: { cookie, origin: mobOrigin, 'x-shoal-mobile': '1', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(postRes.status).toBe(403);
  });
});
