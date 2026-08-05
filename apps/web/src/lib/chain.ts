import { defineChain, isAddress, type Address, type Chain, type Hex } from 'viem';

/* ───────────────────────────────────────────────────────────── chains ───── */

/**
 * Robinhood Chain — verified live 2026-07-29 (SPEC §1).
 * FCFS sequencer ordering, no priority-fee jumping, ~0.0275 gwei observed.
 */
export const robinhoodChain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.mainnet.chain.robinhood.com/'] },
  },
  blockExplorers: {
    default: {
      name: 'Blockscout',
      url: 'https://robinhoodchain.blockscout.com/',
    },
  },
  testnet: false,
});

/** Local development chain (SPEC §1). */
export const anvil = defineChain({
  id: 31337,
  name: 'Anvil',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['http://127.0.0.1:8545'] },
  },
  testnet: true,
});

/** Every chain this app will talk to, in priority order. */
export const SUPPORTED_CHAINS = [robinhoodChain, anvil] as const;

export type SupportedChainId = (typeof SUPPORTED_CHAINS)[number]['id'];

const CHAIN_BY_ID: ReadonlyMap<number, Chain> = new Map(
  SUPPORTED_CHAINS.map((c) => [c.id as number, c as Chain]),
);

export function isSupportedChainId(id: number): id is SupportedChainId {
  return CHAIN_BY_ID.has(id);
}

/** Chain definition for `id`, or `null` when the chain is not supported. */
export function chainById(id: number): Chain | null {
  return CHAIN_BY_ID.get(id) ?? null;
}

/* ────────────────────────────────────────────────────── active chain ───── */

function parseChainId(raw: string | undefined): SupportedChainId {
  if (raw === undefined || raw.trim() === '') return anvil.id;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || !isSupportedChainId(parsed)) return anvil.id;
  return parsed;
}

/** Chain id selected by `NEXT_PUBLIC_CHAIN_ID`; falls back to anvil (31337). */
export const ACTIVE_CHAIN_ID: SupportedChainId = parseChainId(
  process.env.NEXT_PUBLIC_CHAIN_ID,
);

/** The chain this build targets. */
export const activeChain: Chain =
  ACTIVE_CHAIN_ID === robinhoodChain.id ? robinhoodChain : anvil;

function envRpc(raw: string | undefined, fallback: string): string {
  return raw !== undefined && raw.trim() !== '' ? raw.trim() : fallback;
}

/**
 * RPC endpoint for a chain. `NEXT_PUBLIC_RPC_URL` overrides the endpoint of the
 * *active* chain only, so a local override never redirects mainnet traffic.
 */
export function rpcUrlFor(chainId: number): string {
  const chain = chainById(chainId);
  const fallback = chain?.rpcUrls.default.http[0] ?? anvil.rpcUrls.default.http[0];
  if (chainId === ACTIVE_CHAIN_ID) {
    return envRpc(process.env.NEXT_PUBLIC_RPC_URL, fallback);
  }
  return fallback;
}

/* ──────────────────────────────────────────────────────── explorers ────── */

