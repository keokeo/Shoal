import type { Task } from '../shared/protocol.ts';

// Approved tasks nobody touched for longer than maxAgeMs whose session is gone or ended: they go to 已归档.
// liveSessionIds are the sessions still running; a task with a live session is still in use and stays.
export function staleApproved(tasks: Task[], liveSessionIds: Set<string>, now: number, maxAgeMs: number): Task[] {
  return tasks.filter(t =>
    t.phase === 'approved' && !(t.sessionId && liveSessionIds.has(t.sessionId)) && now - t.phaseSince > maxAgeMs);
}

// WORKBENCH_AUTO_ARCHIVE_DAYS: days before an approved, stopped task is archived (default 7); 0 disables.
export function autoArchiveMs(env: string | undefined): number {
  const days = env === undefined || env.trim() === '' ? 7 : Number(env);
  return Number.isFinite(days) && days > 0 ? days * 24 * 3600 * 1000 : 0;
}
