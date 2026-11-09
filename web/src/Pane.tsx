import { useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, DragEvent } from 'react';
import type { Card, FeedbackBody, Project, SessionInfo, Task } from '../../shared/protocol.ts';
import { AGENT_LABEL, canResume } from '../../shared/protocol.ts';
import { attach, fitEntry } from './terms.ts';
import { EditableTitle, PencilIcon, StatusTag } from './bits.tsx';
import { AgentIcon } from './agentIcons.tsx';
import { usePrivacy } from './privacy.ts';

interface Props {
  index: number;
  sessionId: string | null;
  session?: SessionInfo;
  task?: Task;
  project?: Project;
  focused: boolean;
  dual: boolean;
  now: number;
  onFocus(): void;
  onRename(title: string): void;
  onResume(fresh: boolean): void;
  card?: Card; // latest result card of the task
  onApprove(): void;
  onFeedback(text: string, mode: FeedbackBody['mode']): Promise<boolean>; // true = sent
  onSwitch(): void; // open the switch-agent dialog
  onForward(): void; // open the forward dialog for the result card
  handoff?: Card; // latest handoff card of the task
  onDropSession?(sessionId: string): void; // a sidebar task row was dropped on this pane (dual layout only)
}

export const SESSION_DRAG_TYPE = 'application/x-wb-session';

// 待验收: the agent's last reply as a one-line summary, expandable; approve it or write feedback back.
function ReviewBar({ card, onApprove, onFeedback, onForward }: Pick<Props, 'onApprove' | 'onFeedback' | 'onForward'> & { card: Card }) {
  const [open, setOpen] = useState(false);
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const privacy = usePrivacy();
  const summary = card.body.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const blank = !text.trim();

  const send = async (mode: FeedbackBody['mode']) => {
    if (blank || busy) return;
    setBusy(true);
    const ok = await onFeedback(text, mode);
    setBusy(false);
    if (ok) {
      setWriting(false);
      setText('');
    }
  };
  const cancel = () => {
    setWriting(false);
    setText('');
  };

  return (
    <div className="review-bar" data-testid="review-bar">
      <div className="review-line">
        <span className="review-label">待验收</span>
        <span className="review-summary" data-testid="review-summary" data-private="" title={privacy ? undefined : summary}>{summary}</span>
        <button className="btn" data-testid="review-expand" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? '收起' : '展开'}</button>
        {!writing && <button className="btn" data-testid="review-feedback" onClick={() => setWriting(true)}>写反馈</button>}
        <button className="btn" data-testid="review-forward" onClick={onForward}>转发</button>
        <button className="btn primary" data-testid="review-approve" onClick={onApprove}>通过</button>
      </div>
      {open && <div className="review-body" data-testid="review-body" data-private="">{card.body}</div>}
      {writing && (
        <div className="review-write">
          <textarea
            data-testid="feedback-input"
            autoFocus
            rows={3}
            value={text}
            placeholder="写下要改的地方"
            onChange={(e) => setText(e.target.value)}
            onKeyUp={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') cancel();
              else if (e.key === 'Enter' && e.ctrlKey) {
                e.preventDefault();
                void send('new');
              }
            }}
          />
          <div className="review-actions">
            <button className="btn primary" data-testid="feedback-new" disabled={blank || busy} title="Ctrl+Enter" onClick={() => void send('new')}>新会话继续</button>
            <button className="btn" data-testid="feedback-same" disabled={blank || busy} onClick={() => void send('same')}>发到原会话</button>
            <button className="btn" data-testid="feedback-cancel" onClick={cancel}>取消</button>
          </div>
        </div>
      )}
    </div>
  );
}

// What the session's limit looks like in the pane banner: the CLI's own message, plus the reset time when known.
const limitText = (l: NonNullable<SessionInfo['limit']>) =>
  `额度用完：${l.message}${l.resetsAt ? `，${new Date(l.resetsAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })} 重置` : ''}`;

// Shown on the session that took over from another agent: one line, expandable to the whole handoff card.
function HandoffBar({ card }: { card: Card }) {
  const [open, setOpen] = useState(false);
  const from = card.meta?.from;
  return (
    <div className="handoff-bar" data-testid="pane-handoff">
      <div className="handoff-line">
        <span>由 {from ? AGENT_LABEL[from] : '另一个 agent'} 交接（{card.meta?.generated === false ? '按记录摘录' : '自动整理'}）</span>
        <button className="btn" data-testid="pane-handoff-expand" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? '收起' : '展开'}</button>
      </div>
      {open && <div className="handoff-body" data-testid="pane-handoff-body" data-private="">{card.body}</div>}
    </div>
  );
}

function FolderIcon() {
  return (
    <svg style={{ width: '0.8125rem', height: '0.8125rem', flex: 'none' }} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
    </svg>
  );
}

