/**
 * HTTP + websocket surface of `@hoodgram/relay` (SPEC §6).
 *
 * `buildServer()` returns a fully wired, *unlistening* Fastify instance so tests
 * can drive it with `.inject()` — no port, no chain.
 */

import cors, { type FastifyCorsOptions } from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyServerOptions,
} from 'fastify';
import { z } from 'zod';
import { BLOB_PRUNE_INTERVAL_MS, loadConfig, type RelayConfig } from './config.js';
import { RelayDb, type DropRow } from './db.js';
import { Indexer } from './indexer.js';
import { buildSendPorts } from './sender-chain.js';
import { PriceKeeper } from './price-keeper.js';
import { TurnDisabledError, TurnMinter } from './turn.js';
import { SendPipeline, type BatchPoster, type ChainGate } from './sender.js';
import type { TurnPorts } from './turn.js';
import { StreamHub } from './stream.js';

declare module 'fastify' {
  interface FastifyInstance {
    readonly relayConfig: RelayConfig;
    readonly db: RelayDb;
    readonly indexer: Indexer;
    readonly stream: StreamHub;
    readonly sendPipeline: SendPipeline;
    readonly priceKeeper: PriceKeeper;
    readonly turn: TurnMinter;
  }
}

export interface BuildServerOptions {
  /** Overrides applied on top of the parsed environment. */
  readonly config?: Partial<RelayConfig>;
  /** Environment to parse; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam: replaces the live-chain send ports (gate + poster). */
  readonly sendPorts?: { gate: ChainGate; poster: BatchPoster } | null;
  /** Test seam: replaces the live TURN provider. */
  readonly turnPorts?: TurnPorts | null;
  /**
   * Test seam: where the logger writes. Supplying it also forces a live logger
   * at `logLevel: 'silent'`, so a test can assert on what the relay logged —
   * the boot-time reverse-proxy warning has no other observable form.
   */
  readonly logDestination?: { write(line: string): void };
}

export interface ErrorBody {
  readonly error: string;
  readonly message: string;
}

const HEX_64 = /^[0-9a-fA-F]{64}$/;
const CONVO_ID = /^0x[0-9a-fA-F]{64}$/;
/** A call routing tag: the first 8 bytes of a hash of the recipient's registered key. */
const CALL_TAG = /^[0-9a-fA-F]{16}$/;

function normalizeBlobRef(raw: string): `0x${string}` | null {
  const body = raw.startsWith('0x') || raw.startsWith('0X') ? raw.slice(2) : raw;
  if (!HEX_64.test(body)) return null;
  return `0x${body.toLowerCase()}`;
}

function fail(reply: FastifyReply, status: number, error: string, message: string): FastifyReply {
  const body: ErrorBody = { error, message };
  return reply.code(status).send(body);
}

/**
 * Stable machine-readable slug for a failure, so clients never have to match on
 * a framework's internal error code. Fastify's own 413/429 paths are folded into
 * the same vocabulary the routes use.
 */
function errorSlug(status: number, error: FastifyError): string {
  if (status >= 500) return 'internal_error';
  switch (status) {
    case 404:
      return 'not_found';
    case 413:
      return 'payload_too_large';
    case 415:
      return 'unsupported_media_type';
    case 429:
      return 'rate_limited';
    default:
      return typeof error.code === 'string' && error.code.length > 0 ? error.code : 'bad_request';
  }
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return 'invalid request';
  const path = issue.path.join('.');
  return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
}

/**
 * Build the relay.
 *
 * The returned instance is booted (`ready()` has resolved) but is not listening.
 * Closing it releases the database handle, the websocket timer and the indexer.
 */
