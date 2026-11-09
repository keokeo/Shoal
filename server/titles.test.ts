import { describe, expect, it } from 'vitest';
import { titleFromPrompt } from './titles.ts';

describe('titleFromPrompt', () => {
  it('uses the first non-empty line with whitespace collapsed', () => {
    expect(titleFromPrompt('\n  \n  fix   the\tbug  \nsecond line')).toBe('fix the bug');
  });
  it('keeps exactly 24 code points, truncates 25 with an ellipsis', () => {
    expect(titleFromPrompt('中'.repeat(24))).toBe('中'.repeat(24));
    expect(titleFromPrompt('中'.repeat(25))).toBe('中'.repeat(24) + '…');
  });
  it('counts astral characters as one', () => {
    expect(titleFromPrompt('😀'.repeat(30))).toBe('😀'.repeat(24) + '…');
  });
  it('returns empty when nothing usable', () => {
    expect(titleFromPrompt('')).toBe('');
    expect(titleFromPrompt(' \n\t\n ')).toBe('');
  });
});
