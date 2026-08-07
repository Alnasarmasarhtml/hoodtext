/**
 * Regression cover for the silent-message-loss defect found by the on-chain proof
 * run.
 *
 * `Anchors.postBatch` is atomic and its only per-drop revert is `RoomInactive`.
 * A room whose rent lapsed inside `ROOM_TTL_MS` was still admitted by `submit()`
 * with `200 {"accepted":true}`, then reverted the batch it was in — over and over,
 * until `staleMs` discarded the poison drop *and every innocent drop batched with
 * it*. The proof run logged `evicted: 2` for one attacker-shaped drop and one
 * unrelated DM. Both senders were told their message was accepted.
 *
 * The property under test: **a drop the chain refuses must never be able to
 * destroy its batch-mates, and must never disappear without a record.** Its
 * mirror image matters just as much — an innocent drop must never be discarded on
 * a guess when the failure could not be attributed.
 */

import { deriveIdentity, seal, signDrop } from '@hoodgram/crypto';
import type { IdentityKeys, SignableDrop } from '@hoodgram/crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SendPipeline } from '../sender.js';
import type { BatchPoster, ChainGate } from '../sender.js';
import { buildServer } from '../server.js';
import { silentLogger } from './helpers.js';

const ALICE = '0x00000000000000000000000000000000000000a1' as const;
const ZERO_CONVO = `0x${'0'.repeat(64)}` as const;
/** The room whose rent lapses mid-flight — the poison. */
const DOOMED_ROOM = `0x${'ab'.repeat(32)}` as const;
/** An unrelated room that stays paid up. */
const HEALTHY_ROOM = `0x${'cd'.repeat(32)}` as const;

/** Records every rent read so the tests can assert cache behaviour. */
class FakeGate implements ChainGate {
  keys = new Map<string, `0x${string}`>();
  activated = new Set<string>();
  activeRooms = new Set<string>();
  /** `[groupId, fresh]` for every `isRoomActive` call, in order. */
  roomReads: Array<{ groupId: string; fresh: boolean }> = [];
  /** When set, `isRoomActive` throws — the chain is unreachable. */
  roomReadThrows = false;

  ed25519KeyOf(sender: `0x${string}`): Promise<`0x${string}` | null> {
    return Promise.resolve(this.keys.get(sender.toLowerCase()) ?? null);
  }
  isActivated(sender: `0x${string}`): Promise<boolean> {
    return Promise.resolve(this.activated.has(sender.toLowerCase()));
  }
  isRoomActive(
    groupId: `0x${string}`,
    options?: { readonly fresh?: boolean },
  ): Promise<boolean> {
    this.roomReads.push({ groupId: groupId.toLowerCase(), fresh: options?.fresh === true });
    if (this.roomReadThrows) return Promise.reject(new Error('rpc unavailable'));
    return Promise.resolve(this.activeRooms.has(groupId.toLowerCase()));
  }
}

/** Poster that reverts on demand, then records what it eventually accepted. */
class RevertingPoster implements BatchPoster {
  batches: SignableDrop[][] = [];
  /** Number of upcoming `post()` calls that revert. */
  revertNext = 0;

