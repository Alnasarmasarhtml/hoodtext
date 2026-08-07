/**
 * `StreamHub` fan-out while the subscriber set is changing underneath it.
 *
 * The fan-out loop is synchronous, but it is not isolated: `socket.send()` is a
 * real `ws` call that can throw, and the `'close'`/`'error'` listeners the hub
 * installs can fire *during* the loop — a client dropping its connection halfway
 * through a broadcast is the normal case, not the exotic one. Every socket here
 * can therefore be scripted to do something disruptive at the exact moment the
 * hub writes to it.
 */

import { describe, expect, it } from 'vitest';
import type { RelayStats } from '../db.js';
import { StreamHub, type StreamMessage, type StreamSocket } from '../stream.js';
import { makeDrop, silentLogger, waitFor } from './helpers.js';
import { macrotick } from './concurrency-helpers.js';

const OPEN = 1;
const CLOSED = 3;

const STATS: RelayStats = {
  head: 12,
  totalDrops: 12,
  totalBlobs: 4,
  uniquePosters: 3,
  indexedBlock: 900,
};

/**
 * A `ws` stand-in whose `send()` can be scripted to disrupt the broadcast it is
 * part of — the only way to reach the hub's mid-loop states from a test.
 */
class ScriptedSocket {
  readyState = OPEN;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  closedWith: { code: number; reason: string } | null = null;
  /** Runs before the frame is recorded, i.e. inside the hub's fan-out loop. */
  onSend: ((self: ScriptedSocket) => void) | null = null;
  throwOnSend = false;

  readonly #listeners = new Map<string, Set<() => void>>();

  constructor(readonly name: string) {}

