import type { ClientMsg, ServerMsg } from '../../shared/protocol.ts';

let socket: WebSocket | null = null;

// Input is dropped while disconnected; the server keeps the session alive meanwhile.
export function send(msg: ClientMsg): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

export interface Handlers {
  onMsg(msg: ServerMsg): void;
  onOpen(): void;
  onClose(): void;
}

// Connects and auto-reconnects (1s -> 5s backoff). Returns a stop function.
export function connect(h: Handlers): () => void {
  let stopped = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const open = () => {
    const ws = new WebSocket(`ws://${location.host}/ws`);
    socket = ws;
    ws.onopen = () => {
      attempt = 0;
      h.onOpen();
    };
    ws.onmessage = (e) => h.onMsg(JSON.parse(e.data as string) as ServerMsg);
    ws.onclose = () => {
      if (socket === ws) socket = null;
      if (stopped) return;
      h.onClose();
      timer = setTimeout(open, Math.min(5000, 1000 * 2 ** attempt++));
    };
  };
  open();

  return () => {
    stopped = true;
    clearTimeout(timer);
    socket?.close();
    socket = null;
  };
}
