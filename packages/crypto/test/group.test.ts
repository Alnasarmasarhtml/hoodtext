import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { sha256 } from '@noble/hashes/sha2';
import {
  BUCKETS,
  computeViewTag,
  memberRoot,
  newGroupKey,
  openFromGroup,
  sealToGroup,
  unwrapGroupKey,
  wrapGroupKey,
} from '../src/index';
import type { IdentityKeys } from '../src/index';
import { bodyFillingBucket, flipByte, freshIdentity, seededBytes, textMessage } from './helpers';

const CIPHERTEXT_OFFSET = 57;
const MAC_BYTES = 16;
const WRAPPED_KEY_BYTES = 81;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const member: IdentityKeys = await freshIdentity();
const outsider: IdentityKeys = await freshIdentity();

describe('newGroupKey', () => {
  it('returns 32 random bytes', () => {
    const key = newGroupKey();
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key).toHaveLength(32);
  });

  it('returns a different key every call', () => {
    const keys = new Set<string>();
    for (let i = 0; i < 32; i += 1) {
      keys.add(toHex(newGroupKey()));
    }
    expect(keys.size).toBe(32);
  });

  it('is not all zeroes', () => {
    expect(newGroupKey().some((byte) => byte !== 0)).toBe(true);
  });
});

describe('wrapGroupKey / unwrapGroupKey', () => {
  it('round-trips a group key to its member', async () => {
    const key = newGroupKey();
    const wrapped = await wrapGroupKey(key, member.x25519.publicKey);
    const unwrapped = await unwrapGroupKey(
      wrapped,
      member.x25519.privateKey,
      member.x25519.publicKey,
    );
    expect(unwrapped).not.toBeNull();
    expect(toHex(unwrapped ?? new Uint8Array())).toBe(toHex(key));
  });

  it('emits a versioned 81-byte wrapping', async () => {
    const wrapped = await wrapGroupKey(newGroupKey(), member.x25519.publicKey);
    expect(wrapped).toHaveLength(WRAPPED_KEY_BYTES);
    expect(wrapped[0]).toBe(0x01);
  });

  it('produces a different wrapping every time', async () => {
    const key = newGroupKey();
    const a = await wrapGroupKey(key, member.x25519.publicKey);
    const b = await wrapGroupKey(key, member.x25519.publicKey);
    expect(toHex(a)).not.toBe(toHex(b));
  });

  it('returns null for a non-member', async () => {
    const wrapped = await wrapGroupKey(newGroupKey(), member.x25519.publicKey);
    expect(
      await unwrapGroupKey(wrapped, outsider.x25519.privateKey, outsider.x25519.publicKey),
    ).toBeNull();
  });

  it('returns null when the private and public keys do not correspond', async () => {
    const wrapped = await wrapGroupKey(newGroupKey(), member.x25519.publicKey);
    expect(
      await unwrapGroupKey(wrapped, outsider.x25519.privateKey, member.x25519.publicKey),
    ).toBeNull();
  });

  it('returns null on an unknown version byte', async () => {
    const wrapped = await wrapGroupKey(newGroupKey(), member.x25519.publicKey);
    const tampered = wrapped.slice();
    tampered[0] = 0x02;
    expect(
      await unwrapGroupKey(tampered, member.x25519.privateKey, member.x25519.publicKey),
    ).toBeNull();
  });

  it('returns null when any byte is tampered with', async () => {
    const wrapped = await wrapGroupKey(newGroupKey(), member.x25519.publicKey);
    for (const index of [0, 1, 20, 48, 60, WRAPPED_KEY_BYTES - 1]) {
      expect(
        await unwrapGroupKey(
          flipByte(wrapped, index),
          member.x25519.privateKey,
          member.x25519.publicKey,
        ),
      ).toBeNull();
    }
  });

  it('returns null for every truncation', async () => {
    const wrapped = await wrapGroupKey(newGroupKey(), member.x25519.publicKey);
    for (let length = 0; length < WRAPPED_KEY_BYTES; length += 5) {
      expect(
        await unwrapGroupKey(
          wrapped.slice(0, length),
          member.x25519.privateKey,
          member.x25519.publicKey,
        ),
      ).toBeNull();
    }
  });

  it('never throws when fuzzed with random bytes', async () => {
    for (let i = 0; i < 400; i += 1) {
      const length = (seededBytes(i, 1)[0] ?? 0) % 200;
      const wrapped = seededBytes(i + 70_000, length);
      expect(
        await unwrapGroupKey(wrapped, member.x25519.privateKey, member.x25519.publicKey),
      ).toBeNull();
    }
  });

  it('never throws on correctly sized random bytes with a valid version', async () => {
    for (let i = 0; i < 200; i += 1) {
      const wrapped = seededBytes(i + 80_000, WRAPPED_KEY_BYTES);
      wrapped[0] = 0x01;
      expect(
        await unwrapGroupKey(wrapped, member.x25519.privateKey, member.x25519.publicKey),
      ).toBeNull();
    }
  });

  it('returns null for malformed key material', async () => {
    const wrapped = await wrapGroupKey(newGroupKey(), member.x25519.publicKey);
    expect(await unwrapGroupKey(wrapped, new Uint8Array(31), member.x25519.publicKey)).toBeNull();
    expect(await unwrapGroupKey(wrapped, member.x25519.privateKey, new Uint8Array(0))).toBeNull();
  });

  it('rejects a wrong-length group key or member key', async () => {
    await expect(wrapGroupKey(new Uint8Array(31), member.x25519.publicKey)).rejects.toThrow(
      /32 bytes/,
    );
    await expect(wrapGroupKey(newGroupKey(), new Uint8Array(31))).rejects.toThrow(/32 bytes/);
  });

  it('lets every member of a group unwrap the same epoch key', async () => {
    const key = newGroupKey();
    const members = [member, outsider, await freshIdentity()];
    for (const person of members) {
      const wrapped = await wrapGroupKey(key, person.x25519.publicKey);
      const unwrapped = await unwrapGroupKey(
        wrapped,
        person.x25519.privateKey,
        person.x25519.publicKey,
      );
      expect(toHex(unwrapped ?? new Uint8Array())).toBe(toHex(key));
    }
  });
});

