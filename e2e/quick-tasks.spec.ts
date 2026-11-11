// Quick task creation, auto titles, rename and project folding.
//
// Known failure modes -> expected behaviour (pass criterion):
// 1. Quick create lands in the wrong project or still needs the heavy dialog
//    -> "+" on a project + an agent creates the task there, no modal, terminal focused right away.
// 2. Auto title overwrites a name the user chose, or keeps changing
//    -> only the first non-slash prompt of a "新任务 N" task renames it; manual names are never replaced.
// 3. Rename leaks keystrokes into the terminal, or Esc / empty input still saves
//    -> Esc and empty keep the old title; typed text never reaches the CLI; rename persists.
// 4. Rename API accepts bad input -> 400 empty / too long, 404 unknown, 415 non-JSON.
// 5. Folding hides a task that needs you -> folded group shows the waiting count; Alt+` unfolds it;
//    fold state survives reload.
// 6. Alt+N picks the wrong project / agent or leaks into the CLI
//    -> new task in the focused session's project with its last agent; previous CLI gets nothing.
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { titleFromPrompt } from '../server/titles.ts';
import { createFakeTask, createProject, expectStatus, fakeLines, pane, removeAllTasks, row, state, token } from './helpers.ts';

const OUT = path.resolve('.tmp/ui-redesign');
fs.mkdirSync(OUT, { recursive: true });

test.describe.configure({ mode: 'serial' });

let realAgentPosts: string[] = [];
test.beforeEach(async ({ page, request }) => {
  await removeAllTasks(request);
  // Real CLIs are installed on this machine; never let a test launch one.
  realAgentPosts = [];
  await page.route('**/api/tasks', (route) => {
    const req = route.request();
    const agent = req.method() === 'POST' ? (req.postDataJSON() as { agent?: string }).agent : 'fake';
    if (agent !== 'fake') {
      realAgentPosts.push(String(agent));
      return route.abort();
    }
    return route.continue();
  });
  page.on('dialog', (d) => d.accept());
});
test.afterEach(() => expect(realAgentPosts).toEqual([]));

const group = (page: Page, projectId: string) => page.locator(`[data-testid="project-group"][data-project-id="${projectId}"]`);
const rowTitle = (page: Page, sessionId: string) => row(page, sessionId).getByTestId('task-title-text');

async function quickFake(page: Page, projectId: string) {
  const before = new Set((await state(page.request)).tasks.map((t) => t.id));
  await group(page, projectId).getByTestId('project-add-task').click();
  await page.locator('[data-testid="quick-agent"][data-agent="fake"]').click();
  await expect(page.getByTestId('quick-menu')).toHaveCount(0);
  let created;
  await expect.poll(async () => {
    created = (await state(page.request)).tasks.find((t) => !before.has(t.id));
    return created?.sessionId ?? null;
  }).not.toBeNull();
  return created!;
}

async function waitTitle(page: Page, taskId: string, title: string) {
  await expect.poll(async () => (await state(page.request)).tasks.find((t) => t.id === taskId)?.title).toBe(title);
}

