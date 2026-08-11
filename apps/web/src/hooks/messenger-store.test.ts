/**
 * Receive-engine tests (SPEC §7.3).
 *
 * These drive the real engine end to end with real libsodium: real envelopes,
 * real view tags, real group keys. Only the three things the browser owns are
 * faked — the relay REST client, the relay WebSocket, and IndexedDB — so every
 * assertion below is about the engine's own logic, not about a stub.
 *
 * The dedupe gate is the reason this file exists: it is a high-water mark plus
 * a *bounded* retry set, and a bound that silently refuses entries is exactly
 * the kind of thing that looks correct until a drop goes missing in production.
 */
import {
  computeViewTag,
  convoIdFor,
  deriveIdentity,
  newGroupKey,
  scanMatches,
  seal,
  sealToGroup,
  wrapGroupKey,
  type IdentityKeys,
  type Plaintext,
} from '@hoodgram/crypto';
import { sha256, toHex, type Address, type Hex } from 'viem';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getBlob, getDrops, type DropPage, type DropRow } from '@/lib/relay';

import {
  attachMessenger,
  latestRoomKey,
  resyncMessenger,
  upsertPeer,
  upsertRoom,
  useMessengerStore,
  wipeMessenger,
  type PeerKeyResolver,
} from './messenger-store';
import { subscribeToRelay, type RelayStreamListener } from './relay-stream';
import { STEALTH_CONVO_ID, UNATTRIBUTED_CONVO_ID, type ChatMessage } from './types';

/* ════════════════════════════════════════════════════════════ doubles ════ */

/** Store name → keyed records. Mirrors the object stores `./idb` exposes. */
const db = vi.hoisted(() => new Map<string, Map<string, unknown>>());

vi.mock('./idb', () => {
  const table = (store: string): Map<string, unknown> => {
    const existing = db.get(store);
    if (existing !== undefined) return existing;
    const created = new Map<string, unknown>();
    db.set(store, created);
    return created;
  };
  const keyOf = (store: string, value: unknown): string => {
    const record = value as Record<string, unknown>;
    return String(store === 'meta' ? record['key'] : record['id']);
  };
  const ownedBy = (value: unknown, owner: string): boolean =>
    (value as Record<string, unknown>)['owner'] === owner;

  return {
    STORE_IDENTITY: 'identity',
    STORE_MESSAGES: 'messages',
    STORE_PEERS: 'peers',
    STORE_META: 'meta',
    STORE_ROOMS: 'rooms',
    STORE_ROOM_KEYS: 'roomKeys',
    INDEX_BY_OWNER: 'by-owner',
    hasIndexedDb: (): boolean => true,
    idbGet: (store: string, key: IDBValidKey): Promise<unknown> =>
      Promise.resolve(table(store).get(String(key)) ?? null),
    idbPut: (store: string, value: unknown): Promise<void> => {
      table(store).set(keyOf(store, value), value);
      return Promise.resolve();
    },
    idbPutMany: (store: string, values: readonly unknown[]): Promise<void> => {
      for (const value of values) table(store).set(keyOf(store, value), value);
      return Promise.resolve();
    },
    idbDelete: (store: string, key: IDBValidKey): Promise<void> => {
      table(store).delete(String(key));
      return Promise.resolve();
    },
    idbGetAllByOwner: (store: string, owner: string): Promise<unknown[]> =>
      Promise.resolve([...table(store).values()].filter((value) => ownedBy(value, owner))),
    idbDeleteByOwner: (store: string, owner: string): Promise<void> => {
      for (const [key, value] of table(store)) {
        if (ownedBy(value, owner)) table(store).delete(key);
      }
      return Promise.resolve();
    },
    idbClear: (store: string): Promise<void> => {
      table(store).clear();
      return Promise.resolve();
    },
  };
});

vi.mock('@/lib/relay', () => ({
  getDrops: vi.fn(),
  getBlob: vi.fn(),
}));

vi.mock('./relay-stream', () => ({
  subscribeToRelay: vi.fn(),
}));

/* ═══════════════════════════════════════════════════════ fake relay ═════ */

/** The anchor log, always ascending by seq — as both real sources are. */
const log: DropRow[] = [];
/** blobRef (lower-case) → ciphertext the relay will serve. */
const blobs = new Map<string, Uint8Array>();
/** blobRefs the relay currently refuses to serve at all (transient outage). */
const offline = new Set<string>();
/** Every blobRef `getBlob` was asked for, in order. */
const blobFetches: string[] = [];

