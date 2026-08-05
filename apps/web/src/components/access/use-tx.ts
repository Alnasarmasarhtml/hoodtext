'use client';

/**
 * One transaction, four honest states.
 *
 * `signing` → the wallet is open. `confirming` → the hash exists and the
 * sequencer has it. `confirmed` → the receipt came back with status `success`.
 * `error` → a decoded {@link ChainErrorInfo}, never a raw stack.
 *
 * A reverted receipt is treated as a failure, because a mined-but-reverted
 * transaction spends gas and changes nothing — showing it as success would be
 * a lie about the user's money.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Hex } from 'viem';
import { usePublicClient } from 'wagmi';

import { ACTIVE_CHAIN_ID, explorerTxUrl } from '@/lib/chain';
import { describeChainError, type ChainErrorInfo } from './chain-errors';

export type TxPhase = 'idle' | 'signing' | 'confirming' | 'confirmed' | 'error';

export interface TxState {
  readonly phase: TxPhase;
  readonly hash: Hex | null;
  readonly error: ChainErrorInfo | null;
  /** Explorer link for `hash`, or `null` on a chain with no explorer. */
  readonly explorerUrl: string | null;
  /** True while the wallet is open or the receipt is outstanding. */
  readonly busy: boolean;
  /**
   * Send, wait for the receipt, and resolve `true` only when it succeeded.
   * Never throws: failures land in `error`.
   */
  readonly run: (send: () => Promise<Hex>, action: string) => Promise<boolean>;
  readonly reset: () => void;
}

export function useTxState(): TxState {
  const publicClient = usePublicClient({ chainId: ACTIVE_CHAIN_ID });
  const [phase, setPhase] = useState<TxPhase>('idle');
  const [hash, setHash] = useState<Hex | null>(null);
  const [error, setError] = useState<ChainErrorInfo | null>(null);

  /* A tx can outlive the panel that started it; never set state after unmount. */
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const reset = useCallback((): void => {
    if (!aliveRef.current) return;
    setPhase('idle');
    setHash(null);
    setError(null);
  }, []);

  const run = useCallback(
    async (send: () => Promise<Hex>, action: string): Promise<boolean> => {
      if (aliveRef.current) {
        setPhase('signing');
        setHash(null);
        setError(null);
      }

      let txHash: Hex;
      try {
        txHash = await send();
      } catch (caught) {
        if (aliveRef.current) {
          setError(describeChainError(caught, { action }));
          setPhase('error');
        }
        return false;
      }

      if (aliveRef.current) {
        setHash(txHash);
        setPhase('confirming');
      }

      if (publicClient === undefined) {
        /* No read client for this chain: the transaction is out there, but we
           cannot honestly claim it confirmed. */
        if (aliveRef.current) {
          setError({
            kind: 'network',
            title: 'Sent, but not confirmed here',
            detail:
              'The transaction was submitted. This build has no read endpoint for the chain, so its receipt could not be verified — check the explorer.',
            revertName: null,
          });
          setPhase('error');
        }
        return false;
      }

      try {
        const receipt = await publicClient.waitForTransactionReceipt({
          hash: txHash,
        });
        if (receipt.status !== 'success') {
          if (aliveRef.current) {
            setError({
              kind: 'reverted',
              title: 'Reverted on chain',
              detail:
                'The transaction was mined but reverted, so nothing changed. Gas was still spent.',
              revertName: null,
            });
            setPhase('error');
          }
          return false;
        }
      } catch (caught) {
        if (aliveRef.current) {
          setError(describeChainError(caught, { action }));
          setPhase('error');
        }
        return false;
      }

      if (aliveRef.current) setPhase('confirmed');
      return true;
    },
    [publicClient],
  );

  return {
    phase,
    hash,
    error,
    explorerUrl: hash === null ? null : explorerTxUrl(hash),
    busy: phase === 'signing' || phase === 'confirming',
    run,
    reset,
  };
}
