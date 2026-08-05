'use client';

import type { IdentityKeys } from '@telehood/crypto';
import { useCallback, useEffect } from 'react';
import type { Address, Hex } from 'viem';
import { useConfig } from 'wagmi';
import { readContract } from 'wagmi/actions';

import { keyRegistryAbi } from '@/lib/abi';
import { ACTIVE_CHAIN_ID, tryGetContracts } from '@/lib/chain';
import {
  attachMessenger,
  detachMessenger,
  rescanMessengerFromGenesis,
  resyncMessenger,
  useMessengerStore,
  type PeerKeyResolver,
} from './messenger-store';
import type { TamperEvent } from './types';

const ZERO_KEY: Hex = `0x${'00'.repeat(32)}`;

export interface UseDropsParams {
  readonly owner: Address | null;
  readonly keys: IdentityKeys | null;
  /** Defaults to true; pass false to hold the engine while a gate is open. */
  readonly enabled?: boolean;
}

export interface UseDropsResult {
  /** The IndexedDB cache has been read; history is on screen. */
  readonly isHydrated: boolean;
  readonly isBackfilling: boolean;
  readonly scannedSeq: number;
  readonly head: number;
  /** Anchors examined this session. */
  readonly scanned: number;
  /** View-tag matches this session, before decryption. */
  readonly matched: number;
  /** Blobs whose bytes did not hash to the on-chain `blobRef`. */
  readonly tamperEvents: readonly TamperEvent[];
  readonly error: string | null;
  /** Sweep forward from the stored cursor. */
  resync: () => void;
  /** Re-scan the entire log from seq 0 — recovery after a cleared cache. */
  rescan: () => void;
}

/**
 * The receive side (SPEC §7.3).
 *
 * Mount this exactly once, in the app shell: it backfills `GET /v1/drops`,
 * follows the relay WebSocket, runs `scanMatches` over every anchor, verifies
 * each fetched blob against the `blobRef` recorded on chain, and opens what is
 * ours. Everything else in the messenger reads the result out of the store.
 */
export function useDrops({ owner, keys, enabled = true }: UseDropsParams): UseDropsResult {
  const config = useConfig();
  const contracts = tryGetContracts(ACTIVE_CHAIN_ID);
  const registry = contracts === null ? null : contracts.keyRegistry;

  /**
   * Attribution: a drop carries the poster's address on chain, so their
   * registered X25519 key gives us the conversation. Senders who never
   * registered — and relayed posts, where the poster is not the author — fall
   * into the unattributed bucket instead of being dropped.
   */
  const resolvePeerKeys = useCallback<PeerKeyResolver>(
    async (addresses) => {
      const out = new Map<string, Hex>();
      if (registry === null || addresses.length === 0) return out;

      const results = await Promise.all(
        addresses.map(async (candidate): Promise<readonly [Address, Hex | null]> => {
          try {
            const keysOf = await readContract(config, {
              address: registry,
              abi: keyRegistryAbi,
              functionName: 'keysOf',
              args: [candidate],
              chainId: ACTIVE_CHAIN_ID,
            });
            return [candidate, keysOf[0]] as const;
          } catch {
            return [candidate, null] as const;
          }
        }),
      );

      for (const [candidate, key] of results) {
        if (key === null || key.toLowerCase() === ZERO_KEY) continue;
        out.set(candidate.toLowerCase(), key);
      }
      return out;
    },
    [config, registry],
  );

  useEffect(() => {
    if (!enabled || owner === null || keys === null) return;
    attachMessenger({ owner, keys, resolvePeerKeys });
    return () => detachMessenger();
  }, [enabled, keys, owner, resolvePeerKeys]);

  const isHydrated = useMessengerStore((state) => state.hydrated);
  const isBackfilling = useMessengerStore((state) => state.backfilling);
  const scannedSeq = useMessengerStore((state) => state.scannedSeq);
  const head = useMessengerStore((state) => state.head);
  const scanned = useMessengerStore((state) => state.scanned);
  const matched = useMessengerStore((state) => state.matched);
  const tamperEvents = useMessengerStore((state) => state.tamperEvents);
  const error = useMessengerStore((state) => state.error);

  return {
    isHydrated,
    isBackfilling,
    scannedSeq,
    head,
    scanned,
    matched,
    tamperEvents,
    error,
    resync: resyncMessenger,
    rescan: rescanMessengerFromGenesis,
  };
}
