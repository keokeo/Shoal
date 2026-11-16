import { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  Card,
  ClientMsg,
  Snapshot,
  Task,
  TaskConversationResponse,
} from '../../../shared/protocol.ts';
import { AGENT_LABEL, canResume } from '../../../shared/protocol.ts';
import { AgentIcon } from '../agentIcons.tsx';
import { MarkdownPreview } from '../MarkdownPreview.tsx';
import { STATUS_LABEL } from '../util.ts';
import { mobileGet, mobilePost, mobileUploadImage } from './api.ts';
import { EmergencyTerminalDrawer } from './EmergencyTerminalDrawer.tsx';
import type { TermStreamEvent } from './EmergencyTerminalDrawer.tsx';
import { ForwardSheet, NewSessionSheet, RenameSheet, SwitchAgentSheet } from './MobileSheets.tsx';
import { ReadOnlyDiffDrawer } from './ReadOnlyDiffDrawer.tsx';

const CARD_LABEL: Record<Card['kind'], string> = {
  result: '结果卡片',
  feedback: '追问',
  handoff: '跨智能体交接',
  forward: '来自其他任务的转发',
};

class MarkdownBubbleBoundary extends Component<
  { content: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidUpdate(prevProps: { content: string }) {
    if (prevProps.content !== this.props.content && this.state.failed) {
      this.setState({ failed: false });
    }
  }

  render() {
    if (this.state.failed) {
      return <div style={{ whiteSpace: 'pre-wrap' }}>{this.props.content}</div>;
    }
    return this.props.children;
  }
}

