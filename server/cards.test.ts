import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capBody, lastReply } from './cards.ts';
import { CARD_MAX } from '../shared/protocol.ts';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cards-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const step = (o: object) => JSON.stringify({ step_index: 1, source: 'MODEL', status: 'DONE', ...o });

describe('lastReply', () => {
  it('reads last_assistant_message for claude, codex and fake', () => {
    for (const a of ['claude', 'codex', 'fake'] as const) expect(lastReply(a, { last_assistant_message: 'done' })).toBe('done');
    expect(lastReply('claude', { last_assistant_message: 5 })).toBeUndefined();
    expect(lastReply('claude', null)).toBeUndefined();
  });

  it('agy: takes the last non-empty PLANNER_RESPONSE, skipping tool-only steps and other types', () => {
    const file = path.join(dir, 't.jsonl');
    fs.writeFileSync(file, [
      step({ type: 'PLANNER_RESPONSE', content: 'first' }),
      step({ type: 'PLANNER_RESPONSE', content: 'PONG', thinking: '...' }),
      step({ type: 'RUN_COMMAND', content: 'ls' }),
      step({ type: 'PLANNER_RESPONSE', content: '' }),
      '',
    ].join('\n'));
    expect(lastReply('agy', { transcriptPath: file })).toBe('PONG');
  });

  it('agy: only reads the last 1 MB and tolerates the cut first line', () => {
    const file = path.join(dir, 'big.jsonl');
    const filler = step({ type: 'OTHER', content: 'x'.repeat(1000) });
    fs.writeFileSync(file, [step({ type: 'PLANNER_RESPONSE', content: 'old' }), ...Array(1500).fill(filler)].join('\n') + '\n');
    expect(lastReply('agy', { transcriptPath: file })).toBeUndefined();
  });

  it('agy: missing file or path gives undefined and a warning, not an exception', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(lastReply('agy', { transcriptPath: path.join(dir, 'nope.jsonl') })).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    expect(lastReply('agy', {})).toBeUndefined();
  });
});

describe('capBody', () => {
  it('keeps short bodies and truncates long ones with a marker', () => {
    expect(capBody('abc')).toBe('abc');
    const out = capBody('a'.repeat(CARD_MAX + 10));
    expect(out.startsWith('a'.repeat(CARD_MAX))).toBe(true);
    expect(out.endsWith('\n…（已截断）')).toBe(true);
  });
});
