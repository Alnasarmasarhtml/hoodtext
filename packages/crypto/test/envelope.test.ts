import { describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { sha256 } from '@noble/hashes/sha2';
import { BUCKETS, computeViewTag, open, scanMatches, seal } from '../src/index';
import type { IdentityKeys } from '../src/index';
import {
  bodyFillingBucket,
  flipByte,
  freshIdentity,
  jsonOverhead,
  seededBytes,
  textMessage,
} from './helpers';

const CIPHERTEXT_OFFSET = 57;
const MAC_BYTES = 16;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const alice: IdentityKeys = await freshIdentity();
const bob: IdentityKeys = await freshIdentity();
const mallory: IdentityKeys = await freshIdentity();

describe('BUCKETS', () => {
  it('is the exact padded-size ladder from the spec', () => {
    expect(BUCKETS).toEqual([256, 1024, 4096, 16384]);
  });
});

describe('seal wire format', () => {
  it('starts with the 0x01 version byte', async () => {
    const drop = await seal(textMessage('hello'), bob.x25519.publicKey);
    expect(drop.blob[0]).toBe(0x01);
  });

  it('carries the ephemeral public key at bytes 1..33', async () => {
    const drop = await seal(textMessage('hello'), bob.x25519.publicKey);
    expect(toHex(drop.blob.slice(1, 33))).toBe(drop.ephPub.slice(2));
  });

  it('uses a fresh ephemeral key for every drop', async () => {
    const a = await seal(textMessage('hello'), bob.x25519.publicKey);
    const b = await seal(textMessage('hello'), bob.x25519.publicKey);
    expect(a.ephPub).not.toBe(b.ephPub);
    expect(a.blobRef).not.toBe(b.blobRef);
  });

  it('lays the blob out as version + ephPub + nonce + ciphertext', async () => {
    const drop = await seal(textMessage('hello'), bob.x25519.publicKey);
    expect(drop.blob.length).toBe(CIPHERTEXT_OFFSET + drop.size + MAC_BYTES);
  });

  it('reports blobRef as the sha256 of the blob', async () => {
    const drop = await seal(textMessage('hello'), bob.x25519.publicKey);
    expect(drop.blobRef).toBe(`0x${toHex(sha256(drop.blob))}`);
    expect(drop.blobRef).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('produces a blobRef the relay can recompute with a stock sha256', async () => {
    // The relay is content-addressed: it rehashes the uploaded bytes and must land on the
    // same ref. Verified here against Node's own SHA-256, not the one this package uses.
    const drop = await seal(textMessage('content addressed'), bob.x25519.publicKey);
    const digest = createHash('sha256').update(Buffer.from(drop.blob)).digest('hex');
    expect(drop.blobRef).toBe(`0x${digest}`);
  });

  it('reports ephPub as 32 hex-encoded bytes', async () => {
    const drop = await seal(textMessage('hello'), bob.x25519.publicKey);
    expect(drop.ephPub).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('reports a view tag in 0..255', async () => {
    const drop = await seal(textMessage('hello'), bob.x25519.publicKey);
    expect(Number.isInteger(drop.viewTag)).toBe(true);
    expect(drop.viewTag).toBeGreaterThanOrEqual(0);
    expect(drop.viewTag).toBeLessThanOrEqual(255);
  });
});

describe('seal → open round trip', () => {
  for (const bucket of BUCKETS) {
    it(`round-trips a message that fills the ${bucket}-byte bucket`, async () => {
      const body = bodyFillingBucket(bucket);
      const drop = await seal(textMessage(body), bob.x25519.publicKey);
      expect(drop.size).toBe(bucket);
      const opened = await open(drop.blob, bob.x25519.privateKey, bob.x25519.publicKey);
      expect(opened).not.toBeNull();
      expect(opened?.body).toBe(body);
      expect(opened?.v).toBe(1);
      expect(opened?.kind).toBe('text');
    });
  }

  it('round-trips an empty body', async () => {
    const drop = await seal(textMessage(''), bob.x25519.publicKey);
    const opened = await open(drop.blob, bob.x25519.privateKey, bob.x25519.publicKey);
    expect(opened?.body).toBe('');
  });

  it('round-trips multi-byte UTF-8 and emoji', async () => {
    const body = 'Ünïcödé — 中文 — 🔒🕵️‍♀️';
    const drop = await seal(textMessage(body), bob.x25519.publicKey);
    const opened = await open(drop.blob, bob.x25519.privateKey, bob.x25519.publicKey);
    expect(opened?.body).toBe(body);
  });

  it('round-trips a system message', async () => {
    const drop = await seal({ v: 1, t: 42, kind: 'system', body: 'epoch rotated' }, bob.x25519.publicKey);
    const opened = await open(drop.blob, bob.x25519.privateKey, bob.x25519.publicKey);
    expect(opened).toEqual({ v: 1, t: 42, kind: 'system', body: 'epoch rotated' });
  });

  it('preserves the timestamp exactly', async () => {
    const drop = await seal(textMessage('t', 1_763_000_123_456), bob.x25519.publicKey);
    const opened = await open(drop.blob, bob.x25519.privateKey, bob.x25519.publicKey);
    expect(opened?.t).toBe(1_763_000_123_456);
  });
});

describe('bucket selection', () => {
  it('picks the exact bucket at each upper boundary', async () => {
    for (const bucket of BUCKETS) {
      const drop = await seal(textMessage(bodyFillingBucket(bucket)), bob.x25519.publicKey);
      expect(drop.size).toBe(bucket);
    }
  });

  it('steps up to the next bucket one byte past the boundary', async () => {
    const overheadBytes = jsonOverhead();
    for (let i = 0; i < BUCKETS.length - 1; i += 1) {
      const bucket = BUCKETS[i];
      const next = BUCKETS[i + 1];
      if (bucket === undefined || next === undefined) {
        continue;
      }
      const body = 'x'.repeat(bucket - 4 - overheadBytes + 1);
      const drop = await seal(textMessage(body), bob.x25519.publicKey);
      expect(drop.size).toBe(next);
    }
  });

  it('rejects a message larger than the biggest bucket', async () => {
    const body = 'x'.repeat(16384 - 4 - jsonOverhead() + 1);
    await expect(seal(textMessage(body), bob.x25519.publicKey)).rejects.toThrow(/too large/);
  });
});

describe('padding hides length', () => {
  it('produces byte-identical blob lengths for a 5-char and a 200-char message', async () => {
    const short = await seal(textMessage('x'.repeat(5)), bob.x25519.publicKey);
    const long = await seal(textMessage('x'.repeat(200)), bob.x25519.publicKey);
    expect(short.blob.length).toBe(long.blob.length);
    expect(short.size).toBe(long.size);
    expect(short.size).toBe(256);
  });

  it('collapses every sub-bucket length onto exactly four blob sizes', async () => {
    const lengths = new Set<number>();
    for (const bodyLength of [0, 1, 7, 33, 120, 203, 500, 971, 2000, 4043, 8000, 16000]) {
      const drop = await seal(textMessage('x'.repeat(bodyLength)), bob.x25519.publicKey);
      lengths.add(drop.blob.length);
    }
    expect(lengths.size).toBe(4);
    expect([...lengths].sort((a, b) => a - b)).toEqual(
      BUCKETS.map((bucket) => CIPHERTEXT_OFFSET + bucket + MAC_BYTES),
    );
  });

  it('leaks nothing through blob length within a bucket', async () => {
    const sizes = new Set<number>();
    for (let bodyLength = 0; bodyLength <= 200; bodyLength += 20) {
      const drop = await seal(textMessage('x'.repeat(bodyLength)), bob.x25519.publicKey);
      sizes.add(drop.blob.length);
    }
    expect(sizes.size).toBe(1);
  });
});

describe('open rejects the wrong key', () => {
  it('returns null for a third party', async () => {
    const drop = await seal(textMessage('secret'), bob.x25519.publicKey);
    const opened = await open(drop.blob, mallory.x25519.privateKey, mallory.x25519.publicKey);
    expect(opened).toBeNull();
  });

  it('returns null for the sender themselves', async () => {
    const drop = await seal(textMessage('secret'), bob.x25519.publicKey);
    const opened = await open(drop.blob, alice.x25519.privateKey, alice.x25519.publicKey);
    expect(opened).toBeNull();
  });

  it('returns null for a wrong-length private key', async () => {
    const drop = await seal(textMessage('secret'), bob.x25519.publicKey);
    expect(await open(drop.blob, new Uint8Array(31), bob.x25519.publicKey)).toBeNull();
    expect(await open(drop.blob, new Uint8Array(0), bob.x25519.publicKey)).toBeNull();
  });

  it('returns null for a wrong-length public key', async () => {
    const drop = await seal(textMessage('secret'), bob.x25519.publicKey);
    expect(await open(drop.blob, bob.x25519.privateKey, new Uint8Array(31))).toBeNull();
  });
});

describe('open detects tampering', () => {
  it('returns null when the version byte is wrong', async () => {
    const drop = await seal(textMessage('secret'), bob.x25519.publicKey);
    const tampered = drop.blob.slice();
    tampered[0] = 0x02;
    expect(await open(tampered, bob.x25519.privateKey, bob.x25519.publicKey)).toBeNull();
  });

  it('returns null when the ephemeral public key is altered', async () => {
    const drop = await seal(textMessage('secret'), bob.x25519.publicKey);
    expect(
      await open(flipByte(drop.blob, 1), bob.x25519.privateKey, bob.x25519.publicKey),
    ).toBeNull();
    expect(
      await open(flipByte(drop.blob, 32), bob.x25519.privateKey, bob.x25519.publicKey),
    ).toBeNull();
  });

  it('returns null when the nonce is altered', async () => {
    const drop = await seal(textMessage('secret'), bob.x25519.publicKey);
    expect(
      await open(flipByte(drop.blob, 33), bob.x25519.privateKey, bob.x25519.publicKey),
    ).toBeNull();
    expect(
      await open(flipByte(drop.blob, 56), bob.x25519.privateKey, bob.x25519.publicKey),
    ).toBeNull();
  });

  it('returns null when any ciphertext byte is altered', async () => {
    const drop = await seal(textMessage('secret'), bob.x25519.publicKey);
    for (const index of [57, 80, 150, drop.blob.length - 17, drop.blob.length - 1]) {
      expect(
        await open(flipByte(drop.blob, index), bob.x25519.privateKey, bob.x25519.publicKey),
      ).toBeNull();
    }
  });

  it('returns null for every truncation of a valid blob', async () => {
    const drop = await seal(textMessage('secret'), bob.x25519.publicKey);
    for (let length = 0; length < drop.blob.length; length += 7) {
      const truncated = drop.blob.slice(0, length);
      expect(await open(truncated, bob.x25519.privateKey, bob.x25519.publicKey)).toBeNull();
    }
  });

  it('returns null when the blob is extended', async () => {
    const drop = await seal(textMessage('secret'), bob.x25519.publicKey);
    const extended = new Uint8Array(drop.blob.length + 1);
    extended.set(drop.blob, 0);
    expect(await open(extended, bob.x25519.privateKey, bob.x25519.publicKey)).toBeNull();
  });
});

describe('open fuzzing', () => {
  it('never throws on random bytes of random lengths', async () => {
    for (let i = 0; i < 400; i += 1) {
      const length = seededBytes(i, 2)[0] ?? 0;
      const blob = seededBytes(i + 1_000, length * 3);
      const result = await open(blob, bob.x25519.privateKey, bob.x25519.publicKey);
      expect(result).toBeNull();
    }
  });

  it('never throws on random bytes that carry a valid version byte and length', async () => {
    for (let i = 0; i < 200; i += 1) {
      const blob = seededBytes(i + 5_000, CIPHERTEXT_OFFSET + 256 + MAC_BYTES);
      blob[0] = 0x01;
      const result = await open(blob, bob.x25519.privateKey, bob.x25519.publicKey);
      expect(result).toBeNull();
    }
  });

  it('never throws on the empty blob or a single byte', async () => {
    expect(await open(new Uint8Array(0), bob.x25519.privateKey, bob.x25519.publicKey)).toBeNull();
    expect(
      await open(new Uint8Array([0x01]), bob.x25519.privateKey, bob.x25519.publicKey),
    ).toBeNull();
  });

  it('never throws when every byte region is zeroed', async () => {
    const blob = new Uint8Array(CIPHERTEXT_OFFSET + 256 + MAC_BYTES);
    blob[0] = 0x01;
    expect(await open(blob, bob.x25519.privateKey, bob.x25519.publicKey)).toBeNull();
  });

  it('rejects every genuinely mutated blob, at any offset', async () => {
    const drop = await seal(textMessage('mutation resistant'), bob.x25519.publicKey);
    for (let i = 0; i < 1_500; i += 1) {
      const mutated = drop.blob.slice();
      const index = randomBytes(2).readUInt16BE(0) % mutated.length;
      // XOR with 1..255 so the byte is guaranteed to actually change; writing a fresh
      // random byte would silently be a no-op about 1 time in 256.
      mutated[index] = (mutated[index] ?? 0) ^ (1 + ((randomBytes(1)[0] ?? 0) % 255));
      expect(await open(mutated, bob.x25519.privateKey, bob.x25519.publicKey)).toBeNull();
    }
  });
});

describe('computeViewTag', () => {
  it('is deterministic', () => {
    const secret = seededBytes(7, 32);
    expect(computeViewTag(secret)).toBe(computeViewTag(secret));
  });

  it('always returns a byte', () => {
    for (let i = 0; i < 256; i += 1) {
      const tag = computeViewTag(seededBytes(i, 32));
      expect(Number.isInteger(tag)).toBe(true);
      expect(tag).toBeGreaterThanOrEqual(0);
      expect(tag).toBeLessThanOrEqual(255);
    }
  });

  it('is the first byte of sha256(sharedSecret)', () => {
    const secret = seededBytes(11, 32);
    expect(computeViewTag(secret)).toBe(sha256(secret)[0]);
  });

  it('distributes uniformly across all 256 values', () => {
    const counts = new Array<number>(256).fill(0);
    const samples = 25_600;
    for (let i = 0; i < samples; i += 1) {
      const tag = computeViewTag(seededBytes(i + 90_000, 32));
      counts[tag] = (counts[tag] ?? 0) + 1;
    }
    expect(counts.every((count) => count > 0)).toBe(true);
    const expected = samples / 256;
    for (const count of counts) {
      expect(count).toBeGreaterThan(expected * 0.4);
      expect(count).toBeLessThan(expected * 1.6);
    }
    const zeroRate = (counts[0] ?? 0) / samples;
    expect(zeroRate).toBeGreaterThan(1 / 512);
    expect(zeroRate).toBeLessThan(1 / 128);
  });
});

describe('scanMatches', () => {
  it('always matches drops addressed to us', async () => {
    for (let i = 0; i < 40; i += 1) {
      const drop = await seal(textMessage(`msg ${i}`), bob.x25519.publicKey);
      const ephPub = drop.blob.slice(1, 33);
      expect(await scanMatches(ephPub, drop.viewTag, bob.x25519.privateKey)).toBe(true);
    }
  });

  it('matches foreign drops at roughly the 1/256 false-positive rate', async () => {
    const samples = 1024;
    let matches = 0;
    for (let i = 0; i < samples; i += 1) {
      const drop = await seal(textMessage(`msg ${i}`), mallory.x25519.publicKey);
      const ephPub = drop.blob.slice(1, 33);
      if (await scanMatches(ephPub, drop.viewTag, bob.x25519.privateKey)) {
        matches += 1;
      }
    }
    // Expected ~4 of 1024. A 0..24 window is > 8 sigma wide but still catches a broken
    // implementation that matches everything or can never match.
    expect(matches).toBeLessThanOrEqual(24);
    expect(matches / samples).toBeLessThan(0.05);
  });

  it('returns false rather than throwing on malformed input', async () => {
    const drop = await seal(textMessage('hi'), bob.x25519.publicKey);
    const ephPub = drop.blob.slice(1, 33);
    expect(await scanMatches(new Uint8Array(0), drop.viewTag, bob.x25519.privateKey)).toBe(false);
    expect(await scanMatches(new Uint8Array(31), drop.viewTag, bob.x25519.privateKey)).toBe(false);
    expect(await scanMatches(ephPub, drop.viewTag, new Uint8Array(31))).toBe(false);
    expect(await scanMatches(ephPub, -1, bob.x25519.privateKey)).toBe(false);
    expect(await scanMatches(ephPub, 256, bob.x25519.privateKey)).toBe(false);
    expect(await scanMatches(ephPub, 1.5, bob.x25519.privateKey)).toBe(false);
    expect(await scanMatches(ephPub, Number.NaN, bob.x25519.privateKey)).toBe(false);
  });

  it('never throws on all-zero or random ephemeral keys', async () => {
    expect(await scanMatches(new Uint8Array(32), 0, bob.x25519.privateKey)).toBe(false);
    for (let i = 0; i < 64; i += 1) {
      const result = await scanMatches(seededBytes(i + 30_000, 32), 0, bob.x25519.privateKey);
      expect(typeof result).toBe('boolean');
    }
  });
});

describe('seal input validation', () => {
  it('rejects a wrong-length recipient key', async () => {
    await expect(seal(textMessage('hi'), new Uint8Array(31))).rejects.toThrow(/32 bytes/);
  });

  it('rejects an unknown plaintext version', async () => {
    const bad = { v: 2, t: 1, kind: 'text', body: 'x' } as unknown as Parameters<typeof seal>[0];
    await expect(seal(bad, bob.x25519.publicKey)).rejects.toThrow(/plaintext.v/);
  });

  it('rejects an unknown plaintext kind', async () => {
    const bad = { v: 1, t: 1, kind: 'photo', body: 'x' } as unknown as Parameters<typeof seal>[0];
    await expect(seal(bad, bob.x25519.publicKey)).rejects.toThrow(/plaintext.kind/);
  });

  it('rejects a non-finite timestamp', async () => {
    const bad = {
      v: 1,
      t: Number.NaN,
      kind: 'text',
      body: 'x',
    } as unknown as Parameters<typeof seal>[0];
    await expect(seal(bad, bob.x25519.publicKey)).rejects.toThrow(/plaintext.t/);
  });

  it('drops unknown properties from the encoding', async () => {
    const extra = {
      v: 1,
      t: 5,
      kind: 'text',
      body: 'clean',
      secret: 'leak',
    } as unknown as Parameters<typeof seal>[0];
    const drop = await seal(extra, bob.x25519.publicKey);
    const opened = await open(drop.blob, bob.x25519.privateKey, bob.x25519.publicKey);
    expect(opened).toEqual({ v: 1, t: 5, kind: 'text', body: 'clean' });
  });
});

describe('sender identity', () => {
  it('is not recoverable from the blob', async () => {
    const drop = await seal(textMessage('anonymous'), bob.x25519.publicKey);
    expect(toHex(drop.blob)).not.toContain(toHex(alice.x25519.publicKey));
  });
});

describe('interoperability with the relay', () => {
  it('opens a blob that round-tripped through a Node Buffer', async () => {
    // The relay stores raw bytes and hands them back as a Buffer.
    const drop = await seal(textMessage('through the relay'), bob.x25519.publicKey);
    const stored = Buffer.from(drop.blob);
    const opened = await open(stored, bob.x25519.privateKey, bob.x25519.publicKey);
    expect(opened?.body).toBe('through the relay');
  });

  it('opens a blob whose bytes sit at a non-zero offset in a larger buffer', async () => {
    const drop = await seal(textMessage('offset view'), bob.x25519.publicKey);
    const backing = new Uint8Array(drop.blob.length + 64);
    backing.set(drop.blob, 32);
    const view = backing.subarray(32, 32 + drop.blob.length);
    const opened = await open(view, bob.x25519.privateKey, bob.x25519.publicKey);
    expect(opened?.body).toBe('offset view');
  });

  it('reports a size that matches the on-chain uint32 bucket', async () => {
    const drop = await seal(textMessage('anchor me'), bob.x25519.publicKey);
    expect(BUCKETS).toContain(drop.size);
    expect(drop.size).toBeLessThanOrEqual(0xffffffff);
  });
});
