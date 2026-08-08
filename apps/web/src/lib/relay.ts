import type { Address, Hex } from 'viem';

/**
 * Typed client for `@hoodgram/relay` (SPEC §6).
 *
 * Every response is validated at the boundary — the relay is a separate
 * process that can be older, newer, or briefly wrong, and the UI must degrade
 * into a designed empty state rather than crash on a shape it did not expect.
 */

/* ═════════════════════════════════════════════════════════════ types ════ */

export interface DropRow {
  readonly seq: number;
  readonly convoId: Hex;
  readonly poster: Address;
  readonly ephPub: Hex;
  readonly blobRef: Hex;
  readonly viewTag: number;
  readonly size: number;
  /** Unix seconds, as emitted by `Anchors.Dropped`. */
  readonly timestamp: number;
  readonly txHash: Hex;
  readonly blockNumber: number;
}

export interface RelayStats {
  readonly head: number;
  readonly totalDrops: number;
  readonly totalBlobs: number;
  readonly uniquePosters: number;
  readonly indexedBlock: number;
}

export interface RelayHealth {
  readonly ok: boolean;
  readonly chainId: number;
  readonly block: number;
  readonly indexerLagBlocks: number;
}

export interface DropPage {
  readonly drops: readonly DropRow[];
  readonly head: number;
}

export interface BlobReceipt {
  readonly blobRef: Hex;
}

/**
 * Max blob accepted by `POST /v1/blob` — the 4 MB media bucket plus the
 * 41-byte envelope overhead (version + nonce + MAC). Mirrors the relay's
 * `MAX_BLOB_BYTES`.
 */
export const MAX_BLOB_BYTES = 4_194_345;

/* ═════════════════════════════════════════════════════════════ errors ═══ */

export class RelayError extends Error {
  readonly route: string;
  readonly status: number | null;
  override readonly cause: unknown;

  constructor(
    message: string,
    options: { route: string; status?: number | null; cause?: unknown },
  ) {
    super(message);
    this.name = 'RelayError';
    this.route = options.route;
    this.status = options.status ?? null;
    this.cause = options.cause;
  }

  /** True when the relay answered but the resource does not exist. */
  get isNotFound(): boolean {
    return this.status === 404;
  }

  /** True when the relay could not be reached at all. */
  get isOffline(): boolean {
    return this.status === null;
  }
}

/**
 * Machine-readable slugs `POST /v1/send` rejects with. `rate_limited` and
 * `payload_too_large` come from the framework layer; the rest from the send
 * pipeline itself.
 */
export type SendRejectionCode =
  | 'send_disabled'
  | 'blob_missing'
  | 'unknown_key'
  | 'bad_signature'
  | 'not_activated'
  | 'room_inactive'
  | 'queue_full'
  | 'rate_limited'
  | 'invalid_body'
  | 'invalid_json'
  | 'unknown';

const SEND_REJECTION_CODES: readonly SendRejectionCode[] = [
  'send_disabled',
  'blob_missing',
  'unknown_key',
  'bad_signature',
  'not_activated',
  'room_inactive',
  'queue_full',
  'rate_limited',
  'invalid_body',
  'invalid_json',
];

function toSendRejectionCode(value: unknown): SendRejectionCode {
  return typeof value === 'string' &&
    (SEND_REJECTION_CODES as readonly string[]).includes(value)
    ? (value as SendRejectionCode)
    : 'unknown';
}

/** A `POST /v1/send` the relay answered with a rejection body. */
export class RelaySendError extends RelayError {
  /** Stable machine-readable slug, e.g. `not_activated`. */
  readonly code: SendRejectionCode;
  /** The relay's own human message, verbatim. */
  readonly serverMessage: string;

  constructor(options: {
    code: SendRejectionCode;
    serverMessage: string;
    status: number | null;
  }) {
    super(`Relay refused the drop (${options.code}): ${options.serverMessage}`, {
      route: '/v1/send',
      status: options.status,
    });
    this.name = 'RelaySendError';
    this.code = options.code;
    this.serverMessage = options.serverMessage;
  }
}

