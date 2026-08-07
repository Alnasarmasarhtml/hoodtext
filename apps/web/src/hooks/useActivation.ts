'use client';

import { useCallback } from 'react';
import type { Address } from 'viem';
import { useAccount, useReadContract } from 'wagmi';

import { activationAbi } from '@/lib/abi';
import { ACTIVE_CHAIN_ID, tryGetContracts } from '@/lib/chain';
import { DEMO_ACCESS } from '@/lib/demo';
import { describeChainError } from './errors';
import { useDemoActive } from './useDemoMode';

const noop = (): void => undefined;

/** The fixture activation the demo session presents: paid 19 days ago. */
const DEMO_ACTIVATION: UseActivationResult = {
  isActivated: true,
  activatedAt: Math.floor(DEMO_ACCESS.activatedAt / 1000),
  quote: DEMO_ACCESS.activationQuote,
  priceUsd: 5n * 10n ** 18n,
  isLoading: false,
  isDeployed: true,
  error: null,
  refetch: noop,
};

/** How often activation is re-read; it only ever flips false → true. */
const REFRESH_MS = 30_000;

export interface UseActivationResult {
  /** `Activation.isActivated(user)` — the single gate for sending. */
  readonly isActivated: boolean;
  /** Unix seconds of activation. `0` when the wallet has never activated. */
  readonly activatedAt: number;
  /** `quote()` — the live $5 in $GRAM wei, at today's rate. */
  readonly quote: bigint | null;
  /** `priceUsd()` — the activation price, 18-decimal USD. */
  readonly priceUsd: bigint | null;
  readonly isLoading: boolean;
  readonly isDeployed: boolean;
  readonly error: string | null;
  refetch: () => void;
}

/**
 * Live activation state for one wallet.
 *
 * Activation is the whole economics of an account: $5 in $GRAM, once,
 * forever. No tiers, no expiry, no renewals — so unlike the old subscription
 * read there is no countdown here and never will be. Nothing here gates
 * *reading*: an unactivated wallet keeps its keys, its history and the
 * ability to receive; only sending waits for the $5.
 */
export function useActivation(user?: Address | null): UseActivationResult {
  const demo = useDemoActive();
  const { address, chainId } = useAccount();
  const target = user ?? address ?? null;
  const contracts = tryGetContracts(ACTIVE_CHAIN_ID);
  const onActiveChain = chainId === undefined || chainId === ACTIVE_CHAIN_ID;
  const enabled = contracts !== null && target !== null && onActiveChain && !demo;

  const base = {
    chainId: ACTIVE_CHAIN_ID,
    abi: activationAbi,
    ...(contracts === null ? {} : { address: contracts.activation }),
  } as const;

  const activatedRead = useReadContract({
    ...base,
    functionName: 'isActivated',
    args: target === null ? undefined : [target],
    query: { enabled, refetchInterval: REFRESH_MS },
  });

  const activatedAtRead = useReadContract({
    ...base,
    functionName: 'activatedAt',
    args: target === null ? undefined : [target],
    query: { enabled, refetchInterval: REFRESH_MS },
  });

  const quoteRead = useReadContract({
    ...base,
    functionName: 'quote',
    query: { enabled: contracts !== null && onActiveChain && !demo, staleTime: 60_000 },
  });

  const priceRead = useReadContract({
    ...base,
    functionName: 'priceUsd',
    query: { enabled: contracts !== null && onActiveChain && !demo, staleTime: 5 * 60_000 },
  });

  const refetch = useCallback((): void => {
    void activatedRead.refetch();
    void activatedAtRead.refetch();
    void quoteRead.refetch();
  }, [activatedAtRead, activatedRead, quoteRead]);

  const error =
    activatedRead.error !== null
      ? describeChainError(activatedRead.error, 'Your activation could not be read.')
      : null;

  /* Demo: the account was "activated 19 days ago" and every read is inert. */
  if (demo) return DEMO_ACTIVATION;

  return {
    isActivated: activatedRead.data ?? false,
    activatedAt: activatedAtRead.data === undefined ? 0 : Number(activatedAtRead.data),
    quote: quoteRead.data ?? null,
    priceUsd: priceRead.data ?? null,
    isLoading: enabled && activatedRead.isPending,
    isDeployed: contracts !== null,
    error,
    refetch,
  };
}
