import { describe, expect, it } from 'vitest';
import { cleanTitle, titleFromPrompt } from './titles.ts';

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
  it('drops pasted-image placeholders and absolute paths', () => {
    expect(titleFromPrompt('[Image #1] [Image #2] 按截图修一下布局')).toBe('按截图修一下布局');
    expect(titleFromPrompt('C:\\Users\\me\\Desktop\\shot.png\n看看这个报错')).toBe('看看这个报错');
    expect(titleFromPrompt('"C:\\Program Files\\a b.png" 和 /home/me/x.log 对比')).toBe('和 对比');
    expect(titleFromPrompt('改 a/b 和 1/2 的比例')).toBe('改 a/b 和 1/2 的比例');
  });
  it('returns empty when nothing usable', () => {
    expect(titleFromPrompt('')).toBe('');
    expect(titleFromPrompt(' \n\t\n ')).toBe('');
  });
});

describe('cleanTitle', () => {
  it('cleans saved titles that start with placeholders or paths', () => {
    expect(cleanTitle('[Image #1] agy 在使用…')).toBe('agy 在使用…');
    expect(cleanTitle('[Image #1] [Image #2] 修布局')).toBe('修布局');
  });
  it('keeps the title when nothing usable is left, and leaves normal titles alone', () => {
    expect(cleanTitle('[Image #1] [Image #2] [I…')).toBe('[Image #1] [Image #2] [I…');
    expect(cleanTitle('C:\Users\Administrat…')).toBe('C:\Users\Administrat…');
    expect(cleanTitle('改 a/b 的比例')).toBe('改 a/b 的比例');
  });
});
