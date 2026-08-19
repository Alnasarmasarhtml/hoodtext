/**
 * Relay configuration.
 *
 * Every value has a default, so `loadConfig()` succeeds with a completely empty
 * environment — the relay boots with no `.env` at all (SPEC §6). Values that are
 * present but malformed are a hard failure: a typo in `RELAY_PORT` must not be
 * silently swallowed into a default.
 */

import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Hard ceiling on a single stored blob: the largest media bucket (4 MiB) plus the
 * 41-byte media envelope overhead (version + nonce + MAC). Text envelopes are far
 * smaller; this ceiling exists for encrypted media attachments (SPEC §6).
 */
export const MAX_BLOB_BYTES = 4_194_345;

/** Default cadence of the send pipeline's on-chain batch flush. */
export const SEND_FLUSH_MS = 1_500;

/** Default cap on drops waiting in the send queue. */
export const SEND_QUEUE_MAX = 512;

/** Blocks re-scanned on boot so a shallow reorg is absorbed by upserts (SPEC §6). */
export const REORG_DEPTH = 32;

/** Cadence of the `{ type: 'stats' }` websocket broadcast (SPEC §6). */
export const STATS_BROADCAST_MS = 10_000;

/** Default page size for `/v1/drops`. */
export const DROPS_DEFAULT_LIMIT = 200;

/** Absolute ceiling on a `/v1/drops` page. */
export const DROPS_MAX_LIMIT = 1000;

/**
 * Read-route rate limits, per IP per minute.
 *
 * Each number is sized against what the real web client does in its worst honest
 * minute — a cold start — and then left there, so the ceiling a scraper hits is
 * the same one an aggressive first sync never reaches.
 */

/**
 * `/v1/drops` and `/v1/drops/convo/:convoId`. The client backfills in pages of
 * 200 (`apps/web` BACKFILL_LIMIT) in a tight loop, so 240 pages/min lets a cold
 * client pull 48k drops in its first minute and still caps a scraper at that.
 */
export const DROPS_RATE_MAX = 240;

/**
 * `/v1/blob/:ref`. One fetch per candidate drop — and a member joining a busy
 * room fetches one per historical message — so this has to clear a cold sync,
 * not just steady state. Shaped by bandwidth rather than CPU (a stored row reads
 * in well under a millisecond); the ciphertext itself is worthless to a scraper.
 */
export const BLOB_READ_RATE_MAX = 600;

/**
 * `/v1/stats`. Nothing legitimate polls it faster than the 10s websocket
 * broadcast that carries the same numbers; 30/min is 5× that cadence.
 */
export const STATS_RATE_MAX = 30;

/** `/v1/health`. Uptime monitors poll on a 1–5s cadence; 120/min covers 2s. */
export const HEALTH_RATE_MAX = 120;

/**
 * `WS /v1/stream` *handshakes*. A client opens one socket and holds it; even a
 * pathological reconnect backoff needs a handful per minute. This bounds upgrade
 * churn only — concurrent sockets are bounded separately by `streamMaxClients`.
 */
export const STREAM_RATE_MAX = 30;

/** Hard cap on simultaneously connected `/v1/stream` subscribers. */
export const STREAM_MAX_CLIENTS = 2_000;

/**
 * Hard ceiling on one sealed call-signalling frame.
 *
 * The largest real frame is an SDP offer, which seals into the 4096-byte bucket
 * (about 4.2 KB on the wire, base64 to ~5.6 KB). 8 KB leaves headroom without
 * letting the lane carry anything message-sized.
 */
export const SIGNAL_MAX_BYTES = 8_192;

/** How often the blob retention sweep runs when `RELAY_BLOB_TTL_DAYS > 0`. */
export const BLOB_PRUNE_INTERVAL_MS = 3_600_000;

