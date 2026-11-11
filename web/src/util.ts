import type { SessionStatus } from '../../shared/protocol.ts';

export const STATUS_LABEL: Record<SessionStatus, string> = {
  starting: '启动中',
  idle: '就绪',
  working: '工作中',
  needs_you: '需要你',
  exited: '已退出',
};

export function waitText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `等 ${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `等 ${m}分`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `等 ${h}时${rest}分` : `等 ${h}时`;
}
