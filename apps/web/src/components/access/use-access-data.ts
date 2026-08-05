'use client';

/**
 * Every chain read `/access` needs, in one place.
 *
 * Reads are batched with `useReadContracts` so a panel resolves in one round
 * trip instead of a waterfall, and every result is narrowed at runtime — a
 * multicall entry can fail individually, and a failed entry must degrade into a
 * designed empty state rather than throw inside render.
 *
 * Nothing here stakes, locks or deposits anything: holder revenue is derived
 * entirely from historical balance checkpoints (`balanceOfAt`) taken at each
 * sealed epoch's snapshot block (SPEC §4.5), and perk tiers are judged on the
 * LOWER of the live balance and the balance at the last sealed snapshot.
 */

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import {
  parseAbiItem,
  zeroAddress,
  type Address,
  type ContractFunctionParameters,
  type Hex,
} from 'viem';
import { useAccount, usePublicClient, useReadContracts } from 'wagmi';

import {
  activationAbi,
  groupRegistryAbi,
  handlesAbi,
  manualPriceSourceAbi,
  perksAbi,
  PerkTier,
  revenueVaultAbi,
  teleHoodTokenAbi,
  CONTRACT_CONSTANTS,
  type PerkTierId,
  isPerkTierId,
} from '@/lib/abi';
import {
  ACTIVE_CHAIN_ID,
  tryGetContracts,
  type ContractAddresses,
} from '@/lib/chain';

/* ═══════════════════════════════════════════════════════════ narrowing ═══ */

/** One entry of a `useReadContracts` result, without leaning on its generics. */
function pick(data: readonly unknown[] | undefined, index: number): unknown {
  const entry = data?.[index];
  if (typeof entry !== 'object' || entry === null) return undefined;
  const record = entry as Record<string, unknown>;
  return record['status'] === 'success' ? record['result'] : undefined;
}

function asBigInt(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  return null;
}

function asBool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asAddress(value: unknown): Address | null {
  return typeof value === 'string' && value.startsWith('0x')
    ? (value as Address)
    : null;
}

function asTuple(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? (value as readonly unknown[]) : null;
}

/* ═════════════════════════════════════════════════════════════ clocks ════ */

/**
 * Wall-clock seconds, `null` until mount.
 *
 * Returning `null` on the server is deliberate: server and client clocks
 * disagree, and rendering a time-derived string during hydration is a mismatch.
 */
export function useNowSeconds(intervalMs = 15_000): bigint | null {
  const [now, setNow] = useState<bigint | null>(null);

  useEffect(() => {
    const tick = (): void => setNow(BigInt(Math.floor(Date.now() / 1000)));
    tick();
    const timer = setInterval(tick, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return now;
}

/** Trailing debounce — keeps a dragged month stepper (or typing) off the RPC. */
export function useDebounced<T>(value: T, delayMs = 220): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs, value]);

  return settled;
}

/* ═══════════════════════════════════════════════════════ environment ════ */

export interface AccessEnvironment {
  readonly address: Address | null;
  readonly isConnected: boolean;
  readonly chainId: number | null;
  /** `null` when this build has no deployed addresses for the active chain. */
  readonly contracts: ContractAddresses | null;
  readonly wrongNetwork: boolean;
  /** True when reads can actually run. */
  readonly ready: boolean;
}

export function useAccessEnvironment(): AccessEnvironment {
  const { address, isConnected, chainId } = useAccount();
  const contracts = useMemo(() => tryGetContracts(ACTIVE_CHAIN_ID), []);
  const wrongNetwork =
    isConnected && chainId !== undefined && chainId !== ACTIVE_CHAIN_ID;

  return {
    address: address ?? null,
    isConnected,
    chainId: chainId ?? null,
    contracts,
    wrongNetwork,
    ready: contracts !== null && !wrongNetwork,
  };
}

/* ════════════════════════════════════════════════════════════ pricing ═══ */

export interface PricingState {
  /** `Activation.quote()` — the $5, in $THOOD wei, right now. */
  readonly activationQuote: bigint | null;
  /** `Activation.priceUsd` — 18dp USD, deploy-default $5. */
  readonly activationUsd: bigint | null;
  /** `GroupRegistry.rentUsdPerMonth` — 18dp USD, deploy-default $10. */
  readonly rentUsdPerMonth: bigint | null;
  /** `GroupRegistry.quoteRent(1)` — one month of rent in $THOOD wei. */
  readonly rentMonthQuote: bigint | null;
  /** `IPriceSource.thoodPerUsd()` — how many $THOOD equal one dollar. */
  readonly thoodPerUsd: bigint | null;
  readonly monthSeconds: bigint;
  readonly maxMonths: number;
  readonly renewWindowSeconds: bigint;
  readonly isLoading: boolean;
  readonly isError: boolean;
}

const FALLBACK_MONTH = BigInt(CONTRACT_CONSTANTS.monthSeconds);
const FALLBACK_RENEW_WINDOW = BigInt(CONTRACT_CONSTANTS.renewWindowSeconds);