/* ═══════════════════════════════════════════════════════════ guards ═════ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function hex(value: unknown): Hex | null {
  return typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value) ? (value as Hex) : null;
}

function address(value: unknown): Address | null {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)
    ? (value as Address)
    : null;
}

/** Parse one drop row; returns `null` for anything malformed. */
export function parseDropRow(value: unknown): DropRow | null {
  if (!isRecord(value)) return null;

  const seq = num(value['seq']);
  const convoId = hex(value['convoId']);
  const poster = address(value['poster']);
  const ephPub = hex(value['ephPub']);
  const blobRef = hex(value['blobRef']);
  const viewTag = num(value['viewTag']);
  const size = num(value['size']);
  const timestamp = num(value['timestamp']);
  const txHash = hex(value['txHash']);
  const blockNumber = num(value['blockNumber']);

  if (
    seq === null ||
    convoId === null ||
    poster === null ||
    ephPub === null ||
    blobRef === null ||
    viewTag === null ||
    size === null ||
    timestamp === null ||
    txHash === null ||
    blockNumber === null
  ) {
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
    blockNumber,
  };
}

function parseDropRows(value: unknown): DropRow[] {
  if (!Array.isArray(value)) return [];
  const out: DropRow[] = [];
  for (const entry of value) {
    const row = parseDropRow(entry);
    if (row !== null) out.push(row);
  }
  return out;
}

function parseStats(value: unknown): RelayStats | null {
  if (!isRecord(value)) return null;
  const head = num(value['head']);
  const totalDrops = num(value['totalDrops']);
  const totalBlobs = num(value['totalBlobs']);
  const uniquePosters = num(value['uniquePosters']);
  const indexedBlock = num(value['indexedBlock']);
  if (
    head === null ||
    totalDrops === null ||
    totalBlobs === null ||
    uniquePosters === null ||
    indexedBlock === null
  ) {
    return null;
  }
  return { head, totalDrops, totalBlobs, uniquePosters, indexedBlock };
}

/* ══════════════════════════════════════════════════════════ endpoints ═══ */

function trimSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function readEnv(raw: string | undefined, fallback: string): string {
  return raw !== undefined && raw.trim() !== '' ? trimSlash(raw.trim()) : fallback;
}

/**
 * HTTP origin of the relay, e.g. `http://localhost:8787`.
 *
 * The loopback default is a DEVELOPMENT convenience only. It used to apply
 * everywhere, which meant an unconfigured production build shipped a page that
 * printed `http://localhost:8787` in its footer and made every visitor's browser
 * connect to a port on their own machine. A production build with nothing
 * configured now resolves to the empty string: requests fall back to the site's
 * own origin and fail cleanly, which is the correct behaviour for "there is no
 * relay yet".
 */
export const RELAY_URL = readEnv(
  process.env.NEXT_PUBLIC_RELAY_URL,
  process.env.NODE_ENV === 'production' ? '' : 'http://localhost:8787',
);

/**
 * Whether `RELAY_URL` names something a stranger could actually reach. Check
 * this before printing the relay anywhere on a public page.
 */
export const RELAY_IS_PUBLIC: boolean =
  RELAY_URL !== '' && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(RELAY_URL);

function defaultWsUrl(httpUrl: string): string {
  /* No relay configured means no stream. Returning `/v1/stream` here would give
     WebSocket a relative URL, which it rejects — producing a console error and
     a reconnect loop on a page that has nothing to connect to. */
  if (httpUrl === '') return '';
  if (httpUrl.startsWith('https://')) return `wss://${httpUrl.slice('https://'.length)}/v1/stream`;
  if (httpUrl.startsWith('http://')) return `ws://${httpUrl.slice('http://'.length)}/v1/stream`;
  return `${httpUrl}/v1/stream`;
}

/** WebSocket endpoint for `/v1/stream`. */
export const RELAY_WS_URL = readEnv(
  process.env.NEXT_PUBLIC_RELAY_WS,
  defaultWsUrl(RELAY_URL),
);

/* ═══════════════════════════════════════════════════════════ requests ═══ */