  post(drops: readonly SignableDrop[]): Promise<`0x${string}`> {
    if (this.revertNext > 0) {
      this.revertNext -= 1;
      // Shaped like what viem surfaces for a reverted `postBatch`.
      return Promise.reject(new Error('execution reverted: RoomInactive()'));
    }
    this.batches.push([...drops]);
    return Promise.resolve(`0x${'11'.repeat(32)}` as `0x${string}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function signedDrop(
  identity: IdentityKeys,
  convoId: `0x${string}`,
  body: string,
): Promise<{ drop: SignableDrop; signature: `0x${string}` }> {
  const sealed = await seal({ v: 1, t: Date.now(), kind: 'text', body }, identity.x25519.publicKey);
  const drop: SignableDrop = {
    convoId,
    ephPub: sealed.ephPub,
    blobRef: sealed.blobRef,
    viewTag: sealed.viewTag,
    size: sealed.size,
  };
  return { drop, signature: await signDrop(drop, identity.ed25519.privateKey) };
}

describe('a reverting drop cannot destroy its batch-mates', () => {
  let gate: FakeGate;
  let poster: RevertingPoster;
  let pipeline: SendPipeline;
  let identity: IdentityKeys;

  beforeEach(async () => {
    gate = new FakeGate();
    poster = new RevertingPoster();
    identity = await deriveIdentity(`0x${'aa'.repeat(65)}`);
    gate.keys.set(ALICE, `0x${Buffer.from(identity.ed25519.publicKey).toString('hex')}`);
    gate.activated.add(ALICE);
    gate.activeRooms.add(DOOMED_ROOM);
    gate.activeRooms.add(HEALTHY_ROOM);
    pipeline = new SendPipeline({
      gate,
      poster,
      log: silentLogger(),
      flushMs: 60_000, // flushed manually
      queueMax: 100,
    });
  });

  /** Queues a drop and asserts the relay answered "accepted". */
  async function accept(convoId: `0x${string}`, body: string): Promise<`0x${string}`> {
    const { drop, signature } = await signedDrop(identity, convoId, body);
    const result = await pipeline.submit(ALICE, drop, signature);
    expect(result.ok).toBe(true);
    return drop.blobRef;
  }

  it('anchors the innocent DM and quarantines only the lapsed-room drop', async () => {
    // Exactly the proof run: one room drop and one unrelated DM in the same batch.
    const poisonRef = await accept(DOOMED_ROOM, 'into a room about to lapse');
    const innocentRef = await accept(ZERO_CONVO, 'an unrelated DM');

    // The rent lapses after both were accepted; the batch reverts atomically.
    gate.activeRooms.delete(DOOMED_ROOM);
    poster.revertNext = 1;
    await pipeline.flushNow();

    expect(poster.batches).toHaveLength(0);
    // Poison removed, innocent kept — the whole point.
    expect(pipeline.size()).toBe(1);
    expect(pipeline.failureCount()).toBe(1);
    expect(pipeline.statusOf(poisonRef)).toMatchObject({
      status: 'failed',
      failure: { reason: 'room_inactive', convoId: DOOMED_ROOM, sender: ALICE },
    });
    expect(pipeline.statusOf(innocentRef)).toEqual({ status: 'queued' });

    // No backoff was applied, because the failure was attributed rather than
    // guessed at: the survivor goes out on the very next flush.
    await pipeline.flushNow();
    expect(poster.batches).toHaveLength(1);
    expect(poster.batches[0]?.map((drop) => drop.blobRef)).toEqual([innocentRef]);
    expect(pipeline.size()).toBe(0);
  });

  it('survives the attack: one poison drop cannot take down 20 batch-mates', async () => {
    const innocents: string[] = [];
    for (let i = 0; i < 10; i += 1) innocents.push(await accept(ZERO_CONVO, `dm ${i}`));
    const poisonRef = await accept(DOOMED_ROOM, 'attacker drop');
    for (let i = 10; i < 20; i += 1) innocents.push(await accept(HEALTHY_ROOM, `room msg ${i}`));

    gate.activeRooms.delete(DOOMED_ROOM);
    poster.revertNext = 1;
    await pipeline.flushNow();
    await pipeline.flushNow();

    expect(pipeline.failureCount()).toBe(1);
    expect(pipeline.statusOf(poisonRef)).toMatchObject({ status: 'failed' });
    // Every innocent drop was anchored, in its original order.
    expect(poster.batches).toHaveLength(1);
    expect(poster.batches[0]?.map((drop) => drop.blobRef)).toEqual(innocents);
    expect(pipeline.size()).toBe(0);
  });

  it('quarantines every drop for the lapsed room and spares the healthy room', async () => {
    const poisonA = await accept(DOOMED_ROOM, 'a');
    const healthy = await accept(HEALTHY_ROOM, 'b');
    const poisonB = await accept(DOOMED_ROOM, 'c');

    gate.activeRooms.delete(DOOMED_ROOM);
    poster.revertNext = 1;
    await pipeline.flushNow();

    expect(pipeline.failureCount()).toBe(2);
    expect(pipeline.statusOf(poisonA)).toMatchObject({ status: 'failed' });
    expect(pipeline.statusOf(poisonB)).toMatchObject({ status: 'failed' });
    expect(pipeline.statusOf(healthy)).toEqual({ status: 'queued' });
  });

  it('re-reads rent with the cache bypassed, once per distinct room', async () => {
    await accept(DOOMED_ROOM, 'a');
    await accept(DOOMED_ROOM, 'b');
    await accept(HEALTHY_ROOM, 'c');
    await accept(ZERO_CONVO, 'd');

    gate.activeRooms.delete(DOOMED_ROOM);
    gate.roomReads = [];
    poster.revertNext = 1;
    await pipeline.flushNow();

    // Two distinct rooms, one read each. Stealth drops are not rent-gated on
    // chain, so they are never read for. Every read must be `fresh` — answering
    // from the same cache that admitted the drop would re-confirm the stale
    // "active" and blame nobody.
    expect(gate.roomReads).toEqual([
      { groupId: DOOMED_ROOM, fresh: true },
      { groupId: HEALTHY_ROOM, fresh: true },
    ]);
  });
});

describe('an unattributable failure never costs an innocent drop', () => {
  let gate: FakeGate;
  let poster: RevertingPoster;
  let pipeline: SendPipeline;
  let identity: IdentityKeys;

  beforeEach(async () => {
    gate = new FakeGate();
    poster = new RevertingPoster();
    identity = await deriveIdentity(`0x${'aa'.repeat(65)}`);
    gate.keys.set(ALICE, `0x${Buffer.from(identity.ed25519.publicKey).toString('hex')}`);
    gate.activated.add(ALICE);
    gate.activeRooms.add(HEALTHY_ROOM);
    pipeline = new SendPipeline({
      gate,
      poster,
      log: silentLogger(),
      flushMs: 60_000,
      queueMax: 100,
    });
  });

  async function accept(convoId: `0x${string}`, body: string): Promise<void> {
    const { drop, signature } = await signedDrop(identity, convoId, body);
    expect((await pipeline.submit(ALICE, drop, signature)).ok).toBe(true);
  }

  it('retries the whole batch and backs off when every room is still paid up', async () => {
    // A whole-batch cause: RPC down, relayer unapproved, out of gas. Nothing in
    // the batch is individually to blame, so nothing may be discarded.
    await accept(HEALTHY_ROOM, 'a');
    await accept(ZERO_CONVO, 'b');

    poster.revertNext = 1;
    await pipeline.flushNow();

    expect(pipeline.size()).toBe(2);
    expect(pipeline.failureCount()).toBe(0);

    // Backoff still applies for an unattributed failure: an immediate reflush is
    // suppressed rather than hammering a chain that is evidently unhappy.
    await pipeline.flushNow();
    expect(poster.batches).toHaveLength(0);
  });

  it('retries the whole batch when the rent re-check itself cannot be answered', async () => {
    await accept(HEALTHY_ROOM, 'a');
    await accept(HEALTHY_ROOM, 'b');

    // The chain is unreachable, so "is this room active?" has no answer. A drop
    // must never be blamed on a read that failed.
    gate.roomReadThrows = true;
    poster.revertNext = 1;
    await pipeline.flushNow();

    expect(pipeline.size()).toBe(2);
    expect(pipeline.failureCount()).toBe(0);
  });
});

describe('drops that age out are recorded, not silently dropped', () => {
  it('books every stale eviction as a reportable failure', async () => {
    const gate = new FakeGate();
    const poster = new RevertingPoster();
    const identity = await deriveIdentity(`0x${'aa'.repeat(65)}`);
    gate.keys.set(ALICE, `0x${Buffer.from(identity.ed25519.publicKey).toString('hex')}`);
    gate.activated.add(ALICE);

    // `staleMs: 1` plus a short wait makes everything already-stale at the flush.
    const pipeline = new SendPipeline({
      gate,
      poster,
      log: silentLogger(),
      flushMs: 60_000,
      queueMax: 100,
      staleMs: 1,
    });

    const { drop, signature } = await signedDrop(identity, ZERO_CONVO, 'doomed');
    expect((await pipeline.submit(ALICE, drop, signature)).ok).toBe(true);

    await sleep(5);
    await pipeline.flushNow();

    expect(pipeline.size()).toBe(0);
    expect(pipeline.failureCount()).toBe(1);
    expect(pipeline.statusOf(drop.blobRef)).toMatchObject({
      status: 'failed',
      failure: { reason: 'expired', sender: ALICE },
    });
  });

  it('bounds the failure log so it cannot grow without limit', async () => {
    const gate = new FakeGate();
    const identity = await deriveIdentity(`0x${'aa'.repeat(65)}`);
    gate.keys.set(ALICE, `0x${Buffer.from(identity.ed25519.publicKey).toString('hex')}`);
    gate.activated.add(ALICE);

    const pipeline = new SendPipeline({
      gate,
      poster: new RevertingPoster(),
      log: silentLogger(),
      flushMs: 60_000,
      queueMax: 100,
      staleMs: 1,
      failureLogMax: 3,
    });

    for (let i = 0; i < 5; i += 1) {
      const { drop, signature } = await signedDrop(identity, ZERO_CONVO, `m${i}`);
      await pipeline.submit(ALICE, drop, signature);
    }
    await sleep(5);
    await pipeline.flushNow();

    // The running total is honest even though the ring only keeps the last 3.
    expect(pipeline.failureCount()).toBe(5);
    expect(pipeline.recentFailures()).toHaveLength(3);
  });
});

describe('GET /v1/send/:blobRef', () => {
  let app: FastifyInstance;
  let gate: FakeGate;
  let poster: RevertingPoster;
  let identity: IdentityKeys;

  beforeEach(async () => {
    gate = new FakeGate();
    poster = new RevertingPoster();
    identity = await deriveIdentity(`0x${'aa'.repeat(65)}`);
    gate.keys.set(ALICE, `0x${Buffer.from(identity.ed25519.publicKey).toString('hex')}`);
    gate.activated.add(ALICE);
    gate.activeRooms.add(DOOMED_ROOM);

    app = await buildServer({
      env: {},
      config: { dbPath: ':memory:', indexerEnabled: false, logLevel: 'silent' },
      sendPorts: { gate, poster },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('lets a sender discover that an accepted message was abandoned', async () => {
    const { drop, signature } = await signedDrop(identity, DOOMED_ROOM, 'doomed room msg');
    expect((await app.sendPipeline.submit(ALICE, drop, signature)).ok).toBe(true);

    const queued = await app.inject({ method: 'GET', url: `/v1/send/${drop.blobRef}` });
    expect(queued.statusCode).toBe(200);
    expect(queued.json()).toEqual({ blobRef: drop.blobRef, status: 'queued' });

    gate.activeRooms.delete(DOOMED_ROOM);
    poster.revertNext = 1;
    await app.sendPipeline.flushNow();

    const failed = await app.inject({ method: 'GET', url: `/v1/send/${drop.blobRef}` });
    expect(failed.statusCode).toBe(200);
    expect(failed.json()).toMatchObject({
      blobRef: drop.blobRef,
      status: 'failed',
      reason: 'room_inactive',
    });
  });

  it('reports an unseen ref as unknown and rejects a malformed one', async () => {
    const unseen = await app.inject({ method: 'GET', url: `/v1/send/0x${'ee'.repeat(32)}` });
    expect(unseen.json()).toEqual({ blobRef: `0x${'ee'.repeat(32)}`, status: 'unknown' });

    const bad = await app.inject({ method: 'GET', url: '/v1/send/not-a-ref' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: 'invalid_blob_ref' });
  });

  it('counts abandoned drops in /v1/health', async () => {
    const { drop, signature } = await signedDrop(identity, DOOMED_ROOM, 'doomed');
    await app.sendPipeline.submit(ALICE, drop, signature);

    gate.activeRooms.delete(DOOMED_ROOM);
    poster.revertNext = 1;
    await app.sendPipeline.flushNow();

    const health = await app.inject({ method: 'GET', url: '/v1/health' });
    expect(health.json()).toMatchObject({ send: { enabled: true, queued: 0, abandoned: 1 } });
  });
});
