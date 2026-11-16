import { useMemo } from 'react';
import { encodeQr } from './qr.ts';

export function QrCodeSvg({ value, size = 180, testId }: { value: string; size?: number; testId?: string }) {
  const pathData = useMemo(() => {
    try {
      const qr = encodeQr(value);
      const parts: string[] = [];
      for (let r = 0; r < qr.size; r++) {
        for (let c = 0; c < qr.size; c++) {
          if (qr.modules[r][c]) parts.push(`M${c},${r}h1v1h-1z`);
        }
      }
      return { viewSize: qr.size + 4, d: parts.join('') };
    } catch {
      return null;
    }
  }, [value]);

  if (!pathData) return <div className="form-error">链接过长，无法生成二维码</div>;
  return (
    <svg
      data-testid={testId}
      width={size}
      height={size}
      viewBox={`0 0 ${pathData.viewSize} ${pathData.viewSize}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="手机配对二维码"
      className="qr-svg"
    >
      <rect width={pathData.viewSize} height={pathData.viewSize} fill="#ffffff" rx="2" />
      <g transform="translate(2, 2)">
        <path d={pathData.d} fill="#111317" />
      </g>
    </svg>
  );
}
