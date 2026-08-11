'use client';

import {
  IDENTITY_DOMAIN,
  IDENTITY_MESSAGE,
  IDENTITY_TYPES,
  deriveIdentity,
  type IdentityKeys,
} from '@hoodgram/crypto';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { bytesToHex, type Address, type Hex } from 'viem';
import { useAccount, useAccountEffect, useConfig, useReadContract, useSignTypedData, useWriteContract } from 'wagmi';
import { waitForTransactionReceipt } from 'wagmi/actions';

import { keyRegistryAbi } from '@/lib/abi';
import { ACTIVE_CHAIN_ID, tryGetContracts } from '@/lib/chain';
import { describeChainError } from './errors';
import { StorageUnavailableError } from './idb';
import { loadIdentity, saveIdentity, wipeIdentity } from './identity-store';
import { wipeMessenger } from './messenger-store';

const ZERO_KEY: Hex = `0x${'00'.repeat(32)}`;

/**
 * Wallets refuse `eth_signTypedData_v4` when the domain's `chainId` is not the active one. Our
 * domain is pinned to 4663 so an identity never changes with the network (see IDENTITY_DOMAIN in
 * `@hoodgram/crypto`), which means this fires only for a developer pointed at a local chain with a
 * different id — never for a user on Robinhood Chain.
 */
function isDomainChainMismatch(error: unknown): boolean {
  /* viem nests the provider's message several causes deep, so walk the chain. */
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 8; depth += 1) {
    if (/must match the active chain/i.test(current.message)) return true;
    current = current.cause;
  }
  return false;
}

/**
 * `idle`         — no wallet connected.
 * `wrong-network`— connected, but not to the chain this build targets.
 * `not-deployed` — this build has no contract addresses for the active chain.
 * `loading`      — reading the local key cache or the on-chain registry.
 * `locked`       — connected, but this device has no keys: one signature needed.
 * `unlocking`    — awaiting the identity signature.
 * `unregistered` — keys derived, but `KeyRegistry` does not hold them yet.
 * `registering`  — the `register()` transaction is in flight.
 * `ready`        — keys derived and published; the messenger can run.
 */
export type IdentityStatus =
  | 'idle'
  | 'wrong-network'
  | 'not-deployed'
  | 'loading'
  | 'locked'
  | 'unlocking'
  | 'unregistered'
  | 'registering'
  | 'ready';

export interface UseIdentityResult {
  readonly status: IdentityStatus;
  readonly address: Address | null;
  readonly keys: IdentityKeys | null;
  readonly x25519Pub: Hex | null;
  readonly ed25519Pub: Hex | null;
  /** What `KeyRegistry` currently holds for this wallet. */
  readonly onChain: { readonly x25519: Hex; readonly ed25519: Hex; readonly updatedAt: number } | null;
  readonly isReady: boolean;
  readonly isBusy: boolean;
  /** True when the registry holds *different* keys, so registering rotates them. */
  readonly isRotation: boolean;
  readonly error: string | null;
  /** Set when the identity could not be cached; the user must sign each visit. */
  readonly storageWarning: string | null;
  readonly registerTxHash: Hex | null;
  /** Sign the EIP-712 identity message and derive the keypairs. */
  unlock: () => void;
  /** Publish the derived public keys to `KeyRegistry`. */
  register: () => void;
  /** Forget the cached keys for this address on this device. */
  forget: () => void;
  clearError: () => void;
}

type Phase = 'loading' | 'idle' | 'unlocking' | 'registering';

/**
 * The one-time identity ceremony (SPEC §7.3).
 *
 * The signature is over the fixed EIP-712 payload from `@hoodgram/crypto`, so
 * the derivation is deterministic across devices — the same wallet always
 * reproduces the same messaging keys, and nothing secret is ever transmitted.
 *
 * Intended to be mounted once, by the app shell, and shared downwards.
 */
