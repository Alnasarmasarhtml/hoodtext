import { describe, expect, it } from 'vitest';
import { aggregateReactions, reactorKeyOf } from './reactions';
import type { ChatMessage } from './types';

const OWNER = '0x37bce0d2ce5d89e957bc3b5d751ad1321d2fb2bf' as const;
const PEER = '0x0fb26e8b3c4b355cf3711164b0062fba88b03804' as const;
const RELAY = '0x0187393a438bf98866d7a9235fdc1a82d48a63db' as const;
const TARGET = `0x${'ab'.repeat(32)}` as const;

let seq = 0;
function react(
  overrides: Partial<ChatMessage> & { emoji: string; op?: 'add' | 'remove' },
): ChatMessage {
  seq += 1;
  const { emoji, op, ...rest } = overrides;
  return {
    id: `${OWNER}:${String(seq)}`,
    owner: OWNER,
    convoId: `0x${'11'.repeat(32)}`,
    direction: 'in',
    body: JSON.stringify({ target: TARGET, emoji, op: op ?? 'add' }),
    kind: 'react',
    re: null,
    sentAt: 1000 + seq,
    status: 'received',
    integrity: 'verified',
    blobRef: `0x${seq.toString(16).padStart(64, '0')}`,
    ephPub: null,
    viewTag: null,
    size: null,
    seq,
    blockNumber: null,
    txHash: null,
    poster: RELAY,
    author: PEER,
    error: null,
    ...rest,
  };
}

function summary(messages: ChatMessage[], emoji: string) {
  return aggregateReactions(messages).get(TARGET)?.find((entry) => entry.emoji === emoji);
}

describe('aggregateReactions', () => {
  it('N identical adds from one person render as one', () => {
    const rows = [react({ emoji: '🔥' }), react({ emoji: '🔥' }), react({ emoji: '🔥' })];
    expect(summary(rows, '🔥')?.count).toBe(1);
  });

  it('a remove toggles the add off', () => {
    const rows = [react({ emoji: '🔥' }), react({ emoji: '🔥', op: 'remove' })];
    expect(summary(rows, '🔥')).toBeUndefined();
  });

  it('remove-before-add self-corrects once the add arrives', () => {
    const rows = [react({ emoji: '🔥', op: 'remove' }), react({ emoji: '🔥' })];
    expect(summary(rows, '🔥')?.count).toBe(1);
  });

  it('failed outbound reactions are excluded', () => {
    const rows = [react({ emoji: '🔥', direction: 'out', status: 'failed', author: null })];
    expect(summary(rows, '🔥')).toBeUndefined();
  });

  it('distinct people count separately, own reaction sets mine', () => {
    const rows = [
      react({ emoji: '🔥' }),
      react({ emoji: '🔥', direction: 'out', author: null, poster: OWNER }),
    ];
    const entry = summary(rows, '🔥');
    expect(entry?.count).toBe(2);
    expect(entry?.mine).toBe(true);
  });

  it('an own reaction arriving INBOUND (other device) still keys as me', () => {
    const rows = [
      react({ emoji: '🔥', direction: 'out', author: null, poster: OWNER }),
      // Same reaction, echoed back with our own verified author:
      react({ emoji: '🔥', author: OWNER }),
    ];
    const entry = summary(rows, '🔥');
    expect(entry?.count).toBe(1);
    expect(entry?.mine).toBe(true);
  });

  it('a hostile sender cannot exceed the distinct-emoji bound', () => {
    const rows = Array.from({ length: 20 }, (_, index) =>
      react({ emoji: `e${String(index)}` }),
    );
    const groups = aggregateReactions(rows).get(TARGET) ?? [];
    expect(groups.length).toBeLessThanOrEqual(8);
  });

  it('malformed payloads are skipped without throwing', () => {
    const rows = [react({ emoji: '🔥' })];
    rows.push({ ...react({ emoji: 'x' }), body: 'not json' });
    rows.push({ ...react({ emoji: 'x' }), body: JSON.stringify({ target: 'bad', emoji: 'x' }) });
    expect(summary(rows, '🔥')?.count).toBe(1);
  });
});

describe('reactorKeyOf', () => {
  it('outbound is me; verified peer author is the peer; own author is me', () => {
    expect(reactorKeyOf(react({ emoji: 'x', direction: 'out', author: null }))).toBe('me');
    expect(reactorKeyOf(react({ emoji: 'x', author: PEER }))).toBe(PEER);
    expect(reactorKeyOf(react({ emoji: 'x', author: OWNER }))).toBe('me');
    expect(reactorKeyOf(react({ emoji: 'x', author: null }))).toBe(RELAY);
  });
});
