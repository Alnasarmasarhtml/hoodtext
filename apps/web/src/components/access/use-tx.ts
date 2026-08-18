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
import type { Hex, TransactionReceipt } from 'viem';
import { usePublicClient } from 'wagmi';

import { ACTIVE_CHAIN_ID, explorerTxUrl } from '@/lib/chain';
import { describeChainError, type ChainErrorInfo } from './chain-errors';

export type TxPhase = 'idle' | 'signing' | 'confirming' | 'confirmed' | 'error';

export interface TxState {
  readonly phase: TxPhase;
  readonly hash: Hex | null;
  /** The successful receipt — lets panels read event logs for exact amounts. */
  readonly receipt: TransactionReceipt | null;
  readonly error: ChainErrorInfo | null;
  /** Explorer link for `hash`, or `null` on a chain with no explorer. */
  readonly explorerUrl: string | null;
  /** True while the wallet is open or the receipt is outstanding. */
  readonly busy: boolean;
  /**
   * Send, wait for the receipt, and resolve the SUCCESSFUL receipt — `null` on
   * any failure. Never throws: failures land in `error`. Returning the receipt
   * (truthy) rather than a boolean lets callers read event logs without going
   * through state, which would be a stale closure at the moment they need it.
   */
  readonly run: (send: () => Promise<Hex>, action: string) => Promise<TransactionReceipt | null>;
  readonly reset: () => void;
}

export function useTxState(): TxState {
  const publicClient = usePublicClient({ chainId: ACTIVE_CHAIN_ID });
  const [phase, setPhase] = useState<TxPhase>('idle');
  const [hash, setHash] = useState<Hex | null>(null);
  const [receipt, setReceipt] = useState<TransactionReceipt | null>(null);
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
    setReceipt(null);
    setError(null);
  }, []);

  const run = useCallback(
    async (send: () => Promise<Hex>, action: string): Promise<TransactionReceipt | null> => {
      if (aliveRef.current) {
        setPhase('signing');
        setHash(null);
        setReceipt(null);
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
        return null;
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
              'The transaction was submitted. This build has no read endpoint for the chain, so its receipt could not be verified. Check the explorer.',
            revertName: null,
          });
          setPhase('error');
        }
        return null;
      }

      let confirmedReceipt: TransactionReceipt;
      try {
        confirmedReceipt = await publicClient.waitForTransactionReceipt({
          hash: txHash,
        });
        if (confirmedReceipt.status !== 'success') {
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
          return null;
        }
      } catch (caught) {
        if (aliveRef.current) {
          setError(describeChainError(caught, { action }));
          setPhase('error');
        }
        return null;
      }

      if (aliveRef.current) {
        setReceipt(confirmedReceipt);
        setPhase('confirmed');
      }
      return confirmedReceipt;
    },
    [publicClient],
  );

  return {
    phase,
    hash,
    receipt,
    error,
    explorerUrl: hash === null ? null : explorerTxUrl(hash),
    busy: phase === 'signing' || phase === 'confirming',
    run,
    reset,
  };
}