export function usePricing(contracts: ContractAddresses | null): PricingState {
  const activation = contracts?.activation ?? zeroAddress;
  const registry = contracts?.groupRegistry ?? zeroAddress;
  const priceSource = contracts?.priceSource ?? zeroAddress;
  const enabled = contracts !== null;

  const { data, isLoading, isError } = useReadContracts({
    contracts: [
      { address: activation, abi: activationAbi, functionName: 'quote' },
      { address: activation, abi: activationAbi, functionName: 'priceUsd' },
      { address: registry, abi: groupRegistryAbi, functionName: 'rentUsdPerMonth' },
      { address: registry, abi: groupRegistryAbi, functionName: 'quoteRent', args: [1] },
      { address: priceSource, abi: manualPriceSourceAbi, functionName: 'thoodPerUsd' },
      { address: registry, abi: groupRegistryAbi, functionName: 'MONTH' },
      { address: registry, abi: groupRegistryAbi, functionName: 'MAX_MONTHS' },
      { address: registry, abi: groupRegistryAbi, functionName: 'RENEW_WINDOW' },
    ],
    query: { enabled, refetchInterval: 60_000 },
  });

  return useMemo<PricingState>(() => {
    const month = asBigInt(pick(data, 5));
    const maxMonths = asNumber(pick(data, 6));
    const renewWindow = asBigInt(pick(data, 7));

    return {
      activationQuote: asBigInt(pick(data, 0)),
      activationUsd: asBigInt(pick(data, 1)),
      rentUsdPerMonth: asBigInt(pick(data, 2)),
      rentMonthQuote: asBigInt(pick(data, 3)),
      thoodPerUsd: asBigInt(pick(data, 4)),
      monthSeconds: month !== null && month > 0n ? month : FALLBACK_MONTH,
      maxMonths:
        maxMonths !== null && maxMonths > 0 ? maxMonths : CONTRACT_CONSTANTS.maxMonths,
      renewWindowSeconds:
        renewWindow !== null && renewWindow > 0n ? renewWindow : FALLBACK_RENEW_WINDOW,
      isLoading: enabled && isLoading,
      isError: enabled && isError,
    };
  }, [data, enabled, isError, isLoading]);
}

/* ═══════════════════════════════════════════════════════════ activation ══ */

export interface ActivationState {
  /** `isActivated(user)` — the account exists, forever. */
  readonly isActivated: boolean;
  /** Unix seconds of activation; `0n` when never activated. */
  readonly activatedAt: bigint;
  readonly isLoading: boolean;
}

const EMPTY_ACTIVATION: ActivationState = {
  isActivated: false,
  activatedAt: 0n,
  isLoading: false,
};

export function useActivationState(
  contracts: ContractAddresses | null,
  user: Address | null,
): ActivationState {
  const activation = contracts?.activation ?? zeroAddress;
  const enabled = contracts !== null && user !== null;
  const account = user ?? zeroAddress;

  const { data, isLoading } = useReadContracts({
    contracts: [
      { address: activation, abi: activationAbi, functionName: 'isActivated', args: [account] },
      { address: activation, abi: activationAbi, functionName: 'activatedAt', args: [account] },
    ],
    query: { enabled, refetchInterval: 30_000 },
  });

  return useMemo<ActivationState>(() => {
    if (!enabled) return EMPTY_ACTIVATION;
    return {
      isActivated: asBool(pick(data, 0)) ?? false,
      activatedAt: asBigInt(pick(data, 1)) ?? 0n,
      isLoading,
    };
  }, [data, enabled, isLoading]);
}

/* ══════════════════════════════════════════════════════════════ handle ═══ */

export interface HandleState {
  /** The user's current @name, or `null` when none is claimed. */
  readonly handle: string | null;
  readonly isLoading: boolean;
}

export function useHandleState(
  contracts: ContractAddresses | null,
  user: Address | null,
): HandleState {
  const handles = contracts?.handles ?? zeroAddress;
  const enabled = contracts !== null && user !== null;
  const account = user ?? zeroAddress;

  const { data, isLoading } = useReadContracts({
    contracts: [
      { address: handles, abi: handlesAbi, functionName: 'handleOf', args: [account] },
    ],
    query: { enabled, refetchInterval: 30_000 },
  });

  return useMemo<HandleState>(() => {
    if (!enabled) return { handle: null, isLoading: false };
    const raw = asString(pick(data, 0));
    return {
      handle: raw !== null && raw !== '' ? raw : null,
      isLoading,
    };
  }, [data, enabled, isLoading]);
}

export interface HandleAvailability {
  /** `addressOf(name)` — the zero address means available. */
  readonly owner: Address | null;
  readonly available: boolean | null;
  readonly isLoading: boolean;
}

