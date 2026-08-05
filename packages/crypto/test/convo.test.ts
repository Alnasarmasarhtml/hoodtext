import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { convoIdFor, groupIdFor } from '../src/index';
import { seededBytes } from './helpers';

const keyA = seededBytes(1, 32);
const keyB = seededBytes(2, 32);
const keyC = seededBytes(3, 32);

const CREATOR = '0x1234567890AbcdEF1234567890aBcdef12345678';
const SALT = `0x${'ab'.repeat(32)}` as `0x${string}`;

describe('convoIdFor', () => {
  it('returns a 32-byte hex id', () => {
    expect(convoIdFor(keyA, keyB)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('is symmetric in its arguments', () => {
    expect(convoIdFor(keyA, keyB)).toBe(convoIdFor(keyB, keyA));
    expect(convoIdFor(keyC, keyA)).toBe(convoIdFor(keyA, keyC));
  });

  it('is deterministic across calls', () => {
    expect(convoIdFor(keyA, keyB)).toBe(convoIdFor(keyA, keyB));
  });

  it('differs for different pairs', () => {
    const ab = convoIdFor(keyA, keyB);
    const ac = convoIdFor(keyA, keyC);
    const bc = convoIdFor(keyB, keyC);
    expect(new Set([ab, ac, bc]).size).toBe(3);
  });

  it('matches a pinned vector', () => {
    expect(convoIdFor(keyA, keyB)).toBe(
      '0x41cba0186e27aef0743ed374cc18bcf797abe1367e66d5db8676bc8d84da7c02',
    );
  });

  it('really is sha256 of the sorted concatenation', () => {
    // Independently recomputed with Node's own SHA-256.
    const ordered =
      Buffer.compare(Buffer.from(keyA), Buffer.from(keyB)) <= 0 ? [keyA, keyB] : [keyB, keyA];
    const digest = createHash('sha256')
      .update(Buffer.concat([Buffer.from(ordered[0] ?? new Uint8Array()), Buffer.from(ordered[1] ?? new Uint8Array())]))
      .digest('hex');
    expect(convoIdFor(keyA, keyB)).toBe(`0x${digest}`);
  });

  it('handles a self-conversation', () => {
    expect(convoIdFor(keyA, keyA)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('changes when a single key byte changes', () => {
    const mutated = keyB.slice();
    mutated[31] = ((mutated[31] ?? 0) ^ 0x01) & 0xff;
    expect(convoIdFor(keyA, mutated)).not.toBe(convoIdFor(keyA, keyB));
  });

  it('rejects keys that are not 32 bytes', () => {
    expect(() => convoIdFor(new Uint8Array(31), keyB)).toThrow(/32 bytes/);
    expect(() => convoIdFor(keyA, new Uint8Array(33))).toThrow(/32 bytes/);
    expect(() => convoIdFor(new Uint8Array(0), keyB)).toThrow(/32 bytes/);
  });
});

describe('groupIdFor', () => {
  it('returns a 32-byte hex id', () => {
    expect(groupIdFor('signals', CREATOR as `0x${string}`, SALT)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    expect(groupIdFor('signals', CREATOR as `0x${string}`, SALT)).toBe(
      groupIdFor('signals', CREATOR as `0x${string}`, SALT),
    );
  });

  it('is insensitive to creator address checksum casing', () => {
    expect(groupIdFor('signals', CREATOR.toLowerCase() as `0x${string}`, SALT)).toBe(
      groupIdFor('signals', CREATOR.toUpperCase().replace('0X', '0x') as `0x${string}`, SALT),
    );
  });

  it('changes when the name changes', () => {
    expect(groupIdFor('signals', CREATOR as `0x${string}`, SALT)).not.toBe(
      groupIdFor('signal', CREATOR as `0x${string}`, SALT),
    );
  });

  it('changes when the creator changes', () => {
    const other = '0x00000000000000000000000000000000000000ff' as `0x${string}`;
    expect(groupIdFor('signals', CREATOR as `0x${string}`, SALT)).not.toBe(
      groupIdFor('signals', other, SALT),
    );
  });

  it('changes when the salt changes', () => {
    const otherSalt = `0x${'cd'.repeat(32)}` as `0x${string}`;
    expect(groupIdFor('signals', CREATOR as `0x${string}`, SALT)).not.toBe(
      groupIdFor('signals', CREATOR as `0x${string}`, otherSalt),
    );
  });

  it('is unambiguous across name/creator boundaries', () => {
    // Without length prefixing, "ab" + creator and "a" + "b" + creator could collide.
    const a = groupIdFor('ab', CREATOR as `0x${string}`, SALT);
    const b = groupIdFor('a', CREATOR as `0x${string}`, SALT);
    expect(a).not.toBe(b);
  });

  it('accepts an empty name and a short salt', () => {
    expect(groupIdFor('', CREATOR as `0x${string}`, '0x')).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('accepts unicode group names', () => {
    expect(groupIdFor('пример 🛰', CREATOR as `0x${string}`, SALT)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('rejects a malformed creator address', () => {
    expect(() => groupIdFor('signals', '0x1234' as `0x${string}`, SALT)).toThrow(/20-byte/);
    expect(() => groupIdFor('signals', 'nope' as `0x${string}`, SALT)).toThrow(/20-byte/);
  });

  it('rejects a malformed salt', () => {
    expect(() => groupIdFor('signals', CREATOR as `0x${string}`, '0xzz' as `0x${string}`)).toThrow(
      /hex string/,
    );
    expect(() => groupIdFor('signals', CREATOR as `0x${string}`, '0xabc' as `0x${string}`)).toThrow(
      /even number/,
    );
  });

  it('never collides with a conversation id for the same bytes', () => {
    const ids = new Set([
      convoIdFor(keyA, keyB),
      groupIdFor('signals', CREATOR as `0x${string}`, SALT),
    ]);
    expect(ids.size).toBe(2);
  });
});
