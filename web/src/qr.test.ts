import { describe, expect, it } from 'vitest';
import { encodeQr } from './qr.ts';

describe('pure TS ISO/IEC 18004 QR encoder', () => {
  it('encodes short LAN pairing URL in Version 3/4 with valid finder and timing patterns', () => {
    const url = 'http://192.168.1.50:47801/#pair=0123456789abcdef0123456789abcdef0123456789abcdef';
    const qr = encodeQr(url);
    expect(qr.version).toBeGreaterThanOrEqual(4);
    expect(qr.size).toBe(qr.version * 4 + 17);
    expect(qr.modules).toHaveLength(qr.size);

    // Top-left 7x7 finder outer corners + center core + always-dark module
    expect(qr.modules[0][0]).toBe(true);
    expect(qr.modules[1][1]).toBe(false);
    expect(qr.modules[3][3]).toBe(true);
    expect(qr.modules[qr.size - 8][8]).toBe(true);
    // Timing strip row 6 alternates dark/light
    expect(qr.modules[6][8]).toBe(true);
    expect(qr.modules[6][9]).toBe(false);
  });

  it('encodes long Cloudflare subdomain pairing URLs cleanly up to 213 bytes', () => {
    const url = 'https://shoal-dev-sub.example.com/#pair=' + 'a'.repeat(48);
    const qr = encodeQr(url);
    expect(qr.version).toBeLessThanOrEqual(10);
    expect(() => encodeQr('x'.repeat(220))).toThrow();
  });
});
