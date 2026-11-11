// M1 acceptance: workbench skeleton driven end-to-end with the fake agent CLI.
//
// Known failure modes -> expected behaviour (pass criterion):
// 1. Input lands in a session other than the one shown in the focused pane
//    -> every typed token appears only in the fake-agent log of the selected session.
// 2. Keys typed right after switching (click or Alt+`) go to the previous session
//    -> a token typed with no delay after the switch lands in the new session, never the old one.
// 3. Two panes: input follows the focused pane only -> data-focused flips, tokens follow.
// 4. Hook events from 6 concurrent sessions get mixed up -> each row reaches its own status and
//    nativeSessionId equals `fake-<its id>`.
// 5. Ctrl+C interrupts a turn but no Stop hook arrives -> status still becomes needs_you.
// 6. Permission prompt / startup with no prompt / process exit -> needs_you / idle (SessionStart, 就绪) / exited.
//    (A CLI that never reports SessionStart still leaves 启动中 via the 4 s quiet fallback: server/status.test.ts.)
// 7. Alt+` order -> oldest needs_you first, wraps; the shortcut is not delivered to the CLI.
// 8. Browser reload -> tasks, statuses and terminal history come back; routing still correct.
// 9. Other local web pages drive the terminals -> foreign-origin WS/API rejected, /hook needs the token.
import { test, expect } from '@playwright/test';
import WebSocket from 'ws';
import http from 'node:http';
import path from 'node:path';
import type { SessionInfo } from '../shared/protocol.ts';
import {
  allFakeEntries, createFakeTask, createProject, expectStatus, fakeLines, pane, removeAllTasks, row, state, termText, token,
} from './helpers.ts';

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ request }) => {
  await removeAllTasks(request);
});

test('smoke: create project and task from the UI, see the reply', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('new-project-btn').click();
  await page.getByTestId('project-name').fill('smoke');
  await page.getByTestId('project-path').fill(path.resolve('.tmp/m1'));
  await page.getByTestId('project-submit').click();

  await page.getByTestId('new-task-btn').click();
  await page.getByTestId('task-title').fill('冒烟任务');
  await page.getByTestId('task-agent').selectOption('fake');
  await page.getByTestId('task-prompt').fill('hello 中文');
  await page.getByTestId('task-submit').click();

  const r = page.locator('[data-testid="task-row"]').filter({ hasText: '冒烟任务' });
  await expect(r).toHaveAttribute('data-status', 'needs_you');
  const sid = (await r.getAttribute('data-session-id'))!;
  await expect(pane(page, 0)).toHaveAttribute('data-session-id', sid);
  await expect(pane(page, 0).getByTestId('pane-header')).toContainText('冒烟任务');
  await expect(pane(page, 0).getByTestId('pane-header')).toContainText('fake');
  await expect.poll(() => termText(page, sid)).toContain('reply: hello 中文');
  expect(fakeLines(sid)).toEqual(['hello 中文']);

  // Bad project path is reported, not swallowed.
  await page.getByTestId('new-project-btn').click();
  await page.getByTestId('project-name').fill('bad');
  await page.getByTestId('project-path').fill('Z:\\does\\not\\exist');
  await page.getByTestId('project-submit').click();
  await expect(page.getByTestId('project-error')).toBeVisible();
});

test('6 concurrent sessions: statuses, colors and input routing under fast switching', async ({ page, request }) => {
  const project = await createProject(request, 'six');
  const sessions: SessionInfo[] = [];
  for (let i = 0; i < 6; i++) {
    const { session } = await createFakeTask(request, project.id, `任务${i}`, `sleep ${1 + (i % 3)}`);
    sessions.push(session);
  }
  await page.goto('/');
  for (const s of sessions) await expectStatus(page, s.id, 'needs_you');

  const snap = await state(request);
  const tasks = snap.tasks.filter(t => t.projectId === project.id);
  expect(new Set(tasks.map(t => t.color)).size).toBe(6);
  for (const s of sessions) {
    expect(snap.sessions.find(x => x.id === s.id)!.nativeSessionId).toBe(`fake-${s.id}`);
  }
  // Each first turn ended with a result, so all six wait in 待验收 rather than 需要你.
  await expect(page.getByTestId('review-count')).toHaveText('6');
  await expect(page.getByTestId('needs-you-count')).toHaveText('0');

  // Switch and type immediately, shuffled order, twice around; plus Chinese input.
  const sent = new Map<string, string[]>();
  const order = [3, 0, 5, 1, 4, 2, 5, 2, 0, 3, 1, 4];
  for (const i of order) {
    const s = sessions[i];
    const msg = token(`s${i}`);
    await expectStatus(page, s.id, 'needs_you'); // previous turn of the same session finished
    await row(page, s.id).click();
    await page.keyboard.type(msg);
    await page.keyboard.insertText('中文');
    await page.keyboard.press('Enter');
    sent.set(s.id, [...(sent.get(s.id) ?? []), `${msg}中文`]);
  }
  await expect.poll(() => allFakeEntries().filter(e => sessions.some(s => s.id === e.sessionId)).length, { timeout: 20_000 })
    .toBe(6 + order.length);
  for (const s of sessions) {
    expect(fakeLines(s.id).slice(1)).toEqual(sent.get(s.id));
  }
  await expect(pane(page, 0)).toHaveAttribute('data-session-id', sessions[4].id);
  await page.screenshot({ path: '.tmp/m1/six-sessions.png' });
});

