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
/** Anchors already handled this session, so a WS echo of a backfilled drop is free. */
const processedSeqs = new Set<number>();

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

/**
 * Reconciles a drop with an outbound row this device already holds.
 *
 * Matching is on `blobRef` — the content address — because the poster on the
 * gasless path is the relay, not the author. Returns `true` when the drop was
 * ours, so the caller can stop processing it.
 */
async function reconcileOwnDrop(owner: Address, drop: DropRow): Promise<boolean> {
  const id = messageId(owner, drop.blobRef);
  const existing = findMessage(id);
  if (existing === null || existing.direction !== 'out') return false;
  if (
    existing.status === 'anchored' &&
    existing.seq === drop.seq &&
    existing.blockNumber === drop.blockNumber
  ) {
    return true;
  }
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
  return true;
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
    processedSeqs.delete(drop.seq);
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

async function processDrops(
  attachment: MessengerAttachment,
  drops: readonly DropRow[],
  token: number,
): Promise<void> {
  const { owner, keys } = attachment;
  const ownerKey = owner.toLowerCase();
  const priv = keys.x25519.privateKey;
  const pub = keys.x25519.publicKey;

  const candidates: Candidate[] = [];
  let examined = 0;
  let matches = 0;

  for (const drop of drops) {
    if (token !== runToken) return;
    if (processedSeqs.has(drop.seq)) continue;
    processedSeqs.add(drop.seq);
    examined += 1;

    /* 0 — our own optimistic row, matched by content address. */
    if (await reconcileOwnDrop(owner, drop)) continue;

    /* 1a — room drops: `convoId` is the on-chain group id. */
    if (drop.convoId.toLowerCase() !== STEALTH_CONVO_ID) {
      const room = findRoom(drop.convoId);
      if (room !== null) {
        matches += 1;
        await processRoomDrop(attachment, drop, room);
      }
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
    matches += 1;

    const fetched = await fetchVerified(drop);
    if (fetched === false) {
      processedSeqs.delete(drop.seq);
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

  if (examined > 0 || matches > 0) {
    setState((state) => ({
      scanned: state.scanned + examined,
      matched: state.matched + matches,
    }));
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

  const now = Math.floor(Date.now() / 1000);
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
      createdAt: now,
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

async function backfill(attachment: MessengerAttachment, token: number): Promise<void> {
  setState({ backfilling: true, error: null });
  try {
    let since = getState().scannedSeq;

    for (;;) {
      if (token !== runToken) return;
      const page = await getDrops({ since, limit: BACKFILL_LIMIT });
      setState({ head: page.head });
      if (page.drops.length === 0) break;

      await processDrops(attachment, page.drops, token);
      if (token !== runToken) return;

      let highest = since;
      for (const drop of page.drops) highest = Math.max(highest, drop.seq);
      if (highest <= since) break;

      since = highest;
      setState({ scannedSeq: since });
      await saveScanCursor(attachment.owner, since);

      if (page.drops.length < BACKFILL_LIMIT) break;
    }
  } catch (error: unknown) {
    if (token === runToken) setError(readableError(error));
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
        await processDrops(attachment, [drop], token);
        if (token !== runToken) return;
        if (drop.seq > getState().scannedSeq) {
          setState({ scannedSeq: drop.seq, head: Math.max(getState().head, drop.seq) });
          await saveScanCursor(attachment.owner, drop.seq);
        }
      });
    },
    onStats: (stats) => {
      if (token === runToken) setState({ head: stats.head });
    },
  });
}

function teardown(): void {
  runToken += 1;
  stopStream?.();
  stopStream = null;
  context = null;
  processedSeqs.clear();
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

/** Re-runs the backfill from the persisted cursor. Safe to call repeatedly. */
export function resyncMessenger(): void {
  const attachment = context;
  if (attachment === null) return;
  const token = runToken;
  processedSeqs.clear();
  enqueue(async () => {
    await backfill(attachment, token);
  });
}

/** Rescans the whole log from `seq 0` — the recovery path after a lost cache. */
export function rescanMessengerFromGenesis(): void {
  const attachment = context;
  if (attachment === null) return;
  const token = runToken;
  processedSeqs.clear();
  setState({ scannedSeq: 0 });
  enqueue(async () => {
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
