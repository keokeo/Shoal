import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import pty from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeHookFiles } from './agents.ts';
import { createApp } from './http.ts';
import { SessionManager } from './sessions.ts';
import { createFileStore } from './store.ts';
import { createUsage } from './usage.ts';

interface SpawnRec {
  file: string;
  args: string[];
  env: Record<string, string>;
  sessionId: string;
  peerToken: string;
  written: string[];
  emitExit: (code: number) => void;
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as AddressInfo).port;
      srv.close(err => (err ? reject(err) : resolve(p)));
    });
  });
}

function runCli(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; stdin?: string },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (opts.stdin !== undefined) {
      const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', d => { stdout += String(d); });
      child.stderr.on('data', d => { stderr += String(d); });
      child.on('error', reject);
      child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }));
      child.stdin.end(opts.stdin, 'utf8');
      return;
    }
    execFile(cmd, args, { cwd: opts.cwd, env: opts.env, windowsHide: true }, (err, stdout, stderr) => {
      if (err && typeof (err as { code?: unknown }).code !== 'number') {
        reject(err);
        return;
      }
      const code = err ? Number((err as { code?: number }).code ?? 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function setupHarness() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-collab-'));
  const stateDir = path.join(rootDir, 'state');
  const projDir = path.join(rootDir, 'proj');
  const projDir2 = path.join(rootDir, 'proj2');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  fs.mkdirSync(projDir2, { recursive: true });
  writeHookFiles(stateDir);

  const spawns: SpawnRec[] = [];
  const spawnBySession = new Map<string, SpawnRec>();
  vi.spyOn(pty, 'spawn').mockImplementation(((file: string, args: string[] | string, options: pty.IPtyForkOptions) => {
    const env = { ...((options?.env ?? {}) as Record<string, string>) };
    const written: string[] = [];
    let exitCb: (e: { exitCode: number }) => void = () => {};
    const rec: SpawnRec = {
      file,
      args: Array.isArray(args) ? args : [args],
      env,
      sessionId: env.WORKBENCH_SESSION_ID ?? '',
      peerToken: env.WORKBENCH_PEER_TOKEN ?? '',
      written,
      emitExit: code => exitCb({ exitCode: code }),
    };
    spawns.push(rec);
    if (rec.sessionId) spawnBySession.set(rec.sessionId, rec);
    return {
      pid: 7000 + spawns.length,
      cols: 120,
      rows: 36,
      process: path.basename(file),
      handleFlowControl: false,
      onData: () => ({ dispose() {} }),
      onExit: (cb: (e: { exitCode: number }) => void) => {
        exitCb = cb;
        return { dispose() {} };
      },
      write(data: string) { written.push(data); },
      resize() {},
      kill() {},
      pause() {},
      resume() {},
      clear() {},
    } as unknown as pty.IPty;
  }) as typeof pty.spawn);

  const freePort = await getFreePort();
  const token = 'test-hook-token';
  const store = createFileStore(path.join(stateDir, 'state.json'));
  const sessions = new SessionManager({ port: freePort, token, stateDir });
  const usage = createUsage({ stateDir, source: store });
  const app = createApp({ port: freePort, token, store, sessions, stateDir, usage });
  await new Promise<void>(resolve => app.server.listen(freePort, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${freePort}`;

  const api = async <T = any>(method: string, url: string, body?: unknown) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: T | null = null;
    try { json = text ? JSON.parse(text) as T : null; } catch { /* ignore */ }
    return { status: res.status, json: json as T };
  };

  const hook = async (sessionId: string, agent: string, event: string, payload: Record<string, unknown> = {}) => {
    const res = await fetch(`${base}/hook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ sessionId, agent, event, payload }),
    });
    expect(res.status).toBe(204);
  };

  const peer = async <T = any>(
    method: string,
    url: string,
    peerToken: string,
    opts: { body?: unknown; headers?: Record<string, string> } = {},
  ) => {
    const headers: Record<string, string> = {
      ...(peerToken ? { authorization: `Bearer ${peerToken}` } : {}),
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...opts.headers,
    };
    const res = await fetch(`${base}${url}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let json: T | null = null;
    try { json = text ? JSON.parse(text) as T : null; } catch { /* ignore */ }
    return { status: res.status, json: json as T };
  };

  const close = async () => {
    await sessions.killAll();
    await new Promise<void>(resolve => app.server.close(() => resolve()));
  };

  return { rootDir, stateDir, projDir, projDir2, store, sessions, spawns, spawnBySession, api, hook, peer, close };
}

describe('cross-CLI collaboration (Layers 1-3)', () => {
  const prevFake = process.env.WORKBENCH_FAKE_AGENT;
  const prevLocal = process.env.LOCALAPPDATA;
  const prevAgy = process.env.AGY_CONFIG_DIR;

  afterEach(() => {
    vi.restoreAllMocks();
    if (prevFake === undefined) delete process.env.WORKBENCH_FAKE_AGENT; else process.env.WORKBENCH_FAKE_AGENT = prevFake;
    if (prevLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = prevLocal;
    if (prevAgy === undefined) delete process.env.AGY_CONFIG_DIR; else process.env.AGY_CONFIG_DIR = prevAgy;
  });

  it('Layer 1: maintains isolated PEERS.md & turns/<taskId>-latest.md per project and cleans up on delete', async () => {
    process.env.WORKBENCH_FAKE_AGENT = '1';
    const h = await setupHarness();
    try {
      const p1 = (await h.api('POST', '/api/projects', { name: 'Alpha', path: h.projDir })).json;
      const p2 = (await h.api('POST', '/api/projects', { name: 'Beta', path: h.projDir2 })).json;
      const a1 = (await h.api('POST', '/api/tasks', { projectId: p1.id, agent: 'fake', title: 'Task A1', prompt: 'design api' })).json;
      const a2 = (await h.api('POST', '/api/tasks', { projectId: p1.id, agent: 'fake', title: 'Task A2', prompt: 'check schema' })).json;
      const b1 = (await h.api('POST', '/api/tasks', { projectId: p2.id, agent: 'fake', title: 'Task B1', prompt: 'other proj' })).json;

      const recA1 = h.spawnBySession.get(a1.session.id)!;
      expect(recA1.env.WORKBENCH_COLLAB_DIR).toBe(path.join(h.stateDir, 'collab', p1.id));
      expect(recA1.env.WORKBENCH_PEERS_FILE).toBe(path.join(h.stateDir, 'collab', p1.id, 'PEERS.md'));
      expect(recA1.env.WORKBENCH_PEER_TOKEN).toMatch(/^[0-9a-f]{64}$/);
      expect(recA1.env.WORKBENCH_NODE).toBe(process.execPath);
      const pathVal = recA1.env.Path ?? recA1.env.PATH ?? '';
      expect(pathVal.split(path.delimiter)[0]).toBe(path.join(h.stateDir, 'bin'));

      const peers1 = path.join(h.stateDir, 'collab', p1.id, 'PEERS.md');
      const peers2 = path.join(h.stateDir, 'collab', p2.id, 'PEERS.md');
      const md1 = fs.readFileSync(peers1, 'utf8');
      const md2 = fs.readFileSync(peers2, 'utf8');
      expect(md1).toContain('Task A1');
      expect(md1).toContain('Task A2');
      expect(md1).not.toContain('Task B1');
      expect(md2).toContain('Task B1');
      expect(md2).not.toContain('Task A1');

      await h.hook(a1.session.id, 'fake', 'Stop', { last_assistant_message: 'first | pipe\nbody line' });
      await h.hook(a2.session.id, 'fake', 'Stop', { last_assistant_message: 'a2 output' });

      const snapA1 = path.join(h.stateDir, 'collab', p1.id, 'turns', `${a1.task.id}-latest.md`);
      const snapA2 = path.join(h.stateDir, 'collab', p1.id, 'turns', `${a2.task.id}-latest.md`);
      expect(fs.readFileSync(snapA1, 'utf8')).toContain('first | pipe\nbody line');
      expect(fs.existsSync(snapA2)).toBe(true);
      expect(fs.readFileSync(peers1, 'utf8')).toContain('first / pipe');

      expect((await h.api('DELETE', `/api/tasks/${a2.task.id}`)).status).toBe(200);
      expect(fs.existsSync(snapA2)).toBe(false);
      const md1AfterTaskDelete = fs.readFileSync(peers1, 'utf8');
      expect(md1AfterTaskDelete).not.toContain('Task A2');
      expect(md1AfterTaskDelete).toContain('Task A1');

      expect((await h.api('DELETE', `/api/projects/${p1.id}`)).status).toBe(200);
      expect(fs.existsSync(path.join(h.stateDir, 'collab', p1.id))).toBe(false);
      expect(fs.existsSync(peers2)).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('Layer 2: forward with replyBack isolates manual turns, preserves titleAuto/lastActiveAt, stays 1-shot, and disarms on cancel/failure', { timeout: 25_000 }, async () => {
    process.env.WORKBENCH_FAKE_AGENT = '1';
    const h = await setupHarness();
    try {
      const p1 = (await h.api('POST', '/api/projects', { name: 'Alpha', path: h.projDir })).json;
      const a = (await h.api('POST', '/api/tasks', { projectId: p1.id, agent: 'fake', title: 'Task A', prompt: 'init a' })).json;
      await h.hook(a.session.id, 'fake', 'Stop', { last_assistant_message: 'Draft API v1' });
      const cardA = h.store.cards().find(c => c.taskId === a.task.id && c.kind === 'result')!;

      const b = (await h.api('POST', '/api/tasks', { projectId: p1.id, agent: 'fake', prompt: '' })).json;
      await h.hook(b.session.id, 'fake', 'UserPromptSubmit', { prompt: '' });
      const bBefore = h.store.getTask(b.task.id)!;
      expect(bBefore.titleAuto).toBe(true);
      expect(bBefore.title).toBe('新任务 1');

      const fwd = await h.api('POST', `/api/cards/${cardA.id}/forward`, {
        to: { taskId: b.task.id },
        note: 'review v1',
        replyBack: true,
      });
      expect(fwd.status).toBe(200);
      expect(fwd.json.replyBack).toBe(true);

      // Unrelated manual turn finishes on B before the forwarded prompt is delivered: must NOT reply back to A.
      await h.hook(b.session.id, 'fake', 'Stop', { last_assistant_message: 'unrelated manual reply' });
      expect(h.store.cards().some(c => c.taskId === a.task.id && c.meta?.isAutoReply)).toBe(false);

      const recB = h.spawnBySession.get(b.session.id)!;
      const beforeDeliveryIdx = recB.written.length;
      await vi.waitFor(() => {
        const joined = recB.written.slice(beforeDeliveryIdx).join('');
        expect(joined).toContain('review v1');
        expect(recB.written.at(-1)).toBe('\r');
      }, { timeout: 6000, interval: 100 });

      await h.hook(b.session.id, 'fake', 'UserPromptSubmit', { prompt: 'injected text' });
      const bAfterPrompt = h.store.getTask(b.task.id)!;
      expect(bAfterPrompt.titleAuto).toBe(true);
      expect(bAfterPrompt.title).toBe('新任务 1');
      expect(bAfterPrompt.lastActiveAt).toBe(bBefore.lastActiveAt);

      await h.hook(b.session.id, 'fake', 'Stop', { last_assistant_message: 'LGTM from B' });
      const autoCard = h.store.cards().find(c => c.taskId === a.task.id && c.kind === 'forward' && c.meta?.isAutoReply);
      expect(autoCard).toBeDefined();
      expect(autoCard?.meta?.peerHop).toBe(2);
      expect(autoCard?.meta?.sourceTaskId).toBe(b.task.id);

      const recA = h.spawnBySession.get(a.session.id)!;
      await vi.waitFor(() => {
        const joined = recA.written.join('');
        expect(joined).toContain('LGTM from B');
        expect(recA.written.at(-1)).toBe('\r');
      }, { timeout: 6000, interval: 100 });

      // Subsequent completion on A must NOT bounce back to B (strict 1-shot).
      const bCardCountBefore = h.store.cards().filter(c => c.taskId === b.task.id).length;
      await h.hook(a.session.id, 'fake', 'UserPromptSubmit', { prompt: 'auto delivered reply' });
      await h.hook(a.session.id, 'fake', 'Stop', { last_assistant_message: 'ack from A' });
      expect(h.store.cards().filter(c => c.taskId === b.task.id).length).toBe(bCardCountBefore);

      // Disarm on canceled Stop and StopFailure for newly spawned tasks.
      const fwdNew1 = await h.api('POST', `/api/cards/${cardA.id}/forward`, {
        to: { projectId: p1.id, agent: 'fake' },
        note: 'new target canceled',
        replyBack: true,
      });
      expect(fwdNew1.status).toBe(200);
      const countBeforeCancel = h.store.cards().filter(c => c.taskId === a.task.id).length;
      await h.hook(fwdNew1.json.session.id, 'fake', 'Stop', { error: 'canceled', last_assistant_message: 'aborted' });
      expect(h.store.cards().filter(c => c.taskId === a.task.id).length).toBe(countBeforeCancel);

      const fwdNew2 = await h.api('POST', `/api/cards/${cardA.id}/forward`, {
        to: { projectId: p1.id, agent: 'fake' },
        note: 'new target failure',
        replyBack: true,
      });
      expect(fwdNew2.status).toBe(200);
      await h.hook(fwdNew2.json.session.id, 'fake', 'StopFailure', {});
      expect(h.store.cards().filter(c => c.taskId === a.task.id).length).toBe(countBeforeCancel);
    } finally {
      await h.close();
    }
  });

  it('Layer 3: shoal CLI subprocess, security checks, agy subagentWait guard, and MAX_AUTO_HOPS=4 circuit breaker', { timeout: 35_000 }, async () => {
    process.env.WORKBENCH_FAKE_AGENT = '1';
    const agyLocal = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-local-'));
    const agyCfg = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-agycfg-'));
    fs.mkdirSync(path.join(agyLocal, 'agy', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(agyLocal, 'agy', 'bin', 'agy.exe'), '');
    process.env.LOCALAPPDATA = agyLocal;
    process.env.AGY_CONFIG_DIR = agyCfg;

    const h = await setupHarness();
    try {
      const p1 = (await h.api('POST', '/api/projects', { name: 'Alpha', path: h.projDir })).json;
      const a = (await h.api('POST', '/api/tasks', { projectId: p1.id, agent: 'fake', title: 'Task Alpha', prompt: 'start a' })).json;
      const b = (await h.api('POST', '/api/tasks', { projectId: p1.id, agent: 'fake', title: 'Task Beta', prompt: 'start b' })).json;
      await h.hook(a.session.id, 'fake', 'Stop', { last_assistant_message: 'alpha ready' });
      await h.hook(b.session.id, 'fake', 'Stop', { last_assistant_message: 'beta ready' });
      const recA = h.spawnBySession.get(a.session.id)!;

      // 1. Subprocess CLI via Windows shoal.cmd (Path) & shoal-cli.mjs
      const peersRes = process.platform === 'win32'
        ? await runCli('cmd.exe', ['/d', '/c', 'shoal', 'peers', '--json'], { cwd: h.projDir, env: recA.env })
        : await runCli(process.execPath, [path.join(h.stateDir, 'bin', 'shoal-cli.mjs'), 'peers', '--json'], { cwd: h.projDir, env: recA.env });
      expect(peersRes.code).toBe(0);
      const peersJson = JSON.parse(peersRes.stdout);
      expect(peersJson.selfTaskId).toBe(a.task.id);
      expect(peersJson.tasks).toHaveLength(2);

      // Leading @ stripping + multiline --stdin
      const sendStdin = await runCli(
        process.execPath,
        [path.join(h.stateDir, 'bin', 'shoal-cli.mjs'), 'send', '@#2', '--stdin'],
        { cwd: h.projDir, env: recA.env, stdin: 'line one\nline two\n' },
      );
      expect(sendStdin.code).toBe(0);

      // --file inside project
      fs.writeFileSync(path.join(h.projDir, 'spec.md'), 'schema v1\nfields: id', 'utf8');
      const sendFile = await runCli(
        process.execPath,
        [path.join(h.stateDir, 'bin', 'shoal-cli.mjs'), 'send', '#2', '--file', 'spec.md'],
        { cwd: h.projDir, env: recA.env },
      );
      expect(sendFile.code).toBe(0);

      // 3rd send in same turn -> MAX_SENDS_PER_TURN = 2 -> HTTP 409 (exit 1)
      const sendThird = await runCli(
        process.execPath,
        [path.join(h.stateDir, 'bin', 'shoal-cli.mjs'), 'send', '#2', '-m', 'third try'],
        { cwd: h.projDir, env: recA.env },
      );
      expect(sendThird.code).toBe(1);
      expect(sendThird.stderr).toContain('上限 (2)');

      // New human turn resets per-turn limit
      await h.hook(a.session.id, 'fake', 'UserPromptSubmit', { prompt: 'new turn' });

      // --file outside project blocked with 403 (exit 3)
      fs.writeFileSync(path.join(h.rootDir, 'outside.txt'), 'secret', 'utf8');
      const sendOutside = await runCli(
        process.execPath,
        [path.join(h.stateDir, 'bin', 'shoal-cli.mjs'), 'send', '#2', '--file', '../outside.txt'],
        { cwd: h.projDir, env: recA.env },
      );
      expect(sendOutside.code).toBe(3);

      // --new spawns peer task
      const askNew = await runCli(
        process.execPath,
        [path.join(h.stateDir, 'bin', 'shoal-cli.mjs'), 'ask', 'fake', '--new', '-m', 'audit auth'],
        { cwd: h.projDir, env: recA.env },
      );
      expect(askNew.code).toBe(0);
      expect(askNew.stdout).toContain('已新建协作任务');
      await h.hook(a.session.id, 'fake', 'Stop', { last_assistant_message: 'done' });

      // 2. HTTP /api/peer/* security guards
      const evilOrigin = await h.peer('GET', '/api/peer/peers', recA.peerToken, {
        headers: { origin: 'http://evil.local' },
      });
      expect(evilOrigin.status).toBe(403);

      const badTok = await h.peer('GET', '/api/peer/peers', 'not-a-valid-token');
      expect(badTok.status).toBe(401);

      // agy intermediate-stop -> subagentWait 403 -> recovered on primary Stop
      const agyTask = (await h.api('POST', '/api/tasks', {
        projectId: p1.id, agent: 'agy', title: 'Agy Peer', model: '', prompt: 'check',
      })).json;
      const recAgy = h.spawnBySession.get(agyTask.session.id)!;
      const convId = '11111111-1111-4111-8111-111111111111';
      await h.hook(agyTask.session.id, 'agy', 'Stop', {
        conversationId: convId,
        fullyIdle: false,
        workspacePaths: [h.projDir, path.join(h.stateDir, 'agy-hooks')],
      });
      expect((await h.peer('GET', '/api/peer/peers', recAgy.peerToken)).status).toBe(403);
      await h.hook(agyTask.session.id, 'agy', 'Stop', {
        conversationId: convId,
        fullyIdle: true,
        workspacePaths: [h.projDir, path.join(h.stateDir, 'agy-hooks')],
      });
      expect((await h.peer('GET', '/api/peer/peers', recAgy.peerToken)).status).toBe(200);

      // Exited session invalidates WORKBENCH_PEER_TOKEN
      recAgy.emitExit(0);
      expect((await h.peer('GET', '/api/peer/peers', recAgy.peerToken)).status).toBe(401);

      // 3. 4-Hop loop breaker (MAX_AUTO_HOPS = 4) using two fresh idle tasks H1 and H2
      const p2 = (await h.api('POST', '/api/projects', { name: 'Hops', path: h.projDir2 })).json;
      const h1 = (await h.api('POST', '/api/tasks', { projectId: p2.id, agent: 'fake', title: 'Hop 1', prompt: 'h1' })).json;
      const h2 = (await h.api('POST', '/api/tasks', { projectId: p2.id, agent: 'fake', title: 'Hop 2', prompt: 'h2' })).json;
      await h.hook(h1.session.id, 'fake', 'Stop', { last_assistant_message: 'h1 ready' });
      await h.hook(h2.session.id, 'fake', 'Stop', { last_assistant_message: 'h2 ready' });
      const recH1 = h.spawnBySession.get(h1.session.id)!;
      const recH2 = h.spawnBySession.get(h2.session.id)!;

      const waitDelivery = async (rec: SpawnRec, prevLen: number, marker: string) => {
        await vi.waitFor(() => {
          const slice = rec.written.slice(prevLen);
          expect(slice.join('')).toContain(marker);
          expect(rec.written.at(-1)).toBe('\r');
        }, { timeout: 6000, interval: 100 });
      };

      let len2 = recH2.written.length;
      const s1 = await h.peer('POST', '/api/peer/send', recH1.peerToken, { body: { target: h2.task.id, note: 'hop-1' } });
      expect(s1.status).toBe(200);
      expect(s1.json.hop).toBe(1);
      await waitDelivery(recH2, len2, 'hop-1');
      await h.hook(h2.session.id, 'fake', 'UserPromptSubmit', { prompt: 'hop-1' });

      let len1 = recH1.written.length;
      const s2 = await h.peer('POST', '/api/peer/send', recH2.peerToken, { body: { target: h1.task.id, note: 'hop-2' } });
      expect(s2.status).toBe(200);
      expect(s2.json.hop).toBe(2);
      await h.hook(h2.session.id, 'fake', 'Stop', { last_assistant_message: 'done 2' });
      await waitDelivery(recH1, len1, 'hop-2');
      await h.hook(h1.session.id, 'fake', 'UserPromptSubmit', { prompt: 'hop-2' });

      len2 = recH2.written.length;
      const s3 = await h.peer('POST', '/api/peer/send', recH1.peerToken, { body: { target: h2.task.id, note: 'hop-3' } });
      expect(s3.status).toBe(200);
      expect(s3.json.hop).toBe(3);
      await h.hook(h1.session.id, 'fake', 'Stop', { last_assistant_message: 'done 3' });
      await waitDelivery(recH2, len2, 'hop-3');
      await h.hook(h2.session.id, 'fake', 'UserPromptSubmit', { prompt: 'hop-3' });

      len1 = recH1.written.length;
      const s4 = await h.peer('POST', '/api/peer/send', recH2.peerToken, { body: { target: h1.task.id, note: 'hop-4' } });
      expect(s4.status).toBe(200);
      expect(s4.json.hop).toBe(4);
      await h.hook(h2.session.id, 'fake', 'Stop', { last_assistant_message: 'done 4' });
      await waitDelivery(recH1, len1, 'hop-4');
      await h.hook(h1.session.id, 'fake', 'UserPromptSubmit', { prompt: 'hop-4' });

      const s5 = await h.peer('POST', '/api/peer/send', recH1.peerToken, { body: { target: h2.task.id, note: 'hop-5' } });
      expect(s5.status).toBe(429);
    } finally {
      await h.close();
    }
  });

  it('createApp auto-archives stale exited tasks on startup before syncing PEERS.md without TDZ crash', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-tdz-'));
    const stateDir = path.join(rootDir, 'state');
    const projDir = path.join(rootDir, 'proj');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(projDir, { recursive: true });

    const store = createFileStore(path.join(stateDir, 'state.json'));
    const now = Date.now();
    const project = { id: 'p-tdz', name: 'Startup TDZ', path: projDir, createdAt: now - 5 * 86_400_000 };
    store.addProject(project);
    store.addTask({
      id: 't-stale-approved',
      projectId: project.id,
      title: 'Stale Approved Task',
      titleAuto: false,
      prompt: '',
      color: '#5fa4d6',
      agent: 'fake',
      sessionId: null,
      createdAt: now - 4 * 86_400_000,
      phase: 'approved',
      phaseSince: now - 3 * 86_400_000,
      lastActiveAt: now - 3 * 86_400_000,
    });
    store.addTask({
      id: 't-fresh-active',
      projectId: project.id,
      title: 'Fresh Active Task',
      titleAuto: false,
      prompt: '',
      color: '#7ab88c',
      agent: 'fake',
      sessionId: null,
      createdAt: now - 60_000,
      phase: 'active',
      phaseSince: now - 60_000,
      lastActiveAt: now - 60_000,
    });

    const freePort = await getFreePort();
    const sessions = new SessionManager({ port: freePort, token: 'tok', stateDir });
    const usage = createUsage({ stateDir, source: store });
    const app = createApp({ port: freePort, token: 'tok', store, sessions, stateDir, usage });
    try {
      expect(store.getTask('t-stale-approved')?.phase).toBe('archived');
      expect(store.getTask('t-fresh-active')?.phase).toBe('active');
      const peersMd = fs.readFileSync(path.join(stateDir, 'collab', project.id, 'PEERS.md'), 'utf8');
      expect(peersMd).toContain('Fresh Active Task');
      expect(peersMd).not.toContain('Stale Approved Task');
    } finally {
      await sessions.killAll();
      await new Promise<void>(resolve => (app.server.listening ? app.server.close(() => resolve()) : resolve()));
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
