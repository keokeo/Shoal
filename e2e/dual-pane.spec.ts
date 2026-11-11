// Dual panes across projects: which project each pane shows, which pane a task is in, drop a task on a pane.
//
// Known failure modes -> expected behaviour (pass criterion):
// 1. Panes of different projects look alike -> each pane header carries its project label (single pane too).
// 2. The sidebar does not say which pane shows a task -> 左 / 右 marks in dual layout, none in single layout.
// 3. Dropping on a pane opens the task in the other pane -> the dropped-on pane changes, the other one does not.
// 4. Dropping the task of the other pane duplicates it -> the two panes swap.
// 5. Unrelated drags (files, text) trigger the pane drop -> only the workbench's own drag type is accepted.
import { test, expect } from '@playwright/test';
import { createFakeTask, createProject, expectStatus, pane, removeAllTasks, row, token } from './helpers.ts';

test.describe.configure({ mode: 'serial' });
test.beforeEach(async ({ request }) => removeAllTasks(request));

test('project labels, 左/右 marks, and drag a task onto a pane', async ({ page, request }) => {
  const pa = await createProject(request, token('projA'));
  const pb = await createProject(request, token('projB'));
  const ta1 = await createFakeTask(request, pa.id, token('A1'), 'hi');
  const a1 = ta1.session;
  const tb1 = await createFakeTask(request, pb.id, token('B1'), 'hi');
  const b1 = tb1.session;
  const tb2 = await createFakeTask(request, pb.id, token('B2'), 'hi');
  const b2 = tb2.session;
  await page.goto('/');
  for (const s of [a1, b1, b2]) await expectStatus(page, s.id, 'needs_you');
  const mark = page.getByTestId('pane-mark');

  // Single pane: label shown, no marks.
  await row(page, a1.id).click();
  await expect(pane(page, 0).getByTestId('pane-project')).toHaveText(pa.name);
  await expect(pane(page, 0).getByTestId('pane-project')).toHaveAttribute('title', pa.path);
  await expect(mark).toHaveCount(0);
  await expect(row(page, a1.id)).not.toHaveAttribute('draggable', 'true');

  // Dual: A on the left, B on the right.
  await page.getByTestId('layout-2').click();
  await pane(page, 1).click();
  await row(page, b1.id).click();
  await expect(pane(page, 0)).toHaveAttribute('data-session-id', a1.id);
  await expect(pane(page, 1)).toHaveAttribute('data-session-id', b1.id);
  await expect(pane(page, 0).getByTestId('pane-project')).toHaveText(pa.name);
  await expect(pane(page, 1).getByTestId('pane-project')).toHaveText(pb.name);
  await expect(mark).toHaveCount(2);
  await expect(row(page, a1.id).getByTestId('pane-mark')).toHaveText('左');
  await expect(row(page, b1.id).getByTestId('pane-mark')).toHaveText('右');
  await expect(row(page, b2.id).getByTestId('pane-mark')).toHaveCount(0);

  // Drag B's other task onto the left pane: left changes, right stays, focus follows.
  await row(page, b2.id).dragTo(pane(page, 0));
  await expect(pane(page, 0)).toHaveAttribute('data-session-id', b2.id);
  await expect(pane(page, 1)).toHaveAttribute('data-session-id', b1.id);
  await expect(pane(page, 0)).toHaveAttribute('data-focused', 'true');
  await expect(pane(page, 0).getByTestId('pane-project')).toHaveText(pb.name);
  await expect(row(page, a1.id).getByTestId('pane-mark')).toHaveCount(0);
  await expect(row(page, b2.id).getByTestId('pane-mark')).toHaveText('左');

  // Drag the task shown on the right onto the left pane: they swap.
  await row(page, b1.id).dragTo(pane(page, 0));
  await expect(pane(page, 0)).toHaveAttribute('data-session-id', b1.id);
  await expect(pane(page, 1)).toHaveAttribute('data-session-id', b2.id);
  await expect(row(page, b1.id).getByTestId('pane-mark')).toHaveText('左');
  await expect(row(page, b2.id).getByTestId('pane-mark')).toHaveText('右');

  // A drag that is not a workbench task (text, no custom type) is ignored by the panes.
  const before = await pane(page, 1).getAttribute('data-session-id');
  const prevented = await pane(page, 1).evaluate((el) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'hello');
    const over = new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true });
    el.dispatchEvent(over);
    el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    return over.defaultPrevented;
  });
  expect(prevented).toBe(false);
  await expect(pane(page, 1)).toHaveAttribute('data-session-id', before!);

  // Back to a single pane: marks disappear.
  await page.getByTestId('layout-1').click();
  await expect(mark).toHaveCount(0);
  for (const t of [ta1, tb1, tb2]) await request.delete(`/api/tasks/${t.task.id}`);
});
