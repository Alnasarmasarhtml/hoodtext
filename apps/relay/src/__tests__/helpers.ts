/**
 * Shared test scaffolding.
 *
 * Every server here is built with an in-memory database and the indexer off, and
 * is driven through `.inject()` — no port is ever bound and no chain is ever
 * contacted. `env: {}` keeps the developer's real `.env` out of the tests.
 */

import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { RelayConfig } from '../config.js';
import type { DropRow } from '../db.js';
import { buildServer } from '../server.js';

export const BINARY = { 'content-type': 'application/octet-stream' } as const;

export async function newApp(overrides: Partial<RelayConfig> = {}): Promise<FastifyInstance> {
  return buildServer({
    env: {},
    config: {
      dbPath: ':memory:',
      indexerEnabled: false,
      logLevel: 'silent',
      ...overrides,
    },
  });
}

/** Deterministic 32-byte hex from a small integer. */
export function hex32(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(64, '0')}`;
}

/** Deterministic 20-byte hex address from a small integer. */
export function hex20(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(40, '0')}`;
}

export function makeDrop(seq: number, overrides: Partial<DropRow> = {}): DropRow {
  return {
    seq,
    convoId: hex32(1),
    poster: hex20(1),
    ephPub: hex32(seq + 1_000),
    blobRef: hex32(seq + 2_000),
    viewTag: seq % 256,
    size: 256,
    timestamp: 1_700_000_000 + seq,
    txHash: hex32(seq + 3_000),
    blockNumber: 100 + seq,
    ...overrides,
  };
}

/** A logger that swallows everything, for unit-testing pieces without a server. */
export function silentLogger(): FastifyBaseLogger {
  const noop = (): void => {};
  const logger = {
    level: 'silent',
    fatal: noop,
    error: noop,
    warn: noop,
    info: noop,
    debug: noop,
    trace: noop,
    silent: noop,
    child: (): unknown => logger,
  };
  return logger as unknown as FastifyBaseLogger;
}

/** Poll `predicate` until it holds or the budget expires. */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
  stepMs = 5,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  if (!predicate()) {
    throw new Error(`condition not met within ${timeoutMs}ms`);
  }
}