export function useIdentity(): UseIdentityResult {
  const { address, chainId, isConnected } = useAccount();
  const config = useConfig();
  const { signTypedDataAsync } = useSignTypedData();
  const { writeContractAsync } = useWriteContract();

  const [keys, setKeys] = useState<IdentityKeys | null>(null);
  const [keyOwner, setKeyOwner] = useState<Address | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [storageWarning, setStorageWarning] = useState<string | null>(null);
  const [registerTxHash, setRegisterTxHash] = useState<Hex | null>(null);

  const lastAddressRef = useRef<Address | null>(null);
  const contracts = tryGetContracts(ACTIVE_CHAIN_ID);
  const wrongNetwork = isConnected && chainId !== undefined && chainId !== ACTIVE_CHAIN_ID;

  /* ── the cached keys for whichever address is connected ─────────────── */
  useEffect(() => {
    let cancelled = false;

    if (address === undefined) {
      setKeys(null);
      setKeyOwner(null);
      setPhase('idle');
      return;
    }

    lastAddressRef.current = address;
    setPhase('loading');
    setError(null);
    setRegisterTxHash(null);

    void loadIdentity(address).then((found) => {
      if (cancelled) return;
      setKeys(found);
      setKeyOwner(found === null ? null : address);
      setPhase('idle');
    });

    return () => {
      cancelled = true;
    };
  }, [address]);

  /* ── disconnect wipes every trace of the identity from this device ──── */
  useAccountEffect({
    onDisconnect: () => {
      const previous = lastAddressRef.current;
      setKeys(null);
      setKeyOwner(null);
      setRegisterTxHash(null);
      setError(null);
      setStorageWarning(null);
      if (previous === null) return;
      void wipeIdentity(previous);
      void wipeMessenger(previous);
    },
  });

  const activeKeys = keyOwner !== null && keyOwner === address ? keys : null;

  const x25519Pub = useMemo<Hex | null>(
    () => (activeKeys === null ? null : bytesToHex(activeKeys.x25519.publicKey)),
    [activeKeys],
  );
  const ed25519Pub = useMemo<Hex | null>(
    () => (activeKeys === null ? null : bytesToHex(activeKeys.ed25519.publicKey)),
    [activeKeys],
  );

  /* ── what the registry holds ────────────────────────────────────────── */
  const registryRead = useReadContract({
    abi: keyRegistryAbi,
    functionName: 'keysOf',
    chainId: ACTIVE_CHAIN_ID,
    ...(contracts === null ? {} : { address: contracts.keyRegistry }),
    args: address === undefined ? undefined : [address],
    query: {
      enabled: contracts !== null && address !== undefined && !wrongNetwork,
      staleTime: 30_000,
    },
  });

  const onChain = useMemo(() => {
    const data = registryRead.data;
    if (data === undefined) return null;
    const [x25519, ed25519, updatedAt] = data;
    if (x25519.toLowerCase() === ZERO_KEY) return null;
    return { x25519, ed25519, updatedAt: Number(updatedAt) };
  }, [registryRead.data]);

  const matchesChain =
    onChain !== null &&
    x25519Pub !== null &&
    ed25519Pub !== null &&
    onChain.x25519.toLowerCase() === x25519Pub.toLowerCase() &&
    onChain.ed25519.toLowerCase() === ed25519Pub.toLowerCase();

  const isRotation = onChain !== null && !matchesChain && activeKeys !== null;

  /* ── actions ────────────────────────────────────────────────────────── */
  const unlock = useCallback((): void => {
    if (address === undefined) return;
    void (async (): Promise<void> => {
      setError(null);
      setStorageWarning(null);
      setPhase('unlocking');
      try {
        /*
         * IDENTITY_DOMAIN is signed VERBATIM — never spread with an override, and never with the
         * connected `chainId` substituted in. The signature is the sole input to the key
         * derivation, so any change to this payload yields a different identity for the same
         * wallet and orphans every message already sealed to the old one. `smoke-send.ts` diverged
         * here once; keep all three call sites (app, script, tests) byte-identical.
         */
        const signature = await signTypedDataAsync({
          domain: IDENTITY_DOMAIN,
          types: IDENTITY_TYPES,
          primaryType: 'Identity',
          message: IDENTITY_MESSAGE,
        });
        const derived = await deriveIdentity(signature);
        setKeys(derived);
        setKeyOwner(address);
        try {
          await saveIdentity(address, derived);
        } catch (storageError: unknown) {
          setStorageWarning(
            storageError instanceof StorageUnavailableError
              ? storageError.message
              : 'Your identity key could not be cached on this device, so you will be asked to sign again next visit.',
          );
        }
      } catch (signError: unknown) {
        setError(
          isDomainChainMismatch(signError)
            ? `Your wallet refused to sign because it is on chain ${String(chainId ?? 'unknown')}, ` +
              `while HoodGram identities are always derived on chain ${String(IDENTITY_DOMAIN.chainId)}. ` +
              'This is deliberate. An identity must not change when you switch networks. Switch your wallet to Robinhood Chain.'
            : describeChainError(signError, 'The identity signature was not completed.'),
        );
      } finally {
        setPhase('idle');
      }
    })();
  }, [address, chainId, signTypedDataAsync]);

  const register = useCallback((): void => {
    if (address === undefined || activeKeys === null || contracts === null) return;
    const x = bytesToHex(activeKeys.x25519.publicKey);
    const ed = bytesToHex(activeKeys.ed25519.publicKey);

    void (async (): Promise<void> => {
      setError(null);
      setPhase('registering');
      try {
        const hash = await writeContractAsync({
          address: contracts.keyRegistry,
          abi: keyRegistryAbi,
          functionName: 'register',
          args: [x, ed],
          chainId: ACTIVE_CHAIN_ID,
        });
        setRegisterTxHash(hash);
        const receipt = await waitForTransactionReceipt(config, {
          hash,
          chainId: ACTIVE_CHAIN_ID,
        });
        if (receipt.status === 'reverted') {
          throw new Error('The key registration transaction reverted on chain.');
        }
        await registryRead.refetch();
      } catch (writeError: unknown) {
        setError(describeChainError(writeError, 'Publishing your keys failed.'));
      } finally {
        setPhase('idle');
      }
    })();
  }, [activeKeys, address, config, contracts, registryRead, writeContractAsync]);

  const forget = useCallback((): void => {
    const target = address ?? lastAddressRef.current;
    setKeys(null);
    setKeyOwner(null);
    setRegisterTxHash(null);
    if (target === null || target === undefined) return;
    void wipeIdentity(target);
    void wipeMessenger(target);
  }, [address]);

  const clearError = useCallback((): void => setError(null), []);

  /* ── derived status ─────────────────────────────────────────────────── */
  const status = useMemo<IdentityStatus>(() => {
    if (!isConnected || address === undefined) return 'idle';
    if (wrongNetwork) return 'wrong-network';
    if (contracts === null) return 'not-deployed';
    if (phase === 'unlocking') return 'unlocking';
    if (phase === 'registering') return 'registering';
    if (phase === 'loading') return 'loading';
    if (activeKeys === null) return 'locked';
    if (registryRead.isPending) return 'loading';
    return matchesChain ? 'ready' : 'unregistered';
  }, [
    activeKeys,
    address,
    contracts,
    isConnected,
    matchesChain,
    phase,
    registryRead.isPending,
    wrongNetwork,
  ]);

  return {
    status,
    address: address ?? null,
    keys: activeKeys,
    x25519Pub,
    ed25519Pub,
    onChain,
    isReady: status === 'ready',
    isBusy: phase === 'unlocking' || phase === 'registering',
    isRotation,
    error,
    storageWarning,
    registerTxHash,
    unlock,
    register,
    forget,
    clearError,
  };
}
