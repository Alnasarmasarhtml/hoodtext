/**
 * The send path under simultaneous load.
 *
 * The property that matters is conservation: a drop the relay answered 200 for
 * must reach the chain exactly once — not zero times (the web client shows it as
 * sent and it never lands), not twice (the sender pays room rent twice and the
 * recipient sees a duplicate message). Everything here races submissions against
 * flushes and then reconciles the two sets by `blobRef`, which is unique per drop.
 */

import { deriveIdentity, seal, signDrop } from '@hoodgram/crypto';
import type { IdentityKeys, SignableDrop } from '@hoodgram/crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SendPipeline, MAX_BATCH } from '../sender.js';
import { buildServer } from '../server.js';
import { silentLogger } from './helpers.js';
import {
  drain,
  duplicatesOf,
  LaggyGate,
  macrotick,
  RecordingPoster,
  signBatch,
  trapUnhandledRejections,
  ZERO_CONVO,
  type SignedDrop,
} from './concurrency-helpers.js';

const ALICE = '0x00000000000000000000000000000000000000a1' as const;

function pubHex(identity: IdentityKeys): `0x${string}` {
  return `0x${Buffer.from(identity.ed25519.publicKey).toString('hex')}`;
}

describe('SendPipeline: simultaneous submissions', () => {
  let identity: IdentityKeys;
  let gate: LaggyGate;
  let poster: RecordingPoster;

  beforeEach(async () => {
    identity = await deriveIdentity(`0x${'aa'.repeat(65)}`);
    gate = new LaggyGate();
    gate.keys.set(ALICE, pubHex(identity));
    gate.activated.add(ALICE);
    poster = new RecordingPoster();
  });

  function pipelineWith(queueMax: number, flushMs = 60_000): SendPipeline {
    return new SendPipeline({ gate, poster, log: silentLogger(), flushMs, queueMax });
  }

  /**
   * Submits everything at once and records, in resolution order, which drops the
   * relay accepted. `submit()` pushes onto the queue as its final synchronous
   * act, so the order these `.then` callbacks fire in is the queue's own order —
   * which is what lets the FIFO assertions below be exact rather than hopeful.
   */
  async function submitAll(
    pipeline: SendPipeline,
    signed: readonly SignedDrop[],
  ): Promise<{ accepted: string[]; rejected: string[] }> {
    const accepted: string[] = [];
    const rejected: string[] = [];
    await Promise.all(
      signed.map(({ drop, signature }) =>
        pipeline.submit(ALICE, drop, signature).then((result) => {
          if (result.ok) accepted.push(drop.blobRef);
          else rejected.push(result.code);
        }),
      ),
    );
    return { accepted, rejected };
  }

  it('anchors every accepted drop exactly once when 240 submissions race', async () => {
    const pipeline = pipelineWith(1_000);
    const signed = await signBatch(identity, 240);
    poster.delayMs = 1;

    const { accepted, rejected } = await submitAll(pipeline, signed);
    expect(rejected).toEqual([]);
    expect(accepted).toHaveLength(240);
    expect(pipeline.size()).toBe(240);

    await drain(pipeline);

    const anchored = poster.anchoredRefs();
    expect(duplicatesOf(anchored)).toEqual([]);
    expect(anchored).toHaveLength(240);
    expect([...anchored].sort()).toEqual([...accepted].sort());
    // Two posts in flight at once would mean two batches spliced from one queue.
    expect(poster.maxConcurrent).toBe(1);
    // 240 drops, 64 per transaction.
    expect(poster.calls).toBe(Math.ceil(240 / MAX_BATCH));
  });

  it('loses nothing when the flush timer fires while submissions are still landing', async () => {
    // A 1ms flush against a 1ms post means a batch is almost always in flight
    // while new submissions are being verified and pushed.
    const pipeline = pipelineWith(1_000, 1);
    poster.delayMs = 1;
    const signed = await signBatch(identity, 160);

    pipeline.start();
    const { accepted } = await submitAll(pipeline, signed);
    // `quiet` is load-bearing here: the interval's own flush can hold a spliced
    // batch in flight while `size()` already reads 0.
    await drain(pipeline, { quiet: () => poster.inFlight === 0 });
    await pipeline.stop();

    const anchored = poster.anchoredRefs();
    expect(duplicatesOf(anchored)).toEqual([]);
    expect([...anchored].sort()).toEqual([...accepted].sort());
    expect(anchored).toHaveLength(160);
    expect(poster.maxConcurrent).toBe(1);
  });

  it('preserves submission order across an in-flight batch', async () => {
    const pipeline = pipelineWith(1_000);
    poster.delayMs = 2;
    const signed = await signBatch(identity, 150);

    const { accepted } = await submitAll(pipeline, signed);
    await drain(pipeline);

    // FIFO: `flushNow` splices from the head, so the chain order must be the
    // queue order. A drop overtaking another here would mean a message arriving
    // before the one it replies to.
    expect(poster.anchoredRefs()).toEqual(accepted);
  });

  it('admits exactly queueMax under a simultaneous burst and rejects the rest as queue_full', async () => {
    const pipeline = pipelineWith(16);
    const signed = await signBatch(identity, 64);

    const { accepted, rejected } = await submitAll(pipeline, signed);

    expect(accepted).toHaveLength(16);
    expect(rejected).toHaveLength(48);
    expect(new Set(rejected)).toEqual(new Set(['queue_full']));
    expect(pipeline.size()).toBe(16);
    // No two accepted submissions may be told they hold the same queue slot.
    expect(duplicatesOf(accepted)).toEqual([]);
  });

  it('hands out each queue position exactly once when the cap is contested', async () => {
    const pipeline = pipelineWith(16);
    const signed = await signBatch(identity, 64);

    const positions: number[] = [];
    await Promise.all(
      signed.map(({ drop, signature }) =>
        pipeline.submit(ALICE, drop, signature).then((result) => {
          if (result.ok) positions.push(result.queued);
        }),
      ),
    );

    // `queued` is the caller's slot; a duplicate or a gap would mean the capacity
    // check and the push were not atomic with respect to each other.
    expect([...positions].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 16 }, (_, i) => i + 1),
    );
  });

  it('re-opens the queue as a flush drains it, without over-admitting', async () => {
    const pipeline = pipelineWith(MAX_BATCH);
    poster.delayMs = 1;
    const first = await signBatch(identity, MAX_BATCH);

    const wave1 = await submitAll(pipeline, first);
    expect(wave1.accepted).toHaveLength(MAX_BATCH);

    // Full: everything in a second wave must bounce.
    const blocked = await pipeline.submit(
      ALICE,
      first[0]?.drop as SignableDrop,
      first[0]?.signature as `0x${string}`,
    );
    expect(blocked).toMatchObject({ ok: false, code: 'queue_full' });

    await drain(pipeline);
    expect(pipeline.size()).toBe(0);

    const wave2 = await submitAll(pipeline, first);
    expect(wave2.accepted).toHaveLength(MAX_BATCH);
    expect(wave2.rejected).toEqual([]);
  });

  it('never double-anchors a batch that failed and was retried', async () => {
    const pipeline = pipelineWith(400);
    poster.delayMs = 2;
    poster.failOn.add(0); // the first transaction reverts

    const signed = await signBatch(identity, 100);
    const accepted: string[] = [];
    await Promise.all(
      signed.map(({ drop, signature }) =>
        pipeline.submit(ALICE, drop, signature).then((result) => {
          if (result.ok) accepted.push(drop.blobRef);
        }),
      ),
    );

    const room = `0x${'cc'.repeat(32)}` as const;
    gate.activeRooms.add(room);
    // Signed up front: signing inside the in-flight window would only add noise.
    const late = await signBatch(identity, 5, room, 1_000);

    const failing = pipeline.flushNow();
    // Land more work while the doomed batch is in flight; it must queue *behind*
    // the batch that is about to be restored, not in front of it.
    for (const { drop, signature } of late) {
      const result = await pipeline.submit(ALICE, drop, signature);
      expect(result.ok).toBe(true);
      accepted.push(drop.blobRef);
    }
    await failing;

    expect(poster.batches).toHaveLength(0);
    expect(pipeline.size()).toBe(105);

    // The pipeline backs off 2s after a failed post; nothing is attempted inside
    // that window, so waiting it out is the only honest way to observe the retry.
    await macrotick(2_100);
    await drain(pipeline);

    const anchored = poster.anchoredRefs();
    expect(duplicatesOf(anchored)).toEqual([]);
    expect(anchored).toHaveLength(105);
    expect(anchored).toEqual(accepted);
    // The failed batch was attempted twice but anchored once.
    expect(poster.attempted.length).toBeGreaterThan(poster.batches.length);
  }, 15_000);

  it('rejects an unverifiable submission without consuming a queue slot, even in a burst', async () => {
    const pipeline = pipelineWith(8);
    const mallory = await deriveIdentity(`0x${'bb'.repeat(65)}`);
    const good = await signBatch(identity, 8);
    const forged = await Promise.all(
      good.map(async ({ drop }) => ({
        drop,
        signature: await signDrop(drop, mallory.ed25519.privateKey),
      })),
    );

    const results = await Promise.all([
      ...forged.map(({ drop, signature }) => pipeline.submit(ALICE, drop, signature)),
      ...good.map(({ drop, signature }) => pipeline.submit(ALICE, drop, signature)),
    ]);

    const codes = results.filter((r) => !r.ok).map((r) => (r.ok ? '' : r.code));
    // All eight forgeries bounce on the signature, and every honest drop still
    // finds room: a forged burst must not be able to squeeze out real traffic.
    expect(codes).toEqual(Array.from({ length: 8 }, () => 'bad_signature'));
    expect(pipeline.size()).toBe(8);
  });
});

