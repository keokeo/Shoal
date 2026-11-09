import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectLimit, readResetsAt } from './quota.ts';

const MSG = "You've hit your session limit · resets 1:20am (Asia/Shanghai)";

describe('detectLimit', () => {
  it('StopFailure rate_limit / billing_error is a quota hit and keeps the message', () => {
    expect(detectLimit('claude', 'StopFailure', { error: 'rate_limit', last_assistant_message: ` ${MSG} ` })).toEqual({ message: MSG, resetsAt: null });
    expect(detectLimit('claude', 'StopFailure', { error: 'billing_error' })).toEqual({ message: 'API 返回 billing_error', resetsAt: null });
  });

  it('other API errors are not a quota hit', () => {
    expect(detectLimit('claude', 'StopFailure', { error: 'overloaded' })).toBeNull();
    expect(detectLimit('claude', 'StopFailure', { error: 'server_error' })).toBeNull();
  });

  it('a Stop whose last message says the limit was hit counts, a normal Stop does not', () => {
    expect(detectLimit('claude', 'Stop', { last_assistant_message: MSG })).toEqual({ message: MSG, resetsAt: null });
    expect(detectLimit('claude', 'Stop', { last_assistant_message: 'done' })).toBeNull();
  });

  it('codex and agy are never detected', () => {
    expect(detectLimit('codex', 'StopFailure', { error: 'rate_limit' })).toBeNull();
    expect(detectLimit('agy', 'Stop', { last_assistant_message: MSG })).toBeNull();
  });
});

describe('readResetsAt', () => {
  const line = '{"type":"assistant","message":{"model":"<synthetic>","content":[{"type":"text","text":"' + MSG + '"}]},"apiError":"usage_limit_reached","error":"rate_limit","isApiErrorMessage":true,"apiErrorStatus":429,"apiErrorParams":{"rate_limit_info":{"status":"rejected","resetsAt":1791652800,"rateLimitType":"five_hour"}}}';

  it('reads resetsAt (seconds) of the last API error line as ms', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-quota-')), 't.jsonl');
    fs.writeFileSync(file, '{"type":"user"}\n' + line + '\n{"type":"system"}\n');
    expect(readResetsAt(file)).toBe(1791652800000);
  });

  it('returns null for a missing file or a transcript without an API error', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-quota-'));
    expect(readResetsAt(path.join(dir, 'nope.jsonl'))).toBeNull();
    fs.writeFileSync(path.join(dir, 'plain.jsonl'), '{"type":"user"}\n');
    expect(readResetsAt(path.join(dir, 'plain.jsonl'))).toBeNull();
  });
});
