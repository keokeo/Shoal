import { test, expect, type Page } from '@playwright/test';
import { createFakeTask, createProject, pane, row, termText, token } from './helpers.ts';

// `tui` makes the fake agent behave like Claude Code: real cursor hidden, painted cursor after `TUI> ` (column 5),
// and a status line repainted every 50 ms that leaves the hidden cursor at the right end of the input row.
async function openTui(page: Page, request: Parameters<typeof createProject>[0]) {
  const project = await createProject(request, token('ime'));
  const { task, session } = await createFakeTask(request, project.id, token('ime'));
  await page.goto('/');
  await row(page, session.id).click();
  const input = pane(page, 0).locator('.xterm-helper-textarea');
  await input.waitFor({ state: 'attached' });
  await page.waitForTimeout(500);
  await page.keyboard.type('tui\r');
  await expect.poll(() => termText(page, session.id)).toMatch(/status \d+/);
  return { taskId: task.id, sessionId: session.id };
}

// Viewport row of the `TUI> ` line and the screen's cell geometry.
async function painted(page: Page, sessionId: string) {
  const lines = (await termText(page, sessionId)).split('\n');
  const { rows } = await page.evaluate((id) => (window as any).__wbTermSize(id), sessionId);
  const r = lines.findLastIndex((l) => l.startsWith('TUI> ')) - (lines.length - rows);
  const screen = await pane(page, 0).locator('.xterm-screen').evaluate((el) => {
    const b = el.getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height };
  });
  const { cols } = await page.evaluate((id) => (window as any).__wbTermSize(id), sessionId);
  return { row: r, cellW: screen.w / cols, cellH: screen.h / rows, screen };
}

const rects = (page: Page) => pane(page, 0).evaluate((p) => {
  const box = (sel: string) => {
    const b = p.querySelector(sel)!.getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width };
  };
  let scrolled = 0;
  for (const el of p.querySelectorAll('*')) scrolled += el.scrollLeft;
  return { view: box('.composition-view'), ta: box('.xterm-helper-textarea'), screen: box('.xterm-screen'), scrolled };
});

test.describe('IME composition with a hidden-cursor TUI', () => {
  test('composition stays on the painted cursor while the CLI keeps repainting', async ({ page, request }) => {
    const { taskId, sessionId } = await openTui(page, request);
    const g = await painted(page, sessionId);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: "ce'sh", selectionStart: 5, selectionEnd: 5 });
    await expect(pane(page, 0).locator('.composition-view')).toHaveClass(/active/);

    // ~20 repaints of the status line during one composition.
    const samples = [];
    for (let i = 0; i < 20; i++) {
      samples.push(await rects(page));
      await page.waitForTimeout(50);
    }
    const want = { x: g.screen.x + 5 * g.cellW, y: g.screen.y + g.row * g.cellH };
    for (const s of samples) {
      expect(Math.abs(s.view.x - want.x)).toBeLessThan(1);
      expect(Math.abs(s.view.y - want.y)).toBeLessThan(1);
      expect(Math.abs(s.ta.x - want.x)).toBeLessThan(1);
      expect(Math.abs(s.ta.y - want.y)).toBeLessThan(1);
      expect(s.screen.x).toBeCloseTo(g.screen.x, 1);
      expect(s.scrolled).toBe(0);
    }

    await cdp.send('Input.insertText', { text: '测试' });
    await expect.poll(() => termText(page, sessionId)).toContain('测试');
    await request.delete(`/api/tasks/${taskId}`);
  });

  test('a composition wider than the space left stays inside the screen without scrolling it', async ({ page, request }) => {
    const { taskId, sessionId } = await openTui(page, request);
    const g = await painted(page, sessionId);
    const cdp = await page.context().newCDPSession(page);
    // Move the painted cursor near the right edge, then compose a long string there.
    const { cols } = await page.evaluate((id) => (window as any).__wbTermSize(id), sessionId);
    await page.keyboard.type('x'.repeat(cols - 30));
    await page.waitForTimeout(300);
    const long = 'zhe shi yi duan hen chang de pin yin';
    await cdp.send('Input.imeSetComposition', { text: long, selectionStart: long.length, selectionEnd: long.length });
    await expect(pane(page, 0).locator('.composition-view')).toHaveClass(/active/);
    for (let i = 0; i < 10; i++) {
      const s = await rects(page);
      expect(s.scrolled).toBe(0);
      expect(s.screen.x).toBeCloseTo(g.screen.x, 1);
      expect(s.view.x + s.view.w).toBeLessThanOrEqual(g.screen.x + g.screen.w + 1);
      expect(s.view.x).toBeGreaterThan(g.screen.x + g.screen.w / 2);
      await page.waitForTimeout(50);
    }
    await cdp.send('Input.insertText', { text: '' });
    await request.delete(`/api/tasks/${taskId}`);
  });
});
