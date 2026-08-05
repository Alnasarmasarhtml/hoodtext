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

export type StreamMessage = DropMessage | StatsMessage;

export interface StreamHubOptions {
  readonly statsIntervalMs: number;
  /** Read lazily so a broadcast always reflects the database at that instant. */
  readonly stats: () => RelayStats;
  readonly log: FastifyBaseLogger;
}

/** `ws.WebSocket.OPEN`. Imported as a literal because `ws` is a transitive dep. */
const WS_OPEN = 1;

const CLOSE_GOING_AWAY = 1001;
const CLOSE_SERVICE_RESTART = 1012;

export class StreamHub {
  readonly #clients = new Set<StreamSocket>();
  readonly #detach = new Map<StreamSocket, () => void>();
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
  add(socket: StreamSocket): void {
    if (this.#closed) {
      this.#safeClose(socket, CLOSE_SERVICE_RESTART, 'relay shutting down');
      return;
    }
    if (this.#clients.has(socket)) return;

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
    this.#sendStatsTo(socket);
    this.#ensureTimer();
  }

  /** Detach every listener we added and forget the socket. Safe to call twice. */
  remove(socket: StreamSocket): void {
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
