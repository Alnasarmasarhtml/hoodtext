/**
 * Shared types for the messenger (SPEC §7.3).
 *
 * A 1:1 conversation is a purely local threading key: `convoIdFor(myX25519Pub,
 * peerX25519Pub)`. It is deliberately NOT what goes on chain — 1:1 drops post
 * `convoId = 0x0` so the chain never links two participants (SPEC §4.6).
 * A room's conversation id IS its on-chain `groupId`: rooms are announced by
 * design, membership is not.
 */
import type { Address, Hex } from 'viem';

/** 32 zero bytes — the on-chain `convoId` for a stealth 1:1 drop. */
export const STEALTH_CONVO_ID: Hex = `0x${'00'.repeat(32)}`;

/**
 * Local bucket for drops we could decrypt but cannot attribute to a sender —
 * a relayed post, or a poster who has not registered keys. Never a chain value.
 */
export const UNATTRIBUTED_CONVO_ID: Hex = `0x${'ff'.repeat(32)}`;

/** Direction of a message relative to the connected wallet. */
export type MessageDirection = 'in' | 'out';

/** Every kind the wire format carries, mirrored from `@hoodgram/crypto`. */
export type MessageKind = 'text' | 'system' | 'media' | 'react';

/**
 * Lifecycle of one message.
 *
 * The gasless path walks `sealing → uploading → queued → anchored`: `queued`
 * means the relay verified the drop signature and accepted it, and the row
 * flips to `anchored` when the WS stream delivers the drop whose `blobRef`
 * matches. The wallet path walks `sealing → uploading → signing → pending →
 * anchored`. Either can drop into `failed`. Inbound arrives `received`.
 */
export type MessageStatus =
  | 'sealing'
  | 'uploading'
  | 'signing'
  | 'queued'
  | 'pending'
  | 'anchored'
  | 'failed'
  | 'received';

/**
 * `verified` — the blob we fetched hashes to the `blobRef` recorded on chain.
 * `local`    — we produced the ciphertext ourselves, so there is nothing to verify.
 * `unverified` — this browser has no WebCrypto SHA-256, so the check was skipped.
 */
export type MessageIntegrity = 'verified' | 'local' | 'unverified';

/** One rendered row in a thread. */
export interface ChatMessage {
  /** `${owner}:${blobRef}` once a blob exists, otherwise a local draft id. */
  readonly id: string;
  /** Lower-cased wallet address this message belongs to. */
  readonly owner: Address;
  /** Local threading key — a DM convo id, or a room's `groupId`. */
  readonly convoId: Hex;
  readonly direction: MessageDirection;
  /**
   * `text`: the message itself. `media`: a JSON descriptor pointing at a
   * separately encrypted blob. `react`: JSON `{ target, emoji }`. `system`:
   * an app-generated note, already human-readable.
   */
  readonly body: string;
  readonly kind: MessageKind;
  /** blobRef of the message this one replies to, if any. */
  readonly re: Hex | null;
  /** Unix seconds. Inbound uses the sealed `t`; outbound uses the local clock. */
  readonly sentAt: number;
  readonly status: MessageStatus;
  readonly integrity: MessageIntegrity;
  readonly blobRef: Hex | null;
  readonly ephPub: Hex | null;
  readonly viewTag: number | null;
  /** Padded bucket size in bytes — never the true plaintext length. */
  readonly size: number | null;
  readonly seq: number | null;
  readonly blockNumber: number | null;
  readonly txHash: Hex | null;
  /**
   * The address that posted the anchor. On the gasless path this is the
   * relay, not the author — own messages are recognised by `blobRef`, never
   * by poster.
   */
  readonly poster: Address | null;
  /**
   * The VERIFIED author, from the signed `from` inside the sealed payload —
   * checked against the address's registered Ed25519 key. `null` for own
   * messages, legacy payloads, and anything whose signature failed. This is
   * the field attribution and reaction identity key off; `poster` is only a
   * transport detail.
   */
  readonly author: Address | null;
  /** Human-readable failure reason, surfaced inline in the row. */
  readonly error: string | null;
}

/** What we know about the other side of a conversation. */
export interface PeerRecord {
  /** `${owner}:${convoId}`. */
  readonly id: string;
  readonly owner: Address;
  readonly convoId: Hex;
  /** `null` for the unattributed bucket. */
  readonly address: Address | null;
  /** Their registered X25519 public key — required to reply. */
  readonly x25519Pub: Hex | null;
  /** Their registered Ed25519 key — caches author-signature verification. */
  readonly ed25519Pub: Hex | null;
  readonly createdAt: number;
  readonly lastSeenAt: number;
}

/**
 * A room this device belongs to.
 *
 * The member list is LOCAL knowledge: the chain holds only a Merkle
 * commitment (`memberRoot`), so each device keeps the roster it has learned —
 * the creator from creating, members from the admin's key drops. Rent state
 * (`paidUntil`, `isActive`) is read live from `GroupRegistry`, never cached
 * here.
 */
export interface RoomRecord {
  /** `${owner}:${groupId}`. */
  readonly id: string;
  readonly owner: Address;
  /** On-chain group id — also the room's conversation id. */
  readonly groupId: Hex;
  /** Display name, carried inside key drops; never on chain. */
  readonly name: string;
  /** The admin as this device last knew it; the chain read wins. */
  readonly admin: Address | null;
  /** Lower-cased member addresses this device knows about. */
  readonly members: readonly Address[];
  /** Highest key epoch this device holds a group key for. */
  readonly epoch: number;
  readonly createdAt: number;
  readonly lastSeenAt: number;
}

