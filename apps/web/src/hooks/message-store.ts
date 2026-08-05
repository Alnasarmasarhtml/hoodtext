/**
 * Device-local message cache.
 *
 * Two things make this necessary rather than an optimisation:
 *
 * 1. **Sent messages cannot be recovered from the chain.** Every drop uses a
 *    fresh ephemeral keypair whose private half is destroyed inside `seal()`,
 *    so the sender can never re-derive the shared secret. Only the recipient
 *    can open the blob. Our own history therefore lives here.
 * 2. Re-scanning and re-fetching every blob on each page load would hammer the
 *    relay for no benefit.
 *
 * Cleared alongside the identity keys on disconnect.
 */
import type { Address, Hex } from 'viem';

import {
  STORE_MESSAGES,
  STORE_META,
  STORE_PEERS,
  STORE_ROOMS,
  STORE_ROOM_KEYS,
  hasIndexedDb,
  idbDelete,
  idbDeleteByOwner,
  idbGet,
  idbGetAllByOwner,
  idbPut,
  idbPutMany,
} from './idb';
import type {
  ChatMessage,
  MessageIntegrity,
  MessageKind,
  MessageStatus,
  PeerRecord,
  RoomRecord,
} from './types';

const HEX_RE = /^0x[0-9a-fA-F]*$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const STATUSES: readonly MessageStatus[] = [
  'sealing',
  'uploading',
  'signing',
  'queued',
  'pending',
  'anchored',
  'failed',
  'received',
];

const KINDS: readonly MessageKind[] = ['text', 'system', 'media', 'react'];

const INTEGRITIES: readonly MessageIntegrity[] = ['verified', 'local', 'unverified'];

/* ────────────────────────────────────────────────────────────── guards ──── */

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function hex(value: unknown): Hex | null {
  return typeof value === 'string' && HEX_RE.test(value) ? (value as Hex) : null;
}

function addr(value: unknown): Address | null {
  return typeof value === 'string' && ADDRESS_RE.test(value) ? (value as Address) : null;
}

function int(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseMessage(raw: unknown): ChatMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;

  const id = str(r['id']);
  const owner = addr(r['owner']);
  const convoId = hex(r['convoId']);
  const body = str(r['body']);
  const sentAt = int(r['sentAt']);
  const direction = r['direction'];
  const status = r['status'];
  const integrity = r['integrity'];
  const kind = r['kind'];

  if (id === null || owner === null || convoId === null || body === null || sentAt === null) {
    return null;
  }
  if (direction !== 'in' && direction !== 'out') return null;
  if (typeof kind !== 'string' || !KINDS.includes(kind as MessageKind)) return null;
  if (typeof status !== 'string' || !STATUSES.includes(status as MessageStatus)) return null;
  if (typeof integrity !== 'string' || !INTEGRITIES.includes(integrity as MessageIntegrity)) {
    return null;
  }

  return {
    id,
    owner,
    convoId,
    direction,
    body,
    kind: kind as MessageKind,
    re: hex(r['re']),
    sentAt,
    status: status as MessageStatus,
    integrity: integrity as MessageIntegrity,
    blobRef: hex(r['blobRef']),
    ephPub: hex(r['ephPub']),
    viewTag: int(r['viewTag']),
    size: int(r['size']),
    seq: int(r['seq']),
    blockNumber: int(r['blockNumber']),
    txHash: hex(r['txHash']),
    poster: addr(r['poster']),
    error: str(r['error']),
  };
}

function parsePeer(raw: unknown): PeerRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;

  const id = str(r['id']);
  const owner = addr(r['owner']);
  const convoId = hex(r['convoId']);
  const createdAt = int(r['createdAt']);
  const lastSeenAt = int(r['lastSeenAt']);
  if (id === null || owner === null || convoId === null) return null;

  return {
    id,
    owner,
    convoId,
    address: addr(r['address']),
    x25519Pub: hex(r['x25519Pub']),
    createdAt: createdAt ?? 0,
    lastSeenAt: lastSeenAt ?? createdAt ?? 0,
  };
}

