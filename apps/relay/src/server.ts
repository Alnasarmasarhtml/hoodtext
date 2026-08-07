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
} from 'fastify';
import { z } from 'zod';
import { loadConfig, type RelayConfig } from './config.js';
import { RelayDb, type DropRow } from './db.js';
import { Indexer } from './indexer.js';
import { buildSendPorts } from './sender-chain.js';
import { SendPipeline, type BatchPoster, type ChainGate } from './sender.js';
import { StreamHub } from './stream.js';

declare module 'fastify' {
  interface FastifyInstance {
    readonly relayConfig: RelayConfig;
    readonly db: RelayDb;
    readonly indexer: Indexer;
    readonly stream: StreamHub;
    readonly sendPipeline: SendPipeline;
  }
}

export interface BuildServerOptions {
  /** Overrides applied on top of the parsed environment. */
  readonly config?: Partial<RelayConfig>;
  /** Environment to parse; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam: replaces the live-chain send ports (gate + poster). */
  readonly sendPorts?: { gate: ChainGate; poster: BatchPoster } | null;
}

export interface ErrorBody {
  readonly error: string;
  readonly message: string;
}

const HEX_64 = /^[0-9a-fA-F]{64}$/;
const CONVO_ID = /^0x[0-9a-fA-F]{64}$/;

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

  const app = Fastify({
    logger: config.logLevel === 'silent' ? false : { level: config.logLevel },
    bodyLimit: config.maxBlobBytes * 2,
    trustProxy: true,
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
  });
  app.register(websocket, {
    options: { maxPayload: config.maxBlobBytes },
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

  const HEX_32B = /^0x[0-9a-fA-F]{64}$/;
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

    instance.get('/v1/blob/:ref', async (request, reply) => {
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
    });

    instance.get('/v1/drops', async (request, reply) => {
      const query = DropsQuery.safeParse(request.query);
      if (!query.success) {
        return fail(reply, 400, 'invalid_query', firstIssue(query.error));
      }
      const { since, limit } = query.data;
      return reply.code(200).send({
        drops: instance.db.listDrops(since, limit),
        head: instance.db.head(),
      });
    });

    instance.get('/v1/drops/convo/:convoId', async (request, reply) => {
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
    });

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

    instance.get('/v1/stats', async (_request, reply) => {
      return reply.code(200).send(instance.db.stats());
    });

    instance.get('/v1/health', async (_request, reply) => {
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
      });
    });

    instance.get('/v1/stream', { websocket: true }, (socket) => {
      instance.stream.add(socket);
    });
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

  app.addHook('onReady', async () => {
    if (config.indexerEnabled) indexer.start();
    sendPipeline.start();
  });

  app.addHook('onClose', async () => {
    stream.close();
    await sendPipeline.stop();
    await indexer.stop();
    db.close();
  });

  try {
    await app.ready();
  } catch (error) {
    // `onClose` never runs for an instance that failed to boot, so release the
    // resources this function opened before rethrowing.
    stream.close();
    await sendPipeline.stop();
    await indexer.stop();
    db.close();
    throw error;
  }
  return app;
}
