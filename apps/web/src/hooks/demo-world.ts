'use client';

/**
 * Demo-world assembly — turns the fixtures in `@/lib/demo` into the exact
 * shapes the real messenger renders: `ChatMessage` rows, `PeerRecord`s,
 * `RoomRecord`s and per-room chain state.
 *
 * The fixture ids are human strings; everything hex is derived from them
 * deterministically (`hex64`), so reply references and reaction targets line
 * up with the fake blobRefs, and re-entering demo rebuilds the identical
 * world. Seeding writes straight into the in-memory messenger store — never
 * IndexedDB, never the chain, never the relay.
 *
 * Built lazily and only in the browser: nothing here runs during prerender.
 */

import type { Address, Hex } from 'viem';

import { asset } from '@/lib/asset';
import {
  DEMO_CONVERSATIONS,
  DEMO_ME,
  DEMO_ROOMS,
  type DemoMessage,
} from '@/lib/demo';
import { messageId, peerId, roomId } from './message-store';
import { useMessengerStore } from './messenger-store';
import {
  compareMessages,
  type ChatMessage,
  type PeerRecord,
  type RoomRecord,
} from './types';
import type { UseDropsResult } from './useDrops';
import type { UseRelayStatusResult } from './useRelayStatus';

/** Where the fake chain head sits; blocks count back from here at ~12s. */
const BLOCK_HEAD = 8_141_337;
const MS_PER_BLOCK = 12_000;
/** First seq in the fixture log; rows count up from here in time order. */
const SEQ_BASE = 41_180;

/* ═════════════════════════════════════════════════ deterministic hex ════ */

/** 32 bytes of stable hex derived from an ascii seed. */
function hex64(seed: string): Hex {
  let out = '';
  for (let i = 0; i < seed.length && out.length < 64; i += 1) {
    out += (seed.charCodeAt(i) & 0xff).toString(16).padStart(2, '0');
  }
  let filler = seed.length * 31 + 7;
  while (out.length < 64) {
    filler = (filler * 33 + out.length) % 4_294_967_296;
    out += (filler % 16).toString(16);
  }
  return `0x${out.slice(0, 64)}`;
}

function viewTagOf(seed: string): number {
  let sum = 0;
  for (let i = 0; i < seed.length; i += 1) sum = (sum + seed.charCodeAt(i)) % 256;
  return sum;
}

/** The fake blobRef every fixture id anchors under. */
export function demoBlobRef(fixtureId: string): Hex {
  return hex64(`ref:${fixtureId}`);
}

/** The visitor's synthetic X25519 public key, display only. */
export const DEMO_X25519_PUB: Hex = hex64('x25519:me');

/* ═══════════════════════════════════════════════════ the built world ════ */

export interface DemoRoomChainFixture {
  readonly exists: boolean;
  readonly admin: Address;
  readonly epoch: number;
  readonly memberRoot: Hex;
  /** Unix seconds. */
  readonly paidUntil: number;
  readonly autoRenew: boolean;
  readonly isActive: boolean;
}

interface DemoWorld {
  readonly messages: ChatMessage[];
  readonly peers: PeerRecord[];
  readonly rooms: RoomRecord[];
  readonly chain: Map<string, DemoRoomChainFixture>;
  readonly convoByPeer: Map<string, Hex>;
  readonly head: number;
}

let world: DemoWorld | null = null;
let seeded = false;
let blockCounter = BLOCK_HEAD;
let seqCounter = SEQ_BASE;

interface PendingRow {
  readonly fixtureId: string;
  readonly row: Omit<ChatMessage, 'seq' | 'blockNumber'>;
  readonly sentAt: number;
}

function bodyOf(message: DemoMessage): string {
  if (message.kind !== 'media') return message.body;
  return JSON.stringify({
    mime: 'image/jpeg',
    name: message.mediaName ?? 'attachment.jpg',
    bytes: message.mediaBytes ?? 0,
    ref: hex64(`media:${message.id}`),
    key: hex64(`mediakey:${message.id}`),
    src: asset(message.mediaSrc ?? ''),
  });
}

