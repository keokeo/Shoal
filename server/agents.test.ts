import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildGenerator, buildLaunch, claudeResumeId, FULL_ACCESS, NOTIFY } from './agents.ts';
import { pickColor } from './store.ts';
import { TASK_COLORS } from '../shared/protocol.ts';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-test-'));
const build = (agent: 'claude' | 'codex' | 'agy' | 'fake', prompt: string, sessionId = 'sid') =>
  buildLaunch({ agent, sessionId, prompt, stateDir });

describe('buildLaunch', () => {
  it('codex hook args are byte-identical to the M0 probe format and never bypass trust', () => {
    const { args } = build('codex', 'do it');
    const hookToml = (ev: string) => `hooks.${ev}=[{hooks=[{type="command",command='node "${NOTIFY}" codex ${ev}',timeout=5}]}]`;
    expect(args.slice(1)).toEqual([
      '-c', hookToml('SessionStart'),
      '-c', hookToml('UserPromptSubmit'),
      '-c', hookToml('Stop'),
      '-c', hookToml('PermissionRequest'),
      '-c', 'check_for_update_on_startup=false',
      '--dangerously-bypass-approvals-and-sandbox',
      'do it',
    ]);
    expect(args.join(' ')).not.toContain('--dangerously-bypass-hook-trust');
  });

  it('claude puts the prompt last and knows its native session id', () => {
    const l = build('claude', 'hello');
    expect(l.args.at(-1)).toBe('hello');
    expect(l.args[0]).toBe('--session-id');
    expect(l.args[1]).toBe(l.nativeSessionId);
    expect(build('claude', '').args.slice(-2)).toEqual([expect.stringMatching(/claude-hooks\.json$/), '--dangerously-skip-permissions']);
  });

  it('resume uses each CLI\'s M0-verified command, keeps the native id and the codex hook flags', () => {
    const resume = (agent: 'claude' | 'codex' | 'agy' | 'fake') => buildLaunch({ agent, sessionId: 's', prompt: 'ignored', stateDir, resume: 'n-1' });
    const c = resume('claude');
    expect(c.args.slice(0, 2)).toEqual(['--resume', 'n-1']);
    expect(c.nativeSessionId).toBe('n-1');
    const x = resume('codex');
    expect(x.args.slice(1, 3)).toEqual(['resume', 'n-1']);
    expect(x.args.slice(3)).toEqual(build('codex', '').args.slice(1)); // trust hashes still match
    expect(resume('agy').args.slice(0, 2)).toEqual(['--conversation', 'n-1']);
    for (const a of ['claude', 'codex', 'agy', 'fake'] as const) {
      expect(resume(a).args).not.toContain('ignored');
      expect(resume(a).nativeSessionId).toBe('n-1');
    }
  });

  it('every real CLI starts with full permissions, new and resumed', () => {
    expect(FULL_ACCESS).toEqual({
      claude: '--dangerously-skip-permissions',
      codex: '--dangerously-bypass-approvals-and-sandbox',
      agy: '--dangerously-skip-permissions',
    });
    for (const a of ['claude', 'codex', 'agy'] as const) {
      expect(build(a, 'x').args).toContain(FULL_ACCESS[a]);
      expect(build(a, '').args).toContain(FULL_ACCESS[a]);
      expect(buildLaunch({ agent: a, sessionId: 's', prompt: '', stateDir, resume: 'n-1' }).args).toContain(FULL_ACCESS[a]);
    }
    expect(build('fake', 'x').args.join(' ')).not.toContain('--dangerously');
  });

  it('agy uses -i for the prompt', () => {
    expect(build('agy', 'hi').args.slice(-2)).toEqual(['-i', 'hi']);
    expect(build('agy', '').args).not.toContain('-i');
  });

  it('long prompts go to a file; leading dash gets a space', () => {
    const l = build('fake', 'x'.repeat(8001), 'long-1');
    const file = path.join(stateDir, 'prompts', 'long-1.md');
    expect(fs.readFileSync(file, 'utf8')).toHaveLength(8001);
    expect(l.args.at(-1)).toContain(file);
    expect(build('fake', '-rf').args.at(-1)).toBe(' -rf');
  });
});

