import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AgentKind, Card, PeerListResult, PeerSendBody, PeerSendResult, PeerTaskSummary, Project, SessionInfo, Task,
} from '../shared/protocol.ts';
import { AGENT_LABEL, forwardText } from '../shared/protocol.ts';
import { capBody } from './cards.ts';
import type { EnqueueOptions, SessionManager } from './sessions.ts';
import type { Store } from './store.ts';

export const MAX_AUTO_HOPS = 4;
export const MAX_SENDS_PER_TURN = 2;
const MAX_PEER_FILE_BYTES = 512 * 1024;
const VALID_AGENTS = new Set<AgentKind>(['claude', 'codex', 'agy', 'fake']);

export class CollabError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface ReplyObligation {
  id: string;
  targetTaskId: string;
  targetSessionId: string;
  sourceTaskId: string;
  hop: number;
  stage: 'queued' | 'delivered' | 'armed';
  createdAt: number;
}

export interface CollabDeps {
  stateDir: string;
  store: Store;
  sessions: SessionManager;
  availableAgents: () => AgentKind[];
  createPeerTask: (opts: { projectId: string; agent: AgentKind; title: string; prompt: string }) => { task: Task; session: SessionInfo };
  deliverToTask: (opts: {
    targetTask: Task;
    project: Project;
    text: string;
    system: boolean;
    onDelivered?: () => void;
    cardMeta: NonNullable<Card['meta']>;
  }) => { task: Task; session: SessionInfo; card: Card };
}

function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES') {
      // Windows AV/indexer can briefly hold a handle on rename; fall back to direct write and clean tmp.
      fs.writeFileSync(file, content, 'utf8');
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      return;
    }
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw e;
  }
}

function normCompare(p: string): string {
  const clean = path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? clean.toLowerCase() : clean;
}

function isContainedIn(target: string, root: string): boolean {
  const t = normCompare(target);
  const r = normCompare(root);
  return t === r || t.startsWith(r + path.sep);
}

function firstLinePreview(text: string | undefined, max = 100): string {
  if (!text) return '';
  const line = text.trim().split(/\r?\n/).find(l => l.trim())?.trim() ?? '';
  const cleaned = line.replaceAll('|', '/').replaceAll('`', "'");
  return [...cleaned].length > max ? [...cleaned].slice(0, max).join('') + '…' : cleaned;
}

