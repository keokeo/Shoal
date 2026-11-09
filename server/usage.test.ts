import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUsage } from './usage.ts';
import type { UsageSource } from './usage.ts';
import { usageTotal, vendorOf } from '../shared/protocol.ts';
import type { AgentKind, Project, SessionInfo, Task } from '../shared/protocol.ts';

let dir: string;
let src: { sessions: SessionInfo[]; tasks: Task[]; projects: Project[] };
const source: UsageSource = { sessions: () => src.sessions, tasks: () => src.tasks, projects: () => src.projects };
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-usage-'));
  src = { sessions: [], tasks: [], projects: [{ id: 'p1', name: '项目一', path: dir, createdAt: 0 }] };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const T0 = Date.parse('2026-11-01T10:00:00Z');
const MIN = 60_000;
const iso = (t: number) => new Date(t).toISOString();
const lines = (...v: unknown[]) => v.map(x => JSON.stringify(x) + '\n').join('');
const write = (name: string, text: string) => {
  const f = path.join(dir, name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, text);
  return f;
};
const event = (o: Record<string, unknown>) => write('events.jsonl', lines(o));
const hook = (sessionId: string, agent: AgentKind, at: number, payload: Record<string, unknown>) =>
  event({ kind: 'hook', sessionId, agent, event: 'UserPromptSubmit', at, payload });

function addTask(id: string, title: string, sessionId: string, agent: AgentKind, startedAt: number, status: SessionInfo['status'] = 'working') {
  src.tasks.push({ id, projectId: 'p1', title, titleAuto: false, prompt: '', color: '#fff', agent, sessionId, createdAt: startedAt, phase: 'active', phaseSince: startedAt });
  src.sessions.push({ id: sessionId, taskId: id, agent, nativeSessionId: null, status, statusSince: startedAt, startedAt, exitCode: null, cols: 80, rows: 24 });
}

const claudeLine = (id: string, t: number, u: Record<string, unknown>, model = 'claude-opus-5-5') =>
  ({ type: 'assistant', timestamp: iso(t), requestId: 'r-' + id, message: { id, model, usage: u } });

