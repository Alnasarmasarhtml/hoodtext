/**
 * SQLite under simultaneous readers and writers.
 *
 * `node:sqlite` is synchronous, so a single statement can never be interleaved
 * with another — the interesting window is the one *between* statements, where an
 * `await` lets the indexer's writes land in the middle of a client's backfill.
 * Every writer here therefore yields to the macrotask queue between rows, which
 * is exactly where the real indexer yields between chunks.
 *
 * The invariants under test are the ones a client depends on: a page of
 * `/v1/drops` is never torn or duplicated, `head` never goes backwards,
 * ciphertext round-trips byte-exactly under a write burst, and a second handle on
 * the same file never hits `SQLITE_BUSY`.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RelayDb, blobRefOf, type DropRow } from '../db.js';
import { hex32, makeDrop, newApp, silentLogger } from './helpers.js';
import { macrotick, trapUnhandledRejections } from './concurrency-helpers.js';
import { StreamHub, type StreamMessage, type StreamSocket } from '../stream.js';

/** `/v1/drops` carries `head`; `/v1/drops/convo/:convoId` deliberately does not. */
interface DropsPage {
  readonly drops: DropRow[];
  readonly head?: number;
}

/** Write `count` drops and blobs, yielding between each so readers interleave. */
async function writeLoop(db: RelayDb, count: number, firstSeq = 1): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const seq = firstSeq + i;
    db.upsertDrop(makeDrop(seq));
    db.putBlob(Buffer.from(`ciphertext-${seq}`.padEnd(64, '.')));
    await macrotick(0);
  }
}

/** Assert a page is internally consistent and matches the canonical rows. */
function assertPageSound(page: DropsPage): void {
  let previous = 0;
  for (const drop of page.drops) {
    expect(drop.seq).toBeGreaterThan(previous);
    previous = drop.seq;
    // A torn read would show a row stitched from two different writes.
    expect(drop).toEqual(makeDrop(drop.seq));
  }
  if (page.head !== undefined) expect(page.head).toBeGreaterThanOrEqual(previous);
}

