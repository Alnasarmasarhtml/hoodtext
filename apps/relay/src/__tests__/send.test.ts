/**
 * The gasless send path: verification order, queueing, batching, and the HTTP
 * surface — all driven through fakes, no chain required.
 */
import { deriveIdentity, seal, signDrop } from '@telehood/crypto';
import type { IdentityKeys, SignableDrop } from '@telehood/crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_BATCH, SendPipeline } from '../sender.js';
import type { BatchPoster, ChainGate } from '../sender.js';
import { buildServer } from '../server.js';

const ALICE = '0x00000000000000000000000000000000000000a1' as const;
const ZERO_CONVO = `0x${'0'.repeat(64)}` as const;
const ROOM = `0x${'ab'.repeat(32)}` as const;

/** In-memory ChainGate the tests mutate directly. */
class FakeGate implements ChainGate {
  keys = new Map<string, `0x${string}`>();
  activated = new Set<string>();
  activeRooms = new Set<string>();

  ed25519KeyOf(sender: `0x${string}`): Promise<`0x${string}` | null> {
    return Promise.resolve(this.keys.get(sender.toLowerCase()) ?? null);
  }
  isActivated(sender: `0x${string}`): Promise<boolean> {
    return Promise.resolve(this.activated.has(sender.toLowerCase()));
  }
  isRoomActive(groupId: `0x${string}`): Promise<boolean> {
    return Promise.resolve(this.activeRooms.has(groupId.toLowerCase()));
  }
}

/** Poster that records batches and can be told to fail. */
class FakePoster implements BatchPoster {
  batches: SignableDrop[][] = [];
  failNext = 0;

  post(drops: readonly SignableDrop[]): Promise<`0x${string}`> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      return Promise.reject(new Error('rpc unavailable'));
    }
    this.batches.push([...drops]);
    return Promise.resolve(`0x${'11'.repeat(32)}` as `0x${string}`);
  }
}

const silentLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  fatal: () => undefined,
  trace: () => undefined,
  child: () => silentLog,
  level: 'silent',
  silent: () => undefined,
  // Fastify's logger interface; the pipeline only calls info/warn/error.
} as never;

async function identityFor(seedByte: string): Promise<IdentityKeys> {
  return deriveIdentity(`0x${seedByte.repeat(65)}`);
}

async function signedDrop(
  identity: IdentityKeys,
  convoId: `0x${string}` = ZERO_CONVO,
): Promise<{ drop: SignableDrop; signature: `0x${string}` }> {
  const sealed = await seal(
    { v: 1, t: Date.now(), kind: 'text', body: 'relayed' },
    identity.x25519.publicKey,
  );
  const drop: SignableDrop = {
    convoId,
    ephPub: sealed.ephPub,
    blobRef: sealed.blobRef,
    viewTag: sealed.viewTag,
    size: sealed.size,
  };
  return { drop, signature: await signDrop(drop, identity.ed25519.privateKey) };
}

function pipelineWith(gate: FakeGate, poster: BatchPoster | null): SendPipeline {
  return new SendPipeline({
    gate,
    poster,
    log: silentLog,
    flushMs: 60_000, // flushed manually in tests
    queueMax: 8,
  });
}

