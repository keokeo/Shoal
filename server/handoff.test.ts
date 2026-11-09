import { describe, it, expect } from 'vitest';
import { fallbackCard, generatorPrompt, handoffPrompt } from './handoff.ts';
import type { HandoffInput } from './handoff.ts';
import type { Card, Task } from '../shared/protocol.ts';

const task: Task = {
  id: 't1', projectId: 'p1', title: '登录页', prompt: '做一个登录页，要支持记住我', titleAuto: false, color: '#fff',
  agent: 'claude', sessionId: 's1', createdAt: 1, phase: 'active', phaseSince: 1,
};
const card = (kind: Card['kind'], body: string): Card => ({ id: kind + body.length, taskId: 't1', sessionId: 's1', kind, body, createdAt: 1 });
const input = (over: Partial<HandoffInput> = {}): HandoffInput => ({
  task, from: 'claude', to: 'codex', cards: [card('result', '已经做好表单')], turns: [{ role: 'user', text: '开始' }, { role: 'assistant', text: '好' }], ...over,
});

describe('handoff', () => {
  it('generatorPrompt stays under 20000 chars with a huge transcript and keeps the task requirement', () => {
    const turns = Array.from({ length: 400 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: 'y'.repeat(3000) }) as const);
    const cards = [card('result', 'r'.repeat(40_000)), ...Array.from({ length: 10 }, () => card('feedback', 'f'.repeat(5000))), card('handoff', 'h'.repeat(9000))];
    const p = generatorPrompt(input({ turns: [...turns], cards, note: 'n'.repeat(9000) }));
    expect(p.length).toBeLessThanOrEqual(20_000);
    expect(p).toContain('做一个登录页，要支持记住我');
    expect(p).toContain('## 验收方法');
  });

  it('fallbackCard says it was not summarised and includes the excerpt section', () => {
    const c = fallbackCard(input());
    expect(c.split('\n')[0]).toBe('（自动整理失败，下面是按记录摘录的原始材料，没有经过总结。）');
    expect(c).toContain('## 对话摘录\n【用户】开始');
    expect(c).toContain('已经做好表单');
    expect(fallbackCard(input({ turns: [] }))).toContain('（没有读到对话记录）');
  });

  it('handoffPrompt carries the card, the note and the transcript path', () => {
    const p = handoffPrompt(task, 'CARD-BODY', { from: 'claude', transcriptPath: 'C:\\x\\t.jsonl', note: '先别动样式', limit: true });
    expect(p).toContain('继续任务「登录页」');
    expect(p).toContain('它的额度用完了');
    expect(p).toContain('## 交接卡片\nCARD-BODY');
    expect(p).toContain('## 用户的补充\n先别动样式');
    expect(p).toContain('C:\\x\\t.jsonl');
    expect(handoffPrompt(task, 'c', { from: 'codex' })).toContain('用户决定换人');
  });
});
