/**
 * The receive engine (SPEC §7.3).
 *
 * Backfills `GET /v1/drops`, then follows the relay WebSocket. For every anchor
 * it runs the same steps:
 *
 *   0. Reconcile: if this device holds an outbound row whose `blobRef` matches
 *      the drop, that row flips to `anchored` — by blobRef, never by poster,
 *      because on the gasless path the on-chain poster is the relay.
 *   1. Route: a non-zero `convoId` is a room drop, opened with the group key
 *      for that epoch. A zero `convoId` is a stealth 1:1 drop, filtered by
 *      `scanMatches(ephPub, viewTag, myPriv)`.
 *   2. Fetch the ciphertext by `blobRef`.
 *   3. Recompute sha256 over those bytes and compare it with the `blobRef`
 *      recorded on chain. A mismatch means the relay served bytes that are not
 *      what was anchored — raised as a crimson tamper event.
 *   4. Open. A `null` here is the expected outcome of a view-tag false
 *      positive and is discarded silently.
 *
 * 1:1 `system` drops carrying a room-key payload are applied rather than
 * displayed: the wrapped group key is unwrapped and stored, and the room
 * appears (or rotates) on this device with a quiet system note in its thread.
 *
 * State lives in a module-level store rather than React context so the
 * conversation list and the thread read the same rows across a route change,
 * and so the engine survives navigation without re-scanning.
 */
import {
  computeViewTag,
  convoIdFor,
  open as openEnvelope,
  openFromGroup,
  scanMatches,
  unwrapGroupKey,
} from '@hoodgram/crypto';
import type { IdentityKeys, Plaintext } from '@hoodgram/crypto';
import { hexToBytes, sha256, type Address, type Hex } from 'viem';
import { create } from 'zustand';

import { getBlob, getDrops, type DropRow } from '@/lib/relay';
import {
  deleteMessage,
  loadMessages,
  loadPeers,
  loadRoomKeys,
  loadRooms,
  loadScanCursor,
  messageId,
  peerId,
  roomId,
  saveMessage,
  saveMessages,
  savePeer,
  saveRoom,
  saveRoomKey,
  saveScanCursor,
  wipeMessages,
} from './message-store';
import { subscribeToRelay } from './relay-stream';
import {
  STEALTH_CONVO_ID,
  UNATTRIBUTED_CONVO_ID,
  compareMessages,
  parseRoomKeyPayload,
  type ChatMessage,
  type PeerRecord,
  type RoomRecord,
  type TamperEvent,
} from './types';

/** Page size for the backfill sweep. */
const BACKFILL_LIMIT = 200;
/**
 * Backoff before another sweep after an aborted one.
 *
 * `GET /v1/drops` is rate-limited, so a 429 mid-sweep is an ordinary event, not
 * an exceptional one. An aborted sweep used to leave the gap for a human to
 * notice and press "resync"; these delays retry it instead. Exhausting the
 * schedule still leaves `resyncMessenger`, and the scan cursor stays clamped
 * below the gap the whole time, so nothing is lost by giving up on the timer.
 */
const BACKFILL_RETRY_DELAYS_MS = [250, 1_000, 4_000, 15_000] as const;
/** How many tamper events to keep in the banner before dropping the oldest. */
const MAX_TAMPER_EVENTS = 12;
/** Grace period before tearing the engine down, so StrictMode does not thrash. */
const DETACH_GRACE_MS = 250;

const ZERO_KEY: Hex = `0x${'00'.repeat(32)}`;

/** Resolves registered X25519 public keys for a set of addresses. */
export type PeerKeyResolver = (
  addresses: readonly Address[],
) => Promise<ReadonlyMap<string, Hex>>;

export interface MessengerAttachment {
  readonly owner: Address;
  readonly keys: IdentityKeys;
  readonly resolvePeerKeys: PeerKeyResolver;
}

export interface MessengerState {
  readonly owner: Address | null;
  /** True once the IndexedDB cache has been read into memory. */
  readonly hydrated: boolean;
  readonly backfilling: boolean;
  /** Highest relay `seq` scanned so far. */
  readonly scannedSeq: number;
  /** Relay head at the last poll. */
  readonly head: number;
  /** Anchors examined this session. */
  readonly scanned: number;
  /** View-tag matches this session, before decryption. */
  readonly matched: number;
  readonly messages: readonly ChatMessage[];
  readonly peers: readonly PeerRecord[];
  readonly rooms: readonly RoomRecord[];
  readonly tamperEvents: readonly TamperEvent[];
  readonly error: string | null;
}

const EMPTY_STATE: MessengerState = {
  owner: null,
  hydrated: false,
  backfilling: false,
  scannedSeq: 0,
  head: 0,
  scanned: 0,
  matched: 0,
  messages: [],
  peers: [],
  rooms: [],
  tamperEvents: [],
  error: null,
};

export const useMessengerStore = create<MessengerState>()(() => EMPTY_STATE);

const setState = useMessengerStore.setState;
const getState = useMessengerStore.getState;

/* ═════════════════════════════════════════════════════════ state edits ══ */

function mergeMessages(
  existing: readonly ChatMessage[],
  incoming: readonly ChatMessage[],
): readonly ChatMessage[] {
  if (incoming.length === 0) return existing;
  const byId = new Map<string, ChatMessage>();
  for (const message of existing) byId.set(message.id, message);
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort(compareMessages);
}

/** Adds or replaces rows in memory. Persistence is the caller's business. */
export function putMessages(incoming: readonly ChatMessage[]): void {
  if (incoming.length === 0) return;
  setState((state) => ({ messages: mergeMessages(state.messages, incoming) }));
}

/** Row by id, or `null`. */
export function findMessage(id: string): ChatMessage | null {
  return getState().messages.find((message) => message.id === id) ?? null;
}

/**
 * Applies a patch to one row and writes it back to IndexedDB.
 *
 * @returns the updated row, or `null` when the id is unknown.
 */
