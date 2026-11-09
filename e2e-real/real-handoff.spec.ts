// Switch agent with the real CLIs, claude -> codex -> agy -> claude. Before each switch a new code word is typed into
// the running session, so it exists only in that CLI's own transcript: the handoff card (written by the target CLI's
// headless call) and the new session's reply must both carry it. Covers the three transcript parsers and generators.
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentKind, Card, Snapshot, SwitchResult } from '../shared/protocol.ts';

const SANDBOX = path.resolve('.tmp/m0/sandbox'); // trusted by claude and agy since M0
const OUT = path.resolve('.tmp/m3/real');

const termText = (page: Page, id: string) => page.evaluate(i => (window as any).__wbTermText(i) as string, id);
const row = (page: Page, id: string) => page.locator(`[data-testid="task-row"][data-session-id="${id}"]`);
const state = async (request: APIRequestContext): Promise<Snapshot> => (await request.get('/api/state')).json();
const results = async (request: APIRequestContext, taskId: string): Promise<Card[]> =>
  (await state(request)).cards.filter(c => c.taskId === taskId && c.kind === 'result');
const lastResult = async (request: APIRequestContext, taskId: string) => (await results(request, taskId)).at(-1)?.body ?? '';

// Same as real-smoke: answer Codex's "Hooks need review" like the user would.
async function passCodexHookReview(page: Page, id: string, word: RegExp) {
  await expect.poll(async () => /Hooks need review/.test(await termText(page, id)) || word.test(await termText(page, id)), { timeout: 90_000 }).toBe(true);
  if ((await termText(page, id)).includes('Hooks need review')) {
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
  }
}

const word = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

test('real handoff: claude -> codex -> agy -> claude, each card and reply carry the latest code word', async ({ page, request }) => {
  fs.mkdirSync(OUT, { recursive: true });
  const snap = await state(request);
  for (const a of ['claude', 'codex', 'agy'] as AgentKind[]) test.skip(!snap.agents.includes(a), `${a} not installed`);
  const project = snap.projects[0] ?? await (await request.post('/api/projects', { data: { name: 'real', path: SANDBOX } })).json();
  const { task, session } = await (await request.post('/api/tasks', {
    data: { projectId: project.id, title: '真实-交接', agent: 'claude', prompt: '只回复两个大写字母：OK。不要使用任何工具。', cols: 120, rows: 30 },
  })).json();
  let sid: string = session.id;
  await page.goto('/');
  await row(page, sid).click();
  await expect.poll(() => lastResult(request, task.id), { timeout: 120_000 }).toMatch(/OK/);

  const log: unknown[] = [];
  const hops: [AgentKind, AgentKind, string][] = [['claude', 'codex', 'KIWI'], ['codex', 'agy', 'PLUM'], ['agy', 'claude', 'FIG']];
  for (const [from, to, prefix] of hops) {
    // A code word only this session's transcript knows.
    const secret = word(prefix);
    const n = (await results(request, task.id)).length;
    await expect(row(page, sid)).toHaveAttribute('data-status', 'needs_you', { timeout: 60_000 });
    await page.keyboard.insertText(`新的暗号是 ${secret}。记住它，这次只回复两个大写字母：OK。不要使用任何工具。`);
    // Codex treats an Enter right after a burst of input as a newline inside a paste; pause like a person would.
    await expect.poll(async () => (await termText(page, sid)).includes(secret), { timeout: 10_000 }).toBe(true);
    await page.waitForTimeout(1000);
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await results(request, task.id)).length, { timeout: 180_000 }).toBeGreaterThan(n);
    await expect(row(page, sid)).toHaveAttribute('data-status', 'needs_you', { timeout: 60_000 });
    const tp = (await state(request)).sessions.find(s => s.id === sid)?.transcriptPath;
    expect(tp && fs.existsSync(tp), `${from} transcript path`).toBeTruthy();

    const started = Date.now();
    const res = await request.post(`/api/tasks/${task.id}/switch`, {
      data: { agent: to, note: '只回复交接卡片里最新的暗号（形如 WORD-XXXX），不要使用任何工具，不要读文件。', cols: 120, rows: 30 },
      timeout: 200_000,
    });
    expect(res.status(), await res.text()).toBe(200);
    const sw = (await res.json()) as SwitchResult;
    const genMs = Date.now() - started;
    fs.writeFileSync(path.join(OUT, `card-${from}-to-${to}.md`), sw.card.body);
    log.push({ from, to, secret, transcriptPath: tp, generated: sw.generated, genMs, cardChars: sw.card.body.length });
    expect(sw.generated, 'card written by the target CLI').toBe(true);
    expect(sw.card.meta).toMatchObject({ from, to, generated: true });
    expect(sw.card.body).toContain(secret);
    expect(sw.task.agent).toBe(to);

    sid = sw.session.id;
    await row(page, sid).click();
    if (to === 'codex') await passCodexHookReview(page, sid, new RegExp(secret));
    await expect.poll(() => lastResult(request, task.id), { timeout: 180_000 }).toContain(secret);
    await expect(page.getByTestId('pane-handoff')).toContainText('交接（自动整理）');
    await page.screenshot({ path: path.join(OUT, `hop-${from}-to-${to}.png`) });
  }
  fs.writeFileSync(path.join(OUT, 'hops.json'), JSON.stringify(log, null, 2));
  await request.delete(`/api/tasks/${task.id}`);
});