test('dual panes: input follows the focused pane; picking a shown session focuses its pane instead of moving it', async ({ page, request }) => {
  const project = await createProject(request, 'dual');
  const a = (await createFakeTask(request, project.id, '左边A', 'hi')).session;
  const b = (await createFakeTask(request, project.id, '右边B', 'hi')).session;
  await page.goto('/');
  await expectStatus(page, a.id, 'needs_you');
  await expectStatus(page, b.id, 'needs_you');

  await page.getByTestId('layout-2').click();
  await pane(page, 0).click();
  await row(page, a.id).click();
  await pane(page, 1).click();
  await row(page, b.id).click();
  await expect(pane(page, 0)).toHaveAttribute('data-session-id', a.id);
  await expect(pane(page, 1)).toHaveAttribute('data-session-id', b.id);
  await expect(pane(page, 1)).toHaveAttribute('data-focused', 'true');
  await expect(pane(page, 0)).toHaveAttribute('data-focused', 'false');

  const toB = token('toB');
  await page.keyboard.type(toB);
  await page.keyboard.press('Enter');
  await pane(page, 0).click();
  await expect(pane(page, 0)).toHaveAttribute('data-focused', 'true');
  const toA = token('toA');
  await page.keyboard.type(toA);
  await page.keyboard.press('Enter');
  await expect.poll(() => fakeLines(a.id)).toEqual(['hi', toA]);
  await expect.poll(() => fakeLines(b.id)).toEqual(['hi', toB]);

  // Focused pane 0 shows A; choosing B (already in pane 1) only moves the focus there: nothing swaps, input goes to B.
  await expect(row(page, a.id)).toHaveClass(/pane-focused/);
  await row(page, b.id).click();
  await expect(pane(page, 0)).toHaveAttribute('data-session-id', a.id);
  await expect(pane(page, 1)).toHaveAttribute('data-session-id', b.id);
  await expect(pane(page, 1)).toHaveAttribute('data-focused', 'true');
  await expect(row(page, b.id)).toHaveClass(/pane-focused/);
  await expect(row(page, a.id)).not.toHaveClass(/pane-focused/);
  const toB2 = token('toB2');
  await page.keyboard.type(toB2);
  await page.keyboard.press('Enter');
  await expect.poll(() => fakeLines(b.id)).toEqual(['hi', toB, toB2]);
  expect(fakeLines(a.id)).toEqual(['hi', toA]);
  await page.screenshot({ path: '.tmp/m1/dual-panes.png' });
});

test('status edge cases: Ctrl+C, permission prompt, no prompt, crash exit', async ({ page, request }) => {
  const project = await createProject(request, 'edge');
  const busy = (await createFakeTask(request, project.id, '长任务', 'sleep 30')).session;
  const ask = (await createFakeTask(request, project.id, '要授权', 'ask')).session;
  const idle = (await createFakeTask(request, project.id, '无需求', '')).session;
  const crash = (await createFakeTask(request, project.id, '会崩溃', 'exit 3')).session;
  await page.goto('/');

  await expectStatus(page, busy.id, 'working');
  await row(page, busy.id).click();
  await page.keyboard.press('Control+c');
  await expectStatus(page, busy.id, 'needs_you', 3_000);
  await expect.poll(() => termText(page, busy.id)).toContain('Interrupted');

  await expectStatus(page, ask.id, 'needs_you');
  await expect.poll(() => termText(page, ask.id)).toContain('Allow?');
  await row(page, ask.id).click();
  await page.keyboard.type('y');
  await expect.poll(() => termText(page, ask.id)).toContain('reply: ask');
  await expectStatus(page, ask.id, 'needs_you');

  await expectStatus(page, idle.id, 'idle'); // SessionStart, no prompt: 就绪, not 需要你
  await expectStatus(page, crash.id, 'exited');
  expect((await state(request)).sessions.find(s => s.id === crash.id)!.exitCode).toBe(3);
});