export function Pane({ index, sessionId, session, task, project, focused, dual, now, onFocus, onRename, onResume, card, onApprove, onFeedback, onSwitch, onForward, handoff, onDropSession }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);

  // Show this session's terminal in the pane and keep it fitted to the pane size.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    if (!sessionId) {
      body.replaceChildren();
      return;
    }
    attach(sessionId, body);
    // A short fade so a switched terminal reads as a change instead of a jump; ends at the pane's own (maybe dimmed) opacity.
    body.animate([{ opacity: 0 }, { opacity: getComputedStyle(body).opacity }], { duration: 160, easing: 'ease-out' });
    const ro = new ResizeObserver(() => fitEntry(sessionId));
    ro.observe(body);
    const raf = requestAnimationFrame(() => fitEntry(sessionId));
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [sessionId]);

  const privacy = usePrivacy();
  const [dropOver, setDropOver] = useState(false);
  const style = { '--c': task?.color ?? 'var(--text-3)' } as CSSProperties;
  const wantsSession = (e: DragEvent) => !!onDropSession && e.dataTransfer.types.includes(SESSION_DRAG_TYPE);
  return (
    <div
      className={`pane ${focused ? 'focused' : ''} ${dual ? 'dual' : ''} ${dropOver ? 'drop-over' : ''}`}
      style={style}
      data-testid="pane"
      data-pane-index={index}
      data-session-id={sessionId ?? ''}
      data-focused={focused ? 'true' : 'false'}
      onMouseDownCapture={onFocus}
      onFocusCapture={onFocus}
      onDragOver={(e) => {
        if (!wantsSession(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setDropOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropOver(false);
      }}
      onDrop={(e) => {
        if (!wantsSession(e)) return;
        e.preventDefault();
        setDropOver(false);
        const id = e.dataTransfer.getData(SESSION_DRAG_TYPE);
        if (id) onDropSession?.(id);
      }}
    >
      {sessionId && (
        <div className="pane-header" data-testid="pane-header" key={sessionId}>
          <span className="task-swatch" />
          <AgentIcon agent={task?.agent ?? session?.agent ?? 'fake'} />
          <span className="pane-project" data-testid="pane-project" data-private="" title={privacy ? undefined : project?.path}>
            <FolderIcon />
            <span className="pane-project-name">{project?.name ?? '?'}</span>
          </span>
          {task ? <EditableTitle className="pane-title" testId="pane-title" title={task.title} onSave={onRename} editing={editing} onEditingChange={setEditing} /> : <span className="pane-title">?</span>}
          {task && !editing && (
            <button className="icon-btn pane-rename" data-testid="pane-rename" title="改名（也可以双击标题）" onClick={() => setEditing(true)}>
              <PencilIcon />
            </button>
          )}
          <span className="pane-agent">{task?.agent ?? session?.agent ?? '?'}</span>
          {session && !(task?.phase === 'approved' && session.status === 'needs_you') && <StatusTag status={session.status} since={session.statusSince} now={now} />}
          {task && <button className="btn pane-switch" data-testid="pane-switch" title="让另一个 agent 接手这个任务" onClick={onSwitch}>换 agent</button>}
        </div>
      )}
      {session?.limit && (
        <div className="limit-bar" data-testid="pane-limit">
          <span className="limit-text" title={session.limit.message}>{limitText(session.limit)}</span>
          <button className="btn primary" data-testid="pane-limit-switch" onClick={onSwitch}>换 agent</button>
        </div>
      )}
      {handoff && handoff.sessionId === sessionId && <HandoffBar key={handoff.id} card={handoff} />}
      <div className="pane-body" ref={bodyRef} />
      {task?.phase === 'review' && card && <ReviewBar key={task.id} card={card} onApprove={onApprove} onFeedback={onFeedback} onForward={onForward} />}
      {!!session?.queued && (
        <div className="pane-queued" data-testid="pane-queued">消息排队中，agent 空闲后自动发送</div>
      )}
      {session?.status === 'exited' && task && (
        <div className="pane-exited" data-testid="pane-exited">
          <span>会话已退出{session.exitCode ? `（退出码 ${session.exitCode}）` : ''}</span>
          {canResume(session) && (
            <button className="btn primary" data-testid="pane-resume" onClick={() => onResume(false)}>续接上次会话</button>
          )}
          <button className="btn" data-testid="pane-fresh" onClick={() => onResume(true)}>新开会话</button>
        </div>
      )}
      {!sessionId && (
        <div className="pane-empty">
          <span>从左侧选一个任务</span>
          <span className="pane-empty-hint">或按 <kbd>Alt</kbd><kbd>N</kbd> 在当前项目新建</span>
        </div>
      )}
    </div>
  );
}
