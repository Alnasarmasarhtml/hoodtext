/**
 * Persistence for the relay: content-addressed blob storage plus the indexed
 * `Anchors.Dropped` log.
 *
 * Backed by the built-in `node:sqlite` module — no native dependency, nothing to
 * compile (SPEC §3, §6). Every statement is prepared once and reused.
 */

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync as SqliteDatabase, StatementSync } from 'node:sqlite';

/**
 * `node:sqlite` is exposed only under the `node:` specifier, and Node lists it in
 * `module.builtinModules` *with* that prefix. Vite (which powers Vitest) detects
 * builtins by stripping the prefix and looking for a bare `sqlite` entry, finds
 * nothing, and tries to resolve a package that does not exist. Loading the module
 * through `createRequire` keeps the bundler out of it; the `import type` above
 * is erased at compile time, so the types cost nothing at runtime.
 */
const { DatabaseSync } = createRequire(import.meta.url)(
  'node:sqlite',
) as typeof import('node:sqlite');

/** A row of the message log, exactly as `/v1/drops` returns it (SPEC §6). */
export interface DropRow {
  readonly seq: number;
  readonly convoId: `0x${string}`;
  readonly poster: `0x${string}`;
  readonly ephPub: `0x${string}`;
  readonly blobRef: `0x${string}`;
  readonly viewTag: number;
  readonly size: number;
  readonly timestamp: number;
  readonly txHash: `0x${string}`;
  readonly blockNumber: number;
}

/** Body of `GET /v1/stats` (SPEC §6). */
export interface RelayStats {
  readonly head: number;
  readonly totalDrops: number;
  readonly totalBlobs: number;
  readonly uniquePosters: number;
  readonly indexedBlock: number;
}

export interface StoredBlob {
  readonly ref: `0x${string}`;
  readonly bytes: Uint8Array;
  readonly size: number;
}

export interface PutBlobResult {
  readonly ref: `0x${string}`;
  readonly size: number;
  /** `false` when the identical blob was already present — the write was a no-op. */
  readonly stored: boolean;
}

