import { describe, expect, it } from 'vitest';
import { CODEX_NEWLINE, deliverable, modePrefix, nativeIdUpdate, pasteFrame, sanitizePaste, trackModes } from './sessions.ts';
import type { DeliveryState } from './sessions.ts';

describe('nativeIdUpdate', () => {
  it('takes the first id from any event', () => {
    expect(nativeIdUpdate(null, 'UserPromptSubmit', 'a', undefined)).toEqual({ id: 'a' });
    expect(nativeIdUpdate(null, 'SessionStart', 'a', 'startup')).toEqual({ id: 'a' });
  });

  it('SessionStart source resume switches the id and makes it resumable', () => {
    expect(nativeIdUpdate('a', 'SessionStart', 'b', 'resume')).toEqual({ id: 'b', resumable: true });
  });

  it('SessionStart from clear/startup/compact switches the id but waits for a prompt', () => {
    expect(nativeIdUpdate('a', 'SessionStart', 'b', 'clear')).toEqual({ id: 'b', resumable: false });
    expect(nativeIdUpdate('a', 'SessionStart', 'b', undefined)).toEqual({ id: 'b', resumable: false });
  });

  it('ignores the same id, empty ids and non-SessionStart events with another id', () => {
    expect(nativeIdUpdate('a', 'SessionStart', 'a', 'resume')).toBeUndefined();
    expect(nativeIdUpdate('a', 'SessionStart', '', 'resume')).toBeUndefined();
    expect(nativeIdUpdate('a', 'SessionStart', 42, 'resume')).toBeUndefined();
    expect(nativeIdUpdate('a', 'UserPromptSubmit', 'b', undefined)).toBeUndefined();
    expect(nativeIdUpdate('a', 'Stop', 'b', 'resume')).toBeUndefined();
  });
});

describe('pasteFrame', () => {
  it('bracketed: wraps the text, newlines become \\n and never \\r (a \\r submits in Codex)', () => {
    expect(pasteFrame('a\nb\r\nc\rd', true)).toBe('\x1b[200~a\nb\nc\nd\x1b[201~');
  });

  it('codex: every newline becomes the Ctrl+J key record', () => {
    expect(pasteFrame('一\r\n二\n三', true, CODEX_NEWLINE)).toBe(`\x1b[200~一${CODEX_NEWLINE}二${CODEX_NEWLINE}三\x1b[201~`);
  });

  it('plain: collapses newlines into single spaces', () => {
    expect(pasteFrame('a\n\nb\r\nc', false)).toBe('a b c');
  });

  it('strips paste markers and control characters but keeps tabs and newlines', () => {
    const evil = 'x\x1b[201~rm -rf\x1b[200~\x03\x07\x1b[31my\ttab\nz\x7f';
    expect(sanitizePaste(evil)).toBe('xrm -rf[31my\ttab\nz');
    expect(pasteFrame(evil, true)).not.toContain('\x1b[201~rm');
    expect(pasteFrame(evil, true).match(/\x1b/g)).toHaveLength(2);
  });
});

describe('deliverable', () => {
  const base: DeliveryState = { status: 'needs_you', statusSince: 0, permBlocked: false, lastInputAt: 0, lastDeliveryAt: 0 };
  const now = 100_000;

  it('is true for an idle session with no recent typing or delivery', () => {
    expect(deliverable(base, now)).toBe(true);
  });

  it.each([
    ['working', { status: 'working' }],
    ['starting', { status: 'starting' }],
    ['exited', { status: 'exited' }],
    ['turn ended 1.4 s ago (Codex is still settling)', { statusSince: now - 1400 }],
    ['permission prompt open', { permBlocked: true }],
    ['typed 4.9 s ago', { lastInputAt: now - 4900 }],
    ['delivered 1.9 s ago', { lastDeliveryAt: now - 1900 }],
  ] as [string, Partial<DeliveryState>][])('is false: %s', (_n, patch) => {
    expect(deliverable({ ...base, ...patch }, now)).toBe(false);
  });

  it('becomes true exactly at the 5 s / 2 s / 1.5 s boundaries', () => {
    expect(deliverable({ ...base, lastInputAt: now - 5000, lastDeliveryAt: now - 2000, statusSince: now - 1500 }, now)).toBe(true);
  });
});

describe('trackModes / modePrefix', () => {
  it('keeps the last state of replay-relevant modes, across combined and repeated sequences', () => {
    const modes = new Map<number, boolean>();
    trackModes(modes, '\x1b[?2004h\x1b[?25l\x1b[?1049h\x1b[?1000;1006h\x1b[?1003h');
    trackModes(modes, 'text\x1b[?1003l\x1b[?25h');
    expect(modePrefix(modes)).toBe('\x1b[?2004h\x1b[?1049h\x1b[?1000h\x1b[?1006h');
    trackModes(modes, '\x1b[?1049l\x1b[?1000;1006l');
    expect(modePrefix(modes)).toBe('\x1b[?2004h');
  });
});