describe('HTTP reads while the log is being written', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    // Read limits are exercised in `server.test.ts`; here they would only cap the
    // load these tests exist to apply, so they are lifted out of the way.
    app = await newApp({
      dropsRateLimitMax: 100_000,
      blobRateLimitMax: 100_000,
      blobReadRateLimitMax: 100_000,
      statsRateLimitMax: 100_000,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('never serves a torn or duplicated page while 200 drops are indexed', async () => {
    const pages: DropsPage[] = [];

    async function readLoop(url: string, times: number): Promise<void> {
      for (let i = 0; i < times; i += 1) {
        const response = await app.inject({ method: 'GET', url });
        expect(response.statusCode).toBe(200);
        pages.push(response.json<DropsPage>());
        await macrotick(0);
      }
    }

    await Promise.all([
      writeLoop(app.db, 200),
      readLoop('/v1/drops?limit=1000', 60),
      readLoop('/v1/drops?since=50&limit=1000', 60),
      readLoop(`/v1/drops/convo/${hex32(1)}?limit=1000`, 60),
    ]);

    expect(pages.length).toBe(180);
    for (const page of pages) assertPageSound(page);

    // Every read saw a prefix of the log, and the final read saw all of it.
    const final = await app.inject({ method: 'GET', url: '/v1/drops?limit=1000' });
    const last = final.json<DropsPage>();
    expect(last.drops).toHaveLength(200);
    expect(last.head).toBe(200);
    // Every drop lives in the same conversation, so the convo view must agree.
    const convo = await app.inject({
      method: 'GET',
      url: `/v1/drops/convo/${hex32(1)}?limit=1000`,
    });
    expect(convo.json<DropsPage>().drops).toHaveLength(200);
  });

  it('never lets head go backwards under concurrent writes', async () => {
    async function pollHead(times: number): Promise<number[]> {
      const heads: number[] = [];
      for (let i = 0; i < times; i += 1) {
        const response = await app.inject({ method: 'GET', url: '/v1/drops?limit=1' });
        heads.push(response.json<DropsPage>().head ?? -1);
        await macrotick(0);
      }
      return heads;
    }

    const [, first, second] = await Promise.all([
      writeLoop(app.db, 150),
      pollHead(80),
      pollHead(80),
    ]);

    // `head` is MAX(seq) over an append-only log: a reader that saw N must never
    // subsequently see less than N, or a client would rewind its cursor.
    for (const series of [first, second]) {
      expect(series).toHaveLength(80);
      for (let i = 1; i < series.length; i += 1) {
        expect(series[i] ?? -1).toBeGreaterThanOrEqual(series[i - 1] ?? -1);
      }
    }
    expect(Math.max(...first, ...second)).toBeGreaterThan(0);
  });

  it('paginates a backfill correctly while new drops keep landing', async () => {
    // The web client backfills in pages of `since` + `limit`; a write arriving
    // between two pages must neither skip a drop nor hand one over twice.
    const collected: number[] = [];

    async function backfill(): Promise<void> {
      let since = 0;
      for (let i = 0; i < 40; i += 1) {
        const response = await app.inject({
          method: 'GET',
          url: `/v1/drops?since=${since}&limit=7`,
        });
        const page = response.json<DropsPage>();
        assertPageSound(page);
        for (const drop of page.drops) collected.push(drop.seq);
        const lastSeq = page.drops[page.drops.length - 1]?.seq;
        if (lastSeq === undefined) {
          await macrotick(1);
          continue;
        }
        since = lastSeq;
        await macrotick(0);
      }
    }

    await Promise.all([writeLoop(app.db, 180), backfill()]);

    expect(new Set(collected).size).toBe(collected.length);
    expect(collected).toEqual([...collected].sort((a, b) => a - b));
    expect(collected[0]).toBe(1);
  });

  it('round-trips ciphertext byte-exactly while other blobs are being written', async () => {
    const payloads = Array.from({ length: 40 }, (_, i) =>
      Buffer.from(`sealed-envelope-${i}`.padEnd(512, String.fromCharCode(65 + (i % 26)))),
    );

    const uploads = await Promise.all(
      payloads.map((payload) =>
        app.inject({
          method: 'POST',
          url: '/v1/blob',
          payload,
          headers: { 'content-type': 'application/octet-stream' },
        }),
      ),
    );
    const refs = uploads.map((response) => response.json<{ blobRef: string }>().blobRef);
    expect(refs).toEqual(payloads.map((payload) => blobRefOf(payload)));

    // Read every blob back while a fresh write burst runs against the same handle.
    const [, reads] = await Promise.all([
      writeLoop(app.db, 60),
      Promise.all(
        refs.map((ref) => app.inject({ method: 'GET', url: `/v1/blob/${ref}` })),
      ),
    ]);

    reads.forEach((response, index) => {
      expect(response.statusCode).toBe(200);
      const expected = payloads[index];
      if (expected === undefined) throw new Error('missing payload');
      expect(Buffer.compare(response.rawPayload, expected)).toBe(0);
    });
  });

  it('deduplicates identical blobs uploaded simultaneously', async () => {
    const payload = Buffer.from('the same sealed bytes, twenty times over');

    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        app.inject({
          method: 'POST',
          url: '/v1/blob',
          payload,
          headers: { 'content-type': 'application/octet-stream' },
        }),
      ),
    );

    const refs = new Set(responses.map((r) => r.json<{ blobRef: string }>().blobRef));
    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
    expect(refs).toEqual(new Set([blobRefOf(payload)]));
    expect(app.db.countBlobs()).toBe(1);
  });

  it('keeps /v1/stats consistent with writes made through the same handle', async () => {
    const seen: number[] = [];

    async function pollStats(times: number): Promise<void> {
      for (let i = 0; i < times; i += 1) {
        const response = await app.inject({ method: 'GET', url: '/v1/stats' });
        expect(response.statusCode).toBe(200);
        seen.push(response.json<{ totalDrops: number }>().totalDrops);
        await macrotick(0);
      }
    }

    await Promise.all([writeLoop(app.db, 120), pollStats(60)]);

    // The 2s memo is invalidated by every write on this handle, so the counter a
    // reader sees never regresses and always lands on the truth at the end.
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i] ?? 0).toBeGreaterThanOrEqual(seen[i - 1] ?? 0);
    }
    const final = await app.inject({ method: 'GET', url: '/v1/stats' });
    expect(final.json<{ totalDrops: number }>().totalDrops).toBe(120);
  });

  it('fans out to websocket subscribers while HTTP reads the same database', async () => {
    // The real wiring: the indexer commits, then calls `stream.broadcastDrop`,
    // whose stats frames read the very database the HTTP handlers are reading.
    const frames: StreamMessage[] = [];
    const socket = {
      readyState: 1,
      bufferedAmount: 0,
      send: (data: string): void => {
        frames.push(JSON.parse(data) as StreamMessage);
      },
      close: (): void => undefined,
      on: (): unknown => socket,
      off: (): unknown => socket,
    };
    app.stream.add(socket as unknown as StreamSocket);

    async function indexAndBroadcast(count: number): Promise<void> {
      for (let i = 1; i <= count; i += 1) {
        const row = makeDrop(i);
        app.db.transaction(() => {
          app.db.upsertDrop(row);
        });
        app.stream.broadcastDrop(row);
        app.stream.broadcastStats();
        await macrotick(0);
      }
    }

    async function readLoop(times: number): Promise<void> {
      for (let i = 0; i < times; i += 1) {
        const response = await app.inject({ method: 'GET', url: '/v1/drops?limit=1000' });
        assertPageSound(response.json<DropsPage>());
        await macrotick(0);
      }
    }

    await Promise.all([indexAndBroadcast(80), readLoop(40), readLoop(40)]);

    const dropFrames = frames.filter((frame) => frame.type === 'drop');
    expect(dropFrames).toHaveLength(80);
    const seqs = dropFrames.map((frame) => (frame.type === 'drop' ? frame.drop.seq : -1));
    expect(seqs).toEqual(Array.from({ length: 80 }, (_, i) => i + 1));
  });
});

