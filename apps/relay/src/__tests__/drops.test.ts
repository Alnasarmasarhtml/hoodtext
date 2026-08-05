import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DropRow } from '../db.js';
import { hex20, hex32, makeDrop, newApp } from './helpers.js';

interface DropsPage {
  drops: DropRow[];
  head: number;
}

interface ConvoPage {
  drops: DropRow[];
}

describe('GET /v1/drops', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await newApp();
    for (let seq = 1; seq <= 10; seq += 1) {
      app.db.upsertDrop(makeDrop(seq));
    }
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns the whole log with the head seq', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/drops' });
    expect(res.statusCode).toBe(200);

    const body = res.json<DropsPage>();
    expect(body.head).toBe(10);
    expect(body.drops).toHaveLength(10);
    expect(body.drops.map((drop) => drop.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('returns a fully-populated DropRow', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/drops?since=4&limit=1' });
    const [drop] = res.json<DropsPage>().drops;

    expect(drop).toEqual({
      seq: 5,
      convoId: hex32(1),
      poster: hex20(1),
      ephPub: hex32(1_005),
      blobRef: hex32(2_005),
      viewTag: 5,
      size: 256,
      timestamp: 1_700_000_005,
      txHash: hex32(3_005),
      blockNumber: 105,
    });
  });

  it('pages strictly after `since`', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/drops?since=7' });
    const body = res.json<DropsPage>();

    expect(body.drops.map((drop) => drop.seq)).toEqual([8, 9, 10]);
    expect(body.head).toBe(10);
  });

  it('walks the whole log by paging with `since` and `limit`', async () => {
    const seen: number[] = [];
    let since = 0;

    for (let page = 0; page < 10; page += 1) {
      const res = await app.inject({ method: 'GET', url: `/v1/drops?since=${since}&limit=3` });
      const body = res.json<DropsPage>();
      if (body.drops.length === 0) break;
      for (const drop of body.drops) seen.push(drop.seq);
      const last = body.drops[body.drops.length - 1];
      if (last === undefined) break;
      since = last.seq;
    }

    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('returns an empty page past the head without erroring', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/drops?since=99' });

    expect(res.statusCode).toBe(200);
    expect(res.json<DropsPage>().drops).toEqual([]);
    expect(res.json<DropsPage>().head).toBe(10);
  });

  it('rejects a nonsense query', async () => {
    for (const query of [
      'since=-1',
      'limit=0',
      'limit=100000',
      'since=abc',
      'limit=1.5',
      'since=1e300',
    ]) {
      const res = await app.inject({ method: 'GET', url: `/v1/drops?${query}` });
      expect(res.statusCode, query).toBe(400);
      expect(res.json<{ error: string }>().error).toBe('invalid_query');
    }
  });
});

describe('GET /v1/drops/convo/:convoId', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await newApp();
    app.db.upsertDrop(makeDrop(1, { convoId: hex32(0xaa) }));
    app.db.upsertDrop(makeDrop(2, { convoId: hex32(0xbb) }));
    app.db.upsertDrop(makeDrop(3, { convoId: hex32(0xaa) }));
    app.db.upsertDrop(makeDrop(4, { convoId: hex32(0xaa) }));
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns only that conversation', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/drops/convo/${hex32(0xaa)}` });

    expect(res.statusCode).toBe(200);
    expect(res.json<ConvoPage>().drops.map((drop) => drop.seq)).toEqual([1, 3, 4]);
  });

  it('honours `since` within a conversation', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/drops/convo/${hex32(0xaa)}?since=1`,
    });

    expect(res.json<ConvoPage>().drops.map((drop) => drop.seq)).toEqual([3, 4]);
  });

  it('matches a mixed-case convo id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/drops/convo/${hex32(0xaa).toUpperCase().replace('0X', '0x')}`,
    });

    expect(res.json<ConvoPage>().drops).toHaveLength(3);
  });

  it('rejects a malformed convo id', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/drops/convo/0xdeadbeef' });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('invalid_convo_id');
  });

  it('returns an empty list for an unknown conversation', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/drops/convo/${hex32(0xcc)}` });

    expect(res.statusCode).toBe(200);
    expect(res.json<ConvoPage>().drops).toEqual([]);
  });
});
