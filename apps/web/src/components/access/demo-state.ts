'use client';

/**
 * The `/access` fixture world, shaped into the exact state objects the real
 * panels consume.
 *
 * `src/lib/demo.ts` owns the numbers; this module only derives. Everything is
 * computed in bigint from `DEMO_ACCESS` so the page stays internally exact:
 * the four sealed epochs sum to `toHolders`, `toHolders` is half of
 * `totalRevenue`, the revenue staircase's entries sum to the same total, and
 * the claimable figure equals the two unclaimed epoch shares. Nothing here is
 * read from a chain — demo mode passes `null` into every read hook and feeds
 * these objects to the panels instead.
 */

import { CONTRACT_CONSTANTS, PRICES } from '@/lib/abi';
import { DEMO_ACCESS, DEMO_ME, DEMO_ROOMS } from '@/lib/demo';
import type {
  ActivationState,
  EpochRow,
  EpochsState,
  HandleState,
  PerksState,
  PricingState,
  RevenueEntry,
  RevenueHistory,
  RevenueHistoryView,
  RoomRow,
  RoomsState,
  TokenState,
  VaultState,
} from './use-access-data';

const E18 = 10n ** 18n;

/** The fixed 1,000,000,000 $GRAM supply (SPEC §4.1). */
const SUPPLY = 1_000_000_000n * E18;

/** Perk thresholds in bps of supply: RESIDENT 5 / CAPTAIN 10 / DISTRICT 25 / KINGPIN 50. */
const THRESHOLD_BPS: readonly bigint[] = [5n, 10n, 25n, 50n];

const DAY_SECONDS = 86_400;
const WEEK_SECONDS = 7 * DAY_SECONDS;

/* A plausible chain clock: ~2s blocks under a fixed head. Only used to give
   snapshots and log entries coherent, monotonic block heights. */
const BLOCK_SECONDS = 2;
const HEAD_BLOCK = 11_284_003;

function blockAt(nowSec: number, atSec: number): number {
  return HEAD_BLOCK - Math.max(0, Math.floor((nowSec - atSec) / BLOCK_SECONDS));
}

/**
 * Room names live client-side in the messenger, never on chain — so the demo
 * room card resolves its name from the fixture world by groupId.
 */
export function demoRoomName(groupId: string): string | null {
  const needle = groupId.toLowerCase();
  const room = DEMO_ROOMS.find((entry) => entry.groupId.toLowerCase() === needle);
  return room === undefined ? null : room.name;
}

/** Everything `AccessPage` swaps in when demo mode is on. */
export interface DemoAccessWorld {
  readonly pricing: PricingState;
  readonly activation: ActivationState;
  readonly handle: HandleState;
  readonly perks: PerksState;
  readonly token: TokenState;
  readonly rooms: RoomsState;
  readonly vault: VaultState;
  readonly epochs: EpochsState;
  readonly history: RevenueHistoryView;
}

/* ─────────────────────────────────────────────────────── revenue series ── */

/**
 * Payment sizes, cycled. Units are "roughly a thousand GRAM": mostly $5
 * activations and single months of rent, with the occasional multi-month rent
 * prepay carrying the volume — which is how two fixed prices actually produce
 * a lumpy series. Window totals are distributed pro-rata over the cycle, so
 * amounts drift around the nominal quote exactly as a moving $/GRAM rate
 * would make them.
 */
const PAYMENT_WEIGHTS: readonly number[] = [
  5, 10, 5, 240, 5, 30, 10, 5, 120, 5, 60, 10, 5, 240, 5, 20, 10, 5, 180, 5,
];

const ENTRIES_PER_WINDOW = 44;

/**
 * One `RevenueReceived` series across the four epoch windows. Each window's
 * entries sum exactly to `holderAmount × 2`, so the strip's total, the 50/50
 * split and the epoch table all agree to the wei.
 */
