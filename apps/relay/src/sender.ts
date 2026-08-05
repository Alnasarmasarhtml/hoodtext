/**
 * The gasless send pipeline.
 *
 * A sender uploads their sealed blob, then POSTs the drop plus a detached Ed25519
 * signature to `/v1/send`. This module verifies — signature against the sender's
 * registered identity key, activation, and room rent — then queues the drop and
 * batch-posts it on chain from the relay's own funded key (`Anchors.postBatch`).
 *
 * What the sender gets: no wallet popup, no gas, and their address never appears
 * on chain. What the chain still enforces: room rent, per drop, even in a batch.
 *
 * Trust, stated honestly: a relayed drop is vouched for by this relay. The relay
 * cannot read message contents (it only ever holds ciphertext) and cannot forge a
 * sender's signature, but it could refuse to post (censorship) — which is why
 * self-posting via `Anchors.post` always remains open to every activated account.
 */

import { verifyDrop, type SignableDrop } from '@telehood/crypto';
import { hexToBytes } from 'viem';
import type { FastifyBaseLogger } from 'fastify';

/** On-chain reads the pipeline needs, injectable so tests run without a chain. */
export interface ChainGate {
  /** The sender's registered Ed25519 public key, or `null` when unregistered. */
  ed25519KeyOf(sender: `0x${string}`): Promise<`0x${string}` | null>;
  /** Whether the sender has paid the one-time activation. */
  isActivated(sender: `0x${string}`): Promise<boolean>;
  /** Whether the room exists and its rent is current. */
  isRoomActive(groupId: `0x${string}`): Promise<boolean>;
}

/** The on-chain writer, injectable so tests run without a chain. */
export interface BatchPoster {
  /** Posts up to 64 drops in one `postBatch` transaction; resolves to the tx hash. */
  post(drops: readonly SignableDrop[]): Promise<`0x${string}`>;
}

/** Machine-readable rejection reasons for `/v1/send`. */
export type SendRejection =
  | 'unknown_key'
  | 'bad_signature'
  | 'not_activated'
  | 'room_inactive'
  | 'queue_full';

export type SubmitResult =
  | { readonly ok: true; readonly queued: number }
  | { readonly ok: false; readonly code: SendRejection; readonly message: string };

export interface SendPipelineOptions {
  readonly gate: ChainGate;
  /** `null` disables the pipeline (no relayer key configured). */
  readonly poster: BatchPoster | null;
  readonly log: FastifyBaseLogger;
  /** How often the queue is flushed on chain. */
  readonly flushMs: number;
  /** Hard cap on queued drops; submissions beyond it are rejected. */
  readonly queueMax: number;
  /** Drops older than this are evicted rather than retried forever. */
  readonly staleMs?: number;
}

/** `Anchors.MAX_BATCH` — the most drops one transaction may carry. */
export const MAX_BATCH = 64;

const ZERO_CONVO = `0x${'0'.repeat(64)}`;
const INITIAL_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 30_000;
const DEFAULT_STALE_MS = 300_000;

interface Pending {
  readonly drop: SignableDrop;
  readonly sender: `0x${string}`;
  readonly enqueuedAt: number;
}

/**
 * Verifies, queues and batch-posts relayed drops.
 *
 * One instance per relay process. `start()` arms the flush timer; `stop()` clears
 * it. `flushNow()` is exposed for tests and for a final drain on shutdown.
 */
export class SendPipeline {
  private readonly gate: ChainGate;
  private readonly poster: BatchPoster | null;
  private readonly log: FastifyBaseLogger;
  private readonly flushMs: number;
  private readonly queueMax: number;
  private readonly staleMs: number;

  private queue: Pending[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;
  private backoffUntil = 0;
  private backoffMs = INITIAL_BACKOFF_MS;

  constructor(options: SendPipelineOptions) {
    this.gate = options.gate;
    this.poster = options.poster;
    this.log = options.log;
    this.flushMs = options.flushMs;
    this.queueMax = options.queueMax;
    this.staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  }

  /** Whether a relayer key is configured and the pipeline can post. */
  enabled(): boolean {
    return this.poster !== null;
  }

  /** Drops currently waiting for the next batch. */
  size(): number {
    return this.queue.length;
  }

  /** Arms the periodic flush. No-op when the pipeline is disabled. */
  start(): void {
    if (this.poster === null || this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.flushNow();
    }, this.flushMs);
    this.timer.unref();
  }

  /** Clears the flush timer and attempts one final drain. */
  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flushNow();
  }

  /**
   * Verifies one submission end-to-end and queues it.
   *
   * Order matters and is deliberate: identity first (cheapest to fake, cheapest
   * to check), then activation, then room rent, then capacity — so an attacker
   * without a valid signature learns nothing about queue state.
   */
  async submit(
    sender: `0x${string}`,
    drop: SignableDrop,
    signature: `0x${string}`,
  ): Promise<SubmitResult> {
    const ed25519Hex = await this.gate.ed25519KeyOf(sender);
    if (ed25519Hex === null) {
      return {
        ok: false,
        code: 'unknown_key',
        message: 'sender has no registered identity key; call KeyRegistry.register first',
      };
    }

    const verified = await verifyDrop(drop, signature, hexToBytes(ed25519Hex));
    if (!verified) {
      return {
        ok: false,
        code: 'bad_signature',
        message: 'signature does not match the drop and the registered identity key',
      };
    }

    if (!(await this.gate.isActivated(sender))) {
      return {
        ok: false,
        code: 'not_activated',
        message: 'sender has not activated an account ($5, one time)',
      };
    }

    if (drop.convoId !== ZERO_CONVO && !(await this.gate.isRoomActive(drop.convoId))) {
      return {
        ok: false,
        code: 'room_inactive',
        message: 'the room does not exist or its rent has lapsed',
      };
    }

    if (this.queue.length >= this.queueMax) {
      return {
        ok: false,
        code: 'queue_full',
        message: 'the relay is saturated; retry shortly or self-post via Anchors.post',
      };
    }

    this.queue.push({ drop, sender, enqueuedAt: Date.now() });
    return { ok: true, queued: this.queue.length };
  }

  /**
   * Posts one batch if any drops are queued and the backoff window has passed.
   * Serialised: overlapping calls return immediately rather than double-posting.
   */
  async flushNow(): Promise<void> {
    if (this.poster === null || this.flushing) return;
    if (this.queue.length === 0) return;
    if (Date.now() < this.backoffUntil) return;

    this.flushing = true;
    try {
      this.evictStale();
      if (this.queue.length === 0) return;

      const batch = this.queue.slice(0, MAX_BATCH);
      const rest = this.queue.slice(MAX_BATCH);

      try {
        const txHash = await this.poster.post(batch.map((pending) => pending.drop));
        this.queue = rest;
        this.backoffMs = INITIAL_BACKOFF_MS;
        this.backoffUntil = 0;
        this.log.info({ drops: batch.length, txHash }, 'relayed batch anchored');
      } catch (error) {
        // The batch stays at the head of the queue and the next attempts back off.
        this.backoffUntil = Date.now() + this.backoffMs;
        this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
        this.log.error({ err: error, drops: batch.length }, 'relayed batch failed; will retry');
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Evicts drops that have waited longer than `staleMs`, logging each eviction. */
  private evictStale(): void {
    const cutoff = Date.now() - this.staleMs;
    const fresh = this.queue.filter((pending) => pending.enqueuedAt >= cutoff);
    const evicted = this.queue.length - fresh.length;
    if (evicted > 0) {
      this.log.warn({ evicted }, 'evicted stale relayed drops that could not be posted in time');
      this.queue = fresh;
    }
  }
}