/** Raised when SQLite hands back a row shaped differently than the schema promises. */
export class DbError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DbError';
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS blobs (
  ref        TEXT     PRIMARY KEY,
  bytes      BLOB    NOT NULL,
  size       INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS drops (
  seq          INTEGER PRIMARY KEY,
  convo_id     TEXT     NOT NULL,
  poster       TEXT     NOT NULL,
  eph_pub      TEXT     NOT NULL,
  blob_ref     TEXT     NOT NULL,
  view_tag     INTEGER NOT NULL,
  size         INTEGER NOT NULL,
  timestamp    INTEGER NOT NULL,
  tx_hash      TEXT     NOT NULL,
  block_number INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS drops_convo_id_idx     ON drops(convo_id);
CREATE INDEX IF NOT EXISTS drops_block_number_idx ON drops(block_number);
-- The stats query counts distinct posters; without this it is a full table scan
-- plus a temp b-tree, the single most expensive query the relay runs.
CREATE INDEX IF NOT EXISTS drops_poster_idx       ON drops(poster);

-- The retention sweep deletes by age. Without this index that DELETE walks every
-- page of the table — including the multi-MiB payloads it is not filtering on.
CREATE INDEX IF NOT EXISTS blobs_created_at_idx   ON blobs(created_at);

CREATE TABLE IF NOT EXISTS cursor (
  id         INTEGER PRIMARY KEY,
  last_block INTEGER NOT NULL
) STRICT;
`;

const CURSOR_ID = 1;

/** `0x` + sha256 hex — the canonical blob reference (SPEC §5 wire format). */
export function blobRefOf(bytes: Uint8Array): `0x${string}` {
  return `0x${createHash('sha256').update(bytes).digest('hex')}`;
}

type Row = Record<string, unknown>;

function readInt(row: Row, column: string): number {
  const value = row[column];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new DbError(`column "${column}" exceeds the safe integer range: ${value}`);
    }
    return Number(value);
  }
  throw new DbError(`column "${column}" is not an integer (got ${typeof value})`);
}

function readText(row: Row, column: string): string {
  const value = row[column];
  if (typeof value === 'string') return value;
  throw new DbError(`column "${column}" is not text (got ${typeof value})`);
}

function readHex(row: Row, column: string): `0x${string}` {
  const value = readText(row, column);
  if (!value.startsWith('0x')) {
    throw new DbError(`column "${column}" is not 0x-prefixed hex`);
  }
  return value as `0x${string}`;
}

function readBytes(row: Row, column: string): Uint8Array {
  const value = row[column];
  if (value instanceof Uint8Array) return value;
  throw new DbError(`column "${column}" is not a blob`);
}

function toDropRow(row: Row): DropRow {
  return {
    seq: readInt(row, 'seq'),
    convoId: readHex(row, 'convo_id'),
    poster: readHex(row, 'poster'),
    ephPub: readHex(row, 'eph_pub'),
    blobRef: readHex(row, 'blob_ref'),
    viewTag: readInt(row, 'view_tag'),
    size: readInt(row, 'size'),
    timestamp: readInt(row, 'timestamp'),
    txHash: readHex(row, 'tx_hash'),
    blockNumber: readInt(row, 'block_number'),
  };
}

/**
 * Every relay query lives here. The class owns the `DatabaseSync` handle and is
 * the only place raw SQL appears.
 */
/**
 * How long a {@link RelayStats} snapshot may be reused.
 *
 * The websocket broadcast is every 10s and nothing else needs fresher numbers, so
 * this only ever collapses a *flood* — the honest caller sees the same value it
 * would have computed. Every write path invalidates the cache explicitly, so this
 * TTL is a ceiling on staleness from concurrent writers, not on correctness.
 */
const STATS_TTL_MS = 2_000;

export class RelayDb {
  readonly #db: SqliteDatabase;
  readonly #statements = new Map<string, StatementSync>();
  #statsCache: { readonly at: number; readonly value: RelayStats } | null = null;
  #closed = false;

  private constructor(db: SqliteDatabase) {
    this.#db = db;
  }

  /**
   * Open (creating if absent) the database at `path` and apply the schema.
   *
   * @param path - filesystem path, or `':memory:'` for an ephemeral database.
   */
  static open(path: string): RelayDb {
    if (path !== ':memory:' && !path.startsWith('file:')) {
      mkdirSync(dirname(path), { recursive: true });
    }
    const db = new DatabaseSync(path);
    // WAL keeps readers from blocking the indexer's writes. It is a no-op for
    // in-memory databases, which SQLite always journals in memory.
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
    // `node:sqlite` defaults busy_timeout to 0, so any second holder of the file
    // — a backup, an `sqlite3` shell, a second relay on the same volume — turns
    // into an instant SQLITE_BUSY throw with no retry. Wait instead.
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(SCHEMA);
    db.exec('PRAGMA user_version = 1;');
    return new RelayDb(db);
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** The journal mode SQLite actually settled on — `'wal'` for any file-backed db. */
  journalMode(): string {
    const row = this.#prepare('PRAGMA journal_mode').get();
    return row === undefined ? 'unknown' : readText(row, 'journal_mode');
  }

  /** Prepare once, reuse forever. Statements are finalised when the handle closes. */
  #prepare(sql: string): StatementSync {
    const cached = this.#statements.get(sql);
    if (cached !== undefined) return cached;
    if (this.#closed) {
      throw new DbError('database handle is closed');
    }
    const statement = this.#db.prepare(sql);
    this.#statements.set(sql, statement);
    return statement;
  }

  // ── blobs ────────────────────────────────────────────────────────────────

  /**
   * Store `bytes` under its own sha256. Any client-supplied reference is
   * irrelevant: the ref is derived here and nowhere else. Re-storing identical
   * bytes is an idempotent no-op.
   */
  putBlob(bytes: Uint8Array): PutBlobResult {
    const ref = blobRefOf(bytes);
    const result = this.#prepare(
      'INSERT INTO blobs (ref, bytes, size, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(ref) DO NOTHING',
    ).run(ref, bytes, bytes.byteLength, Date.now());
    const stored = Number(result.changes) > 0;
    if (stored) this.#statsCache = null;
    return { ref, size: bytes.byteLength, stored };
  }

  /**
   * Permanently delete every blob stored before `cutoffMs`.
   *
   * This is destructive in a way nothing else here is: the row is the *only* copy
   * of the ciphertext a recipient can fetch — the chain holds a reference, not the
   * payload. A recipient offline longer than the TTL loses those messages for good.
   * That is why retention is opt-in (`RELAY_BLOB_TTL_DAYS=0` keeps everything) and
   * why the caller logs every sweep that removes anything.
   *
   * @returns how many blobs were removed.
   */
  pruneBlobs(cutoffMs: number): number {
    const result = this.#prepare('DELETE FROM blobs WHERE created_at < ?').run(cutoffMs);
    const removed = Number(result.changes);
    if (removed > 0) {
      this.#statsCache = null;
      // Deleted pages live in the WAL until a checkpoint moves them out; without
      // this a prune frees no disk at all, which is the entire point of the knob.
      this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    }
    return removed;
  }

  getBlob(ref: string): StoredBlob | null {
    const row = this.#prepare('SELECT ref, bytes, size FROM blobs WHERE ref = ?').get(ref);
    if (row === undefined) return null;
    return {
      ref: readHex(row, 'ref'),
      bytes: readBytes(row, 'bytes'),
      size: readInt(row, 'size'),
    };
  }

  hasBlob(ref: string): boolean {
    return this.#prepare('SELECT 1 AS ok FROM blobs WHERE ref = ?').get(ref) !== undefined;
  }

  countBlobs(): number {
    const row = this.#prepare('SELECT COUNT(*) AS n FROM blobs').get();
    return row === undefined ? 0 : readInt(row, 'n');
  }

  // ── drops ────────────────────────────────────────────────────────────────

  /**
   * Insert or replace a drop keyed by its on-chain `seq`.
   *
   * Upsert rather than insert-ignore: after a reorg the same `seq` can legitimately
   * resolve to a different transaction, and the canonical chain must win.
   */
  upsertDrop(drop: DropRow): void {
    this.#prepare(
      `INSERT INTO drops (seq, convo_id, poster, eph_pub, blob_ref, view_tag, size, timestamp, tx_hash, block_number)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(seq) DO UPDATE SET
         convo_id     = excluded.convo_id,
         poster       = excluded.poster,
         eph_pub      = excluded.eph_pub,
         blob_ref     = excluded.blob_ref,
         view_tag     = excluded.view_tag,
         size         = excluded.size,
         timestamp    = excluded.timestamp,
         tx_hash      = excluded.tx_hash,
         block_number = excluded.block_number`,
    ).run(
      drop.seq,
      drop.convoId,
      drop.poster,
      drop.ephPub,
      drop.blobRef,
      drop.viewTag,
      drop.size,
      drop.timestamp,
      drop.txHash,
      drop.blockNumber,
    );
    this.#statsCache = null;
  }

  /** Run `fn` inside a single transaction, rolling back if it throws. */
  transaction<T>(fn: () => T): T {
    this.#db.exec('BEGIN');
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        // A failed rollback means the transaction was already unwound; the
        // original error below is the one that matters.
      }
      throw error;
    }
  }

  /** Drops with `seq > since`, oldest first. */
  listDrops(since: number, limit: number): DropRow[] {
    const rows = this.#prepare(
      'SELECT * FROM drops WHERE seq > ? ORDER BY seq ASC LIMIT ?',
    ).all(since, limit);
    return rows.map(toDropRow);
  }

  /** Drops in one conversation with `seq > since`, oldest first. */
  listDropsByConvo(convoId: string, since: number, limit: number): DropRow[] {
    const rows = this.#prepare(
      'SELECT * FROM drops WHERE convo_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
    ).all(convoId, since, limit);
    return rows.map(toDropRow);
  }

  getDrop(seq: number): DropRow | null {
    const row = this.#prepare('SELECT * FROM drops WHERE seq = ?').get(seq);
    return row === undefined ? null : toDropRow(row);
  }

  /** Highest indexed `seq`, or 0 when the log is empty. */
  head(): number {
    const row = this.#prepare('SELECT COALESCE(MAX(seq), 0) AS head FROM drops').get();
    return row === undefined ? 0 : readInt(row, 'head');
  }

  countDrops(): number {
    const row = this.#prepare('SELECT COUNT(*) AS n FROM drops').get();
    return row === undefined ? 0 : readInt(row, 'n');
  }

  // ── cursor ───────────────────────────────────────────────────────────────

  /** Last fully-scanned block, or `null` if the indexer has never run. */
  getCursor(): number | null {
    const row = this.#prepare('SELECT last_block FROM cursor WHERE id = ?').get(CURSOR_ID);
    return row === undefined ? null : readInt(row, 'last_block');
  }

  setCursor(lastBlock: number): void {
    if (!Number.isSafeInteger(lastBlock) || lastBlock < 0) {
      throw new DbError(`cursor must be a non-negative safe integer (got ${lastBlock})`);
    }
    this.#prepare(
      'INSERT INTO cursor (id, last_block) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET last_block = excluded.last_block',
    ).run(CURSOR_ID, lastBlock);
    this.#statsCache = null;
  }

  // ── aggregate ────────────────────────────────────────────────────────────

  /**
   * Aggregate counters for `/v1/stats` and the websocket stats frame.
   *
   * Memoised: this is the one query here that scans, it is reachable
   * unauthenticated, and `node:sqlite` is synchronous — so every millisecond it
   * spends freezes HTTP, the fan-out and the indexer alike. Writes invalidate the
   * memo, so a cached answer is only ever stale with respect to a *concurrent*
   * writer, never with respect to this caller's own writes.
   */
  stats(): RelayStats {
    const cached = this.#statsCache;
    if (cached !== null && Date.now() - cached.at < STATS_TTL_MS) return cached.value;

    const row = this.#prepare(
      `SELECT
         (SELECT COALESCE(MAX(seq), 0)      FROM drops) AS head,
         (SELECT COUNT(*)                   FROM drops) AS total_drops,
         (SELECT COUNT(*)                   FROM blobs) AS total_blobs,
         (SELECT COUNT(DISTINCT poster)     FROM drops) AS unique_posters`,
    ).get();
    if (row === undefined) {
      throw new DbError('stats query returned no row');
    }
    const value: RelayStats = {
      head: readInt(row, 'head'),
      totalDrops: readInt(row, 'total_drops'),
      totalBlobs: readInt(row, 'total_blobs'),
      uniquePosters: readInt(row, 'unique_posters'),
      indexedBlock: this.getCursor() ?? 0,
    };
    this.#statsCache = { at: Date.now(), value };
    return value;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#statsCache = null;
    this.#statements.clear();
    this.#db.close();
  }
}