export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const config = loadConfig(options.env ?? process.env, options.config ?? {});

  const logger: FastifyServerOptions['logger'] =
    options.logDestination !== undefined
      ? {
          level: config.logLevel === 'silent' ? 'warn' : config.logLevel,
          stream: options.logDestination,
        }
      : config.logLevel === 'silent'
        ? false
        : { level: config.logLevel };

  const app = Fastify({
    logger,
    bodyLimit: config.maxBlobBytes * 2,
    // Every rate limit below is keyed on `request.ip`. Trusting X-Forwarded-For
    // unconditionally would let any caller mint a fresh bucket per request with
    // one header, so the default trusts nothing and a deployment behind N proxies
    // sets RELAY_TRUST_PROXY=N — which makes the IP the proxy saw authoritative.
    trustProxy: config.trustProxyHops === 0 ? false : config.trustProxyHops,
  });

  /**
   * Whether any request has arrived carrying `X-Forwarded-For`.
   *
   * With `trustProxyHops === 0` the relay is telling itself it is directly
   * exposed, so `request.ip` is whatever socket connected. Behind a proxy that is
   * the *proxy's* single address, and every per-IP ceiling below silently becomes
   * a ceiling for the entire user base combined — 30 `/v1/stream` handshakes a
   * minute for everyone, not per person. The knob to fix it (RELAY_TRUST_PROXY)
   * is invisible until something announces it, so this does.
   */
  let forwardedHeaderSeen = false;
  app.addHook('onRequest', async (request) => {
    if (forwardedHeaderSeen) return; // latched: no per-request cost afterwards
    if (request.headers['x-forwarded-for'] === undefined) return;
    forwardedHeaderSeen = true;
    if (config.trustProxyHops > 0) return;
    app.log.warn(
      { trustProxyHops: 0, envVar: 'RELAY_TRUST_PROXY' },
      'X-Forwarded-For seen but RELAY_TRUST_PROXY=0: this relay is behind a proxy, ' +
        'so every per-IP rate limit is keyed on the proxy address and applies to ALL ' +
        'users combined. Set RELAY_TRUST_PROXY to the number of trusted proxy hops.',
    );
  });

  // The only body this service accepts is an opaque ciphertext envelope, so every
  // content type is read as raw bytes and nothing is ever JSON-parsed on input.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });

  const db = RelayDb.open(config.dbPath);
  const stream = new StreamHub({
    statsIntervalMs: config.statsBroadcastMs,
    stats: () => db.stats(),
    log: app.log,
    maxClients: config.streamMaxClients,
  });
  const indexer = new Indexer({
    db,
    config,
    log: app.log,
    onDrop: (drop: DropRow) => {
      stream.broadcastDrop(drop);
    },
  });
  const sendPorts = options.sendPorts !== undefined ? options.sendPorts : buildSendPorts(config);
  const sendPipeline = new SendPipeline({
    gate: sendPorts?.gate ?? {
      ed25519KeyOf: () => Promise.resolve(null),
      isActivated: () => Promise.resolve(false),
      isRoomActive: () => Promise.resolve(false),
    },
    poster: sendPorts?.poster ?? null,
    log: app.log,
    flushMs: config.sendFlushMs,
    queueMax: config.sendQueueMax,
  });

  app.decorate('relayConfig', config);
  app.decorate('db', db);
  app.decorate('stream', stream);
  app.decorate('indexer', indexer);
  app.decorate('sendPipeline', sendPipeline);
  const priceKeeper = new PriceKeeper({ config, log: app.log });
  app.decorate('priceKeeper', priceKeeper);
  const turn = new TurnMinter({ config, log: app.log, ...(options.turnPorts !== undefined ? { ports: options.turnPorts } : {}) });
  app.decorate('turn', turn);

  const corsOptions: FastifyCorsOptions = {
    origin: config.webOrigins.includes('*') ? true : [...config.webOrigins],
    methods: ['GET', 'POST', 'OPTIONS'],
    maxAge: 86_400,
  };
  app.register(cors, corsOptions);
  app.register(rateLimit, {
    global: false,
    max: config.blobRateLimitMax,
    timeWindow: config.blobRateLimitWindow,
    // Each route that opts in gets its own LRU of this many keys, so the bound is
    // per route rather than global.
    cache: 5_000,
  });
  app.register(websocket, {
    // The relay registers no 'message' handler — `/v1/stream` is push-only — so
    // any inbound frame is discarded regardless. A 4 MiB allowance would only let
    // a client make the server buffer 4 MiB per frame for nothing.
    options: { maxPayload: 1_024 },
  });

  /** Per-route limiter config, `@fastify/rate-limit`'s `config.rateLimit` shape. */
  const readLimit = (max: number): { rateLimit: { max: number; timeWindow: string } } => ({
    rateLimit: { max, timeWindow: config.readRateLimitWindow },
  });

  const DropsQuery = z.object({
    // Capped at the safe-integer range: `seq` is bound straight into SQLite.
    since: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(config.dropsMaxLimit)
      .default(config.dropsDefaultLimit),
  });
  const ConvoParams = z.object({
    convoId: z.string().regex(CONVO_ID, 'must be a 32-byte hex string'),
  });
  const BlobParams = z.object({ ref: z.string().min(1) });

  /** A call routing tag: 16 hex chars, derived client-side from a registered key. */
  const SignalBody = z.object({
    to: z.string().regex(CALL_TAG, 'must be a 16-character hex call tag'),
    blob: z
      .string()
      .min(1)
      .max(config.signalMaxBytes)
      .regex(/^[A-Za-z0-9+/=]+$/, 'must be base64'),
  });

  const HEX_32B = /^0x[0-9a-fA-F]{64}$/;
  const SendStatusParams = z.object({
    blobRef: z.string().regex(HEX_32B, 'must be a 32-byte hex string'),
  });
  const SendBody = z.object({
    sender: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte hex address'),
    signature: z.string().regex(/^0x[0-9a-fA-F]{128}$/, 'must be a 64-byte hex signature'),
    drop: z.object({
      convoId: z.string().regex(HEX_32B, 'must be a 32-byte hex string'),
      ephPub: z.string().regex(HEX_32B, 'must be a 32-byte hex string'),
      blobRef: z.string().regex(HEX_32B, 'must be a 32-byte hex string'),
      viewTag: z.number().int().min(0).max(255),
      size: z.number().int().min(0).max(0xffffffff),
    }),
  });

  /** HTTP status for each machine-readable send rejection. */
  const SEND_REJECTION_STATUS: Record<string, number> = {
    unknown_key: 401,
    bad_signature: 401,
    not_activated: 403,
    room_inactive: 403,
    queue_full: 429,
  };

  // Routes live in their own plugin so `@fastify/websocket`'s `onRoute` hook is
  // guaranteed to be installed before `/v1/stream` is declared.
  app.register(async (instance) => {
    /** Content-addressed write. The client's idea of the ref is irrelevant. */
    instance.post(
      '/v1/blob',
      {
        bodyLimit: config.maxBlobBytes * 2,
        config: {
          rateLimit: { max: config.blobRateLimitMax, timeWindow: config.blobRateLimitWindow },
        },
      },
      async (request, reply) => {
        const body: unknown = request.body;
        if (!Buffer.isBuffer(body)) {
          return fail(
            reply,
            400,
            'invalid_body',
            'expected a raw binary body (content-type: application/octet-stream)',
          );
        }
        if (body.byteLength === 0) {
          return fail(reply, 400, 'empty_body', 'blob must not be empty');
        }
        if (body.byteLength > config.maxBlobBytes) {
          return fail(
            reply,
            413,
            'payload_too_large',
            `blob is ${body.byteLength} bytes; the maximum is ${config.maxBlobBytes}`,
          );
        }

        const { ref } = instance.db.putBlob(body);
        return reply.code(200).send({ blobRef: ref });
      },
    );

    instance.get(
      '/v1/blob/:ref',
      { config: readLimit(config.blobReadRateLimitMax) },
      async (request, reply) => {
        const params = BlobParams.safeParse(request.params);
        if (!params.success) {
          return fail(reply, 400, 'invalid_ref', firstIssue(params.error));
        }
        const ref = normalizeBlobRef(params.data.ref);
        if (ref === null) {
          return fail(reply, 400, 'invalid_ref', 'blob ref must be 32 bytes of hex');
        }
        const blob = instance.db.getBlob(ref);
        if (blob === null) {
          return fail(reply, 404, 'not_found', `no blob stored for ${ref}`);
        }
        return reply
          .code(200)
          .header('content-type', 'application/octet-stream')
          .header('content-length', String(blob.size))
          // Content-addressed: the bytes behind a ref can never change.
          .header('cache-control', 'public, max-age=31536000, immutable')
          .send(Buffer.from(blob.bytes.buffer, blob.bytes.byteOffset, blob.bytes.byteLength));
      },
    );

    instance.get(
      '/v1/drops',
      { config: readLimit(config.dropsRateLimitMax) },
      async (request, reply) => {
        const query = DropsQuery.safeParse(request.query);
        if (!query.success) {
          return fail(reply, 400, 'invalid_query', firstIssue(query.error));
        }
        const { since, limit } = query.data;
        return reply.code(200).send({
          drops: instance.db.listDrops(since, limit),
          head: instance.db.head(),
        });
      },
    );

    instance.get(
      '/v1/drops/convo/:convoId',
      { config: readLimit(config.dropsRateLimitMax) },
      async (request, reply) => {
        const params = ConvoParams.safeParse(request.params);
        if (!params.success) {
          return fail(reply, 400, 'invalid_convo_id', firstIssue(params.error));
        }
        const query = DropsQuery.safeParse(request.query);
        if (!query.success) {
          return fail(reply, 400, 'invalid_query', firstIssue(query.error));
        }
        const { since, limit } = query.data;
        const convoId = params.data.convoId.toLowerCase();
        return reply.code(200).send({ drops: instance.db.listDropsByConvo(convoId, since, limit) });
      },
    );

    /**
     * Gasless send. The client uploads its sealed blob first, then submits the
     * drop plus a detached Ed25519 identity signature; the relay verifies and
     * batch-posts it on chain from its own funded key. The sender pays nothing,
     * signs no transaction, and never appears on chain.
     */
    instance.post(
      '/v1/send',
      {
        config: {
          rateLimit: { max: config.blobRateLimitMax, timeWindow: config.blobRateLimitWindow },
        },
      },
      async (request, reply) => {
        if (!instance.sendPipeline.enabled()) {
          return fail(
            reply,
            503,
            'send_disabled',
            'this relay has no posting key configured; self-post via Anchors.post instead',
          );
        }

        const body: unknown = request.body;
        if (!Buffer.isBuffer(body)) {
          return fail(reply, 400, 'invalid_body', 'expected a JSON body');
        }
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(body.toString('utf8'));
        } catch {
          return fail(reply, 400, 'invalid_json', 'body is not valid JSON');
        }
        const parsed = SendBody.safeParse(parsedJson);
        if (!parsed.success) {
          return fail(reply, 400, 'invalid_body', firstIssue(parsed.error));
        }

        const { sender, signature, drop } = parsed.data;
        const blobRef = drop.blobRef.toLowerCase() as `0x${string}`;

        // The relay must be able to serve the ciphertext before it anchors a
        // reference to it — otherwise recipients would see a drop they can never fetch.
        if (!instance.db.hasBlob(blobRef)) {
          return fail(reply, 409, 'blob_missing', 'upload the sealed blob to /v1/blob first');
        }

        const result = await instance.sendPipeline.submit(
          sender.toLowerCase() as `0x${string}`,
          {
            convoId: drop.convoId.toLowerCase() as `0x${string}`,
            ephPub: drop.ephPub.toLowerCase() as `0x${string}`,
            blobRef,
            viewTag: drop.viewTag,
            size: drop.size,
          },
          signature.toLowerCase() as `0x${string}`,
        );

        if (!result.ok) {
          const status = SEND_REJECTION_STATUS[result.code] ?? 400;
          return fail(reply, status, result.code, result.message);
        }
        return reply.code(200).send({ accepted: true, queued: result.queued });
      },
    );

    /**
     * What became of a drop that `POST /v1/send` accepted.
     *
     * A 200 from `/v1/send` only means "queued", and a queued drop can still be
     * abandoned — its room's rent lapses before the batch lands, or the relayer
     * cannot reach the chain for `staleMs`. Without this route that outcome was
     * a log line the sender could never see. Reveals nothing new: the caller
     * already has to know the `blobRef` to ask, and `GET /v1/blob/:ref` already
     * confirms a ref exists.
     */
    instance.get(
      '/v1/send/:blobRef',
      { config: readLimit(config.dropsRateLimitMax) },
      async (request, reply) => {
        const params = SendStatusParams.safeParse(request.params);
        if (!params.success) {
          return fail(reply, 400, 'invalid_blob_ref', firstIssue(params.error));
        }
        const blobRef = params.data.blobRef.toLowerCase() as `0x${string}`;
        const status = instance.sendPipeline.statusOf(blobRef);
        if (status.status === 'failed') {
          return reply.code(200).send({
            blobRef,
            status: 'failed',
            reason: status.failure.reason,
            failedAt: status.failure.failedAt,
          });
        }
        return reply.code(200).send({ blobRef, status: status.status });
      },
    );

    instance.get(
      '/v1/stats',
      { config: readLimit(config.statsRateLimitMax) },
      async (_request, reply) => {
        return reply.code(200).send(instance.db.stats());
      },
    );

    instance.get(
      '/v1/health',
      { config: readLimit(config.healthRateLimitMax) },
      async (_request, reply) => {
        const status = instance.indexer.status();
        return reply.code(200).send({
          ok: true,
          chainId: status.chainId,
          block: status.headBlock,
          indexerLagBlocks: status.lagBlocks,
          indexer: {
            enabled: status.enabled,
            running: status.running,
            connected: status.connected,
            indexedBlock: status.indexedBlock,
            lastError: status.lastError,
          },
          send: {
            enabled: instance.sendPipeline.enabled(),
            queued: instance.sendPipeline.size(),
            // Non-zero means accepted messages were lost; it should be alerted on.
            abandoned: instance.sendPipeline.failureCount(),
          },
          // `forwardedHeaderSeen: true` with `trustedProxyHops: 0` is the
          // misconfiguration that turns every per-IP limit into a global one.
          proxy: {
            trustedProxyHops: config.trustProxyHops,
            forwardedHeaderSeen,
          },
          // The market-price keeper: strategy, on-chain vs target rate, and the
          // last failure. `lastError` non-null for long means the fee is stale.
          price: instance.priceKeeper.status(),
          // Voice calling: whether this relay can mint TURN credentials at all,
          // and how many sockets are currently reachable for a call.
          calls: { turn: instance.turn.enabled },
        });
      },
    );

    // The limiter runs in `onRequest`, which fires before the upgrade is hijacked,
    // so a throttled handshake is answered with a plain 429 and never becomes a
    // socket. This caps upgrade *churn*; `streamMaxClients` caps live sockets.
    /**
     * Short-lived ICE/TURN credentials for one call.
     *
     * Minted here rather than in the browser because the provider token is
     * account-wide authority that must never ship to a client.
     */
    instance.get(
      '/v1/turn',
      { config: readLimit(config.signalRateLimitMax) },
      async (_request, reply) => {
        if (!instance.turn.enabled) {
          return fail(
            reply,
            503,
            'turn_disabled',
            'This relay has no TURN configuration, so calls cannot connect.',
          );
        }
        try {
          const credentials = await instance.turn.mint();
          // Credentials are per-request and expire; never let a cache serve a
          // used one to somebody else.
          return reply.header('cache-control', 'no-store').code(200).send(credentials);
        } catch (error) {
          if (error instanceof TurnDisabledError) {
            return fail(reply, 503, 'turn_disabled', 'Calling is not configured on this relay.');
          }
          instance.log.error({ err: error }, 'turn: minting failed');
          return fail(
            reply,
            502,
            'turn_unavailable',
            'The TURN provider did not answer. Try the call again.',
          );
        }
      },
    );

    /**
     * One sealed call-signalling frame, routed to a tag and forgotten.
     *
     * Never persisted, never anchored, never queued: if nobody is listening on
     * the tag the frame is dropped. The response is deliberately identical
     * whether or not it was delivered, because tags are derivable from the
     * public key registry and a delivery count would turn this into a presence
     * oracle for anybody who wanted to know if you are online.
     */
    instance.post(
      '/v1/call/signal',
      {
        config: readLimit(config.signalRateLimitMax),
        bodyLimit: config.signalMaxBytes,
      },
      async (request, reply) => {
        const body: unknown = request.body;
        if (!Buffer.isBuffer(body)) {
          return fail(reply, 400, 'invalid_body', 'expected a JSON body');
        }
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(body.toString('utf8'));
        } catch {
          return fail(reply, 400, 'invalid_json', 'body is not valid JSON');
        }
        const parsed = SignalBody.safeParse(parsedJson);
        if (!parsed.success) {
          return fail(reply, 400, 'invalid_body', firstIssue(parsed.error));
        }
        instance.stream.routeSignal(parsed.data.to, parsed.data.blob);
        return reply.code(202).send({ accepted: true });
      },
    );

    instance.get(
      '/v1/stream',
      { websocket: true, config: readLimit(config.streamRateLimitMax) },
      (socket, request) => {
        const query = request.query as Record<string, unknown> | undefined;
        const raw = query?.['call'];
        const callTag = typeof raw === 'string' && CALL_TAG.test(raw) ? raw.toLowerCase() : undefined;
        instance.stream.add(socket, callTag);
      },
    );
  });

  app.setNotFoundHandler((request, reply) => {
    void fail(reply, 404, 'not_found', `${request.method} ${request.url} is not a relay route`);
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err: error }, 'relay request failed');
    }
    void fail(
      reply,
      status,
      errorSlug(status, error),
      // Never leak an internal failure's detail to the caller.
      status >= 500 ? 'internal relay error' : error.message,
    );
  });

  /**
   * Blob retention sweep. Armed here rather than in the indexer because the
   * indexer only runs when a chain is configured, and disk pressure does not wait
   * for that. `blobTtlDays === 0` means "keep forever", so the timer is never
   * armed at the shipped default and this is a no-op until an operator opts in.
   */
  let pruneTimer: NodeJS.Timeout | null = null;

  app.addHook('onReady', async () => {
    if (config.indexerEnabled) indexer.start();
    sendPipeline.start();
    if (config.priceKeeperEnabled) priceKeeper.start();
    if (config.blobTtlDays > 0) {
      pruneTimer = setInterval(() => {
        try {
          const removed = db.pruneBlobs(Date.now() - config.blobTtlDays * 86_400_000);
          // Deleting ciphertext is irreversible; a silent sweep would make lost
          // messages impossible to explain after the fact.
          if (removed > 0) app.log.info({ removed }, 'blob retention: pruned expired blobs');
        } catch (error) {
          app.log.error({ err: error }, 'blob retention: sweep failed');
        }
      }, BLOB_PRUNE_INTERVAL_MS);
      pruneTimer.unref();
    }
  });

  app.addHook('onClose', async () => {
    if (pruneTimer !== null) {
      clearInterval(pruneTimer);
      pruneTimer = null;
    }
    stream.close();
    await priceKeeper.stop();
    await sendPipeline.stop();
    await indexer.stop();
    db.close();
  });

  try {
    await app.ready();
  } catch (error) {
    // `onClose` never runs for an instance that failed to boot, so release the
    // resources this function opened before rethrowing.
    if (pruneTimer !== null) clearInterval(pruneTimer);
    stream.close();
    await sendPipeline.stop();
    await indexer.stop();
    db.close();
    throw error;
  }
  return app;
}