export async function patchMessage(
  id: string,
  patch: Partial<Omit<ChatMessage, 'id' | 'owner'>>,
): Promise<ChatMessage | null> {
  const current = findMessage(id);
  if (current === null) return null;
  const next: ChatMessage = { ...current, ...patch };
  putMessages([next]);
  await saveMessage(next);
  return next;
}

/** Replaces a row's id — used when an optimistic draft learns its `blobRef`. */
export async function renameMessage(fromId: string, toId: string): Promise<void> {
  const current = findMessage(fromId);
  if (current === null || fromId === toId) return;
  setState((state) => ({
    messages: mergeMessages(
      state.messages.filter((message) => message.id !== fromId),
      [{ ...current, id: toId }],
    ),
  }));
  await saveMessage({ ...current, id: toId });
}

/** Adds a row to memory and to the cache. */
export async function addMessage(message: ChatMessage): Promise<void> {
  putMessages([message]);
  await saveMessage(message);
}

/** Drops a row entirely — used when a failed send is retried. */
export async function removeMessage(id: string): Promise<void> {
  setState((state) => ({ messages: state.messages.filter((message) => message.id !== id) }));
  await deleteMessage(id);
}

export function findPeer(convoId: Hex): PeerRecord | null {
  const target = convoId.toLowerCase();
  return getState().peers.find((peer) => peer.convoId.toLowerCase() === target) ?? null;
}

/** Adds or updates a peer, keeping the newest known public key. */
export async function upsertPeer(peer: PeerRecord): Promise<PeerRecord> {
  const existing = findPeer(peer.convoId);
  const merged: PeerRecord = {
    ...peer,
    createdAt: existing?.createdAt ?? peer.createdAt,
    address: peer.address ?? existing?.address ?? null,
    x25519Pub: peer.x25519Pub ?? existing?.x25519Pub ?? null,
    lastSeenAt: Math.max(peer.lastSeenAt, existing?.lastSeenAt ?? 0),
  };
  setState((state) => ({
    peers: [
      ...state.peers.filter((entry) => entry.id !== merged.id),
      merged,
    ],
  }));
  await savePeer(merged);
  return merged;
}

/* ─────────────────────────────────────────────────────────────── rooms ─── */

export function findRoom(groupId: Hex): RoomRecord | null {
  const target = groupId.toLowerCase();
  return getState().rooms.find((room) => room.groupId.toLowerCase() === target) ?? null;
}

/**
 * Adds or updates a room, merging the member roster and keeping the highest
 * epoch this device has seen.
 */
export async function upsertRoom(room: RoomRecord): Promise<RoomRecord> {
  const existing = findRoom(room.groupId);
  const members = new Set<string>();
  for (const member of existing?.members ?? []) members.add(member.toLowerCase());
  for (const member of room.members) members.add(member.toLowerCase());

  const merged: RoomRecord = {
    ...room,
    name: room.name !== '' ? room.name : existing?.name ?? room.name,
    admin: room.admin ?? existing?.admin ?? null,
    members: [...members] as Address[],
    epoch: Math.max(room.epoch, existing?.epoch ?? 0),
    createdAt: existing?.createdAt ?? room.createdAt,
    lastSeenAt: Math.max(room.lastSeenAt, existing?.lastSeenAt ?? 0),
  };
  setState((state) => ({
    rooms: [...state.rooms.filter((entry) => entry.id !== merged.id), merged],
  }));
  await saveRoom(merged);
  return merged;
}

/** Replaces a room's member roster outright (kick flow). */
export async function replaceRoomMembers(
  groupId: Hex,
  members: readonly Address[],
  epoch: number,
): Promise<void> {
  const existing = findRoom(groupId);
  if (existing === null) return;
  const next: RoomRecord = {
    ...existing,
    members: members.map((member) => member.toLowerCase() as Address),
    epoch: Math.max(existing.epoch, epoch),
  };
  setState((state) => ({
    rooms: [...state.rooms.filter((entry) => entry.id !== next.id), next],
  }));
  await saveRoom(next);
}

/**
 * Group keys held this session: `groupId → epoch → key`. Module-level (not
 * React state) because raw key material has no business being rendered.
 */
const roomKeys = new Map<string, Map<number, Uint8Array>>();

/** Registers a group key for one epoch, in memory and in IndexedDB. */
export async function putRoomKey(
  groupId: Hex,
  epoch: number,
  key: Uint8Array,
): Promise<void> {
  const groupKey = groupId.toLowerCase();
  let epochs = roomKeys.get(groupKey);
  if (epochs === undefined) {
    epochs = new Map<number, Uint8Array>();
    roomKeys.set(groupKey, epochs);
  }
  epochs.set(epoch, Uint8Array.from(key));
  const owner = context?.owner ?? getState().owner;
  if (owner !== null) await saveRoomKey(owner, groupId, epoch, key);
}

/** The newest group key held for a room, or `null`. */
export function latestRoomKey(groupId: Hex): { epoch: number; key: Uint8Array } | null {
  const epochs = roomKeys.get(groupId.toLowerCase());
  if (epochs === undefined || epochs.size === 0) return null;
  let best = -1;
  for (const epoch of epochs.keys()) best = Math.max(best, epoch);
  const key = epochs.get(best);
  return key === undefined ? null : { epoch: best, key };
}

/** Every held key for a room, newest epoch first. */
function allRoomKeys(groupId: Hex): readonly { epoch: number; key: Uint8Array }[] {
  const epochs = roomKeys.get(groupId.toLowerCase());
  if (epochs === undefined) return [];
  return [...epochs.entries()]
    .map(([epoch, key]) => ({ epoch, key }))
    .sort((a, b) => b.epoch - a.epoch);
}

function recordTamper(event: TamperEvent): void {
  setState((state) => ({
    tamperEvents: [...state.tamperEvents, event].slice(-MAX_TAMPER_EVENTS),
  }));
}

function setError(error: string | null): void {
  setState({ error });
}

/* ════════════════════════════════════════════════════════════ engine ════ */