function pendingRowsFor(
  convoId: Hex,
  message: DemoMessage,
  nowMs: number,
): PendingRow[] {
  const owner = DEMO_ME.address;
  const outbound = message.sender.toLowerCase() === owner.toLowerCase();
  const sentAt = Math.floor((nowMs - message.agoMs) / 1000);
  const blobRef = demoBlobRef(message.id);
  const body = bodyOf(message);

  const base: Omit<ChatMessage, 'seq' | 'blockNumber'> = {
    id: messageId(owner, blobRef),
    owner,
    convoId,
    direction: outbound ? 'out' : 'in',
    body,
    kind: message.kind,
    re: message.re === undefined ? null : demoBlobRef(message.re),
    sentAt,
    status: 'anchored',
    integrity: outbound ? 'local' : 'verified',
    blobRef,
    ephPub: hex64(`eph:${message.id}`),
    viewTag: viewTagOf(message.id),
    size: body.length + 4 <= 256 ? 256 : 1024,
    txHash: null,
    poster: message.sender,
    author: outbound ? null : message.sender,
    error: null,
  };

  const out: PendingRow[] = [{ fixtureId: message.id, row: base, sentAt }];

  /* A fixture media message may carry a caption; the wire format does not,
     so the caption becomes its own text row moments later. */
  if (message.kind === 'media' && message.body !== '') {
    const captionId = `${message.id}:caption`;
    const captionRef = demoBlobRef(captionId);
    out.push({
      fixtureId: captionId,
      sentAt: sentAt + 8,
      row: {
        ...base,
        id: messageId(owner, captionRef),
        body: message.body,
        kind: 'text',
        re: null,
        sentAt: sentAt + 8,
        blobRef: captionRef,
        ephPub: hex64(`eph:${captionId}`),
        viewTag: viewTagOf(captionId),
        size: 256,
      },
    });
  }

  /* Reactions become real `react` rows targeting the fake blobRef. */
  for (const reaction of message.reactions ?? []) {
    for (const [index, from] of reaction.from.entries()) {
      const reactId = `${message.id}:react:${reaction.emoji}:${String(index)}`;
      const reactRef = demoBlobRef(reactId);
      const reactOut = from.toLowerCase() === owner.toLowerCase();
      out.push({
        fixtureId: reactId,
        sentAt: sentAt + 45 + index,
        row: {
          id: messageId(owner, reactRef),
          owner,
          convoId,
          direction: reactOut ? 'out' : 'in',
          body: JSON.stringify({ target: blobRef, emoji: reaction.emoji }),
          kind: 'react',
          re: null,
          sentAt: sentAt + 45 + index,
          status: 'anchored',
          integrity: reactOut ? 'local' : 'verified',
          blobRef: reactRef,
          ephPub: hex64(`eph:${reactId}`),
          viewTag: viewTagOf(reactId),
          size: 256,
          txHash: null,
          poster: from,
          author: from,
          error: null,
        },
      });
    }
  }

  return out;
}

function buildWorld(): DemoWorld {
  const nowMs = Date.now();
  const owner = DEMO_ME.address;
  const pending: PendingRow[] = [];
  const peers: PeerRecord[] = [];
  const rooms: RoomRecord[] = [];
  const chain = new Map<string, DemoRoomChainFixture>();
  const convoByPeer = new Map<string, Hex>();

  for (const conversation of DEMO_CONVERSATIONS) {
    const convoId = hex64(`convo:${conversation.id}`);
    convoByPeer.set(conversation.peer.toLowerCase(), convoId);

    let lastSeenAt = 0;
    for (const message of conversation.messages) {
      const rows = pendingRowsFor(convoId, message, nowMs);
      for (const row of rows) lastSeenAt = Math.max(lastSeenAt, row.sentAt);
      pending.push(...rows);
    }

    peers.push({
      id: peerId(owner, convoId),
      owner,
      convoId,
      address: conversation.peer,
      x25519Pub: hex64(`x25519:${conversation.peer.toLowerCase()}`),
      ed25519Pub: hex64(`ed25519:${conversation.peer.toLowerCase()}`),
      createdAt: lastSeenAt - 7 * 86_400,
      lastSeenAt,
    });
  }

  for (const room of DEMO_ROOMS) {
    let lastSeenAt = 0;
    for (const message of room.messages) {
      const rows = pendingRowsFor(room.groupId, message, nowMs);
      for (const row of rows) lastSeenAt = Math.max(lastSeenAt, row.sentAt);
      pending.push(...rows);
    }

    const epoch = room.name === 'signal boardroom' ? 4 : 1;
    rooms.push({
      id: roomId(owner, room.groupId),
      owner,
      groupId: room.groupId,
      name: room.name,
      admin: room.admin,
      members: room.members.map((member) => member.toLowerCase() as Address),
      epoch,
      createdAt: lastSeenAt - 21 * 86_400,
      lastSeenAt,
    });
    chain.set(room.groupId.toLowerCase(), {
      exists: true,
      admin: room.admin,
      epoch,
      memberRoot: hex64(`root:${room.groupId}`),
      paidUntil: Math.floor((nowMs + room.paidForMs) / 1000),
      autoRenew: room.autoRenew,
      isActive: room.paidForMs > 0,
    });
  }

  /* Time order decides the fake log: older rows carry smaller seq numbers
     and earlier blocks, exactly as a real backfill would present them. */
  pending.sort((a, b) => a.sentAt - b.sentAt);
  const messages: ChatMessage[] = pending.map((entry, index) => ({
    ...entry.row,
    seq: SEQ_BASE + index,
    blockNumber:
      BLOCK_HEAD - Math.max(0, Math.floor((nowMs - entry.sentAt * 1000) / MS_PER_BLOCK)),
  }));
  messages.sort(compareMessages);

  seqCounter = SEQ_BASE + pending.length;
  blockCounter = BLOCK_HEAD;

  return {
    messages,
    peers,
    rooms,
    chain,
    convoByPeer,
    head: SEQ_BASE + pending.length - 1,
  };
}