/** `apps/relay` — this file lives at `<pkg>/src/config.ts` (or `<pkg>/dist/config.js`). */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface RelayConfig {
  /** TCP port for `index.ts`. Tests use `.inject()` and never bind. */
  readonly port: number;
  readonly host: string;
  /** Absolute path to the SQLite file, or the literal `':memory:'`. */
  readonly dbPath: string;
  readonly logLevel: LogLevel;
  /** Allowed CORS origins. `['*']` means "any origin". */
  readonly webOrigins: readonly string[];
  readonly rpcUrl: string;
  readonly chainId: number;
  /** `Anchors` deployment. Without it the indexer has nothing to watch. */
  readonly anchorsAddress: `0x${string}` | null;
  /** `Activation` deployment, read by the send pipeline. */
  readonly activationAddress: `0x${string}` | null;
  /** `GroupRegistry` deployment, read by the send pipeline for room rent. */
  readonly groupRegistryAddress: `0x${string}` | null;
  /** `KeyRegistry` deployment, read by the send pipeline for identity keys. */
  readonly keyRegistryAddress: `0x${string}` | null;
  /** Master switch for the market-price keeper. Off unless explicitly enabled. */
  readonly priceKeeperEnabled: boolean;
  /** `ManualPriceSource` deployment the keeper writes. `null` disables it. */
  readonly priceSourceAddress: `0x${string}` | null;
  /** The payment token, for DexScreener lookups. */
  readonly priceTokenAddress: `0x${string}` | null;
  /** Pre-graduation bonding curve to read spot reserves from. */
  readonly priceCurveAddress: `0x${string}` | null;
  /** Keeper tick cadence. */
  readonly pricePollMs: number;
  /** Minimum drift, in basis points, before a setRate is worth its gas. */
  readonly priceDriftBps: number;
  /** Sanity window: a derived rate outside it is rejected, never written. */
  readonly priceMinRate: bigint;
  readonly priceMaxRate: bigint;
  /** Manual override: when set the keeper writes exactly this rate. */
  readonly priceFixedRate: bigint | null;
  /** Cloudflare Realtime TURN key id. `null` disables voice calls. */
  readonly turnKeyId: string | null;
  /** Cloudflare Realtime TURN API token. Never leaves the relay. */
  readonly turnApiToken: string | null;
  /** Lifetime of a minted TURN credential, in seconds. */
  readonly turnTtlSeconds: number;
  /** Per-IP-per-window ceiling on call signalling. */
  readonly signalRateLimitMax: number;
  /** Hard cap on one sealed signalling frame, in bytes. */
  readonly signalMaxBytes: number;
  /** Funded key for `Anchors.postBatch`. `null` disables gasless send. */
  readonly relayerPrivateKey: `0x${string}` | null;
  readonly sendFlushMs: number;
  readonly sendQueueMax: number;
  readonly startBlock: bigint;
  /** Master switch — off in tests so no chain is required. */
  readonly indexerEnabled: boolean;
  readonly indexChunkSize: bigint;
  readonly reorgDepth: bigint;
  readonly pollIntervalMs: number;
  readonly rpcTimeoutMs: number;
  readonly maxBlobBytes: number;
  readonly blobRateLimitMax: number;
  readonly blobRateLimitWindow: string;
  /** Per-IP-per-window ceiling on `/v1/drops` and `/v1/drops/convo/:convoId`. */
  readonly dropsRateLimitMax: number;
  /** Per-IP-per-window ceiling on `GET /v1/blob/:ref`. */
  readonly blobReadRateLimitMax: number;
  /** Per-IP-per-window ceiling on `GET /v1/stats`. */
  readonly statsRateLimitMax: number;
  /** Per-IP-per-window ceiling on `GET /v1/health`. */
  readonly healthRateLimitMax: number;
  /** Per-IP-per-window ceiling on `WS /v1/stream` *handshakes*. */
  readonly streamRateLimitMax: number;
  /** Window shared by every read-route limit. */
  readonly readRateLimitWindow: string;
  /** Hard cap on concurrent `/v1/stream` subscribers. */
  readonly streamMaxClients: number;
  /**
   * Reverse-proxy hops to trust when deriving the client IP. `0` trusts nothing
   * — the only safe posture for a directly-exposed relay, because every rate
   * limit here is keyed on that IP.
   */
  readonly trustProxyHops: number;
  /**
   * Days a stored blob is retained. `0` means "keep forever" and disables the
   * prune entirely — matching what `.env.example` ships and what the relay has
   * always done.
   */
  readonly blobTtlDays: number;
  readonly dropsDefaultLimit: number;
  readonly dropsMaxLimit: number;
  readonly statsBroadcastMs: number;
}

