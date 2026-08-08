import { cookieStorage, createConfig, createStorage, http } from 'wagmi';
import { injected } from 'wagmi/connectors';

import {
  ACTIVE_CHAIN_ID,
  anvil,
  robinhoodChain,
  robinhoodTestnet,
  rpcUrlFor,
  SUPPORTED_CHAINS,
} from '@/lib/chain';

/**
 * Chains, ordered so the build's ACTIVE chain is always first.
 *
 * This ordering is load-bearing, not cosmetic. With no wallet connected, wagmi's `useChainId()`
 * reports `chains[0]`, and `tryGetContracts()` returns null for any chain that is not the active
 * one. If the active chain were not first, every contract read would be silently discarded for
 * visitors who have not connected — /access would render "price unavailable" while the chain, the
 * contracts and the RPC were all perfectly healthy.
 *
 * Written out per active chain rather than derived, because wagmi types `chains` as a tuple of
 * literal chain types and a `.filter()` widens every member to `Chain`, which it rejects. The
 * cost of writing it out is that a new chain must be added in each arm — so the assertion below
 * makes forgetting a compile error instead of the silent read failure described above.
 */
const CHAINS =
  ACTIVE_CHAIN_ID === robinhoodChain.id
    ? ([robinhoodChain, robinhoodTestnet, anvil] as const)
    : ACTIVE_CHAIN_ID === robinhoodTestnet.id
      ? ([robinhoodTestnet, robinhoodChain, anvil] as const)
      : ([anvil, robinhoodChain, robinhoodTestnet] as const);

/** Fails the build if any supported chain is missing from every arm above. */
type AssertTrue<T extends true> = T;
type ChainsCoverSupported = AssertTrue<
  (typeof SUPPORTED_CHAINS)[number]['id'] extends (typeof CHAINS)[number]['id'] ? true : false
>;
export type { ChainsCoverSupported };

/**
 * wagmi configuration.
 *
 * Connectors are deliberately limited to `injected()` plus wagmi's EIP-6963
 * discovery (`multiInjectedProviderDiscovery`, on by default). Discovery
 * returns every wallet the browser actually announces, each with its real name
 * and icon, which is exactly what `ConnectSheet` renders — so the product never
 * has to fall back to a third-party connect modal (SPEC §7.1).
 *
 * `ssr: true` + cookie storage means the connection survives a reload without
 * forcing the root layout to read request headers, which would opt the
 * marketing route out of static rendering.
 */
export const wagmiConfig = createConfig({
  chains: CHAINS,
  connectors: [injected({ shimDisconnect: true })],
  transports: {
    [robinhoodChain.id]: http(rpcUrlFor(robinhoodChain.id)),
    [robinhoodTestnet.id]: http(rpcUrlFor(robinhoodTestnet.id)),
    [anvil.id]: http(rpcUrlFor(anvil.id)),
  },
  ssr: true,
  storage: createStorage({ storage: cookieStorage, key: 'hoodgram.wagmi' }),
});

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig;
  }
}
