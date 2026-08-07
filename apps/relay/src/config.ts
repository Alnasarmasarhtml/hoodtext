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
    dropsDefaultLimit: DROPS_DEFAULT_LIMIT,
    dropsMaxLimit: DROPS_MAX_LIMIT,
    statsBroadcastMs: STATS_BROADCAST_MS,
  };

  return { ...base, ...overrides };
}
