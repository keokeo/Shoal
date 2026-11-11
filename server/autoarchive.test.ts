import { describe, it, expect } from 'vitest';
import { autoArchiveMs, staleApproved } from './autoarchive.ts';
import type { Task } from '../shared/protocol.ts';

const DAY = 24 * 3600 * 1000;
const NOW = 100 * DAY;
const task = (id: string, o: Partial<Task>): Task => ({
  id, projectId: 'p', title: id, prompt: '', titleAuto: false, color: '#fff', agent: 'fake' as Task['agent'],
  sessionId: null, createdAt: 0, phase: 'approved', phaseSince: 0, ...o,
});

describe('staleApproved', () => {
  it('picks approved tasks older than the limit', () => {
    const t = task('a', { phaseSince: NOW - 7 * DAY - 1 });
    expect(staleApproved([t], new Set(), NOW, 7 * DAY)).toEqual([t]);
  });

  it('keeps a task that is exactly at the limit', () => {
    expect(staleApproved([task('a', { phaseSince: NOW - 7 * DAY })], new Set(), NOW, 7 * DAY)).toEqual([]);
  });

  it('keeps a task whose session is still live, archives one whose session ended', () => {
    const live = task('a', { sessionId: 's1', phaseSince: 0 });
    const dead = task('b', { sessionId: 's2', phaseSince: 0 });
    expect(staleApproved([live, dead], new Set(['s1']), NOW, 7 * DAY)).toEqual([dead]);
  });

  it('ignores review, active and already archived tasks', () => {
    const others = (['review', 'active', 'archived'] as const).map(p => task(p, { phase: p, phaseSince: 0 }));
    expect(staleApproved(others, new Set(), NOW, 7 * DAY)).toEqual([]);
  });
});

describe('autoArchiveMs', () => {
  it('defaults to 7 days, 0 or junk disables', () => {
    expect(autoArchiveMs(undefined)).toBe(7 * DAY);
    expect(autoArchiveMs('2')).toBe(2 * DAY);
    expect(autoArchiveMs('0')).toBe(0);
    expect(autoArchiveMs('abc')).toBe(0);
  });
});
