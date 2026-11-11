// Sidebar scanning and keyboard: state glyph, swatch only for rows in a pane, 活跃/全部 filter, Alt+K task search, Alt+1/2 pane focus.
//
// Known failure modes -> expected behaviour (pass criterion):
// 1. State only readable from the status text -> every row has a glyph; working / idle differ.
// 2. Every row carries a task color -> only the row shown in a pane has the swatch.
// 3. Stopped tasks pile up -> 活跃 hides them with a count, the choice survives reload, the count button shows them again.
// 4. Search steals or loses focus -> Alt+K opens, typing filters, Enter opens the task in the focused pane, Esc closes.
// 5. Pane focus needs the mouse in dual layout -> Alt+2 / Alt+1 move the focused pane.
import { test, expect, type Page } from '@playwright/test';
import { createFakeTask, createProject, expectStatus, pane, removeAllTasks, row, token } from './helpers.ts';

test.beforeEach(async ({ request }) => removeAllTasks(request));

const glyph = (page: Page, sessionId: string) => row(page, sessionId).getByTestId('row-glyph');

test('row glyph reflects state; the swatch is only on the row shown in a pane', async ({ page, request }) => {
  const project = await createProject(request, token('ux'));
  const busy = await createFakeTask(request, project.id, 'busy', 'sleep 30');
  const calm = await createFakeTask(request, project.id, 'calm', '');
  await page.goto('/');
  await expectStatus(page, busy.session.id, 'working');
  await expectStatus(page, calm.session.id, 'idle');
  await expect(glyph(page, busy.session.id)).toHaveAttribute('data-glyph', 'working');
  await expect(glyph(page, calm.session.id)).toHaveAttribute('data-glyph', 'idle');

  await row(page, calm.session.id).click();
  await expect(pane(page, 0)).toHaveAttribute('data-session-id', calm.session.id);
  await expect(row(page, calm.session.id).getByTestId('task-swatch')).toHaveCount(1);
  await expect(row(page, busy.session.id).getByTestId('task-swatch')).toHaveCount(0);
  // The agent icon is the last thing in the row.
  await expect(row(page, calm.session.id).locator(':scope > *').last().getByTestId('agent-icon')).toHaveCount(1);
});

test('活跃 hides stopped tasks with a count, survives reload, the count button shows all', async ({ page, request }) => {
  const project = await createProject(request, token('flt'));
  const live = await createFakeTask(request, project.id, 'live', '');
  const dead = await createFakeTask(request, project.id, 'dead', 'exit 0');
  await page.goto('/');
  await expectStatus(page, dead.session.id, 'exited');
  await expect(page.getByTestId('filter-all')).toHaveAttribute('aria-checked', 'true');

  await page.getByTestId('filter-active').click();
  await expect(row(page, dead.session.id)).toHaveCount(0);
  await expect(row(page, live.session.id)).toHaveCount(1);
  await expect(page.getByTestId('group-hidden')).toHaveText('另有 1 个已退出');

  await page.reload();
  await expect(page.getByTestId('filter-active')).toHaveAttribute('aria-checked', 'true');
  await expect(row(page, dead.session.id)).toHaveCount(0);

  await page.getByTestId('group-hidden').click();
  await expect(page.getByTestId('filter-all')).toHaveAttribute('aria-checked', 'true');
  await expect(row(page, dead.session.id)).toHaveCount(1);
  await expect(page.getByTestId('group-hidden')).toHaveCount(0);
});

test('Alt+K searches tasks: filter, Enter opens in the focused pane, Esc closes', async ({ page, request }) => {
  const project = await createProject(request, token('srch'));
  const needle = token('needle');
  const target = await createFakeTask(request, project.id, `alpha-${needle}`, '');
  const other = await createFakeTask(request, project.id, 'beta-other', '');
  await page.goto('/');
  await expectStatus(page, target.session.id, 'idle');
  await row(page, other.session.id).click();
  await expect(pane(page, 0)).toHaveAttribute('data-session-id', other.session.id);

  await page.keyboard.press('Alt+KeyK');
  const input = page.getByTestId('task-search-input');
  await expect(input).toBeFocused();
  await expect(page.getByTestId('task-search-item')).toHaveCount(2);
  await input.fill(needle.toUpperCase());
  await expect(page.getByTestId('task-search-item')).toHaveCount(1);
  await expect(page.getByTestId('task-search-item')).toHaveAttribute('data-session-id', target.session.id);
  await page.keyboard.press('Enter');
  await expect(input).toHaveCount(0);
  await expect(pane(page, 0)).toHaveAttribute('data-session-id', target.session.id);

  await page.keyboard.press('Alt+KeyK');
  await expect(input).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(input).toHaveCount(0);

  // The sidebar button opens it too; no match shows no items.
  await page.getByTestId('search-btn').click();
  await input.fill('no-such-task-anywhere');
  await expect(page.getByTestId('task-search-item')).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('Alt+2 / Alt+1 move the focused pane in dual layout', async ({ page, request }) => {
  const project = await createProject(request, token('dual'));
  const a = await createFakeTask(request, project.id, 'left', '');
  await createFakeTask(request, project.id, 'right', '');
  await page.goto('/');
  await expectStatus(page, a.session.id, 'idle');
  await page.getByTestId('layout-2').click();
  await pane(page, 0).click();
  await expect(pane(page, 0)).toHaveAttribute('data-focused', 'true');

  await page.keyboard.press('Alt+Digit2');
  await expect(pane(page, 1)).toHaveAttribute('data-focused', 'true');
  await expect(pane(page, 0)).toHaveAttribute('data-focused', 'false');
  await page.keyboard.press('Alt+Digit1');
  await expect(pane(page, 0)).toHaveAttribute('data-focused', 'true');
});