/** Live availability for a (debounced, already-valid) candidate name. */
export function useHandleAvailability(
  contracts: ContractAddresses | null,
  name: string | null,
): HandleAvailability {
  const handles = contracts?.handles ?? zeroAddress;
  const enabled = contracts !== null && name !== null && name !== '';

  const { data, isLoading } = useReadContracts({
    contracts: [
      { address: handles, abi: handlesAbi, functionName: 'addressOf', args: [name ?? ''] },
    ],
    query: { enabled, refetchInterval: 30_000 },
  });

  return useMemo<HandleAvailability>(() => {
    if (!enabled) return { owner: null, available: null, isLoading: false };
    const owner = asAddress(pick(data, 0));
    return {
      owner,
      available: owner === null ? null : owner === zeroAddress,
      isLoading,
    };
  }, [data, enabled, isLoading]);
}

/* ═══════════════════════════════════════════════════════════════ perks ═══ */

export interface PerksState {
  /** `tierOf(user)` — 0 none, 1..4 held rungs. */
  readonly tier: PerkTierId;
  /** `eligibleBalance(user)` — min(now, at last sealed snapshot). */
  readonly eligibleBalance: bigint | null;
  /** `thresholdAmount(1..4)` — live thresholds in $THOOD wei, lowest first. */
  readonly thresholds: readonly (bigint | null)[];
  /** `RevenueVault.latestSnapshot()` — the block tiers are judged against. */
  readonly latestSnapshot: bigint | null;
  readonly isLoading: boolean;
}

const EMPTY_PERKS: PerksState = {
  tier: PerkTier.NONE,
  eligibleBalance: null,
  thresholds: [null, null, null, null],
  latestSnapshot: null,
  isLoading: false,
};

export function usePerksState(
  contracts: ContractAddresses | null,
  user: Address | null,
): PerksState {
  const perks = contracts?.perks ?? zeroAddress;
  const vault = contracts?.revenueVault ?? zeroAddress;
  const enabled = contracts !== null;
  const account = user ?? zeroAddress;

  const { data, isLoading } = useReadContracts({
    contracts: [
      { address: perks, abi: perksAbi, functionName: 'tierOf', args: [account] },
      { address: perks, abi: perksAbi, functionName: 'eligibleBalance', args: [account] },
      { address: perks, abi: perksAbi, functionName: 'thresholdAmount', args: [1] },
      { address: perks, abi: perksAbi, functionName: 'thresholdAmount', args: [2] },
      { address: perks, abi: perksAbi, functionName: 'thresholdAmount', args: [3] },
      { address: perks, abi: perksAbi, functionName: 'thresholdAmount', args: [4] },
      { address: vault, abi: revenueVaultAbi, functionName: 'latestSnapshot' },
    ],
    query: { enabled, refetchInterval: 30_000 },
  });

  return useMemo<PerksState>(() => {
    if (!enabled) return EMPTY_PERKS;

    const rawTier = user === null ? 0 : (asNumber(pick(data, 0)) ?? 0);
    const tier: PerkTierId = isPerkTierId(rawTier) ? rawTier : PerkTier.NONE;

    return {
      tier,
      eligibleBalance: user === null ? null : asBigInt(pick(data, 1)),
      thresholds: [
        asBigInt(pick(data, 2)),
        asBigInt(pick(data, 3)),
        asBigInt(pick(data, 4)),
        asBigInt(pick(data, 5)),
      ],
      latestSnapshot: asBigInt(pick(data, 6)),
      isLoading,
    };
  }, [data, enabled, isLoading, user]);
}

/* ════════════════════════════════════════════════════════════ token ═════ */

export interface TokenState {
  readonly balance: bigint | null;
  /** Allowance granted to `Activation` — what activate/activateFor can pull. */
  readonly activationAllowance: bigint | null;
  /** Allowance granted to `GroupRegistry` — what payRent/renewFor can pull. */
  readonly registryAllowance: bigint | null;
  readonly totalSupply: bigint | null;
  readonly isLoading: boolean;
}

export function useTokenState(
  contracts: ContractAddresses | null,
  user: Address | null,
): TokenState {
  const token = contracts?.token ?? zeroAddress;
  const activation = contracts?.activation ?? zeroAddress;
  const registry = contracts?.groupRegistry ?? zeroAddress;
  const enabled = contracts !== null && user !== null;
  const account = user ?? zeroAddress;

  const { data, isLoading } = useReadContracts({
    contracts: [
      { address: token, abi: teleHoodTokenAbi, functionName: 'balanceOf', args: [account] },
      {
        address: token,
        abi: teleHoodTokenAbi,
        functionName: 'allowance',
        args: [account, activation],
      },
      {
        address: token,
        abi: teleHoodTokenAbi,
        functionName: 'allowance',
        args: [account, registry],
      },
      { address: token, abi: teleHoodTokenAbi, functionName: 'totalSupply' },
    ],
    query: { enabled, refetchInterval: 30_000 },
  });

  return useMemo<TokenState>(
    () => ({
      balance: enabled ? asBigInt(pick(data, 0)) : null,
      activationAllowance: enabled ? asBigInt(pick(data, 1)) : null,
      registryAllowance: enabled ? asBigInt(pick(data, 2)) : null,
      totalSupply: enabled ? asBigInt(pick(data, 3)) : null,
      isLoading: enabled && isLoading,
    }),
    [data, enabled, isLoading],
  );
}