describe('usage', () => {
  it('counts a claude conversation once per message, including subagent files, and maps the vendor', () => {
    addTask('t1', '修登录', 's1', 'claude', T0);
    const f = write('claude/abc.jsonl', lines(
      claudeLine('m1', T0 + MIN, { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 50, output_tokens_details: { thinking_tokens: 20 } }),
      claudeLine('m1', T0 + MIN, { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 50 }), // same message, next content block
      { type: 'user', timestamp: iso(T0 + 2 * MIN), message: { content: 'hi' } },
      claudeLine('syn', T0 + 2 * MIN, { input_tokens: 0, output_tokens: 0 }, '<synthetic>'),
    ));
    write('claude/abc/subagents/agent-1.jsonl', lines(claudeLine('m2', T0 + 3 * MIN, { input_tokens: 5, output_tokens: 7 }, 'claude-haiku-5-5')));
    hook('s1', 'claude', T0 + 10_000, { transcript_path: f, model: 'claude-opus-5-5' });

    const r = createUsage({ stateDir: dir, source }).report(null, null);
    expect(r.total).toEqual({ input: 15, cacheWrite: 100, cacheRead: 1000, output: 57, reasoning: 20, requests: 2 });
    expect(r.byModel.map(m => [m.label, m.vendor, usageTotal(m)])).toEqual([['claude-opus-5-5', 'Anthropic', 1160], ['claude-haiku-5-5', 'Anthropic', 12]]);
    expect(r.byTask).toMatchObject([{ key: 't1', label: '修登录', project: '项目一', deleted: false, agents: ['claude'] }]);
  });

  it('normalizes codex usage: cached input is split out, token_count duplicates of records are skipped, old files fall back to token_count', () => {
    addTask('t1', '新格式', 's1', 'codex', T0);
    addTask('t2', '旧格式', 's2', 'codex', T0);
    const usage = { input_tokens: 1000, cached_input_tokens: 800, cache_write_input_tokens: 0, output_tokens: 40, reasoning_output_tokens: 30, total_tokens: 1040 };
    const fresh = write('codex/new.jsonl', lines(
      { timestamp: iso(T0 + MIN), type: 'turn_context', payload: { turn_id: 'a', model: 'codeplan/gpt-6.1-sol' } },
      { timestamp: iso(T0 + MIN), type: 'token_usage_record', payload: { response_id: 'resp1', usage } },
      { timestamp: iso(T0 + MIN), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage } } },
    ));
    const old = write('codex/old.jsonl', lines(
      { timestamp: iso(T0 + MIN), type: 'turn_context', payload: { model: 'gpt-5' } },
      { timestamp: iso(T0 + MIN), type: 'event_msg', payload: { type: 'token_count', info: null } },
      { timestamp: iso(T0 + MIN), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: { total_tokens: 1040 } } } },
      { timestamp: iso(T0 + MIN), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: { total_tokens: 1040 } } } },
      { timestamp: iso(T0 + 2 * MIN), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: { total_tokens: 2080 } } } },
    ));
    hook('s1', 'codex', T0 + 10_000, { transcript_path: '\\\\?\\' + fresh, model: 'codeplan/gpt-6.1-sol' });
    hook('s2', 'codex', T0 + 10_000, { transcript_path: old });

    const r = createUsage({ stateDir: dir, source }).report(null, null);
    const byTask = Object.fromEntries(r.byTask.map(t => [t.label, t]));
    expect(byTask['新格式']).toMatchObject({ input: 200, cacheRead: 800, output: 40, reasoning: 30, requests: 1 });
    expect(byTask['旧格式']).toMatchObject({ input: 400, cacheRead: 1600, output: 80, requests: 2 });
    expect(r.byModel.map(m => [m.label, m.vendor])).toEqual([['gpt-5', 'OpenAI'], ['codeplan/gpt-6.1-sol', 'OpenAI']]);
  });

  it('takes the agy model from hooks and keeps cache reads separate from input', () => {
    addTask('t1', 'agy 任务', 's1', 'agy', T0);
    const f = write('agy/transcript_full.jsonl', lines(
      { step_index: 1, type: 'PLANNER_RESPONSE', created_at: iso(T0 + MIN), input_tokens: 300, cache_read_tokens: 2000, output_tokens: 20 },
      { step_index: 2, type: 'USER_INPUT', created_at: iso(T0 + 2 * MIN), content: 'x' },
    ));
    hook('s1', 'agy', T0 + 10_000, { transcriptPath: f, modelName: 'gemini-3.8-flash-high', conversationId: 'c1' });
    const r = createUsage({ stateDir: dir, source }).report(null, null);
    expect(r.total).toMatchObject({ input: 300, cacheRead: 2000, output: 20, requests: 1 });
    expect(r.byVendor.map(v => v.label)).toEqual(['Google']);
  });

  it('reads only what was appended, waits for a line to be complete, and ignores turns outside the workbench run', () => {
    addTask('t1', '续写', 's1', 'claude', T0);
    const f = write('claude/c.jsonl', lines(claudeLine('m1', T0 + MIN, { input_tokens: 1, output_tokens: 1 })));
    hook('s1', 'claude', T0 + 10_000, { transcript_path: f });
    let now = T0 + 5 * MIN;
    const u = createUsage({ stateDir: dir, source, now: () => now });
    u.scan();
    expect(u.report(null, null).total.requests).toBe(1);

    const next = JSON.stringify(claudeLine('m2', T0 + 6 * MIN, { input_tokens: 2, output_tokens: 2 }));
    write('claude/c.jsonl', next.slice(0, 20)); // the CLI is mid-write
    now += 10_000;
    expect(u.report(null, null).total.requests).toBe(1);
    write('claude/c.jsonl', next.slice(20) + '\n');
    now += 10_000;
    expect(u.report(null, null).total).toMatchObject({ input: 3, output: 3, requests: 2 });

    // The session exits; the conversation is later resumed in a plain terminal.
    event({ kind: 'exit', sessionId: 's1', agent: 'claude', exitCode: 0, at: T0 + 7 * MIN });
    src.sessions[0].status = 'exited';
    write('claude/c.jsonl', lines(claudeLine('m3', T0 + 60 * MIN, { input_tokens: 99, output_tokens: 99 })));
    now += 10_000;
    expect(u.report(null, null).total.requests).toBe(2);
  });

  it('keeps totals and the title of a deleted task across restarts, and filters by hour', () => {
    addTask('t1', '已经删掉的任务', 's1', 'claude', T0);
    const f = write('claude/d.jsonl', lines(
      claudeLine('m1', T0 + MIN, { input_tokens: 10, output_tokens: 10 }),
      claudeLine('m2', T0 + 3 * 60 * MIN, { input_tokens: 1, output_tokens: 1 }),
    ));
    hook('s1', 'claude', T0 + 10_000, { transcript_path: f });
    createUsage({ stateDir: dir, source }).scan();
    src = { sessions: [], tasks: [], projects: [] }; // task and project deleted, transcript cleaned up by the CLI
    fs.rmSync(f);

    const u = createUsage({ stateDir: dir, source });
    const all = u.report(null, null);
    expect(all.byTask).toMatchObject([{ label: '已经删掉的任务', project: '项目一', deleted: true, input: 11 }]);
    expect(all.byProject).toMatchObject([{ label: '项目一', deleted: true }]);
    expect(all.since).toBe(T0);
    expect(all.hours.map(h => h.t)).toEqual([T0, T0 + 3 * 60 * MIN]);
    expect(u.report(T0 + 60 * MIN, null).total.input).toBe(1);
    expect(u.report(T0, T0 + 60 * MIN).total.input).toBe(10);
    expect(u.report(T0 + 4 * 60 * MIN, null).total.requests).toBe(0);
  });

  it('attributes sessions known only from events.jsonl to an unknown task', () => {
    const f = write('claude/e.jsonl', lines(claudeLine('m1', T0 + MIN, { input_tokens: 4, output_tokens: 4 })));
    hook('gone', 'claude', T0, { transcript_path: f });
    const r = createUsage({ stateDir: dir, source }).report(null, null);
    expect(r.byTask).toMatchObject([{ key: '', deleted: true, input: 4 }]);
  });

  it('infers the vendor from the model name before the CLI', () => {
    expect(vendorOf('deepseek-v4', 'claude')).toBe('DeepSeek');
    expect(vendorOf('codeplan/gpt-6.1-sol', 'codex')).toBe('OpenAI');
    expect(vendorOf('o4-mini', 'codex')).toBe('OpenAI');
    expect(vendorOf('', 'agy')).toBe('Google');
    expect(vendorOf('my-model', 'claude')).toBe('Anthropic');
  });
});
