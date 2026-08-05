import { cookieStorage, createConfig, createStorage, http } from 'wagmi';
import { injected } from 'wagmi/connectors';

import { ACTIVE_CHAIN_ID, anvil, robinhoodChain, rpcUrlFor } from '@/lib/chain';

/**
 * Chains, ordered so the build's ACTIVE chain is always first.
 *
 * This ordering is load-bearing, not cosmetic. With no wallet connected, wagmi's `useChainId()`
 * reports `chains[0]`, and `tryGetContracts()` returns null for any chain that is not the active
 * one. If the active chain were not first, every contract read would be silently discarded for
 * visitors who have not connected — /access would render "price unavailable" while the chain, the
 * contracts and the RPC were all perfectly healthy.
 */
const CHAINS =
  ACTIVE_CHAIN_ID === robinhoodChain.id
    ? ([robinhoodChain, anvil] as const)
    : ([anvil, robinhoodChain] as const);

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
    [anvil.id]: http(rpcUrlFor(anvil.id)),
  },
  ssr: true,
  storage: createStorage({ storage: cookieStorage, key: 'telehood.wagmi' }),
});

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig;
  }
}
