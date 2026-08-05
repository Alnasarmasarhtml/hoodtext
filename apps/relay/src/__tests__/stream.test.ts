import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RelayStats } from '../db.js';
import { StreamHub, type StreamMessage, type StreamSocket } from '../stream.js';
import { makeDrop, silentLogger, waitFor } from './helpers.js';

const OPEN = 1;
const CLOSED = 3;

/** Minimal stand-in for a `ws` socket — only what the hub actually touches. */
class FakeSocket {
  readyState = OPEN;
  readonly sent: string[] = [];
  closedWith: { code: number; reason: string } | null = null;
  readonly #listeners = new Map<string, Set<() => void>>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1_000, reason = ''): void {
    this.closedWith = { code, reason };
    this.readyState = CLOSED;
  }

  on(event: string, listener: () => void): this {
    const set = this.#listeners.get(event) ?? new Set<() => void>();
    set.add(listener);
    this.#listeners.set(event, set);
    return this;
  }

  off(event: string, listener: () => void): this {
    this.#listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string): void {
    for (const listener of [...(this.#listeners.get(event) ?? [])]) listener();
  }

  listenerCount(event: string): number {
    return this.#listeners.get(event)?.size ?? 0;
  }

  messages(): StreamMessage[] {
    return this.sent.map((frame) => JSON.parse(frame) as StreamMessage);
  }

  asSocket(): StreamSocket {
    return this as unknown as StreamSocket;
  }
}

const STATS: RelayStats = {
  head: 3,
  totalDrops: 3,
  totalBlobs: 1,
  uniquePosters: 2,
  indexedBlock: 99,
};

describe('StreamHub', () => {
  let hub: StreamHub;

  beforeEach(() => {
    hub = new StreamHub({ statsIntervalMs: 10, stats: () => STATS, log: silentLogger() });
  });

  afterEach(() => {
    hub.close();
  });

  it('greets a new subscriber with a stats frame and arms the timer', () => {
    const socket = new FakeSocket();
    hub.add(socket.asSocket());

    expect(hub.size).toBe(1);
    expect(hub.timerArmed).toBe(true);
    expect(socket.messages()).toEqual([{ type: 'stats', stats: STATS }]);
  });

  it('broadcasts each new anchor to every subscriber', () => {
    const a = new FakeSocket();
    const b = new FakeSocket();
    hub.add(a.asSocket());
    hub.add(b.asSocket());

    const drop = makeDrop(7);
    hub.broadcastDrop(drop);

    expect(a.messages().at(-1)).toEqual({ type: 'drop', drop });
    expect(b.messages().at(-1)).toEqual({ type: 'drop', drop });
  });

  it('keeps broadcasting stats on the interval', async () => {
    const socket = new FakeSocket();
    hub.add(socket.asSocket());

    await waitFor(() => socket.messages().filter((m) => m.type === 'stats').length >= 3);
    expect(socket.messages().every((message) => message.type === 'stats')).toBe(true);
  });

  it('releases listeners and the timer when the last subscriber disconnects', () => {
    const socket = new FakeSocket();
    hub.add(socket.asSocket());

    socket.emit('close');

    expect(hub.size).toBe(0);
    expect(hub.timerArmed).toBe(false);
    expect(socket.listenerCount('close')).toBe(0);
    expect(socket.listenerCount('error')).toBe(0);
  });

  it('keeps the timer while other subscribers remain', () => {
    const a = new FakeSocket();
    const b = new FakeSocket();
    hub.add(a.asSocket());
    hub.add(b.asSocket());

    a.emit('close');

    expect(hub.size).toBe(1);
    expect(hub.timerArmed).toBe(true);
  });

  it('drops a subscriber whose socket errored', () => {
    const socket = new FakeSocket();
    hub.add(socket.asSocket());

    socket.emit('error');

    expect(hub.size).toBe(0);
    expect(socket.listenerCount('error')).toBe(0);
  });

  it('discards a socket that is no longer open instead of writing to it', () => {
    const socket = new FakeSocket();
    hub.add(socket.asSocket());
    socket.readyState = CLOSED;

    hub.broadcastDrop(makeDrop(1));

    expect(hub.size).toBe(0);
    expect(socket.sent).toHaveLength(1); // only the greeting
  });

  it('adding the same socket twice does not double-subscribe', () => {
    const socket = new FakeSocket();
    hub.add(socket.asSocket());
    hub.add(socket.asSocket());

    expect(hub.size).toBe(1);
    expect(socket.listenerCount('close')).toBe(1);
  });

  it('survives a stats provider that throws', () => {
    const broken = new StreamHub({
      statsIntervalMs: 10,
      stats: () => {
        throw new Error('db closed');
      },
      log: silentLogger(),
    });
    const socket = new FakeSocket();

    expect(() => broken.add(socket.asSocket())).not.toThrow();
    expect(() => broken.broadcastStats()).not.toThrow();
    expect(socket.sent).toHaveLength(0);
    broken.close();
  });

  it('closes every socket and disarms the timer on shutdown', () => {
    const socket = new FakeSocket();
    hub.add(socket.asSocket());

    hub.close();

    expect(hub.size).toBe(0);
    expect(hub.timerArmed).toBe(false);
    expect(socket.closedWith?.code).toBe(1_001);
    expect(socket.listenerCount('close')).toBe(0);
  });

  it('refuses new subscribers once closed', () => {
    hub.close();
    const socket = new FakeSocket();

    hub.add(socket.asSocket());

    expect(hub.size).toBe(0);
    expect(socket.closedWith?.code).toBe(1_012);
  });
});
