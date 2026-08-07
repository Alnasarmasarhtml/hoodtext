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

import { verifyDrop, type SignableDrop } from '@hoodgram/crypto';
import { hexToBytes } from 'viem';
import type { FastifyBaseLogger } from 'fastify';

/** On-chain reads the pipeline needs, injectable so tests run without a chain. */
export interface ChainGate {
  /** The sender's registered Ed25519 public key, or `null` when unregistered. */
  ed25519KeyOf(sender: `0x${string}`): Promise<`0x${string}` | null>;
  /** Whether the sender has paid the one-time activation. */
  isActivated(sender: `0x${string}`): Promise<boolean>;
  /**
   * Whether the room exists and its rent is current.
   *
   * @param options - `{ fresh: true }` forbids answering from cache. Admission
   *   control reads through the cache (a stale "yes" only costs a retry now that
   *   {@link SendPipeline} isolates poison drops), but blaming a *specific* drop
   *   for a reverted batch must never be done against a cached value.
   */
  isRoomActive(groupId: `0x${string}`, options?: { readonly fresh?: boolean }): Promise<boolean>;
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

/**
 * Why a drop the relay had already *accepted* was ultimately abandoned.
 *
 * - `room_inactive` — the room's rent lapsed between acceptance and anchoring, so
 *   `Anchors.postBatch` will revert on it forever. The chain is right; the drop is
 *   genuinely unpostable.
 * - `expired` — the drop sat in the queue past `staleMs` without ever reaching the
 *   chain (a prolonged RPC or relayer-funding outage).
 */
export type SendFailureReason = 'room_inactive' | 'expired';

/** A drop that was answered with HTTP 200 and then never anchored. */
export interface SendFailure {
  readonly blobRef: `0x${string}`;
  readonly convoId: `0x${string}`;
  readonly sender: `0x${string}`;
  readonly reason: SendFailureReason;
  readonly failedAt: number;
}

/** Queue state of a submitted drop, as served by `GET /v1/send/:blobRef`. */
export type SendStatus =
  | { readonly status: 'queued' }
  | { readonly status: 'failed'; readonly failure: SendFailure }
  | { readonly status: 'unknown' };

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
  /** How many recent {@link SendFailure} records stay queryable. */
  readonly failureLogMax?: number;
}

/** `Anchors.MAX_BATCH` — the most drops one transaction may carry. */
export const MAX_BATCH = 64;

