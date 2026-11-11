import { describe, it, expect } from 'vitest';
import { reduceStatus } from './status.ts';
import type { SessionStatus } from '../shared/protocol.ts';

const hook = (event: string) => ({ type: 'hook' as const, event });

describe('reduceStatus', () => {
  it.each(['UserPromptSubmit', 'PreToolUse', 'PreInvocation'])('%s -> working', ev => {
    expect(reduceStatus('needs_you', hook(ev))).toBe('working');
  });

  it.each(['Stop', 'StopFailure', 'PermissionRequest', 'Notification'])('%s -> needs_you', ev => {
    expect(reduceStatus('working', hook(ev))).toBe('needs_you');
  });

  it('SessionStart makes a starting session idle and is ignored later', () => {
    expect(reduceStatus('starting', hook('SessionStart'))).toBe('idle');
    for (const s of ['idle', 'working', 'needs_you'] as SessionStatus[]) expect(reduceStatus(s, hook('SessionStart'))).toBe(s);
  });

  it('idle: Notification keeps it idle, a turn or a stop moves it on', () => {
    expect(reduceStatus('idle', hook('Notification'))).toBe('idle');
    expect(reduceStatus('idle', hook('UserPromptSubmit'))).toBe('working');
    expect(reduceStatus('idle', hook('PermissionRequest'))).toBe('needs_you');
    expect(reduceStatus('idle', { type: 'quiet' })).toBe('idle');
    expect(reduceStatus('idle', { type: 'input', data: '\x03' })).toBe('idle');
  });

  it.each(['PostInvocation', 'Whatever'])('%s leaves status unchanged', ev => {
    for (const s of ['starting', 'working', 'needs_you'] as SessionStatus[]) expect(reduceStatus(s, hook(ev))).toBe(s);
  });

  it('Ctrl+C only counts while working', () => {
    const ev = { type: 'input' as const, data: 'ab\x03' };
    expect(reduceStatus('working', ev)).toBe('needs_you');
    expect(reduceStatus('starting', ev)).toBe('starting');
    expect(reduceStatus('needs_you', ev)).toBe('needs_you');
    expect(reduceStatus('working', { type: 'input', data: 'hello' })).toBe('working');
  });

  it('quiet only moves starting', () => {
    expect(reduceStatus('starting', { type: 'quiet' })).toBe('needs_you');
    expect(reduceStatus('working', { type: 'quiet' })).toBe('working');
    expect(reduceStatus('needs_you', { type: 'quiet' })).toBe('needs_you');
  });

  it('exit wins everywhere and exited is terminal', () => {
    for (const s of ['starting', 'working', 'needs_you'] as SessionStatus[]) expect(reduceStatus(s, { type: 'exit' })).toBe('exited');
    for (const ev of [hook('UserPromptSubmit'), hook('Stop'), { type: 'quiet' as const }, { type: 'input' as const, data: '\x03' }]) {
      expect(reduceStatus('exited', ev)).toBe('exited');
    }
  });
});
