/**
 * Pure helpers of the messenger store.
 *
 * The three `parse*` functions read attacker-controlled plaintext — a body that
 * came out of a blob anyone could have anchored. They are the boundary between
 * "decrypted" and "trusted", so what they reject matters as much as what they
 * accept.
 */
import type { Address, Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { messageId, peerId, roomId } from './message-store';
import {
  compareMessages,
  parseMediaPayload,
  parseReactionPayload,
  parseRoomKeyPayload,
  type ChatMessage,
} from './types';

const OWNER = `0x${'11'.repeat(20)}` as Address;
const REF32 = `0x${'ab'.repeat(32)}` as Hex;

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'id',
    owner: OWNER,
    convoId: REF32,
    direction: 'in',
    body: '',
    kind: 'text',
    re: null,
    sentAt: 0,
    status: 'received',
    integrity: 'verified',
    blobRef: null,
    ephPub: null,
    viewTag: null,
    size: null,
    seq: null,
    blockNumber: null,
    txHash: null,
    poster: null,
    author: null,
    error: null,
    ...overrides,
  };
}

describe('compareMessages', () => {
  it('orders oldest first', () => {
    const older = message({ id: 'a', sentAt: 100 });
    const newer = message({ id: 'b', sentAt: 200 });
    expect([newer, older].sort(compareMessages).map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('breaks a timestamp tie on seq', () => {
    const first = message({ id: 'a', sentAt: 100, seq: 4 });
    const second = message({ id: 'b', sentAt: 100, seq: 9 });
    expect([second, first].sort(compareMessages).map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('sorts an un-anchored draft below an anchor of the same second', () => {
    // A pending row has no seq, so it must sink to the bottom of that second
    // rather than jump above rows that are already on chain.
    const anchored = message({ id: 'a', sentAt: 100, seq: 12 });
    const draft = message({ id: 'b', sentAt: 100, seq: null });
    expect([draft, anchored].sort(compareMessages).map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('is a total order — equal sentAt and seq fall back to the id', () => {
    const a = message({ id: 'a', sentAt: 100, seq: 3 });
    const b = message({ id: 'b', sentAt: 100, seq: 3 });
    expect(compareMessages(a, b)).toBeLessThan(0);
    expect(compareMessages(b, a)).toBeGreaterThan(0);
    expect(compareMessages(a, a)).toBe(0);
  });
});

describe('parseRoomKeyPayload', () => {
  const valid = {
    type: 'roomKey',
    groupId: `0x${'cd'.repeat(32)}`,
    epoch: 2,
    name: 'Back Room',
    wrapped: `0x${'ef'.repeat(81)}`,
  };

  it('accepts a well-formed payload and lower-cases the hex', () => {
    const parsed = parseRoomKeyPayload(
      JSON.stringify({ ...valid, groupId: `0x${'CD'.repeat(32)}` }),
    );
    expect(parsed).toEqual({
      type: 'roomKey',
      groupId: valid.groupId,
      epoch: 2,
      name: 'Back Room',
      wrapped: valid.wrapped,
    });
  });

  it('rejects anything that is not a room-key payload', () => {
    expect(parseRoomKeyPayload('not json')).toBeNull();
    expect(parseRoomKeyPayload('"a string"')).toBeNull();
    expect(parseRoomKeyPayload('[1,2,3]')).toBeNull();
    expect(parseRoomKeyPayload(JSON.stringify({ ...valid, type: 'other' }))).toBeNull();
  });

  it('rejects a malformed group id, epoch or wrapping', () => {
    expect(parseRoomKeyPayload(JSON.stringify({ ...valid, groupId: '0xdead' }))).toBeNull();
    expect(parseRoomKeyPayload(JSON.stringify({ ...valid, epoch: -1 }))).toBeNull();
    expect(parseRoomKeyPayload(JSON.stringify({ ...valid, epoch: 1.5 }))).toBeNull();
    expect(parseRoomKeyPayload(JSON.stringify({ ...valid, epoch: '2' }))).toBeNull();
    expect(parseRoomKeyPayload(JSON.stringify({ ...valid, wrapped: 'ef00' }))).toBeNull();
  });

  it('accepts an empty room name but not a missing one', () => {
    expect(parseRoomKeyPayload(JSON.stringify({ ...valid, name: '' }))?.name).toBe('');
    expect(parseRoomKeyPayload(JSON.stringify({ ...valid, name: 7 }))).toBeNull();
  });
});

describe('parseReactionPayload', () => {
  it('accepts a reaction and lower-cases the target', () => {
    const parsed = parseReactionPayload(
      JSON.stringify({ target: `0x${'AB'.repeat(32)}`, emoji: '🔥' }),
    );
    expect(parsed).toEqual({ target: REF32, emoji: '🔥', op: 'add' });
  });

  it('rejects an empty emoji, an over-long one, or a bad target', () => {
    expect(parseReactionPayload(JSON.stringify({ target: REF32, emoji: '' }))).toBeNull();
    expect(
      parseReactionPayload(JSON.stringify({ target: REF32, emoji: 'x'.repeat(17) })),
    ).toBeNull();
    expect(
      parseReactionPayload(JSON.stringify({ target: REF32, emoji: 'x'.repeat(16) })),
    ).not.toBeNull();
    expect(parseReactionPayload(JSON.stringify({ target: '0x00', emoji: '👍' }))).toBeNull();
  });
});

describe('parseMediaPayload', () => {
  const valid = {
    mime: 'image/png',
    name: 'shot.png',
    bytes: 1024,
    ref: REF32,
    key: `0x${'11'.repeat(32)}`,
  };

  it('accepts a descriptor and omits src when absent', () => {
    expect(parseMediaPayload(JSON.stringify(valid))).toEqual(valid);
    expect(parseMediaPayload(JSON.stringify({ ...valid, src: '' }))).not.toHaveProperty('src');
  });

  it('keeps a non-empty src', () => {
    expect(parseMediaPayload(JSON.stringify({ ...valid, src: '/demo/a.png' }))?.src).toBe(
      '/demo/a.png',
    );
  });

  it('rejects a missing mime, a negative size or a short ref', () => {
    expect(parseMediaPayload(JSON.stringify({ ...valid, mime: '' }))).toBeNull();
    expect(parseMediaPayload(JSON.stringify({ ...valid, bytes: -1 }))).toBeNull();
    expect(parseMediaPayload(JSON.stringify({ ...valid, ref: '0xabcd' }))).toBeNull();
    expect(parseMediaPayload(JSON.stringify({ ...valid, key: 'nothex' }))).toBeNull();
  });
});

describe('record ids', () => {
  it('are case-insensitive, so a checksummed address cannot fork a row', () => {
    const checksummed = `0x${'11'.repeat(20)}`.toUpperCase().replace('0X', '0x') as Address;
    expect(messageId(checksummed, REF32.toUpperCase() as Hex)).toBe(messageId(OWNER, REF32));
    expect(peerId(checksummed, REF32)).toBe(peerId(OWNER, REF32));
    expect(roomId(checksummed, REF32)).toBe(roomId(OWNER, REF32));
  });

  it('namespaces every row by owner', () => {
    const other = `0x${'22'.repeat(20)}` as Address;
    expect(messageId(OWNER, REF32)).not.toBe(messageId(other, REF32));
    expect(messageId(OWNER, REF32)).toBe(`${OWNER}:${REF32}`);
  });
});
