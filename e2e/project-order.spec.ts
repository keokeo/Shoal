// Sidebar project order: drag a project header to reorder; the order is remembered.
//
// Known failure modes -> expected behaviour (pass criterion):
// 1. Drop on the upper half does not put the project before the target -> dragged project moves in front of it.
// 2. The order is lost on reload -> same relative order after reload.
// 3. A project created later lands in the middle -> it is listed after the arranged ones.
// 4. A task row dropped on a project header reorders or breaks something -> the order stays as it was.
// Other specs share the state, so only the relative order of this spec's own projects is asserted.
import { test, expect, type Page } from '@playwright/test';
import { createFakeTask, createProject, removeAllTasks, row, token } from './helpers.ts';

test.beforeEach(async ({ request }) => removeAllTasks(request));

const mine = async (page: Page, names: string[]) =>
  (await page.locator('.group-name').allTextContents()).filter((n) => names.includes(n));
const head = (page: Page, name: string) =>
  page.getByTestId('project-group').filter({ has: page.locator('.group-name', { hasText: name }) }).locator('.group-head');

test('drag a project header to reorder; order survives reload; new projects go last; task drop does nothing', async ({ page, request }) => {
  const [p1, p2, p3] = [await createProject(request, token('ord1')), await createProject(request, token('ord2')), await createProject(request, token('ord3'))];
  const names = [p1.name, p2.name, p3.name];
  const { session } = await createFakeTask(request, p2.id, token('ordtask'));
  await page.goto('/');
  await expect.poll(() => mine(page, names)).toEqual(names);

  // Upper half of the first project's header: the dragged project goes before it.
  await head(page, p3.name).dragTo(head(page, p1.name), { targetPosition: { x: 20, y: 3 } });
  await expect.poll(() => mine(page, names)).toEqual([p3.name, p1.name, p2.name]);

  await page.reload();
  await expect.poll(() => mine(page, names)).toEqual([p3.name, p1.name, p2.name]);

  // Lower half puts it after the target.
  await head(page, p3.name).dragTo(head(page, p1.name), { targetPosition: { x: 20, y: 27 } });
  await expect.poll(() => mine(page, names)).toEqual([p1.name, p3.name, p2.name]);

  // A project created later is listed after the arranged ones.
  const p4 = await createProject(request, token('ord4'));
  const all = [...names, p4.name];
  await expect.poll(() => mine(page, all)).toEqual([p1.name, p3.name, p2.name, p4.name]);

  // Dragging a task row over a project header does not reorder.
  await row(page, session.id).dragTo(head(page, p1.name), { targetPosition: { x: 20, y: 3 } });
  await expect.poll(() => mine(page, all)).toEqual([p1.name, p3.name, p2.name, p4.name]);

  for (const p of [p1, p2, p3, p4]) expect((await request.delete(`/api/projects/${p.id}`)).ok()).toBeTruthy();
});
