'use client';

/**
 * Handle and perk-tier resolution, with an in-memory cache.
 *
 * `handleOf` and `tierOf` are pure view calls that get asked for the same
 * addresses over and over — every message row, every rail entry. The cache is
 * module-level so all hook instances share one entry per address, in-flight
 * reads are de-duplicated, and results are held for a TTL rather than
 * per-component.
 */

import { useEffect, useState } from 'react';
import { isAddress, type Address } from 'viem';
import { useConfig } from 'wagmi';
import { readContract } from 'wagmi/actions';
import type { Config } from 'wagmi';

import { handlesAbi, perksAbi } from '@/lib/abi';
import { ACTIVE_CHAIN_ID, tryGetContracts } from '@/lib/chain';

/** How long a resolved handle / tier is trusted before re-reading. */
const TTL_MS = 5 * 60_000;

/** `@name` shape: 2–15 chars, a–z 0–9 _, starting with a letter. */
export const HANDLE_RE = /^[a-z][a-z0-9_]{1,14}$/;

interface CacheEntry<T> {
  readonly value: T;
  readonly at: number;
}

interface ResolverCache<T> {
  readonly entries: Map<string, CacheEntry<T>>;
  readonly inflight: Map<string, Promise<T>>;
  readonly listeners: Set<() => void>;
}

function createCache<T>(): ResolverCache<T> {
  return { entries: new Map(), inflight: new Map(), listeners: new Set() };
}

const handleCache = createCache<string | null>();
const tierCache = createCache<number>();

function notify<T>(cache: ResolverCache<T>): void {
  for (const listener of [...cache.listeners]) listener();
}

function cached<T>(cache: ResolverCache<T>, key: string): CacheEntry<T> | null {
  const entry = cache.entries.get(key);
  if (entry === undefined) return null;
  return Date.now() - entry.at > TTL_MS ? null : entry;
}

async function resolveThrough<T>(
  cache: ResolverCache<T>,
  key: string,
  fetcher: () => Promise<T>,
): Promise<T> {
  const fresh = cached(cache, key);
  if (fresh !== null) return fresh.value;

  const running = cache.inflight.get(key);
  if (running !== undefined) return running;

  const promise = fetcher()
    .then((value) => {
      cache.entries.set(key, { value, at: Date.now() });
      cache.inflight.delete(key);
      notify(cache);
      return value;
    })
    .catch((error: unknown) => {
      cache.inflight.delete(key);
      throw error;
    });
  cache.inflight.set(key, promise);
  return promise;
}

async function fetchHandle(config: Config, address: Address): Promise<string | null> {
  const contracts = tryGetContracts(ACTIVE_CHAIN_ID);
  if (contracts === null) return null;
  const name = await readContract(config, {
    address: contracts.handles,
    abi: handlesAbi,
    functionName: 'handleOf',
    args: [address],
    chainId: ACTIVE_CHAIN_ID,
  });
  return name === '' ? null : name;
}

async function fetchTier(config: Config, address: Address): Promise<number> {
  const contracts = tryGetContracts(ACTIVE_CHAIN_ID);
  if (contracts === null) return 0;
  const tier = await readContract(config, {
    address: contracts.perks,
    abi: perksAbi,
    functionName: 'tierOf',
    args: [address],
    chainId: ACTIVE_CHAIN_ID,
  });
  return Number(tier);
}

/** Generic subscription to one cache key. */
function useResolved<T>(
  cache: ResolverCache<T>,
  address: Address | null | undefined,
  fetcher: (config: Config, address: Address) => Promise<T>,
  fallback: T,
): T {
  const config = useConfig();
  const key = address === null || address === undefined ? null : address.toLowerCase();
  const [, bump] = useState(0);

  useEffect(() => {
    if (key === null) return;
    const listener = (): void => bump((n) => n + 1);
    cache.listeners.add(listener);

    if (cached(cache, key) === null) {
      void resolveThrough(cache, key, () => fetcher(config, key as Address)).catch(() => {
        /* Resolution is decoration — a failed read renders as the address. */
      });
    }
    return () => {
      cache.listeners.delete(listener);
    };
  }, [cache, config, fetcher, key]);

  if (key === null) return fallback;
  return cached(cache, key)?.value ?? fallback;
}