export function createCollabManager(deps: CollabDeps) {
  const { stateDir, store, sessions } = deps;
  const obligations = new Map<string, ReplyObligation>(); // id -> obligation
  const deliveredHops = new Map<string, number>(); // targetSessionId -> hop of just-delivered injected prompt
  const sessionHops = new Map<string, number>(); // sessionId -> active turn's hop depth (0 = human turn)
  const turnSentCounts = new Map<string, Map<string, number>>(); // sessionId -> (targetKey -> send count in current turn)
  const latestPreviews = new Map<string, string>(); // taskId -> one-line reply summary

  const collabDirOf = (projectId: string) => path.join(stateDir, 'collab', projectId);
  const peersFileOf = (projectId: string) => path.join(collabDirOf(projectId), 'PEERS.md');
  const turnsDirOf = (projectId: string) => path.join(collabDirOf(projectId), 'turns');
  const turnFileOf = (projectId: string, taskId: string) => path.join(turnsDirOf(projectId), `${taskId}-latest.md`);

  function activeProjectTasks(projectId: string): Task[] {
    return store.tasks()
      .filter(t => t.projectId === projectId && t.phase !== 'archived')
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  function syncProjectPeers(projectId: string): void {
    const project = store.getProject(projectId);
    if (!project) return;
    const tasks = activeProjectTasks(projectId);
    const byId = new Map(sessions.list().map(s => [s.id, s]));
    const cards = store.cards();

    const rows: string[] = [];
    const details: string[] = [];
    tasks.forEach((t, idx) => {
      const n = idx + 1;
      const sess = t.sessionId ? byId.get(t.sessionId) : undefined;
      const status = sess?.status ?? 'none';
      const replyPath = turnFileOf(projectId, t.id);
      const hasFile = fs.existsSync(replyPath);
      const safeTitle = firstLinePreview(t.title, 60) || t.id.slice(0, 8);
      rows.push(`| #${n} | ${safeTitle} (\`${t.id.slice(0, 8)}\`) | ${t.agent} | ${t.phase} | ${status} | ${hasFile ? `\`${replyPath}\`` : '—'} |`);

      let preview = latestPreviews.get(t.id);
      if (preview === undefined) {
        const lastResult = cards.filter(c => c.taskId === t.id && c.kind === 'result').at(-1);
        preview = firstLinePreview(lastResult?.body, 140);
      }
      const promptLine = t.lastPrompt ? firstLinePreview(t.lastPrompt, 120) : '';
      const infoParts = [
        `### #${n} ${t.title} (\`${t.id}\`)`,
        `- Agent: ${AGENT_LABEL[t.agent]} (\`${t.agent}\`) · Phase: \`${t.phase}\` · Session: \`${status}\``,
      ];
      if (promptLine) infoParts.push(`- Last prompt: ${promptLine}`);
      if (hasFile) infoParts.push(`- Latest reply snapshot: \`${replyPath}\``);
      if (preview) infoParts.push(`- Latest reply preview: ${preview}`);
      details.push(infoParts.join('\n'));
    });

    const md = [
      `# Shoal Project Peers — ${project.name}`,
      '',
      `- Project ID: \`${project.id}\``,
      `- Directory: \`${project.path}\``,
      `- Updated: ${new Date().toISOString()}`,
      '',
      'Passive index of non-archived tasks in this project. Read any listed `*-latest.md` file directly for zero-disturbance context, or use `shoal` CLI (`shoal peers`, `shoal send <target> -m "..."`, `shoal ask <target> -m "..."`). Never prefix `<target>` with unquoted `@` in PowerShell.',
      '',
      ...(rows.length
        ? [
            '| # | Task | Agent | Phase | Status | Latest Reply File |',
            '|---|---|---|---|---|---|',
            ...rows,
            '',
            ...details,
          ]
        : ['（当前项目暂无活跃任务）']),
      '',
    ].join('\n');

    atomicWrite(peersFileOf(projectId), md);
  }

  function recordTurnReply(task: Task, agent: AgentKind, replyText: string, at = Date.now()): void {
    const clean = capBody(replyText).trim();
    latestPreviews.set(task.id, firstLinePreview(clean, 140));
    const doc = [
      `# ${task.title}`,
      '',
      `- Task ID: \`${task.id}\``,
      `- Project ID: \`${task.projectId}\``,
      `- Agent: ${AGENT_LABEL[agent]} (\`${agent}\`)`,
      `- Updated: ${new Date(at).toISOString()}`,
      '',
      '---',
      '',
      clean,
      '',
    ].join('\n');
    atomicWrite(turnFileOf(task.projectId, task.id), doc);
    syncProjectPeers(task.projectId);
  }

  function clearSessionState(sessionId: string): void {
    deliveredHops.delete(sessionId);
    sessionHops.delete(sessionId);
    turnSentCounts.delete(sessionId);
    for (const [id, o] of obligations) {
      if (o.targetSessionId === sessionId) obligations.delete(id);
    }
  }

  function removeTaskSnapshot(projectId: string, taskId: string): void {
    latestPreviews.delete(taskId);
    for (const [id, o] of obligations) {
      if (o.targetTaskId === taskId || o.sourceTaskId === taskId) obligations.delete(id);
    }
    try { fs.rmSync(turnFileOf(projectId, taskId), { force: true }); } catch { /* ignore */ }
    syncProjectPeers(projectId);
  }

  function removeProjectCollab(projectId: string): void {
    const gone = new Set(store.tasks().filter(t => t.projectId === projectId).map(t => t.id));
    for (const tid of gone) latestPreviews.delete(tid);
    for (const [id, o] of obligations) {
      if (gone.has(o.targetTaskId) || gone.has(o.sourceTaskId)) obligations.delete(id);
    }
    try { fs.rmSync(collabDirOf(projectId), { recursive: true, force: true }); } catch { /* ignore */ }
  }

  function registerReplyBack(opts: {
    targetTaskId: string;
    targetSessionId: string;
    sourceTaskId: string;
    hop: number;
    immediateArm: boolean;
  }): string {
    const id = crypto.randomUUID();
    obligations.set(id, {
      id,
      targetTaskId: opts.targetTaskId,
      targetSessionId: opts.targetSessionId,
      sourceTaskId: opts.sourceTaskId,
      hop: opts.hop,
      stage: opts.immediateArm ? 'armed' : 'queued',
      createdAt: Date.now(),
    });
    return id;
  }

  function seedSessionHop(sessionId: string, hop: number): void {
    sessionHops.set(sessionId, hop);
  }

  function onSystemDelivered(targetSessionId: string, hop: number, obligationId?: string): void {
    deliveredHops.set(targetSessionId, hop);
    if (obligationId) {
      const o = obligations.get(obligationId);
      if (o && o.targetSessionId === targetSessionId && o.stage === 'queued') {
        o.stage = 'delivered';
      }
    }
  }

  function onPromptStart(sessionId: string, systemInjected: boolean): void {
    turnSentCounts.delete(sessionId);
    if (systemInjected) {
      const hop = deliveredHops.get(sessionId) ?? 1;
      deliveredHops.delete(sessionId);
      sessionHops.set(sessionId, hop);
      // Promote delivered reply-back obligations for this session so ONLY the injected turn arms them.
      for (const o of obligations.values()) {
        if (o.targetSessionId === sessionId && o.stage === 'delivered') {
          o.stage = 'armed';
        }
      }
    } else {
      sessionHops.set(sessionId, 0);
    }
  }

  function disarmOnFailureOrCancel(sessionId: string): void {
    for (const [id, o] of obligations) {
      if (o.targetSessionId === sessionId && o.stage === 'armed') {
        obligations.delete(id);
      }
    }
  }

  function onPrimaryStop(opts: {
    task: Task;
    session: SessionInfo;
    replyText: string;
    resultCardId?: string;
    canceledOrLimit?: boolean;
  }): void {
    const { task, session, replyText, resultCardId, canceledOrLimit } = opts;
    if (canceledOrLimit) {
      disarmOnFailureOrCancel(session.id);
      return;
    }

    recordTurnReply(task, session.agent, replyText);

    const ready: ReplyObligation[] = [];
    for (const [id, o] of obligations) {
      if (o.targetTaskId === task.id && o.targetSessionId === session.id && o.stage === 'armed') {
        ready.push(o);
        obligations.delete(id);
      }
    }
    if (!ready.length) return;

    for (const o of ready) {
      if (o.hop >= MAX_AUTO_HOPS) continue;
      const source = store.getTask(o.sourceTaskId);
      if (!source || source.id === task.id || source.phase === 'archived') continue;
      const sourceProject = store.getProject(source.projectId);
      if (!sourceProject) continue;
      const nextHop = o.hop + 1;
      const note = `这是「${task.title}」对你上一轮请求的自动回传结果：`;
      const text = forwardText({ title: task.title, agent: session.agent }, replyText, note, { replyBack: false });
      try {
      let deliveredSessionId = '';
      const delivered = deps.deliverToTask({
        targetTask: source,
        project: sourceProject,
        text,
        system: true,
        onDelivered: () => {
          if (deliveredSessionId) onSystemDelivered(deliveredSessionId, nextHop);
        },
        cardMeta: {
          sourceTaskId: task.id,
          ...(resultCardId ? { sourceCardId: resultCardId } : {}),
          isAutoReply: true,
          peerHop: nextHop,
        },
      });
      deliveredSessionId = delivered.session.id;
      if (sourceProject.id !== task.projectId) syncProjectPeers(sourceProject.id);
      } catch (e) {
        console.warn('[collab] 自动回传失败:', (e as Error).message);
      }
    }
  }

  function verifyCaller(callerSessionId: string): { task: Task; project: Project } {
    const sess = sessions.list().find(s => s.id === callerSessionId);
    const task = sess ? store.getTask(sess.taskId) : undefined;
    if (!sess || !task || task.sessionId !== sess.id || task.phase === 'archived') {
      throw new CollabError(403, '当前会话已不再归属于活跃任务');
    }
    const project = store.getProject(task.projectId);
    if (!project) throw new CollabError(404, '所属项目不存在');
    return { task, project };
  }

  function toPeerSummaries(projectId: string, selfTaskId: string): PeerTaskSummary[] {
    const byId = new Map(sessions.list().map(s => [s.id, s]));
    return activeProjectTasks(projectId).map((t, i) => {
      const s = t.sessionId ? byId.get(t.sessionId) : undefined;
      const snapshot = turnFileOf(projectId, t.id);
      return {
        index: i + 1,
        id: t.id,
        title: t.title,
        agent: t.agent,
        phase: t.phase,
        status: s?.status ?? 'none',
        isSelf: t.id === selfTaskId,
        ...(t.lastPrompt ? { lastPrompt: t.lastPrompt } : {}),
        ...(fs.existsSync(snapshot) ? { latestReplyFile: snapshot } : {}),
      };
    });
  }

  function listPeers(callerSessionId: string): PeerListResult {
    const { task, project } = verifyCaller(callerSessionId);
    const file = peersFileOf(project.id);
    if (!fs.existsSync(file)) syncProjectPeers(project.id);
    return {
      projectId: project.id,
      projectName: project.name,
      selfTaskId: task.id,
      peersFile: file,
      tasks: toPeerSummaries(project.id, task.id),
    };
  }

  function readSafePeerFile(project: Project, rawPath: string): string {
    const abs = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(project.path, rawPath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      throw new CollabError(400, `文件不存在：${abs}`);
    }
    if (!stat.isFile()) throw new CollabError(400, `目标不是普通文件：${abs}`);
    if (stat.size > MAX_PEER_FILE_BYTES) {
      throw new CollabError(400, `文件过大（上限 ${MAX_PEER_FILE_BYTES / 1024} KB）：${abs}`);
    }
    const realFile = fs.realpathSync(abs);
    const roots = [fs.realpathSync(project.path)];
    const cDir = collabDirOf(project.id);
    if (fs.existsSync(cDir)) roots.push(fs.realpathSync(cDir));
    if (!roots.some(r => isContainedIn(realFile, r))) {
      throw new CollabError(403, '安全拦截：--file 仅允许读取当前项目目录或项目协作黑板内的文件');
    }
    return fs.readFileSync(realFile, 'utf8');
  }

  function resolveTarget(
    project: Project,
    caller: Task,
    rawInput: string,
    createIfAgent: boolean,
  ): { kind: 'existing'; task: Task; summary: PeerTaskSummary } | { kind: 'spawn'; agent: AgentKind } {
    const q = rawInput.trim().replace(/^@+/, '');
    if (!q) throw new CollabError(400, '请指定目标任务（如 #2、标题关键词或 claude/codex/agy）');

    const summaries = toPeerSummaries(project.id, caller.id);
    const taskMap = new Map(activeProjectTasks(project.id).map(t => [t.id, t]));
    const others = summaries.filter(s => s.id !== caller.id);

    const numMatch = /^#?(\d+)$/.exec(q);
    if (numMatch) {
      const idx = Number(numMatch[1]);
      const hit = summaries.find(s => s.index === idx);
      if (!hit) throw new CollabError(404, `当前项目没有编号为 #${idx} 的任务`);
      if (hit.id === caller.id) throw new CollabError(400, '不能向当前任务自己发送协作消息');
      return { kind: 'existing', task: taskMap.get(hit.id)!, summary: hit };
    }

    const lower = q.toLowerCase();
    const isAgentName = VALID_AGENTS.has(lower as AgentKind);

    if (createIfAgent && isAgentName) {
      return { kind: 'spawn', agent: lower as AgentKind };
    }

    const exactId = summaries.find(s => s.id.toLowerCase() === lower);
    if (exactId) {
      if (exactId.id === caller.id) throw new CollabError(400, '不能向当前任务自己发送协作消息');
      return { kind: 'existing', task: taskMap.get(exactId.id)!, summary: exactId };
    }

    if (q.length >= 6) {
      const idMatches = others.filter(s => s.id.toLowerCase().startsWith(lower));
      if (idMatches.length === 1) {
        return { kind: 'existing', task: taskMap.get(idMatches[0].id)!, summary: idMatches[0] };
      }
      if (idMatches.length > 1) {
        throw new CollabError(400, `任务 ID 前缀「${q}」命中多个任务，请使用 #序号：${idMatches.map(m => `#${m.index}`).join(' ')}`);
      }
    }

    if (isAgentName) {
      const agent = lower as AgentKind;
      const matches = others.filter(s => s.agent === agent);
      if (matches.length === 1) {
        return { kind: 'existing', task: taskMap.get(matches[0].id)!, summary: matches[0] };
      }
      if (matches.length === 0) {
        return { kind: 'spawn', agent };
      }
      throw new CollabError(
        400,
        `当前项目存在 ${matches.length} 个 ${agent} 任务，请改用 #序号指定：${matches.map(m => `#${m.index}「${m.title}」`).join(' / ')}`,
      );
    }

    const exactTitle = others.filter(s => s.title.toLowerCase() === lower);
    if (exactTitle.length === 1) {
      return { kind: 'existing', task: taskMap.get(exactTitle[0].id)!, summary: exactTitle[0] };
    }
    const subTitle = others.filter(s => s.title.toLowerCase().includes(lower));
    if (subTitle.length === 1) {
      return { kind: 'existing', task: taskMap.get(subTitle[0].id)!, summary: subTitle[0] };
    }
    if (subTitle.length > 1) {
      throw new CollabError(
        400,
        `目标标题「${q}」不唯一，请改用 #序号：${subTitle.map(m => `#${m.index}「${m.title}」`).join(' / ')}`,
      );
    }

    throw new CollabError(404, `在当前项目中未找到目标任务：${q}（可先运行 shoal peers 查看 #序号）`);
  }

  function sendPeer(callerSessionId: string, body: PeerSendBody): PeerSendResult {
    const { task: caller, project } = verifyCaller(callerSessionId);
    const currentHop = sessionHops.get(callerSessionId) ?? 0;
    const hop = currentHop + 1;
    if (hop > MAX_AUTO_HOPS) {
      throw new CollabError(429, `已达到自动协作最大跳数上限 (${MAX_AUTO_HOPS})，已熔断以防死循环`);
    }

    const rawTarget = typeof body.target === 'string' ? body.target : '';
    const replyBack = body.replyBack === true;
    const createIfAgent = body.createIfAgent === true;
    const resolved = resolveTarget(project, caller, rawTarget, createIfAgent);

    const targetKey = resolved.kind === 'existing' ? resolved.task.id : `spawn:${resolved.agent}`;
    let sentMap = turnSentCounts.get(callerSessionId);
    if (!sentMap) {
      sentMap = new Map<string, number>();
      turnSentCounts.set(callerSessionId, sentMap);
    }
    const priorSends = sentMap.get(targetKey) ?? 0;
    if (priorSends >= MAX_SENDS_PER_TURN) {
      throw new CollabError(409, `本轮向同一目标发送次数已达上限 (${MAX_SENDS_PER_TURN})，请先结束本轮等待对方回应`);
    }

    const note = typeof body.note === 'string' ? body.note.trim() : '';
    const stdinText = typeof body.stdinText === 'string' ? body.stdinText.trim() : '';
    const fileContent = typeof body.filePath === 'string' && body.filePath.trim()
      ? readSafePeerFile(project, body.filePath.trim()).trim()
      : '';

    const parts = [stdinText, fileContent].filter(Boolean);
    const combinedBody = parts.join('\n\n') || note;
    if (!combinedBody.trim()) {
      throw new CollabError(400, '发送内容不能为空，请提供 -m、--file 或 --stdin');
    }
    const headerNote = parts.length ? (note || (replyBack ? '请协助处理以下协作请求并回复结果：' : '下面是来自同项目协作任务的信息：'))
      : (replyBack ? '请协助处理以下请求，完成后把结论发回给我：' : '下面是来自同项目协作任务的简讯：');
    const fullText = forwardText({ title: caller.title, agent: caller.agent }, combinedBody, headerNote, { replyBack });

    if (resolved.kind === 'spawn') {
      const avail = deps.availableAgents();
      if (!avail.includes(resolved.agent)) {
        throw new CollabError(400, `智能体不可用：${resolved.agent}`);
      }
      sentMap.set(targetKey, priorSends + 1);
      const title = [...`协作：${caller.title}`].slice(0, 80).join('');
      const { task: createdTask, session: createdSession } = deps.createPeerTask({
        projectId: project.id,
        agent: resolved.agent,
        title,
        prompt: fullText,
      });
      seedSessionHop(createdSession.id, hop);
      if (replyBack) {
        registerReplyBack({
          targetTaskId: createdTask.id,
          targetSessionId: createdSession.id,
          sourceTaskId: caller.id,
          hop,
          immediateArm: true,
        });
      }
      syncProjectPeers(project.id);
      return {
        targetTaskId: createdTask.id,
        targetTitle: createdTask.title,
        targetAgent: createdTask.agent,
        created: true,
        queued: false,
        replyBack,
        hop,
      };
    }

    const target = resolved.task;
    if (!deps.availableAgents().includes(target.agent)) {
      throw new CollabError(400, `目标智能体不可用：${target.agent}`);
    }
    sentMap.set(targetKey, priorSends + 1);

    let obligationId: string | undefined;
    let boundSessionId = target.sessionId ?? '';
    const { task: deliveredTask, session: deliveredSession } = deps.deliverToTask({
      targetTask: target,
      project,
      text: fullText,
      system: true,
      onDelivered: () => {
        const sid = store.getTask(target.id)?.sessionId ?? boundSessionId;
        if (sid) onSystemDelivered(sid, hop, obligationId);
      },
      cardMeta: {
        sourceTaskId: caller.id,
        peerHop: hop,
        ...(replyBack ? { replyBack: true } : {}),
      },
    });
    boundSessionId = deliveredSession.id;
    if (replyBack) {
      obligationId = registerReplyBack({
        targetTaskId: deliveredTask.id,
        targetSessionId: deliveredSession.id,
        sourceTaskId: caller.id,
        hop,
        immediateArm: false,
      });
    }
    syncProjectPeers(project.id);
    return {
      targetTaskId: deliveredTask.id,
      targetTitle: deliveredTask.title,
      targetAgent: deliveredTask.agent,
      created: false,
      queued: (deliveredSession.queued ?? 0) > 0,
      replyBack,
      hop,
    };
  }

  return {
    collabDirOf,
    peersFileOf,
    turnFileOf,
    syncProjectPeers,
    recordTurnReply,
    clearSessionState,
    removeTaskSnapshot,
    removeProjectCollab,
    registerReplyBack,
    seedSessionHop,
    onSystemDelivered,
    onPromptStart,
    onPrimaryStop,
    listPeers,
    sendPeer,
  };
}

export type { EnqueueOptions };
