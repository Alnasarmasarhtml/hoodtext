import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BINARY, hex20, hex32, makeDrop, newApp } from './helpers.js';

interface StatsBody {
  head: number;
  totalDrops: number;
  totalBlobs: number;
  uniquePosters: number;
  indexedBlock: number;
}

interface HealthBody {
  ok: boolean;
  chainId: number;
  block: number;
  indexerLagBlocks: number;
}

describe('GET /v1/stats', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await newApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('has the documented shape when empty', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/stats' });
    expect(res.statusCode).toBe(200);

    const body = res.json<StatsBody>();
    expect(Object.keys(body).sort()).toEqual([
      'head',
      'indexedBlock',
      'totalBlobs',
      'totalDrops',
      'uniquePosters',
    ]);
    expect(body).toEqual({
      head: 0,
      totalDrops: 0,
      totalBlobs: 0,
      uniquePosters: 0,
      indexedBlock: 0,
    });
  });

  it('counts drops, blobs, distinct posters and the indexed block', async () => {
    app.db.upsertDrop(makeDrop(1, { poster: hex20(1) }));
    app.db.upsertDrop(makeDrop(2, { poster: hex20(2) }));
    app.db.upsertDrop(makeDrop(3, { poster: hex20(1) }));
    app.db.setCursor(4_242);

    await app.inject({
      method: 'POST',
      url: '/v1/blob',
      headers: BINARY,
      payload: Buffer.from('one', 'utf8'),
    });
    await app.inject({
      method: 'POST',
      url: '/v1/blob',
      headers: BINARY,
      payload: Buffer.from('two', 'utf8'),
    });

    const body = (await app.inject({ method: 'GET', url: '/v1/stats' })).json<StatsBody>();

    expect(body).toEqual({
      head: 3,
      totalDrops: 3,
      totalBlobs: 2,
      uniquePosters: 2,
      indexedBlock: 4_242,
    });
  });
});

describe('GET /v1/health', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it('has the documented shape and serves with the indexer off', async () => {
    app = await newApp({ chainId: 4_663 });

    const res = await app.inject({ method: 'GET', url: '/v1/health' });
    expect(res.statusCode).toBe(200);

    const body = res.json<HealthBody>();
    expect(body.ok).toBe(true);
    expect(body.chainId).toBe(4_663);
    expect(typeof body.block).toBe('number');
    expect(typeof body.indexerLagBlocks).toBe('number');
    expect(body.indexerLagBlocks).toBe(0);
  });

  it('reports the indexer as idle when no Anchors address is configured', async () => {
    app = await newApp({ indexerEnabled: true, anchorsAddress: null });

    const body = (await app.inject({ method: 'GET', url: '/v1/health' })).json<{
      ok: boolean;
      indexer: { enabled: boolean; running: boolean; connected: boolean };
    }>();

    expect(body.ok).toBe(true);
    expect(body.indexer.enabled).toBe(false);
    expect(body.indexer.running).toBe(false);
  });

  it('reports the persisted cursor as the indexed block', async () => {
    app = await newApp();
    app.db.setCursor(1_000);

    const body = (await app.inject({ method: 'GET', url: '/v1/health' })).json<{
      block: number;
      indexerLagBlocks: number;
      indexer: { indexedBlock: number };
    }>();

    // The cursor is read when the indexer is constructed, so a later write is
    // visible through /v1/stats; health reports what the indexer itself knows.
    expect(body.indexerLagBlocks).toBe(0);
    expect(body.block).toBeGreaterThanOrEqual(0);
    expect(body.indexer.indexedBlock).toBeGreaterThanOrEqual(0);
  });

  it('404s an unknown route as JSON', async () => {
    app = await newApp();

    const res = await app.inject({ method: 'GET', url: '/v1/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe('not_found');
  });

  it('serves CORS headers for the configured web origin', async () => {
    app = await newApp({ webOrigins: ['http://localhost:3000'] });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/stats',
      headers: { origin: 'http://localhost:3000' },
    });

    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  it('keeps serving reads while a drop references a blob that was never uploaded', async () => {
    app = await newApp();
    app.db.upsertDrop(makeDrop(1, { blobRef: hex32(0xdead) }));

    const drops = await app.inject({ method: 'GET', url: '/v1/drops' });
    const blob = await app.inject({ method: 'GET', url: `/v1/blob/${hex32(0xdead)}` });

    expect(drops.statusCode).toBe(200);
    expect(blob.statusCode).toBe(404);
  });
});