describe('POST /v1/send: simultaneous HTTP submissions', () => {
  let app: FastifyInstance;
  let gate: LaggyGate;
  let poster: RecordingPoster;
  let identity: IdentityKeys;

  /** A real sealed blob plus the signed drop that references it. */
  async function sealed(index: number): Promise<{
    drop: SignableDrop;
    signature: `0x${string}`;
    blob: Uint8Array;
  }> {
    const envelope = await seal(
      { v: 1, t: 1_700_000_000_000 + index, kind: 'text', body: `burst ${index}` },
      identity.x25519.publicKey,
    );
    const drop: SignableDrop = {
      convoId: ZERO_CONVO,
      ephPub: envelope.ephPub,
      blobRef: envelope.blobRef,
      viewTag: envelope.viewTag,
      size: envelope.size,
    };
    return {
      drop,
      signature: await signDrop(drop, identity.ed25519.privateKey),
      blob: envelope.blob,
    };
  }

  async function build(sendQueueMax: number): Promise<FastifyInstance> {
    return buildServer({
      env: {},
      config: {
        dbPath: ':memory:',
        indexerEnabled: false,
        logLevel: 'silent',
        blobRateLimitMax: 100_000,
        sendQueueMax,
        sendFlushMs: 60_000,
      },
      sendPorts: { gate, poster },
    });
  }

  beforeEach(async () => {
    identity = await deriveIdentity(`0x${'aa'.repeat(65)}`);
    gate = new LaggyGate();
    gate.keys.set(ALICE, pubHex(identity));
    gate.activated.add(ALICE);
    poster = new RecordingPoster();
  });

  afterEach(async () => {
    await app.close();
  });

  it('anchors every 200-accepted send exactly once when 48 requests arrive together', async () => {
    app = await build(1_000);
    const messages = await Promise.all(Array.from({ length: 48 }, (_, i) => sealed(i)));
    await Promise.all(
      messages.map(({ blob }) =>
        app.inject({
          method: 'POST',
          url: '/v1/blob',
          payload: Buffer.from(blob),
          headers: { 'content-type': 'application/octet-stream' },
        }),
      ),
    );

    const accepted: string[] = [];
    await Promise.all(
      messages.map(({ drop, signature }) =>
        app
          .inject({
            method: 'POST',
            url: '/v1/send',
            payload: JSON.stringify({ sender: ALICE, signature, drop }),
            headers: { 'content-type': 'application/json' },
          })
          .then((response) => {
            if (response.statusCode === 200) accepted.push(drop.blobRef);
          }),
      ),
    );

    expect(accepted).toHaveLength(48);
    await drain(app.sendPipeline);

    const anchored = poster.anchoredRefs();
    expect(duplicatesOf(anchored)).toEqual([]);
    expect([...anchored].sort()).toEqual([...accepted].sort());
  });

  it('answers 429 queue_full for exactly the overflow of a simultaneous burst', async () => {
    app = await build(8);
    const messages = await Promise.all(Array.from({ length: 32 }, (_, i) => sealed(i)));
    await Promise.all(
      messages.map(({ blob }) =>
        app.inject({
          method: 'POST',
          url: '/v1/blob',
          payload: Buffer.from(blob),
          headers: { 'content-type': 'application/octet-stream' },
        }),
      ),
    );

    const responses = await Promise.all(
      messages.map(({ drop, signature }) =>
        app.inject({
          method: 'POST',
          url: '/v1/send',
          payload: JSON.stringify({ sender: ALICE, signature, drop }),
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const ok = responses.filter((r) => r.statusCode === 200);
    const full = responses.filter((r) => r.statusCode === 429);
    expect(ok).toHaveLength(8);
    expect(full).toHaveLength(24);
    // 429 is also the rate-limiter's status; the slug is what a client keys on,
    // and a queue rejection must never be mistaken for a throttle.
    for (const response of full) {
      expect(response.json()).toMatchObject({ error: 'queue_full' });
    }
    expect(app.sendPipeline.size()).toBe(8);
  });

  it('serves reads and rejects the 409 blob-missing path while a send burst is in flight', async () => {
    app = await build(1_000);
    const trap = trapUnhandledRejections();
    try {
      const messages = await Promise.all(Array.from({ length: 24 }, (_, i) => sealed(i)));
      // Deliberately upload only half the blobs: the unuploaded half must 409 and
      // must not disturb the accepted half's accounting.
      const uploaded = messages.slice(0, 12);
      await Promise.all(
        uploaded.map(({ blob }) =>
          app.inject({
            method: 'POST',
            url: '/v1/blob',
            payload: Buffer.from(blob),
            headers: { 'content-type': 'application/octet-stream' },
          }),
        ),
      );

      const mixed = await Promise.all([
        ...messages.map(({ drop, signature }) =>
          app.inject({
            method: 'POST',
            url: '/v1/send',
            payload: JSON.stringify({ sender: ALICE, signature, drop }),
            headers: { 'content-type': 'application/json' },
          }),
        ),
        ...Array.from({ length: 20 }, () => app.inject({ method: 'GET', url: '/v1/stats' })),
        ...Array.from({ length: 20 }, () => app.inject({ method: 'GET', url: '/v1/drops' })),
        ...Array.from({ length: 20 }, () => app.inject({ method: 'GET', url: '/v1/health' })),
      ]);

      expect(mixed.filter((r) => r.statusCode >= 500)).toEqual([]);
      expect(mixed.filter((r) => r.statusCode === 200)).toHaveLength(72);
      expect(mixed.filter((r) => r.statusCode === 409)).toHaveLength(12);
      expect(app.sendPipeline.size()).toBe(12);
      await macrotick(5);
      expect(trap.seen).toEqual([]);
    } finally {
      trap.restore();
    }
  });
});