const ZERO_CONVO = `0x${'0'.repeat(64)}`;
const INITIAL_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 30_000;
const DEFAULT_STALE_MS = 300_000;
/** Recent post-acceptance failures kept queryable. Bounded so this cannot grow. */
const DEFAULT_FAILURE_LOG_MAX = 512;

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
  private readonly failureLogMax: number;

  private queue: Pending[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;
  private backoffUntil = 0;
  private backoffMs = INITIAL_BACKOFF_MS;
  /** Bounded ring of abandoned drops, oldest first. */
  private failed: SendFailure[] = [];
  private failedTotal = 0;

  constructor(options: SendPipelineOptions) {
    this.gate = options.gate;
    this.poster = options.poster;
    this.log = options.log;
    this.flushMs = options.flushMs;
    this.queueMax = options.queueMax;
    this.staleMs = options.staleMs ?? DEFAULT_STALE_MS;
    this.failureLogMax = options.failureLogMax ?? DEFAULT_FAILURE_LOG_MAX;
  }

  /** Whether a relayer key is configured and the pipeline can post. */
  enabled(): boolean {
    return this.poster !== null;
  }

  /** Drops currently waiting for the next batch. */
  size(): number {
    return this.queue.length;
  }

  /** Total drops abandoned after acceptance since boot; unbounded by the ring. */
  failureCount(): number {
    return this.failedTotal;
  }

  /** The most recent {@link SendFailure} records, oldest first. */
  recentFailures(): readonly SendFailure[] {
    return this.failed;
  }

  /**
   * What became of a drop the relay accepted.
   *
   * `unknown` is deliberately ambiguous: it covers "anchored successfully",
   * "never submitted" and "aged out of the failure ring" alike. The relay does
   * not index by `blobRef`, and inventing a stronger claim than it can back would
   * be worse than saying nothing.
   */
  statusOf(blobRef: `0x${string}`): SendStatus {
    const ref = blobRef.toLowerCase();
    // Newest first: a blobRef could in principle be resubmitted after failing.
    for (let i = this.failed.length - 1; i >= 0; i -= 1) {
      const failure = this.failed[i];
      if (failure !== undefined && failure.blobRef.toLowerCase() === ref) {
        return { status: 'failed', failure };
      }
    }
    if (this.queue.some((pending) => pending.drop.blobRef.toLowerCase() === ref)) {
      return { status: 'queued' };
    }
    return { status: 'unknown' };
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

      // Splice, never slice-then-reassign: `submit()` pushes onto this same array
      // while `post()` is in flight, and overwriting `this.queue` with a snapshot
      // taken before the await would silently discard every drop accepted during
      // it — drops the client was already told were queued.
      const batch = this.queue.splice(0, MAX_BATCH);

      try {
        const txHash = await this.poster.post(batch.map((pending) => pending.drop));
        this.backoffMs = INITIAL_BACKOFF_MS;
        this.backoffUntil = 0;
        this.log.info({ drops: batch.length, txHash }, 'relayed batch anchored');
      } catch (error) {
        await this.recoverFailedBatch(batch, error);
      }
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Recovers the innocent drops from a batch that failed to post.
   *
   * `Anchors.postBatch` is atomic, and its only *per-drop* revert is
   * `RoomInactive`. So one room whose rent lapses between `submit()` accepting a
   * drop and the batch landing takes down every unrelated drop batched with it:
   * each retry re-posts the same poison, and `staleMs` eventually discards the
   * innocents alongside it. Senders were told 200. Reachable by accident, and
   * trivially on purpose by posting into a room known to be about to lapse.
   *
   * The fix is to attribute the failure instead of guessing. Re-read room rent
   * from the chain with the cache bypassed: whatever the chain now refuses is
   * quarantined and reported, and everything else goes back at the head of the
   * queue to be retried immediately. When the chain cannot be reached, nothing
   * is blamed and the whole batch is retried under the existing backoff — an
   * innocent drop must never be discarded on a guess.
   */
  private async recoverFailedBatch(batch: readonly Pending[], error: unknown): Promise<void> {
    const poison = await this.findUnpostable(batch);

    if (poison === null || poison.size === 0) {
      // Nothing here is individually to blame, so the cause is whole-batch:
      // RPC down, relayer unapproved, out of gas. Put the batch back at the head
      // so ordering survives the retry. This can leave the queue up to MAX_BATCH
      // over `queueMax` until it drains, which is the right trade: a bounded
      // overshoot beats dropping accepted work.
      this.queue.unshift(...batch);
      this.backoffUntil = Date.now() + this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
      this.log.error({ err: error, drops: batch.length }, 'relayed batch failed; will retry');
      return;
    }

    const survivors: Pending[] = [];
    for (const pending of batch) {
      if (poison.has(pending)) {
        this.recordFailure(pending, 'room_inactive');
        continue;
      }
      survivors.push(pending);
    }

    // No backoff: the cause was identified and removed, so the survivors are not
    // made to serve a sentence earned by someone else's drop. The next scheduled
    // flush retries them at full speed.
    this.queue.unshift(...survivors);
    this.log.error(
      { err: error, quarantined: poison.size, requeued: survivors.length },
      'relayed batch reverted; quarantined the drops whose room rent has lapsed and requeued the rest',
    );
  }

  /**
   * The subset of `batch` the chain will refuse, re-read live.
   *
   * Returns `null` when the gate could not answer at all — indistinguishable from
   * a transient outage, so the caller must retry everything rather than blame
   * anyone. One read per *distinct* room, and only on the failure path, so the
   * happy path pays nothing for this.
   */
  private async findUnpostable(batch: readonly Pending[]): Promise<Set<Pending> | null> {
    const roomActive = new Map<string, boolean>();
    try {
      for (const pending of batch) {
        const { convoId } = pending.drop;
        // Stealth 1:1 drops carry no convo id and are not rent-gated on chain.
        if (convoId === ZERO_CONVO) continue;
        const key = convoId.toLowerCase();
        if (roomActive.has(key)) continue;
        roomActive.set(key, await this.gate.isRoomActive(convoId, { fresh: true }));
      }
    } catch (gateError) {
      this.log.warn(
        { err: gateError },
        'could not re-read room rent after a failed batch; retrying the whole batch',
      );
      return null;
    }

    const poison = new Set<Pending>();
    for (const pending of batch) {
      const { convoId } = pending.drop;
      if (convoId === ZERO_CONVO) continue;
      if (roomActive.get(convoId.toLowerCase()) === false) poison.add(pending);
    }
    return poison;
  }

  /** Evicts drops that have waited longer than `staleMs`, recording each one. */
  private evictStale(): void {
    const cutoff = Date.now() - this.staleMs;
    const fresh: Pending[] = [];
    let evicted = 0;
    for (const pending of this.queue) {
      if (pending.enqueuedAt >= cutoff) {
        fresh.push(pending);
        continue;
      }
      evicted += 1;
      this.recordFailure(pending, 'expired');
    }
    if (evicted > 0) {
      this.log.warn({ evicted }, 'evicted stale relayed drops that could not be posted in time');
      this.queue = fresh;
    }
  }

  /**
   * Books an accepted-but-unanchorable drop as a real, reportable failure.
   *
   * The sender was answered `200 {"accepted":true}`. Losing that message without
   * a trace is the defect; it has to be loud in the log *and* queryable at
   * `GET /v1/send/:blobRef` afterwards.
   */
  private recordFailure(pending: Pending, reason: SendFailureReason): void {
    const failure: SendFailure = {
      blobRef: pending.drop.blobRef,
      convoId: pending.drop.convoId,
      sender: pending.sender,
      reason,
      failedAt: Date.now(),
    };
    this.failed.push(failure);
    this.failedTotal += 1;
    if (this.failed.length > this.failureLogMax) this.failed.shift();
    this.log.error(
      {
        blobRef: failure.blobRef,
        convoId: failure.convoId,
        sender: failure.sender,
        reason,
        waitedMs: failure.failedAt - pending.enqueuedAt,
      },
      'relayed drop abandoned after it was accepted; it will never be anchored',
    );
  }
}
