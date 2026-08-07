/**
 * `flushNow()` re-entrancy.
 *
 * The flush is the only place the relay spends money and the only place a drop
 * can be anchored twice. Three callers can enter it at once — the interval timer,
 * `stop()`, and (in tests and on shutdown) an explicit call — while a batch is
 * already mid-transaction. These tests hold a batch open and then hammer the
 * entry point from every direction.
 *
 * They also pin down what `stop()` does *not* do, because that is where the
 * pipeline's guarantees actually end. See the notes on the last two tests.
 */

import { deriveIdentity } from '@hoodgram/crypto';
import type { IdentityKeys } from '@hoodgram/crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_BATCH, SendPipeline } from '../sender.js';
import { buildServer } from '../server.js';
import { silentLogger } from './helpers.js';
import {
  duplicatesOf,
  HeldPoster,
  LaggyGate,
  macrotick,
  RecordingPoster,
  signBatch,
  trapUnhandledRejections,
  type SignedDrop,
} from './concurrency-helpers.js';

const ALICE = '0x00000000000000000000000000000000000000a1' as const;

function pubHex(identity: IdentityKeys): `0x${string}` {
  return `0x${Buffer.from(identity.ed25519.publicKey).toString('hex')}`;
}

describe('SendPipeline.flushNow re-entrancy', () => {
  let identity: IdentityKeys;
  let gate: LaggyGate;
  let poster: HeldPoster;
  let pipeline: SendPipeline;
  let signed: SignedDrop[];

  beforeEach(async () => {
    identity = await deriveIdentity(`0x${'aa'.repeat(65)}`);
    gate = new LaggyGate();
    gate.keys.set(ALICE, pubHex(identity));
    gate.activated.add(ALICE);
    poster = new HeldPoster();
    pipeline = new SendPipeline({
      gate,
      poster,
      log: silentLogger(),
      flushMs: 60_000,
      queueMax: 500,
    });
    signed = await signBatch(identity, 200);
  });

  /** Queues `signed[from..to)` and returns their refs in queue order. */
  async function queue(from: number, to: number): Promise<string[]> {
    const refs: string[] = [];
    for (let i = from; i < to; i += 1) {
      const entry = signed[i];
      if (entry === undefined) throw new Error(`no signed drop at ${i}`);
      const result = await pipeline.submit(ALICE, entry.drop, entry.signature);
      expect(result.ok).toBe(true);
      refs.push(entry.drop.blobRef);
    }
    return refs;
  }

  it('posts once when eight flushes enter together', async () => {
    await queue(0, 10);

    const flushes = Array.from({ length: 8 }, () => pipeline.flushNow());
    await poster.arrived(1);
    // Seven of the eight found the pipeline busy; only one transaction exists.
    expect(poster.received).toHaveLength(1);
    expect(poster.inFlight).toBe(1);

    poster.releaseAll();
    await Promise.all(flushes);

    expect(poster.posted).toHaveLength(1);
    expect(poster.posted[0]).toHaveLength(10);
    expect(pipeline.size()).toBe(0);
  });

  it('an overlapping flush returns immediately instead of waiting for the batch', async () => {
    await queue(0, 10);

    const first = pipeline.flushNow();
    await poster.arrived(1);

    // Documented behaviour, and a trap for callers: the second flush resolves
    // while the first transaction is still open, so awaiting `flushNow()` is not
    // a guarantee that the queue was flushed.
    const second = await Promise.race([
      pipeline.flushNow().then(() => 'returned' as const),
      macrotick(50).then(() => 'waited' as const),
    ]);
    expect(second).toBe('returned');
    expect(poster.inFlight).toBe(1);
    expect(poster.posted).toHaveLength(0);

    poster.releaseAll();
    await first;
  });

  it('the interval timer cannot start a second transaction while one is open', async () => {
    const timed = new SendPipeline({
      gate,
      poster,
      log: silentLogger(),
      flushMs: 1,
      queueMax: 500,
    });
    for (let i = 0; i < 5; i += 1) {
      const entry = signed[i];
      if (entry === undefined) throw new Error('missing signed drop');
      await timed.submit(ALICE, entry.drop, entry.signature);
    }

    timed.start();
    await poster.arrived(1);
    // ~50 ticks of a 1ms interval, all of them against an open transaction.
    await macrotick(50);
    expect(poster.received).toHaveLength(1);

    poster.releaseAll();
    await macrotick(5);
    await timed.stop();
    expect(poster.posted).toHaveLength(1);
  });

  it('never splices more than MAX_BATCH, however many flushes pile up', async () => {
    await queue(0, 200);

    const flushes = Array.from({ length: 6 }, () => pipeline.flushNow());
    await poster.arrived(1);
    poster.releaseAll();
    await Promise.all(flushes);

    for (const batch of poster.received) {
      expect(batch.length).toBeLessThanOrEqual(MAX_BATCH);
    }
    const seen = poster.posted.flat().map((drop) => drop.blobRef);
    expect(duplicatesOf(seen)).toEqual([]);
  });

  it('restores a failed batch exactly once when flushes pile up behind it', async () => {
    const refs = await queue(0, 100);

    poster.failNext = true;
    const flushes = Array.from({ length: 4 }, () => pipeline.flushNow());
    await poster.arrived(1);
    expect(poster.received).toHaveLength(1);

    poster.releaseAll();
    await Promise.all(flushes);

    // 100, not 164: the batch was put back once, not once per waiting flush.
    expect(pipeline.size()).toBe(100);
    expect(poster.posted).toHaveLength(0);

    // And the restored batch is still at the head, in its original order.
    const late = await signBatch(identity, 3, undefined, 5_000);
    for (const { drop, signature } of late) {
      await pipeline.submit(ALICE, drop, signature);
    }
    expect(pipeline.size()).toBe(103);
    expect(refs).toHaveLength(100);
  });

  it('does not double-post when a submission lands in the same turn as a flush', async () => {
    const recording = new RecordingPoster();
    recording.delayMs = 1;
    const racing = new SendPipeline({
      gate,
      poster: recording,
      log: silentLogger(),
      flushMs: 60_000,
      queueMax: 500,
    });

    // Submissions and flushes issued in the same tick, repeatedly.
    const work: Promise<unknown>[] = [];
    for (let i = 0; i < 120; i += 1) {
      const entry = signed[i];
      if (entry === undefined) throw new Error('missing signed drop');
      work.push(racing.submit(ALICE, entry.drop, entry.signature));
      if (i % 8 === 0) work.push(racing.flushNow());
    }
    await Promise.all(work);

    const deadline = Date.now() + 5_000;
    while ((racing.size() > 0 || recording.inFlight > 0) && Date.now() < deadline) {
      await racing.flushNow();
      await macrotick(1);
    }

    const anchored = recording.anchoredRefs();
    expect(duplicatesOf(anchored)).toEqual([]);
    expect(anchored).toHaveLength(120);
    expect(recording.maxConcurrent).toBe(1);
  });
});