export interface RequestOptions {
  readonly signal?: AbortSignal;
  /** Abort after this many ms. Default 12000. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 12_000;

function withTimeout(options: RequestOptions | undefined): {
  signal: AbortSignal;
  done: () => void;
} {
  const controller = new AbortController();
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => {
    controller.abort(new DOMException('Relay request timed out', 'TimeoutError'));
  }, timeoutMs);

  const external = options?.signal;
  const forward = (): void => controller.abort(external?.reason);
  if (external !== undefined) {
    if (external.aborted) forward();
    else external.addEventListener('abort', forward, { once: true });
  }

  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', forward);
    },
  };
}

async function request(
  route: string,
  init: RequestInit,
  options?: RequestOptions,
): Promise<Response> {
  /* With no relay configured, `${RELAY_URL}${route}` is a same-origin path —
     so every call would quietly fetch our own static host and 404. Fail here
     instead, with a message that says what is actually wrong; every caller
     already handles RelayError by degrading into its empty state. */
  if (RELAY_URL === '') {
    throw new RelayError('No relay is configured for this build', { route });
  }

  const { signal, done } = withTimeout(options);
  try {
    const response = await fetch(`${RELAY_URL}${route}`, { ...init, signal });
    if (!response.ok) {
      throw new RelayError(`Relay ${route} responded ${response.status}`, {
        route,
        status: response.status,
      });
    }
    return response;
  } catch (error) {
    if (error instanceof RelayError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new RelayError(`Relay ${route} aborted`, { route, cause: error });
    }
    throw new RelayError(`Relay unreachable at ${RELAY_URL}${route}`, {
      route,
      cause: error,
    });
  } finally {
    done();
  }
}

async function getJson(route: string, options?: RequestOptions): Promise<unknown> {
  const response = await request(route, { method: 'GET', headers: { accept: 'application/json' } }, options);
  try {
    return (await response.json()) as unknown;
  } catch (error) {
    throw new RelayError(`Relay ${route} returned malformed JSON`, {
      route,
      status: response.status,
      cause: error,
    });
  }
}

/* ═══════════════════════════════════════════════════════════ REST API ═══ */

/**
 * `POST /v1/blob` — content-addressed and idempotent; the server recomputes
 * the sha256 and returns the canonical ref.
 */
export async function postBlob(
  blob: Uint8Array,
  options?: RequestOptions,
): Promise<BlobReceipt> {
  if (blob.byteLength === 0) {
    throw new RelayError('Refusing to upload an empty blob', { route: '/v1/blob' });
  }
  if (blob.byteLength > MAX_BLOB_BYTES) {
    throw new RelayError(
      `Blob is ${blob.byteLength} bytes; the relay accepts at most ${MAX_BLOB_BYTES}`,
      { route: '/v1/blob' },
    );
  }

  // Copy into a plain ArrayBuffer view: a `Uint8Array<ArrayBufferLike>` may be
  // backed by a SharedArrayBuffer, which `BodyInit` does not accept.
  const bytes = new Uint8Array(blob.byteLength);
  bytes.set(blob);

  const response = await request(
    '/v1/blob',
    {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Blob([bytes]),
    },
    options,
  );

  let json: unknown;
  try {
    json = (await response.json()) as unknown;
  } catch (error) {
    throw new RelayError('Relay returned malformed JSON for /v1/blob', {
      route: '/v1/blob',
      status: response.status,
      cause: error,
    });
  }

  const ref = isRecord(json) ? hex(json['blobRef']) : null;
  if (ref === null) {
    throw new RelayError('Relay did not return a blobRef', {
      route: '/v1/blob',
      status: response.status,
    });
  }
  return { blobRef: ref };
}

/** The exact on-chain fields of a drop, as `POST /v1/send` expects them. */
export interface SendDropFields {
  readonly convoId: Hex;
  readonly ephPub: Hex;
  readonly blobRef: Hex;
  readonly viewTag: number;
  readonly size: number;
}

export interface SendDropInput {
  /** The author's wallet address — never appears on chain on this path. */
  readonly sender: Address;
  /** Detached Ed25519 signature over the drop (`signDrop`). */
  readonly signature: Hex;
  readonly drop: SendDropFields;
}

export interface SendReceipt {
  readonly accepted: true;
  /** Drops sitting in the relay's queue after this one was admitted. */
  readonly queued: number;
}

/**
 * `POST /v1/send` — the gasless path. The relay verifies the Ed25519
 * signature against the sender's registered key, checks activation (and room
 * rent for room drops), then batches the anchor itself.
 *
 * The blob must already be uploaded (`postBlob`); confirmation is the WS
 * stream delivering a drop with the same `blobRef`, not this response.
 *
 * @throws {RelaySendError} for any rejection the relay answered with a body.
 * @throws {RelayError} when the relay is unreachable or answered garbage.
 */
