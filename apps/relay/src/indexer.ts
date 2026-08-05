/**
 * Chain watcher (SPEC §6).
 *
 * Two mechanisms, one cursor:
 *
 *  1. A chunked backfill from `START_BLOCK` (or from `cursor - 32` on boot, so a
 *     shallow reorg is re-scanned and upserted away). The cursor is persisted
 *     after every chunk, so a restart resumes where it left off.
 *  2. viem `watchContractEvent` on `Anchors.Dropped` for low-latency delivery of
 *     new anchors to the websocket.
 *
 * The indexer is strictly best-effort: it owns no part of the HTTP request path.
 * If the RPC is unreachable, every error is logged, `connected` flips false,
 * `/v1/health` reports the growing lag, and the loop retries with exponential
 * backoff. It never throws into the process.
 */

import type { FastifyBaseLogger } from 'fastify';
import { createPublicClient, defineChain, http, type Chain } from 'viem';
import { ANCHORS_ABI, DROPPED_EVENT, DROPPED_EVENT_NAME } from './abi.js';
import type { RelayConfig } from './config.js';
import type { DropRow, RelayDb } from './db.js';

export interface IndexerStatus {
  /** False when disabled by config or when no `Anchors` address is configured. */
  readonly enabled: boolean;
  readonly running: boolean;
  /** True after a successful RPC round-trip, false after a failure. */
  readonly connected: boolean;
  readonly watching: boolean;
  readonly chainId: number;
  readonly headBlock: number;
  readonly indexedBlock: number;
  readonly lagBlocks: number;
  readonly lastError: string | null;
  readonly lastErrorAt: number | null;
}

export interface IndexerOptions {
  readonly db: RelayDb;
  readonly config: RelayConfig;
  readonly log: FastifyBaseLogger;
  /** Called once per newly ingested anchor, after it is committed. */
  readonly onDrop?: (drop: DropRow) => void;
}

/** The shape of a `Dropped` log the indexer needs, from `getLogs` or the watcher. */
export interface RawDroppedLog {
  readonly args: unknown;
  readonly blockNumber: bigint | null;
  readonly transactionHash: `0x${string}` | null;
}

const MAX_BACKOFF_MS = 30_000;
const NEVER_SCANNED = -1n;
const HEX_32 = /^0x[0-9a-fA-F]{64}$/;
const HEX_20 = /^0x[0-9a-fA-F]{40}$/;

function clampToSafeNumber(value: bigint): number {
  if (value <= 0n) return 0;
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  return Number(value > max ? max : value);
}

function toUint(value: unknown, max: number): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 && value <= max ? value : null;
  }
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(max)) return null;
    return Number(value);
  }
  return null;
}

function toHex(value: unknown, pattern: RegExp): `0x${string}` | null {
  if (typeof value !== 'string' || !pattern.test(value)) return null;
  return value.toLowerCase() as `0x${string}`;
}