/**
 * Shutdown. `stop()` is documented as "clears the flush timer and attempts one
 * final drain", and `server.ts` awaits it in `onClose` before closing the
 * database — so whatever `stop()` leaves behind is lost when the process exits.
 * The send queue lives only in memory; there is no journal to replay from.
 */
describe('SendPipeline.stop under an in-flight batch', () => {
  let identity: IdentityKeys;
  let gate: LaggyGate;
  let poster: HeldPoster;
  let pipeline: SendPipeline;
  let signed: SignedDrop[];

  beforeEach(async () => {
    identity = await deriveIdentity(`0x${'aa'.repeat(65)}`);
    gate = new LaggyGate();
    gate.keys.set(ALICE, pubHex(identity));
    gate.activated.add(ALICE);
    poster = new HeldPoster();
    pipeline = new SendPipeline({
      gate,
      poster,
      log: silentLogger(),
      flushMs: 60_000,
      queueMax: 500,
    });
    signed = await signBatch(identity, 20);
  });

  async function queue(from: number, to: number): Promise<void> {
    for (let i = from; i < to; i += 1) {
      const entry = signed[i];
      if (entry === undefined) throw new Error('missing signed drop');
      const result = await pipeline.submit(ALICE, entry.drop, entry.signature);
      expect(result.ok).toBe(true);
    }
  }

  it('DEFECT: stop() returns while a transaction is open and abandons later arrivals', async () => {
    await queue(0, 5);

    const flush = pipeline.flushNow();
    await poster.arrived(1);

    // Five more sends the relay has already answered 200 for.
    await queue(5, 10);
    expect(pipeline.size()).toBe(5);

    const outcome = await Promise.race([
      pipeline.stop().then(() => 'returned' as const),
      macrotick(100).then(() => 'waited' as const),
    ]);

    // `stop()` hits the `flushing` guard in `flushNow()` and returns at once, so
    // `onClose` proceeds to close the database and the process is free to exit
    // with a transaction still open and five accepted drops still queued.
    expect(outcome).toBe('returned');
    expect(poster.inFlight).toBe(1);
    expect(poster.posted).toHaveLength(0);
    expect(pipeline.size()).toBe(5);

    poster.releaseAll();
    await flush;
    // The five never reach the chain: nothing drains them after stop().
    expect(pipeline.size()).toBe(5);
    expect(poster.posted).toHaveLength(1);
  });

  it('DEFECT: stop() drains nothing while the backoff window is open', async () => {
    await queue(0, 5);

    poster.failNext = true;
    const flush = pipeline.flushNow();
    await poster.arrived(1);
    poster.releaseAll();
    await flush;

    // The batch was restored and a 2s backoff armed.
    expect(pipeline.size()).toBe(5);
    expect(poster.posted).toHaveLength(0);

    await pipeline.stop();

    // The "final drain" is a no-op inside the backoff window, so a relay
    // restarted after any RPC blip discards every accepted-but-unposted drop.
    expect(pipeline.size()).toBe(5);
    expect(poster.posted).toHaveLength(0);
    expect(poster.received).toHaveLength(1);
  });

  it('stop() twice concurrently is safe and posts the queue once', async () => {
    await queue(0, 5);

    const stops = Promise.all([pipeline.stop(), pipeline.stop()]);
    await poster.arrived(1);
    // The second `stop()` finds the first one's flush in progress and returns.
    expect(poster.received).toHaveLength(1);

    poster.releaseAll();
    await stops;
    expect(poster.posted).toHaveLength(1);
    expect(poster.posted[0]).toHaveLength(5);
    expect(pipeline.size()).toBe(0);
  });
});

