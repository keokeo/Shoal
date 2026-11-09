import { useRef, useState } from 'react';
import type { SessionStatus } from '../../shared/protocol.ts';
import { STATUS_LABEL, waitText } from './util.ts';
import { usePrivacy } from './privacy.ts';

// Double-click (or the parent's rename button, via editing/onEditingChange) to rename; Enter or blur saves, Esc cancels.
export function EditableTitle({ title, className, testId = 'task-title-text', onSave, editing: outer, onEditingChange }: {
  title: string;
  className?: string;
  testId?: string;
  onSave(title: string): void;
  editing?: boolean;
  onEditingChange?(editing: boolean): void;
}) {
  const [own, setOwn] = useState(false);
  const editing = outer ?? own;
  const setEditing = onEditingChange ?? setOwn;
  const done = useRef(false);
  const privacy = usePrivacy();

  if (!editing) {
    done.current = false;
    return (
      <span
        className={className}
        data-testid={testId}
        title={privacy ? undefined : `${title}（双击改名）`}
        data-private=""
        onDoubleClick={(e) => {
          e.stopPropagation();
          setEditing(true);
        }}
      >{title}</span>
    );
  }

  const finish = (value: string | null) => {
    if (done.current) return; // Enter followed by the blur it causes
    done.current = true;
    setEditing(false);
    const next = value?.trim();
    if (next && next !== title) onSave(next);
  };
  return (
    <input
      className={`title-input ${className ?? ''}`}
      data-testid="title-input"
      defaultValue={title}
      maxLength={80}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(e.currentTarget.value);
        else if (e.key === 'Escape') finish(null);
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  );
}

export function PencilIcon() {
  return (
    <svg style={{ width: '0.8125rem', height: '0.8125rem' }} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.5 2.5l3 3L6 13H3v-3z" />
    </svg>
  );
}

export function StatusTag({ status, since, now }: { status: SessionStatus; since?: number; now: number }) {
  return (
    <span className={`status st-${status}`} data-testid="status">
      {status === 'needs_you' && since ? waitText(now - since) : STATUS_LABEL[status]}
    </span>
  );
}