let streamListener: RelayStreamListener | null = null;

function relayHead(): number {
  return log.at(-1)?.seq ?? 0;
}

function publish(row: DropRow, blob?: Uint8Array): DropRow {
  log.push(row);
  if (blob !== undefined) blobs.set(row.blobRef.toLowerCase(), blob);
  return row;
}

/** Pushes an already-published anchor down the WebSocket a second time. */
function emit(row: DropRow): void {
  streamListener?.onDrop?.(row);
}

/* ═══════════════════════════════════════════════════════════ fixtures ═══ */

const OWNER = `0x${'11'.repeat(20)}` as Address;
const SENDER = `0x${'22'.repeat(20)}` as Address;
const RELAY_POSTER = `0x${'33'.repeat(20)}` as Address;
const STRANGER = `0x${'44'.repeat(20)}` as Address;

const GROUP_ID = `0x${'ab'.repeat(32)}` as Hex;

let ownerKeys: IdentityKeys;
let senderKeys: IdentityKeys;

/** The conversation id an attributed drop from SENDER must land in. */
function senderConvoId(): Hex {
  return convoIdFor(ownerKeys.x25519.publicKey, senderKeys.x25519.publicKey);
}

/** Deterministic filler bytes — no entropy needed, but every drop must differ. */
function pseudoBytes(seed: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let x = (seed * 2_654_435_761) >>> 0 || 1;
  for (let i = 0; i < length; i += 1) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

function txHashFor(seq: number): Hex {
  return toHex(pseudoBytes(seq + 7_000_000, 32));
}

function plaintext(body: string, sentAt: number, kind: Plaintext['kind'] = 'text'): Plaintext {
  return { v: 1, t: sentAt, kind, body };
}

interface RowOverrides {
  readonly poster?: Address;
  readonly timestamp?: number;
}

/** A real 1:1 envelope sealed to `to`, published on the fake relay. */
async function stealthDrop(
  seq: number,
  body: string,
  sentAt: number,
  to: IdentityKeys = ownerKeys,
  overrides: RowOverrides = {},
  kind: Plaintext['kind'] = 'text',
): Promise<DropRow> {
  const sealed = await seal(plaintext(body, sentAt, kind), to.x25519.publicKey);
  return publish(
    {
      seq,
      convoId: STEALTH_CONVO_ID,
      poster: overrides.poster ?? SENDER,
      ephPub: sealed.ephPub,
      blobRef: sealed.blobRef,
      viewTag: sealed.viewTag,
      size: sealed.size,
      timestamp: overrides.timestamp ?? sentAt,
      txHash: txHashFor(seq),
      blockNumber: 1000 + seq,
    },
    sealed.blob,
  );
}

/** A real group envelope for `GROUP_ID`, published on the fake relay. */
async function roomDrop(
  seq: number,
  body: string,
  sentAt: number,
  key: Uint8Array,
  groupId: Hex = GROUP_ID,
): Promise<DropRow> {
  const sealed = await sealToGroup(plaintext(body, sentAt), key);
  return publish(
    {
      seq,
      convoId: groupId,
      poster: SENDER,
      ephPub: sealed.ephPub,
      blobRef: sealed.blobRef,
      viewTag: sealed.viewTag,
      size: sealed.size,
      timestamp: sentAt,
      txHash: txHashFor(seq),
      blockNumber: 1000 + seq,
    },
    sealed.blob,
  );
}

/**
 * A room anchor whose bytes are junk: it reaches `fetchVerified` (so the fetch
 * is observable) and then fails to open, which keeps the bulk-boundary test
 * from paying for thousands of real seals *and* thousands of store merges.
 */
function opaqueRoomDrop(seq: number, groupKey: Uint8Array): DropRow {
  const blob = pseudoBytes(seq, 96);
  return publish(
    {
      seq,
      convoId: GROUP_ID,
      poster: SENDER,
      ephPub: `0x${'00'.repeat(32)}`,
      blobRef: sha256(blob),
      viewTag: computeViewTag(groupKey),
      size: 256,
      timestamp: 1_700_000_000 + seq,
      txHash: txHashFor(seq),
      blockNumber: 1000 + seq,
    },
    blob,
  );
}

/**
 * An anchor addressed to somebody else. The view tag is chosen to *provably*
 * miss our key, so the 1-in-256 false-positive rate cannot make a bulk test
 * flaky.
 */
async function foreignDrop(seq: number): Promise<DropRow> {
  const ephPub = pseudoBytes(seq + 500_000, 32);
  const collides = await scanMatches(ephPub, 0, ownerKeys.x25519.privateKey);
  return publish({
    seq,
    convoId: STEALTH_CONVO_ID,
    poster: STRANGER,
    ephPub: toHex(ephPub),
    blobRef: sha256(pseudoBytes(seq + 900_000, 48)),
    viewTag: collides ? 1 : 0,
    size: 256,
    timestamp: 1_700_000_000 + seq,
    txHash: txHashFor(seq),
    blockNumber: 1000 + seq,
  });
}

/** A `system` drop carrying a room key, sealed 1:1 to us. */
async function roomKeyDrop(
  seq: number,
  groupId: Hex,
  epoch: number,
  name: string,
  key: Uint8Array,
  sentAt: number,
): Promise<DropRow> {
  const wrapped = await wrapGroupKey(key, ownerKeys.x25519.publicKey);
  const body = JSON.stringify({
    type: 'roomKey',
    groupId,
    epoch,
    name,
    wrapped: toHex(wrapped),
  });
  return stealthDrop(seq, body, sentAt, ownerKeys, {}, 'system');
}

function seedRoom(groupId: Hex, name: string, epoch: number): void {
  const rooms = db.get('rooms') ?? new Map<string, unknown>();
  db.set('rooms', rooms);
  rooms.set(`${OWNER}:${groupId}`, {
    id: `${OWNER}:${groupId}`,
    owner: OWNER,
    groupId,
    name,
    admin: SENDER,
    members: [OWNER, SENDER],
    epoch,
    createdAt: 1_700_000_000,
    lastSeenAt: 1_700_000_000,
  });
}

function seedRoomKey(groupId: Hex, epoch: number, key: Uint8Array): void {
  const keys = db.get('roomKeys') ?? new Map<string, unknown>();
  db.set('roomKeys', keys);
  keys.set(`${OWNER}:${groupId}:${String(epoch)}`, {
    id: `${OWNER}:${groupId}:${String(epoch)}`,
    owner: OWNER,
    groupId,
    epoch,
    key,
  });
}

function seedMessage(message: ChatMessage): void {
  const messages = db.get('messages') ?? new Map<string, unknown>();
  db.set('messages', messages);
  messages.set(message.id, message);
}

/* ═════════════════════════════════════════════════════════ harness ══════ */

const resolveKnownSender: PeerKeyResolver = (addresses) => {
  const out = new Map<string, Hex>();
  for (const address of addresses) {
    if (address.toLowerCase() === SENDER.toLowerCase()) {
      out.set(address.toLowerCase(), toHex(senderKeys.x25519.publicKey));
    }
  }
  return Promise.resolve(out);
};

const resolveNobody: PeerKeyResolver = () => Promise.resolve(new Map<string, Hex>());

function tick(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function ticks(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) await tick();
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await tick();
  }
}