/* ───────────────────────────────────────────────────────────── messages ─── */

export function messageId(owner: Address, blobRef: Hex): string {
  return `${owner.toLowerCase()}:${blobRef.toLowerCase()}`;
}

export function peerId(owner: Address, convoId: Hex): string {
  return `${owner.toLowerCase()}:${convoId.toLowerCase()}`;
}

export function roomId(owner: Address, groupId: Hex): string {
  return `${owner.toLowerCase()}:${groupId.toLowerCase()}`;
}

function roomKeyRecordId(owner: Address, groupId: Hex, epoch: number): string {
  return `${owner.toLowerCase()}:${groupId.toLowerCase()}:${String(epoch)}`;
}

/** Every cached message for one wallet. Returns `[]` when storage is unusable. */
export async function loadMessages(owner: Address): Promise<ChatMessage[]> {
  if (!hasIndexedDb()) return [];
  try {
    const rows = await idbGetAllByOwner(STORE_MESSAGES, owner.toLowerCase());
    const out: ChatMessage[] = [];
    for (const row of rows) {
      const parsed = parseMessage(row);
      if (parsed !== null) out.push(parsed);
    }
    return out;
  } catch {
    return [];
  }
}

export async function saveMessage(message: ChatMessage): Promise<void> {
  if (!hasIndexedDb()) return;
  try {
    await idbPut(STORE_MESSAGES, message);
  } catch {
    /* The in-memory copy is still correct; the cache is best-effort. */
  }
}

export async function saveMessages(messages: readonly ChatMessage[]): Promise<void> {
  if (!hasIndexedDb() || messages.length === 0) return;
  try {
    await idbPutMany(STORE_MESSAGES, messages);
  } catch {
    /* see saveMessage */
  }
}

export async function deleteMessage(id: string): Promise<void> {
  if (!hasIndexedDb()) return;
  try {
    await idbDelete(STORE_MESSAGES, id);
  } catch {
    /* see saveMessage */
  }
}

/* ──────────────────────────────────────────────────────────────── peers ─── */

export async function loadPeers(owner: Address): Promise<PeerRecord[]> {
  if (!hasIndexedDb()) return [];
  try {
    const rows = await idbGetAllByOwner(STORE_PEERS, owner.toLowerCase());
    const out: PeerRecord[] = [];
    for (const row of rows) {
      const parsed = parsePeer(row);
      if (parsed !== null) out.push(parsed);
    }
    return out;
  } catch {
    return [];
  }
}

export async function savePeer(peer: PeerRecord): Promise<void> {
  if (!hasIndexedDb()) return;
  try {
    await idbPut(STORE_PEERS, peer);
  } catch {
    /* see saveMessage */
  }
}

/* ──────────────────────────────────────────────────────────────── rooms ─── */

function parseRoom(raw: unknown): RoomRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;

  const id = str(r['id']);
  const owner = addr(r['owner']);
  const groupId = hex(r['groupId']);
  const name = str(r['name']);
  const epoch = int(r['epoch']);
  const createdAt = int(r['createdAt']);
  const lastSeenAt = int(r['lastSeenAt']);
  if (id === null || owner === null || groupId === null || name === null) return null;

  const membersRaw = r['members'];
  const members: Address[] = [];
  if (Array.isArray(membersRaw)) {
    for (const entry of membersRaw) {
      const member = addr(entry);
      if (member !== null) members.push(member);
    }
  }

  return {
    id,
    owner,
    groupId,
    name,
    admin: addr(r['admin']),
    members,
    epoch: epoch === null || epoch < 0 ? 0 : epoch,
    createdAt: createdAt ?? 0,
    lastSeenAt: lastSeenAt ?? createdAt ?? 0,
  };
}