/* ═══════════════════════════════════════════════════════ public seams ═══ */

/**
 * Builds the world (once) and writes it into the live messenger store.
 * Idempotent; safe under StrictMode's double-effect.
 */
export function seedDemoWorld(): void {
  if (seeded) return;
  seeded = true;
  world ??= buildWorld();
  useMessengerStore.setState({
    owner: DEMO_ME.address,
    hydrated: true,
    backfilling: false,
    scannedSeq: world.head,
    head: world.head,
    scanned: world.head - SEQ_BASE + 96,
    matched: world.messages.filter((message) => message.direction === 'in').length,
    messages: world.messages,
    peers: world.peers,
    rooms: world.rooms,
    tamperEvents: [],
    error: null,
  });
}

/** Fixture chain state for a demo room, or `null` for an unknown id. */
export function demoRoomChain(groupId: Hex): DemoRoomChainFixture | null {
  return world?.chain.get(groupId.toLowerCase()) ?? null;
}

/** The seeded conversation with a fixture peer, or a stable derived id. */
export function demoConvoIdFor(peer: Address): Hex {
  return (
    world?.convoByPeer.get(peer.toLowerCase()) ?? hex64(`convo:demo-dm:${peer.toLowerCase()}`)
  );
}

/** Next fake block for a simulated anchor. */
export function nextDemoBlock(): number {
  blockCounter += 1;
  return blockCounter;
}

/** Next fake seq for a simulated anchor. */
export function nextDemoSeq(): number {
  seqCounter += 1;
  return seqCounter;
}

/**
 * Registers a room created inside the demo (from `/app/rooms/new`) so the
 * rent dot, header countdown and members drawer read coherent fixture state.
 */
export function registerDemoRoom(params: {
  readonly groupId: Hex;
  readonly name: string;
  readonly months: number;
}): void {
  world ??= buildWorld();
  const nowMs = Date.now();
  world.chain.set(params.groupId.toLowerCase(), {
    exists: true,
    admin: DEMO_ME.address,
    epoch: 0,
    memberRoot: hex64(`root:${params.groupId}`),
    paidUntil: Math.floor((nowMs + params.months * 30 * 86_400_000) / 1000),
    autoRenew: false,
    isActive: true,
  });
}

/** A fresh, unique demo group id for a locally created room. */
export function demoGroupIdFor(name: string): Hex {
  return hex64(`demo-room:${name}:${String(Date.now())}`);
}

/* ─────────────────────────────────────────────── synthetic hook results ── */

const noop = (): void => undefined;

/** The drop-engine readout the demo session presents. */
export function demoDropsSnapshot(): UseDropsResult {
  const head = world?.head ?? SEQ_BASE;
  const matched = world?.messages.filter((message) => message.direction === 'in').length ?? 0;
  return {
    isHydrated: seeded,
    isBackfilling: false,
    scannedSeq: head,
    head,
    scanned: head - SEQ_BASE + 96,
    matched,
    tamperEvents: [],
    error: null,
    resync: noop,
    rescan: noop,
  };
}

/** A live-looking relay readout with no socket behind it. */
export function demoRelaySnapshot(): UseRelayStatusResult {
  const head = world?.head ?? SEQ_BASE;
  return {
    status: 'open',
    isLive: true,
    stats: {
      head,
      totalDrops: head,
      totalBlobs: head,
      uniquePosters: 214,
      indexedBlock: BLOCK_HEAD,
    },
    health: { ok: true, chainId: 4663, block: BLOCK_HEAD, indexerLagBlocks: 0 },
    indexerLag: 0,
    isLagging: false,
    error: null,
    lastEventAt: Date.now(),
  };
}