function state(): ReturnType<typeof useMessengerStore.getState> {
  return useMessengerStore.getState();
}

/** Attaches the engine and waits for hydrate + the whole backfill sweep. */
async function attachAndSettle(resolver: PeerKeyResolver = resolveKnownSender): Promise<void> {
  attachMessenger({ owner: OWNER, keys: ownerKeys, resolvePeerKeys: resolver });
  await waitUntil(() => state().hydrated && !state().backfilling, 'backfill to finish');
  await ticks(3);
}

function bodies(): string[] {
  return state().messages.map((message) => message.body);
}

/** The cursor as it was actually persisted, which is the one that survives a reload. */
function persistedCursor(): number | null {
  const row = db.get('meta')?.get(`${OWNER}:scan`);
  if (row === undefined) return null;
  return (row as { scannedSeq: number }).scannedSeq;
}

beforeAll(async () => {
  ownerKeys = await deriveIdentity(`0x${'a1'.repeat(65)}`);
  senderKeys = await deriveIdentity(`0x${'b2'.repeat(65)}`);
});

beforeEach(() => {
  log.length = 0;
  blobs.clear();
  offline.clear();
  blobFetches.length = 0;
  db.clear();
  streamListener = null;

  vi.mocked(getDrops).mockReset();
  vi.mocked(getBlob).mockReset();
  vi.mocked(subscribeToRelay).mockReset();

  vi.mocked(getDrops).mockImplementation(
    (params: { since?: number; limit?: number } = {}): Promise<DropPage> => {
      const since = params.since ?? 0;
      const limit = params.limit ?? 200;
      const drops = log.filter((row) => row.seq > since).slice(0, limit);
      return Promise.resolve({ drops, head: relayHead() });
    },
  );

  vi.mocked(getBlob).mockImplementation((blobRef: Hex): Promise<Uint8Array | null> => {
    const ref = blobRef.toLowerCase();
    blobFetches.push(ref);
    if (offline.has(ref)) return Promise.reject(new Error('relay unreachable'));
    return Promise.resolve(blobs.get(ref) ?? null);
  });

  vi.mocked(subscribeToRelay).mockImplementation((listener: RelayStreamListener) => {
    streamListener = listener;
    return (): void => {
      if (streamListener === listener) streamListener = null;
    };
  });
});