describe('SendPipeline.submit', () => {
  let gate: FakeGate;
  let poster: FakePoster;
  let pipeline: SendPipeline;
  let identity: IdentityKeys;

  beforeEach(async () => {
    gate = new FakeGate();
    poster = new FakePoster();
    pipeline = pipelineWith(gate, poster);
    identity = await identityFor('aa');
    gate.keys.set(ALICE, `0x${Buffer.from(identity.ed25519.publicKey).toString('hex')}`);
    gate.activated.add(ALICE);
    gate.activeRooms.add(ROOM);
  });

  it('accepts a fully valid stealth drop', async () => {
    const { drop, signature } = await signedDrop(identity);
    const result = await pipeline.submit(ALICE, drop, signature);
    expect(result).toEqual({ ok: true, queued: 1 });
    expect(pipeline.size()).toBe(1);
  });

  it('rejects a sender with no registered key', async () => {
    gate.keys.delete(ALICE);
    const { drop, signature } = await signedDrop(identity);
    const result = await pipeline.submit(ALICE, drop, signature);
    expect(result).toMatchObject({ ok: false, code: 'unknown_key' });
  });

  it('rejects a signature from the wrong identity', async () => {
    const mallory = await identityFor('bb');
    const { drop } = await signedDrop(identity);
    const forged = await signDrop(drop, mallory.ed25519.privateKey);
    const result = await pipeline.submit(ALICE, drop, forged);
    expect(result).toMatchObject({ ok: false, code: 'bad_signature' });
  });

  it('rejects a drop whose fields were altered after signing', async () => {
    const { drop, signature } = await signedDrop(identity);
    const tampered = { ...drop, viewTag: (drop.viewTag + 1) % 256 };
    const result = await pipeline.submit(ALICE, tampered, signature);
    expect(result).toMatchObject({ ok: false, code: 'bad_signature' });
  });

  it('rejects an unactivated sender even with a valid signature', async () => {
    gate.activated.delete(ALICE);
    const { drop, signature } = await signedDrop(identity);
    const result = await pipeline.submit(ALICE, drop, signature);
    expect(result).toMatchObject({ ok: false, code: 'not_activated' });
  });

  it('rejects a room drop when the rent has lapsed', async () => {
    gate.activeRooms.delete(ROOM);
    const { drop, signature } = await signedDrop(identity, ROOM);
    const result = await pipeline.submit(ALICE, drop, signature);
    expect(result).toMatchObject({ ok: false, code: 'room_inactive' });
  });

  it('accepts a room drop while the rent is current', async () => {
    const { drop, signature } = await signedDrop(identity, ROOM);
    const result = await pipeline.submit(ALICE, drop, signature);
    expect(result).toMatchObject({ ok: true });
  });

  it('rejects beyond the queue cap', async () => {
    for (let i = 0; i < 8; i += 1) {
      const { drop, signature } = await signedDrop(identity);
      expect((await pipeline.submit(ALICE, drop, signature)).ok).toBe(true);
    }
    const { drop, signature } = await signedDrop(identity);
    const result = await pipeline.submit(ALICE, drop, signature);
    expect(result).toMatchObject({ ok: false, code: 'queue_full' });
  });
});

describe('SendPipeline.flushNow', () => {
  let gate: FakeGate;
  let poster: FakePoster;
  let identity: IdentityKeys;

  beforeEach(async () => {
    gate = new FakeGate();
    poster = new FakePoster();
    identity = await identityFor('aa');
    gate.keys.set(ALICE, `0x${Buffer.from(identity.ed25519.publicKey).toString('hex')}`);
    gate.activated.add(ALICE);
  });

  it('posts queued drops as one batch and empties the queue', async () => {
    const pipeline = pipelineWith(gate, poster);
    for (let i = 0; i < 3; i += 1) {
      const { drop, signature } = await signedDrop(identity);
      await pipeline.submit(ALICE, drop, signature);
    }

    await pipeline.flushNow();

    expect(poster.batches).toHaveLength(1);
    expect(poster.batches[0]).toHaveLength(3);
    expect(pipeline.size()).toBe(0);
  });

  it('caps a single batch at MAX_BATCH and keeps the rest queued', async () => {
    const pipeline = new SendPipeline({
      gate,
      poster,
      log: silentLog,
      flushMs: 60_000,
      queueMax: 100,
    });
    for (let i = 0; i < MAX_BATCH + 5; i += 1) {
      const { drop, signature } = await signedDrop(identity);
      await pipeline.submit(ALICE, drop, signature);
    }

    await pipeline.flushNow();
    expect(poster.batches[0]).toHaveLength(MAX_BATCH);
    expect(pipeline.size()).toBe(5);
  });

  it('keeps drops queued when posting fails, and backs off', async () => {
    const pipeline = pipelineWith(gate, poster);
    const { drop, signature } = await signedDrop(identity);
    await pipeline.submit(ALICE, drop, signature);

    poster.failNext = 1;
    await pipeline.flushNow();
    expect(pipeline.size()).toBe(1, );
    expect(poster.batches).toHaveLength(0);

    // Inside the backoff window nothing is attempted.
    await pipeline.flushNow();
    expect(poster.batches).toHaveLength(0);
  });

  it('does nothing when disabled', async () => {
    const pipeline = pipelineWith(gate, null);
    expect(pipeline.enabled()).toBe(false);
    await pipeline.flushNow(); // must not throw
  });
});

