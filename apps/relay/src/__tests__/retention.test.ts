/**
 * Blob retention (`RELAY_BLOB_TTL_DAYS`).
 *
 * The sweep runs on an hourly interval, so these tests fake only `setInterval` /
 * `clearInterval` — everything else, including the database, is real.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BLOB_PRUNE_INTERVAL_MS } from '../config.js';
import { newApp } from './helpers.js';

const DAY_MS = 86_400_000;

describe('blob retention sweep', () => {
  let app: FastifyInstance | null = null;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });

  afterEach(async () => {
    if (app !== null) await app.close();
    app = null;
    vi.useRealTimers();
  });

  it('sweeps on the hour with a cutoff of exactly the configured TTL', async () => {
    app = await newApp({ blobTtlDays: 2 });
    const prune = vi.spyOn(app.db, 'pruneBlobs');

    const before = Date.now();
    vi.advanceTimersByTime(BLOB_PRUNE_INTERVAL_MS);

    expect(prune).toHaveBeenCalledTimes(1);
    const cutoff = prune.mock.calls[0]?.[0] ?? 0;
    expect(cutoff).toBeGreaterThanOrEqual(before - 2 * DAY_MS);
    expect(cutoff).toBeLessThanOrEqual(Date.now() - 2 * DAY_MS);

    vi.advanceTimersByTime(BLOB_PRUNE_INTERVAL_MS * 2);
    expect(prune).toHaveBeenCalledTimes(3);
  });

  it('never touches stored blobs at the shipped default of 0 days', async () => {
    // 0 means "keep forever": the timer must not even be armed, because deleting
    // a blob destroys the only fetchable copy of that ciphertext.
    app = await newApp();
    const prune = vi.spyOn(app.db, 'pruneBlobs');

    vi.advanceTimersByTime(BLOB_PRUNE_INTERVAL_MS * 24);

    expect(prune).not.toHaveBeenCalled();
  });

  it('leaves a blob younger than the TTL in place', async () => {
    app = await newApp({ blobTtlDays: 1 });
    const stored = app.db.putBlob(Buffer.from('fresh ciphertext', 'utf8'));

    vi.advanceTimersByTime(BLOB_PRUNE_INTERVAL_MS);

    expect(app.db.countBlobs()).toBe(1);
    expect(app.db.getBlob(stored.ref)).not.toBeNull();
  });

  it('stops sweeping once the relay closes', async () => {
    const instance = await newApp({ blobTtlDays: 1 });
    const prune = vi.spyOn(instance.db, 'pruneBlobs');
    await instance.close();

    vi.advanceTimersByTime(BLOB_PRUNE_INTERVAL_MS * 3);

    // A sweep against a closed handle would throw inside a timer callback.
    expect(prune).not.toHaveBeenCalled();
  });
});
