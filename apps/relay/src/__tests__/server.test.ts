import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_BLOB_BYTES } from '../config.js';
import type { StreamMessage } from '../stream.js';
import { BINARY, makeDrop, newApp, waitFor } from './helpers.js';

describe('WS /v1/stream', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it('greets with stats, pushes each new anchor, and cleans up on disconnect', async () => {
    app = await newApp();
    const frames: StreamMessage[] = [];

    const socket = await app.injectWS('/v1/stream', undefined, {
      onInit: (ws) => {
        // `ws`'s RawData type is not resolvable from this package, so the frame
        // is narrowed by hand.
        ws.on('message', (data: unknown) => {
          frames.push(JSON.parse(String(data)) as StreamMessage);
        });
      },
    });

    await waitFor(() => frames.length >= 1);
    expect(frames[0]).toEqual({
      type: 'stats',
      stats: { head: 0, totalDrops: 0, totalBlobs: 0, uniquePosters: 0, indexedBlock: 0 },
    });
    expect(app.stream.size).toBe(1);

    const drop = makeDrop(1);
    app.stream.broadcastDrop(drop);

    await waitFor(() => frames.length >= 2);
    expect(frames[1]).toEqual({ type: 'drop', drop });

    socket.terminate();
    await waitFor(() => app.stream.size === 0);
    expect(app.stream.timerArmed).toBe(false);
  });
});

describe('blob rate limit', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it('caps blob posts per IP and keeps reads open', async () => {
    app = await newApp({ blobRateLimitMax: 2 });

    const post = async (n: number): Promise<number> => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/blob',
        headers: BINARY,
        payload: Buffer.from(`payload-${n}`, 'utf8'),
      });
      return res.statusCode;
    };

    expect(await post(1)).toBe(200);
    expect(await post(2)).toBe(200);
    expect(await post(3)).toBe(429);

    // Reads are not rate limited.
    const stats = await app.inject({ method: 'GET', url: '/v1/stats' });
    expect(stats.statusCode).toBe(200);
  });

  it('labels the throttled response with a stable slug and a retry hint', async () => {
    app = await newApp({ blobRateLimitMax: 1 });
    const post = (n: number) =>
      app.inject({
        method: 'POST',
        url: '/v1/blob',
        headers: BINARY,
        payload: Buffer.from(`throttle-${n}`, 'utf8'),
      });

    await post(1);
    const throttled = await post(2);

    expect(throttled.statusCode).toBe(429);
    expect(throttled.json<{ error: string }>().error).toBe('rate_limited');
    expect(throttled.headers['retry-after']).toBeDefined();
  });
});

describe('framework-level failures', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it('reports a body past the hard transport limit as payload_too_large', async () => {
    app = await newApp();

    // Past the transport's own ceiling (maxBlobBytes * 2): Fastify aborts this one
    // itself, before the route's size check ever runs.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/blob',
      headers: BINARY,
      payload: Buffer.alloc(MAX_BLOB_BYTES * 2 + 1),
    });

    expect(res.statusCode).toBe(413);
    expect(res.json<{ error: string }>().error).toBe('payload_too_large');
    expect(app.db.countBlobs()).toBe(0);
  });
});

describe('server lifecycle', () => {
  it('releases the database and is safe to close twice', async () => {
    const app = await newApp();

    await app.close();
    expect(app.db.closed).toBe(true);
    await expect(app.close()).resolves.toBeUndefined();
  });

  it('never starts the indexer when it is disabled', async () => {
    const app = await newApp({ indexerEnabled: false, anchorsAddress: `0x${'ab'.repeat(20)}` });

    expect(app.indexer.status().running).toBe(false);
    expect(app.indexer.status().enabled).toBe(false);

    await app.close();
  });
});
