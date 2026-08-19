import { describe, expect, it, vi } from 'vitest';
import { buildServer } from '../server.js';
import { normalizeIceServers } from '../turn.js';

const TAG = 'a1b2c3d4e5f60718';
const OTHER_TAG = '00112233445566aa';

async function server(overrides: Parameters<typeof buildServer>[0] = {}) {
  return buildServer({
    env: {
      TURN_KEY_ID: 'test-key',
      TURN_API_TOKEN: 'test-token',
      ...(overrides.env ?? {}),
    } as NodeJS.ProcessEnv,
    config: { dbPath: ':memory:', indexerEnabled: false, logLevel: 'silent' },
    sendPorts: null,
    ...overrides,
  });
}

describe('GET /v1/turn', () => {
  it('mints credentials and refuses to let them be cached', async () => {
    const mint = vi.fn(async (ttl: number) => ({
      iceServers: [
        { urls: ['stun:stun.cloudflare.com:3478'] },
        { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' },
      ],
    }));
    const app = await server({ turnPorts: { mint } });
    const res = await app.inject({ method: 'GET', url: '/v1/turn' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ iceServers: unknown[]; ttlSeconds: number; expiresAt: number }>();
    expect(body.iceServers).toHaveLength(2);
    expect(body.ttlSeconds).toBe(3600);
    expect(body.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(res.headers['cache-control']).toBe('no-store');
    expect(mint).toHaveBeenCalledWith(3600);
    await app.close();
  });

  it('answers 503 when the relay has no TURN configuration', async () => {
    const app = await buildServer({
      env: {} as NodeJS.ProcessEnv,
      config: { dbPath: ':memory:', indexerEnabled: false, logLevel: 'silent' },
      sendPorts: null,
      turnPorts: null,
    });
    const res = await app.inject({ method: 'GET', url: '/v1/turn' });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ error: string }>().error).toBe('turn_disabled');
    await app.close();
  });

  it('answers 502 rather than leaking a provider failure', async () => {
    const app = await server({
      turnPorts: {
        mint: async () => {
          throw new Error('provider exploded with secret detail');
        },
      },
    });
    const res = await app.inject({ method: 'GET', url: '/v1/turn' });
    expect(res.statusCode).toBe(502);
    const body = res.json<{ error: string; message: string }>();
    expect(body.error).toBe('turn_unavailable');
    expect(body.message).not.toContain('secret detail');
    await app.close();
  });

  it('never reports the API token in the health surface', async () => {
    const app = await server({ turnPorts: { mint: async () => ({ iceServers: [] }) } });
    const res = await app.inject({ method: 'GET', url: '/v1/health' });
    const raw = res.body;
    expect(raw).not.toContain('test-token');
    expect(res.json<{ calls: { turn: boolean } }>().calls.turn).toBe(true);
    await app.close();
  });
});

describe('POST /v1/call/signal', () => {
  it('accepts a well-formed frame and answers identically with nobody listening', async () => {
    const app = await server({ turnPorts: null });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/call/signal',
      payload: JSON.stringify({ to: TAG, blob: 'aGVsbG8=' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(202);
    // No delivery count: this must not become a presence oracle.
    expect(res.json()).toEqual({ accepted: true });
    await app.close();
  });

  it('rejects a malformed tag, a non-base64 blob and a non-JSON body', async () => {
    const app = await server({ turnPorts: null });
    const bad = async (payload: string) =>
      (
        await app.inject({
          method: 'POST',
          url: '/v1/call/signal',
          payload,
          headers: { 'content-type': 'application/json' },
        })
      ).statusCode;

    expect(await bad(JSON.stringify({ to: 'nope', blob: 'aGk=' }))).toBe(400);
    expect(await bad(JSON.stringify({ to: TAG, blob: 'not base64!!' }))).toBe(400);
    expect(await bad('{')).toBe(400);
    await app.close();
  });

  it('caps the frame size so the lane cannot carry messages', async () => {
    const app = await server({ turnPorts: null });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/call/signal',
      payload: JSON.stringify({ to: TAG, blob: 'A'.repeat(20_000) }),
      headers: { 'content-type': 'application/json' },
    });
    expect([400, 413]).toContain(res.statusCode);
    await app.close();
  });

  it('routes only to sockets on the matching tag, and never persists', async () => {
    const app = await server({ turnPorts: null });
    const frames: string[] = [];
    const socket = {
      readyState: 1,
      bufferedAmount: 0,
      send: (frame: string) => frames.push(frame),
      on: () => undefined,
      off: () => undefined,
      close: () => undefined,
    };
    app.stream.add(socket as never, TAG);
    expect(app.stream.tagSize(TAG)).toBe(1);

    app.stream.routeSignal(OTHER_TAG, 'bm90LWZvci15b3U=');
    expect(frames.some((f) => f.includes('bm90LWZvci15b3U='))).toBe(false);

    app.stream.routeSignal(TAG, 'Zm9yLXlvdQ==');
    const signal = frames.map((f) => JSON.parse(f) as { type: string; blob?: string }).find((f) => f.type === 'signal');
    expect(signal?.blob).toBe('Zm9yLXlvdQ==');

    // Nothing about the call reached storage.
    expect(app.db.stats().totalBlobs).toBe(0);
    expect(app.db.stats().totalDrops).toBe(0);

    app.stream.remove(socket as never);
    expect(app.stream.tagSize(TAG)).toBe(0);
    await app.close();
  });
});

describe('normalizeIceServers', () => {
  it('accepts a single object, an array, and drops malformed entries', () => {
    expect(normalizeIceServers({ urls: 'turn:a' })).toEqual([{ urls: ['turn:a'] }]);
    expect(normalizeIceServers([{ urls: ['turn:a'], username: 'u', credential: 'c' }])).toEqual([
      { urls: ['turn:a'], username: 'u', credential: 'c' },
    ]);
    expect(normalizeIceServers([{ urls: [] }, { nope: 1 }, null, 'x'])).toEqual([]);
    expect(normalizeIceServers(undefined)).toEqual([]);
  });
});
