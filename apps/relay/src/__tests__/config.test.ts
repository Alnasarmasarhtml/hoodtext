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
    expect(config.dropsRateLimitMax).toBe(240);
    expect(config.blobReadRateLimitMax).toBe(600);
    expect(config.statsRateLimitMax).toBe(30);
    expect(config.healthRateLimitMax).toBe(120);
    expect(config.streamRateLimitMax).toBe(30);
    expect(config.readRateLimitWindow).toBe('1 minute');
    // Trust nothing and retain everything unless an operator says otherwise.
    expect(config.trustProxyHops).toBe(0);
    expect(config.blobTtlDays).toBe(0);
    expect(config.reorgDepth).toBe(32n);
    expect(config.statsBroadcastMs).toBe(10_000);
    expect(config.webOrigins).toEqual(['http://localhost:3000']);
  });

  it('resolves a relative db path under apps/relay and keeps :memory: literal', () => {
    expect(loadConfig({}).dbPath.replace(/\\/g, '/')).toMatch(/apps\/relay\/data\/hoodgram\.db$/);
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
      WEB_ORIGIN: 'https://hoodgram.xyz, http://localhost:3000',
    });

    expect(config.port).toBe(9_001);
    expect(config.chainId).toBe(4_663);
    expect(config.anchorsAddress).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(config.startBlock).toBe(123_456n);
    expect(config.webOrigins).toEqual(['https://hoodgram.xyz', 'http://localhost:3000']);
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

  it('reads the retention and proxy knobs the example env ships', () => {
    // `.env.example` ships RELAY_BLOB_TTL_DAYS=0, and the knob was previously
    // absent from the schema — parsed and dropped on the floor.
    expect(loadConfig({ RELAY_BLOB_TTL_DAYS: '0' }).blobTtlDays).toBe(0);
    expect(loadConfig({ RELAY_BLOB_TTL_DAYS: '30' }).blobTtlDays).toBe(30);
    expect(loadConfig({ RELAY_TRUST_PROXY: '1' }).trustProxyHops).toBe(1);

    expect(() => loadConfig({ RELAY_BLOB_TTL_DAYS: '-1' })).toThrow(ConfigError);
    expect(() => loadConfig({ RELAY_BLOB_TTL_DAYS: 'forever' })).toThrow(ConfigError);
    expect(() => loadConfig({ RELAY_TRUST_PROXY: 'true' })).toThrow(ConfigError);
  });

  it('reads each read-route limit from its own key', () => {
    const config = loadConfig({
      RELAY_DROPS_RATE_MAX: '10',
      RELAY_BLOB_READ_RATE_MAX: '11',
      RELAY_STATS_RATE_MAX: '12',
      RELAY_HEALTH_RATE_MAX: '13',
      RELAY_STREAM_RATE_MAX: '14',
      RELAY_STREAM_MAX_CLIENTS: '15',
    });

    expect(config.dropsRateLimitMax).toBe(10);
    expect(config.blobReadRateLimitMax).toBe(11);
    expect(config.statsRateLimitMax).toBe(12);
    expect(config.healthRateLimitMax).toBe(13);
    expect(config.streamRateLimitMax).toBe(14);
    expect(config.streamMaxClients).toBe(15);
  });

  it('applies overrides last', () => {
    const config = loadConfig({ RELAY_PORT: '9001' }, { port: 1234, indexerEnabled: false });

    expect(config.port).toBe(1_234);
    expect(config.indexerEnabled).toBe(false);
  });
});