function buildRevenueHistory(nowSec: number): RevenueHistory {
  const windows = DEMO_ACCESS.epochs
    .slice()
    .reverse() /* oldest first — the staircase is drawn left to right */
    .map((epoch) => {
      const endSec = nowSec - Math.floor(epoch.agoMs / 1000);
      return {
        revenue: epoch.holderAmount * 2n,
        startSec: endSec - WEEK_SECONDS,
        endSec,
      };
    });

  const entries: RevenueEntry[] = [];
  let firstSec: number | null = null;
  let lastSec: number | null = null;

  for (const window of windows) {
    let weightTotal = 0n;
    const weights: number[] = [];
    for (let i = 0; i < ENTRIES_PER_WINDOW; i += 1) {
      const weight = PAYMENT_WEIGHTS[i % PAYMENT_WEIGHTS.length] ?? 5;
      weights.push(weight);
      weightTotal += BigInt(weight);
    }

    let allocated = 0n;
    weights.forEach((weight, index) => {
      const isLast = index === weights.length - 1;
      const amount = isLast
        ? window.revenue - allocated
        : (window.revenue * BigInt(weight)) / weightTotal;
      allocated += amount;

      /* Deterministic jitter keeps the ticks from reading as a metronome while
         staying strictly monotonic in block order. */
      const jitter = ((weight * 37) % 11) / 22;
      const frac = (index + 0.3 + jitter) / ENTRIES_PER_WINDOW;
      const atSec = Math.floor(
        window.startSec + (window.endSec - window.startSec) * frac,
      );
      if (firstSec === null) firstSec = atSec;
      lastSec = atSec;

      const toHolders = amount / 2n;
      entries.push({
        blockNumber: BigInt(blockAt(nowSec, atSec)),
        logIndex: (index * 3) % 7,
        amount,
        toHolders,
        toTreasury: amount - toHolders,
      });
    });
  }

  let total = 0n;
  let toHolders = 0n;
  let toTreasury = 0n;
  for (const entry of entries) {
    total += entry.amount;
    toHolders += entry.toHolders;
    toTreasury += entry.toTreasury;
  }

  const first = entries[0];

  return {
    entries,
    total,
    toHolders,
    toTreasury,
    scannedFrom: first === undefined ? 0n : first.blockNumber - 900n,
    scannedTo: BigInt(HEAD_BLOCK),
    partial: false,
    firstAt: firstSec === null ? null : BigInt(firstSec),
    lastAt: lastSec === null ? null : BigInt(lastSec),
  };
}

/* ─────────────────────────────────────────────────────────────── epochs ── */

/** Pool-level claim progress per epoch — older pools are more fully claimed. */
const CLAIMED_POOL_BPS: ReadonlyMap<number, bigint> = new Map<number, bigint>([
  [3, 3_324n],
  [2, 6_821n],
  [1, 9_148n],
  [0, 9_831n],
]);

interface DemoEpochWorld {
  readonly rows: readonly EpochRow[];
  readonly claimableIds: readonly bigint[];
  readonly sealedUnclaimed: bigint;
}

function buildEpochRows(nowSec: number, claimedAll: boolean): DemoEpochWorld {
  const rows: EpochRow[] = DEMO_ACCESS.epochs.map((epoch) => {
    const sealedSec = nowSec - Math.floor(epoch.agoMs / 1000);
    const hasClaimed = epoch.claimed || claimedAll;

    const poolClaimedBase =
      (epoch.holderAmount * (CLAIMED_POOL_BPS.get(epoch.id) ?? 5_000n)) / 10_000n;
    const poolClaimed =
      claimedAll && !epoch.claimed
        ? poolClaimedBase + epoch.myShare
        : poolClaimedBase;

    return {
      id: epoch.id,
      snapshot: blockAt(nowSec, sealedSec),
      sealedAt: BigInt(sealedSec),
      holderAmount: epoch.holderAmount,
      /* Derived so `holderAmount × balance ÷ eligibleSupply` reproduces the
         fixture share — the same arithmetic the vault performs. */
      eligibleSupply: (epoch.holderAmount * DEMO_ACCESS.eligibleBalance) / epoch.myShare,
      claimed: poolClaimed,
      swept: false,
      userBalanceAt: DEMO_ACCESS.eligibleBalance,
      userShare: epoch.myShare,
      userClaimable: hasClaimed ? 0n : epoch.myShare,
      hasClaimed,
    };
  });

  let sealedUnclaimed = 0n;
  for (const row of rows) sealedUnclaimed += row.holderAmount - row.claimed;

  return {
    rows,
    claimableIds: rows
      .filter((row) => row.userClaimable > 0n)
      .map((row) => BigInt(row.id)),
    sealedUnclaimed,
  };
}

/* ─────────────────────────────────────────────────────────── the world ── */

/**
 * Build the full demo `/access` state.
 *
 * @param claimedAll — true after the visitor presses the demo "claim all":
 * the unclaimed epochs flip to claimed, claimable drops to zero and lifetime
 * claimed absorbs it, exactly as a confirmed `claimMany` would read back.
 */
