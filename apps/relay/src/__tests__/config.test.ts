import { describe, expect, it } from 'vitest';
import { ConfigError, MAX_BLOB_BYTES, loadConfig } from '../config.js';

describe('loadConfig', () => {
  it('boots with a completely empty environment', () => {
    const config = loadConfig({});

    expect(config.port).toBe(8787);
    expect(config.host).toBe('0.0.0.0');
    expect(config.chainId).toBe(31_337);
    expect(config.rpcUrl).toBe('http://127.0.0.1:8545');
    expect(config.anchorsAddress).toBeNull();
    expect(config.startBlock).toBe(0n);
    expect(config.indexerEnabled).toBe(true);
    expect(config.maxBlobBytes).toBe(MAX_BLOB_BYTES);
    expect(config.blobRateLimitMax).toBe(60);
    expect(config.reorgDepth).toBe(32n);
    expect(config.statsBroadcastMs).toBe(10_000);
    expect(config.webOrigins).toEqual(['http://localhost:3000']);
  });

  it('resolves a relative db path under apps/relay and keeps :memory: literal', () => {
    expect(loadConfig({}).dbPath.replace(/\\/g, '/')).toMatch(/apps\/relay\/data\/telehood\.db$/);
    expect(loadConfig({ RELAY_DB_PATH: ':memory:' }).dbPath).toBe(':memory:');
    expect(loadConfig({ RELAY_DB_PATH: '/tmp/relay.db' }).dbPath).toBe('/tmp/relay.db');
  });

  it('treats a blank value exactly like an absent one', () => {
    const config = loadConfig({ ANCHORS_ADDRESS: '', RELAY_PORT: '   ', START_BLOCK: '' });

    expect(config.anchorsAddress).toBeNull();
    expect(config.port).toBe(8787);
    expect(config.startBlock).toBe(0n);
  });

  it('parses the real environment shape', () => {
    const config = loadConfig({
      RELAY_PORT: '9001',
      RPC_URL: 'https://rpc.mainnet.chain.robinhood.com/',
      CHAIN_ID: '4663',
      ANCHORS_ADDRESS: '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa',
      START_BLOCK: '123456',
      WEB_ORIGIN: 'https://telehood.xyz, http://localhost:3000',
    });

    expect(config.port).toBe(9_001);
    expect(config.chainId).toBe(4_663);
    expect(config.anchorsAddress).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(config.startBlock).toBe(123_456n);
    expect(config.webOrigins).toEqual(['https://telehood.xyz', 'http://localhost:3000']);
  });

  it('understands every spelling of the indexer switch', () => {
    for (const off of ['0', 'false', 'no', 'off', 'FALSE']) {
      expect(loadConfig({ RELAY_INDEXER: off }).indexerEnabled, off).toBe(false);
    }
    for (const on of ['1', 'true', 'yes', 'on', 'TRUE']) {
      expect(loadConfig({ RELAY_INDEXER: on }).indexerEnabled, on).toBe(true);
    }
  });

  it('fails loudly on a malformed value rather than silently defaulting', () => {
    expect(() => loadConfig({ RELAY_PORT: 'abc' })).toThrow(ConfigError);
    expect(() => loadConfig({ CHAIN_ID: '-1' })).toThrow(ConfigError);
    expect(() => loadConfig({ ANCHORS_ADDRESS: '0x1234' })).toThrow(ConfigError);
    expect(() => loadConfig({ START_BLOCK: '-5' })).toThrow(ConfigError);
    expect(() => loadConfig({ RPC_URL: 'not-a-url' })).toThrow(ConfigError);
    expect(() => loadConfig({ RELAY_INDEXER: 'maybe' })).toThrow(ConfigError);
  });

  it('reports which key was wrong', () => {
    try {
      loadConfig({ RELAY_PORT: 'abc' });
      expect.unreachable('expected a ConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues.join(' ')).toContain('RELAY_PORT');
    }
  });

  it('applies overrides last', () => {
    const config = loadConfig({ RELAY_PORT: '9001' }, { port: 1234, indexerEnabled: false });

    expect(config.port).toBe(1_234);
    expect(config.indexerEnabled).toBe(false);
  });
});