describe('sealToGroup / openFromGroup', () => {
  it('round-trips a message', async () => {
    const key = newGroupKey();
    const drop = await sealToGroup(textMessage('gm group'), key);
    const opened = await openFromGroup(drop.blob, key);
    expect(opened?.body).toBe('gm group');
  });

  for (const bucket of BUCKETS) {
    it(`round-trips a message that fills the ${bucket}-byte bucket`, async () => {
      const key = newGroupKey();
      const body = bodyFillingBucket(bucket);
      const drop = await sealToGroup(textMessage(body), key);
      expect(drop.size).toBe(bucket);
      expect(drop.blob.length).toBe(CIPHERTEXT_OFFSET + bucket + MAC_BYTES);
      const opened = await openFromGroup(drop.blob, key);
      expect(opened?.body).toBe(body);
    });
  }

  it('uses 32 zero bytes as the ephemeral public key', async () => {
    const drop = await sealToGroup(textMessage('gm'), newGroupKey());
    expect(drop.ephPub).toBe(`0x${'00'.repeat(32)}`);
    expect(toHex(drop.blob.slice(1, 33))).toBe('00'.repeat(32));
  });

  it('derives the view tag from the epoch key', async () => {
    const key = newGroupKey();
    const a = await sealToGroup(textMessage('one'), key);
    const b = await sealToGroup(textMessage('two'), key);
    expect(a.viewTag).toBe(computeViewTag(key));
    expect(b.viewTag).toBe(a.viewTag);
  });

  it('changes the view tag when the epoch rotates', async () => {
    const tags = new Set<number>();
    for (let i = 0; i < 32; i += 1) {
      const drop = await sealToGroup(textMessage('rotate'), newGroupKey());
      tags.add(drop.viewTag);
    }
    expect(tags.size).toBeGreaterThan(1);
  });

  it('reports blobRef as the sha256 of the blob', async () => {
    const drop = await sealToGroup(textMessage('gm'), newGroupKey());
    expect(drop.blobRef).toBe(`0x${toHex(sha256(drop.blob))}`);
  });

  it('uses a fresh nonce for every drop', async () => {
    const key = newGroupKey();
    const a = await sealToGroup(textMessage('same'), key);
    const b = await sealToGroup(textMessage('same'), key);
    expect(toHex(a.blob.slice(33, 57))).not.toBe(toHex(b.blob.slice(33, 57)));
    expect(a.blobRef).not.toBe(b.blobRef);
  });

  it('hides length exactly as the 1:1 envelope does', async () => {
    const key = newGroupKey();
    const short = await sealToGroup(textMessage('x'.repeat(5)), key);
    const long = await sealToGroup(textMessage('x'.repeat(200)), key);
    expect(short.blob.length).toBe(long.blob.length);
    expect(short.size).toBe(long.size);
  });

  it('returns null for a rotated-away epoch key', async () => {
    const drop = await sealToGroup(textMessage('old epoch'), newGroupKey());
    expect(await openFromGroup(drop.blob, newGroupKey())).toBeNull();
  });

  it('returns null when the blob is tampered with', async () => {
    const key = newGroupKey();
    const drop = await sealToGroup(textMessage('gm'), key);
    for (const index of [0, 33, 56, 57, drop.blob.length - 1]) {
      expect(await openFromGroup(flipByte(drop.blob, index), key)).toBeNull();
    }
  });

  it('returns null for every truncation', async () => {
    const key = newGroupKey();
    const drop = await sealToGroup(textMessage('gm'), key);
    for (let length = 0; length < drop.blob.length; length += 11) {
      expect(await openFromGroup(drop.blob.slice(0, length), key)).toBeNull();
    }
  });

  it('never throws when fuzzed', async () => {
    const key = newGroupKey();
    for (let i = 0; i < 300; i += 1) {
      const length = ((seededBytes(i, 1)[0] ?? 0) * 3) % 400;
      expect(await openFromGroup(seededBytes(i + 40_000, length), key)).toBeNull();
    }
  });

  it('rejects a blob whose ephemeral-key slot is not all zeroes', async () => {
    // The slot is not an input to secretbox, so without an explicit check its 32 bytes
    // would be malleable: an attacker could mint a second, different blobRef for identical
    // content and defeat the relay's content addressing.
    const key = newGroupKey();
    const drop = await sealToGroup(textMessage('non-malleable'), key);
    for (const index of [1, 7, 16, 31, 32]) {
      const mutated = drop.blob.slice();
      mutated[index] = 0xff;
      expect(await openFromGroup(mutated, key)).toBeNull();
    }
  });

  it('rejects every genuinely mutated group blob', async () => {
    const key = newGroupKey();
    const drop = await sealToGroup(textMessage('mutation resistant'), key);
    for (let i = 0; i < 1_500; i += 1) {
      const mutated = drop.blob.slice();
      const index = randomBytes(2).readUInt16BE(0) % mutated.length;
      // XOR with 1..255 so the byte is guaranteed to actually change.
      mutated[index] = (mutated[index] ?? 0) ^ (1 + ((randomBytes(1)[0] ?? 0) % 255));
      expect(await openFromGroup(mutated, key)).toBeNull();
    }
  });

  it('returns null for a malformed group key', async () => {
    const key = newGroupKey();
    const drop = await sealToGroup(textMessage('gm'), key);
    expect(await openFromGroup(drop.blob, new Uint8Array(31))).toBeNull();
    expect(await openFromGroup(drop.blob, new Uint8Array(0))).toBeNull();
  });

  it('rejects a wrong-length group key when sealing', async () => {
    await expect(sealToGroup(textMessage('gm'), new Uint8Array(31))).rejects.toThrow(/32 bytes/);
  });

  it('rejects an oversized message', async () => {
    const body = 'x'.repeat(20_000);
    await expect(sealToGroup(textMessage(body), newGroupKey())).rejects.toThrow(/too large/);
  });
});

