export type DiffLineKind = 'ctx' | 'add' | 'del';

export interface DiffLine {
  kind: DiffLineKind;
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

const MAX_LCS_LINES = 900;

export function buildUnifiedDiffHunks(base: string, head: string, context = 3): DiffHunk[] {
  const a = base === '' ? [] : base.replace(/\r\n/g, '\n').split('\n');
  const b = head === '' ? [] : head.replace(/\r\n/g, '\n').split('\n');

  const raw: DiffLine[] = [];
  if (a.length <= MAX_LCS_LINES && b.length <= MAX_LCS_LINES) {
    const n = a.length;
    const m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? 1 + dp[i + 1][j + 1] : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        raw.push({ kind: 'ctx', oldLine: i + 1, newLine: j + 1, text: a[i] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        raw.push({ kind: 'del', oldLine: i + 1, newLine: null, text: a[i] });
        i++;
      } else {
        raw.push({ kind: 'add', oldLine: null, newLine: j + 1, text: b[j] });
        j++;
      }
    }
    while (i < n) raw.push({ kind: 'del', oldLine: i + 1, newLine: null, text: a[i++] });
    while (j < m) raw.push({ kind: 'add', oldLine: null, newLine: j + 1, text: b[j++] });
  } else {
    // Fallback for huge files: simple prefix/suffix trimming without O(N*M) matrix.
    let pre = 0;
    while (pre < a.length && pre < b.length && a[pre] === b[pre]) {
      raw.push({ kind: 'ctx', oldLine: pre + 1, newLine: pre + 1, text: a[pre] });
      pre++;
    }
    let suf = 0;
    while (a.length - 1 - suf >= pre && b.length - 1 - suf >= pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) {
      suf++;
    }
    for (let i = pre; i < a.length - suf; i++) raw.push({ kind: 'del', oldLine: i + 1, newLine: null, text: a[i] });
    for (let j = pre; j < b.length - suf; j++) raw.push({ kind: 'add', oldLine: null, newLine: j + 1, text: b[j] });
    for (let k = 0; k < suf; k++) {
      const ai = a.length - suf + k;
      const bi = b.length - suf + k;
      raw.push({ kind: 'ctx', oldLine: ai + 1, newLine: bi + 1, text: a[ai] });
    }
  }

  const changedIdx: number[] = [];
  for (let idx = 0; idx < raw.length; idx++) if (raw[idx].kind !== 'ctx') changedIdx.push(idx);
  if (changedIdx.length === 0) return [];

  const hunks: DiffHunk[] = [];
  let spanStart = Math.max(0, changedIdx[0] - context);
  let spanEnd = Math.min(raw.length - 1, changedIdx[0] + context);
  const pushSpan = (start: number, end: number) => {
    const lines = raw.slice(start, end + 1);
    const oldStart = lines.find(l => l.oldLine !== null)?.oldLine ?? 1;
    const newStart = lines.find(l => l.newLine !== null)?.newLine ?? 1;
    const oldCount = lines.filter(l => l.kind !== 'add').length;
    const newCount = lines.filter(l => l.kind !== 'del').length;
    hunks.push({
      header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
      lines,
    });
  };
  for (let c = 1; c < changedIdx.length; c++) {
    const nextStart = Math.max(0, changedIdx[c] - context);
    const nextEnd = Math.min(raw.length - 1, changedIdx[c] + context);
    if (nextStart <= spanEnd + 1) {
      spanEnd = nextEnd;
    } else {
      pushSpan(spanStart, spanEnd);
      spanStart = nextStart;
      spanEnd = nextEnd;
    }
  }
  pushSpan(spanStart, spanEnd);
  return hunks;
}
