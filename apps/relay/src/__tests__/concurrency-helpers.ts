/**
 * Scaffolding shared by the concurrency suites.
 *
 * Node runs one thread, so the only interleaving that exists in this process is
 * at `await` points. Every fake here therefore yields *deliberately* — a chain
 * gate that resolves after a variable number of microtasks, a poster that parks
 * on a real macrotask — so one submission can sit suspended mid-verification
 * while dozens of others run to completion around it. Fakes that resolved
 * synchronously would make these tests look concurrent while in fact running
 * every call to completion one at a time, which proves nothing.
 */

import { signDrop, type IdentityKeys, type SignableDrop } from '@hoodgram/crypto';
import type { BatchPoster, ChainGate } from '../sender.js';
import type { SendPipeline } from '../sender.js';

export const ZERO_CONVO = `0x${'0'.repeat(64)}` as const;
export const TX_HASH = `0x${'11'.repeat(32)}` as `0x${string}`;

/** Yield `n` times to the microtask queue. */
export async function microticks(n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}

/** Yield to the macrotask queue, so timers and pending I/O get a turn. */
export function macrotick(ms = 0): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** A deterministic, unique-per-index drop. `blobRef` doubles as its identity. */
export function dropAt(index: number, convoId: `0x${string}` = ZERO_CONVO): SignableDrop {
  return {
    convoId,
    ephPub: `0x${(index + 1).toString(16).padStart(64, '0')}`,
    blobRef: `0x${(index + 1_000_000).toString(16).padStart(64, '0')}`,
    viewTag: index % 256,
    size: 256,
  };
}

export interface SignedDrop {
  readonly drop: SignableDrop;
  readonly signature: `0x${string}`;
}

/**
 * Pre-sign `count` distinct drops so the race itself is not measuring libsodium.
 * `offset` shifts the index space, which matters because `blobRef` is how these
 * suites tell drops apart — two calls must not mint colliding identities.
 */
export async function signBatch(
  identity: IdentityKeys,
  count: number,
  convoId: `0x${string}` = ZERO_CONVO,
  offset = 0,
): Promise<SignedDrop[]> {
  const signed: SignedDrop[] = [];
  for (let i = 0; i < count; i += 1) {
    const drop = dropAt(offset + i, convoId);
    signed.push({ drop, signature: await signDrop(drop, identity.ed25519.privateKey) });
  }
  return signed;
}

/**
 * A {@link ChainGate} whose every answer arrives after a varying number of
 * microtask hops, so concurrent `submit()` calls suspend at different points and
 * genuinely interleave rather than running to completion in submission order.
 */
export class LaggyGate implements ChainGate {
  readonly keys = new Map<string, `0x${string}`>();
  readonly activated = new Set<string>();
  readonly activeRooms = new Set<string>();
  /** Upper bound on the microtask hops any single gate call parks for. */
  lag = 4;
  #calls = 0;

  async ed25519KeyOf(sender: `0x${string}`): Promise<`0x${string}` | null> {
    await this.#park();
    return this.keys.get(sender.toLowerCase()) ?? null;
  }

  async isActivated(sender: `0x${string}`): Promise<boolean> {
    await this.#park();
    return this.activated.has(sender.toLowerCase());
  }

  async isRoomActive(groupId: `0x${string}`): Promise<boolean> {
    await this.#park();
    return this.activeRooms.has(groupId.toLowerCase());
  }

  async #park(): Promise<void> {
    this.#calls += 1;
    await microticks(1 + (this.#calls % this.lag));
  }
}

/**
 * Records every batch it is asked to post, parks on a real macrotask so a flush
 * is genuinely in flight across event-loop turns, and tracks how many posts were
 * ever simultaneously in flight — the number that would expose a double-post.
 */
export class RecordingPoster implements BatchPoster {
  readonly batches: SignableDrop[][] = [];
  /** Every batch handed to `post()`, including ones that then failed. */
  readonly attempted: SignableDrop[][] = [];
  /** Highest number of `post()` calls in flight at the same instant. */
  maxConcurrent = 0;
  /** Zero-based call indexes that must reject instead of posting. */
  readonly failOn = new Set<number>();
  /** Milliseconds each post parks for before settling. */
  delayMs = 0;

