import { test, expect, type Page } from '@playwright/test';
import { createFakeTask, createProject, pane, row, termText, token } from './helpers.ts';

// The real system clipboard is never touched: writeText is replaced before the app loads and records what it was given.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as any;
    w.__copied = [];
    w.__denyCopy = false;
    Object.defineProperty(navigator.clipboard, 'writeText', {
      value: async (text: string) => {
        if (w.__denyCopy) throw new Error('Document is not focused.');
        w.__copied.push(text);
      },
    });
  });
});

const copied = (page: Page) => page.evaluate(() => (window as any).__copied as string[]);

async function openTerminal(page: Page, request: Parameters<typeof createProject>[0]) {
  const project = await createProject(request, token('copy'));
  const { task, session } = await createFakeTask(request, project.id, token('copy'));
  await page.goto('/');
  await row(page, session.id).click();
  const input = pane(page, 0).locator('.xterm-helper-textarea');
  await input.waitFor({ state: 'attached' });
  await page.waitForTimeout(800);
  return { input, id: session.id, taskId: task.id, host: pane(page, 0).locator('.term-host') };
}

// Screen position of the cells of the last terminal line containing `needle`; col 0 is the needle's first character.
async function locate(page: Page, t: Awaited<ReturnType<typeof openTerminal>>, needle: string) {
  await expect.poll(async () => (await termText(page, t.id)).includes(needle)).toBe(true);
  const lines = (await termText(page, t.id)).split('\n');
  const screen = (await t.host.locator('.xterm-screen').boundingBox())!;
  const { cols, rows } = (await page.evaluate((id) => (window as any).__wbTermSize(id), t.id)) as { cols: number; rows: number };
  const line = lines.findLastIndex((l) => l.includes(needle));
  const start = lines[line].indexOf(needle);
  const y = screen.y + (line - (lines.length - rows) + 0.5) * (screen.height / rows);
  return (col: number) => ({ x: screen.x + (start + col + 0.5) * (screen.width / cols), y });
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

test.describe('copy on select', () => {
  test('a drag copies once on release; double and triple click copy the word and the line; a plain click copies nothing', async ({ page, request }) => {
    const t = await openTerminal(page, request);
    await t.input.focus();
    await page.keyboard.type('ALPHA BETA GAMMA');
    const at = await locate(page, t, 'ALPHA BETA GAMMA');

    // xterm includes the cell under the pointer only from its right half on.
    await drag(page, at(-0.3), at(9.4));
    await expect.poll(() => copied(page)).toEqual(['ALPHA BETA']);

    await page.mouse.click(at(12).x, at(12).y);
    await page.waitForTimeout(300);
    expect(await copied(page)).toEqual(['ALPHA BETA']);

    await page.mouse.dblclick(at(12).x, at(12).y);
    await expect.poll(async () => (await copied(page)).at(-1)).toBe('GAMMA');

    await page.mouse.click(at(7).x, at(7).y, { clickCount: 3 });
    await expect.poll(async () => (await copied(page)).at(-1)).toBe('> ALPHA BETA GAMMA');
    await request.delete(`/api/tasks/${t.taskId}`);
  });

  test('a drag released outside the terminal still copies, across lines and links, and a refused clipboard is reported', async ({ page, request }) => {
    const t = await openTerminal(page, request);
    await t.input.focus();
    await page.keyboard.type('link https://copy-test.invalid/x LINKTEXT tail');
    await page.keyboard.press('Enter');
    await page.keyboard.type('NEXTLINE');
    const link = await locate(page, t, 'LINKTEXT tail');
    const next = await locate(page, t, 'NEXTLINE');

    // From the link to the line below, released over the sidebar.
    const sidebar = (await page.locator('.sidebar').boundingBox())!;
    await page.mouse.move(link(0).x, link(0).y);
    await page.mouse.down();
    await page.mouse.move(next(7).x, next(7).y, { steps: 8 });
    await page.mouse.move(sidebar.x + 20, next(7).y, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => (await copied(page)).length).toBe(1);
    // Dragging left over the sidebar clamps the end to the start of the lower line.
    expect((await copied(page))[0]).toMatch(/^LINKTEXT tail\r?\n$/);
    expect(page.context().pages()).toHaveLength(1);

    await page.evaluate(() => { (window as any).__denyCopy = true; });
    await drag(page, next(0), next(3));
    await expect(page.getByTestId('notice')).toContainText('复制失败');
    expect(await copied(page)).toHaveLength(1);
    await request.delete(`/api/tasks/${t.taskId}`);
  });

  // Claude Code's fullscreen mode selects on its own and sends the text as OSC 52.
  test('an OSC 52 copy from the CLI reaches the clipboard; clipboard reads and replayed copies are ignored', async ({ page, request }) => {
    const t = await openTerminal(page, request);
    const copies = async () => (await termText(page, t.id)).split('copied').length - 1;
    await t.input.focus();
    await page.keyboard.type('osc52 选中 的文字');
    await page.keyboard.press('Enter');
    await expect.poll(() => copied(page)).toEqual(['选中 的文字']);

    await page.keyboard.type('osc52?');
    await page.keyboard.press('Enter');
    await expect.poll(copies).toBe(2);
    await page.waitForTimeout(300);
    expect(await copied(page)).toEqual(['选中 的文字']);

    // A reload replays the session's output, earlier copy included.
    await page.reload();
    await row(page, t.id).click();
    await expect.poll(copies).toBe(2);
    await page.waitForTimeout(300);
    expect(await copied(page)).toEqual([]);
    await request.delete(`/api/tasks/${t.taskId}`);
  });
});
