// Short turns per real CLI through the workbench: launch with an initial prompt, hooks drive the status to
// needs_you, the reply renders in the browser terminal and becomes a result card (待验收), typed input reaches
// the CLI, feedback is pasted into the same session (bracketed paste, two lines), and feedback in a new session
// starts the CLI with the multi-line feedbackPrompt as its argument.
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentKind, Card, Snapshot } from '../shared/protocol.ts';

// Already trusted by Claude and agy during M0, so no folder-trust dialog.
const SANDBOX = path.resolve('.tmp/m0/sandbox');
const EVENTS = path.resolve('.tmp/m2/real/state/events.jsonl'); // WORKBENCH_STATE_DIR of playwright.real.config.ts

const termText = (page: Page, id: string) => page.evaluate(i => (window as any).__wbTermText(i) as string, id);
const row = (page: Page, id: string) => page.locator(`[data-testid="task-row"][data-session-id="${id}"]`);
const state = async (request: APIRequestContext): Promise<Snapshot> => (await request.get('/api/state')).json();
const results = async (request: APIRequestContext, taskId: string): Promise<Card[]> =>
  (await state(request)).cards.filter(c => c.taskId === taskId && c.kind === 'result');
// A line of the reply, not the echoed prompt.
const replied = async (page: Page, id: string, word: RegExp, prompt: RegExp) =>
  (await termText(page, id)).split('\n').some(l => word.test(l) && !prompt.test(l));

// Prompts the CLI itself reported receiving (its TUI may redraw the echo away): claude/codex UserPromptSubmit, agy PreInvocation.
const received = (sessionId: string): string[] => fs.readFileSync(EVENTS, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  .filter(e => e.sessionId === sessionId && (e.event === 'UserPromptSubmit' || e.event === 'PreInvocation'))
  .map(e => (e.payload?.prompt ?? e.payload?.lastUserInput ?? '') as string);

// Codex shows "Hooks need review" while the user's own untrusted hooks exist; answer it like the user would.
async function passCodexHookReview(page: Page, id: string, word: RegExp) {
  await expect.poll(async () => /Hooks need review/.test(await termText(page, id)) || word.test(await termText(page, id)), { timeout: 60_000 }).toBe(true);
  if ((await termText(page, id)).includes('Hooks need review')) {
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
  }
}

for (const agent of ['claude', 'codex', 'agy'] as AgentKind[]) {
  test(`real ${agent}: prompt -> 待验收 card -> follow-up -> feedback same / new`, async ({ page, request }) => {
    test.setTimeout(480_000);
    const snap = await state(request);
    test.skip(!snap.agents.includes(agent), `${agent} not installed`);
    const project = snap.projects[0] ?? await (await request.post('/api/projects', { data: { name: 'real', path: SANDBOX } })).json();
    const { task, session } = await (await request.post('/api/tasks', {
      data: { projectId: project.id, title: `真实-${agent}`, agent, prompt: '只回复四个大写字母：PONG。不要使用任何工具。', cols: 120, rows: 30 },
    })).json();

    await page.goto('/');
    await row(page, session.id).click();
    if (agent === 'codex') await passCodexHookReview(page, session.id, /PONG/);

    await expect.poll(() => replied(page, session.id, /PONG/, /只回复/), { timeout: 120_000 }).toBe(true);
    await expect(row(page, session.id)).toHaveAttribute('data-status', 'needs_you', { timeout: 60_000 });
    const info = (await state(request)).sessions.find(s => s.id === session.id)!;
    expect(info.nativeSessionId, 'native session id from hooks').toBeTruthy();

    // The last reply became a result card and the task waits in 待验收.
    await expect.poll(async () => (await results(request, task.id)).at(-1)?.body ?? '', { timeout: 30_000 }).toMatch(/PONG/);
    await expect(row(page, session.id)).toHaveAttribute('data-phase', 'review');

    // Follow-up typed in the browser reaches the CLI and produces a new turn.
    await page.keyboard.insertText('再回复一次：PING');
    await page.keyboard.press('Enter');
    await expect(row(page, session.id)).toHaveAttribute('data-status', 'working', { timeout: 30_000 });
    await expect.poll(() => replied(page, session.id, /PING/, /再回复/), { timeout: 120_000 }).toBe(true);
    await expect(row(page, session.id)).toHaveAttribute('data-status', 'needs_you', { timeout: 60_000 });
    await expect.poll(async () => (await results(request, task.id)).at(-1)?.body ?? '', { timeout: 30_000 }).toMatch(/PING/);

    // Feedback to the same session: pasted as one two-line message once the user has been idle for 5 s.
    let res = await request.post(`/api/tasks/${task.id}/feedback`, {
      data: { mode: 'same', text: '下面两行是同一条消息。\n只回复四个大写字母：TANG。不要使用任何工具。' },
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).session.id).toBe(session.id);
    await expect(row(page, session.id)).toHaveAttribute('data-status', 'working', { timeout: 30_000 });
    await expect.poll(async () => (await results(request, task.id)).at(-1)?.body ?? '', { timeout: 120_000 }).toMatch(/TANG/);
    await expect(row(page, session.id)).toHaveAttribute('data-phase', 'review');
    expect(received(session.id).at(-1)?.replace(/\r\n?/g, '\n')).toBe('下面两行是同一条消息。\n只回复四个大写字母：TANG。不要使用任何工具。');
    await page.screenshot({ path: `.tmp/m2/real/real-${agent}-same.png` });

    // Feedback in a new session: the CLI starts with the multi-line feedbackPrompt as its initial prompt.
    res = await request.post(`/api/tasks/${task.id}/feedback`, {
      data: { mode: 'new', text: '这次只回复四个大写字母：ZING。不要使用任何工具。', cols: 120, rows: 30 },
    });
    expect(res.status()).toBe(200);
    const s2 = (await res.json()).session.id as string;
    expect(s2).not.toBe(session.id);
    await row(page, s2).click();
    if (agent === 'codex') await passCodexHookReview(page, s2, /ZING/);
    await expect.poll(async () => (await results(request, task.id)).at(-1)?.body ?? '', { timeout: 120_000 }).toMatch(/ZING/);
    const first = received(s2)[0] ?? '';
    for (const part of ['继续任务「', '## 任务需求', '## 上一轮的结果', 'TANG', '## 用户的反馈', 'ZING']) expect(first).toContain(part);
    await expect(row(page, s2)).toHaveAttribute('data-phase', 'review');
    await page.screenshot({ path: `.tmp/m2/real/real-${agent}-new.png` });

    await request.delete(`/api/tasks/${task.id}`);
  });
}