/** A conversation as the list and thread render it. */
export interface Conversation {
  readonly convoId: Hex;
  /** Set when this conversation is a room; `null` for DMs. */
  readonly room: RoomRecord | null;
  readonly peerAddress: Address | null;
  readonly peerX25519: Hex | null;
  readonly lastMessage: ChatMessage | null;
  /** Unix seconds of the most recent activity, for ordering. */
  readonly lastActivity: number;
  readonly messageCount: number;
  readonly anchoredCount: number;
  readonly pendingCount: number;
  readonly failedCount: number;
  /** True for the bucket of drops we decrypted but cannot attribute. */
  readonly unattributed: boolean;
  /** False when this device holds no key to seal with. */
  readonly canReply: boolean;
}

/** A blob whose bytes did not hash to the `blobRef` recorded on chain. */
export interface TamperEvent {
  readonly seq: number;
  readonly blobRef: Hex;
  readonly computed: Hex;
  readonly poster: Address;
  /** Unix seconds, from the anchor. */
  readonly at: number;
}

/** Newest first. Ties break on `seq` so optimistic rows sit under anchors. */
export function compareMessages(a: ChatMessage, b: ChatMessage): number {
  if (a.sentAt !== b.sentAt) return a.sentAt - b.sentAt;
  const aSeq = a.seq ?? Number.MAX_SAFE_INTEGER;
  const bSeq = b.seq ?? Number.MAX_SAFE_INTEGER;
  if (aSeq !== bSeq) return aSeq - bSeq;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/* ═══════════════════════════════════════════════ wire payload helpers ═══ */

/** The JSON a `system` room-key drop carries, sealed 1:1 to each member. */
export interface RoomKeyPayload {
  readonly type: 'roomKey';
  readonly groupId: Hex;
  readonly epoch: number;
  readonly name: string;
  /** Hex of `wrapGroupKey(groupKey, memberX25519Pub)`. */
  readonly wrapped: Hex;
}

/** The JSON a `react` drop carries. */
export interface ReactionPayload {
  /** blobRef of the message being reacted to. */
  readonly target: Hex;
  readonly emoji: string;
  /**
   * Toggle op. Reactions are one-per-emoji-per-person: `add` turns the emoji
   * on for the sender, `remove` turns it off; the aggregation is last-op-wins
   * set semantics, so replaying N identical adds still renders as one.
   * Legacy payloads without the field parse as `add`.
   */
  readonly op: 'add' | 'remove';
}

const HEX32_RE = /^0x[0-9a-fA-F]{64}$/;
const HEX_RE = /^0x[0-9a-fA-F]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse a room-key payload out of a `system` body. `null` for anything else. */
export function parseRoomKeyPayload(body: string): RoomKeyPayload | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const { type, groupId, epoch, name, wrapped } = raw as Record<string, unknown>;
  if (type !== 'roomKey') return null;
  if (typeof groupId !== 'string' || !HEX32_RE.test(groupId)) return null;
  if (typeof epoch !== 'number' || !Number.isInteger(epoch) || epoch < 0) return null;
  if (typeof name !== 'string') return null;
  if (typeof wrapped !== 'string' || !HEX_RE.test(wrapped)) return null;
  return {
    type: 'roomKey',
    groupId: groupId.toLowerCase() as Hex,
    epoch,
    name,
    wrapped: wrapped.toLowerCase() as Hex,
  };
}

/** Parse a reaction payload out of a `react` body. `null` when malformed. */
export function parseReactionPayload(body: string): ReactionPayload | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const { target, emoji, op } = raw as Record<string, unknown>;
  if (typeof target !== 'string' || !HEX32_RE.test(target)) return null;
  if (typeof emoji !== 'string' || emoji === '' || emoji.length > 16) return null;
  if (op !== undefined && op !== 'add' && op !== 'remove') return null;
  return { target: target.toLowerCase() as Hex, emoji, op: op === 'remove' ? 'remove' : 'add' };
}

/** The JSON descriptor carried in a `media` body (`@hoodgram/crypto` shape). */
export interface MediaPayload {
  readonly mime: string;
  readonly name: string;
  readonly bytes: number;
  readonly ref: Hex;
  readonly key: Hex;
  /**
   * Locally resolvable source (an asset path or object URL). Only demo-mode
   * fixtures and demo-mode attachments carry it — real descriptors never do,
   * and the renderer skips the fetch-and-decrypt round trip when present.
   */
  readonly src?: string;
}

/** Parse a media descriptor out of a `media` body. `null` when malformed. */
export function parseMediaPayload(body: string): MediaPayload | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const { mime, name, bytes, ref, key, src } = raw as Record<string, unknown>;
  if (typeof mime !== 'string' || mime === '') return null;
  if (typeof name !== 'string') return null;
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null;
  if (typeof ref !== 'string' || !HEX32_RE.test(ref)) return null;
  if (typeof key !== 'string' || !HEX_RE.test(key)) return null;
  const parsed: MediaPayload = {
    mime,
    name,
    bytes,
    ref: ref.toLowerCase() as Hex,
    key: key.toLowerCase() as Hex,
  };
  return typeof src === 'string' && src !== '' ? { ...parsed, src } : parsed;
}
