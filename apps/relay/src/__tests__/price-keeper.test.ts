import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { PriceKeeper, usdPriceToRate, type PricePorts } from '../price-keeper.js';

const SOURCE = '0xaa164d5e19f2eeeca56af3cbbe677533e962f109';
const TOKEN = '0x24dac33de87dbff11a7b1cbf02db4b0668c5e3d6';
const CURVE = '0x4efef103a10c912e2b6468f8db65b99179c28a6c';
const KEY = `0x${'11'.repeat(32)}` as const;

const silentLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  fatal: () => undefined,
  child: () => silentLog,
  level: 'silent',
} as never;

function keeperWith(
  ports: Partial<PricePorts>,
  env: Record<string, string> = {},
): { keeper: PriceKeeper; setRate: ReturnType<typeof vi.fn> } {
  const setRate = vi.fn(async () => '0xabc' as `0x${string}`);
  const full: PricePorts = {
    fetchDexScreenerUsd: async () => null,
    fetchEthUsd: async () => ({ usd: 2000, source: 'coinbase' }),
    readRate: async () => 1000n * 10n ** 18n,
    readCurveReserves: async () => null,
    setRate,
    ...ports,
  };
  const config = loadConfig({
    PRICE_KEEPER: '1',
    PRICE_SOURCE_ADDRESS: SOURCE,
    PRICE_TOKEN_ADDRESS: TOKEN,
    PRICE_CURVE_ADDRESS: CURVE,
    ...env,
  } as NodeJS.ProcessEnv);
  return { keeper: new PriceKeeper({ config, log: silentLog, ports: full }), setRate };
}

describe('usdPriceToRate', () => {
  it('converts a micro-cap price without losing precision', () => {
    // $0.00000325 per token → ~307,692 tokens per USD
    const rate = usdPriceToRate(0.00000325);
    expect(rate / 10n ** 18n).toBe(307_692n);
  });

  it('converts an ordinary price', () => {
    expect(usdPriceToRate(2) / 10n ** 18n).toBe(0n); // 0.5 tokens/USD < 1
    expect(usdPriceToRate(0.5) / 10n ** 18n).toBe(2n);
  });
});

describe('PriceKeeper.tick', () => {
  it('writes when DexScreener answers and drift is large', async () => {
    const { keeper, setRate } = keeperWith({
      fetchDexScreenerUsd: async () => 0.00000325,
    });
    await keeper.tick();
    expect(setRate).toHaveBeenCalledTimes(1);
    const written = setRate.mock.calls[0]?.[0] as bigint;
    expect(written / 10n ** 18n).toBe(307_692n);
    expect(keeper.status().strategy).toBe('dexscreener');
    expect(keeper.status().lastError).toBeNull();
  });

  it('falls back to the curve when no DEX pair exists', async () => {
    const { keeper, setRate } = keeperWith({
      fetchDexScreenerUsd: async () => null,
      // 1.6884 ETH quote / 995M tokens, ETH at $1914.775 → ≈ $3.25e-6
      readCurveReserves: async () => ({
        quote: 1_688_447_370_320_562_823n,
        token: 994_996_959_651_185_909_773_307_150n,
        graduated: false,
      }),
      fetchEthUsd: async () => ({ usd: 1914.775, source: 'coinbase' }),
    });
    await keeper.tick();
    expect(setRate).toHaveBeenCalledTimes(1);
    const written = setRate.mock.calls[0]?.[0] as bigint;
    const tokensPerUsd = written / 10n ** 18n;
    expect(tokensPerUsd).toBeGreaterThan(300_000n);
    expect(tokensPerUsd).toBeLessThan(320_000n);
    expect(keeper.status().strategy).toBe('curve');
  });

  it('holds within the drift threshold instead of burning gas', async () => {
    const { keeper, setRate } = keeperWith({
      fetchDexScreenerUsd: async () => 0.001, // → exactly 1000 tokens/USD
      readRate: async () => 1000n * 10n ** 18n, // on-chain already there
    });
    await keeper.tick();
    expect(setRate).not.toHaveBeenCalled();
    expect(keeper.status().lastError).toBeNull();
  });

  it('REJECTS an out-of-bounds rate rather than clamping it', async () => {
    const { keeper, setRate } = keeperWith(
      { fetchDexScreenerUsd: async () => 1e-18 }, // absurd: 1e18 tokens per USD
    );
    await keeper.tick();
    expect(setRate).not.toHaveBeenCalled();
    expect(keeper.status().lastError).toContain('outside');
  });

  it('goes manual-hold with a flagged error when nothing answers', async () => {
    const { keeper, setRate } = keeperWith({
      fetchDexScreenerUsd: async () => null,
      readCurveReserves: async () => null,
    });
    await keeper.tick();
    expect(setRate).not.toHaveBeenCalled();
    expect(keeper.status().strategy).toBe('manual-hold');
    expect(keeper.status().lastError).toContain('no market source');
  });

  it('treats a graduated curve as no source', async () => {
    const { keeper, setRate } = keeperWith({
      readCurveReserves: async () => ({ quote: 1n, token: 1n, graduated: true }),
    });
    await keeper.tick();
    expect(setRate).not.toHaveBeenCalled();
    expect(keeper.status().strategy).toBe('manual-hold');
  });

  it('a fixed rate short-circuits every fetch', async () => {
    const dex = vi.fn(async () => 0.5);
    const { keeper, setRate } = keeperWith(
      { fetchDexScreenerUsd: dex },
      { PRICE_FIXED_RATE: (5000n * 10n ** 18n).toString() },
    );
    await keeper.tick();
    expect(dex).not.toHaveBeenCalled();
    expect(setRate).toHaveBeenCalledWith(5000n * 10n ** 18n);
    expect(keeper.status().strategy).toBe('fixed');
  });

  it('an RPC failure keeps the last rate and records the error', async () => {
    const { keeper, setRate } = keeperWith({
      readRate: async () => {
        throw new Error('rpc down');
      },
    });
    await keeper.tick();
    expect(setRate).not.toHaveBeenCalled();
    expect(keeper.status().lastError).toContain('rpc down');
  });
});