test('Alt+` jumps to the oldest waiting session, wraps, and is not sent to the CLI', async ({ page, request }) => {
  const project = await createProject(request, 'jump');
  const first = (await createFakeTask(request, project.id, '先停', 'hi')).session;
  await page.goto('/');
  await expectStatus(page, first.id, 'needs_you');
  const second = (await createFakeTask(request, project.id, '后停', 'hi')).session;
  await expectStatus(page, second.id, 'needs_you');
  const busy = (await createFakeTask(request, project.id, '还在忙', 'sleep 60')).session;
  await expectStatus(page, busy.id, 'working');

  await row(page, busy.id).click();
  await page.keyboard.press('Alt+Backquote');
  await expect(pane(page, 0)).toHaveAttribute('data-session-id', first.id);
  // Type with no delay after the jump: must land in `first`, never in `busy`.
  const t1 = token('jump');
  await page.keyboard.type(t1);
  await page.keyboard.press('Enter');
  await expect.poll(() => fakeLines(first.id)).toEqual(['hi', t1]);
  expect(fakeLines(busy.id)).toEqual(['sleep 60']);

  // `first` just got a new turn and stops again later, so `second` is now the oldest waiting.
  await expectStatus(page, first.id, 'needs_you');
  await page.keyboard.press('Alt+Backquote');
  await expect(pane(page, 0)).toHaveAttribute('data-session-id', second.id);
  await page.keyboard.press('Alt+Backquote');
  await expect(pane(page, 0)).toHaveAttribute('data-session-id', first.id);
  await page.keyboard.press('Alt+Backquote');
  await expect(pane(page, 0)).toHaveAttribute('data-session-id', second.id);
  for (const id of [first.id, second.id, busy.id]) expect(await termText(page, id)).not.toContain('`');
});

test('reload restores rows, statuses and terminal history', async ({ page, request }) => {
  const project = await createProject(request, 'reload');
  const a = (await createFakeTask(request, project.id, '刷新A', 'before-reload')).session;
  await page.goto('/');
  await expectStatus(page, a.id, 'needs_you');
  await row(page, a.id).click();
  await expect.poll(() => termText(page, a.id)).toContain('reply: before-reload');

  page.on('dialog', d => d.accept()); // beforeunload guard
  await page.reload();
  await expectStatus(page, a.id, 'needs_you');
  await row(page, a.id).click();
  await expect.poll(() => termText(page, a.id)).toContain('reply: before-reload');
  const after = token('after');
  await page.keyboard.type(after);
  await page.keyboard.press('Enter');
  await expect.poll(() => fakeLines(a.id)).toEqual(['before-reload', after]);
});

test('security: foreign origins rejected, hook needs the token', async ({ request, baseURL }) => {
  const project = await createProject(request, 'sec');
  const { session } = await createFakeTask(request, project.id, '安全', '');

  const hook = await request.post('/hook', { data: { sessionId: session.id, agent: 'fake', event: 'Stop', at: Date.now(), payload: {} } });
  expect(hook.status()).toBe(401);
  const wrong = await request.post('/hook', {
    headers: { authorization: 'Bearer nope' },
    data: { sessionId: session.id, agent: 'fake', event: 'Stop', at: Date.now(), payload: {} },
  });
  expect(wrong.status()).toBe(401);

  const api = await request.post('/api/projects', { headers: { origin: 'http://evil.example' }, data: { name: 'x', path: 'C:\\' } });
  expect(api.status()).toBe(403);

  // DNS rebinding: same-origin GET (no Origin header) but a foreign Host.
  const rebound = await new Promise<number>((resolve, reject) => {
    http.get(`${baseURL}/api/state`, { headers: { host: 'evil.example:47811' } }, r => { r.resume(); resolve(r.statusCode!); })
      .on('error', reject);
  });
  expect(rebound).toBe(403);

  const wsUrl = baseURL!.replace('http', 'ws') + '/ws';
  const outcome = (origin: string) => new Promise<string>(resolve => {
    const ws = new WebSocket(wsUrl, { headers: { origin } });
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('error', () => resolve('rejected'));
    ws.on('unexpected-response', () => resolve('rejected'));
  });
  expect(await outcome('http://evil.example')).toBe('rejected');
  expect(await outcome(baseURL!)).toBe('open');
});