  #inFlight = 0;
  #calls = 0;

  /** Posts currently awaiting settlement. Zero means the pipeline is quiescent. */
  get inFlight(): number {
    return this.#inFlight;
  }

  async post(drops: readonly SignableDrop[]): Promise<`0x${string}`> {
    const call = this.#calls;
    this.#calls += 1;
    this.#inFlight += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.#inFlight);
    const snapshot = [...drops];
    this.attempted.push(snapshot);
    try {
      await macrotick(this.delayMs);
      if (this.failOn.has(call)) {
        throw new Error(`injected post failure #${call}`);
      }
      this.batches.push(snapshot);
      return TX_HASH;
    } finally {
      this.#inFlight -= 1;
    }
  }

  get calls(): number {
    return this.#calls;
  }

  /** Every successfully anchored drop, flattened in the order it went on chain. */
  anchoredRefs(): string[] {
    return this.batches.flat().map((drop) => drop.blobRef);
  }
}

/**
 * A poster whose calls hang until the test releases them, so a batch can be held
 * mid-flight while other flushes and submissions pile up behind it.
 */
export class HeldPoster implements BatchPoster {
  /** Batches that reached `post()`, whether or not they have settled. */
  readonly received: SignableDrop[][] = [];
  /** Batches that settled successfully. */
  readonly posted: SignableDrop[][] = [];
  /** When true, the next release rejects instead of resolving. */
  failNext = false;

  #waiters: (() => void)[] = [];

  post(drops: readonly SignableDrop[]): Promise<`0x${string}`> {
    const snapshot = [...drops];
    this.received.push(snapshot);
    return new Promise<`0x${string}`>((resolve, reject) => {
      this.#waiters.push(() => {
        if (this.failNext) {
          this.failNext = false;
          reject(new Error('rpc unavailable'));
          return;
        }
        this.posted.push(snapshot);
        resolve(TX_HASH);
      });
    });
  }

  /** Batches currently parked inside `post()`. */
  get inFlight(): number {
    return this.#waiters.length;
  }

  /** Resolve once at least `n` batches have reached `post()`. */
  async arrived(n: number, budgetMs = 2_000): Promise<void> {
    const deadline = Date.now() + budgetMs;
    while (this.received.length < n) {
      if (Date.now() > deadline) {
        throw new Error(`only ${this.received.length} of ${n} batches reached the poster`);
      }
      await macrotick(1);
    }
  }

  /** Settle every parked batch. */
  releaseAll(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const waiter of waiters) waiter();
  }
}

/**
 * Flush until the pipeline is genuinely quiescent.
 *
 * Two things make a single `await flushNow()` insufficient. It posts at most
 * `MAX_BATCH` drops, and it returns *immediately* — without waiting — when
 * another flush already owns the pipeline. `size()` is likewise not a quiescence
 * signal: a flush splices its batch out of the queue before awaiting the chain,
 * so an empty queue can still have 64 drops in flight. Passing the poster makes
 * this wait for those too.
 */
export async function drain(
  pipeline: SendPipeline,
  options: { readonly quiet?: () => boolean; readonly budgetMs?: number } = {},
): Promise<void> {
  const quiet = options.quiet ?? ((): boolean => true);
  const deadline = Date.now() + (options.budgetMs ?? 8_000);
  while (pipeline.size() > 0 || !quiet()) {
    if (Date.now() > deadline) {
      throw new Error(`pipeline never drained; ${pipeline.size()} drops still queued`);
    }
    await pipeline.flushNow();
    await macrotick(1);
  }
}

/** Values that appear more than once, for "anchored exactly once" assertions. */
export function duplicatesOf(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) dupes.add(value);
    seen.add(value);
  }
  return [...dupes];
}

/** Capture unhandled promise rejections for the lifetime of one test. */
export function trapUnhandledRejections(): { readonly seen: unknown[]; restore: () => void } {
  const seen: unknown[] = [];
  const onRejection = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on('unhandledRejection', onRejection);
  return {
    seen,
    restore: (): void => {
      process.off('unhandledRejection', onRejection);
    },
  };
}
