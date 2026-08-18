/**
 * PriceKeeper — keeps `ManualPriceSource.rate` equal to the live market.
 *
 * The product promise is "$5, paid in $GRAM at the moment's market price".
 * On chain that price is one storage variable, `thoodPerUsd`, that nothing
 * updated until this keeper existed. Every tick it derives the market rate,
 * compares it with the on-chain rate, and writes `setRate` only when the
 * drift crosses a threshold — so a quiet market costs zero gas.
 *
 * Strategy ladder, first source that answers wins:
 *   1. `fixed`       — PRICE_FIXED_RATE set: a manual override, never fetches.
 *   2. `dexscreener` — the token trades on an indexed DEX pair: its USD price.
 *   3. `curve`       — pre-graduation Pons bonding curve: spot = quoteReserve /
 *                      tokenReserve (ETH per token), times ETH-USD from a public
 *                      spot API (Coinbase, falling back to CoinGecko).
 *   4. `manual-hold` — nothing answered: keep the last on-chain rate, flag it.
 *
 * Failure posture is fail-safe throughout: any fetch or RPC error keeps the
 * last written rate and surfaces in `/v1/health` as `price.lastError`; an
 * out-of-bounds target is REJECTED, never clamped and written, because a rate
 * outside the sanity window means a broken feed, not a price.
 */

import type { FastifyBaseLogger } from 'fastify';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseUnits,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { PRICE_SOURCE_ABI, PONS_CURVE_ABI } from './abi.js';
import type { RelayConfig } from './config.js';

/** One ETH-USD answer, plus where it came from (for the status surface). */
interface EthUsd {
  readonly usd: number;
  readonly source: 'coinbase' | 'coingecko';
}

export type PriceStrategy = 'fixed' | 'dexscreener' | 'curve' | 'manual-hold';

export interface PriceKeeperStatus {
  readonly enabled: boolean;
  readonly running: boolean;
  readonly strategy: PriceStrategy | null;
  /** Rate currently on chain, tokens-per-USD 18dp, as a decimal string. */
  readonly onChainRate: string | null;
  /** Rate the last tick derived from the market. */
  readonly targetRate: string | null;
  readonly ethUsd: number | null;
  /** Token price in USD implied by the last derivation. */
  readonly tokenUsd: number | null;
  readonly lastCheckedAt: number | null;
  readonly lastUpdatedAt: number | null;
  readonly lastUpdateTx: string | null;
  readonly lastError: string | null;
  readonly lastErrorAt: number | null;
}

/** Test seam: every external effect the keeper performs. */
export interface PricePorts {
  fetchDexScreenerUsd(token: `0x${string}`): Promise<number | null>;
  fetchEthUsd(): Promise<EthUsd>;
  readRate(): Promise<bigint>;
  readCurveReserves(): Promise<{ quote: bigint; token: bigint; graduated: boolean } | null>;
  setRate(rate: bigint): Promise<`0x${string}`>;
}