export function buildDemoAccessWorld(claimedAll: boolean): DemoAccessWorld {
  const nowSec = Math.floor(Date.now() / 1000);

  const { rows, claimableIds, sealedUnclaimed } = buildEpochRows(nowSec, claimedAll);
  const totalClaimable = claimedAll ? 0n : DEMO_ACCESS.claimable;
  const lifetimeClaimed = claimedAll
    ? DEMO_ACCESS.lifetimeClaimed + DEMO_ACCESS.claimable
    : DEMO_ACCESS.lifetimeClaimed;

  const latestSnapshot = rows[0]?.snapshot ?? HEAD_BLOCK;

  const pricing: PricingState = {
    activationQuote: DEMO_ACCESS.activationQuote,
    activationUsd: BigInt(PRICES.activationUsd) * E18,
    rentUsdPerMonth: BigInt(PRICES.roomUsdPerMonth) * E18,
    rentMonthQuote: DEMO_ACCESS.rentPerMonth,
    thoodPerUsd: DEMO_ACCESS.thoodPerUsd,
    monthSeconds: BigInt(CONTRACT_CONSTANTS.monthSeconds),
    maxMonths: CONTRACT_CONSTANTS.maxMonths,
    renewWindowSeconds: BigInt(CONTRACT_CONSTANTS.renewWindowSeconds),
    isLoading: false,
    isError: false,
  };

  const activation: ActivationState = {
    isActivated: true,
    activatedAt: BigInt(Math.floor(DEMO_ACCESS.activatedAt / 1000)),
    isLoading: false,
  };

  const handle: HandleState = {
    handle: DEMO_ME.handle,
    isLoading: false,
  };

  const perks: PerksState = {
    tier: DEMO_ME.tier,
    eligibleBalance: DEMO_ACCESS.eligibleBalance,
    thresholds: THRESHOLD_BPS.map((bps) => (SUPPLY * bps) / 10_000n),
    latestSnapshot: BigInt(latestSnapshot),
    isLoading: false,
  };

  const token: TokenState = {
    balance: DEMO_ACCESS.walletBalance,
    activationAllowance: null,
    /* Auto-renew is armed, so the registry allowance is funded well ahead. */
    registryAllowance: DEMO_ACCESS.rentPerMonth * 24n,
    totalSupply: SUPPLY,
    isLoading: false,
  };

  /* Only rooms the demo identity actually admins — the lapsed "night shift"
     room belongs to someone else and must not appear in the rooms-you-run
     panel. */
  const roomRows: RoomRow[] = DEMO_ROOMS.filter(
    (room) => room.admin.toLowerCase() === DEMO_ME.address.toLowerCase(),
  ).map((room) => ({
    id: room.groupId,
    admin: room.admin,
    epoch: 4,
    createdAt: BigInt(nowSec - 47 * DAY_SECONDS),
    paidUntil: BigInt(nowSec + Math.floor(room.paidForMs / 1000)),
    autoRenew: room.autoRenew,
  }));

  const rooms: RoomsState = {
    rooms: roomRows,
    partial: false,
    isLoading: false,
    isError: false,
  };

  const lastSealAgoMs = DEMO_ACCESS.epochs[0].agoMs;

  const vault: VaultState = {
    epochCount: DEMO_ACCESS.epochs.length,
    /* The sealed epochs account for every banked wei — the pending pot is
       empty until the next payment arrives. */
    pendingHolders: 0n,
    treasuryAccrued: DEMO_ACCESS.totalRevenue - DEMO_ACCESS.toHolders,
    nextSealAt: BigInt(nowSec + Math.floor(DEMO_ACCESS.nextSealInMs / 1000)),
    lastSealAt: BigInt(nowSec - Math.floor(lastSealAgoMs / 1000)),
    holderBps: 5_000n,
    epochIntervalSeconds: BigInt(CONTRACT_CONSTANTS.epochMinIntervalSeconds),
    claimWindowSeconds: BigInt(CONTRACT_CONSTANTS.claimWindowSeconds),
    totalClaimable,
    sealedUnclaimed,
    isSolvent: true,
    isLoading: false,
    isError: false,
  };

  const epochs: EpochsState = {
    rows,
    claimableIds,
    totalClaimable,
    lifetimeClaimed,
    truncated: false,
    isLoading: false,
  };

  const history: RevenueHistoryView = {
    data: buildRevenueHistory(nowSec),
    isPending: false,
    isError: false,
  };

  return { pricing, activation, handle, perks, token, rooms, vault, epochs, history };
}