describe('relay shutdown while the send pipeline is posting', () => {
  let app: FastifyInstance;
  let poster: HeldPoster;

  afterEach(async () => {
    poster.releaseAll();
    await macrotick(5);
  });

  it('app.close() resolves with a transaction open, without an unhandled rejection', async () => {
    const identity = await deriveIdentity(`0x${'aa'.repeat(65)}`);
    const gate = new LaggyGate();
    gate.keys.set(ALICE, pubHex(identity));
    gate.activated.add(ALICE);
    poster = new HeldPoster();

    app = await buildServer({
      env: {},
      config: {
        dbPath: ':memory:',
        indexerEnabled: false,
        logLevel: 'silent',
        sendFlushMs: 60_000,
      },
      sendPorts: { gate, poster },
    });

    const signed = await signBatch(identity, 3);
    for (const { drop, signature } of signed) {
      expect((await app.sendPipeline.submit(ALICE, drop, signature)).ok).toBe(true);
    }

    const flush = app.sendPipeline.flushNow();
    await poster.arrived(1);

    const trap = trapUnhandledRejections();
    try {
      await app.close();
      expect(app.db.closed).toBe(true);
      // The batch is still on the wire after the handle it was accepted through
      // is gone. Releasing it must not blow up the process.
      poster.releaseAll();
      await flush;
      await macrotick(10);
      expect(trap.seen).toEqual([]);
    } finally {
      trap.restore();
    }
  });
});