function createChain(config: RelayConfig): Chain {
  return defineChain({
    id: config.chainId,
    name: `chain-${config.chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });
}

function createClient(config: RelayConfig) {
  return createPublicClient({
    chain: createChain(config),
    transport: http(config.rpcUrl, {
      timeout: config.rpcTimeoutMs,
      retryCount: 1,
      retryDelay: 250,
    }),
    pollingInterval: config.pollIntervalMs,
  });
}

type RelayPublicClient = ReturnType<typeof createClient>;

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export class Indexer {
  readonly #db: RelayDb;
  readonly #config: RelayConfig;
  readonly #log: FastifyBaseLogger;
  readonly #onDrop: ((drop: DropRow) => void) | undefined;
  readonly #address: `0x${string}` | null;
  readonly #enabled: boolean;

  #client: RelayPublicClient | null = null;
  #timer: NodeJS.Timeout | null = null;
  #unwatch: (() => void) | null = null;
  #inflight: Promise<void> = Promise.resolve();

  #running = false;
  #connected = false;
  #bootScanDone = false;
  #chainIdChecked = false;
  #failures = 0;
  #headBlock = 0n;
  #indexedBlock: bigint;
  #lastError: string | null = null;
  #lastErrorAt: number | null = null;

  constructor(options: IndexerOptions) {
    this.#db = options.db;
    this.#config = options.config;
    this.#log = options.log;
    this.#onDrop = options.onDrop;
    this.#address = options.config.anchorsAddress;
    this.#enabled = options.config.indexerEnabled && this.#address !== null;

    const cursor = this.#db.getCursor();
    this.#indexedBlock = cursor === null ? NEVER_SCANNED : BigInt(cursor);
  }

  /** Begin polling. Idempotent; a no-op when disabled. */
  start(): void {
    if (this.#running) return;
    if (!this.#enabled) {
      if (!this.#config.indexerEnabled) {
        this.#log.info('indexer disabled by config');
      } else {
        this.#log.warn('indexer idle: ANCHORS_ADDRESS is not configured');
      }
      return;
    }
    this.#client = createClient(this.#config);
    this.#running = true;
    this.#log.info(
      {
        address: this.#address,
        rpcUrl: this.#config.rpcUrl,
        chainId: this.#config.chainId,
        startBlock: this.#config.startBlock.toString(),
        cursor: this.#indexedBlock === NEVER_SCANNED ? null : this.#indexedBlock.toString(),
      },
      'indexer starting',
    );
    this.#inflight = this.#tick();
  }

  /** Stop polling and release every timer and subscription. Safe to call twice. */
  async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#stopWatcher();
    await this.#inflight;
    this.#client = null;
  }

  status(): IndexerStatus {
    const indexed = this.#indexedBlock < 0n ? 0n : this.#indexedBlock;
    const head = this.#headBlock > indexed ? this.#headBlock : indexed;
    return {
      enabled: this.#enabled,
      running: this.#running,
      connected: this.#connected,
      watching: this.#unwatch !== null,
      chainId: this.#config.chainId,
      headBlock: clampToSafeNumber(head),
      indexedBlock: clampToSafeNumber(indexed),
      lagBlocks: clampToSafeNumber(head - indexed),
      lastError: this.#lastError,
      lastErrorAt: this.#lastErrorAt,
    };
  }

  // ── polling loop ─────────────────────────────────────────────────────────

  async #tick(): Promise<void> {
    if (!this.#running) return;
    let delay = this.#config.pollIntervalMs;
    try {
      await this.#syncOnce();
      this.#failures = 0;
      this.#connected = true;
    } catch (error) {
      this.#connected = false;
      this.#failures += 1;
      this.#recordError(error, 'indexer sync failed; will retry');
      // The watcher shares the transport, so assume it died too and let the
      // next successful sync re-arm it.
      this.#stopWatcher();
      delay = this.#backoffDelay();
    }
    this.#schedule(delay);
  }

  #schedule(delay: number): void {
    if (!this.#running) return;
    const timer = setTimeout(() => {
      this.#inflight = this.#tick();
    }, delay);
    timer.unref();
    this.#timer = timer;
  }

  #backoffDelay(): number {
    const exponent = Math.min(this.#failures, 8);
    const base = Math.min(this.#config.pollIntervalMs * 2 ** exponent, MAX_BACKOFF_MS);
    // Jitter so a fleet of relays does not stampede a recovering RPC.
    return Math.round(base * (0.75 + Math.random() * 0.5));
  }

  async #syncOnce(): Promise<void> {
    const client = this.#client;
    if (client === null) return;

    const head = await client.getBlockNumber({ cacheTime: 0 });
    this.#headBlock = head;

    if (!this.#chainIdChecked) {
      this.#chainIdChecked = true;
      const actual = await client.getChainId();
      if (actual !== this.#config.chainId) {
        this.#log.warn(
          { expected: this.#config.chainId, actual },
          'indexer: RPC chain id does not match CHAIN_ID',
        );
      }
    }

    const from = this.#nextFromBlock();
    if (from <= head) {
      await this.#scanRange(client, from, head);
    } else if (!this.#bootScanDone) {
      this.#bootScanDone = true;
    }

    this.#startWatcher(client);
  }

  /**
   * Where the next scan begins. On the first pass after boot we deliberately
   * rewind by `reorgDepth` blocks: anything that changed under us is re-read and
   * upserted over the stale row.
   */
  #nextFromBlock(): bigint {
    const start = this.#config.startBlock;
    if (this.#indexedBlock === NEVER_SCANNED) return start;
    const next = this.#indexedBlock + 1n;
    if (this.#bootScanDone) return next;
    const rewound = next - this.#config.reorgDepth;
    return rewound < start ? start : rewound;
  }

  async #scanRange(client: RelayPublicClient, from: bigint, to: bigint): Promise<void> {
    const address = this.#address;
    if (address === null) return;

    let cursor = from;
    while (cursor <= to && this.#running) {
      const end = (() => {
        const candidate = cursor + this.#config.indexChunkSize - 1n;
        return candidate > to ? to : candidate;
      })();

      const logs = await client.getLogs({
        address,
        event: DROPPED_EVENT,
        fromBlock: cursor,
        toBlock: end,
        strict: true,
      });

      const ingested = this.#ingest(logs);
      this.#commitCursor(end);

      if (ingested > 0) {
        this.#log.info(
          { from: cursor.toString(), to: end.toString(), drops: ingested },
          'indexer: batch ingested',
        );
      }
      cursor = end + 1n;
    }
    this.#bootScanDone = true;
  }

  #commitCursor(block: bigint): void {
    const value = clampToSafeNumber(block);
    try {
      this.#db.setCursor(value);
      this.#indexedBlock = block;
    } catch (error) {
      // A cursor write failure must not abort ingestion; the next batch retries.
      this.#recordError(error, 'indexer: failed to persist cursor');
    }
  }

  // ── live watcher ─────────────────────────────────────────────────────────

  #startWatcher(client: RelayPublicClient): void {
    if (this.#unwatch !== null || !this.#running) return;
    const address = this.#address;
    if (address === null) return;

    this.#unwatch = client.watchContractEvent({
      address,
      abi: ANCHORS_ABI,
      eventName: DROPPED_EVENT_NAME,
      strict: true,
      poll: true,
      pollingInterval: this.#config.pollIntervalMs,
      onLogs: (logs: readonly RawDroppedLog[]) => {
        try {
          this.#ingest(logs);
        } catch (error) {
          this.#recordError(error, 'indexer: failed to ingest watched logs');
        }
      },
      onError: (error: Error) => {
        this.#connected = false;
        this.#recordError(error, 'indexer: event watcher error');
        this.#stopWatcher();
      },
    });
  }

  #stopWatcher(): void {
    if (this.#unwatch === null) return;
    const unwatch = this.#unwatch;
    this.#unwatch = null;
    try {
      unwatch();
    } catch (error) {
      this.#log.debug({ err: error }, 'indexer: unwatch threw');
    }
  }

  // ── ingestion ────────────────────────────────────────────────────────────

  #ingest(logs: readonly RawDroppedLog[]): number {
    const rows: DropRow[] = [];
    for (const log of logs) {
      const row = this.#toDropRow(log);
      if (row !== null) rows.push(row);
    }
    if (rows.length === 0) return 0;

    this.#db.transaction(() => {
      for (const row of rows) this.#db.upsertDrop(row);
    });

    const notify = this.#onDrop;
    if (notify !== undefined) {
      for (const row of rows) {
        try {
          notify(row);
        } catch (error) {
          this.#log.warn({ err: error, seq: row.seq }, 'indexer: drop listener threw');
        }
      }
    }
    return rows.length;
  }

  /** Validate a decoded log at runtime. Malformed or pending logs are skipped, not fatal. */
  #toDropRow(log: RawDroppedLog): DropRow | null {
    const { args, blockNumber, transactionHash } = log;
    if (blockNumber === null || transactionHash === null) {
      this.#log.debug('indexer: skipping pending log');
      return null;
    }
    if (typeof args !== 'object' || args === null) {
      this.#log.warn('indexer: skipping log with undecodable args');
      return null;
    }

    const record = args as Record<string, unknown>;
    const seq = toUint(record['seq'], Number.MAX_SAFE_INTEGER);
    const convoId = toHex(record['convoId'], HEX_32);
    const poster = toHex(record['poster'], HEX_20);
    const ephPub = toHex(record['ephPub'], HEX_32);
    const blobRef = toHex(record['blobRef'], HEX_32);
    const viewTag = toUint(record['viewTag'], 0xff);
    const size = toUint(record['size'], 0xffff_ffff);
    const timestamp = toUint(record['timestamp'], Number.MAX_SAFE_INTEGER);
    const txHash = toHex(transactionHash, HEX_32);

    if (
      seq === null ||
      convoId === null ||
      poster === null ||
      ephPub === null ||
      blobRef === null ||
      viewTag === null ||
      size === null ||
      timestamp === null ||
      txHash === null
    ) {
      this.#log.warn({ txHash: transactionHash }, 'indexer: skipping malformed Dropped log');
      return null;
    }

    return {
      seq,
      convoId,
      poster,
      ephPub,
      blobRef,
      viewTag,
      size,
      timestamp,
      txHash,
      blockNumber: clampToSafeNumber(blockNumber),
    };
  }

  #recordError(error: unknown, message: string): void {
    this.#lastError = describeError(error);
    this.#lastErrorAt = Date.now();
    this.#log.error({ err: error, failures: this.#failures }, message);
  }
}