export function MobileTaskView({
  task,
  state,
  wsConnected,
  subscribeTerm,
  sendMsg,
  onBack,
  onOpenTask,
}: {
  task: Task;
  state: Snapshot;
  now: number;
  wsConnected: boolean;
  subscribeTerm(fn: (ev: TermStreamEvent) => void): () => void;
  sendMsg(msg: ClientMsg): void;
  onBack(): void;
  onOpenTask(taskId: string): void;
}) {
  const session = useMemo(
    () => (task.sessionId ? state.sessions.find((s) => s.id === task.sessionId) : undefined),
    [state.sessions, task.sessionId],
  );
  const project = useMemo(() => state.projects.find((p) => p.id === task.projectId), [state.projects, task.projectId]);
  const git = state.git[task.projectId];
  const taskCards = useMemo(
    () => state.cards.filter((c) => c.taskId === task.id).sort((a, b) => a.createdAt - b.createdAt),
    [state.cards, task.id],
  );
  const lastResultCard = useMemo(
    () => [...taskCards].reverse().find((c) => c.kind === 'result'),
    [taskCards],
  );
  const liveActivity = session ? state.activity?.[session.id] ?? null : null;

  const [conv, setConv] = useState<TaskConversationResponse | null>(null);
  const [loadingConv, setLoadingConv] = useState(true);
  const [convError, setConvError] = useState('');

  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState('');

  const [drawer, setDrawer] = useState<'none' | 'diff' | 'term'>('none');
  const [sheet, setSheet] = useState<'none' | 'more' | 'switch' | 'forward' | 'new-session' | 'rename'>('none');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const loadSeqRef = useRef(0);
  const prevTaskIdRef = useRef<string | null>(null);

  const loadConversation = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    setConvError('');
    try {
      const data = await mobileGet<TaskConversationResponse>(`/api/mobile/tasks/${encodeURIComponent(task.id)}/conversation`);
      if (seq !== loadSeqRef.current) return;
      setConv(data);
    } catch (e) {
      if (seq !== loadSeqRef.current) return;
      setConvError((e as Error).message);
    } finally {
      if (seq === loadSeqRef.current) setLoadingConv(false);
    }
  }, [task.id]);

  // Auto-refresh structured conversation whenever task, session id/status, or cards change.
  const latestCardId = taskCards.at(-1)?.id ?? '';
  useEffect(() => {
    if (prevTaskIdRef.current !== task.id) {
      prevTaskIdRef.current = task.id;
      setConv(null);
      setLoadingConv(true);
    }
    void loadConversation();
  }, [task.id, session?.id, session?.status, taskCards.length, latestCardId, loadConversation]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [conv?.items.length, liveActivity?.stepCount]);

  const handleUploadFiles = async (files: FileList | null) => {
    if (!files?.length || uploading) return;
    setUploading(true);
    setActionError('');
    try {
      for (const file of Array.from(files)) {
        const name = await mobileUploadImage(file);
        setAttachments((prev) => [...prev, name]);
      }
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const sendFeedback = async () => {
    if (sending) return;
    const text = input.trim();
    if (!text && attachments.length === 0) return;
    setSending(true);
    setActionError('');
    try {
      await mobilePost(`/api/tasks/${encodeURIComponent(task.id)}/feedback`, {
        text,
        mode: 'same',
        ...(attachments.length ? { attachments } : {}),
      });
      setInput('');
      setAttachments([]);
      await loadConversation();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const runTaskAction = async (path: string, body: unknown = {}) => {
    if (actionBusy) return;
    setActionBusy(true);
    setActionError('');
    try {
      await mobilePost(path, body);
      setSheet('none');
      await loadConversation();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setActionBusy(false);
    }
  };

  const canSendSameSession = Boolean(
    session && (session.status !== 'exited' || canResume(session)),
  );
  const statusText = session ? STATUS_LABEL[session.status] : '未启动';

  return (
    <div className="mob-root" data-testid="mobile-task-view">
      <header className="mob-header">
        <button type="button" className="mob-btn compact ghost" data-testid="mobile-back-btn" onClick={onBack}>
          ←
        </button>
        <AgentIcon agent={session?.agent ?? task.agent} className="agent-icon" />
        <div className="mob-title-wrap">
          <span className="mob-title">{task.title}</span>
          <span className="mob-sub">
            {project?.name ?? '项目'} · {AGENT_LABEL[session?.agent ?? task.agent]} · {statusText}
            {task.phase === 'review' ? ' · 待验收' : task.phase === 'approved' ? ' · 已通过' : task.phase === 'archived' ? ' · 已归档' : ''}
          </span>
        </div>
        <button type="button" className="mob-btn compact" data-testid="mobile-open-diff-btn" onClick={() => setDrawer('diff')}>
          变更{git && git.dirty > 0 ? `(${git.dirty})` : ''}
        </button>
        {session && (
          <button type="button" className="mob-btn compact" data-testid="mobile-open-term-btn" onClick={() => setDrawer('term')} title="应急只读终端">
            &gt;_
          </button>
        )}
        <button type="button" className="mob-btn compact ghost" data-testid="mobile-task-more-btn" onClick={() => setSheet('more')} aria-label="更多操作">
          ⋯
        </button>
      </header>

      {session?.blocked && (
        <div className="mob-banner is-blocked" data-testid="mobile-blocked-banner">
          <span>
            {session.blocked === 'permission'
              ? '智能体在终端等待授权按键（如 y/n 或数字选择）'
              : '会话在终端启动界面等待信任确认'}
          </span>
          <button
            type="button"
            className="mob-btn compact warn"
            data-testid="mobile-blocked-open-term"
            onClick={() => setDrawer('term')}
          >打开应急终端</button>
        </div>
      )}

      {session?.limit && (
        <div className="mob-banner is-blocked">
          <span>额度已达上限：{session.limit.message}</span>
          <button type="button" className="mob-btn compact warn" onClick={() => setSheet('switch')}>
            换 Agent
          </button>
        </div>
      )}

      {task.phase === 'review' && (
        <div className="mob-banner is-review">
          <span>本轮已产出结果，请验收</span>
          <div style={{ display: 'flex', gap: '0.375rem', flex: 'none' }}>
            <button type="button" className="mob-btn compact" onClick={() => setDrawer('diff')}>Diff</button>
            {lastResultCard && (
              <button type="button" className="mob-btn compact" onClick={() => setSheet('forward')}>转发</button>
            )}
            <button
              type="button"
              className="mob-btn compact primary"
              data-testid="mobile-approve-btn"
              disabled={actionBusy}
              onClick={() => void runTaskAction(`/api/tasks/${encodeURIComponent(task.id)}/approve`)}
            >✓ 通过</button>
          </div>
        </div>
      )}

      <div className="mob-scroll" ref={scrollRef}>
        {loadingConv && !conv && <div className="mob-sub">正在整理对话记录…</div>}
        {convError && <div className="form-error">{convError}</div>}

        {conv && conv.items.length === 0 && !liveActivity && (
          <div className="mob-sub">暂无对话内容，发送第一句指令即可开始。</div>
        )}

        {conv?.items.map((item) => {
          if (item.kind === 'user') {
            return (
              <div key={item.id} className="mob-turn-user" data-testid="mobile-turn-user">
                {item.text}
              </div>
            );
          }
          if (item.kind === 'assistant') {
            return (
              <div key={item.id} className="mob-turn-assistant" data-testid="mobile-turn-assistant">
                <MarkdownBubbleBoundary content={item.text}>
                  <MarkdownPreview projectId={task.projectId} filePath="" content={item.text} />
                </MarkdownBubbleBoundary>
              </div>
            );
          }
          if (item.kind === 'tools') {
            return (
              <details key={item.id} className="mob-tools-group" data-testid="mobile-tool-group">
                <summary>已执行 {item.count} 步工具调用</summary>
                <ul className="mob-tools-list">
                  {item.tools.map((line, idx) => (
                    <li key={idx}>{line}</li>
                  ))}
                </ul>
              </details>
            );
          }
          return (
            <div key={item.id} className="mob-card-event">
              <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>{CARD_LABEL[item.card.kind]}</div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{item.card.body}</div>
            </div>
          );
        })}

        {liveActivity && (
          <div className="mob-pair-card" data-testid="mobile-live-activity">
            <div className="mob-task-top" style={{ justifyContent: 'space-between' }}>
              <strong style={{ fontSize: '0.8125rem', color: 'var(--work)' }}>{liveActivity.summary}</strong>
              <span className="mob-sub">{liveActivity.stepCount} 步</span>
            </div>
            {liveActivity.thinkingSnippet && (
              <div className="mob-sub" style={{ whiteSpace: 'normal' }}>{liveActivity.thinkingSnippet}</div>
            )}
            {liveActivity.recentSteps.length > 0 && (
              <div className="mob-sub" style={{ whiteSpace: 'normal' }}>
                最近：{liveActivity.recentSteps.slice(-3).map((s) => s.summary).join(' → ')}
              </div>
            )}
            {(liveActivity.filesRead.length > 0 || liveActivity.filesWritten.length > 0) && (
              <div className="mob-sub" style={{ whiteSpace: 'normal' }}>
                {liveActivity.filesWritten.length > 0 ? `改动：${liveActivity.filesWritten.join(', ')}` : `读取：${liveActivity.filesRead.join(', ')}`}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="mob-composer">
        {session?.queued ? (
          <div className="mob-sub" data-testid="mobile-queued-badge">
            队列中有 {session.queued} 条指令等待当前轮次完成后发送
          </div>
        ) : null}

        {attachments.length > 0 && (
          <div className="mob-attach-chips">
            {attachments.map((name, idx) => (
              <span key={`${name}-${idx}`} className="mob-attach-chip">
                {name}
                <button type="button" className="ghost" onClick={() => setAttachments((p) => p.filter((_, i) => i !== idx))}>×</button>
              </span>
            ))}
          </div>
        )}

        {actionError && <div className="form-error">{actionError}</div>}

        {session?.status === 'exited' && !canResume(session) ? (
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button type="button" className="mob-btn primary" style={{ flex: 1 }} onClick={() => setSheet('new-session')}>
              新会话继续
            </button>
            <button type="button" className="mob-btn" disabled={actionBusy} onClick={() => void runTaskAction(`/api/tasks/${encodeURIComponent(task.id)}/resume`, { fresh: true })}>
              重启空白会话
            </button>
          </div>
        ) : (
          <div className="mob-composer-row">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              data-testid="mobile-image-input"
              style={{ display: 'none' }}
              onChange={(e) => {
                void handleUploadFiles(e.target.files);
                e.target.value = '';
              }}
            />
            <button
              type="button"
              className="mob-btn compact"
              data-testid="mobile-attach-btn"
              disabled={uploading || !canSendSameSession}
              onClick={() => fileInputRef.current?.click()}
              title="拍照或从相册附截图"
            >{uploading ? '…' : '📷'}</button>
            <textarea
              className="mob-composer-box"
              data-testid="mobile-composer-input"
              rows={1}
              value={input}
              disabled={!canSendSameSession}
              placeholder={
                session?.status === 'working'
                  ? '正在运行中，发送会进入排队…'
                  : session?.status === 'exited'
                    ? '会话已退出，发送将自动恢复并继续…'
                    : '继续追问或下达修改指令…'
              }
              onChange={(e) => setInput(e.target.value)}
            />
            <button
              type="button"
              className="mob-btn compact primary"
              data-testid="mobile-composer-send"
              disabled={sending || !canSendSameSession || (!input.trim() && attachments.length === 0)}
              onClick={() => void sendFeedback()}
            >{sending ? '…' : '发送'}</button>
          </div>
        )}
      </div>

      {drawer === 'term' && session && (
        <EmergencyTerminalDrawer
          session={session}
          wsConnected={wsConnected}
          subscribeTerm={subscribeTerm}
          sendMsg={sendMsg}
          onClose={() => setDrawer('none')}
        />
      )}

      {drawer === 'diff' && (
        <ReadOnlyDiffDrawer
          projectId={task.projectId}
          projectName={project?.name ?? '项目'}
          gitKey={git ? `${git.branch}:${git.dirty}` : ''}
          onClose={() => setDrawer('none')}
        />
      )}

      {sheet === 'more' && (
        <div className="mob-sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setSheet('none')}>
          <div className="mob-sheet" data-testid="mobile-task-more-sheet">
            <h3>任务操作</h3>
            <button type="button" className="mob-btn" onClick={() => setSheet('switch')}>切换 Agent 接力</button>
            <button type="button" className="mob-btn" onClick={() => setSheet('new-session')}>开新会话继续</button>
            {lastResultCard && (
              <button type="button" className="mob-btn" onClick={() => setSheet('forward')}>转发最后结果给其他任务</button>
            )}
            <button type="button" className="mob-btn" onClick={() => setSheet('rename')}>重命名任务</button>
            {session?.status === 'exited' && canResume(session) && (
              <button type="button" className="mob-btn" disabled={actionBusy} onClick={() => void runTaskAction(`/api/tasks/${encodeURIComponent(task.id)}/resume`, { fresh: false })}>
                重新恢复原对话
              </button>
            )}
            {task.phase !== 'archived' ? (
              <button type="button" className="mob-btn danger" disabled={actionBusy} onClick={() => void runTaskAction(`/api/tasks/${encodeURIComponent(task.id)}/archive`)}>
                归档并结束会话
              </button>
            ) : (
              <button type="button" className="mob-btn" disabled={actionBusy} onClick={() => void runTaskAction(`/api/tasks/${encodeURIComponent(task.id)}/unarchive`)}>
                恢复为活跃任务
              </button>
            )}
            <button type="button" className="mob-btn ghost" onClick={() => setSheet('none')}>取消</button>
          </div>
        </div>
      )}

      {sheet === 'switch' && (
        <SwitchAgentSheet
          task={task}
          agents={state.agents}
          onDone={() => {
            setSheet('none');
            void loadConversation();
          }}
          onClose={() => setSheet('none')}
        />
      )}

      {sheet === 'forward' && lastResultCard && (
        <ForwardSheet
          sourceTask={task}
          card={lastResultCard}
          tasks={state.tasks}
          agents={state.agents}
          onForwarded={(targetId) => {
            setSheet('none');
            onOpenTask(targetId);
          }}
          onClose={() => setSheet('none')}
        />
      )}

      {sheet === 'new-session' && (
        <NewSessionSheet
          task={task}
          onDone={() => {
            setSheet('none');
            void loadConversation();
          }}
          onClose={() => setSheet('none')}
        />
      )}

      {sheet === 'rename' && (
        <RenameSheet
          task={task}
          onDone={() => setSheet('none')}
          onClose={() => setSheet('none')}
        />
      )}
    </div>
  );
}