afterEach(async () => {
  await wipeMessenger(OWNER);
  vi.restoreAllMocks();
});

/* ═══════════════════════════════════════════════════════════ tests ══════ */

describe('receive engine — dedupe', () => {
  it('processes an anchor once when the backfill and the stream both deliver it', async () => {
    const drop = await stealthDrop(1, 'hello twice', 1_700_000_100);
    await attachAndSettle();

    expect(bodies()).toEqual(['hello twice']);
    expect(blobFetches).toEqual([drop.blobRef.toLowerCase()]);
    expect(state().scanned).toBe(1);

    emit(drop);
    await ticks(25);

    expect(bodies()).toEqual(['hello twice']);
    expect(blobFetches).toHaveLength(1);
    // The gate is *work avoidance*: a second look must not even be attempted.
    expect(state().scanned).toBe(1);
  });

  it('skips a re-emitted lower seq, which is what a reorg rewind looks like', async () => {
    await stealthDrop(1, 'first', 1_700_000_100);
    const second = await stealthDrop(2, 'second', 1_700_000_200);
    await stealthDrop(3, 'third', 1_700_000_300);
    await attachAndSettle();

    expect(bodies()).toEqual(['first', 'second', 'third']);
    const fetchesAfterBackfill = blobFetches.length;

    emit(second);
    await ticks(25);

    expect(bodies()).toEqual(['first', 'second', 'third']);
    expect(blobFetches).toHaveLength(fetchesAfterBackfill);
    expect(state().scanned).toBe(3);
  });

  it('re-examines a drop whose blob fetch failed when the same anchor comes back', async () => {
    const flaky = await stealthDrop(1, 'delayed by an outage', 1_700_000_100);
    await stealthDrop(2, 'arrived fine', 1_700_000_200);
    offline.add(flaky.blobRef.toLowerCase());

    await attachAndSettle();
    expect(bodies()).toEqual(['arrived fine']);

    // The relay recovers and the indexer re-emits the anchor.
    offline.clear();
    emit(flaky);
    await waitUntil(() => state().messages.length === 2, 'the retried drop to land');

    expect(bodies()).toEqual(['delayed by an outage', 'arrived fine']);
    expect(state().messages.filter((m) => m.body === 'delayed by an outage')).toHaveLength(1);
  });

  it('does not re-arm a drop that was merely missing rather than unfetchable', async () => {
    // A 404 is a permanent verdict — `getBlob` resolves null — so the seq stays
    // consumed and a re-delivery must not cost a second round trip.
    const ghost = await stealthDrop(1, 'never stored', 1_700_000_100);
    blobs.delete(ghost.blobRef.toLowerCase());

    await attachAndSettle();
    expect(state().messages).toHaveLength(0);
    expect(blobFetches).toHaveLength(1);

    emit(ghost);
    await ticks(25);
    expect(blobFetches).toHaveLength(1);
  });

  /**
   * The retry set is capped at 4096 entries and the cap *refuses* new arrivals
   * rather than evicting old ones. This pins both halves of that boundary: the
   * 4096 armed seqs are examined again, and the 4097th never is.
   */
  it('arms at most 4096 failed drops, and forgets the ones past the cap', async () => {
    const groupKey = newGroupKey();
    seedRoom(GROUP_ID, 'Bulk', 0);
    seedRoomKey(GROUP_ID, 0, groupKey);

    const total = 4097;
    const real = await roomDrop(1, 'inside the cap', 1_700_000_001, groupKey);
    for (let seq = 2; seq <= total; seq += 1) opaqueRoomDrop(seq, groupKey);
    for (const row of log) offline.add(row.blobRef.toLowerCase());

    await attachAndSettle();
    // Every anchor was examined and every fetch failed: 4097 attempts, no rows.
    expect(state().scanned).toBe(total);
    expect(blobFetches).toHaveLength(total);
    expect(state().messages).toHaveLength(0);
    // The cap refused 1 of the 4097 armed seqs, so the retry set is *not* a
    // complete record of the outage — which is exactly why the cursor may not
    // move past the first failure. Room drops are fetched with no view-tag
    // filter, so this is the ordinary shape of a relay outage, not a corner.
    expect(state().scannedSeq).toBe(0);
    expect(persistedCursor()).toBeNull();

    offline.clear();
    blobFetches.length = 0;

    // Replay the whole log on the stream, as a reorg rewind would.
    for (let index = 0; index < log.length; index += 1) {
      const row = log[index];
      if (row !== undefined) emit(row);
      if (index % 256 === 255) await ticks(2);
    }
    await waitUntil(() => blobFetches.length >= total - 1, 'the armed drops to be retried');
    await ticks(30);

    const lastRow = log.at(-1);
    expect(lastRow?.seq).toBe(total);
    // Exactly the first 4096 were armed; the 4097th was refused by the cap and
    // is therefore invisible until a rescan from genesis.
    expect(blobFetches).toHaveLength(total - 1);
    expect(blobFetches).not.toContain(lastRow?.blobRef.toLowerCase());
    // …and an armed drop really does complete, not merely get re-fetched.
    expect(blobFetches).toContain(real.blobRef.toLowerCase());
    expect(bodies()).toEqual(['inside the cap']);
  });

  /**
   * `fetchVerified` promises to "leave the drop for the next resync". The retry
   * set alone cannot keep that promise: it is only ever consulted for a seq the
   * WebSocket re-delivers, and a backfilled drop is never re-delivered. The
   * cursor is what keeps it — it must not pass a seq this sweep failed on.
   */
  it('recovers an outage-skipped drop on the next resync', async () => {
    const flaky = await stealthDrop(1, 'lost to the outage', 1_700_000_100);
    await stealthDrop(2, 'arrived fine', 1_700_000_200);
    offline.add(flaky.blobRef.toLowerCase());

    await attachAndSettle();
    expect(bodies()).toEqual(['arrived fine']);
    // The sweep saw seq 2, but seq 1 is unaccounted for, so nothing is durable.
    expect(state().scannedSeq).toBe(0);
    expect(persistedCursor()).toBeNull();

    offline.clear();
    resyncMessenger();
    await waitUntil(() => state().messages.length === 2, 'the resync to refetch seq 1');

    expect(bodies()).toEqual(['lost to the outage', 'arrived fine']);
    expect(state().scannedSeq).toBe(2);
  });

  it('holds the cursor below a hole in the middle of a page', async () => {
    await stealthDrop(1, 'before the hole', 1_700_000_100);
    const lost = await stealthDrop(2, 'in the hole', 1_700_000_200);
    await stealthDrop(3, 'after the hole', 1_700_000_300);
    offline.add(lost.blobRef.toLowerCase());

    await attachAndSettle();

    // Seq 3 was opened and stored, but the cursor may not claim it: doing so
    // would put seq 2 permanently out of reach of `GET /v1/drops`.
    expect(bodies()).toEqual(['before the hole', 'after the hole']);
    expect(state().scannedSeq).toBe(1);
    expect(persistedCursor()).toBe(1);

    offline.clear();
    resyncMessenger();
    await waitUntil(() => state().messages.length === 3, 'the resync to fill the hole');

    expect(bodies()).toEqual(['before the hole', 'in the hole', 'after the hole']);
    expect(state().scannedSeq).toBe(3);
    expect(persistedCursor()).toBe(3);
  });
});