describe('config', () => {
  it('boots with the keeper off and no price keys', () => {
    const config = loadConfig({} as NodeJS.ProcessEnv);
    expect(config.priceKeeperEnabled).toBe(false);
    expect(config.priceSourceAddress).toBeNull();
    expect(config.priceFixedRate).toBeNull();
    expect(config.pricePollMs).toBe(60_000);
    expect(config.priceDriftBps).toBe(100);
  });

  it('rejects a malformed price source address', () => {
    expect(() =>
      loadConfig({ PRICE_SOURCE_ADDRESS: 'not-an-address' } as NodeJS.ProcessEnv),
    ).toThrow(/PRICE_SOURCE_ADDRESS/);
  });

  it('parses the full keeper environment', () => {
    const config = loadConfig({
      PRICE_KEEPER: '1',
      PRICE_SOURCE_ADDRESS: SOURCE,
      PRICE_TOKEN_ADDRESS: TOKEN,
      PRICE_CURVE_ADDRESS: CURVE,
      PRICE_POLL_MS: '30000',
      PRICE_DRIFT_BPS: '50',
      PRICE_MIN_RATE: '1000000000000000000',
      PRICE_MAX_RATE: '1000000000000000000000000000000',
      RELAYER_PRIVATE_KEY: KEY,
    } as NodeJS.ProcessEnv);
    expect(config.priceKeeperEnabled).toBe(true);
    expect(config.priceSourceAddress).toBe(SOURCE);
    expect(config.pricePollMs).toBe(30_000);
    expect(config.priceDriftBps).toBe(50);
  });
});

describe('per-tick step bound', () => {
  it('allows the bootstrap correction, then rejects a 4x jump', async () => {
    let marketUsd = 0.00000325;
    const { keeper, setRate } = keeperWith({
      fetchDexScreenerUsd: async () => marketUsd,
    });
    // First write: placeholder 1000/USD → ~307,692/USD. A giant, legitimate step.
    await keeper.tick();
    expect(setRate).toHaveBeenCalledTimes(1);

    // Feed goes insane (100x price collapse → 100x rate jump): must be refused.
    marketUsd = marketUsd / 100;
    await keeper.tick();
    expect(setRate).toHaveBeenCalledTimes(1);
    expect(keeper.status().lastError).toContain('4x');
  });
});
