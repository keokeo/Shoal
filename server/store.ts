import fs from 'node:fs';
import type { Card, Project, SessionInfo, Task } from '../shared/protocol.ts';
import { CARDS_PER_TASK, TASK_COLORS } from '../shared/protocol.ts';
import { cleanTitle } from './titles.ts';

// Pre-muted palette; tasks stored with these are migrated to the TASK_COLORS entry at the same index.
export const LEGACY_TASK_COLORS = [
  '#4f9dff', '#ff7a45', '#36cfc9', '#f759ab', '#ffd666',
  '#95de64', '#b37feb', '#ff4d4f', '#d4b106',
] as const;

export interface Store {
  projects(): Project[];
  tasks(): Task[];
  sessions(): SessionInfo[];
  cards(): Card[];
  getProject(id: string): Project | undefined;
  getTask(id: string): Task | undefined;
  addProject(p: Project): void;
  addTask(t: Task): void;
  updateTask(t: Task): void;
  removeTask(id: string): void; // also drops the task's sessions and cards
  removeProject(id: string): void; // also drops all its tasks, their sessions and cards (one save)
  saveSession(s: SessionInfo): void;
  removeSession(id: string): void;
  addCard(c: Card): void; // keeps only the newest CARDS_PER_TASK cards of the task
}

interface StateFile {
  version: 1;
  projects: Project[];
  tasks: Task[];
  sessions: SessionInfo[];
  cards?: Card[]; // missing in files saved before M2
}

function createStore(onChange: (s: Store) => void, init?: Partial<StateFile>): Store {
  const projects = new Map<string, Project>((init?.projects ?? []).map(p => [p.id, p]));
  const tasks = new Map<string, Task>((init?.tasks ?? []).map(t => [t.id, t]));
  const sessions = new Map<string, SessionInfo>((init?.sessions ?? []).map(s => [s.id, s]));
  const cards = new Map<string, Card>((init?.cards ?? []).map(c => [c.id, c]));
  const store: Store = {
    projects: () => [...projects.values()],
    tasks: () => [...tasks.values()],
    sessions: () => [...sessions.values()],
    cards: () => [...cards.values()],
    getProject: id => projects.get(id),
    getTask: id => tasks.get(id),
    addProject: p => { projects.set(p.id, p); onChange(store); },
    addTask: t => { tasks.set(t.id, t); onChange(store); },
    updateTask: t => { tasks.set(t.id, t); onChange(store); },
    removeTask: id => {
      tasks.delete(id);
      for (const [sid, s] of sessions) if (s.taskId === id) sessions.delete(sid);
      for (const [cid, c] of cards) if (c.taskId === id) cards.delete(cid);
      onChange(store);
    },
    removeProject: id => {
      const gone = new Set<string>();
      for (const [tid, t] of tasks) if (t.projectId === id) { gone.add(tid); tasks.delete(tid); }
      for (const [sid, s] of sessions) if (gone.has(s.taskId)) sessions.delete(sid);
      for (const [cid, c] of cards) if (gone.has(c.taskId)) cards.delete(cid);
      projects.delete(id);
      onChange(store);
    },
    saveSession: s => { sessions.set(s.id, { ...s }); onChange(store); },
    removeSession: id => { if (sessions.delete(id)) onChange(store); },
    addCard: c => {
      cards.set(c.id, c);
      const mine = [...cards.values()].filter(x => x.taskId === c.taskId);
      // Map keeps insertion order, so the oldest come first.
      for (const old of mine.slice(0, Math.max(0, mine.length - CARDS_PER_TASK))) cards.delete(old.id);
      onChange(store);
    },
  };
  return store;
}

export function createMemoryStore(): Store {
  return createStore(() => {});
}

// File-backed store: loads `file` once, rewrites it atomically (tmp + rename) after every mutation.
export function createFileStore(file: string): Store {
  let init: StateFile | undefined;
  let raw: string | undefined;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`[store] 无法读取 ${file}：`, (e as Error).message);
  }
  if (raw !== undefined) {
    try {
      const v = JSON.parse(raw);
      if (!v || typeof v !== 'object' || Array.isArray(v) || v.version !== 1
        || !Array.isArray(v.projects) || !Array.isArray(v.tasks) || !Array.isArray(v.sessions)) throw new Error('unexpected format');
      init = v as StateFile;
    } catch (e) {
      const keep = `${file}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(file, keep);
        console.warn(`[store] ${file} 已损坏（${(e as Error).message}），已保留为 ${keep}，从空状态启动`);
      } catch (e2) {
        console.error(`[store] ${file} 已损坏且无法改名保留：`, (e2 as Error).message);
      }
    }
  }
  let migrated = false;
  const oldTitles = new Map<Task, string>(); // titles rewritten by cleanTitle
  if (init) {
    for (const t of init.tasks) {
      if (t.phase !== 'active' && t.phase !== 'review' && t.phase !== 'approved' && t.phase !== 'archived') { t.phase = 'active'; t.phaseSince = t.createdAt; migrated = true; }
      if (typeof t.titleAuto !== 'boolean') { t.titleAuto = false; migrated = true; }
      const i = typeof t.color === 'string' ? (LEGACY_TASK_COLORS as readonly string[]).indexOf(t.color.toLowerCase()) : -1;
      if (i >= 0) { t.color = TASK_COLORS[i]; migrated = true; }
      const title = typeof t.title === 'string' ? cleanTitle(t.title) : t.title;
      if (title !== t.title) { oldTitles.set(t, t.title); t.title = title; }
    }
    // Titles are user data: rewrite them only once the file as it was is kept aside.
    if (oldTitles.size) {
      const keep = `${file}.before-title-cleanup`;
      try {
        if (!fs.existsSync(keep)) fs.copyFileSync(file, keep);
        migrated = true;
      } catch (e) {
        console.error(`[store] 无法备份 ${file}，跳过标题清理：`, (e as Error).message);
        for (const [t, title] of oldTitles) t.title = title;
      }
    }
    // Their processes died with the previous server.
    init.sessions = init.sessions.map(({ queued: _q, ...s }) => s.status === 'exited'
      ? s
      : { ...s, status: 'exited', exitCode: null, statusSince: Date.now() }); // queues do not survive a restart
  }
  const flush = (store: Store) => {
    const data: StateFile = { version: 1, projects: store.projects(), tasks: store.tasks(), sessions: store.sessions(), cards: store.cards() };
    const tmp = `${file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, file);
    } catch (e) {
      console.error(`[store] 写入 ${file} 失败：`, (e as Error).message);
    }
  };
  const store = createStore(flush, init);
  if (migrated) flush(store);
  return store;
}

// Least-used color among current tasks; ties go to the earliest entry.
export function pickColor(tasks: Pick<Task, 'color'>[]): string {
  const counts = new Map<string, number>(TASK_COLORS.map(c => [c, 0]));
  for (const t of tasks) if (counts.has(t.color)) counts.set(t.color, counts.get(t.color)! + 1);
  let best: string = TASK_COLORS[0];
  for (const c of TASK_COLORS) if (counts.get(c)! < counts.get(best)!) best = c;
  return best;
}