function explorerBase(chainId: number): string | null {
  const url = chainById(chainId)?.blockExplorers?.default.url;
  if (url === undefined) return null;
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/** Explorer transaction URL, or `null` when the chain has no explorer. */
export function explorerTxUrl(hash: Hex, chainId: number = ACTIVE_CHAIN_ID): string | null {
  const base = explorerBase(chainId);
  return base === null ? null : `${base}/tx/${hash}`;
}

/** Explorer address URL, or `null` when the chain has no explorer. */
export function explorerAddressUrl(
  address: Address,
  chainId: number = ACTIVE_CHAIN_ID,
): string | null {
  const base = explorerBase(chainId);
  return base === null ? null : `${base}/address/${address}`;
}

/** Explorer block URL, or `null` when the chain has no explorer. */
export function explorerBlockUrl(
  block: bigint | number,
  chainId: number = ACTIVE_CHAIN_ID,
): string | null {
  const base = explorerBase(chainId);
  return base === null ? null : `${base}/block/${block.toString()}`;
}

/* ─────────────────────────────────────────────────────── deployments ───── */

/**
 * Deployed contract set for one chain. Field names mirror the `Deployment`
 * interface in SPEC §5 exactly, so this can delegate to
 * `@telehood/crypto`'s `DEPLOYMENTS` once that package ships without any
 * call-site changes.
 */
export interface ContractAddresses {
  readonly token: Address;
  readonly priceSource: Address;
  readonly revenueVault: Address;
  readonly activation: Address;
  readonly groupRegistry: Address;
  readonly keyRegistry: Address;
  readonly anchors: Address;
  readonly perks: Address;
  readonly handles: Address;
}

export type ContractName = keyof ContractAddresses;

/**
 * Addresses come from the deploy step. `Deploy.s.sol` writes
 * `contracts/deployments/<chainid>.json`; those values are surfaced to the
 * browser through `NEXT_PUBLIC_ADDR_*`, which Next inlines at build time.
 */
const ADDRESS_ENV: Readonly<Record<ContractName, string>> = {
  token: 'NEXT_PUBLIC_ADDR_TOKEN',
  priceSource: 'NEXT_PUBLIC_ADDR_PRICE_SOURCE',
  revenueVault: 'NEXT_PUBLIC_ADDR_REVENUE_VAULT',
  activation: 'NEXT_PUBLIC_ADDR_ACTIVATION',
  groupRegistry: 'NEXT_PUBLIC_ADDR_GROUP_REGISTRY',
  keyRegistry: 'NEXT_PUBLIC_ADDR_KEY_REGISTRY',
  anchors: 'NEXT_PUBLIC_ADDR_ANCHORS',
  perks: 'NEXT_PUBLIC_ADDR_PERKS',
  handles: 'NEXT_PUBLIC_ADDR_HANDLES',
};

/* Static member access is required for Next's build-time inlining. */
const RAW_ADDRESSES: Readonly<Record<ContractName, string | undefined>> = {
  token: process.env.NEXT_PUBLIC_ADDR_TOKEN,
  priceSource: process.env.NEXT_PUBLIC_ADDR_PRICE_SOURCE,
  revenueVault: process.env.NEXT_PUBLIC_ADDR_REVENUE_VAULT,
  activation: process.env.NEXT_PUBLIC_ADDR_ACTIVATION,
  groupRegistry: process.env.NEXT_PUBLIC_ADDR_GROUP_REGISTRY,
  keyRegistry: process.env.NEXT_PUBLIC_ADDR_KEY_REGISTRY,
  anchors: process.env.NEXT_PUBLIC_ADDR_ANCHORS,
  perks: process.env.NEXT_PUBLIC_ADDR_PERKS,
  handles: process.env.NEXT_PUBLIC_ADDR_HANDLES,
};

const CONTRACT_NAMES: readonly ContractName[] = [
  'token',
  'priceSource',
  'revenueVault',
  'activation',
  'groupRegistry',
  'keyRegistry',
  'anchors',
  'perks',
  'handles',
];

export class MissingDeploymentError extends Error {
  readonly chainId: number;
  readonly missing: readonly ContractName[];

  constructor(chainId: number, missing: readonly ContractName[]) {
    const vars = missing.map((name) => ADDRESS_ENV[name]).join(', ');
    super(
      `TeleHood is not configured for chain ${chainId}. ` +
        `Deploy the contracts (\`pnpm deploy:local\`) and set: ${vars}.`,
    );
    this.name = 'MissingDeploymentError';
    this.chainId = chainId;
    this.missing = missing;
  }
}

function readAddresses(): ContractAddresses | null {
  const out: Partial<Record<ContractName, Address>> = {};
  for (const name of CONTRACT_NAMES) {
    const raw = RAW_ADDRESSES[name]?.trim();
    if (raw === undefined || raw === '' || !isAddress(raw, { strict: false })) return null;
    out[name] = raw as Address;
  }
  return out as ContractAddresses;
}

const CONFIGURED = readAddresses();

/**
 * Deployed addresses for `chainId`, or `null` when the build has no addresses
 * for it. Callers should render a designed "not deployed" state rather than a
 * blank — never a dead end (SPEC §7.4).
 */
export function tryGetContracts(
  chainId: number = ACTIVE_CHAIN_ID,
): ContractAddresses | null {
  if (chainId !== ACTIVE_CHAIN_ID) return null;
  return CONFIGURED;
}

/** Same as {@link tryGetContracts}, but throws a precise, actionable error. */
export function getContracts(chainId: number = ACTIVE_CHAIN_ID): ContractAddresses {
  const found = tryGetContracts(chainId);
  if (found !== null) return found;

  const missing = CONTRACT_NAMES.filter((name) => {
    const raw = RAW_ADDRESSES[name]?.trim();
    return raw === undefined || raw === '' || !isAddress(raw, { strict: false });
  });
  throw new MissingDeploymentError(
    chainId,
    missing.length > 0 ? missing : CONTRACT_NAMES,
  );
}

/** True when this build knows where the contracts live on `chainId`. */
export function isDeployed(chainId: number = ACTIVE_CHAIN_ID): boolean {
  return tryGetContracts(chainId) !== null;
}