/* ═════════════════════════════════════════════════════════════ rooms ════ */

export interface RoomRow {
  readonly id: Hex;
  readonly admin: Address;
  readonly epoch: number;
  readonly createdAt: bigint;
  readonly paidUntil: bigint;
  readonly autoRenew: boolean;
}

export interface RoomsState {
  /** Rooms the connected address currently administers, newest first. */
  readonly rooms: readonly RoomRow[];
  /** True when the log scan could not cover the whole chain. */
  readonly partial: boolean;
  readonly isLoading: boolean;
  readonly isError: boolean;
}

const EMPTY_ROOMS: RoomsState = {
  rooms: [],
  partial: false,
  isLoading: false,
  isError: false,
};

/** SPEC §4.4 — the two events that can make an address a room's admin. */
const GROUP_CREATED = parseAbiItem(
  'event GroupCreated(bytes32 indexed groupId, address indexed admin, bytes32 memberRoot, uint8 months, uint256 thoodPaid, uint64 paidUntil)',
);
const ADMIN_TRANSFERRED = parseAbiItem(
  'event AdminTransferred(bytes32 indexed groupId, address indexed from, address indexed to)',
);

type ReadClient = NonNullable<ReturnType<typeof usePublicClient>>;

/** Conservative window; most public RPCs cap `eth_getLogs` around 10k blocks. */
const LOG_CHUNK = 9_000n;
const MAX_CHUNKS = 240;

function startBlockFromEnv(): bigint {
  const raw = process.env.NEXT_PUBLIC_START_BLOCK;
  if (raw === undefined || raw.trim() === '') return 0n;
  try {
    const parsed = BigInt(raw.trim());
    return parsed < 0n ? 0n : parsed;
  } catch {
    return 0n;
  }
}

interface RoomCandidates {
  readonly ids: readonly Hex[];
  readonly partial: boolean;
}