describe('memberRoot', () => {
  const a = '0x1111111111111111111111111111111111111111' as `0x${string}`;
  const b = '0x2222222222222222222222222222222222222222' as `0x${string}`;
  const c = '0x3333333333333333333333333333333333333333' as `0x${string}`;

  it('returns a 32-byte hex root', () => {
    expect(memberRoot([a, b, c])).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    expect(memberRoot([a, b, c])).toBe(memberRoot([a, b, c]));
  });

  it('is invariant under reordering', () => {
    const root = memberRoot([a, b, c]);
    expect(memberRoot([c, b, a])).toBe(root);
    expect(memberRoot([b, a, c])).toBe(root);
    expect(memberRoot([c, a, b])).toBe(root);
  });

  it('is invariant under checksum casing', () => {
    expect(memberRoot([a.toUpperCase().replace('0X', '0x') as `0x${string}`, b])).toBe(
      memberRoot([a, b]),
    );
  });

  it('de-duplicates members', () => {
    expect(memberRoot([a, b, a, b, a])).toBe(memberRoot([a, b]));
  });

  it('changes when a member is added', () => {
    expect(memberRoot([a, b])).not.toBe(memberRoot([a, b, c]));
  });

  it('changes when a member is removed', () => {
    expect(memberRoot([a, b, c])).not.toBe(memberRoot([a, c]));
  });

  it('changes when a member is replaced', () => {
    expect(memberRoot([a, b])).not.toBe(memberRoot([a, c]));
  });

  it('returns the zero root for an empty membership', () => {
    expect(memberRoot([])).toBe(`0x${'00'.repeat(32)}`);
  });

  it('handles a single member', () => {
    expect(memberRoot([a])).toMatch(/^0x[0-9a-f]{64}$/);
    expect(memberRoot([a])).not.toBe(memberRoot([b]));
  });

  it('handles odd member counts at every tree level', () => {
    const roots = new Set<string>();
    for (let size = 1; size <= 9; size += 1) {
      const members = Array.from(
        { length: size },
        (_, i) => `0x${i.toString(16).padStart(40, '0')}` as `0x${string}`,
      );
      roots.add(memberRoot(members));
    }
    expect(roots.size).toBe(9);
  });

  it('is stable for large memberships', () => {
    const members = Array.from(
      { length: 257 },
      (_, i) => `0x${i.toString(16).padStart(40, '0')}` as `0x${string}`,
    );
    const shuffled = [...members].reverse();
    expect(memberRoot(shuffled)).toBe(memberRoot(members));
  });

  it('rejects malformed addresses', () => {
    expect(() => memberRoot(['0x1234' as `0x${string}`])).toThrow(/20-byte/);
    expect(() => memberRoot([a, 'nope' as `0x${string}`])).toThrow(/members\[1\]/);
  });
});
