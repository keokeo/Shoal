// Pure TypeScript ISO/IEC 18004 Byte-mode QR Code encoder (Versions 1-10, Error Correction Level M).
// Zero external dependencies and zero network calls.

export interface QrMatrix {
  version: number;
  size: number;
  modules: boolean[][];
}

interface VersionSpec {
  version: number;
  maxBytes: number;
  countBits: 8 | 16;
  ecPerBlock: number;
  groups: [count: number, dataWords: number][];
  align: number[];
  remainder: number;
}

const SPECS: readonly VersionSpec[] = [
  { version: 1, maxBytes: 14, countBits: 8, ecPerBlock: 10, groups: [[1, 16]], align: [], remainder: 0 },
  { version: 2, maxBytes: 26, countBits: 8, ecPerBlock: 16, groups: [[1, 28]], align: [6, 18], remainder: 7 },
  { version: 3, maxBytes: 42, countBits: 8, ecPerBlock: 26, groups: [[1, 44]], align: [6, 22], remainder: 7 },
  { version: 4, maxBytes: 62, countBits: 8, ecPerBlock: 18, groups: [[2, 32]], align: [6, 26], remainder: 7 },
  { version: 5, maxBytes: 84, countBits: 8, ecPerBlock: 24, groups: [[2, 43]], align: [6, 30], remainder: 7 },
  { version: 6, maxBytes: 106, countBits: 8, ecPerBlock: 16, groups: [[4, 27]], align: [6, 34], remainder: 7 },
  { version: 7, maxBytes: 122, countBits: 8, ecPerBlock: 18, groups: [[4, 31]], align: [6, 22, 38], remainder: 0 },
  { version: 8, maxBytes: 152, countBits: 8, ecPerBlock: 22, groups: [[2, 38], [2, 39]], align: [6, 24, 42], remainder: 0 },
  { version: 9, maxBytes: 180, countBits: 8, ecPerBlock: 22, groups: [[3, 36], [2, 37]], align: [6, 26, 46], remainder: 0 },
  { version: 10, maxBytes: 213, countBits: 16, ecPerBlock: 26, groups: [[4, 43], [1, 44]], align: [6, 28, 50], remainder: 0 },
];

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}

const gfMul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]);

function rsGenerator(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    const root = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], root);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data: Uint8Array, ecCount: number): Uint8Array {
  const gen = rsGenerator(ecCount);
  const res = new Uint8Array(ecCount);
  for (const byte of data) {
    const factor = byte ^ res[0];
    res.copyWithin(0, 1);
    res[ecCount - 1] = 0;
    for (let j = 0; j < ecCount; j++) {
      res[j] ^= gfMul(gen[j + 1], factor);
    }
  }
  return res;
}

function encodeDataCodewords(bytes: Uint8Array, spec: VersionSpec): number[] {
  const totalData = spec.groups.reduce((acc, [cnt, n]) => acc + cnt * n, 0);
  const bits: number[] = [];
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  pushBits(0b0100, 4); // Byte mode
  pushBits(bytes.length, spec.countBits);
  for (const b of bytes) pushBits(b, 8);
  const capBits = totalData * 8;
  const term = Math.min(4, capBits - bits.length);
  for (let i = 0; i < term; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let b = 0; b < 8; b++) v = (v << 1) | bits[i + b];
    out.push(v);
  }
  const pads = [0xec, 0x11];
  let pi = 0;
  while (out.length < totalData) {
    out.push(pads[pi++ & 1]);
  }
  return out;
}

function interleaveBlocks(codewords: number[], spec: VersionSpec): number[] {
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (const [count, dataLen] of spec.groups) {
    for (let i = 0; i < count; i++) {
      const slice = new Uint8Array(codewords.slice(offset, offset + dataLen));
      offset += dataLen;
      dataBlocks.push(slice);
      ecBlocks.push(rsRemainder(slice, spec.ecPerBlock));
    }
  }
  const bits: number[] = [];
  const pushByte = (b: number) => {
    for (let bit = 7; bit >= 0; bit--) bits.push((b >>> bit) & 1);
  };
  const maxDataLen = Math.max(...dataBlocks.map(b => b.length));
  for (let i = 0; i < maxDataLen; i++) {
    for (const blk of dataBlocks) if (i < blk.length) pushByte(blk[i]);
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (const blk of ecBlocks) pushByte(blk[i]);
  }
  for (let i = 0; i < spec.remainder; i++) bits.push(0);
  return bits;
}