test('项目旁 + 快捷新建：不弹窗、标题自动取第一句、可双击改名', async ({ page }) => {
  const project = await createProject(page.request, token('quick'));
  await page.goto('/');

  // Menu closes on Esc and on outside click; arrows move between agents.
  const add = group(page, project.id).getByTestId('project-add-task');
  await add.click();
  await expect(page.getByTestId('quick-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('quick-menu')).toHaveCount(0);
  await add.click();
  await page.mouse.click(1000, 500);
  await expect(page.getByTestId('quick-menu')).toHaveCount(0);
  await add.click();
  const first = page.getByTestId('quick-agent').first();
  await expect(first).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(first).not.toBeFocused();
  await page.screenshot({ path: path.join(OUT, 'quick-menu.png') });
  await page.keyboard.press('Escape');

  const t1 = await quickFake(page, project.id);
  await expect(page.locator('.overlay')).toHaveCount(0);
  expect(t1.projectId).toBe(project.id);
  expect(t1.title).toBe('新任务 1');
  expect(t1.titleAuto).toBe(true);
  const s1 = t1.sessionId!;
  await expectStatus(page, s1, 'idle');
  await expect(pane(page, 0)).toHaveAttribute('data-session-id', s1);
  // The row and the pane header carry the agent's icon.
  await expect(page.locator(`[data-testid="task-row"][data-session-id="${s1}"] [data-testid="agent-icon"]`)).toHaveAttribute('data-agent', 'fake');
  await expect(pane(page, 0).getByTestId('agent-icon')).toHaveAttribute('data-agent', 'fake');

  // Keys go straight to the new terminal; the first prompt becomes the title, later ones don't.
  await page.keyboard.type('修复登录页的跳转问题\r');
  await expect(rowTitle(page, s1)).toHaveText('修复登录页的跳转问题');
  await expect(pane(page, 0).getByTestId('pane-title')).toHaveText('修复登录页的跳转问题');
  await page.keyboard.type('second prompt\r');
  await expect.poll(() => fakeLines(s1)).toEqual(['修复登录页的跳转问题', 'second prompt']);
  await waitTitle(page, t1.id, '修复登录页的跳转问题');

  // Double-click rename in the sidebar: Esc cancels, empty is ignored, Enter saves; nothing reaches the CLI.
  await rowTitle(page, s1).dblclick();
  await page.getByTestId('title-input').fill('不要保存');
  await page.keyboard.press('Escape');
  await expect(rowTitle(page, s1)).toHaveText('修复登录页的跳转问题');
  await rowTitle(page, s1).dblclick();
  await page.getByTestId('title-input').fill('   ');
  await page.keyboard.press('Enter');
  await expect(rowTitle(page, s1)).toHaveText('修复登录页的跳转问题');
  await rowTitle(page, s1).dblclick();
  await page.getByTestId('title-input').fill('登录跳转');
  await page.screenshot({ path: path.join(OUT, 'rename-editing.png') });
  await page.keyboard.press('Enter');
  await expect(rowTitle(page, s1)).toHaveText('登录跳转');
  await waitTitle(page, t1.id, '登录跳转');

  // Rename from the pane header too.
  await pane(page, 0).getByTestId('pane-title').dblclick();
  await page.getByTestId('title-input').fill('在窗格里改名');
  await page.getByTestId('title-input').blur();
  await expect(rowTitle(page, s1)).toHaveText('在窗格里改名');
  await waitTitle(page, t1.id, '在窗格里改名');
  expect(fakeLines(s1)).toEqual(['修复登录页的跳转问题', 'second prompt']);

  // The menu now offers the agent used last in this project first.
  await add.click();
  await expect(page.getByTestId('quick-agent').first()).toHaveAttribute('data-agent', 'fake');
  await expect(page.getByTestId('quick-agent').first()).toContainText('上次用的');
  await page.keyboard.press('Escape');

  // A manual name chosen before the first prompt is kept.
  const t2 = await quickFake(page, project.id);
  expect(t2.title).toBe('新任务 1'); // numbering reuses the first free number
  await rowTitle(page, t2.sessionId!).dblclick();
  await page.getByTestId('title-input').fill('手动名');
  await page.keyboard.press('Enter');
  await waitTitle(page, t2.id, '手动名');
  await row(page, t2.sessionId!).click();
  await page.keyboard.type('hello\r');
  await expect.poll(() => fakeLines(t2.sessionId!)).toEqual(['hello']);
  await waitTitle(page, t2.id, '手动名');

  // Slash commands don't count as the first prompt.
  const t3 = await quickFake(page, project.id);
  expect(t3.title).toBe('新任务 1');
  await page.keyboard.type('/help\r');
  await expect.poll(() => fakeLines(t3.sessionId!)).toEqual(['/help']);
  await waitTitle(page, t3.id, '新任务 1');
  await page.keyboard.type('写一个很长很长的需求描述，用来检查标题截断是否正常工作\r');
  await waitTitle(page, t3.id, titleFromPrompt('写一个很长很长的需求描述，用来检查标题截断是否正常工作'));
  expect([...titleFromPrompt('写一个很长很长的需求描述，用来检查标题截断是否正常工作')].length).toBe(25);

  // The full dialog still works: defaults to the focused project and its last agent, title optional.
  await page.getByTestId('new-task-btn').click();
  await expect(page.getByTestId('task-project')).toHaveValue(project.id);
  await expect(page.getByTestId('task-agent')).toHaveValue('fake');
  await page.getByTestId('task-prompt').fill('从对话框带需求创建\n第二行不进标题');
  await page.screenshot({ path: path.join(OUT, 'task-dialog.png') });
  await page.getByTestId('task-submit').click();
  await expect(page.getByTestId('task-row').filter({ hasText: '从对话框带需求创建' })).toHaveCount(1);
  const fromDialog = (await state(page.request)).tasks.find((t) => t.title === '从对话框带需求创建');
  expect(fromDialog?.titleAuto).toBe(false);
  await page.screenshot({ path: path.join(OUT, 'single.png') });
});

test('改名 API：非法输入被拒，合法改名同步到已打开的页面', async ({ page }) => {
  const project = await createProject(page.request, token('rename'));
  const { task, session } = await createFakeTask(page.request, project.id, '原名');
  await page.goto('/');
  const patch = (id: string, data: unknown) => page.request.patch(`/api/tasks/${id}`, { data });

  expect((await patch(task.id, { title: '' })).status()).toBe(400);
  expect((await patch(task.id, { title: '   ' })).status()).toBe(400);
  expect((await patch(task.id, {})).status()).toBe(400);
  expect((await patch(task.id, { title: '中'.repeat(81) })).status()).toBe(400);
  expect((await patch('no-such-task', { title: 'x' })).status()).toBe(404);
  const text = await page.request.patch(`/api/tasks/${task.id}`, { headers: { 'content-type': 'text/plain' }, data: '{"title":"x"}' });
  expect(text.status()).toBe(415);
  await expect(rowTitle(page, session.id)).toHaveText('原名');

  const ok = await patch(task.id, { title: '中'.repeat(80) });
  expect(ok.status()).toBe(200);
  expect((await ok.json()).titleAuto).toBe(false);
  await expect(rowTitle(page, session.id)).toHaveText('中'.repeat(80));
});

test('折叠项目：等你的任务仍有提示，Alt+` 自动展开；Alt+N 在当前项目用上次的 agent 新建', async ({ page }) => {
  const p1 = await createProject(page.request, token('fold-a'));
  const p2 = await createProject(page.request, token('fold-b'));
  const a = await createFakeTask(page.request, p1.id, 'A 项目任务', 'hi');
  const b = await createFakeTask(page.request, p2.id, 'B 项目任务', 'hi');
  await page.goto('/');
  await expectStatus(page, a.session.id, 'needs_you');
  await expectStatus(page, b.session.id, 'needs_you');

  await group(page, p1.id).getByTestId('project-toggle').click();
  await expect(group(page, p1.id)).toHaveAttribute('data-collapsed', 'true');
  await expect(row(page, a.session.id)).toHaveCount(0);
  // A finished its turn: 待验收 counts as waiting (a fresh 就绪 session would not).
  await expect(group(page, p1.id).getByTestId('group-review')).toHaveText('1 待验收');
  await expect(row(page, b.session.id)).toBeVisible(); // other project untouched
  await page.screenshot({ path: path.join(OUT, 'collapsed.png') });

  await page.reload();
  await expect(group(page, p1.id)).toHaveAttribute('data-collapsed', 'true');
  await expect(row(page, b.session.id)).toBeVisible();

  // Oldest waiting session is A, inside the folded project: jumping there unfolds it.
  await page.keyboard.press('Alt+Backquote');
  await expect(pane(page, 0)).toHaveAttribute('data-session-id', a.session.id);
  await expect(group(page, p1.id)).toHaveAttribute('data-collapsed', 'false');
  await expect(row(page, a.session.id)).toHaveClass(/in-pane/);

  // Alt+N from A's terminal: new fake task in project 1, focused immediately.
  await page.keyboard.press('Alt+KeyN');
  let n1;
  await expect.poll(async () => {
    n1 = (await state(page.request)).tasks.find((t) => t.projectId === p1.id && t.id !== a.task.id);
    return n1?.sessionId ?? null;
  }).not.toBeNull();
  expect(n1!.agent).toBe('fake');
  expect(n1!.title).toBe('新任务 1');
  await expect(pane(page, 0)).toHaveAttribute('data-session-id', n1!.sessionId!);
  await page.keyboard.type('after alt n\r');
  await expect.poll(() => fakeLines(n1!.sessionId!)).toEqual(['after alt n']);
  await waitTitle(page, n1!.id, 'after alt n');

  // The shortcut itself never reached A's CLI.
  await row(page, a.session.id).click();
  await page.keyboard.type('probe\r');
  await expect.poll(() => fakeLines(a.session.id)).toEqual(['hi', 'probe']);

  // Focus a session in project 2 -> Alt+N creates there.
  await layoutDual(page);
  await row(page, b.session.id).click();
  await page.keyboard.press('Alt+KeyN');
  await expect.poll(async () => (await state(page.request)).tasks.filter((t) => t.projectId === p2.id).length).toBe(2);
  await expect(page.locator('[data-testid="pane"][data-focused="true"]')).toHaveCount(1);
  await page.screenshot({ path: path.join(OUT, 'dual.png') });
});

async function layoutDual(page: Page) {
  await page.getByTestId('layout-2').click();
  await expect(page.getByTestId('pane')).toHaveCount(2);
}
