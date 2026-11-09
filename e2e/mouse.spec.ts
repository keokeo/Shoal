import { test, expect } from '@playwright/test';
import { createFakeTask, createProject, pane, row, termText, token } from './helpers.ts';

// Claude Code's fullscreen mode turns on the alternate screen and mouse reporting; its menus take clicks.
test('a CLI with mouse reporting gets clicks, also after a reload whose replay was trimmed past the mode switch', async ({ page, request }) => {
  test.setTimeout(90_000);
  const project = await createProject(request, token('mouse'));
  const { task, session } = await createFakeTask(request, project.id, token('mouse'));
  const sent: string[] = [];
  page.on('websocket', (ws) => ws.on('framesent', (f) => {
    const m = JSON.parse(String(f.payload));
    if (m.t === 'in' && m.id === session.id) sent.push(m.d);
  }));
  await page.goto('/');
  await row(page, session.id).click();
  const term = pane(page, 0).locator('.xterm');
  await pane(page, 0).locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('fullscreen\r');
  await expect(term).toHaveClass(/enable-mouse-events/);

  const click = async () => {
    const box = (await pane(page, 0).locator('.xterm-screen').boundingBox())!;
    sent.length = 0;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(() => sent.join('')).toMatch(/\x1b\[<0;\d+;\d+M\x1b\[<0;\d+;\d+m/);
  };
  await click();

  // More output than the server keeps for replay, so the replay no longer contains the mode switch.
  await page.keyboard.type('flood 1400\r');
  await expect.poll(() => termText(page, session.id), { timeout: 60_000 }).toContain('flooded');
  await page.reload();
  await row(page, session.id).click();
  await expect.poll(() => termText(page, session.id), { timeout: 30_000 }).toContain('flooded');
  expect(await termText(page, session.id)).not.toContain('FULLSCREEN');
  await expect(term).toHaveClass(/enable-mouse-events/);
  await click();
  // Still the alternate screen: nothing goes to scrollback.
  expect(await page.evaluate((id) => (window as any).__wbTermText(id).split('\n').length, session.id))
    .toBe((await page.evaluate((id) => (window as any).__wbTermSize(id), session.id)).rows);
  await request.delete(`/api/tasks/${task.id}`);
});