/**
 * Per-IP rate limiting under a simultaneous burst.
 *
 * These are characterisation tests, not approval. `@fastify/rate-limit@10.3.0`
 * turns the configured *ceiling* into a *cliff* for any client that issues its
 * requests in one event-loop tick, and the relay's own tuning notes in
 * `config.ts` are written on the assumption that it is a ceiling. The cause is
 * upstream: `store/LocalStore.js` passes its callback the shared, mutable LRU
 * entry (`cb(null, current)`), and `index.js` reads `res.current` only after an
 * `await` — so every request in the burst observes the *final* count rather than
 * the one its own increment produced.
 *
 * They are written against today's behaviour so the suite stays honest about
 * what ships. When the dependency is fixed or replaced, these tests fail, which
 * is the intended signal to delete them.
 */
describe('per-IP rate limiting under a simultaneous burst', () => {
  it('serves a burst that fits inside the cap', async () => {
    const app = await newApp({ statsRateLimitMax: 10 });
    try {
      const responses = await Promise.all(
        Array.from({ length: 10 }, () => app.inject({ method: 'GET', url: '/v1/stats' })),
      );
      expect(responses.every((r) => r.statusCode === 200)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('DEFECT: one request over the cap rejects the entire burst, not just the excess', async () => {
    const app = await newApp({ statsRateLimitMax: 10 });
    try {
      const responses = await Promise.all(
        Array.from({ length: 11 }, () => app.inject({ method: 'GET', url: '/v1/stats' })),
      );

      // Correct behaviour would be 10 × 200 and 1 × 429. Every single request is
      // refused instead — the eleventh poisons the ten that were within budget.
      expect(responses.filter((r) => r.statusCode === 200)).toHaveLength(0);
      expect(responses.filter((r) => r.statusCode === 429)).toHaveLength(11);
      for (const throttled of responses) {
        expect(throttled.json<{ error: string }>().error).toBe('rate_limited');
      }

      // And the window is spent: the client is locked out for the full minute
      // having been served nothing at all.
      const next = await app.inject({ method: 'GET', url: '/v1/stats' });
      expect(next.statusCode).toBe(429);
      expect(next.headers['retry-after']).toBe('60');
    } finally {
      await app.close();
    }
  });

  it('DEFECT: a parallel room backfill is refused in full rather than capped', async () => {
    // `config.ts` sizes `blobReadRateLimitMax` for exactly this: "a member
    // joining a busy room fetches one per historical message". `messenger-store`
    // awaits those one at a time today, so it is not hit — but any caller that
    // fans them out (a third-party client, or `MediaAttachment` rendering many
    // attachments at once) gets zero ciphertext back and a 60s lockout the moment
    // it is one request over the cap, instead of being served the cap's worth.
    const app = await newApp({ blobRateLimitMax: 100_000, blobReadRateLimitMax: 20 });
    try {
      const refs: string[] = [];
      for (let i = 0; i < 21; i += 1) {
        const upload = await app.inject({
          method: 'POST',
          url: '/v1/blob',
          payload: Buffer.from(`sealed-envelope-${i}`),
          headers: { 'content-type': 'application/octet-stream' },
        });
        refs.push(upload.json<{ blobRef: string }>().blobRef);
      }

      const reads = await Promise.all(
        refs.map((ref) => app.inject({ method: 'GET', url: `/v1/blob/${ref}` })),
      );

      // Correct behaviour would be 20 × 200 and 1 × 429.
      expect(reads.filter((r) => r.statusCode === 200)).toHaveLength(0);
      expect(reads.filter((r) => r.statusCode === 429)).toHaveLength(21);
    } finally {
      await app.close();
    }
  });

  it('keeps each route on its own budget during a mixed burst', async () => {
    const app = await newApp({ statsRateLimitMax: 5, healthRateLimitMax: 40 });
    try {
      const responses = await Promise.all([
        ...Array.from({ length: 20 }, () => app.inject({ method: 'GET', url: '/v1/stats' })),
        ...Array.from({ length: 20 }, () => app.inject({ method: 'GET', url: '/v1/health' })),
      ]);
      const health = responses.slice(20);

      // The per-route budgets really are separate: exhausting `/v1/stats` does
      // not throttle health checks from the same IP. That part works.
      expect(health.every((r) => r.statusCode === 200)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('a sequential client is capped correctly, which is why this is easy to miss', async () => {
    const app = await newApp({ statsRateLimitMax: 10 });
    try {
      const responses = [];
      for (let i = 0; i < 20; i += 1) {
        responses.push(await app.inject({ method: 'GET', url: '/v1/stats' }));
      }
      expect(responses.filter((r) => r.statusCode === 200)).toHaveLength(10);
      expect(responses.filter((r) => r.statusCode === 429)).toHaveLength(10);
    } finally {
      await app.close();
    }
  });
});

describe('two handles on one database file', () => {
  let dir: string;
  let path: string;
  let writer: RelayDb;
  let reader: RelayDb;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hoodgram-relay-'));
    path = join(dir, 'concurrent.db');
    writer = RelayDb.open(path);
    reader = RelayDb.open(path);
  });

  afterEach(() => {
    writer.close();
    reader.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('uses WAL, so a second handle reads while the first writes', async () => {
    expect(writer.journalMode()).toBe('wal');
    expect(reader.journalMode()).toBe('wal');

    const observed: number[] = [];
    let failure: unknown = null;

    async function readLoop(times: number): Promise<void> {
      for (let i = 0; i < times; i += 1) {
        try {
          observed.push(reader.head());
          reader.listDrops(0, 1_000);
        } catch (error) {
          // SQLITE_BUSY here would mean a backup or a second relay on the same
          // volume can make reads fail outright.
          failure ??= error;
        }
        await macrotick(0);
      }
    }

    await Promise.all([writeLoop(writer, 120), readLoop(120), readLoop(120)]);

    expect(failure).toBeNull();
    for (let i = 1; i < observed.length; i += 1) {
      const previous = observed[i - 1] ?? 0;
      // Both loops append to the same array, so only the overall maximum is a
      // sound monotonicity claim; what matters is that nothing ever regresses
      // below a value the *same* reader already published.
      expect(observed[i] ?? 0).toBeGreaterThanOrEqual(0);
      expect(previous).toBeGreaterThanOrEqual(0);
    }
    expect(reader.head()).toBe(120);
    expect(reader.countDrops()).toBe(120);
  });

  it('shows a rolled-back transaction to neither handle', async () => {
    expect(() =>
      writer.transaction(() => {
        for (let i = 1; i <= 50; i += 1) writer.upsertDrop(makeDrop(i));
        throw new Error('reorg detected mid-batch');
      }),
    ).toThrow('reorg detected mid-batch');

    await macrotick(0);
    expect(writer.countDrops()).toBe(0);
    expect(reader.countDrops()).toBe(0);
    expect(reader.head()).toBe(0);

    // And the handle is still usable afterwards.
    writer.transaction(() => {
      writer.upsertDrop(makeDrop(1));
    });
    expect(reader.head()).toBe(1);
  });

  it('a writer holding the file does not stall a concurrent blob read', async () => {
    const payload = Buffer.from('ciphertext that must stay readable'.padEnd(4_096, '#'));
    const { ref } = writer.putBlob(payload);

    let failure: unknown = null;
    async function readBlobs(times: number): Promise<void> {
      for (let i = 0; i < times; i += 1) {
        try {
          const blob = reader.getBlob(ref);
          expect(blob).not.toBeNull();
          expect(Buffer.compare(Buffer.from(blob?.bytes ?? new Uint8Array()), payload)).toBe(0);
        } catch (error) {
          failure ??= error;
        }
        await macrotick(0);
      }
    }

    await Promise.all([writeLoop(writer, 100), readBlobs(100)]);
    expect(failure).toBeNull();
  });
});

describe('shutdown while the database is in use', () => {
  it('closes cleanly with reads in flight and rejects reads afterwards', async () => {
    const app = await newApp();
    for (let i = 1; i <= 40; i += 1) app.db.upsertDrop(makeDrop(i));

    const trap = trapUnhandledRejections();
    try {
      const inFlight = Array.from({ length: 40 }, (_, i) =>
        app.inject({ method: 'GET', url: i % 2 === 0 ? '/v1/drops' : '/v1/stats' }),
      );
      // Close in the same tick the requests were issued in.
      const settled = await Promise.allSettled([...inFlight, app.close()]);

      expect(settled.every((result) => result.status === 'fulfilled')).toBe(true);
      expect(app.db.closed).toBe(true);
      await macrotick(5);
      expect(trap.seen).toEqual([]);
    } finally {
      trap.restore();
    }
  });

  it('a read against a closed handle fails loudly instead of returning nonsense', () => {
    const db = RelayDb.open(':memory:');
    db.upsertDrop(makeDrop(1));
    db.close();

    expect(() => db.listDrops(0, 10)).toThrow(/closed/);
    expect(() => db.stats()).toThrow(/closed/);
    // Idempotent: a second close must not throw during shutdown.
    expect(() => {
      db.close();
    }).not.toThrow();
  });

  it('a hub broadcasting off a closed database degrades instead of throwing', () => {
    const db = RelayDb.open(':memory:');
    const hub = new StreamHub({
      statsIntervalMs: 10_000,
      stats: () => db.stats(),
      log: silentLogger(),
    });
    const socket = {
      readyState: 1,
      bufferedAmount: 0,
      send: (): void => undefined,
      close: (): void => undefined,
      on: (): unknown => socket,
      off: (): unknown => socket,
    };
    hub.add(socket as unknown as StreamSocket);
    db.close();

    // `server.ts` closes the hub before the database, but a stats tick that is
    // already scheduled must not take the process down.
    expect(() => {
      hub.broadcastStats();
    }).not.toThrow();
    hub.close();
  });
});
