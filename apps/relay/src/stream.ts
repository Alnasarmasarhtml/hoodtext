/**
 * `WS /v1/stream` fan-out (SPEC §6).
 *
 * Emits `{ type: 'drop', drop }` the moment the indexer sees a new anchor and
 * `{ type: 'stats', stats }` every 10s. The stats timer exists only while at
 * least one client is connected, and every listener attached to a socket is
 * detached again when that socket goes away — a disconnected client must leave
 * nothing behind.
 */

import type { FastifyBaseLogger } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import type { DropRow, RelayStats } from './db.js';

/** The socket handed to us by `@fastify/websocket`. */
export type StreamSocket = WebSocket;

export interface DropMessage {
  readonly type: 'drop';
  readonly drop: DropRow;
}

export interface StatsMessage {
  readonly type: 'stats';
  readonly stats: RelayStats;
}

/**
 * One sealed call-signalling frame, delivered to a single tag.
 *
 * The relay cannot read it: the body is the same sealed envelope the messenger
 * uses, opened only by the holder of the recipient's X25519 key. It is never
 * stored and never anchored, so a call leaves no record here.
 */
export interface SignalMessage {
  readonly type: 'signal';
  /** Base64 of the sealed envelope. */
  readonly blob: string;
}

export type StreamMessage = DropMessage | StatsMessage | SignalMessage;

export interface StreamHubOptions {
  readonly statsIntervalMs: number;
  /** Read lazily so a broadcast always reflects the database at that instant. */
  readonly stats: () => RelayStats;
  readonly log: FastifyBaseLogger;
  /** Hard cap on concurrent subscribers. Omit for unbounded (tests only). */
  readonly maxClients?: number;
}

/** `ws.WebSocket.OPEN`. Imported as a literal because `ws` is a transitive dep. */
const WS_OPEN = 1;

const CLOSE_GOING_AWAY = 1001;
const CLOSE_TRY_AGAIN_LATER = 1013;
const CLOSE_SERVICE_RESTART = 1012;

/**
 * Outbound bytes a single subscriber may leave unflushed before it is dropped.
 *
 * `ws` buffers in process memory for a socket that stops reading, and the fan-out
 * writes to every subscriber unconditionally — so one stalled client would grow
 * the relay's heap without limit. A client that cannot absorb 1 MiB of JSON is
 * better off reconnecting and backfilling over HTTP.
 */
const MAX_BUFFERED_BYTES = 1_048_576;

export class StreamHub {
  readonly #clients = new Set<StreamSocket>();
  readonly #detach = new Map<StreamSocket, () => void>();
  /**
   * Call-signalling routing table: tag -> the sockets listening on it.
   *
   * A tag is derived by the client from its own registered X25519 key, so it is
   * a routing address, not a secret. HONEST LEAK, stated because the project
   * refuses to overclaim: every X25519 key is public in KeyRegistry, so the
   * relay can precompute the tag table and therefore learns WHO CALLS WHOM and
   * WHEN. It still learns nothing about what is said. The message lane does not
   * leak this; the call lane does, because a live call needs a live route.
   */
  readonly #byTag = new Map<string, Set<StreamSocket>>();
  readonly #tagOf = new Map<StreamSocket, string>();
  readonly #options: StreamHubOptions;
  #timer: NodeJS.Timeout | null = null;
  #closed = false;

  constructor(options: StreamHubOptions) {
    this.#options = options;
  }

  /** Number of live subscribers. */
  get size(): number {
    return this.#clients.size;
  }

  /** True while the 10s stats timer is armed — used by tests to prove it is released. */
  get timerArmed(): boolean {
    return this.#timer !== null;
  }

  /**
   * Register a freshly upgraded socket. Sends an immediate stats frame so a new
   * client renders something before the first tick.
   */
  add(socket: StreamSocket, callTag?: string): void {
    if (this.#closed) {
      this.#safeClose(socket, CLOSE_SERVICE_RESTART, 'relay shutting down');
      return;
    }
    if (this.#clients.has(socket)) return;
    const maxClients = this.#options.maxClients;
    if (maxClients !== undefined && this.#clients.size >= maxClients) {
      // The per-IP handshake limit bounds churn, not concurrency: many IPs can
      // each hold one socket. This is the ceiling on the fan-out itself.
      this.#options.log.warn({ maxClients }, 'stream: subscriber cap reached, refusing socket');
      this.#safeClose(socket, CLOSE_TRY_AGAIN_LATER, 'relay stream is at capacity');
      return;
    }

    const onGone = (): void => {
      this.remove(socket);
    };
    socket.on('close', onGone);
    socket.on('error', onGone);
    this.#detach.set(socket, () => {
      socket.off('close', onGone);
      socket.off('error', onGone);
    });