describe('receive engine — failure containment', () => {
  /**
   * The loss this pins is total and silent: an aborted sweep leaves a gap, and
   * one live drop above it used to persist a cursor past the gap. The relay
   * only ever serves `seq > cursor`, so every drop in between was gone from
   * that device for good — in this session and every future one.
   */
  it('does not let a live drop persist a cursor past an aborted sweep', async () => {
    await stealthDrop(1, 'one', 1_700_000_001);
    await stealthDrop(2, 'two', 1_700_000_002);
    const live = await stealthDrop(9, 'nine', 1_700_000_009);

    // `/v1/drops` is rate-limited; a 429 mid-sweep is an ordinary event.
    vi.mocked(getDrops).mockImplementationOnce(() =>
      Promise.reject(new Error('429 Too Many Requests')),
    );

    attachMessenger({ owner: OWNER, keys: ownerKeys, resolvePeerKeys: resolveKnownSender });
    await waitUntil(() => state().hydrated && !state().backfilling, 'the sweep to abort');
    expect(state().error).not.toBeNull();
    expect(state().messages).toHaveLength(0);

    // The stream keeps running through the abort and delivers a far higher seq.
    emit(live);
    await waitUntil(() => bodies().includes('nine'), 'the live drop to be processed');
    await ticks(5);

    // It is recorded — but it must not drag the cursor over seqs 1…8.
    expect(state().scannedSeq).toBe(0);
    expect(persistedCursor()).toBeNull();

    // …and recovery is automatic: no human presses "resync".
    await waitUntil(() => state().messages.length === 3, 'the backfill to retry itself');
    expect(bodies()).toEqual(['one', 'two', 'nine']);
    expect(state().scannedSeq).toBe(9);
    expect(persistedCursor()).toBe(9);
    expect(state().error).toBeNull();
  });

  /**
   * `classifySlice` admits 40–150 drops before any I/O runs. If the mark were
   * written there, one unhandled throw in `runSliceIo` would consume the entire
   * slice with no row written for any of it — the old serial loop lost only the
   * drops after the failure point. The mark has to mean "fully processed".
   *
   * The throw is injected through a store subscriber (which is what React's
   * `useSyncExternalStore` is) because every writer the engine currently calls
   * swallows its own errors: `message-store` catches each IndexedDB failure and
   * `@hoodgram/crypto` returns `null` rather than throwing. Containment has to
   * hold for the callers that do not, and a subscriber is one of them today.
   * It fires from `upsertPeer`, which runs after every blob in the slice has
   * been fetched and opened and before any message row is written.
   */
  it('loses no drop of a slice when its I/O throws', async () => {
    await stealthDrop(1, 'one', 1_700_000_001);
    const second = await stealthDrop(2, 'two', 1_700_000_002);
    await stealthDrop(3, 'three', 1_700_000_003);

    let armed = true;
    const unsubscribe = useMessengerStore.subscribe((next, previous) => {
      if (!armed || next.peers.length <= previous.peers.length) return;
      armed = false;
      throw new Error('slice I/O blew up');
    });

    try {
      await attachAndSettle();
      // All three were classified in one slice, and not one of them was stored.
      expect(state().messages).toHaveLength(0);
      expect(state().scannedSeq).toBe(0);
    } finally {
      unsubscribe();
    }

    /* Silence the relay so only the re-delivery below can produce a row: this
       has to prove the *dedupe mark* was never taken, not that some later sweep
       happened to refetch the page. */
    log.length = 0;

    emit(second);
    await waitUntil(() => state().messages.length === 1, 'the re-delivered drop to land');
    expect(bodies()).toEqual(['two']);
  });
});