async function scanRoomIds(
  client: ReadClient,
  registry: Address,
  user: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<RoomCandidates> {
  const ids = new Set<Hex>();

  const collect = async (lower: bigint, upper: bigint): Promise<void> => {
    const [created, transferred] = await Promise.all([
      client.getLogs({
        address: registry,
        event: GROUP_CREATED,
        args: { admin: user },
        fromBlock: lower,
        toBlock: upper,
        strict: true,
      }),
      client.getLogs({
        address: registry,
        event: ADMIN_TRANSFERRED,
        args: { to: user },
        fromBlock: lower,
        toBlock: upper,
        strict: true,
      }),
    ]);
    for (const log of created) ids.add(log.args.groupId);
    for (const log of transferred) ids.add(log.args.groupId);
  };

  /* Fast path: anvil and most self-hosted endpoints answer the whole range. */
  try {
    await collect(fromBlock, toBlock);
    return { ids: [...ids], partial: false };
  } catch {
    ids.clear();
  }

  /* Bounded backwards scan — recent rooms first, and one bad window must not
     discard what was already found. */
  let cursor = toBlock;
  let chunks = 0;
  let reachedStart = false;

  while (cursor >= fromBlock && chunks < MAX_CHUNKS) {
    const lowerCandidate = cursor - LOG_CHUNK + 1n;
    const lower = lowerCandidate > fromBlock ? lowerCandidate : fromBlock;

    try {
      await collect(lower, cursor);
    } catch {
      break;
    }

    chunks += 1;
    if (lower <= fromBlock) {
      reachedStart = true;
      break;
    }
    cursor = lower - 1n;
  }

  return { ids: [...ids], partial: !reachedStart };
}

/**
 * Rooms the connected user runs: `GroupCreated(admin=user)` plus
 * `AdminTransferred(to=user)`, then `groups()` for each candidate — the struct
 * read is the authority, so a room transferred *away* drops out here.
 */
export function useMyRooms(
  contracts: ContractAddresses | null,
  user: Address | null,
): RoomsState {
  const client = usePublicClient({ chainId: ACTIVE_CHAIN_ID });
  const registry = contracts?.groupRegistry ?? null;

  const candidates = useQuery<RoomCandidates, Error>({
    queryKey: ['access', 'my-rooms', ACTIVE_CHAIN_ID, registry, user],
    enabled: client !== undefined && registry !== null && user !== null,
    staleTime: 30_000,
    refetchInterval: 60_000,
    queryFn: async (): Promise<RoomCandidates> => {
      if (client === undefined || registry === null || user === null) {
        throw new Error('No read client for the active chain.');
      }
      const head = await client.getBlockNumber();
      const from = startBlockFromEnv();
      return scanRoomIds(client, registry, user, from > head ? head : from, head);
    },
  });

  const ids = useMemo<readonly Hex[]>(
    () => candidates.data?.ids ?? [],
    [candidates.data],
  );

  const groupCalls = useMemo<readonly ContractFunctionParameters[]>(
    () =>
      registry === null
        ? []
        : ids.map((id) => ({
            address: registry,
            abi: groupRegistryAbi,
            functionName: 'groups',
            args: [id],
          })),
    [ids, registry],
  );

  const { data: groupData, isLoading: groupsLoading } = useReadContracts({
    contracts: groupCalls,
    query: { enabled: groupCalls.length > 0, refetchInterval: 30_000 },
  });

  return useMemo<RoomsState>(() => {
    if (registry === null || user === null) return EMPTY_ROOMS;

    const rooms: RoomRow[] = [];
    ids.forEach((id, index) => {
      const tuple = asTuple(pick(groupData, index));
      if (tuple === null) return;
      const admin = asAddress(tuple[0]);
      const epoch = asNumber(tuple[1]);
      const createdAt = asBigInt(tuple[2]);
      const paidUntil = asBigInt(tuple[4]);
      const autoRenew = asBool(tuple[5]);
      const exists = asBool(tuple[6]);
      if (
        admin === null ||
        epoch === null ||
        createdAt === null ||
        paidUntil === null ||
        autoRenew === null ||
        exists !== true
      ) {
        return;
      }
      /* The struct is the authority — drop rooms transferred away since. */
      if (admin.toLowerCase() !== user.toLowerCase()) return;
      rooms.push({ id, admin, epoch, createdAt, paidUntil, autoRenew });
    });

    rooms.sort((a, b) => (a.createdAt === b.createdAt ? 0 : a.createdAt < b.createdAt ? 1 : -1));

    return {
      rooms,
      partial: candidates.data?.partial ?? false,
      isLoading:
        candidates.isPending || (groupCalls.length > 0 && groupsLoading),
      isError: candidates.isError,
    };
  }, [
    candidates.data,
    candidates.isError,
    candidates.isPending,
    groupCalls.length,
    groupData,
    groupsLoading,
    ids,
    registry,
    user,
  ]);
}

/** `quoteRent(months)` for one (debounced) term — the live rent quote. */
export function useRentQuote(
  contracts: ContractAddresses | null,
  months: number,
): { readonly quote: bigint | null; readonly isLoading: boolean } {
  const registry = contracts?.groupRegistry ?? zeroAddress;
  const enabled = contracts !== null && months >= 1 && months <= 24;

  const { data, isLoading } = useReadContracts({
    contracts: [
      { address: registry, abi: groupRegistryAbi, functionName: 'quoteRent', args: [months] },
    ],
    query: { enabled, refetchInterval: 45_000 },
  });

  return useMemo(
    () => ({
      quote: enabled ? asBigInt(pick(data, 0)) : null,
      isLoading: enabled && isLoading,
    }),
    [data, enabled, isLoading],
  );
}

/* ════════════════════════════════════════════════════════════ vault ═════ */

export interface VaultState {
  readonly epochCount: number;
  /** Revenue banked for holders but not yet snapshotted into an epoch. */
  readonly pendingHolders: bigint | null;
  readonly treasuryAccrued: bigint | null;
  /** Unix seconds at which `sealEpoch()` becomes callable by anyone. */
  readonly nextSealAt: bigint | null;
  readonly lastSealAt: bigint | null;
  /** `HOLDER_BPS` — 5000, i.e. the holders' half. */
  readonly holderBps: bigint | null;
  readonly epochIntervalSeconds: bigint | null;
  readonly claimWindowSeconds: bigint | null;
  /** Contract-reported total across every unclaimed, unswept epoch. */
  readonly totalClaimable: bigint | null;
  readonly sealedUnclaimed: bigint | null;
  readonly isSolvent: boolean | null;
  readonly isLoading: boolean;
  readonly isError: boolean;
}

export function useVaultState(
  contracts: ContractAddresses | null,
  user: Address | null,
): VaultState {
  const vault = contracts?.revenueVault ?? zeroAddress;
  const enabled = contracts !== null;
  const account = user ?? zeroAddress;

  const { data, isLoading, isError } = useReadContracts({
    contracts: [
      { address: vault, abi: revenueVaultAbi, functionName: 'epochCount' },
      { address: vault, abi: revenueVaultAbi, functionName: 'pendingHolders' },
      { address: vault, abi: revenueVaultAbi, functionName: 'treasuryAccrued' },
      { address: vault, abi: revenueVaultAbi, functionName: 'nextSealAt' },
      { address: vault, abi: revenueVaultAbi, functionName: 'lastSealAt' },
      { address: vault, abi: revenueVaultAbi, functionName: 'HOLDER_BPS' },
      { address: vault, abi: revenueVaultAbi, functionName: 'EPOCH_MIN_INTERVAL' },
      { address: vault, abi: revenueVaultAbi, functionName: 'CLAIM_WINDOW' },
      { address: vault, abi: revenueVaultAbi, functionName: 'totalClaimable', args: [account] },
      { address: vault, abi: revenueVaultAbi, functionName: 'sealedUnclaimed' },
      { address: vault, abi: revenueVaultAbi, functionName: 'isSolvent' },
    ],
    query: { enabled, refetchInterval: 30_000 },
  });

  return useMemo<VaultState>(
    () => ({
      epochCount: asNumber(pick(data, 0)) ?? 0,
      pendingHolders: asBigInt(pick(data, 1)),
      treasuryAccrued: asBigInt(pick(data, 2)),
      nextSealAt: asBigInt(pick(data, 3)),
      lastSealAt: asBigInt(pick(data, 4)),
      holderBps: asBigInt(pick(data, 5)),
      epochIntervalSeconds: asBigInt(pick(data, 6)),
      claimWindowSeconds: asBigInt(pick(data, 7)),
      totalClaimable: user === null ? null : asBigInt(pick(data, 8)),
      sealedUnclaimed: asBigInt(pick(data, 9)),
      isSolvent: asBool(pick(data, 10)),
      isLoading: enabled && isLoading,
      isError: enabled && isError,
    }),
    [data, enabled, isError, isLoading, user],
  );
}

/* ═══════════════════════════════════════════════════════════ epochs ═════ */

export interface EpochRow {
  readonly id: number;
  /** Block number balances were read at. */
  readonly snapshot: number;
  readonly sealedAt: bigint;
  readonly holderAmount: bigint;
  readonly eligibleSupply: bigint;
  readonly claimed: bigint;
  readonly swept: boolean;
  /** `balanceOfAt(user, snapshot)` — `null` when nobody is connected. */
  readonly userBalanceAt: bigint | null;
  /** `holderAmount * userBalanceAt / eligibleSupply`, exactly as the vault computes it. */
  readonly userShare: bigint | null;
  /** What the user can still take from this epoch, right now. */
  readonly userClaimable: bigint;
  readonly hasClaimed: boolean;
}

export interface EpochsState {
  /** Newest first. */
  readonly rows: readonly EpochRow[];
  /** Epoch ids with a non-zero, unclaimed, unswept share. */
  readonly claimableIds: readonly bigint[];
  readonly totalClaimable: bigint;
  readonly lifetimeClaimed: bigint;
  /** True when older epochs were left unread to bound the number of calls. */
  readonly truncated: boolean;
  readonly isLoading: boolean;
}

/** Two years of weekly epochs. Older ones are past the 180-day claim window. */
const MAX_EPOCH_ROWS = 104;

const EMPTY_EPOCHS: EpochsState = {
  rows: [],
  claimableIds: [],
  totalClaimable: 0n,
  lifetimeClaimed: 0n,
  truncated: false,
  isLoading: false,
};

export function useEpochs(
  contracts: ContractAddresses | null,
  user: Address | null,
  epochCount: number,
): EpochsState {
  const vault = contracts?.revenueVault ?? zeroAddress;
  const token = contracts?.token ?? zeroAddress;
  const enabled = contracts !== null && epochCount > 0;

  const firstId = Math.max(0, epochCount - MAX_EPOCH_ROWS);
  const ids = useMemo<readonly number[]>(() => {
    if (!enabled) return [];
    const out: number[] = [];
    for (let id = firstId; id < epochCount; id += 1) out.push(id);
    return out;
  }, [enabled, epochCount, firstId]);

  /* Pass 1 — the epoch structs. `snapshot` is needed before any balance read. */
  const epochCalls = useMemo<readonly ContractFunctionParameters[]>(
    () =>
      ids.map((id) => ({
        address: vault,
        abi: revenueVaultAbi,
        functionName: 'epochs',
        args: [BigInt(id)],
      })),
    [ids, vault],
  );

  const { data: epochData, isLoading: epochsLoading } = useReadContracts({
    contracts: epochCalls,
    query: { enabled: enabled && epochCalls.length > 0, refetchInterval: 60_000 },
  });

  interface RawEpoch {
    readonly id: number;
    readonly snapshot: number;
    readonly sealedAt: bigint;
    readonly holderAmount: bigint;
    readonly eligibleSupply: bigint;
    readonly claimed: bigint;
    readonly swept: boolean;
  }

  const raw = useMemo<readonly RawEpoch[]>(() => {
    const out: RawEpoch[] = [];
    ids.forEach((id, index) => {
      const tuple = asTuple(pick(epochData, index));
      if (tuple === null) return;
      const snapshot = asNumber(tuple[0]);
      const sealedAt = asBigInt(tuple[1]);
      const holderAmount = asBigInt(tuple[2]);
      const eligibleSupply = asBigInt(tuple[3]);
      const claimed = asBigInt(tuple[4]);
      const swept = asBool(tuple[5]);
      if (
        snapshot === null ||
        sealedAt === null ||
        holderAmount === null ||
        eligibleSupply === null ||
        claimed === null ||
        swept === null
      ) {
        return;
      }
      out.push({ id, snapshot, sealedAt, holderAmount, eligibleSupply, claimed, swept });
    });
    return out;
  }, [epochData, ids]);

  /* Pass 2 — the caller's position in each epoch. Three reads per epoch:
     the historical balance, whether they already claimed, and the vault's own
     `claimable`, which is the authority when they have not. */
  const userCalls = useMemo<readonly ContractFunctionParameters[]>(() => {
    if (user === null) return [];
    const out: ContractFunctionParameters[] = [];
    for (const epoch of raw) {
      out.push({
        address: token,
        abi: teleHoodTokenAbi,
        functionName: 'balanceOfAt',
        args: [user, epoch.snapshot],
      });
      out.push({
        address: vault,
        abi: revenueVaultAbi,
        functionName: 'hasClaimed',
        args: [BigInt(epoch.id), user],
      });
      out.push({
        address: vault,
        abi: revenueVaultAbi,
        functionName: 'claimable',
        args: [user, BigInt(epoch.id)],
      });
    }
    return out;
  }, [raw, token, user, vault]);

  const { data: userData, isLoading: userLoading } = useReadContracts({
    contracts: userCalls,
    query: { enabled: userCalls.length > 0, refetchInterval: 30_000 },
  });

  return useMemo<EpochsState>(() => {
    if (!enabled) return EMPTY_EPOCHS;

    const rows: EpochRow[] = [];
    const claimableIds: bigint[] = [];
    let totalClaimable = 0n;
    let lifetimeClaimed = 0n;

    raw.forEach((epoch, index) => {
      const balance = user === null ? null : asBigInt(pick(userData, index * 3));
      const claimedFlag = user === null ? null : asBool(pick(userData, index * 3 + 1));
      const vaultClaimable = user === null ? null : asBigInt(pick(userData, index * 3 + 2));

      const share =
        balance === null || epoch.eligibleSupply === 0n
          ? balance === null
            ? null
            : 0n
          : (epoch.holderAmount * balance) / epoch.eligibleSupply;

      const hasClaimed = claimedFlag ?? false;
      let userClaimable = 0n;
      if (!hasClaimed && !epoch.swept) {
        userClaimable = vaultClaimable ?? share ?? 0n;
      }

      if (userClaimable > 0n) {
        claimableIds.push(BigInt(epoch.id));
        totalClaimable += userClaimable;
      }
      if (hasClaimed && share !== null) lifetimeClaimed += share;

      rows.push({
        id: epoch.id,
        snapshot: epoch.snapshot,
        sealedAt: epoch.sealedAt,
        holderAmount: epoch.holderAmount,
        eligibleSupply: epoch.eligibleSupply,
        claimed: epoch.claimed,
        swept: epoch.swept,
        userBalanceAt: balance,
        userShare: share,
        userClaimable,
        hasClaimed,
      });
    });

    rows.reverse();
    claimableIds.reverse();

    return {
      rows,
      claimableIds,
      totalClaimable,
      lifetimeClaimed,
      truncated: firstId > 0,
      isLoading: epochsLoading || (userCalls.length > 0 && userLoading),
    };
  }, [enabled, epochsLoading, firstId, raw, user, userCalls.length, userData, userLoading]);
}

/* ═════════════════════════════════════════════════════ revenue history ══ */

/** SPEC §4.5 — the event the whole revenue story is drawn from. */
const REVENUE_RECEIVED = parseAbiItem(
  'event RevenueReceived(address indexed from, uint256 amount, uint256 toHolders, uint256 toTreasury)',
);

export interface RevenueEntry {
  readonly blockNumber: bigint;
  readonly logIndex: number;
  readonly amount: bigint;
  readonly toHolders: bigint;
  readonly toTreasury: bigint;
}

export interface RevenueHistory {
  /** Oldest first. */
  readonly entries: readonly RevenueEntry[];
  readonly total: bigint;
  readonly toHolders: bigint;
  readonly toTreasury: bigint;
  /** First block actually scanned — shown when the scan had to be bounded. */
  readonly scannedFrom: bigint;
  readonly scannedTo: bigint;
  /** True when older history exists but was not read. */
  readonly partial: boolean;
  /** Unix seconds of the first and last payment, when the blocks were readable. */
  readonly firstAt: bigint | null;
  readonly lastAt: bigint | null;
}

async function scanRevenue(
  client: ReadClient,
  address: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<{ entries: RevenueEntry[]; scannedFrom: bigint; partial: boolean }> {
  const collect = (
    logs: readonly {
      blockNumber: bigint;
      logIndex: number;
      args: { amount: bigint; toHolders: bigint; toTreasury: bigint };
    }[],
  ): RevenueEntry[] =>
    logs.map((log) => ({
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      amount: log.args.amount,
      toHolders: log.args.toHolders,
      toTreasury: log.args.toTreasury,
    }));

  /* Fast path: anvil and most self-hosted endpoints answer the whole range. */
  try {
    const logs = await client.getLogs({
      address,
      event: REVENUE_RECEIVED,
      fromBlock,
      toBlock,
      strict: true,
    });
    return { entries: collect(logs), scannedFrom: fromBlock, partial: false };
  } catch {
    /* Fall through to a bounded backwards scan. */
  }

  const entries: RevenueEntry[] = [];
  let cursor = toBlock;
  let scannedFrom = toBlock;
  let chunks = 0;
  let reachedStart = false;

  while (cursor >= fromBlock && chunks < MAX_CHUNKS) {
    const lowerCandidate = cursor - LOG_CHUNK + 1n;
    const lower = lowerCandidate > fromBlock ? lowerCandidate : fromBlock;

    try {
      const logs = await client.getLogs({
        address,
        event: REVENUE_RECEIVED,
        fromBlock: lower,
        toBlock: cursor,
        strict: true,
      });
      entries.push(...collect(logs));
    } catch {
      /* One bad window must not discard the history we already have. */
      break;
    }

    scannedFrom = lower;
    chunks += 1;
    if (lower <= fromBlock) {
      reachedStart = true;
      break;
    }
    cursor = lower - 1n;
  }

  entries.sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? a.logIndex - b.logIndex
      : a.blockNumber < b.blockNumber
        ? -1
        : 1,
  );

  return { entries, scannedFrom, partial: !reachedStart && scannedFrom > fromBlock };
}

export type RevenueHistoryResult = UseQueryResult<RevenueHistory, Error>;

/**
 * `RevenueReceived` history, read straight from the chain with viem `getLogs`.
 *
 * The relay is not involved: this panel must be true even with the indexer
 * down, because it is the evidence behind the 50/50 claim.
 */
export function useRevenueHistory(
  contracts: ContractAddresses | null,
): RevenueHistoryResult {
  const client = usePublicClient({ chainId: ACTIVE_CHAIN_ID });
  const vault = contracts?.revenueVault ?? null;

  return useQuery<RevenueHistory, Error>({
    queryKey: ['access', 'revenue-history', ACTIVE_CHAIN_ID, vault],
    enabled: client !== undefined && vault !== null,
    staleTime: 30_000,
    refetchInterval: 60_000,
    queryFn: async (): Promise<RevenueHistory> => {
      if (client === undefined || vault === null) {
        throw new Error('No read client for the active chain.');
      }

      const head = await client.getBlockNumber();
      const from = startBlockFromEnv();
      const { entries, scannedFrom, partial } = await scanRevenue(
        client,
        vault,
        from > head ? head : from,
        head,
      );

      let total = 0n;
      let toHolders = 0n;
      let toTreasury = 0n;
      for (const entry of entries) {
        total += entry.amount;
        toHolders += entry.toHolders;
        toTreasury += entry.toTreasury;
      }

      /* Two extra calls at most, and only to date-stamp the strip. */
      let firstAt: bigint | null = null;
      let lastAt: bigint | null = null;
      const first = entries[0];
      const last = entries[entries.length - 1];
      if (first !== undefined && last !== undefined) {
        try {
          const [a, b] = await Promise.all([
            client.getBlock({ blockNumber: first.blockNumber }),
            client.getBlock({ blockNumber: last.blockNumber }),
          ]);
          firstAt = a.timestamp;
          lastAt = b.timestamp;
        } catch {
          firstAt = null;
          lastAt = null;
        }
      }

      return {
        entries,
        total,
        toHolders,
        toTreasury,
        scannedFrom,
        scannedTo: head,
        partial,
        firstAt,
        lastAt,
      };
    },
  });
}

/* ═══════════════════════════════════════════════════ handle validation ══ */

export type HandleProblem =
  | 'empty'
  | 'too-short'
  | 'too-long'
  | 'bad-start'
  | 'bad-chars'
  | null;

/**
 * Client-side mirror of `Handles.isValidName`: 2–15 chars of `[a-z0-9_]`,
 * starting with a letter. The chain read is still the authority — this only
 * exists so typing gets an answer before a round trip.
 */
export function validateHandle(name: string): HandleProblem {
  if (name.length === 0) return 'empty';
  if (name.length < CONTRACT_CONSTANTS.handleMinLength) return 'too-short';
  if (name.length > CONTRACT_CONSTANTS.handleMaxLength) return 'too-long';
  if (!/^[a-z]/.test(name)) return 'bad-start';
  if (!/^[a-z0-9_]+$/.test(name)) return 'bad-chars';
  return null;
}

/** Mirror of `Handles.requiredTier(length)` — 5+ free, 4/3/2 tiered. */
export function requiredTierForLength(length: number): PerkTierId {
  if (length >= 5) return PerkTier.NONE;
  if (length === 4) return PerkTier.BLOCK_CAPTAIN;
  if (length === 3) return PerkTier.DISTRICT;
  return PerkTier.KINGPIN;
}
