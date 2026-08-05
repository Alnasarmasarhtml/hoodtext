import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type RelayConfig } from '../config.js';
import { RelayDb } from '../db.js';
import { Indexer } from '../indexer.js';
import { hex20, newApp, silentLogger, waitFor } from './helpers.js';

function config(overrides: Partial<RelayConfig>): RelayConfig {
  return loadConfig({}, { dbPath: ':memory:', ...overrides });
}

describe('Indexer', () => {
  let db: RelayDb;

  beforeEach(() => {
    db = RelayDb.open(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('is inert when disabled by config', async () => {
    const indexer = new Indexer({
      db,
      config: config({ indexerEnabled: false, anchorsAddress: hex20(1) }),
      log: silentLogger(),
    });

    indexer.start();
    const status = indexer.status();

    expect(status.enabled).toBe(false);
    expect(status.running).toBe(false);
    expect(status.watching).toBe(false);
    expect(status.lagBlocks).toBe(0);
    await indexer.stop();
  });

  it('is inert when no Anchors address is configured', async () => {
    const indexer = new Indexer({
      db,
      config: config({ indexerEnabled: true, anchorsAddress: null }),
      log: silentLogger(),
    });

    indexer.start();

    expect(indexer.status().enabled).toBe(false);
    expect(indexer.status().running).toBe(false);
    await indexer.stop();
  });

  it('reports the persisted cursor as the indexed block', async () => {
    db.setCursor(4_242);
    const indexer = new Indexer({
      db,
      config: config({ indexerEnabled: false }),
      log: silentLogger(),
    });

    expect(indexer.status().indexedBlock).toBe(4_242);
    expect(indexer.status().lagBlocks).toBe(0);
    await indexer.stop();
  });

  it('degrades gracefully when the RPC is unreachable', async () => {
    const indexer = new Indexer({
      db,
      // Port 1 is never listening: this exercises the failure path without a chain.
      config: config({
        indexerEnabled: true,
        anchorsAddress: hex20(9),
        rpcUrl: 'http://127.0.0.1:1',
        rpcTimeoutMs: 250,
        pollIntervalMs: 250,
      }),
      log: silentLogger(),
    });

    indexer.start();
    expect(indexer.status().running).toBe(true);

    await waitFor(() => indexer.status().lastError !== null, 8_000);

    const status = indexer.status();
    expect(status.connected).toBe(false);
    expect(status.lastError).not.toBeNull();
    expect(status.watching).toBe(false);

    await indexer.stop();
    expect(indexer.status().running).toBe(false);
  });

  it('stop() is safe before start and twice in a row', async () => {
    const indexer = new Indexer({
      db,
      config: config({ indexerEnabled: false }),
      log: silentLogger(),
    });

    await indexer.stop();
    await indexer.stop();
    expect(indexer.status().running).toBe(false);
  });
});

describe('relay HTTP with the indexer off', () => {
  it('still serves every read route and reports lag', async () => {
    const app = await newApp();

    const health = await app.inject({ method: 'GET', url: '/v1/health' });
    const stats = await app.inject({ method: 'GET', url: '/v1/stats' });
    const drops = await app.inject({ method: 'GET', url: '/v1/drops' });

    expect(health.statusCode).toBe(200);
    expect(stats.statusCode).toBe(200);
    expect(drops.statusCode).toBe(200);
    expect(app.indexer.status().enabled).toBe(false);

    await app.close();
  });
});
