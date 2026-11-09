import fs from 'node:fs';
import type { AgentKind } from '../shared/protocol.ts';
import { CARD_MAX } from '../shared/protocol.ts';

const TAIL_BYTES = 1024 * 1024;

// Last line of an agy transcript (JSONL) that is a PLANNER_RESPONSE with text; tool-only steps have empty content.
function agyReply(transcriptPath: string): string | undefined {
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
    const l = lines[i].trim();
    if (!l) continue;
    let v: { type?: unknown; content?: unknown };
    try { v = JSON.parse(l); } catch { continue; } // a cut first line of the tail, or a torn write
    if (v && v.type === 'PLANNER_RESPONSE' && typeof v.content === 'string' && v.content.trim()) return v.content;
  }
  return undefined;
}

// The agent's last reply of a finished turn, from a Stop hook payload. Never throws.
export function lastReply(agent: AgentKind | string, payload: unknown): string | undefined {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  try {
    if (agent === 'agy') {
      return typeof p.transcriptPath === 'string' && p.transcriptPath ? agyReply(p.transcriptPath) : undefined;
    }
    const m = p.last_assistant_message;
    return typeof m === 'string' && m.trim() ? m : undefined;
  } catch (e) {
    console.warn(`[cards] 读取最后回复失败：${(e as Error).message}`);
    return undefined;
  }
}

export function capBody(body: string): string {
  return body.length > CARD_MAX ? body.slice(0, CARD_MAX) + '\n…（已截断）' : body;
}
