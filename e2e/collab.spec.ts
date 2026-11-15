import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import type { Card } from '../shared/protocol.ts';
import {
  createFakeTask,
  createProject,
  expectStatus,
  fakeLines,
  openReview,
  pane,
  removeAllTasks,
  row,
  state,
  termText,
  token,
} from './helpers.ts';

const ARTIFACT_DIR = path.resolve('.tmp/collab');
const STATE_DIR = path.resolve('.tmp/m1/state');

const cardsOf = (st: Awaited<ReturnType<typeof state>>, taskId: string): Card[] =>
  st.cards.filter(c => c.taskId === taskId);

test.describe('cross-CLI collaboration e2e', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ request }) => {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    await removeAllTasks(request);
  });

  test('Layer 1+2: ForwardDialog optional 1-shot replyBack keeps .pane-body height invariant and updates blackboard', async ({ page, request }) => {
    const project = await createProject(request, token('collab-ui'));
    const a = await createFakeTask(request, project.id, 'Task A', 'draft plan');
    const b = await createFakeTask(request, project.id, 'Task B', 'sleep 5');

    await page.goto('/');
    await row(page, a.session.id).click();
    await expectStatus(page, a.session.id, 'needs_you');
    await expectStatus(page, b.session.id, 'working');

    const bodyLocator = pane(page, 0).locator('.pane-body');
    await expect(bodyLocator).toBeVisible();
    const beforeBox = (await bodyLocator.boundingBox())!;
    expect(beforeBox.height).toBeGreaterThan(100);

    await openReview(page, 0);
    await pane(page, 0).getByTestId('review-forward').click();
    const dlg = page.getByTestId('forward-dialog');
    await expect(dlg).toBeVisible();
    await dlg.getByTestId('forward-target').selectOption(`task:${b.task.id}`);
    const cb = dlg.getByTestId('forward-reply-back');
    await expect(cb).not.toBeChecked();
    await cb.check();
    await expect(cb).toBeChecked();
    await dlg.getByTestId('forward-note').fill('请核对接口字段');
    await dlg.getByTestId('forward-submit').click();
    await expect(dlg).toBeHidden();

    await expect.poll(async () => {
      const st = await state(request);
      return st.sessions.find(s => s.id === b.session.id)?.queued ?? 0;
    }, { timeout: 10_000 }).toBe(1);

    await expect.poll(async () => {
      const st = await state(request);
      const aCards = cardsOf(st, a.task.id);
      const autoFwd = aCards.filter(c => c.kind === 'forward' && c.meta?.isAutoReply === true);
      const results = aCards.filter(c => c.kind === 'result');
      const taskA = st.tasks.find(t => t.id === a.task.id);
      return { autoCount: autoFwd.length, resultCount: results.length, phase: taskA?.phase };
    }, { timeout: 30_000 }).toEqual({ autoCount: 1, resultCount: 2, phase: 'review' });

    await expectStatus(page, a.session.id, 'needs_you', 30_000);
    if (await pane(page, 0).getByTestId('review-popover').count()) {
      await pane(page, 0).getByTestId('review-toggle').click();
    }
    const afterBox = (await bodyLocator.boundingBox())!;
    expect(Math.abs(afterBox.height - beforeBox.height)).toBeLessThanOrEqual(1);

    const peersFile = path.join(STATE_DIR, 'collab', project.id, 'PEERS.md');
    const turnBFile = path.join(STATE_DIR, 'collab', project.id, 'turns', `${b.task.id}-latest.md`);
    expect(fs.existsSync(peersFile)).toBe(true);
    expect(fs.existsSync(turnBFile)).toBe(true);
    expect(fs.readFileSync(peersFile, 'utf8')).toContain('Task B');
    expect(fs.readFileSync(turnBFile, 'utf8')).toContain('reply:');

    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'ui-roundtrip.png') });
  });

  test('Layer 3 + 4-gate safety: shoal ask inside real ConPTY and Ctrl+C queue freeze/recovery', async ({ page, request }) => {
    const project = await createProject(request, token('collab-cli'));
    const a = await createFakeTask(request, project.id, 'Caller A', '');
    const b = await createFakeTask(request, project.id, 'Worker B', 'sleep 8');

    await page.goto('/');
    await expectStatus(page, b.session.id, 'working');
    await row(page, a.session.id).click();
    await expectStatus(page, a.session.id, 'idle', 10_000);
    await expect.poll(() => termText(page, a.session.id)).toContain('FAKE AGENT');

    await pane(page, 0).locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('shoal ask #2 "review schema"');
    await page.keyboard.press('Enter');

    await expect.poll(() => fakeLines(a.session.id), { timeout: 15_000 }).toContain('shoal ask #2 "review schema"');
    await expectStatus(page, a.session.id, 'needs_you', 15_000);
    await expect.poll(async () => {
      const st = await state(request);
      return cardsOf(st, a.task.id).find(c => c.kind === 'result')?.body ?? '';
    }, { timeout: 10_000 }).toContain('shoal(0):');

    await expect.poll(async () => {
      const st = await state(request);
      return {
        queued: st.sessions.find(s => s.id === b.session.id)?.queued ?? 0,
        status: st.sessions.find(s => s.id === b.session.id)?.status,
      };
    }, { timeout: 10_000 }).toEqual({ queued: 1, status: 'working' });

    // Switch to Worker B while it is still running `sleep 8` and press Ctrl+C -> must freeze queued delivery.
    await row(page, b.session.id).click();
    await expect.poll(() => termText(page, b.session.id)).toContain('FAKE AGENT');
    await pane(page, 0).locator('.xterm-helper-textarea').focus();
    await page.keyboard.press('Control+c');

    await expectStatus(page, b.session.id, 'needs_you', 10_000);
    await expect.poll(() => termText(page, b.session.id)).toContain('Interrupted');

    await new Promise(r => setTimeout(r, 3000));
    const midState = await state(request);
    expect(midState.sessions.find(s => s.id === b.session.id)?.queued).toBe(1);
    expect(fakeLines(b.session.id).some(l => l.includes('review schema'))).toBe(false);

    // Explicit user turn (resume work + Enter) unfreezes the queue -> B receives `review schema`, finishes, and auto-replies to A.
    await pane(page, 0).locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('resume work');
    await page.keyboard.press('Enter');

    await expect.poll(() => fakeLines(b.session.id).some(l => l.includes('review schema')), { timeout: 25_000 }).toBe(true);
    await expect.poll(async () => {
      const st = await state(request);
      const aCards = cardsOf(st, a.task.id);
      const autoFwd = aCards.filter(c => c.kind === 'forward' && c.meta?.isAutoReply === true);
      const results = aCards.filter(c => c.kind === 'result');
      const sessA = st.sessions.find(s => s.id === a.session.id);
      return { autoCount: autoFwd.length, resultCount: results.length, statusA: sessA?.status };
    }, { timeout: 30_000 }).toEqual({ autoCount: 1, resultCount: 2, statusA: 'needs_you' });

    await row(page, a.session.id).click();
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'cli-ctrlc-recovery.png') });
    fs.writeFileSync(
      path.join(ARTIFACT_DIR, 'verification-summary.json'),
      JSON.stringify(
        {
          verifiedAt: new Date().toISOString(),
          uiRoundtrip: 'passed',
          cliCtrlCRecovery: 'passed',
          artifacts: ['ui-roundtrip.png', 'cli-ctrlc-recovery.png'],
        },
        null,
        2,
      ),
      'utf8',
    );
  });
});
