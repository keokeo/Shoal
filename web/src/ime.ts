import type { Terminal } from '@xterm/xterm';

// Claude Code hides the real cursor (CSI ?25l) and paints its own as an inverse cell. xterm still anchors the IME
// (hidden textarea = candidate window, plus the composition view) at the real cursor on every render, and that cursor
// ends wherever the CLI's last repaint stopped (often the end of a line or the status bar), so the composition jumps
// around while you type or while the CLI is printing. While the real cursor is hidden, pin both to the painted cursor.
export function pinIme(term: Terminal, el: HTMLElement): void {
  const textarea = el.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');
  const view = el.querySelector<HTMLElement>('.composition-view');
  const screen = el.querySelector<HTMLElement>('.xterm-screen');
  if (!textarea || !view || !screen) return;

  // null = unknown (e.g. the replayed output was trimmed before the CLI's ?25l); treated like hidden.
  let hidden: boolean | null = null;
  const track = (show: boolean) => (params: (number | number[])[]) => {
    if (params.includes(25)) hidden = !show;
    return false;
  };
  term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, track(true));
  term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, track(false));

  let anchor: { x: number; row: number } | null = null; // row is absolute in the active buffer
  const isInverse = (x: number, row: number) => {
    const cell = term.buffer.active.getLine(row)?.getCell(x);
    return Boolean(cell && cell.getWidth() > 0 && cell.isInverse());
  };
  // The inverse cell on screen closest to `near`; rows weigh more than columns.
  const findCursor = (near: { x: number; row: number }) => {
    const buf = term.buffer.active;
    let best: { x: number; row: number } | null = null;
    let bestDist = Infinity;
    for (let row = buf.baseY; row < buf.baseY + term.rows; row++) {
      const line = buf.getLine(row);
      if (!line) continue;
      for (let x = 0; x < term.cols; x++) {
        const cell = line.getCell(x);
        if (!cell || cell.getWidth() === 0 || !cell.isInverse()) continue;
        const dist = Math.abs(row - near.row) * 1000 + Math.abs(x - near.x);
        if (dist < bestDist) {
          bestDist = dist;
          best = { x, row };
        }
      }
    }
    return best;
  };

  const place = (node: HTMLElement, left: number, top: number) => {
    if (node.style.left !== `${left}px`) node.style.left = `${left}px`;
    if (node.style.top !== `${top}px`) node.style.top = `${top}px`;
  };

  const pin = () => {
    if (hidden === false || document.activeElement !== textarea) {
      anchor = null;
      return;
    }
    const buf = term.buffer.active;
    if (!anchor || !isInverse(anchor.x, anchor.row)) {
      anchor = findCursor(anchor ?? { x: buf.cursorX, row: buf.baseY + buf.cursorY });
    }
    if (!anchor) return;
    const vrow = anchor.row - buf.viewportY;
    if (vrow < 0 || vrow >= term.rows) return;
    const cellW = screen.clientWidth / term.cols;
    const cellH = screen.clientHeight / term.rows;
    // Keep a long composition inside the screen instead of letting it overflow, which scrolls the whole terminal sideways.
    const width = view.classList.contains('active') ? view.offsetWidth : 0;
    const left = Math.max(0, Math.min(anchor.x * cellW, screen.clientWidth - width));
    const top = vrow * cellH;
    place(view, left, top);
    place(textarea, left, top);
  };

  // xterm rewrites these styles on renders and in timers; a MutationObserver re-pins them before the next paint.
  const mo = new MutationObserver(pin);
  mo.observe(textarea, { attributes: true, attributeFilter: ['style'] });
  mo.observe(view, { attributes: true, attributeFilter: ['style', 'class'] });
  textarea.addEventListener('focus', pin);
  term.onRender(pin);

  // Belt and braces: focusing an overflowing textarea scrolls its overflow:hidden ancestors; the terminal never scrolls sideways.
  el.addEventListener('scroll', (e) => {
    const t = e.target as HTMLElement;
    if (t.scrollLeft) t.scrollLeft = 0;
  }, true);
}