describe('receive engine — chunked processing', () => {
  it('sweeps a multi-page backlog without losing or double-counting a drop', async () => {
    const mine = new Map<number, string>();
    for (let seq = 1; seq <= 1000; seq += 1) {
      if (seq % 20 === 0) {
        const body = `mine #${String(seq)}`;
        mine.set(seq, body);
        await stealthDrop(seq, body, 1_700_000_000 + seq);
      } else {
        await foreignDrop(seq);
      }
    }

    await attachAndSettle();

    // Every anchor examined exactly once, every one of ours opened exactly once.
    expect(state().scanned).toBe(1000);
    expect(state().matched).toBe(mine.size);
    expect(state().messages).toHaveLength(mine.size);
    expect(bodies()).toEqual([...mine.values()]);

    // Paging contract: five full pages of 200, then one empty page to stop.
    const sinceValues = vi
      .mocked(getDrops)
      .mock.calls.map((call) => call[0]?.since ?? 0);
    expect(sinceValues).toEqual([0, 200, 400, 600, 800, 1000]);

    expect(state().scannedSeq).toBe(1000);
    expect(state().head).toBe(1000);
    expect(db.get('meta')?.get(`${OWNER}:scan`)).toMatchObject({ scannedSeq: 1000 });
  });

  it('resumes correctly when the slice budget cuts mid-page', async () => {
    // Force a cut every few drops by making the engine's clock jump 3ms per
    // reading against its 8ms budget. This is the real budget mechanism, not a
    // stub of the loop.
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      clock += 3;
      return clock;
    });

    const expected: string[] = [];
    for (let seq = 1; seq <= 40; seq += 1) {
      if (seq % 4 === 0) {
        const body = `sliced #${String(seq)}`;
        expected.push(body);
        await stealthDrop(seq, body, 1_700_000_000 + seq);
      } else {
        await foreignDrop(seq);
      }
    }

    await attachAndSettle();

    expect(state().scanned).toBe(40);
    expect(bodies()).toEqual(expected);
    expect(state().scannedSeq).toBe(40);
  });

  it('keeps thread order when several drops share a timestamp', async () => {
    // Ties break on seq, so an anchor never overtakes an earlier one just
    // because the sender's clock was coarse.
    await stealthDrop(5, 'third by seq', 1_700_000_500);
    await stealthDrop(3, 'first by seq', 1_700_000_500);
    await stealthDrop(4, 'second by seq', 1_700_000_500);
    log.sort((a, b) => a.seq - b.seq);

    await attachAndSettle();

    expect(bodies()).toEqual(['first by seq', 'second by seq', 'third by seq']);
  });
});