interface PriceKeeperDeps {
  readonly config: RelayConfig;
  readonly log: FastifyBaseLogger;
  /** Replaces the live ports in tests. */
  readonly ports?: PricePorts | null;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Builds the live ports from config: real HTTP, real chain. */
function livePorts(config: RelayConfig, log: FastifyBaseLogger): PricePorts | null {
  if (config.priceSourceAddress === null || config.relayerPrivateKey === null) return null;

  const chain = defineChain({
    id: config.chainId,
    name: `chain-${String(config.chainId)}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });
  const transport = http(config.rpcUrl, { timeout: config.rpcTimeoutMs, retryCount: 1 });
  const publicClient: PublicClient = createPublicClient({ chain, transport });
  const account = privateKeyToAccount(config.relayerPrivateKey);
  const walletClient: WalletClient = createWalletClient({ account, chain, transport });
  const priceSource = config.priceSourceAddress;
  const curve = config.priceCurveAddress;

  return {
    async fetchDexScreenerUsd(token) {
      const response = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${token}`,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (!response.ok) throw new Error(`dexscreener http ${String(response.status)}`);
      const body = (await response.json()) as {
        pairs: { priceUsd?: string; liquidity?: { usd?: number } }[] | null;
      };
      if (!Array.isArray(body.pairs) || body.pairs.length === 0) return null;
      const best = [...body.pairs].sort(
        (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0),
      )[0];
      const price = best?.priceUsd === undefined ? NaN : Number(best.priceUsd);
      return Number.isFinite(price) && price > 0 ? price : null;
    },

    async fetchEthUsd() {
      try {
        const response = await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot', {
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`coinbase http ${String(response.status)}`);
        const body = (await response.json()) as { data?: { amount?: string } };
        const usd = Number(body.data?.amount);
        if (!Number.isFinite(usd) || usd <= 0) throw new Error('coinbase malformed');
        return { usd, source: 'coinbase' };
      } catch (error) {
        log.debug({ err: describeError(error) }, 'price: coinbase failed, trying coingecko');
        const response = await fetch(
          'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd',
          { signal: AbortSignal.timeout(10_000) },
        );
        if (!response.ok) throw new Error(`coingecko http ${String(response.status)}`);
        const body = (await response.json()) as { ethereum?: { usd?: number } };
        const usd = body.ethereum?.usd;
        if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) {
          throw new Error('coingecko malformed');
        }
        return { usd, source: 'coingecko' };
      }
    },

    async readRate() {
      return publicClient.readContract({
        address: priceSource,
        abi: PRICE_SOURCE_ABI,
        functionName: 'rate',
      });
    },

    async readCurveReserves() {
      if (curve === null) return null;
      const [graduated, reserves] = await Promise.all([
        publicClient.readContract({ address: curve, abi: PONS_CURVE_ABI, functionName: 'graduated' }),
        publicClient.readContract({ address: curve, abi: PONS_CURVE_ABI, functionName: 'getReserves' }),
      ]);
      return { graduated, quote: reserves[0], token: reserves[1] };
    },

    async setRate(rate) {
      const hash = await walletClient.writeContract({
        address: priceSource,
        abi: PRICE_SOURCE_ABI,
        functionName: 'setRate',
        args: [rate],
        chain,
        account,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') {
        throw new Error(`setRate reverted in ${hash}`);
      }
      return hash;
    },
  };
}

export class PriceKeeper {
  readonly #config: RelayConfig;
  readonly #log: FastifyBaseLogger;
  readonly #ports: PricePorts | null;

  #running = false;
  #timer: NodeJS.Timeout | null = null;
  #ticking: Promise<void> | null = null;

  #strategy: PriceStrategy | null = null;
  #onChainRate: bigint | null = null;
  #targetRate: bigint | null = null;
  #ethUsd: number | null = null;
  #tokenUsd: number | null = null;
  #lastCheckedAt: number | null = null;
  #lastUpdatedAt: number | null = null;
  #lastUpdateTx: string | null = null;
  #lastError: string | null = null;
  #lastErrorAt: number | null = null;

  constructor(deps: PriceKeeperDeps) {
    this.#config = deps.config;
    this.#log = deps.log;
    this.#ports = deps.ports !== undefined ? deps.ports : livePorts(deps.config, deps.log);
  }