  send(data: string): void {
    this.onSend?.(this);
    if (this.throwOnSend) throw new Error(`${this.name}: socket write failed`);
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

  /** Frames received after the initial stats greeting. */
  broadcasts(): StreamMessage[] {
    return this.sent.slice(1).map((frame) => JSON.parse(frame) as StreamMessage);
  }

  dropSeqs(): number[] {
    return this.broadcasts()
      .filter((message) => message.type === 'drop')
      .map((message) => (message.type === 'drop' ? message.drop.seq : -1));
  }

  asSocket(): StreamSocket {
    return this as unknown as StreamSocket;
  }
}

function newHub(overrides: { statsIntervalMs?: number; maxClients?: number } = {}): StreamHub {
  return new StreamHub({
    statsIntervalMs: overrides.statsIntervalMs ?? 10_000,
    stats: () => STATS,
    log: silentLogger(),
    ...(overrides.maxClients === undefined ? {} : { maxClients: overrides.maxClients }),
  });
}

function addAll(hub: StreamHub, count: number, prefix = 'sub'): ScriptedSocket[] {
  const sockets = Array.from({ length: count }, (_, i) => new ScriptedSocket(`${prefix}-${i}`));
  for (const socket of sockets) hub.add(socket.asSocket());
  return sockets;
}

describe('StreamHub fan-out with a subscriber leaving mid-broadcast', () => {
  it('delivers to every remaining subscriber when one closes during the loop', () => {
    const hub = newHub();
    const sockets = addAll(hub, 6);
    const [first, , , quitter] = sockets;
    if (first === undefined || quitter === undefined) throw new Error('setup failed');

    // The first write in the loop is what tears the fourth subscriber's socket
    // down — the hub is mutating its own client set while iterating it.
    first.onSend = (): void => {
      quitter.readyState = CLOSED;
      quitter.emit('close');
    };

    const drop = makeDrop(1);
    expect(() => {
      hub.broadcastDrop(drop);
    }).not.toThrow();

    expect(hub.size).toBe(5);
    for (const socket of sockets) {
      if (socket === quitter) continue;
      expect(socket.dropSeqs()).toEqual([1]);
    }
    // The departed socket got nothing after it closed, and left no listeners.
    expect(quitter.dropSeqs()).toEqual([]);
    expect(quitter.listenerCount('close')).toBe(0);
    expect(quitter.listenerCount('error')).toBe(0);
    hub.close();
  });

  it('keeps fanning out past a subscriber whose write throws', () => {
    const hub = newHub();
    const sockets = addAll(hub, 5);
    const broken = sockets[1];
    if (broken === undefined) throw new Error('setup failed');
    broken.throwOnSend = true;

    hub.broadcastDrop(makeDrop(7));

    // One dead socket must not cost the other four their message.
    expect(hub.size).toBe(4);
    for (const socket of sockets) {
      expect(socket.dropSeqs()).toEqual(socket === broken ? [] : [7]);
    }
    expect(broken.listenerCount('close')).toBe(0);
    hub.close();
  });

  it('handles half the room disconnecting inside a single broadcast', () => {
    const hub = newHub();
    const sockets = addAll(hub, 40);
    const trigger = sockets[0];
    if (trigger === undefined) throw new Error('setup failed');

    trigger.onSend = (): void => {
      // Every odd subscriber drops at the instant the first one is written to.
      for (let i = 1; i < sockets.length; i += 2) {
        const victim = sockets[i];
        if (victim === undefined) continue;
        victim.readyState = CLOSED;
        victim.emit('close');
      }
    };

    hub.broadcastDrop(makeDrop(3));

    expect(hub.size).toBe(20);
    for (let i = 0; i < sockets.length; i += 1) {
      const socket = sockets[i];
      if (socket === undefined) continue;
      expect(socket.dropSeqs()).toEqual(i % 2 === 0 ? [3] : []);
    }
    hub.close();
  });

  it('does not deliver the in-flight frame to a subscriber that joins during it', () => {
    const hub = newHub();
    const [first] = addAll(hub, 2);
    if (first === undefined) throw new Error('setup failed');
    const latecomer = new ScriptedSocket('latecomer');

    first.onSend = (): void => {
      hub.add(latecomer.asSocket());
    };

    hub.broadcastDrop(makeDrop(5));

    // The loop iterates a snapshot, so the newcomer sees only its greeting and
    // then the *next* broadcast — never a partially-observed one.
    expect(latecomer.dropSeqs()).toEqual([]);
    expect(latecomer.sent).toHaveLength(1);
    expect(hub.size).toBe(3);

    hub.broadcastDrop(makeDrop(6));
    expect(latecomer.dropSeqs()).toEqual([6]);
    hub.close();
  });

  it('lets no frame escape to a socket already closed by a shutdown mid-broadcast', () => {
    const hub = newHub();
    const sockets = addAll(hub, 5);
    const trigger = sockets[0];
    if (trigger === undefined) throw new Error('setup failed');

    // Shutdown arriving in the middle of a fan-out.
    trigger.onSend = (): void => {
      hub.close();
    };

    expect(() => {
      hub.broadcastDrop(makeDrop(9));
    }).not.toThrow();

    expect(hub.size).toBe(0);
    for (const socket of sockets.slice(1)) {
      expect(socket.dropSeqs()).toEqual([]);
      expect(socket.closedWith?.code).toBe(1_001);
      expect(socket.listenerCount('close')).toBe(0);
    }
  });

  it('drops a stalled subscriber without disturbing the rest of the room', () => {
    const hub = newHub();
    const sockets = addAll(hub, 8);
    const stalled = sockets[3];
    if (stalled === undefined) throw new Error('setup failed');
    stalled.bufferedAmount = 2 * 1_048_576;

    hub.broadcastDrop(makeDrop(11));
    hub.broadcastDrop(makeDrop(12));

    expect(hub.size).toBe(7);
    expect(stalled.closedWith?.code).toBe(1_013);
    for (const socket of sockets) {
      expect(socket.dropSeqs()).toEqual(socket === stalled ? [] : [11, 12]);
    }
    hub.close();
  });

  it('OBSERVED: a peer removed mid-broadcast still receives that frame', () => {
    const hub = newHub();
    const sockets = addAll(hub, 3);
    const [first, , peer] = sockets;
    if (first === undefined || peer === undefined) throw new Error('setup failed');

    // `remove()` without the socket transitioning out of OPEN — what an `'error'`
    // event does, since `ws` leaves readyState alone when it emits `error`.
    first.onSend = (): void => {
      peer.emit('error');
    };

    hub.broadcastDrop(makeDrop(21));

    expect(hub.size).toBe(2);
    expect(peer.listenerCount('error')).toBe(0);
    // `#sendFrame` re-checks `readyState`, not membership, so the socket the hub
    // has already forgotten is still written to once. Harmless today — the write
    // is inside a try/catch and the socket is not re-added — but it contradicts
    // the module's "a disconnected client must leave nothing behind" contract
    // and would matter the moment the hub carried per-subscriber state.
    expect(peer.dropSeqs()).toEqual([21]);
    hub.close();
  });
});

describe('StreamHub subscriber churn', () => {
  it('survives 200 joins and departures interleaved with 100 broadcasts', () => {
    const hub = newHub();
    const live: ScriptedSocket[] = [];
    const retired: ScriptedSocket[] = [];

    for (let round = 0; round < 100; round += 1) {
      const joiner = new ScriptedSocket(`churn-${round}`);
      hub.add(joiner.asSocket());
      live.push(joiner);

      hub.broadcastDrop(makeDrop(round + 1));

      if (round % 2 === 1) {
        const leaving = live.shift();
        if (leaving !== undefined) {
          leaving.readyState = CLOSED;
          leaving.emit('close');
          retired.push(leaving);
        }
      }
    }

    expect(hub.size).toBe(live.length);
    expect(hub.timerArmed).toBe(true);
    // Nothing left a listener behind, which is what keeps a long-running relay
    // from leaking one closure per reconnect.
    for (const socket of retired) {
      expect(socket.listenerCount('close')).toBe(0);
      expect(socket.listenerCount('error')).toBe(0);
      // A departed subscriber's stream is a contiguous run, never a frame with a
      // gap in it — no broadcast half-reached it.
      const seqs = socket.dropSeqs();
      for (let i = 1; i < seqs.length; i += 1) {
        expect(seqs[i] ?? 0).toBe((seqs[i - 1] ?? 0) + 1);
      }
    }

    hub.close();
    expect(hub.size).toBe(0);
    expect(hub.timerArmed).toBe(false);
  });

  it('releases and re-arms the stats timer as the room empties and refills', async () => {
    const hub = newHub({ statsIntervalMs: 5 });
    const sockets = addAll(hub, 4);
    expect(hub.timerArmed).toBe(true);

    await waitFor(() => (sockets[0]?.sent.length ?? 0) >= 3);

    // Everyone leaves at once, from inside the timer's own broadcast window.
    for (const socket of sockets) {
      socket.readyState = CLOSED;
      socket.emit('close');
    }
    expect(hub.size).toBe(0);
    expect(hub.timerArmed).toBe(false);

    const before = sockets.map((socket) => socket.sent.length);
    await macrotick(30);
    // A disarmed timer means no further work is done for an empty room.
    expect(sockets.map((socket) => socket.sent.length)).toEqual(before);

    const returning = new ScriptedSocket('returning');
    hub.add(returning.asSocket());
    expect(hub.timerArmed).toBe(true);
    await waitFor(() => returning.sent.length >= 3);
    hub.close();
  });

  it('holds the cap while subscribers churn against it', () => {
    const hub = newHub({ maxClients: 5 });
    const accepted = addAll(hub, 5, 'seated');
    const refused = addAll(hub, 20, 'refused');

    expect(hub.size).toBe(5);
    for (const socket of refused) {
      expect(socket.closedWith?.code).toBe(1_013);
      expect(socket.sent).toHaveLength(0);
    }

    // Free two seats mid-broadcast and confirm exactly two can be reclaimed.
    const first = accepted[0];
    if (first === undefined) throw new Error('setup failed');
    first.onSend = (): void => {
      for (const index of [1, 2]) {
        const leaving = accepted[index];
        if (leaving === undefined) continue;
        leaving.readyState = CLOSED;
        leaving.emit('close');
      }
    };
    hub.broadcastDrop(makeDrop(1));
    expect(hub.size).toBe(3);

    const returning = addAll(hub, 4, 'returning');
    expect(hub.size).toBe(5);
    expect(returning.filter((socket) => socket.closedWith === null)).toHaveLength(2);
    hub.close();
  });

  it('a stats provider that fails mid-fanout does not take the broadcast down', () => {
    let failing = false;
    const hub = new StreamHub({
      statsIntervalMs: 10_000,
      stats: (): RelayStats => {
        if (failing) throw new Error('database handle is closed');
        return STATS;
      },
      log: silentLogger(),
    });
    const sockets = addAll(hub, 4);

    failing = true;
    expect(() => {
      hub.broadcastStats();
    }).not.toThrow();
    // No stats frame is invented from a failed read.
    for (const socket of sockets) expect(socket.sent).toHaveLength(1);

    // Drops still flow: only the stats read was broken, not the fan-out.
    hub.broadcastDrop(makeDrop(4));
    for (const socket of sockets) expect(socket.dropSeqs()).toEqual([4]);

    // And a subscriber joining during the outage is still registered.
    const joiner = new ScriptedSocket('during-outage');
    hub.add(joiner.asSocket());
    expect(hub.size).toBe(5);
    expect(joiner.sent).toHaveLength(0);
    hub.broadcastDrop(makeDrop(5));
    expect(joiner.sent).toHaveLength(1);
    hub.close();
  });
});
