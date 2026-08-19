import { describe, expect, it } from 'vitest';
import {
  callTagFor,
  encodeCallSignal,
  losesGlare,
  newCallId,
  parseCallSignal,
  MAX_CANDIDATES_PER_SIGNAL,
  MAX_SDP_BYTES,
  type CallSignal,
} from './call-wire';

const ID = 'a'.repeat(32);
const KEY = `0x${'11'.repeat(32)}` as const;

const offer: CallSignal = { v: 1, type: 'call', op: 'offer', callId: ID, sdp: 'v=0\r\n' };

describe('parseCallSignal', () => {
  it('round-trips every op', () => {
    const cases: CallSignal[] = [
      offer,
      { v: 1, type: 'call', op: 'answer', callId: ID, sdp: 'v=0\r\n' },
      { v: 1, type: 'call', op: 'ringing', callId: ID },
      { v: 1, type: 'call', op: 'end', callId: ID, reason: 'hangup' },
      {
        v: 1,
        type: 'call',
        op: 'ice',
        callId: ID,
        cands: [{ candidate: 'candidate:1 1 udp', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: null }],
      },
    ];
    for (const signal of cases) {
      expect(parseCallSignal(encodeCallSignal(signal))).toEqual(signal);
    }
  });

  it('rejects anything that is not a call signal', () => {
    expect(parseCallSignal('not json')).toBeNull();
    expect(parseCallSignal(JSON.stringify({ type: 'roomKey' }))).toBeNull();
    expect(parseCallSignal(JSON.stringify({ ...offer, v: 2 }))).toBeNull();
    expect(parseCallSignal(JSON.stringify({ ...offer, op: 'evil' }))).toBeNull();
    expect(parseCallSignal(JSON.stringify({ ...offer, callId: 'short' }))).toBeNull();
  });

  it('refuses an oversized SDP rather than letting it spill a bucket', () => {
    const huge = { ...offer, sdp: 'x'.repeat(MAX_SDP_BYTES + 1) };
    expect(parseCallSignal(JSON.stringify(huge))).toBeNull();
    expect(() => encodeCallSignal(huge)).toThrow();
  });

  it('bounds ICE batches and rejects a malformed candidate', () => {
    const many = {
      ...offer,
      op: 'ice',
      cands: Array.from({ length: MAX_CANDIDATES_PER_SIGNAL + 1 }, () => ({
        candidate: 'c', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: null,
      })),
    };
    expect(parseCallSignal(JSON.stringify(many))).toBeNull();
    expect(parseCallSignal(JSON.stringify({ ...offer, op: 'ice', cands: [] }))).toBeNull();
    expect(parseCallSignal(JSON.stringify({ ...offer, op: 'ice', cands: [{ candidate: '' }] }))).toBeNull();
    const overlong = { ...offer, op: 'ice', cands: [{ candidate: 'c'.repeat(400) }] };
    expect(parseCallSignal(JSON.stringify(overlong))).toBeNull();
  });

  it('rejects an unknown end reason', () => {
    expect(parseCallSignal(JSON.stringify({ ...offer, op: 'end', reason: 'whatever' }))).toBeNull();
  });
});

describe('newCallId', () => {
  it('is 32 hex chars and does not repeat', () => {
    const a = newCallId();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(newCallId());
  });
});

describe('callTagFor', () => {
  it('is deterministic, 16 hex chars, and differs per key', () => {
    expect(callTagFor(KEY)).toMatch(/^[0-9a-f]{16}$/);
    expect(callTagFor(KEY)).toBe(callTagFor(KEY));
    expect(callTagFor(KEY)).not.toBe(callTagFor(`0x${'22'.repeat(32)}`));
  });
});

describe('losesGlare', () => {
  it('picks exactly one loser, whichever way round it is asked', () => {
    const low = '0x1111111111111111111111111111111111111111' as const;
    const high = '0x9999999999999999999999999999999999999999' as const;
    expect(losesGlare(low, high)).toBe(true);
    expect(losesGlare(high, low)).toBe(false);
  });
});