export async function sendDrop(
  input: SendDropInput,
  options?: RequestOptions,
): Promise<SendReceipt> {
  const { signal, done } = withTimeout(options);
  let response: Response;
  try {
    response = await fetch(`${RELAY_URL}/v1/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(input),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new RelayError('Relay /v1/send aborted', { route: '/v1/send', cause: error });
    }
    throw new RelayError(`Relay unreachable at ${RELAY_URL}/v1/send`, {
      route: '/v1/send',
      cause: error,
    });
  } finally {
    done();
  }

  let json: unknown = null;
  try {
    json = (await response.json()) as unknown;
  } catch {
    /* A rejection with no body still maps onto a code below. */
  }
  const record = isRecord(json) ? json : {};

  if (!response.ok) {
    const message = record['message'];
    throw new RelaySendError({
      code: toSendRejectionCode(record['error']),
      serverMessage:
        typeof message === 'string' && message !== ''
          ? message
          : `the relay responded ${response.status}`,
      status: response.status,
    });
  }

  if (record['accepted'] !== true) {
    throw new RelayError('Relay /v1/send returned a malformed acceptance', {
      route: '/v1/send',
      status: response.status,
    });
  }
  return { accepted: true, queued: num(record['queued']) ?? 0 };
}

/**
 * `GET /v1/blob/:ref` — raw ciphertext envelope. Resolves to `null` when the
 * relay has never seen the ref (a 404 is an expected state, not a failure).
 */
export async function getBlob(
  blobRef: Hex,
  options?: RequestOptions,
): Promise<Uint8Array | null> {
  try {
    const response = await request(`/v1/blob/${blobRef}`, { method: 'GET' }, options);
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof RelayError && error.isNotFound) return null;
    throw error;
  }
}

/** `GET /v1/drops?since=&limit=` — the global anchor log. */
export async function getDrops(
  params: { since?: number; limit?: number } = {},
  options?: RequestOptions,
): Promise<DropPage> {
  const query = new URLSearchParams();
  if (params.since !== undefined) query.set('since', String(params.since));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  const serialized = query.toString();
  const suffix = serialized === '' ? '' : `?${serialized}`;

  const json = await getJson(`/v1/drops${suffix}`, options);
  const record = isRecord(json) ? json : {};
  const drops = parseDropRows(record['drops']);
  const head = num(record['head']);
  return { drops, head: head ?? (drops.length > 0 ? Math.max(...drops.map((d) => d.seq)) : 0) };
}

/** `GET /v1/drops/convo/:convoId?since=` — one conversation's anchors. */
export async function getConvoDrops(
  convoId: Hex,
  params: { since?: number } = {},
  options?: RequestOptions,
): Promise<readonly DropRow[]> {
  const query = new URLSearchParams();
  if (params.since !== undefined) query.set('since', String(params.since));
  const serialized = query.toString();
  const suffix = serialized === '' ? '' : `?${serialized}`;

  const json = await getJson(`/v1/drops/convo/${convoId}${suffix}`, options);
  return parseDropRows(isRecord(json) ? json['drops'] : null);
}

/** `GET /v1/stats` — the figures on the marketing page. */
export async function getStats(options?: RequestOptions): Promise<RelayStats> {
  const json = await getJson('/v1/stats', options);
  const stats = parseStats(json);
  if (stats === null) {
    throw new RelayError('Relay returned malformed stats', { route: '/v1/stats' });
  }
  return stats;
}

/** `GET /v1/health` — includes indexer lag, which is a real product signal. */
export async function getHealth(options?: RequestOptions): Promise<RelayHealth> {
  const json = await getJson('/v1/health', options);
  const record = isRecord(json) ? json : {};
  const chainId = num(record['chainId']);
  const block = num(record['block']);
  const lag = num(record['indexerLagBlocks']);
  if (chainId === null || block === null || lag === null) {
    throw new RelayError('Relay returned malformed health', { route: '/v1/health' });
  }
  return {
    ok: record['ok'] === true,
    chainId,
    block,
    indexerLagBlocks: lag,
  };
}

/* ════════════════════════════════════════════════════════════ stream ════ */

export type RelayStreamStatus =
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'closed'
  | 'unsupported';

export interface RelayStreamHandlers {
  /** A new anchor was indexed. */
  readonly onDrop?: (drop: DropRow) => void;
  /** Periodic stats push (every 10s). */
  readonly onStats?: (stats: RelayStats) => void;
  /** Connection lifecycle, for the "LIVE / RECONNECTING" chrome. */
  readonly onStatus?: (status: RelayStreamStatus) => void;
  /** Transport-level failure. The stream keeps retrying regardless. */
  readonly onError?: (error: RelayError) => void;
}

export interface RelayStreamOptions {
  /** Override the endpoint. Defaults to `NEXT_PUBLIC_RELAY_WS`. */
  readonly url?: string;
  /** First retry delay in ms. Default 500. */
  readonly baseDelayMs?: number;
  /** Retry ceiling in ms. Default 15000. */
  readonly maxDelayMs?: number;
}

/**
 * Subscribe to `WS /v1/stream` with automatic reconnection.
 *
 * Backoff is exponential with full jitter and a ceiling, and it resets on every
 * successful open. Coming back online or refocusing the tab short-circuits a
 * pending retry so the stream is live again immediately instead of after the
 * remaining backoff.
 *
 * @returns an unsubscribe function. Safe to call more than once.
 */
export function subscribeRelayStream(
  handlers: RelayStreamHandlers,
  options: RelayStreamOptions = {},
): () => void {
  const url = options.url ?? RELAY_WS_URL;
  const baseDelay = options.baseDelayMs ?? 500;
  const maxDelay = options.maxDelayMs ?? 15_000;

  if (typeof WebSocket === 'undefined') {
    handlers.onStatus?.('unsupported');
    return () => undefined;
  }

  /* No relay is configured for this build. Report it the same way as a browser
     without WebSocket — the UI already has a designed state for that — rather
     than opening a socket to nothing and retrying forever. */
  if (url === '') {
    handlers.onStatus?.('unsupported');
    return () => undefined;
  }

  let socket: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let stopped = false;

  const setStatus = (status: RelayStreamStatus): void => handlers.onStatus?.(status);

  const clearRetry = (): void => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const scheduleRetry = (): void => {
    if (stopped || retryTimer !== null) return;
    const ceiling = Math.min(maxDelay, baseDelay * 2 ** Math.min(attempt, 10));
    const delay = Math.round(ceiling * (0.5 + Math.random() * 0.5));
    attempt += 1;
    setStatus('reconnecting');
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
  };

  const handleMessage = (event: MessageEvent<unknown>): void => {
    if (typeof event.data !== 'string') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data) as unknown;
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;

    if (parsed['type'] === 'drop') {
      const drop = parseDropRow(parsed['drop']);
      if (drop !== null) handlers.onDrop?.(drop);
      return;
    }
    if (parsed['type'] === 'stats') {
      const stats = parseStats(parsed['stats']);
      if (stats !== null) handlers.onStats?.(stats);
    }
  };

  function connect(): void {
    if (stopped) return;
    setStatus(attempt === 0 ? 'connecting' : 'reconnecting');

    let next: WebSocket;
    try {
      next = new WebSocket(url);
    } catch (error) {
      handlers.onError?.(
        new RelayError(`Cannot open relay stream at ${url}`, {
          route: '/v1/stream',
          cause: error,
        }),
      );
      scheduleRetry();
      return;
    }

    socket = next;

    next.addEventListener('open', () => {
      if (stopped) {
        next.close();
        return;
      }
      attempt = 0;
      setStatus('open');
    });

    next.addEventListener('message', handleMessage);

    next.addEventListener('error', () => {
      handlers.onError?.(
        new RelayError('Relay stream error', { route: '/v1/stream' }),
      );
    });

    next.addEventListener('close', () => {
      if (socket === next) socket = null;
      if (stopped) {
        setStatus('closed');
        return;
      }
      scheduleRetry();
    });
  }

  const reviveNow = (): void => {
    if (stopped || socket !== null) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    clearRetry();
    attempt = 0;
    connect();
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('online', reviveNow);
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', reviveNow);
  }

  connect();

  return (): void => {
    if (stopped) return;
    stopped = true;
    clearRetry();
    if (typeof window !== 'undefined') window.removeEventListener('online', reviveNow);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', reviveNow);
    }
    const open = socket;
    socket = null;
    if (open !== null && (open.readyState === 0 || open.readyState === 1)) open.close();
    setStatus('closed');
  };
}
