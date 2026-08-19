'use client';

/**
 * Owns the one live call for the whole messenger.
 *
 * Mounted at the shell so a call survives navigating between threads and so an
 * incoming call reaches the user wherever they are. The engine itself is
 * `useVoiceCall`; this wires it to the session, to the key registry it verifies
 * signatures against, and to the relay routing tag.
 */
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { useConfig } from 'wagmi';
import { readContract } from 'wagmi/actions';
import type { Address } from 'viem';

import { keyRegistryAbi } from '@/lib/abi';
import { callTagFor } from '@/lib/call-wire';
import { ACTIVE_CHAIN_ID, tryGetContracts } from '@/lib/chain';
import { setRelayCallTag } from '@/hooks/relay-stream';
import {
  setCallKeyLookup,
  useVoiceCall,
  type CallPeer,
  type UseVoiceCallResult,
} from '@/hooks/useVoiceCall';
import { CallSurface } from './CallSurface';
import { useAppSession } from './session';

const ZERO_KEY = `0x${'00'.repeat(32)}`;

const CallContext = createContext<UseVoiceCallResult | null>(null);

/** The live call, or `null` outside the provider. */
export function useCall(): UseVoiceCallResult | null {
  return useContext(CallContext);
}

export function CallProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const session = useAppSession();
  const config = useConfig();
  const call = useVoiceCall({ owner: session.address, keys: session.keys });

  /* The engine refuses to trust an SDP until its author signature verifies
     against the keys the registry holds for that address. This is that lookup. */
  useEffect(() => {
    setCallKeyLookup(async (address: Address): Promise<CallPeer | null> => {
      const contracts = tryGetContracts(ACTIVE_CHAIN_ID);
      if (contracts === null) return null;
      const keysOf = await readContract(config, {
        address: contracts.keyRegistry,
        abi: keyRegistryAbi,
        functionName: 'keysOf',
        args: [address],
        chainId: ACTIVE_CHAIN_ID,
      });
      if (keysOf[0].toLowerCase() === ZERO_KEY || keysOf[1].toLowerCase() === ZERO_KEY) {
        return null;
      }
      return { address, x25519Pub: keysOf[0], ed25519Pub: keysOf[1] };
    });
  }, [config]);

  /* Listen on our own routing tag so calls can reach this device. */
  useEffect(() => {
    const pub = session.x25519Pub;
    setRelayCallTag(pub === null ? null : callTagFor(pub));
    return () => setRelayCallTag(null);
  }, [session.x25519Pub]);

  const value = useMemo(() => call, [call]);

  return (
    <CallContext.Provider value={value}>
      {children}
      <CallSurface call={call} />
    </CallContext.Provider>
  );
}