describe('receive engine — routing and integrity', () => {
  it('anchors our own outbound row by blobRef even when the relay is the poster', async () => {
    const sealed = await seal(plaintext('sent from here', 1_700_000_100), senderKeys.x25519.publicKey);
    const id = `${OWNER}:${sealed.blobRef}`;
    seedMessage({
      id,
      owner: OWNER,
      convoId: senderConvoId(),
      direction: 'out',
      body: 'sent from here',
      kind: 'text',
      re: null,
      sentAt: 1_700_000_100,
      status: 'queued',
      integrity: 'local',
      blobRef: sealed.blobRef,
      ephPub: sealed.ephPub,
      viewTag: sealed.viewTag,
      size: sealed.size,
      seq: null,
      blockNumber: null,
      txHash: null,
      poster: null,
      error: null,
    });
    publish(
      {
        seq: 1,
        convoId: STEALTH_CONVO_ID,
        poster: RELAY_POSTER,
        ephPub: sealed.ephPub,
        blobRef: sealed.blobRef,
        viewTag: sealed.viewTag,
        size: sealed.size,
        timestamp: 1_700_000_100,
        txHash: txHashFor(1),
        blockNumber: 4242,
      },
      sealed.blob,
    );

    await attachAndSettle();

    expect(state().messages).toHaveLength(1);
    const row = state().messages[0];
    expect(row?.status).toBe('anchored');
    expect(row?.direction).toBe('out');
    expect(row?.seq).toBe(1);
    expect(row?.blockNumber).toBe(4242);
    expect(row?.poster).toBe(RELAY_POSTER);
    // Reconciliation is a pure state flip — our own ciphertext is never re-fetched.
    expect(blobFetches).toHaveLength(0);
  });

  it('raises a tamper event and drops the row when served bytes do not match the ref', async () => {
    const drop = await stealthDrop(1, 'authentic', 1_700_000_100);
    const forged = pseudoBytes(4242, 128);
    blobs.set(drop.blobRef.toLowerCase(), forged);

    await attachAndSettle();

    expect(state().messages).toHaveLength(0);
    expect(state().tamperEvents).toHaveLength(1);
    expect(state().tamperEvents[0]).toMatchObject({
      seq: 1,
      blobRef: drop.blobRef,
      computed: sha256(forged),
    });
  });

  it('applies a room-key handoff before the room drops that need it', async () => {
    // Both arrive in the same page: the engine promises stealth-before-rooms
    // precisely so the key lands first.
    const groupKey = newGroupKey();
    await roomKeyDrop(1, GROUP_ID, 0, 'Back Room', groupKey, 1_700_000_100);
    await roomDrop(2, 'said in the room', 1_700_000_200, groupKey);

    await attachAndSettle();

    const room = state().rooms.find((entry) => entry.groupId === GROUP_ID);
    expect(room?.name).toBe('Back Room');
    expect(latestRoomKey(GROUP_ID)?.epoch).toBe(0);
    expect(bodies()).toEqual([
      'Added to “Back Room”. Room key received (epoch 0).',
      'said in the room',
    ]);
    const roomMessage = state().messages.find((m) => m.body === 'said in the room');
    expect(roomMessage?.convoId).toBe(GROUP_ID);
  });

  it('opens a room drop sealed under a superseded epoch key', async () => {
    const oldKey = newGroupKey();
    const newKey = newGroupKey();
    seedRoom(GROUP_ID, 'Rotated', 1);
    seedRoomKey(GROUP_ID, 0, oldKey);
    seedRoomKey(GROUP_ID, 1, newKey);
    await roomDrop(1, 'sealed before the rotation', 1_700_000_100, oldKey);
    await roomDrop(2, 'sealed after the rotation', 1_700_000_200, newKey);

    await attachAndSettle();

    expect(bodies()).toEqual(['sealed before the rotation', 'sealed after the rotation']);
    expect(latestRoomKey(GROUP_ID)?.epoch).toBe(1);
  });

  it('files a decryptable drop from an unregistered sender under the unattributed bucket', async () => {
    await stealthDrop(1, 'who sent this', 1_700_000_100);

    await attachAndSettle(resolveNobody);

    expect(state().messages[0]?.convoId).toBe(UNATTRIBUTED_CONVO_ID);
    const peer = state().peers.find((entry) => entry.convoId === UNATTRIBUTED_CONVO_ID);
    expect(peer?.address).toBeNull();
    expect(peer?.x25519Pub).toBeNull();
  });

  it('attributes a drop to its sender conversation once the key resolves', async () => {
    await stealthDrop(1, 'from a known peer', 1_700_000_100);

    await attachAndSettle();

    expect(state().messages[0]?.convoId).toBe(senderConvoId());
    const peer = state().peers.find((entry) => entry.convoId === senderConvoId());
    expect(peer?.address).toBe(SENDER);
    expect(state().messages[0]?.integrity).toBe('verified');
  });

  it('ignores a stealth drop this device posted itself', async () => {
    // The ephemeral secret died inside `seal()`, so our own stealth anchor can
    // never be opened here — and must not be counted as a match either.
    await stealthDrop(1, 'unopenable', 1_700_000_100, ownerKeys, { poster: OWNER });

    await attachAndSettle();

    expect(state().messages).toHaveLength(0);
    expect(state().matched).toBe(0);
    expect(blobFetches).toHaveLength(0);
  });
});

