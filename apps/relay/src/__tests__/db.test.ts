import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RelayDb, blobRefOf } from '../db.js';
import { hex20, hex32, makeDrop } from './helpers.js';

describe('RelayDb', () => {
  let db: RelayDb;

  beforeEach(() => {
    db = RelayDb.open(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('addresses blobs by sha256 of their bytes', () => {
    const bytes = randomBytes(512);
    const expected = `0x${createHash('sha256').update(bytes).digest('hex')}`;

    expect(blobRefOf(bytes)).toBe(expected);
    expect(db.putBlob(bytes).ref).toBe(expected);
  });

  it('treats a repeat store as an idempotent no-op', () => {
    const bytes = randomBytes(64);

    const first = db.putBlob(bytes);
    const second = db.putBlob(bytes);

    expect(first.stored).toBe(true);
    expect(second.stored).toBe(false);
    expect(second.ref).toBe(first.ref);
    expect(db.countBlobs()).toBe(1);
  });

  it('round-trips blob bytes exactly', () => {
    const bytes = randomBytes(4_000);
    const { ref } = db.putBlob(bytes);

    const stored = db.getBlob(ref);
    expect(stored).not.toBeNull();
    expect(stored?.size).toBe(4_000);
    expect(Buffer.compare(Buffer.from(stored?.bytes ?? new Uint8Array()), bytes)).toBe(0);
  });

  it('reports a missing blob as null, never throwing', () => {
    expect(db.getBlob(hex32(7))).toBeNull();
    expect(db.hasBlob(hex32(7))).toBe(false);
  });

  it('upserts a drop by seq so a reorg replaces rather than duplicates', () => {
    db.upsertDrop(makeDrop(1, { txHash: hex32(0x11), blockNumber: 500 }));
    db.upsertDrop(makeDrop(1, { txHash: hex32(0x22), blockNumber: 501 }));

    expect(db.countDrops()).toBe(1);
    expect(db.getDrop(1)?.txHash).toBe(hex32(0x22));
    expect(db.getDrop(1)?.blockNumber).toBe(501);
  });

  it('pages drops strictly after `since`, oldest first', () => {
    for (let seq = 1; seq <= 5; seq += 1) db.upsertDrop(makeDrop(seq));

    expect(db.listDrops(0, 100).map((drop) => drop.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(db.listDrops(2, 100).map((drop) => drop.seq)).toEqual([3, 4, 5]);
    expect(db.listDrops(0, 2).map((drop) => drop.seq)).toEqual([1, 2]);
    expect(db.listDrops(5, 100)).toEqual([]);
    expect(db.head()).toBe(5);
  });

  it('filters by conversation', () => {
    db.upsertDrop(makeDrop(1, { convoId: hex32(0xa) }));
    db.upsertDrop(makeDrop(2, { convoId: hex32(0xb) }));
    db.upsertDrop(makeDrop(3, { convoId: hex32(0xa) }));

    expect(db.listDropsByConvo(hex32(0xa), 0, 100).map((drop) => drop.seq)).toEqual([1, 3]);
    expect(db.listDropsByConvo(hex32(0xb), 0, 100).map((drop) => drop.seq)).toEqual([2]);
    expect(db.listDropsByConvo(hex32(0xc), 0, 100)).toEqual([]);
  });

  it('starts with no cursor and persists one', () => {
    expect(db.getCursor()).toBeNull();

    db.setCursor(100);
    expect(db.getCursor()).toBe(100);

    db.setCursor(250);
    expect(db.getCursor()).toBe(250);
    expect(db.stats().indexedBlock).toBe(250);
  });

  it('rejects an impossible cursor', () => {
    expect(() => db.setCursor(-1)).toThrow(/non-negative/);
    expect(() => db.setCursor(1.5)).toThrow(/non-negative/);
  });

  it('aggregates stats across drops and blobs', () => {
    db.upsertDrop(makeDrop(1, { poster: hex20(1) }));
    db.upsertDrop(makeDrop(2, { poster: hex20(2) }));
    db.upsertDrop(makeDrop(3, { poster: hex20(2) }));
    db.putBlob(Buffer.from('a', 'utf8'));

    expect(db.stats()).toEqual({
      head: 3,
      totalDrops: 3,
      totalBlobs: 1,
      uniquePosters: 2,
      indexedBlock: 0,
    });
  });

  it('rolls a failed transaction back', () => {
    expect(() =>
      db.transaction(() => {
        db.upsertDrop(makeDrop(1));
        throw new Error('boom');
      }),
    ).toThrow('boom');

    expect(db.countDrops()).toBe(0);
  });

  it('commits a successful transaction', () => {
    db.transaction(() => {
      db.upsertDrop(makeDrop(1));
      db.upsertDrop(makeDrop(2));
    });

    expect(db.countDrops()).toBe(2);
  });

  it('memoises stats and drops the memo on every write', () => {
    db.upsertDrop(makeDrop(1));

    const first = db.stats();
    // Identity, not equality: a second call inside the TTL must not re-run the
    // scan that `/v1/stats` and the 10s broadcast both go through.
    expect(db.stats()).toBe(first);

    db.upsertDrop(makeDrop(2));
    const afterDrop = db.stats();
    expect(afterDrop).not.toBe(first);
    expect(afterDrop.totalDrops).toBe(2);

    db.putBlob(Buffer.from('invalidate', 'utf8'));
    expect(db.stats().totalBlobs).toBe(1);

    db.setCursor(77);
    expect(db.stats().indexedBlock).toBe(77);
  });

  it('prunes only blobs older than the cutoff', () => {
    const kept = db.putBlob(Buffer.from('recent', 'utf8')).ref;

    // Nothing is older than a cutoff in the past.
    expect(db.pruneBlobs(Date.now() - 60_000)).toBe(0);
    expect(db.countBlobs()).toBe(1);

    // A cutoff in the future sweeps everything stored so far.
    expect(db.pruneBlobs(Date.now() + 60_000)).toBe(1);
    expect(db.countBlobs()).toBe(0);
    expect(db.getBlob(kept)).toBeNull();
    expect(db.stats().totalBlobs).toBe(0);
  });

  it('is safe to close twice', () => {
    db.close();
    expect(() => db.close()).not.toThrow();
    expect(db.closed).toBe(true);
  });
});

describe('RelayDb on disk', () => {
  let dir: string;
  let db: RelayDb;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relay-db-'));
    db = RelayDb.open(join(dir, 'relay.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('journals in WAL so a reader never blocks the indexer mid-write', () => {
    expect(db.journalMode()).toBe('wal');
  });

  it('checkpoints after a prune so the deleted pages actually leave the file', () => {
    db.putBlob(randomBytes(256_000));
    expect(db.countBlobs()).toBe(1);

    expect(db.pruneBlobs(Date.now() + 60_000)).toBe(1);
    expect(db.countBlobs()).toBe(0);
    // A prune that leaves the WAL untouched frees no disk at all.
    expect(statSync(join(dir, 'relay.db-wal')).size).toBe(0);
  });
});
