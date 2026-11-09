// Removing a project from the workbench.
//
// Known failure modes -> expected behaviour (pass criterion):
// 1. Cancelling the confirm still removes something -> nothing changes (state, sessions, DOM).
// 2. Confirm text miscounts (archived tasks left out, exited sessions counted as running) -> it says 2 个任务 / 1 个正在运行.
// 3. Some of the project's tasks / sessions / cards survive -> state has no trace of the project, its tasks or sessions;
//    the pane that showed its terminal is empty.
// 4. Another project is touched -> its task and session stay and the terminal still takes input.
// 5. The project directory is deleted along with the entry -> both project directories are still on disk.
//    (Token spend of a removed project is checked in usage.spec, the only spec that records usage.)
// 6. Unknown project id -> 404, nothing removed.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { createFakeTask, createProject, expectStatus, fakeLines, pane, removeAllTasks, row, state, termText, token } from './helpers.ts';

const OUT = path.resolve('.tmp/project-remove');
fs.mkdirSync(OUT, { recursive: true });

const group = (page: import('@playwright/test').Page, id: string) => page.locator(`[data-testid="project-group"][data-project-id="${id}"]`);

test.describe('从工作台移除项目', () => {
  test.describe.configure({ mode: 'serial' });
  test.beforeEach(async ({ request }) => removeAllTasks(request));

  test('空项目：悬停出现移除按钮，确认后分组消失，目录还在', async ({ page, request }) => {
    const project = await createProject(request, token('pm-empty'));
    await page.goto('/');
    const g = group(page, project.id);
    await expect(g).toBeVisible();
    const btn = g.getByTestId('project-remove');
    await expect(btn).toHaveCSS('opacity', '0');
    await g.locator('.group-head').hover();
    await expect(btn).toHaveCSS('opacity', '1');
    await expect(btn).toHaveAttribute('title', '从工作台移除项目');
    await page.locator('.sidebar').screenshot({ path: path.join(OUT, 'sidebar-hover.png') });

    let text = '';
    page.once('dialog', (d) => { text = d.message(); void d.accept(); });
    await btn.click();
    await expect(g).toHaveCount(0);
    expect(text).toContain(`从工作台移除项目「${project.name}」？`);
    expect(text).toContain('其中 0 个任务会一起移除。');
    expect(text).not.toContain('正在运行');
    expect((await state(request)).projects.some((p) => p.id === project.id)).toBe(false);
    expect(fs.existsSync(project.path)).toBe(true);
    await page.reload();
    await expect(group(page, project.id)).toHaveCount(0);
  });

  test('在跑任务 + 已归档任务：取消不动，确认后只清掉该项目', async ({ page, request }) => {
    const proj = await createProject(request, token('pm-main'));
    const other = await createProject(request, token('pm-other'));
    const live = await createFakeTask(request, proj.id, '移除-在跑');
    const arch = await createFakeTask(request, proj.id, '移除-归档');
    const keep = await createFakeTask(request, other.id, '保留-别的项目');
    await page.goto('/');

    // Archived task: let its session exit first so only one session counts as running.
    await row(page, arch.session.id).click();
    await expect.poll(() => termText(page, arch.session.id)).toContain('FAKE AGENT');
    await page.keyboard.type('exit 0\r');
    await expectStatus(page, arch.session.id, 'exited');
    expect((await request.post(`/api/tasks/${arch.task.id}/archive`, { data: {} })).ok()).toBeTruthy();

    await row(page, live.session.id).click();
    await expect.poll(() => termText(page, live.session.id)).toContain('FAKE AGENT');
    await expect(pane(page, 0)).toHaveAttribute('data-session-id', live.session.id);

    const g = group(page, proj.id);
    const snapshot = async () => JSON.stringify(await state(request));
    const s0 = await snapshot();

    // Cancel: nothing changes.
    page.once('dialog', (d) => void d.dismiss());
    await g.locator('.group-head').hover();
    await g.getByTestId('project-remove').click();
    await expect(g).toBeVisible();
    expect(await snapshot()).toBe(s0);
    await expect(pane(page, 0)).toHaveAttribute('data-session-id', live.session.id);

    // Confirm.
    let text = '';
    page.once('dialog', (d) => { text = d.message(); void d.accept(); });
    await g.getByTestId('project-remove').click();
    await expect(g).toHaveCount(0);
    expect(text).toContain(`从工作台移除项目「${proj.name}」？`);
    expect(text).toContain('2 个任务');
    expect(text).toContain('1 个正在运行');
    expect(text).toContain('项目目录、对话记录和 Token 统计不会删除');

    const st = await state(request);
    expect(st.projects.map((p) => p.id)).not.toContain(proj.id);
    expect(st.tasks.filter((t) => t.projectId === proj.id)).toHaveLength(0);
    for (const s of [live.session, arch.session]) expect(st.sessions.some((x) => x.id === s.id)).toBe(false);
    expect(st.cards.some((c) => c.taskId === live.task.id || c.taskId === arch.task.id)).toBe(false);
    await expect(pane(page, 0)).not.toHaveAttribute('data-session-id', live.session.id);
    await expect(row(page, live.session.id)).toHaveCount(0);
    await page.screenshot({ path: path.join(OUT, 'after-remove.png') });

    // The other project is untouched and still takes input.
    expect(st.projects.map((p) => p.id)).toContain(other.id);
    expect(st.tasks.some((t) => t.id === keep.task.id)).toBe(true);
    expect(st.sessions.find((x) => x.id === keep.session.id)?.status).not.toBe('exited');
    await row(page, keep.session.id).click();
    await expect.poll(() => termText(page, keep.session.id)).toContain('FAKE AGENT');
    const n = fakeLines(keep.session.id).length;
    await page.keyboard.type('still here\r');
    await expect.poll(() => fakeLines(keep.session.id).length).toBe(n + 1);

    expect(fs.existsSync(proj.path)).toBe(true);
    expect(fs.existsSync(other.path)).toBe(true);
  });

  test('未知项目 id 返回 404', async ({ request }) => {
    const before = (await state(request)).projects.length;
    const res = await request.delete('/api/projects/nope');
    expect(res.status()).toBe(404);
    expect((await res.json()).error).toBe('项目不存在');
    expect((await state(request)).projects.length).toBe(before);
  });
});
