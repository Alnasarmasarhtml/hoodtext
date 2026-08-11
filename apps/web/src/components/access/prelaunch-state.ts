/**
 * The `/access` world before launch: every figure zero, because that is the
 * truth.
 *
 * The site is compiled against the test network, where the proof run created
 * activations, revenue and sealed epochs. Reading those numbers onto the public
 * page would present test activity as money, so before launch the page reads
 * nothing at all: `AccessPage` drives every hook with `null` (no RPC is ever
 * touched) and feeds the panels this object instead. The panels then render
 * their own honest empty states: no epochs sealed, nothing claimable, zero paid
 * to holders.
 *
 * The two USD prices are real constants from the contracts, so the page can
 * still say what things will cost. Every $GRAM quote is `null` on purpose:
 * conversion happens at the moment of payment, at the rate the chain reports
 * then, and printing a number today would just be a stale guess.
 */

import { CONTRACT_CONSTANTS, PRICES } from '@/lib/abi';
import type { DemoAccessWorld } from './demo-state';
import type { RevenueHistory } from './use-access-data';

const E18 = 10n ** 18n;

const EMPTY_HISTORY: RevenueHistory = {
  entries: [],
  total: 0n,
  toHolders: 0n,
  toTreasury: 0n,
  scannedFrom: 0n,
  scannedTo: 0n,
  partial: false,
  firstAt: null,
  lastAt: null,
};

export const PRELAUNCH_WORLD: DemoAccessWorld = {
  pricing: {
    activationQuote: null,
    activationUsd: BigInt(PRICES.activationUsd) * E18,
    rentUsdPerMonth: BigInt(PRICES.roomUsdPerMonth) * E18,
    rentMonthQuote: null,
    thoodPerUsd: null,
    monthSeconds: BigInt(CONTRACT_CONSTANTS.monthSeconds),
    maxMonths: CONTRACT_CONSTANTS.maxMonths,
    renewWindowSeconds: BigInt(CONTRACT_CONSTANTS.renewWindowSeconds),
    isLoading: false,
    isError: false,
  },
  activation: {
    isActivated: false,
    activatedAt: 0n,
    isLoading: false,
  },
  handle: {
    handle: null,
    isLoading: false,
  },
  perks: {
    tier: 0,
    eligibleBalance: null,
    thresholds: [null, null, null, null],
    latestSnapshot: null,
    isLoading: false,
  },
  token: {
    balance: null,
    activationAllowance: null,
    registryAllowance: null,
    totalSupply: 1_000_000_000n * E18,
    isLoading: false,
  },
  rooms: {
    rooms: [],
    partial: false,
    isLoading: false,
    isError: false,
  },
  vault: {
    epochCount: 0,
    pendingHolders: 0n,
    treasuryAccrued: 0n,
    nextSealAt: null,
    lastSealAt: null,
    holderBps: BigInt(CONTRACT_CONSTANTS.holderBps),
    epochIntervalSeconds: BigInt(CONTRACT_CONSTANTS.epochMinIntervalSeconds),
    claimWindowSeconds: BigInt(CONTRACT_CONSTANTS.claimWindowSeconds),
    totalClaimable: 0n,
    sealedUnclaimed: 0n,
    isSolvent: true,
    isLoading: false,
    isError: false,
  },
  epochs: {
    rows: [],
    claimableIds: [],
    totalClaimable: 0n,
    lifetimeClaimed: 0n,
    truncated: false,
    isLoading: false,
  },
  history: {
    data: EMPTY_HISTORY,
    isPending: false,
    isError: false,
  },
};