    this.#clients.add(socket);
    if (callTag !== undefined && callTag !== '') {
      this.#tagOf.set(socket, callTag);
      let sockets = this.#byTag.get(callTag);
      if (sockets === undefined) {
        sockets = new Set();
        this.#byTag.set(callTag, sockets);
      }
      sockets.add(socket);
    }
    this.#sendStatsTo(socket);
    this.#ensureTimer();
  }

  /**
   * Deliver one sealed signalling frame to every socket on `tag`.
   *
   * @returns true when at least one socket was written to. The ROUTE must not
   *   expose this: answering "nobody is listening" would turn the endpoint into
   *   a presence oracle, since tags are derivable from the public registry.
   */
  routeSignal(tag: string, blob: string): boolean {
    const sockets = this.#byTag.get(tag);
    if (sockets === undefined || sockets.size === 0) return false;
    const frame = JSON.stringify({ type: 'signal', blob } satisfies SignalMessage);
    let delivered = false;
    for (const socket of [...sockets]) {
      if (socket.readyState !== WS_OPEN) {
        this.remove(socket);
        continue;
      }
      this.#sendFrame(socket, frame);
      delivered = true;
    }
    return delivered;
  }

  /** Sockets currently listening on a call tag. Tests assert on this. */
  tagSize(tag: string): number {
    return this.#byTag.get(tag)?.size ?? 0;
  }

  /** Detach every listener we added and forget the socket. Safe to call twice. */
  remove(socket: StreamSocket): void {
    const tag = this.#tagOf.get(socket);
    if (tag !== undefined) {
      this.#tagOf.delete(socket);
      const sockets = this.#byTag.get(tag);
      if (sockets !== undefined) {
        sockets.delete(socket);
        if (sockets.size === 0) this.#byTag.delete(tag);
      }
    }
    const detach = this.#detach.get(socket);
    if (detach !== undefined) {
      this.#detach.delete(socket);
      try {
        detach();
      } catch (error) {
        this.#options.log.debug({ err: error }, 'stream: failed to detach socket listeners');
      }
    }
    this.#clients.delete(socket);
    if (this.#clients.size === 0) this.#clearTimer();
  }

  /** Push one anchor to every subscriber. Never throws. */
  broadcastDrop(drop: DropRow): void {
    this.#broadcast({ type: 'drop', drop });
  }

  /** Push a stats frame immediately, outside the timer. Never throws. */
  broadcastStats(): void {
    const stats = this.#readStats();
    if (stats === null) return;
    this.#broadcast({ type: 'stats', stats });
  }

  /** Close every socket, release the timer, and refuse further subscribers. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearTimer();
    for (const socket of [...this.#clients]) {
      this.remove(socket);
      this.#safeClose(socket, CLOSE_GOING_AWAY, 'relay shutting down');
    }
    this.#clients.clear();
    this.#detach.clear();
    this.#byTag.clear();
    this.#tagOf.clear();
  }

  #ensureTimer(): void {
    if (this.#timer !== null || this.#closed) return;
    const timer = setInterval(() => {
      this.broadcastStats();
    }, this.#options.statsIntervalMs);
    // Never hold the process open just to tick stats.
    timer.unref();
    this.#timer = timer;
  }

  #clearTimer(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  #readStats(): RelayStats | null {
    try {
      return this.#options.stats();
    } catch (error) {
      this.#options.log.warn({ err: error }, 'stream: stats snapshot failed');
      return null;
    }
  }

  #sendStatsTo(socket: StreamSocket): void {
    const stats = this.#readStats();
    if (stats === null) return;
    this.#send(socket, { type: 'stats', stats });
  }

  #broadcast(message: StreamMessage): void {
    if (this.#clients.size === 0) return;
    const frame = JSON.stringify(message);
    for (const socket of [...this.#clients]) {
      this.#sendFrame(socket, frame);
    }
  }

  #send(socket: StreamSocket, message: StreamMessage): void {
    this.#sendFrame(socket, JSON.stringify(message));
  }

  #sendFrame(socket: StreamSocket, frame: string): void {
    if (socket.readyState !== WS_OPEN) {
      this.remove(socket);
      return;
    }
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.#options.log.warn(
        { buffered: socket.bufferedAmount },
        'stream: subscriber is not draining, dropping it',
      );
      this.remove(socket);
      this.#safeClose(socket, CLOSE_TRY_AGAIN_LATER, 'stream backpressure');
      return;
    }
    try {
      socket.send(frame);
    } catch (error) {
      this.#options.log.debug({ err: error }, 'stream: send failed, dropping subscriber');
      this.remove(socket);
    }
  }

  #safeClose(socket: StreamSocket, code: number, reason: string): void {
    try {
      socket.close(code, reason);
    } catch (error) {
      this.#options.log.debug({ err: error }, 'stream: failed to close socket');
    }
  }
}