let refCount = 0;
let context: MessengerAttachment | null = null;
let stopStream: (() => void) | null = null;
let detachTimer: ReturnType<typeof setTimeout> | null = null;
let runToken = 0;
let pipeline: Promise<void> = Promise.resolve();

/**
 * Dedupe state for the scan, as a high-water mark rather than a set of every
 * seq ever seen.
 *
 * The mark means *fully processed*, not *looked at*: it is advanced by
 * `processDrops` only once the slice's I/O has resolved, never by
 * `classifySlice` while the drops are still in flight. A throw halfway through
 * a slice's fetches therefore costs a re-examination of that slice and nothing
 * more.
 *
 * This state is *work avoidance*, not write protection: every downstream write
 * is idempotent and content-addressed (`messageId` is `owner:blobRef`, and
 * `patchMessage` / `addMessage` / `upsertRoom` / `putRoomKey` are all upserts
 * keyed by id, each re-checking `existing.seq` before it writes). Forgetting a
 * seq therefore costs one redundant examination and can never produce a
 * duplicate row; remembering one that was never opened is the only unsafe
 * direction. Two independent things guard that direction: `rememberRetry` puts
 * the seq back within this session, and — because the retry set is bounded and
 * only the WebSocket ever re-delivers a seq — `backfill` refuses to persist a
 * scan cursor at or above the lowest re-armed seq, so the *next* sweep asks the
 * relay for it again. The cursor is the durable record; the retry set is only
 * the fast path.
 *
 * A plain `Set` grew without bound — ~31 MB at a million drops. The high-water
 * mark holds because every source of drops is ascending: backfill pages are
 * `seq > since ORDER BY seq ASC` and non-overlapping, and the relay stream
 * emits in ascending block/logIndex order. The one source of descending seqs is
 * the indexer's reorg rewind, and those re-emissions are exactly what we want
 * to skip — identical to the behaviour of the old `Set`.
 */
let scanHighWater = -1;
/** Seqs at or below the mark that must be examined again — see `rememberRetry`. */
const retrySeqs = new Set<number>();
/**
 * Ceiling on the retry set.
 *
 * The bound is *not* excused by the view tag: only stealth drops are filtered
 * to ~1/256 before `fetchVerified`, while every room drop of every room this
 * device holds is fetched unconditionally. A relay that refuses blobs can
 * therefore arm one seq per drop in the log, which is exactly why the cap
 * refuses entries past 4096 — and exactly why refusing them has to be safe.
 * It is safe because `rememberRetry` records the lowest failed seq *before* the
 * cap is consulted, and `backfill` clamps the persisted cursor below it: a
 * refused arming costs a re-sweep, never a message.
 */
const MAX_RETRY_SEQS = 4096;

/** Main-thread budget for one uninterrupted classification slice, in ms. */
const SCAN_SLICE_MS = 8;

/**
 * Lowest seq re-armed since the current `processDrops` batch began, or `null`
 * when every drop in it was resolved. Module-level rather than threaded through
 * the call chain because `rememberRetry` is called from three nesting levels
 * down; safe as a single slot because every entry point funnels through
 * `enqueue`, so batches never overlap.
 */
let retryLowWater: number | null = null;

/**
 * True while a hole is known to exist above the persisted scan cursor: an
 * aborted sweep, a page with an unfetchable blob, or a live drop that did not
 * follow the cursor by exactly one. While it is set, the stream may not push
 * the cursor forward — doing so is what turned a rate-limited page into
 * permanent loss. Only a sweep that reaches the relay head with nothing left
 * behind clears it.
 */
let scanGap = true;

function resetScanDedupe(): void {
  scanHighWater = -1;
  retrySeqs.clear();
  retryLowWater = null;
  scanGap = true;
}

/**
 * Re-arms a seq for another examination after a *transient* failure — a blob
 * the relay could not serve right now. Capped, because an outage that lasts
 * a whole backfill would otherwise rebuild the unbounded set we just removed.
 *
 * The low-water mark is recorded before the cap is consulted: the caller uses
 * it to hold the scan cursor below the failure, and that has to happen whether
 * or not there was room to arm the seq itself.
 */
function rememberRetry(seq: number): void {
  if (retryLowWater === null || seq < retryLowWater) retryLowWater = seq;
  if (retrySeqs.size < MAX_RETRY_SEQS) retrySeqs.add(seq);
}

/* ───────────────────────────────────────────────────── yielding to paint ─── */

type YieldFn = () => Promise<void>;

let yieldImpl: YieldFn | null = null;
let messageChannel: MessageChannel | null = null;
const yieldWaiters: (() => void)[] = [];