  start(): void {
    if (this.#running || this.#ports === null) return;
    this.#running = true;
    this.#log.info(
      {
        priceSource: this.#config.priceSourceAddress,
        token: this.#config.priceTokenAddress,
        curve: this.#config.priceCurveAddress,
        pollMs: this.#config.pricePollMs,
        driftBps: this.#config.priceDriftBps,
      },
      'price keeper: started',
    );
    const loop = (): void => {
      if (!this.#running) return;
      this.#ticking = this.tick().finally(() => {
        this.#ticking = null;
        if (this.#running) {
          this.#timer = setTimeout(loop, this.#config.pricePollMs);
        }
      });
    };
    loop();
  }

  async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.#ticking !== null) await this.#ticking;
  }

  /** One derivation + conditional write. Public so tests can drive it directly. */
  async tick(): Promise<void> {
    const ports = this.#ports;
    if (ports === null) return;
    this.#lastCheckedAt = Date.now();
    try {
      this.#onChainRate = await ports.readRate();

      const target = await this.#deriveTarget(ports);
      if (target === null) {
        this.#strategy = 'manual-hold';
        this.#targetRate = null;
        this.#fail('no market source available; holding the last on-chain rate');
        return;
      }
      this.#targetRate = target;

      if (target < this.#config.priceMinRate || target > this.#config.priceMaxRate) {
        this.#fail(
          `derived rate ${target.toString()} is outside [${this.#config.priceMinRate.toString()}, ${this.#config.priceMaxRate.toString()}]; refusing to write`,
        );
        return;
      }

      const current = this.#onChainRate;
      const driftBps = current === 0n ? 10_000n : ((target > current ? target - current : current - target) * 10_000n) / current;
      if (driftBps < BigInt(this.#config.priceDriftBps)) {
        this.#lastError = null;
        return; // quiet market: nothing to write
      }

      const hash = await ports.setRate(target);
      this.#onChainRate = target;
      this.#lastUpdatedAt = Date.now();
      this.#lastUpdateTx = hash;
      this.#lastError = null;
      this.#log.info(
        { rate: target.toString(), driftBps: driftBps.toString(), tx: hash, strategy: this.#strategy },
        'price keeper: rate updated',
      );
    } catch (error) {
      this.#fail(describeError(error));
    }
  }

  /** Derives the tokens-per-USD target via the strategy ladder. `null` = no source. */
  async #deriveTarget(ports: PricePorts): Promise<bigint | null> {
    if (this.#config.priceFixedRate !== null) {
      this.#strategy = 'fixed';
      this.#tokenUsd = null;
      this.#ethUsd = null;
      return this.#config.priceFixedRate;
    }

    const token = this.#config.priceTokenAddress;
    if (token !== null) {
      const usd = await ports.fetchDexScreenerUsd(token).catch((error: unknown) => {
        this.#log.debug({ err: describeError(error) }, 'price: dexscreener failed');
        return null;
      });
      if (usd !== null) {
        this.#strategy = 'dexscreener';
        this.#tokenUsd = usd;
        this.#ethUsd = null;
        return usdPriceToRate(usd);
      }
    }

    const reserves = await ports.readCurveReserves();
    if (reserves !== null && !reserves.graduated && reserves.token > 0n && reserves.quote > 0n) {
      const { usd: ethUsd } = await ports.fetchEthUsd();
      this.#ethUsd = ethUsd;
      // spot ETH per token = quote/token; USD per token = that × ethUsd.
      const ethPerTokenE18 = (reserves.quote * 10n ** 18n) / reserves.token;
      const usdPerToken = (Number(ethPerTokenE18) / 1e18) * ethUsd;
      if (!Number.isFinite(usdPerToken) || usdPerToken <= 0) return null;
      this.#strategy = 'curve';
      this.#tokenUsd = usdPerToken;
      return usdPriceToRate(usdPerToken);
    }

    return null;
  }

  #fail(message: string): void {
    this.#lastError = message;
    this.#lastErrorAt = Date.now();
    this.#log.warn({ err: message }, 'price keeper: tick failed');
  }

  status(): PriceKeeperStatus {
    return {
      enabled: this.#config.priceKeeperEnabled && this.#ports !== null,
      running: this.#running,
      strategy: this.#strategy,
      onChainRate: this.#onChainRate?.toString() ?? null,
      targetRate: this.#targetRate?.toString() ?? null,
      ethUsd: this.#ethUsd,
      tokenUsd: this.#tokenUsd,
      lastCheckedAt: this.#lastCheckedAt,
      lastUpdatedAt: this.#lastUpdatedAt,
      lastUpdateTx: this.#lastUpdateTx,
      lastError: this.#lastError,
      lastErrorAt: this.#lastErrorAt,
    };
  }
}

/**
 * USD-per-token → tokens-per-USD, 18dp.
 *
 * Goes through `parseUnits` on the decimal string so precision survives the
 * tiny prices a fresh launch trades at (3.2e-6 USD → ~3.1e5 tokens/USD).
 */
export function usdPriceToRate(usdPerToken: number): bigint {
  const priceE18 = parseUnits(usdPerToken.toFixed(18), 18);
  if (priceE18 === 0n) return 0n;
  return (10n ** 36n) / priceE18;
}
