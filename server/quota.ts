import fs from 'node:fs';
import type { AgentKind } from '../shared/protocol.ts';

export interface LimitHit { message: string; resetsAt: number | null }

const TAIL_BYTES = 256 * 1024;
const LIMIT_TEXT = /hit your .*limit/i;

// Whether a hook means the session ran out of quota.
// Only claude (and the fake agent that imitates it) has a verified sample: StopFailure with error rate_limit / billing_error,
// or a Stop whose last message says "You've hit your ... limit". codex and agy have no real sample yet, so for them
// switching agent stays manual.
export function detectLimit(agent: AgentKind, event: string, payload: Record<string, unknown>): LimitHit | null {
  if (agent !== 'claude' && agent !== 'fake') return null;
  const last = typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message.trim() : '';
  if (event === 'StopFailure') {
    const err = payload.error;
    if (err !== 'rate_limit' && err !== 'billing_error') return null;
    return { message: last || `API 返回 ${err}`, resetsAt: null };
  }
  if (event === 'Stop' && LIMIT_TEXT.test(last)) return { message: last, resetsAt: null };
  return null;
}

// Reset time (ms epoch) from the last API error line of a claude transcript; null when not found. Never throws.
export function readResetsAt(transcriptPath: string): number | null {
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    let text: string;
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, TAIL_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"apiErrorParams"')) continue;
      try {
        const secs = JSON.parse(lines[i])?.apiErrorParams?.rate_limit_info?.resetsAt;
        if (typeof secs === 'number' && Number.isFinite(secs)) return secs * 1000;
      } catch { /* cut first line of the tail */ }
    }
  } catch { /* missing or unreadable */ }
  return null;
}