describe('store merges', () => {
  it('keeps the earliest createdAt and the newest key when a peer is upserted twice', async () => {
    await attachAndSettle();
    const convoId = senderConvoId();
    const base = {
      id: `${OWNER}:${convoId}`,
      owner: OWNER,
      convoId,
      address: SENDER,
      x25519Pub: toHex(senderKeys.x25519.publicKey),
      createdAt: 100,
      lastSeenAt: 400,
    };

    await upsertPeer(base);
    const merged = await upsertPeer({ ...base, createdAt: 900, lastSeenAt: 200, x25519Pub: null });

    expect(merged.createdAt).toBe(100);
    expect(merged.lastSeenAt).toBe(400);
    expect(merged.x25519Pub).toBe(base.x25519Pub);
    expect(state().peers.filter((peer) => peer.convoId === convoId)).toHaveLength(1);
  });

  it('unions members and keeps the highest epoch when a room is upserted twice', async () => {
    await attachAndSettle();
    const base = {
      id: `${OWNER}:${GROUP_ID}`,
      owner: OWNER,
      groupId: GROUP_ID,
      name: 'Back Room',
      admin: SENDER,
      members: [OWNER],
      epoch: 3,
      createdAt: 100,
      lastSeenAt: 100,
    };

    await upsertRoom(base);
    const merged = await upsertRoom({
      ...base,
      name: '',
      admin: null,
      members: [SENDER],
      epoch: 1,
      createdAt: 900,
      lastSeenAt: 50,
    });

    expect(merged.name).toBe('Back Room');
    expect(merged.admin).toBe(SENDER);
    expect([...merged.members].sort()).toEqual([OWNER, SENDER].sort());
    expect(merged.epoch).toBe(3);
    expect(merged.createdAt).toBe(100);
    expect(merged.lastSeenAt).toBe(100);
    expect(state().rooms).toHaveLength(1);
  });
});