describe('POST /v1/send', () => {
  let app: FastifyInstance;
  let gate: FakeGate;
  let poster: FakePoster;
  let identity: IdentityKeys;

  beforeEach(async () => {
    gate = new FakeGate();
    poster = new FakePoster();
    identity = await identityFor('aa');
    gate.keys.set(ALICE, `0x${Buffer.from(identity.ed25519.publicKey).toString('hex')}`);
    gate.activated.add(ALICE);

    app = await buildServer({
      config: {
        dbPath: ':memory:',
        indexerEnabled: false,
        logLevel: 'silent',
        blobRateLimitMax: 10_000,
      },
      sendPorts: { gate, poster },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  async function sendSigned(): Promise<{
    drop: SignableDrop;
    signature: `0x${string}`;
    blob: Uint8Array;
  }> {
    const sealed = await seal(
      { v: 1, t: Date.now(), kind: 'text', body: 'over http' },
      identity.x25519.publicKey,
    );
    const drop: SignableDrop = {
      convoId: ZERO_CONVO,
      ephPub: sealed.ephPub,
      blobRef: sealed.blobRef,
      viewTag: sealed.viewTag,
      size: sealed.size,
    };
    return { drop, signature: await signDrop(drop, identity.ed25519.privateKey), blob: sealed.blob };
  }

  it('accepts a valid submission whose blob was uploaded first', async () => {
    const { drop, signature, blob } = await sendSigned();

    const upload = await app.inject({
      method: 'POST',
      url: '/v1/blob',
      payload: Buffer.from(blob),
      headers: { 'content-type': 'application/octet-stream' },
    });
    expect(upload.statusCode).toBe(200);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/send',
      payload: JSON.stringify({ sender: ALICE, signature, drop }),
      headers: { 'content-type': 'application/json' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accepted: true, queued: 1 });
    expect(app.sendPipeline.size()).toBe(1);
  });

  it('409s when the blob was never uploaded', async () => {
    const { drop, signature } = await sendSigned();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/send',
      payload: JSON.stringify({ sender: ALICE, signature, drop }),
      headers: { 'content-type': 'application/json' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'blob_missing' });
  });

  it('401s a bad signature', async () => {
    const { drop, blob } = await sendSigned();
    await app.inject({
      method: 'POST',
      url: '/v1/blob',
      payload: Buffer.from(blob),
      headers: { 'content-type': 'application/octet-stream' },
    });

    const mallory = await identityFor('bb');
    const forged = await signDrop(drop, mallory.ed25519.privateKey);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/send',
      payload: JSON.stringify({ sender: ALICE, signature: forged, drop }),
      headers: { 'content-type': 'application/json' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: 'bad_signature' });
  });

  it('403s an unactivated sender', async () => {
    gate.activated.delete(ALICE);
    const { drop, signature, blob } = await sendSigned();
    await app.inject({
      method: 'POST',
      url: '/v1/blob',
      payload: Buffer.from(blob),
      headers: { 'content-type': 'application/octet-stream' },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/send',
      payload: JSON.stringify({ sender: ALICE, signature, drop }),
      headers: { 'content-type': 'application/json' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'not_activated' });
  });

  it('400s malformed JSON and malformed bodies', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/send',
      payload: 'not json',
      headers: { 'content-type': 'application/json' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: 'invalid_json' });

    const wrongShape = await app.inject({
      method: 'POST',
      url: '/v1/send',
      payload: JSON.stringify({ sender: 'nope' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(wrongShape.statusCode).toBe(400);
    expect(wrongShape.json()).toMatchObject({ error: 'invalid_body' });
  });

  it('503s when the relay has no posting key', async () => {
    const disabled = await buildServer({
      config: { dbPath: ':memory:', indexerEnabled: false, logLevel: 'silent' },
      sendPorts: null,
    });
    try {
      const { drop, signature } = await sendSigned();
      const response = await disabled.inject({
        method: 'POST',
        url: '/v1/send',
        payload: JSON.stringify({ sender: ALICE, signature, drop }),
        headers: { 'content-type': 'application/json' },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: 'send_disabled' });
    } finally {
      await disabled.close();
    }
  });
});
