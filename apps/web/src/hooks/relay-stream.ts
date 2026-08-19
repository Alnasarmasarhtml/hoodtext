/**
 * One relay WebSocket for the whole app.
 *
 * `subscribeRelayStream` in `@/lib/relay` opens a socket per call. The
 * messenger needs the stream in at least two places at once (the drop engine
 * and the status chip), and a second socket would double the relay's fan-out
 * for no benefit — so this module owns exactly one connection and fans it out
 * to every listener, opening lazily on the first subscriber and closing on the
 * last.
 */
import {
  subscribeRelayStream,
  type DropRow,
  type RelayError,
  type RelayStats,
  type RelayStreamStatus,
} from '@/lib/relay';

export interface RelayStreamListener {
  readonly onDrop?: (drop: DropRow) => void;
  /** A sealed call-signalling frame for our tag. */
  readonly onSignal?: (blob: string) => void;
  readonly onStats?: (stats: RelayStats) => void;
  readonly onStatus?: (status: RelayStreamStatus) => void;
  readonly onError?: (error: RelayError) => void;
}

const listeners = new Set<RelayStreamListener>();

let teardown: (() => void) | null = null;
let status: RelayStreamStatus = 'closed';
/** Our call routing tag. Set before the socket opens; changing it reopens it. */
let callTag: string | null = null;
let latestStats: RelayStats | null = null;
let lastEventAt: number | null = null;

/** Current connection state without subscribing. */
export function relayStreamStatus(): RelayStreamStatus {
  return status;
}

/** Most recent stats frame, or `null` before the first one arrives. */
export function relayStreamStats(): RelayStats | null {
  return latestStats;
}

/** `Date.now()` of the last frame of any kind. */
export function relayStreamLastEventAt(): number | null {
  return lastEventAt;
}

function open(): void {
  if (teardown !== null) return;

  teardown = subscribeRelayStream({
    onDrop: (drop) => {
      lastEventAt = Date.now();
      for (const listener of [...listeners]) listener.onDrop?.(drop);
    },
    onSignal: (blob) => {
      lastEventAt = Date.now();
      for (const listener of [...listeners]) listener.onSignal?.(blob);
    },
    onStats: (stats) => {
      lastEventAt = Date.now();
      latestStats = stats;
      for (const listener of [...listeners]) listener.onStats?.(stats);
    },
    onStatus: (next) => {
      status = next;
      for (const listener of [...listeners]) listener.onStatus?.(next);
    },
    onError: (error) => {
      for (const listener of [...listeners]) listener.onError?.(error);
    },
    // A getter, so a reconnect after the identity unlocks still carries the tag.
  }, { callTag: () => callTag });
}

/**
 * Register the call tag this device listens on.
 *
 * Called once the identity is unlocked. If the socket is already open on a
 * different tag it is reopened, because the tag is part of the URL.
 */
export function setRelayCallTag(tag: string | null): void {
  if (callTag === tag) return;
  const hadNone = callTag === null;
  callTag = tag;
  // Reopen so the tag reaches the relay now rather than at the next reconnect.
  // Going from no tag to a tag is the case that matters: the socket is already
  // up (the messenger opened it) and would otherwise never register for calls.
  if (teardown !== null && (hadNone || tag === null)) {
    close();
    if (listeners.size > 0) open();
  }
}

function close(): void {
  const stop = teardown;
  teardown = null;
  status = 'closed';
  stop?.();
}

/**
 * Attach a listener; the socket is opened on the first one and closed shortly
 * after the last one detaches.
 *
 * The close is deferred by a tick so React StrictMode's mount → unmount →
 * mount cycle reuses the same connection instead of thrashing it.
 *
 * @returns an unsubscribe function. Safe to call more than once.
 */
export function subscribeToRelay(listener: RelayStreamListener): () => void {
  listeners.add(listener);
  open();

  // Replay what we already know so a late subscriber is not blank.
  if (status !== 'closed') listener.onStatus?.(status);
  if (latestStats !== null) listener.onStats?.(latestStats);

  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    listeners.delete(listener);
    if (listeners.size > 0) return;
    setTimeout(() => {
      if (listeners.size === 0) close();
    }, 250);
  };
}