export async function loadRooms(owner: Address): Promise<RoomRecord[]> {
  if (!hasIndexedDb()) return [];
  try {
    const rows = await idbGetAllByOwner(STORE_ROOMS, owner.toLowerCase());
    const out: RoomRecord[] = [];
    for (const row of rows) {
      const parsed = parseRoom(row);
      if (parsed !== null) out.push(parsed);
    }
    return out;
  } catch {
    return [];
  }
}

export async function saveRoom(room: RoomRecord): Promise<void> {
  if (!hasIndexedDb()) return;
  try {
    await idbPut(STORE_ROOMS, room);
  } catch {
    /* see saveMessage */
  }
}

/* ─────────────────────────────────────────────────────────── room keys ──── */

/** One symmetric group key, bound to its room and epoch. */
export interface RoomKeyRecord {
  readonly groupId: Hex;
  readonly epoch: number;
  readonly key: Uint8Array;
}

interface StoredRoomKey {
  readonly id: string;
  readonly owner: string;
  readonly groupId: string;
  readonly epoch: number;
  readonly key: Uint8Array;
}

function parseRoomKey(raw: unknown): RoomKeyRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const groupId = hex(r['groupId']);
  const epoch = int(r['epoch']);
  const key = r['key'];
  if (groupId === null || epoch === null || epoch < 0) return null;
  if (!(key instanceof Uint8Array) || key.length !== 32) return null;
  return { groupId, epoch, key };
}

export async function loadRoomKeys(owner: Address): Promise<RoomKeyRecord[]> {
  if (!hasIndexedDb()) return [];
  try {
    const rows = await idbGetAllByOwner(STORE_ROOM_KEYS, owner.toLowerCase());
    const out: RoomKeyRecord[] = [];
    for (const row of rows) {
      const parsed = parseRoomKey(row);
      if (parsed !== null) out.push(parsed);
    }
    return out;
  } catch {
    return [];
  }
}

export async function saveRoomKey(
  owner: Address,
  groupId: Hex,
  epoch: number,
  key: Uint8Array,
): Promise<void> {
  if (!hasIndexedDb()) return;
  const record: StoredRoomKey = {
    id: roomKeyRecordId(owner, groupId, epoch),
    owner: owner.toLowerCase(),
    groupId: groupId.toLowerCase(),
    epoch,
    key: Uint8Array.from(key),
  };
  try {
    await idbPut(STORE_ROOM_KEYS, record);
  } catch {
    /* see saveMessage */
  }
}

/* ──────────────────────────────────────────────────────── scan cursor ───── */

function scanKey(owner: Address): string {
  return `${owner.toLowerCase()}:scan`;
}

/** Highest relay `seq` this device has already scanned for `owner`. */
export async function loadScanCursor(owner: Address): Promise<number> {
  if (!hasIndexedDb()) return 0;
  try {
    const raw = await idbGet(STORE_META, scanKey(owner));
    if (typeof raw !== 'object' || raw === null) return 0;
    const value = int((raw as Record<string, unknown>)['scannedSeq']);
    return value === null || value < 0 ? 0 : value;
  } catch {
    return 0;
  }
}

export async function saveScanCursor(owner: Address, scannedSeq: number): Promise<void> {
  if (!hasIndexedDb()) return;
  try {
    await idbPut(STORE_META, { key: scanKey(owner), owner: owner.toLowerCase(), scannedSeq });
  } catch {
    /* A lost cursor only costs a re-scan on the next visit. */
  }
}

/* ─────────────────────────────────────────────────────────────── wipe ───── */

/** Drops every cached message, peer, room, key and cursor for one wallet. Never throws. */
export async function wipeMessages(owner: Address): Promise<void> {
  if (!hasIndexedDb()) return;
  const key = owner.toLowerCase();
  try {
    await idbDeleteByOwner(STORE_MESSAGES, key);
    await idbDeleteByOwner(STORE_PEERS, key);
    await idbDeleteByOwner(STORE_ROOMS, key);
    await idbDeleteByOwner(STORE_ROOM_KEYS, key);
    await idbDelete(STORE_META, scanKey(owner));
  } catch {
    /* Disconnect must always complete. */
  }
}