/**
 * The `@handle` registered for an address, or `null`.
 *
 * Cached and shared across every caller; a missing handle is itself cached so
 * bare addresses do not re-query on every row.
 */
export function useHandle(address: Address | null | undefined): string | null {
  return useResolved(handleCache, address, fetchHandle, null);
}

/** `Perks.tierOf(address)` — 0 (none) to 4 (KINGPIN). Cached like handles. */
export function usePerkTier(address: Address | null | undefined): number {
  return useResolved(tierCache, address, fetchTier, 0);
}

/**
 * Display name for an address: `@handle` when one resolves, otherwise the
 * caller's fallback (usually a truncated address).
 */
export function useDisplayName(
  address: Address | null | undefined,
  fallback: string,
): string {
  const handle = useHandle(address);
  return handle === null ? fallback : `@${handle}`;
}

/* ═══════════════════════════════════════════ recipient resolution ═══════ */

export interface ResolvedRecipient {
  readonly address: Address;
  /** Set when the input was a handle. */
  readonly handle: string | null;
}

export type RecipientFailure =
  | { readonly reason: 'invalid'; readonly message: string }
  | { readonly reason: 'unclaimed'; readonly message: string }
  | { readonly reason: 'chain'; readonly message: string };

export type RecipientResult =
  | { readonly ok: true; readonly recipient: ResolvedRecipient }
  | { readonly ok: false; readonly failure: RecipientFailure };

const ZERO_ADDRESS = `0x${'00'.repeat(20)}`;

/**
 * Turns user input — `0x…`, `@name` or a bare handle — into an address.
 *
 * Pure async function rather than a hook so start-conversation and add-member
 * flows can share it.
 */
export async function resolveRecipient(
  config: Config,
  raw: string,
): Promise<RecipientResult> {
  const trimmed = raw.trim();

  if (isAddress(trimmed, { strict: false })) {
    return { ok: true, recipient: { address: trimmed as Address, handle: null } };
  }

  const name = (trimmed.startsWith('@') ? trimmed.slice(1) : trimmed).toLowerCase();
  if (!HANDLE_RE.test(name)) {
    return {
      ok: false,
      failure: {
        reason: 'invalid',
        message:
          'Enter a wallet address (0x…) or a handle — 2–15 characters, a–z 0–9 _, starting with a letter.',
      },
    };
  }

  const contracts = tryGetContracts(ACTIVE_CHAIN_ID);
  if (contracts === null) {
    return {
      ok: false,
      failure: {
        reason: 'chain',
        message: 'TeleHood is not configured for this chain, so handles cannot be resolved.',
      },
    };
  }

  try {
    const address = await readContract(config, {
      address: contracts.handles,
      abi: handlesAbi,
      functionName: 'addressOf',
      args: [name],
      chainId: ACTIVE_CHAIN_ID,
    });
    if (address.toLowerCase() === ZERO_ADDRESS) {
      return {
        ok: false,
        failure: {
          reason: 'unclaimed',
          message: `Nobody has claimed @${name}. Check the spelling, or use their wallet address.`,
        },
      };
    }
    /* Prime the reverse cache so the fresh thread shows the handle at once. */
    handleCache.entries.set(address.toLowerCase(), { value: name, at: Date.now() });
    notify(handleCache);
    return { ok: true, recipient: { address, handle: name } };
  } catch {
    return {
      ok: false,
      failure: {
        reason: 'chain',
        message: 'The handle registry could not be read. Check your connection and try again.',
      },
    };
  }
}