function formatBits(mask: number): number {
  // EC Level M = 00 -> 5-bit data = (0b00 << 3) | mask = mask
  const data = mask & 0b111;
  let rem = data << 10;
  for (let bit = 14; bit >= 10; bit--) {
    if ((rem >>> bit) & 1) rem ^= 0x537 << (bit - 10);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function versionBits(version: number): number {
  let rem = version << 12;
  for (let bit = 17; bit >= 12; bit--) {
    if ((rem >>> bit) & 1) rem ^= 0x1f25 << (bit - 12);
  }
  return (version << 12) | rem;
}

function makeMaskFn(mask: number): (r: number, c: number) => boolean {
  switch (mask) {
    case 0: return (r, c) => (r + c) % 2 === 0;
    case 1: return (r) => r % 2 === 0;
    case 2: return (_r, c) => c % 3 === 0;
    case 3: return (r, c) => (r + c) % 3 === 0;
    case 4: return (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
  }
}

function penaltyScore(m: boolean[][]): number {
  const n = m.length;
  let score = 0;
  for (let r = 0; r < n; r++) {
    let runLen = 1;
    for (let c = 1; c < n; c++) {
      if (m[r][c] === m[r][c - 1]) runLen++;
      else { if (runLen >= 5) score += runLen - 2; runLen = 1; }
    }
    if (runLen >= 5) score += runLen - 2;
  }
  for (let c = 0; c < n; c++) {
    let runLen = 1;
    for (let r = 1; r < n; r++) {
      if (m[r][c] === m[r - 1][c]) runLen++;
      else { if (runLen >= 5) score += runLen - 2; runLen = 1; }
    }
    if (runLen >= 5) score += runLen - 2;
  }
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }
  let dark = 0;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (m[r][c]) dark++;
  const pct = (dark * 100) / (n * n);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

export function encodeQr(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  const spec = SPECS.find(s => bytes.length <= s.maxBytes);
  if (!spec) throw new Error('二维码内容过长（超过 213 字节）');
  const size = spec.version * 4 + 17;

  const isFunc = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const base = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const setFunc = (r: number, c: number, dark: boolean) => {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    isFunc[r][c] = true;
    base[r][c] = dark;
  };

  const drawFinder = (top: number, left: number) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = top + dr;
        const c = left + dc;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const inBox = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const onOuter = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setFunc(r, c, inBox && (onOuter || inCore));
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    setFunc(6, i, i % 2 === 0);
    setFunc(i, 6, i % 2 === 0);
  }

  for (const rCenter of spec.align) {
    for (const cCenter of spec.align) {
      if (isFunc[rCenter][cCenter]) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const onEdge = Math.abs(dr) === 2 || Math.abs(dc) === 2;
          setFunc(rCenter + dr, cCenter + dc, onEdge || (dr === 0 && dc === 0));
        }
      }
    }
  }

  // Reserve format & dark module
  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      setFunc(8, i, false);
      setFunc(i, 8, false);
    }
  }
  for (let i = size - 8; i < size; i++) {
    setFunc(8, i, false);
    setFunc(i, 8, false);
  }
  setFunc(size - 8, 8, true);

  if (spec.version >= 7) {
    const vb = versionBits(spec.version);
    for (let i = 0; i < 18; i++) {
      const dark = ((vb >>> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = size - 11 + (i % 3);
      setFunc(a, b, dark);
      setFunc(b, a, dark);
    }
  }

  const stream = interleaveBlocks(encodeDataCodewords(bytes, spec), spec);
  let bestModules: boolean[][] | null = null;
  let bestPenalty = Number.POSITIVE_INFINITY;

  for (let mask = 0; mask < 8; mask++) {
    const m = base.map(row => [...row]);
    const maskFn = makeMaskFn(mask);
    let bitIdx = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const c = right - j;
          const upward = ((right + 1) & 2) === 0;
          const r = upward ? size - 1 - vert : vert;
          if (!isFunc[r][c] && bitIdx < stream.length) {
            const bit = stream[bitIdx++] === 1;
            m[r][c] = maskFn(r, c) ? !bit : bit;
          }
        }
      }
    }

    const fb = formatBits(mask);
    for (let i = 0; i < 15; i++) {
      const dark = ((fb >>> i) & 1) === 1;
      if (i < 6) m[i][8] = dark;
      else if (i < 8) m[i + 1][8] = dark;
      else m[size - 15 + i][8] = dark;

      if (i < 8) m[8][size - 1 - i] = dark;
      else if (i < 9) m[8][15 - i] = dark;
      else m[8][14 - i] = dark;
    }

    const p = penaltyScore(m);
    if (p < bestPenalty) {
      bestPenalty = p;
      bestModules = m;
    }
  }

  return { version: spec.version, size, modules: bestModules! };
}
