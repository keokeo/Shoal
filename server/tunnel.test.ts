import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { MobileTunnelStatus } from '../shared/protocol.ts';
import { createCfAccessVerifier, createTunnelManager, extractTunnelToken, normalizeTeamDomain, parseCloudflaredLine } from './tunnel.ts';

const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64url');

describe('tunnel helpers & security', () => {
  it('extracts raw token or token inside cloudflared install command and rejects garbage', () => {
    const sample = 'eyJhIjoiYWJjZGVmZ2hpamsiLCJ0IjoidHVubmVsLWlkLTEyMzQ1Njc4OTAifQ==';
    expect(extractTunnelToken(sample)).toBe(sample);
    expect(extractTunnelToken(`  cloudflared.exe service install ${sample}  `)).toBe(sample);
    expect(extractTunnelToken('')).toBe('');
    expect(() => extractTunnelToken('not a valid token!')).toThrow();
  });

  it('parses cloudflared edge registration and error lines', () => {
    const st: MobileTunnelStatus = { state: 'starting', mode: 'named', pid: 123, startedAt: 1, connectedEdges: 0, binaryPath: 'cloudflared' };
    expect(parseCloudflaredLine('2026-11-15 INF Registered tunnel connection connIndex=0', st)).toBe(true);
    expect(st.state).toBe('running');
    expect(st.connectedEdges).toBe(1);
    expect(parseCloudflaredLine('2026-11-15 ERR Failed to connect edge', st)).toBe(true);
    expect(st.lastError).toBe('Failed to connect edge');
    expect(parseCloudflaredLine('2026-11-15 INF Unregistered tunnel connection connIndex=0', st)).toBe(true);
    expect(st.connectedEdges).toBe(0);
  });

  it('supports zero-account Quick Tunnel mode without TUNNEL_TOKEN and ignores api.trycloudflare.com', async () => {
    const spawns: { args: string[]; hasEnvToken: boolean; proc: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter } }[] = [];
    class QuickFakeProc extends EventEmitter {
      pid = 8888;
      exitCode: number | null = null;
      killed = false;
      stdout = new EventEmitter();
      stderr = new EventEmitter();
      kill() {
        this.killed = true;
        this.exitCode = 0;
        this.emit('exit', 0, null);
        return true;
      }
    }
    const mgr = createTunnelManager({
      findBinary: () => '/fake/cloudflared',
      spawnImpl: ((_file: string, args: string[], opts: { env?: Record<string, string> }) => {
        const proc = new QuickFakeProc();
        spawns.push({ args, hasEnvToken: Object.prototype.hasOwnProperty.call(opts.env ?? {}, 'TUNNEL_TOKEN'), proc });
        return proc as never;
      }) as never,
    });

    mgr.sync({ enabled: true, mode: 'quick', token: 'ignored-tok', targetUrl: 'http://127.0.0.1:47801' });
    expect(spawns).toHaveLength(1);
    expect(spawns[0].args).toEqual(['tunnel', '--no-autoupdate', '--protocol', 'http2', '--edge-ip-version', '4', '--url', 'http://127.0.0.1:47801']);
    expect(spawns[0].hasEnvToken).toBe(false);
    expect(mgr.status().state).toBe('starting');

    // Internal API banner must be ignored, while random quick subdomain is captured.
    spawns[0].proc.stderr.emit('data', Buffer.from('2026-11-16 INF Requesting new quick Tunnel on https://api.trycloudflare.com\n'));
    expect(mgr.status().quickUrl).toBeUndefined();
    spawns[0].proc.stderr.emit('data', Buffer.from('2026-11-16 INF |  https://bright-otter-1234.trycloudflare.com  |\n'));
    expect(mgr.status().quickUrl).toBe('https://bright-otter-1234.trycloudflare.com');
    expect(mgr.status().state).toBe('starting');

    spawns[0].proc.stderr.emit('data', Buffer.from('2026-11-16 INF Registered tunnel connection connIndex=0\n'));
    expect(mgr.status().state).toBe('running');
    expect(mgr.status().connectedEdges).toBe(1);

    await mgr.stop();
    expect(mgr.status().state).toBe('stopped');
    expect(mgr.status().quickUrl).toBeUndefined();
    expect(mgr.status().connectedEdges).toBe(0);
  });

  it('passes TUNNEL_TOKEN strictly via env and never CLI args', async () => {
    const calls: { file: string; args: string[]; envToken?: string }[] = [];
    class FakeProc extends EventEmitter {
      pid = 9999;
      exitCode: number | null = null;
      killed = false;
      stderr = new EventEmitter();
      kill() {
        this.killed = true;
        this.exitCode = 0;
        this.emit('exit', 0, null);
        return true;
      }
    }
    const mgr = createTunnelManager({
      findBinary: () => '/fake/cloudflared',
      spawnImpl: ((file: string, args: string[], opts: { env?: Record<string, string> }) => {
        calls.push({ file, args, envToken: opts.env?.TUNNEL_TOKEN });
        return new FakeProc() as never;
      }) as never,
    });
    const tok = 'eyJhIjoiYWJjZGVmZ2hpamsiLCJ0IjoidHVubmVsLWlkLTEyMzQ1Njc4OTAifQ==';
    mgr.sync({ enabled: true, token: tok });
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(['tunnel', '--no-autoupdate', '--protocol', 'http2', '--edge-ip-version', '4', 'run']);
    expect(calls[0].args.join(' ')).not.toContain(tok);
    expect(calls[0].envToken).toBe(tok);
    await mgr.stop();
  });

  it('verifies Cloudflare Access RS256 JWT signatures and rejects forged or expired tokens', async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
    const now = 1_800_000_000;
    const signJwt = (payload: Record<string, unknown>, key = privateKey, kid = 'k1') => {
      const h = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
      const p = b64url(JSON.stringify(payload));
      const sig = b64url(crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key));
      return `${h}.${p}.${sig}`;
    };

    const verifier = createCfAccessVerifier({
      nowSec: () => now,
      fetchImpl: (async (url: string) => {
        expect(url).toBe('https://shoal-team.cloudflareaccess.com/cdn-cgi/access/certs');
        return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
      }) as never,
    });

    expect(normalizeTeamDomain('shoal-team')).toBe('shoal-team.cloudflareaccess.com');
    expect(() => normalizeTeamDomain('.cloudflareaccess.com')).toThrow();
    expect(() => normalizeTeamDomain('a..cloudflareaccess.com')).toThrow();
    expect(() => normalizeTeamDomain('-bad')).toThrow();
    const valid = signJwt({ iss: 'https://shoal-team.cloudflareaccess.com', aud: ['aud-123'], exp: now + 300 });
    expect(await verifier.verify(valid, 'shoal-team', 'aud-123')).toBe(true);

    // Wrong AUD
    expect(await verifier.verify(valid, 'shoal-team', 'aud-other')).toBe(false);
    // Expired
    const expired = signJwt({ iss: 'https://shoal-team.cloudflareaccess.com', aud: ['aud-123'], exp: now - 120 });
    expect(await verifier.verify(expired, 'shoal-team', 'aud-123')).toBe(false);
    // Wrong key signature
    const rogue = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const forged = signJwt({ iss: 'https://shoal-team.cloudflareaccess.com', aud: ['aud-123'], exp: now + 300 }, rogue);
    expect(await verifier.verify(forged, 'shoal-team', 'aud-123')).toBe(false);
  });

  it('throttles forced JWKS refreshes on repeated unknown kids and honors cooldown', async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
    const now = 1_800_000_000;
    let nowMs = 1_000_000;
    let fetchCalls = 0;
    const signJwt = (kid: string) => {
      const h = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
      const p = b64url(JSON.stringify({ iss: 'https://shoal-team.cloudflareaccess.com', aud: ['aud-123'], exp: now + 300 }));
      const sig = b64url(crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey));
      return `${h}.${p}.${sig}`;
    };

    const verifier = createCfAccessVerifier({
      nowSec: () => now,
      nowMs: () => nowMs,
      minForceRefreshMs: 60_000,
      fetchImpl: (async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
      }) as never,
    });

    // Initial verification populates JWKS cache (1st fetch).
    expect(await verifier.verify(signJwt('k1'), 'shoal-team', 'aud-123')).toBe(true);
    expect(fetchCalls).toBe(1);

    // First unknown kid forces 1 refresh (2nd fetch); subsequent unknown kids within 60s do not refetch.
    expect(await verifier.verify(signJwt('unknown-1'), 'shoal-team', 'aud-123')).toBe(false);
    expect(fetchCalls).toBe(2);
    nowMs += 5_000;
    expect(await verifier.verify(signJwt('unknown-2'), 'shoal-team', 'aud-123')).toBe(false);
    expect(await verifier.verify(signJwt('unknown-3'), 'shoal-team', 'aud-123')).toBe(false);
    expect(fetchCalls).toBe(2);

    // After cooldown expires, a single forced refresh is permitted again.
    nowMs += 60_000;
    expect(await verifier.verify(signJwt('unknown-4'), 'shoal-team', 'aud-123')).toBe(false);
    expect(fetchCalls).toBe(3);
  });

  it('serializes stop() and immediate sync({ enabled: true }) so old process exits before launching next', async () => {
    const spawns: number[] = [];
    class AsyncFakeProc extends EventEmitter {
      pid = 999_999_999;
      exitCode: number | null = null;
      killed = false;
      stderr = new EventEmitter();
      kill() {
        this.killed = true;
        this.exitCode = 0;
        this.emit('exit', 0, null);
        return true;
      }
    }
    const mgr = createTunnelManager({
      findBinary: () => '/fake/cloudflared',
      spawnImpl: (() => {
        spawns.push(spawns.length + 1);
        return new AsyncFakeProc() as never;
      }) as never,
    });

    const tok = 'eyJhIjoiYWJjZGVmZ2hpamsiLCJ0IjoidHVubmVsLWlkLTEyMzQ1Njc4OTAifQ==';
    mgr.sync({ enabled: true, token: tok });
    expect(spawns).toHaveLength(1);

    const stopPromise = mgr.stop();
    // Immediately re-enable while async termination is in flight: must NOT spawn concurrently!
    mgr.sync({ enabled: true, token: tok });
    expect(spawns).toHaveLength(1);

    await stopPromise;
    await new Promise(r => setTimeout(r, 0));
    expect(spawns).toHaveLength(2);
    expect(mgr.status().state).toBe('starting');

    await mgr.stop();
  });
});