function now(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

const timeoutYield: YieldFn = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

function schedulerYield(): YieldFn | null {
  // Reflected rather than referenced: `scheduler.yield()` is Baseline-new, and
  // the DOM lib this project builds against does not declare it everywhere.
  const scheduler: unknown = Reflect.get(globalThis, 'scheduler');
  if (typeof scheduler !== 'object' || scheduler === null) return null;
  const candidate: unknown = Reflect.get(scheduler, 'yield');
  if (typeof candidate !== 'function') return null;
  const bound = (candidate as YieldFn).bind(scheduler);
  return async (): Promise<void> => {
    try {
      await bound();
    } catch {
      // `scheduler.yield()` rejects when its task is aborted; a plain macrotask
      // still hands the frame back, which is all we need.
      await timeoutYield();
    }
  };
}

function ensureMessageChannel(): MessageChannel {
  if (messageChannel !== null) return messageChannel;
  const created = new MessageChannel();
  created.port1.onmessage = (): void => {
    const next = yieldWaiters.shift();
    if (next !== undefined) next();
  };
  messageChannel = created;
  return created;
}

function messageChannelYield(): YieldFn | null {
  if (typeof MessageChannel === 'undefined') return null;
  return () =>
    new Promise<void>((resolve) => {
      const channel = ensureMessageChannel();
      yieldWaiters.push(resolve);
      channel.port2.postMessage(0);
    });
}

/**
 * Hands the main thread back for one macrotask.
 *
 * The scan *looks* asynchronous and is not: `scanMatches` is an `async` wrapper
 * over a synchronous WASM scalarmult, and every other await on the
 * 99.6 %-non-matching path resolves against an already-settled promise. Awaiting
 * a settled promise schedules a microtask, and microtasks drain inside the same
 * task — the browser never gets a chance to paint or to deliver input. So
 * `queueMicrotask` and `await Promise.resolve()` are useless here; only a real
 * macrotask boundary yields a frame.
 */
function yieldToBrowser(): Promise<void> {
  yieldImpl ??= schedulerYield() ?? messageChannelYield() ?? timeoutYield;
  return yieldImpl();
}

function readableError(error: unknown): string {
  if (error instanceof Error) {
    const first = error.message.split('\n')[0] ?? error.message;
    return first.length > 200 ? `${first.slice(0, 197)}…` : first;
  }
  return 'The relay could not be reached.';
}

function enqueue(task: () => Promise<void>): void {
  pipeline = pipeline.then(task).catch((error: unknown) => {
    setError(readableError(error));
  });
}

function sameAttachment(a: MessengerAttachment | null, b: MessengerAttachment): boolean {
  if (a === null) return false;
  if (a.owner.toLowerCase() !== b.owner.toLowerCase()) return false;
  const left = a.keys.x25519.publicKey;
  const right = b.keys.x25519.publicKey;
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

/** sha256 over the fetched ciphertext. `null` only if the digest cannot be taken. */
function digestOf(blob: Uint8Array): Hex | null {
  try {
    return sha256(blob);
  } catch {
    return null;
  }
}

function toKeyBytes(value: Hex): Uint8Array | null {
  try {
    const bytes = hexToBytes(value);
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

type OwnDropVerdict = 'not-ours' | 'up-to-date' | 'needs-anchor';

/**
 * Decides whether a drop reconciles against an outbound row this device already
 * holds. Synchronous on purpose: this runs inside the classification slice, and
 * the IndexedDB write it may imply is deferred to `anchorOwnDrop`.
 *
 * Matching is on `blobRef` — the content address — because the poster on the
 * gasless path is the relay, not the author.
 */
function classifyOwnDrop(drop: DropRow, id: string): OwnDropVerdict {
  const existing = findMessage(id);
  if (existing === null || existing.direction !== 'out') return 'not-ours';
  if (
    existing.status === 'anchored' &&
    existing.seq === drop.seq &&
    existing.blockNumber === drop.blockNumber
  ) {
    return 'up-to-date';
  }
  return 'needs-anchor';
}

/** Flips one of our own outbound rows to `anchored`. */
async function anchorOwnDrop(id: string, drop: DropRow): Promise<void> {
  await patchMessage(id, {
    status: 'anchored',
    seq: drop.seq,
    blockNumber: drop.blockNumber,
    txHash: drop.txHash,
    poster: drop.poster,
    size: drop.size,
    viewTag: drop.viewTag,
    ephPub: drop.ephPub,
    error: null,
  });
}

interface VerifiedBlob {
  readonly blob: Uint8Array;
  readonly integrity: 'verified' | 'unverified';
}

/** Fetches and hash-verifies a blob. `null` means skip; `false` means retry later. */
async function fetchVerified(drop: DropRow): Promise<VerifiedBlob | null | false> {
  let blob: Uint8Array | null;
  try {
    blob = await getBlob(drop.blobRef);
  } catch {
    // The relay is unreachable or refused the blob; leave the drop for the
    // next resync rather than inventing a row.
    return false;
  }
  if (blob === null) return null;

  const digest = digestOf(blob);
  if (digest !== null && digest.toLowerCase() !== drop.blobRef.toLowerCase()) {
    recordTamper({
      seq: drop.seq,
      blobRef: drop.blobRef,
      computed: digest,
      poster: drop.poster,
      at: drop.timestamp,
    });
    return null;
  }
  return { blob, integrity: digest === null ? 'unverified' : 'verified' };
}

/** A decrypted 1:1 drop awaiting sender attribution. */
interface Candidate {
  readonly drop: DropRow;
  readonly pt: Plaintext;
  readonly sentAt: number;
  readonly integrity: 'verified' | 'unverified';
}

function sentAtOf(pt: Plaintext, drop: DropRow): number {
  return Number.isFinite(pt.t) && pt.t > 0 ? pt.t : drop.timestamp;
}

/**
 * Applies a room-key payload delivered inside a 1:1 `system` drop: unwraps
 * the group key, stores it for its epoch, upserts the room and leaves a
 * quiet system note in the room's own thread.
 */
async function applyRoomKey(
  attachment: MessengerAttachment,
  drop: DropRow,
  body: string,
  sentAt: number,
  integrity: 'verified' | 'unverified',
): Promise<boolean> {
  const payload = parseRoomKeyPayload(body);
  if (payload === null) return false;

  const { owner, keys } = attachment;
  let wrapped: Uint8Array;
  try {
    wrapped = hexToBytes(payload.wrapped);
  } catch {
    return true; // Malformed key material: consumed, never displayed.
  }

  const groupKey = await unwrapGroupKey(
    wrapped,
    keys.x25519.privateKey,
    keys.x25519.publicKey,
  );
  if (groupKey === null) return true;

  const existing = findRoom(payload.groupId);
  const isRotation = existing !== null && payload.epoch > existing.epoch;
  await putRoomKey(payload.groupId, payload.epoch, groupKey);
  await upsertRoom({
    id: roomId(owner, payload.groupId),
    owner,
    groupId: payload.groupId,
    name: payload.name,
    admin: null,
    members: [owner.toLowerCase() as Address],
    epoch: payload.epoch,
    createdAt: sentAt,
    lastSeenAt: sentAt,
  });

  const note =
    existing === null
      ? `Added to “${payload.name}” — room key received (epoch ${String(payload.epoch)}).`
      : isRotation
        ? `Room key rotated to epoch ${String(payload.epoch)}.`
        : `Room key re-delivered for epoch ${String(payload.epoch)}.`;

  await addMessage({
    id: messageId(owner, drop.blobRef),
    owner,
    convoId: payload.groupId,
    direction: 'in',
    body: note,
    kind: 'system',
    re: null,
    sentAt,
    status: 'received',
    integrity,
    blobRef: drop.blobRef,
    ephPub: drop.ephPub,
    viewTag: drop.viewTag,
    size: drop.size,
    seq: drop.seq,
    blockNumber: drop.blockNumber,
    txHash: drop.txHash,
    poster: drop.poster,
    error: null,
  });
  return true;
}

/** Opens one room drop with any held epoch key and records the row. */
async function processRoomDrop(
  attachment: MessengerAttachment,
  drop: DropRow,
  room: RoomRecord,
): Promise<void> {
  const keys = allRoomKeys(room.groupId);
  if (keys.length === 0) return;

  const fetched = await fetchVerified(drop);
  if (fetched === false) {
    rememberRetry(drop.seq);
    return;
  }
  if (fetched === null) return;

  // The view tag of a group drop is derived from the group key, so it names
  // the epoch: try tag-matching keys first, then the rest (defensively).
  const ordered = [
    ...keys.filter((entry) => computeViewTag(entry.key) === drop.viewTag),
    ...keys.filter((entry) => computeViewTag(entry.key) !== drop.viewTag),
  ];

  let pt: Plaintext | null = null;
  for (const entry of ordered) {
    pt = await openFromGroup(fetched.blob, entry.key);
    if (pt !== null) break;
  }
  if (pt === null) return;

  const { owner } = attachment;
  const id = messageId(owner, drop.blobRef);
  const existing = findMessage(id);
  if (existing !== null && existing.seq === drop.seq) return;

  const sentAt = sentAtOf(pt, drop);
  await addMessage({
    id,
    owner,
    convoId: room.groupId,
    direction: 'in',
    body: pt.body,
    kind: pt.kind,
    re: pt.re ?? null,
    sentAt,
    status: 'received',
    integrity: fetched.integrity,
    blobRef: drop.blobRef,
    ephPub: drop.ephPub,
    viewTag: drop.viewTag,
    size: drop.size,
    seq: drop.seq,
    blockNumber: drop.blockNumber,
    txHash: drop.txHash,
    poster: drop.poster,
    error: null,
  });
  await upsertRoom({ ...room, lastSeenAt: Math.max(room.lastSeenAt, sentAt) });
}

/** One slice of classification: pure CPU, no I/O, bounded by `SCAN_SLICE_MS`. */
interface ScanSlice {
  /** Our own outbound rows that need flipping to `anchored`. */
  readonly own: readonly { readonly id: string; readonly drop: DropRow }[];
  /** Room drops, still unresolved — `findRoom` runs in the I/O phase. */
  readonly room: readonly DropRow[];
  /** Stealth 1:1 drops whose view tag matched our key. */
  readonly stealth: readonly DropRow[];
  /** Anchors admitted by the dedupe gate in this slice. */
  readonly examined: number;
  /**
   * Highest seq admitted by the gate, or `-1` for a slice that admitted none.
   * The caller writes this to `scanHighWater` — but only after the slice's I/O
   * has resolved, so the mark can never claim a drop that was never recorded.
   */
  readonly highest: number;
  /**
   * Seqs this slice took *out* of `retrySeqs`. If the I/O throws they go back:
   * they sit at or below the mark, so nothing else would ever look at them.
   */
  readonly rearmed: readonly number[];
  /** Index in `drops` where the next slice resumes. */
  readonly next: number;
  /** The run token changed mid-slice; the caller must abandon the batch. */
  readonly cancelled: boolean;
}

/**
 * Classifies drops until the slice budget is spent.
 *
 * Everything here is synchronous work — the one `await` is `scanMatches`, whose
 * body is a synchronous WASM scalarmult behind a memoised `ready()`. Nothing in
 * this function touches the network or IndexedDB, which is what makes it safe
 * to cut at an arbitrary drop and resume after a macrotask yield.
 *
 * It *reads* the dedupe gate and it never advances it. Marking a drop examined
 * before its blob has been fetched, opened and written would lose the whole
 * slice — 40 to 150 drops — to a single `idbPut` quota error or a failed
 * `resolvePeerKeys`, so the mark is the caller's to make, once the I/O is done.
 */
async function classifySlice(
  attachment: MessengerAttachment,
  drops: readonly DropRow[],
  from: number,
  token: number,
): Promise<ScanSlice> {
  const { owner, keys } = attachment;
  const ownerKey = owner.toLowerCase();
  const priv = keys.x25519.privateKey;

  const own: { readonly id: string; readonly drop: DropRow }[] = [];
  const room: DropRow[] = [];
  const stealth: DropRow[] = [];
  const rearmed: number[] = [];
  let examined = 0;
  let highest = -1;
  let index = from;
  const sliceStart = now();

  while (index < drops.length) {
    /* Always make progress on at least one drop, so a slow device cannot
       livelock on a budget it can never meet. */
    if (index > from && now() - sliceStart > SCAN_SLICE_MS) break;

    const drop = drops[index];
    if (drop === undefined) {
      index += 1;
      continue;
    }

    /* The token test and the gate below are one synchronous block with no await
       between them. `teardown()` is the only writer of `runToken` and it resets
       the dedupe state in the same synchronous breath, so an abandoned run can
       never consume an armed seq on behalf of the run that replaces it. */
    if (token !== runToken) {
      return { own, room, stealth, examined, highest, rearmed, next: index, cancelled: true };
    }
    index += 1;

    if (drop.seq <= scanHighWater) {
      if (!retrySeqs.delete(drop.seq)) continue;
      rearmed.push(drop.seq);
    }
    if (drop.seq > highest) highest = drop.seq;
    examined += 1;

    /* 0 — our own optimistic row, matched by content address. */
    const id = messageId(owner, drop.blobRef);
    const verdict = classifyOwnDrop(drop, id);
    if (verdict === 'needs-anchor') {
      own.push({ id, drop });
      continue;
    }
    if (verdict === 'up-to-date') continue;

    /* 1a — room drops: `convoId` is the on-chain group id. */
    if (drop.convoId.toLowerCase() !== STEALTH_CONVO_ID) {
      room.push(drop);
      continue;
    }

    /* A stealth drop we posted from another device cannot be opened here —
       the ephemeral secret died inside `seal()`. */
    if (drop.poster.toLowerCase() === ownerKey) continue;

    /* 1b — stealth 1:1 drops, filtered by view tag. */
    const ephPub = toKeyBytes(drop.ephPub);
    if (ephPub === null) continue;

    const isMatch = await scanMatches(ephPub, drop.viewTag, priv);
    if (!isMatch) continue;
    stealth.push(drop);
  }

  return { own, room, stealth, examined, highest, rearmed, next: index, cancelled: false };
}

/**
 * Fetches, opens and records the stealth drops of one slice.
 *
 * Split out of the scan loop so that the CPU filter above stays pure; the awaits
 * in here are genuine network and IndexedDB I/O and yield on their own.
 */
async function processStealthDrops(
  attachment: MessengerAttachment,
  drops: readonly DropRow[],
  token: number,
): Promise<void> {
  if (drops.length === 0) return;

  const { owner, keys } = attachment;
  const priv = keys.x25519.privateKey;
  const pub = keys.x25519.publicKey;
  const candidates: Candidate[] = [];

  for (const drop of drops) {
    if (token !== runToken) return;

    const fetched = await fetchVerified(drop);
    if (fetched === false) {
      rememberRetry(drop.seq);
      continue;
    }
    if (fetched === null) continue;

    const plaintext = await openEnvelope(fetched.blob, priv, pub);
    // `null` is the ordinary outcome of a 1/256 view-tag collision.
    if (plaintext === null) continue;

    const sentAt = sentAtOf(plaintext, drop);

    /* Room-key handoffs are applied, not displayed. */
    if (
      plaintext.kind === 'system' &&
      (await applyRoomKey(attachment, drop, plaintext.body, sentAt, fetched.integrity))
    ) {
      continue;
    }

    candidates.push({ drop, pt: plaintext, sentAt, integrity: fetched.integrity });
  }

  if (candidates.length === 0 || token !== runToken) return;

  /* Resolve every unknown sender's registered key in one round trip. */
  const known = new Map<string, Hex>();
  for (const peer of getState().peers) {
    if (peer.address !== null && peer.x25519Pub !== null) {
      known.set(peer.address.toLowerCase(), peer.x25519Pub);
    }
  }
  const unknown: Address[] = [];
  for (const candidate of candidates) {
    const key = candidate.drop.poster.toLowerCase();
    if (!known.has(key) && !unknown.some((entry) => entry.toLowerCase() === key)) {
      unknown.push(candidate.drop.poster);
    }
  }
  if (unknown.length > 0) {
    try {
      const resolved = await attachment.resolvePeerKeys(unknown);
      for (const [address, key] of resolved) known.set(address.toLowerCase(), key);
    } catch {
      // Attribution is best-effort — unresolved senders land in the
      // unattributed bucket rather than blocking delivery.
    }
  }
  if (token !== runToken) return;

  const nowSeconds = Math.floor(Date.now() / 1000);
  const fresh: ChatMessage[] = [];
  const touchedPeers = new Map<string, PeerRecord>();

  for (const candidate of candidates) {
    const posterKey = candidate.drop.poster.toLowerCase();
    const peerPubHex = known.get(posterKey) ?? null;
    const peerPubBytes =
      peerPubHex === null || peerPubHex.toLowerCase() === ZERO_KEY
        ? null
        : toKeyBytes(peerPubHex);

    const convoId =
      peerPubBytes === null ? UNATTRIBUTED_CONVO_ID : convoIdFor(pub, peerPubBytes);

    const id = messageId(owner, candidate.drop.blobRef);
    const existing = findMessage(id);
    if (existing !== null && existing.seq === candidate.drop.seq) continue;

    fresh.push({
      id,
      owner,
      convoId,
      direction: 'in',
      body: candidate.pt.body,
      kind: candidate.pt.kind,
      re: candidate.pt.re ?? null,
      sentAt: candidate.sentAt,
      status: 'received',
      integrity: candidate.integrity,
      blobRef: candidate.drop.blobRef,
      ephPub: candidate.drop.ephPub,
      viewTag: candidate.drop.viewTag,
      size: candidate.drop.size,
      seq: candidate.drop.seq,
      blockNumber: candidate.drop.blockNumber,
      txHash: candidate.drop.txHash,
      poster: candidate.drop.poster,
      error: null,
    });

    const record: PeerRecord = {
      id: peerId(owner, convoId),
      owner,
      convoId,
      address: peerPubBytes === null ? null : candidate.drop.poster,
      x25519Pub: peerPubBytes === null ? null : peerPubHex,
      createdAt: nowSeconds,
      lastSeenAt: candidate.sentAt,
    };
    const previous = touchedPeers.get(record.id);
    touchedPeers.set(
      record.id,
      previous === undefined
        ? record
        : { ...record, lastSeenAt: Math.max(previous.lastSeenAt, record.lastSeenAt) },
    );
  }

  for (const peer of touchedPeers.values()) await upsertPeer(peer);
  if (fresh.length > 0) {
    putMessages(fresh);
    await saveMessages(fresh);
  }
}

/**
 * Runs every I/O the slice implied.
 *
 * @returns the number of anchors that matched — view-tag hits plus room drops
 *          for a room this device actually holds.
 */
async function runSliceIo(
  attachment: MessengerAttachment,
  slice: ScanSlice,
  token: number,
): Promise<number> {
  for (const entry of slice.own) {
    if (token !== runToken) return 0;
    await anchorOwnDrop(entry.id, entry.drop);
  }

  /* Stealth before rooms, and `findRoom` deferred to here: a room key arrives
     as a stealth `system` drop, so a room drop from the same slice can only be
     opened once that handoff has been applied. The serial loop used to give
     this ordering for free. */
  await processStealthDrops(attachment, slice.stealth, token);

  let matches = slice.stealth.length;
  for (const drop of slice.room) {
    if (token !== runToken) return matches;
    const room = findRoom(drop.convoId);
    if (room === null) continue;
    matches += 1;
    await processRoomDrop(attachment, drop, room);
  }
  return matches;
}

/**
 * Handles a batch of anchors without ever blocking the main thread for more
 * than one slice.
 *
 * Concurrency: every entry point funnels through `enqueue`, so `processDrops`
 * calls are strictly serialised on the `pipeline` promise — the yields below
 * hand the frame back to the browser but never let a second `processDrops`
 * start. That is what keeps the dedupe gate in `classifySlice` a critical
 * section despite the interruptions.
 *
 * @returns the lowest seq re-armed for a later attempt, or `null` when every
 *          drop in the batch reached a verdict. The caller must not persist a
 *          scan cursor at or above that seq.
 */
async function processDrops(
  attachment: MessengerAttachment,
  drops: readonly DropRow[],
  token: number,
): Promise<number | null> {
  retryLowWater = null;
  let index = 0;

  while (index < drops.length) {
    if (token !== runToken) return retryLowWater;

    const slice = await classifySlice(attachment, drops, index, token);
    index = slice.next;
    if (slice.cancelled) return retryLowWater;

    let matches: number;
    try {
      matches = await runSliceIo(attachment, slice, token);
    } catch (error: unknown) {
      /* Nothing in this slice was marked, so the whole slice is still on the
         relay's side of the ledger — except the armed seqs it consumed, which
         only `retrySeqs` remembers. Put those back before the throw unwinds. */
      for (const seq of slice.rearmed) rememberRetry(seq);
      throw error;
    }

    /* Mark only now, and only for a run that still owns the engine: the token
       may have moved while the I/O above was in flight, and `teardown()` has
       already reset the mark for whoever comes next. */
    if (token !== runToken) return retryLowWater;
    if (slice.highest > scanHighWater) scanHighWater = slice.highest;

    if (slice.examined > 0 || matches > 0) {
      setState((state) => ({
        scanned: state.scanned + slice.examined,
        matched: state.matched + matches,
      }));
    }

    if (index < drops.length) await yieldToBrowser();
  }
  return retryLowWater;
}

async function hydrate(attachment: MessengerAttachment, token: number): Promise<void> {
  const [messages, peers, rooms, keys, cursor] = await Promise.all([
    loadMessages(attachment.owner),
    loadPeers(attachment.owner),
    loadRooms(attachment.owner),
    loadRoomKeys(attachment.owner),
    loadScanCursor(attachment.owner),
  ]);
  if (token !== runToken) return;

  roomKeys.clear();
  for (const record of keys) {
    const groupKey = record.groupId.toLowerCase();
    let epochs = roomKeys.get(groupKey);
    if (epochs === undefined) {
      epochs = new Map<number, Uint8Array>();
      roomKeys.set(groupKey, epochs);
    }
    epochs.set(record.epoch, record.key);
  }

  setState({
    messages: [...messages].sort(compareMessages),
    peers,
    rooms,
    scannedSeq: cursor,
    hydrated: true,
  });
}

/** Pending automatic re-sweep, if any. */
let backfillRetryTimer: ReturnType<typeof setTimeout> | null = null;

function cancelBackfillRetry(): void {
  if (backfillRetryTimer === null) return;
  clearTimeout(backfillRetryTimer);
  backfillRetryTimer = null;
}

/**
 * Queues another sweep after `delay`.
 *
 * The wait happens on a timer rather than inside the pipeline: a sleeping
 * backfill would hold `pipeline` and stall live delivery for as long as the
 * backoff, which is the opposite of what a struggling relay needs.
 */
function scheduleBackfill(
  attachment: MessengerAttachment,
  token: number,
  attempt: number,
  delay: number,
): void {
  cancelBackfillRetry();
  backfillRetryTimer = setTimeout(() => {
    backfillRetryTimer = null;
    if (token !== runToken) return;
    enqueue(async () => {
      if (token !== runToken) return;
      await backfill(attachment, token, attempt);
    });
  }, delay);
}

/**
 * Sweeps `GET /v1/drops` from the persisted cursor to the relay head.
 *
 * Two cursors, deliberately: `since` is where the *paging* is, and always
 * advances so the sweep terminates; `cursor` is what gets persisted, and stops
 * dead at the first seq this sweep failed to resolve. Advancing the persisted
 * cursor over a failure is unrecoverable — the relay only ever serves
 * `seq > since`, so a seq the cursor has passed is never offered again — which
 * is why the clamp is here and not left to the bounded, session-local retry set.
 *
 * @param attempt index into `BACKFILL_RETRY_DELAYS_MS` for the *next* abort.
 */
async function backfill(
  attachment: MessengerAttachment,
  token: number,
  attempt = 0,
): Promise<void> {
  cancelBackfillRetry();
  setState({ backfilling: true, error: null });

  const started = getState().scannedSeq;
  let since = started;
  let cursor = started;
  /** Lowest seq this sweep left behind, sticky: later pages cannot jump it. */
  let hole: number | null = null;
  let reachedHead = false;

  /* Everything at or below the resume cursor is durably processed and nothing
     above it is, whatever a live drop may have marked while the sweep was
     aborted. Re-arming the region above the cursor is what lets a retry heal a
     gap the stream has already scanned past. */
  scanHighWater = since;
  retrySeqs.clear();
  scanGap = true;

  try {
    for (;;) {
      if (token !== runToken) return;
      const page = await getDrops({ since, limit: BACKFILL_LIMIT });
      setState({ head: page.head });
      if (page.drops.length === 0) {
        reachedHead = true;
        break;
      }

      const retried = await processDrops(attachment, page.drops, token);
      if (token !== runToken) return;
      if (retried !== null && (hole === null || retried < hole)) hole = retried;

      let highest = since;
      for (const drop of page.drops) highest = Math.max(highest, drop.seq);
      if (highest <= since) break;

      since = highest;
      const next = hole === null ? highest : Math.min(highest, hole - 1);
      if (next > cursor) {
        cursor = next;
        setState({ scannedSeq: cursor });
        await saveScanCursor(attachment.owner, cursor);
      }

      if (page.drops.length < BACKFILL_LIMIT) {
        reachedHead = true;
        break;
      }
    }
    /* The stream may extend the cursor only from a sweep that ended whole. */
    if (reachedHead && hole === null) scanGap = false;
  } catch (error: unknown) {
    if (token !== runToken) return;
    setError(readableError(error));
    /* A sweep that was draining the backlog before it was cut off has been
       throttled rather than broken, so it drops back down the ladder instead of
       climbing it — but only by one rung, never all the way to the floor.
       Resetting to 0 on any progress is what turned this into a hot loop: each
       sweep landed a page, reset to the 250 ms delay, and the client sat at
       ~4 req/s, which is exactly the relay's own DROPS_RATE_MAX. Backing off one
       step still drains a large backlog steadily while easing off a service that
       is already shedding load. */
    const nextAttempt = cursor > started ? Math.max(0, attempt - 1) : attempt;
    const delay = BACKFILL_RETRY_DELAYS_MS[nextAttempt];
    if (delay !== undefined) {
      scheduleBackfill(attachment, token, nextAttempt + 1, delay);
    }
  } finally {
    if (token === runToken) setState({ backfilling: false });
  }
}

function startStream(attachment: MessengerAttachment, token: number): void {
  stopStream?.();
  stopStream = subscribeToRelay({
    onDrop: (drop) => {
      if (token !== runToken) return;
      enqueue(async () => {
        if (token !== runToken) return;
        const retried = await processDrops(attachment, [drop], token);
        if (token !== runToken) return;
        setState({ head: Math.max(getState().head, drop.seq) });

        /* The cursor is a promise that everything at or below it is recorded,
           so the stream may only extend it across a prefix with no holes: not
           over a drop it could not fetch, not while a sweep is known to have
           left something behind, and not over seqs it never saw. `seq` is the
           contract's own dense counter, so "the next drop" is literally the
           next number; anything else is a gap the following sweep must fill. */
        if (retried !== null) {
          scanGap = true;
          return;
        }
        const floor = getState().scannedSeq;
        if (drop.seq <= floor || scanGap) return;
        if (drop.seq > floor + 1) {
          scanGap = true;
          scheduleBackfill(attachment, token, 1, BACKFILL_RETRY_DELAYS_MS[0]);
          return;
        }

        setState({ scannedSeq: drop.seq });
        await saveScanCursor(attachment.owner, drop.seq);
      });
    },
    onStats: (stats) => {
      if (token === runToken) setState({ head: stats.head });
    },
  });
}

/**
 * Bumping `runToken` and resetting the dedupe state happen in one synchronous
 * block with no await between them. Any task still in flight fails its next
 * token test before it can touch `scanHighWater` again — `processDrops` tests
 * it immediately before writing the mark, precisely because the slice's I/O is
 * a long await during which this can run — so an abandoned run cannot mark a
 * seq as examined on behalf of the run that replaces it.
 */
function teardown(): void {
  runToken += 1;
  stopStream?.();
  stopStream = null;
  cancelBackfillRetry();
  context = null;
  resetScanDedupe();
  roomKeys.clear();
  setState(EMPTY_STATE);
}

/**
 * Starts the engine for one wallet, or joins an already running one.
 *
 * Reference-counted: every `attachMessenger` must be paired with a
 * `detachMessenger`, and only the last detach tears the engine down.
 */
export function attachMessenger(attachment: MessengerAttachment): void {
  refCount += 1;
  if (detachTimer !== null) {
    clearTimeout(detachTimer);
    detachTimer = null;
  }
  if (sameAttachment(context, attachment)) return;

  teardown();
  context = attachment;
  const token = (runToken += 1);

  setState({ ...EMPTY_STATE, owner: attachment.owner });
  enqueue(async () => {
    await hydrate(attachment, token);
    if (token !== runToken) return;
    startStream(attachment, token);
    await backfill(attachment, token);
  });
}

export function detachMessenger(): void {
  refCount = Math.max(0, refCount - 1);
  if (refCount > 0) return;
  if (detachTimer !== null) clearTimeout(detachTimer);
  detachTimer = setTimeout(() => {
    detachTimer = null;
    if (refCount === 0) teardown();
  }, DETACH_GRACE_MS);
}

/**
 * Re-runs the backfill from the persisted cursor. Safe to call repeatedly.
 *
 * The reset happens *inside* the queued task, not at call time: a backfill may
 * be mid-flight, and it now yields the main thread between slices, so a reset
 * from outside the pipeline would land in the middle of someone else's sweep
 * and rewind the mark under them.
 */
export function resyncMessenger(): void {
  const attachment = context;
  if (attachment === null) return;
  const token = runToken;
  enqueue(async () => {
    if (token !== runToken) return;
    resetScanDedupe();
    await backfill(attachment, token);
  });
}

/** Rescans the whole log from `seq 0` — the recovery path after a lost cache. */
export function rescanMessengerFromGenesis(): void {
  const attachment = context;
  if (attachment === null) return;
  const token = runToken;
  enqueue(async () => {
    if (token !== runToken) return;
    resetScanDedupe();
    setState({ scannedSeq: 0 });
    await saveScanCursor(attachment.owner, 0);
    await backfill(attachment, token);
  });
}

/** Wipes every cached message for `owner` and stops the engine. */
export async function wipeMessenger(owner: Address): Promise<void> {
  teardown();
  refCount = 0;
  await wipeMessages(owner);
}
