/**
 * Reaction aggregation: SET semantics, one reaction per emoji per person per
 * message, toggled by `op: 'add' | 'remove'` events.
 *
 * The transport is an append-only anchored log, so dedup cannot live anywhere
 * but here, at read time. The state per (target, reactor, emoji) is a boolean
 * decided last-op-wins over the store's (sentAt, seq, id) order — idempotent
 * under replay: a hostile sender replaying fifty identical `add`s still
 * renders as a single reaction.
 *
 * Reactor identity: own rows key as `'me'`; inbound rows key on the VERIFIED
 * in-payload author when present, else the on-chain poster. Relayed room
 * reactions from legacy clients (no signed author) all share the relay's
 * poster address and therefore collapse into one — an undercount, which is
 * the safe failure, never the spam the counter version allowed.
 */
import type { ChatMessage } from './types';
import { parseReactionPayload } from './types';

export interface ReactionSummary {
  readonly emoji: string;
  /** Number of distinct people whose reaction of this emoji is currently ON. */
  readonly count: number;
  /** Whether the viewer's own reaction of this emoji is currently ON. */
  readonly mine: boolean;
}

/** Most distinct emoji one reactor may hold on one message. */
const MAX_EMOJI_PER_REACTOR = 8;
/** Most emoji groups rendered per message. */
const MAX_GROUPS_PER_TARGET = 16;

/** The reactor key one message aggregates under. Exported so send-side toggle state matches. */
export function reactorKeyOf(message: ChatMessage): string {
  if (message.direction === 'out') return 'me';
  if (message.author !== null) return message.author.toLowerCase();
  return message.poster?.toLowerCase() ?? 'unknown';
}

/**
 * Folds every `react` row into per-target summaries.
 *
 * @param messages - the conversation's rows, ALREADY in store order
 *   (sentAt, then seq, then id) — the order is what makes last-op-wins correct.
 * @returns summaries keyed by lowercased target blobRef.
 */
export function aggregateReactions(
  messages: readonly ChatMessage[],
): Map<string, readonly ReactionSummary[]> {
  /* target -> reactor -> emoji -> on/off */
  const state = new Map<string, Map<string, Map<string, boolean>>>();

  for (const message of messages) {
    if (message.kind !== 'react') continue;
    // A failed outbound toggle must not stick — and its absence also gives
    // optimistic rollback for free when a send errors out.
    if (message.status === 'failed') continue;
    const payload = parseReactionPayload(message.body);
    if (payload === null) continue;

    const target = payload.target.toLowerCase();
    const reactor = reactorKeyOf(message);

    let perReactor = state.get(target);
    if (perReactor === undefined) {
      perReactor = new Map();
      state.set(target, perReactor);
    }
    let perEmoji = perReactor.get(reactor);
    if (perEmoji === undefined) {
      perEmoji = new Map();
      perReactor.set(reactor, perEmoji);
    }
    if (!perEmoji.has(payload.emoji) && perEmoji.size >= MAX_EMOJI_PER_REACTOR) {
      continue; // hostile variety bound: first-seen emoji win
    }
    perEmoji.set(payload.emoji, payload.op === 'add');
  }

  const summaries = new Map<string, readonly ReactionSummary[]>();
  for (const [target, perReactor] of state) {
    const counts = new Map<string, { count: number; mine: boolean }>();
    for (const [reactor, perEmoji] of perReactor) {
      for (const [emoji, on] of perEmoji) {
        if (!on) continue;
        const entry = counts.get(emoji) ?? { count: 0, mine: false };
        counts.set(emoji, {
          count: entry.count + 1,
          mine: entry.mine || reactor === 'me',
        });
      }
    }
    if (counts.size === 0) continue;
    const groups = [...counts.entries()]
      .map(([emoji, entry]) => ({ emoji, count: entry.count, mine: entry.mine }))
      .slice(0, MAX_GROUPS_PER_TARGET);
    summaries.set(target, groups);
  }
  return summaries;
}
