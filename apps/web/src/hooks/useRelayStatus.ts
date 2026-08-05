'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { isDemoActive } from '@/lib/demo';
import { getHealth, type RelayHealth, type RelayStats, type RelayStreamStatus } from '@/lib/relay';
import { describeChainError } from './errors';
import {
  relayStreamLastEventAt,
  relayStreamStats,
  relayStreamStatus,
  subscribeToRelay,
} from './relay-stream';
import { useDemoActive } from './useDemoMode';

/** The indexer is considered behind past this many blocks. */
const LAG_THRESHOLD = 12;

export interface UseRelayStatusResult {
  readonly status: RelayStreamStatus;
  /** The socket is open and frames are arriving. */
  readonly isLive: boolean;
  readonly stats: RelayStats | null;
  readonly health: RelayHealth | null;
  /** Blocks the indexer is behind the chain head, or `null` when unknown. */
  readonly indexerLag: number | null;
  readonly isLagging: boolean;
  readonly error: string | null;
  /** `Date.now()` of the last frame of any kind. */
  readonly lastEventAt: number | null;
}

/**
 * Relay connectivity for the app chrome.
 *
 * The socket is shared app-wide (`relay-stream.ts`), so mounting this in
 * several places costs nothing. `/v1/health` is polled alongside it because the
 * stream staying open says nothing about whether the indexer is keeping up.
 */
export function useRelayStatus(active = true): UseRelayStatusResult {
  const demo = useDemoActive();
  const [status, setStatus] = useState<RelayStreamStatus>(() => relayStreamStatus());
  const [stats, setStats] = useState<RelayStats | null>(() => relayStreamStats());
  const [lastEventAt, setLastEventAt] = useState<number | null>(() => relayStreamLastEventAt());

  useEffect(() => {
    /* `isDemoActive()` is re-checked at effect time — the demo flag settles
       just after hydration, and a socket must never open in demo, not even
       for the frame between the two renders. */
    if (!active || isDemoActive()) return;
    return subscribeToRelay({
      onStatus: (next) => setStatus(next),
      onStats: (next) => {
        setStats(next);
        setLastEventAt(Date.now());
      },
      onDrop: () => setLastEventAt(Date.now()),
    });
  }, [active]);

  const healthQuery = useQuery<RelayHealth>({
    queryKey: ['relay', 'health'],
    queryFn: ({ signal }) =>
      isDemoActive()
        ? Promise.resolve<RelayHealth>({ ok: false, chainId: 0, block: 0, indexerLagBlocks: 0 })
        : getHealth({ signal }),
    refetchInterval: 20_000,
    staleTime: 10_000,
    retry: 1,
    enabled: active && !demo,
  });

  const health = healthQuery.data ?? null;
  const indexerLag = health === null ? null : health.indexerLagBlocks;

  return {
    status,
    isLive: status === 'open',
    stats,
    health,
    indexerLag,
    isLagging: indexerLag !== null && indexerLag > LAG_THRESHOLD,
    error:
      healthQuery.error === null
        ? null
        : describeChainError(healthQuery.error, 'The relay is unreachable.'),
    lastEventAt,
  };
}