/** Thrown when the environment is present but invalid. Never thrown for absent values. */
export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`invalid relay configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off']);

const booleanish = (defaultValue: boolean) =>
  z.preprocess((raw) => {
    if (raw === undefined) return defaultValue;
    if (typeof raw === 'boolean') return raw;
    const token = String(raw).trim().toLowerCase();
    if (TRUTHY.has(token)) return true;
    if (FALSY.has(token)) return false;
    return raw;
  }, z.boolean());

const uintString = (defaultValue: string) =>
  z
    .string()
    .regex(/^\d+$/, 'must be a non-negative integer')
    .default(defaultValue);

const EnvSchema = z.object({
  RELAY_PORT: z.coerce.number().int().min(0).max(65535).default(8787),
  RELAY_HOST: z.string().min(1).default('0.0.0.0'),
  RELAY_DB_PATH: z.string().min(1).default('./data/hoodgram.db'),
  RELAY_LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  WEB_ORIGIN: z.string().min(1).default('http://localhost:3000'),
  RPC_URL: z.string().url().default('http://127.0.0.1:8545'),
  CHAIN_ID: z.coerce.number().int().positive().default(31337),
  ANCHORS_ADDRESS: z.string().regex(HEX_ADDRESS, 'must be a 20-byte hex address').optional(),
  ACTIVATION_ADDRESS: z.string().regex(HEX_ADDRESS, 'must be a 20-byte hex address').optional(),
  GROUP_REGISTRY_ADDRESS: z.string().regex(HEX_ADDRESS, 'must be a 20-byte hex address').optional(),
  KEY_REGISTRY_ADDRESS: z.string().regex(HEX_ADDRESS, 'must be a 20-byte hex address').optional(),
  RELAYER_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 32-byte hex private key')
    .optional(),
  RELAY_SEND_FLUSH_MS: z.coerce.number().int().min(100).max(60_000).default(SEND_FLUSH_MS),
  RELAY_SEND_QUEUE_MAX: z.coerce.number().int().min(1).max(100_000).default(SEND_QUEUE_MAX),
  START_BLOCK: uintString('0'),
  RELAY_INDEXER: booleanish(true),
  RELAY_INDEX_CHUNK: z.coerce.number().int().min(1).max(100_000).default(2_000),
  RELAY_POLL_MS: z.coerce.number().int().min(250).max(600_000).default(4_000),
  RELAY_RPC_TIMEOUT_MS: z.coerce.number().int().min(250).max(600_000).default(10_000),
  RELAY_BLOB_RATE_MAX: z.coerce.number().int().min(1).max(100_000).default(60),
  RELAY_DROPS_RATE_MAX: z.coerce.number().int().min(1).max(100_000).default(DROPS_RATE_MAX),
  RELAY_BLOB_READ_RATE_MAX: z.coerce.number().int().min(1).max(100_000).default(BLOB_READ_RATE_MAX),
  RELAY_STATS_RATE_MAX: z.coerce.number().int().min(1).max(100_000).default(STATS_RATE_MAX),
  RELAY_HEALTH_RATE_MAX: z.coerce.number().int().min(1).max(100_000).default(HEALTH_RATE_MAX),
  RELAY_STREAM_RATE_MAX: z.coerce.number().int().min(1).max(100_000).default(STREAM_RATE_MAX),
  RELAY_STREAM_MAX_CLIENTS: z.coerce.number().int().min(1).max(1_000_000).default(STREAM_MAX_CLIENTS),
  // Number of reverse-proxy hops in front of this relay, not a boolean: trusting
  // *any* X-Forwarded-For makes every per-IP limit spoofable with one header.
  RELAY_TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
  // 0 = retain forever. Any positive value permanently deletes ciphertext that
  // has been stored longer than that; see `RelayConfig.blobTtlDays`.
  RELAY_BLOB_TTL_DAYS: z.coerce.number().int().min(0).max(3650).default(0),
  // ── market-price keeper ────────────────────────────────────────────────────
  PRICE_KEEPER: booleanish(false),
  PRICE_SOURCE_ADDRESS: z.string().regex(HEX_ADDRESS, 'must be a 20-byte hex address').optional(),
  PRICE_TOKEN_ADDRESS: z.string().regex(HEX_ADDRESS, 'must be a 20-byte hex address').optional(),
  PRICE_CURVE_ADDRESS: z.string().regex(HEX_ADDRESS, 'must be a 20-byte hex address').optional(),
  PRICE_POLL_MS: z.coerce.number().int().min(5_000).max(3_600_000).default(60_000),
  PRICE_DRIFT_BPS: z.coerce.number().int().min(1).max(5_000).default(100),
  // Sanity window, tokens-per-USD in wei (18dp). Defaults span 1 token/USD to
  // 1e12 tokens/USD — generous, but a broken feed lands well outside it.
  PRICE_MIN_RATE: uintString('1000000000000000000'),
  PRICE_MAX_RATE: uintString('1000000000000000000000000000000'),
  PRICE_FIXED_RATE: z.string().regex(/^\d+$/, 'must be a non-negative integer').optional(),
  // ── voice calls ────────────────────────────────────────────────────────────
  TURN_KEY_ID: z.string().min(1).optional(),
  TURN_API_TOKEN: z.string().min(1).optional(),
  // Short by design: a credential the browser holds should outlive the call it
  // was minted for and nothing more.
  TURN_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3_600),
  // Signalling is chatty in bursts (offer, answer, a few ICE frames, hangup)
  // and then silent. 240/min per IP clears a dozen calls a minute and still
  // bounds anyone trying to use the lane as a free message bus.
  SIGNAL_RATE_MAX: z.coerce.number().int().min(1).max(100_000).default(240),
});

const ENV_KEYS = Object.keys(EnvSchema.shape) as readonly (keyof typeof EnvSchema.shape)[];

/**
 * Copy only the keys we care about, mapping blank strings to `undefined` so that
 * a committed `.env` with `ANCHORS_ADDRESS=` behaves exactly like an absent key.
 */
function collect(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ENV_KEYS) {
    const value = env[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    out[key] = trimmed;
  }
  return out;
}

/** `:memory:` stays literal; anything else becomes an absolute path under `apps/relay`. */
function resolveDbPath(raw: string): string {
  if (raw === ':memory:' || raw.startsWith('file:')) return raw;
  return isAbsolute(raw) ? raw : resolve(PACKAGE_ROOT, raw);
}

function parseOrigins(raw: string): readonly string[] {
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts : ['http://localhost:3000'];
}

/**
 * Parse the environment into a fully-resolved {@link RelayConfig}.
 *
 * @param env - environment to read; defaults to `process.env`.
 * @param overrides - applied last, used by tests to force an in-memory DB and
 *   disable the indexer.
 * @throws {ConfigError} when a present value is malformed.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<RelayConfig> = {},
): RelayConfig {
  const parsed = EnvSchema.safeParse(collect(env));
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new ConfigError(issues);
  }

  const raw = parsed.data;
  const base: RelayConfig = {
    port: raw.RELAY_PORT,
    host: raw.RELAY_HOST,
    dbPath: resolveDbPath(raw.RELAY_DB_PATH),
    logLevel: raw.RELAY_LOG_LEVEL,
    webOrigins: parseOrigins(raw.WEB_ORIGIN),
    rpcUrl: raw.RPC_URL,
    chainId: raw.CHAIN_ID,
    anchorsAddress:
      raw.ANCHORS_ADDRESS === undefined
        ? null
        : (raw.ANCHORS_ADDRESS.toLowerCase() as `0x${string}`),
    activationAddress:
      raw.ACTIVATION_ADDRESS === undefined
        ? null
        : (raw.ACTIVATION_ADDRESS.toLowerCase() as `0x${string}`),
    groupRegistryAddress:
      raw.GROUP_REGISTRY_ADDRESS === undefined
        ? null
        : (raw.GROUP_REGISTRY_ADDRESS.toLowerCase() as `0x${string}`),
    keyRegistryAddress:
      raw.KEY_REGISTRY_ADDRESS === undefined
        ? null
        : (raw.KEY_REGISTRY_ADDRESS.toLowerCase() as `0x${string}`),
    priceKeeperEnabled: raw.PRICE_KEEPER,
    priceSourceAddress:
      raw.PRICE_SOURCE_ADDRESS === undefined
        ? null
        : (raw.PRICE_SOURCE_ADDRESS.toLowerCase() as `0x${string}`),
    priceTokenAddress:
      raw.PRICE_TOKEN_ADDRESS === undefined
        ? null
        : (raw.PRICE_TOKEN_ADDRESS.toLowerCase() as `0x${string}`),
    priceCurveAddress:
      raw.PRICE_CURVE_ADDRESS === undefined
        ? null
        : (raw.PRICE_CURVE_ADDRESS.toLowerCase() as `0x${string}`),
    pricePollMs: raw.PRICE_POLL_MS,
    priceDriftBps: raw.PRICE_DRIFT_BPS,
    priceMinRate: BigInt(raw.PRICE_MIN_RATE),
    priceMaxRate: BigInt(raw.PRICE_MAX_RATE),
    priceFixedRate: raw.PRICE_FIXED_RATE === undefined ? null : BigInt(raw.PRICE_FIXED_RATE),
    turnKeyId: raw.TURN_KEY_ID ?? null,
    turnApiToken: raw.TURN_API_TOKEN ?? null,
    turnTtlSeconds: raw.TURN_TTL_SECONDS,
    signalRateLimitMax: raw.SIGNAL_RATE_MAX,
    signalMaxBytes: SIGNAL_MAX_BYTES,
    relayerPrivateKey:
      raw.RELAYER_PRIVATE_KEY === undefined ? null : (raw.RELAYER_PRIVATE_KEY as `0x${string}`),
    sendFlushMs: raw.RELAY_SEND_FLUSH_MS,
    sendQueueMax: raw.RELAY_SEND_QUEUE_MAX,
    startBlock: BigInt(raw.START_BLOCK),
    indexerEnabled: raw.RELAY_INDEXER,
    indexChunkSize: BigInt(raw.RELAY_INDEX_CHUNK),
    reorgDepth: BigInt(REORG_DEPTH),
    pollIntervalMs: raw.RELAY_POLL_MS,
    rpcTimeoutMs: raw.RELAY_RPC_TIMEOUT_MS,
    maxBlobBytes: MAX_BLOB_BYTES,
    blobRateLimitMax: raw.RELAY_BLOB_RATE_MAX,
    blobRateLimitWindow: '1 minute',
    dropsRateLimitMax: raw.RELAY_DROPS_RATE_MAX,
    blobReadRateLimitMax: raw.RELAY_BLOB_READ_RATE_MAX,
    statsRateLimitMax: raw.RELAY_STATS_RATE_MAX,
    healthRateLimitMax: raw.RELAY_HEALTH_RATE_MAX,
    streamRateLimitMax: raw.RELAY_STREAM_RATE_MAX,
    readRateLimitWindow: '1 minute',
    streamMaxClients: raw.RELAY_STREAM_MAX_CLIENTS,
    trustProxyHops: raw.RELAY_TRUST_PROXY,
    blobTtlDays: raw.RELAY_BLOB_TTL_DAYS,
    dropsDefaultLimit: DROPS_DEFAULT_LIMIT,
    dropsMaxLimit: DROPS_MAX_LIMIT,
    statsBroadcastMs: STATS_BROADCAST_MS,
  };

  return { ...base, ...overrides };
}
