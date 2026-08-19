/**
 * TURN credential minting for 1:1 voice calls.
 *
 * A browser needs ICE servers to place a call, and TURN needs credentials. Those
 * credentials are minted from an account-wide API token that must never reach a
 * browser, so the relay holds the token and hands out short-lived credentials
 * instead. Cloudflare Realtime issues them per request with a TTL.
 *
 * What the TURN provider can and cannot see, stated plainly because the product
 * refuses to overclaim: it relays the media packets, so it sees BOTH PEERS' IP
 * ADDRESSES, the timing and the volume of a call. It cannot hear anything: the
 * audio is DTLS-SRTP encrypted end to end between the two browsers, and the keys
 * are never shared with it. Forcing every call through TURN is a deliberate
 * trade, it hides each caller's IP from the other person at the cost of showing
 * both to Cloudflare.
 */

import type { FastifyBaseLogger } from 'fastify';

import type { RelayConfig } from './config.js';

/** One entry of the `RTCPeerConnection` `iceServers` array. */
export interface IceServer {
  readonly urls: readonly string[];
  readonly username?: string;
  readonly credential?: string;
}

export interface TurnCredentials {
  readonly iceServers: readonly IceServer[];
  readonly ttlSeconds: number;
  /** Unix seconds after which these stop working. */
  readonly expiresAt: number;
}

/** Test seam: the one network call this module makes. */
export interface TurnPorts {
  mint(ttlSeconds: number): Promise<{ iceServers: readonly IceServer[] }>;
}

export class TurnDisabledError extends Error {
  constructor() {
    super('voice calling is not configured on this relay');
    this.name = 'TurnDisabledError';
  }
}

/** Live port: Cloudflare Realtime's credential endpoint. */
export function liveTurnPorts(config: RelayConfig): TurnPorts | null {
  const keyId = config.turnKeyId;
  const token = config.turnApiToken;
  if (keyId === null || token === null) return null;

  return {
    async mint(ttlSeconds) {
      const response = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ttl: ttlSeconds }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) {
        throw new Error(`turn provider http ${String(response.status)}`);
      }
      const body = (await response.json()) as { iceServers?: unknown };
      const servers = normalizeIceServers(body.iceServers);
      if (servers.length === 0) throw new Error('turn provider returned no ice servers');
      return { iceServers: servers };
    },
  };
}

/**
 * Accepts either shape Cloudflare has used (a single object or an array) and
 * keeps only well-formed entries, so a provider change cannot hand the browser
 * something `RTCPeerConnection` throws on.
 */
export function normalizeIceServers(raw: unknown): readonly IceServer[] {
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  const out: IceServer[] = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const urlsRaw = record['urls'];
    const urls = (Array.isArray(urlsRaw) ? urlsRaw : [urlsRaw]).filter(
      (url): url is string => typeof url === 'string' && url.length > 0,
    );
    if (urls.length === 0) continue;
    const username = record['username'];
    const credential = record['credential'];
    out.push({
      urls,
      ...(typeof username === 'string' ? { username } : {}),
      ...(typeof credential === 'string' ? { credential } : {}),
    });
  }
  return out;
}

export class TurnMinter {
  readonly #config: RelayConfig;
  readonly #log: FastifyBaseLogger;
  readonly #ports: TurnPorts | null;

  constructor(deps: { config: RelayConfig; log: FastifyBaseLogger; ports?: TurnPorts | null }) {
    this.#config = deps.config;
    this.#log = deps.log;
    this.#ports = deps.ports !== undefined ? deps.ports : liveTurnPorts(deps.config);
  }

  get enabled(): boolean {
    return this.#ports !== null;
  }

  /**
   * Mint a fresh short-lived credential.
   *
   * Deliberately NOT cached. A credential is bearer authority to relay traffic
   * on the account, so every caller gets their own with its own expiry rather
   * than sharing one long-lived secret that outlives the call.
   *
   * @throws {TurnDisabledError} when the relay has no TURN configuration.
   */
  async mint(): Promise<TurnCredentials> {
    const ports = this.#ports;
    if (ports === null) throw new TurnDisabledError();
    const ttlSeconds = this.#config.turnTtlSeconds;
    const { iceServers } = await ports.mint(ttlSeconds);
    this.#log.debug({ servers: iceServers.length, ttlSeconds }, 'turn: credentials minted');
    return {
      iceServers,
      ttlSeconds,
      expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds,
    };
  }
}
