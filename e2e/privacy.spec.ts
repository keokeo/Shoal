// Privacy mode: names, titles and paths blur for screen sharing; the toggle is remembered.
//
// Known failure modes -> expected behaviour (pass criterion):
// 1. A private element is missed (sidebar, pane header, stats rows) -> computed filter contains blur when on, none when off.
// 2. Native tooltips still leak names / paths -> no title attribute with the project name or path while on.
// 3. The state is lost on reload -> still on after reload, button aria-pressed=true.
// 4. Renaming while on is impossible to do blind -> the rename input is clear, and the saved title is blurred again.
// 5. Stats groups that hold no secrets get blurred too -> by agent the row names stay clear.
import { test, expect, type Locator, type Page } from '@playwright/test';
import type { UsageReport, UsageRow } from '../shared/protocol.ts';
import { createFakeTask, createProject, pane, removeAllTasks, row, token } from './helpers.ts';

const filterOf = (l: Locator) => l.evaluate((el) => getComputedStyle(el).filter);
const expectBlur = async (l: Locator) => expect.poll(() => filterOf(l)).toContain('blur');
const expectClear = async (l: Locator) => expect.poll(() => filterOf(l)).toBe('none');

const counts = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 1 };
const usageRow = (key: string, label: string, extra: Partial<UsageRow> = {}): UsageRow => ({ key, label, ...counts, ...extra });

test.describe.configure({ mode: 'serial' });
test.beforeEach(async ({ request }) => removeAllTasks(request));

async function mockUsage(page: Page, projectName: string, taskTitle: string) {
  const report: UsageReport = {
    from: null, to: null, since: null, scannedAt: Date.now(), total: counts,
    byVendor: [], byModel: [],
    byAgent: [usageRow('claude', 'Claude Code')],
    byTask: [usageRow('t1', taskTitle, { project: projectName })],
    byProject: [usageRow('p1', projectName)],
    hours: [],
  };
  await page.route('**/api/usage*', (route) => route.fulfill({ json: report }));
}

test('toggle blurs sidebar, pane header and stats, hides leaking tooltips, survives reload', async ({ page, request }) => {
  const project = await createProject(request, token('priv'));
  const title = token('秘密任务');
  const { task, session } = await createFakeTask(request, project.id, title);
  await mockUsage(page, project.name, title);
  await page.goto('/');
  await row(page, session.id).click();
  const group = page.locator('.group-name').filter({ hasText: project.name });
  const groupEl = page.getByTestId('project-group').filter({ has: group });
  const rowTitle = row(page, session.id).locator('.task-title');
  const paneProject = pane(page, 0).getByTestId('pane-project');
  const paneTitle = pane(page, 0).getByTestId('pane-title');
  const toggle = page.getByTestId('privacy-toggle');
  const privateEls = [group, rowTitle, paneProject, paneTitle];

  // Off by default: nothing is blurred, tooltips are present.
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  for (const l of privateEls) await expectClear(l);
  await expect(groupEl.getByTestId('project-toggle')).toHaveAttribute('title', project.path);
  await expect(paneProject).toHaveAttribute('title', project.path);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.app')).toHaveClass(/privacy/);
  for (const l of privateEls) await expectBlur(l);
  // No tooltip carries the project name, the task title or the path.
  await expect(groupEl.getByTestId('project-toggle')).not.toHaveAttribute('title', /.+/);
  await expect(groupEl.getByTestId('project-add-task')).not.toHaveAttribute('title', /.+/);
  await expect(rowTitle).not.toHaveAttribute('title', /.+/);
  await expect(paneTitle).not.toHaveAttribute('title', /.+/);
  await expect(paneProject).not.toHaveAttribute('title', /.+/);
  // Functional titles stay.
  await expect(page.getByTestId('task-rename').first()).toHaveAttribute('title', /改名/);

  // Still on after a reload.
  await page.reload();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expectBlur(group);

  // Stats: tasks and projects are blurred, agents are not.
  await page.getByTestId('tab-stats').click();
  await page.getByTestId('group-byTask').click();
  const labelOf = (name: string) => page.getByTestId('usage-row').locator('.row-label').filter({ hasText: name });
  await expectBlur(labelOf(title));
  await expectBlur(page.getByTestId('usage-row').locator('.row-sub').filter({ hasText: project.name }));
  await expect(labelOf(title)).not.toHaveAttribute('title', /.+/);
  await page.getByTestId('group-byProject').click();
  await expectBlur(labelOf(project.name));
  await page.getByTestId('group-byAgent').click();
  await expectClear(labelOf('Claude'));
  await page.getByTestId('tab-work').click();

  // Off again: everything clears and the tooltips return.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  for (const l of privateEls) await expectClear(l);
  await expect(groupEl.getByTestId('project-toggle')).toHaveAttribute('title', project.path);
  await page.reload();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await request.delete(`/api/tasks/${task.id}`);
});

test('renaming while on: the input is clear, the saved title is blurred again', async ({ page, request }) => {
  const project = await createProject(request, token('priv'));
  const { task, session } = await createFakeTask(request, project.id, token('改名前'));
  await page.goto('/');
  await page.getByTestId('privacy-toggle').click();
  const rowTitle = row(page, session.id).locator('.task-title');
  await expectBlur(rowTitle);

  await rowTitle.dblclick();
  const input = page.getByTestId('title-input');
  await expect(input).toBeFocused();
  await expectClear(input);
  const next = token('改名后');
  await input.fill(next);
  await input.press('Enter');
  await expect(page.getByTestId('title-input')).toHaveCount(0);
  await expect(rowTitle).toHaveText(next);
  await expectBlur(rowTitle);
  await expect(rowTitle).not.toHaveAttribute('title', /.+/);

  // Dialog fields: project name / path inputs blur when not focused, clear when focused.
  await page.getByTestId('new-project-btn').click();
  const name = page.getByTestId('project-name');
  const pathInput = page.getByTestId('project-path');
  await name.fill('abc');
  await pathInput.fill('G:\\secret');
  await expectBlur(name);
  await expectClear(pathInput);
  await request.delete(`/api/tasks/${task.id}`);
});