describe('agy hook file', () => {
  it('commands contain no quotes', async () => {
    const { writeHookFiles } = await import('./agents.ts');
    writeHookFiles(stateDir);
    const file = path.join(stateDir, 'agy-hooks', '.agents', 'hooks.json');
    if (!fs.existsSync(file)) return; // repo path contains a space: agy disabled
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    const cmds = Object.values(cfg.workbench).flatMap(v => (v as { command: string }[]).map(h => h.command));
    expect(cmds).toHaveLength(4);
    for (const c of cmds) expect(c).not.toMatch(/["']/);
  });
});

describe('pickColor', () => {
  it('picks the least used color, ties to the first', () => {
    expect(pickColor([])).toBe(TASK_COLORS[0]);
    expect(pickColor([{ color: TASK_COLORS[0] }])).toBe(TASK_COLORS[1]);
    const all = TASK_COLORS.map(color => ({ color }));
    expect(pickColor([...all, { color: TASK_COLORS[0] }, { color: TASK_COLORS[1] }])).toBe(TASK_COLORS[2]);
    expect(pickColor([...all.slice(0, 8)])).toBe(TASK_COLORS[8]);
  });
});

describe('buildGenerator', () => {
  const gen = (agent: 'claude' | 'codex' | 'agy' | 'fake', prompt = 'PROMPT') => buildGenerator(agent, prompt, 'OUT.md');

  it('claude: headless haiku without tools or session, prompt on stdin, no --bare', () => {
    const g = gen('claude');
    expect(g.args).toEqual(['-p', '--model', 'haiku', '--tools', '', '--no-session-persistence']);
    expect(g.args).not.toContain('--bare');
    expect(g.stdin).toBe('PROMPT');
    expect(g.outFile).toBeNull();
  });

  it('codex: ephemeral read-only exec, no -m, result in the output file, prompt on stdin', () => {
    const g = gen('codex');
    expect(g.args).not.toContain('-m');
    expect(g.args.slice(-3)).toEqual(['-o', 'OUT.md', '-']);
    expect(g.args).toContain('--ephemeral');
    expect(g.stdin).toBe('PROMPT');
    expect(g.outFile).toBe('OUT.md');
  });

  it('agy: prompt after -p (space-guarded when it starts with a dash), nothing on stdin', () => {
    expect(gen('agy').args.slice(0, 2)).toEqual(['-p', 'PROMPT']);
    expect(gen('agy', '-x').args[1]).toBe(' -x');
    expect(gen('agy').stdin).toBeNull();
  });

  it('fake: runs the fake generator script with the prompt on stdin', () => {
    const g = gen('fake');
    expect(g.args[0]).toMatch(/fake-handoff\.mjs$/);
    expect(g.stdin).toBe('PROMPT');
  });
});

describe('claudeResumeId', () => {
  const OLD = '11111111-1111-4111-8111-111111111111';
  const LIVE = '22222222-2222-4222-8222-222222222222';
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-claude-cfg-'));
  const slug = path.join(cfg, 'projects', 'G--proj');
  fs.mkdirSync(slug, { recursive: true });
  const livePath = path.join(slug, `${LIVE}.jsonl`);
  fs.writeFileSync(livePath, '{}\n');

  const withConfig = <T>(fn: () => T): T => {
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = cfg;
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  };

  it('keeps the recorded id when its conversation exists', () => {
    expect(withConfig(() => claudeResumeId(LIVE, undefined))).toBe(LIVE);
  });

  it('falls back to the transcript uuid when the recorded id has no conversation', () => {
    expect(withConfig(() => claudeResumeId(OLD, livePath))).toBe(LIVE);
    expect(withConfig(() => claudeResumeId(null, livePath))).toBe(LIVE);
  });

  it('accepts a \\\\?\\ prefixed transcript path', () => {
    expect(withConfig(() => claudeResumeId(OLD, `\\\\?\\${livePath}`))).toBe(LIVE);
  });

  it('is undefined when neither exists, or the transcript name is not a uuid', () => {
    expect(withConfig(() => claudeResumeId(OLD, undefined))).toBeUndefined();
    expect(withConfig(() => claudeResumeId(OLD, path.join(slug, `${OLD}.jsonl`)))).toBeUndefined();
    const odd = path.join(slug, 'notes.jsonl');
    fs.writeFileSync(odd, '');
    expect(withConfig(() => claudeResumeId(OLD, odd))).toBeUndefined();
  });
});
