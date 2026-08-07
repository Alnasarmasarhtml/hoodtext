/**
 * Real chain errors, in plain language.
 *
 * Every write on `/access` goes through here. A wallet rejection, an ERC20
 * allowance shortfall and a contract-level revert are three completely
 * different situations for the person at the keyboard, and the UI must say
 * which one happened — never "execution reverted", never a raw stack.
 *
 * Decoding relies on viem's typed error chain: `BaseError.walk()` finds the
 * innermost cause, and `ContractFunctionRevertedError.data.errorName` carries
 * the custom error the contract actually threw (SPEC §4 — custom errors, never
 * revert strings).
 */

import {
  BaseError,
  ContractFunctionRevertedError,
  UserRejectedRequestError,
} from 'viem';

import { formatToken } from '@/lib/format';

export type ChainErrorKind =
  | 'rejected'
  | 'insufficient-balance'
  | 'insufficient-allowance'
  | 'insufficient-gas'
  | 'not-due'
  | 'reverted'
  | 'network'
  | 'unknown';

export interface ChainErrorInfo {
  readonly kind: ChainErrorKind;
  /** One short line, safe to use as a heading. */
  readonly title: string;
  /** What happened and what to do next. Always non-empty. */
  readonly detail: string;
  /** The Solidity custom error, when the failure was a contract revert. */
  readonly revertName: string | null;
}

/* ────────────────────────────────────────────────────────── narrowing ───── */

function readProperty(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

function readCode(error: unknown): number | null {
  const code = readProperty(error, 'code');
  if (typeof code === 'number') return code;
  const cause = readProperty(error, 'cause');
  if (cause === undefined || cause === error) return null;
  const nested = readProperty(cause, 'code');
  return typeof nested === 'number' ? nested : null;
}

function messageOf(error: unknown): string {
  const short = readProperty(error, 'shortMessage');
  if (typeof short === 'string' && short.trim() !== '') return short.trim();
  if (error instanceof Error && error.message.trim() !== '') {
    const first = error.message.split('\n')[0] ?? error.message;
    return first.trim();
  }
  if (typeof error === 'string' && error.trim() !== '') return error.trim();
  return '';
}

function clip(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function findRevert(error: unknown): ContractFunctionRevertedError | null {
  if (error instanceof ContractFunctionRevertedError) return error;
  if (!(error instanceof BaseError)) return null;
  const found = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
  return found instanceof ContractFunctionRevertedError ? found : null;
}

function isRejection(error: unknown): boolean {
  if (error instanceof UserRejectedRequestError) return true;
  if (error instanceof BaseError) {
    const found = error.walk((cause) => cause instanceof UserRejectedRequestError);
    if (found !== null) return true;
  }
  /* EIP-1193 userRejectedRequest, for wallets viem has not wrapped. */
  if (readCode(error) === 4001) return true;
  const message = messageOf(error).toLowerCase();
  return (
    message.includes('user rejected') ||
    message.includes('user denied') ||
    message.includes('rejected the request')
  );
}

function amountOf(args: readonly unknown[] | undefined, index: number): string | null {
  if (args === undefined) return null;
  const value = args[index];
  return typeof value === 'bigint'
    ? formatToken(value, { digits: 4, symbol: 'GRAM' })
    : null;
}

function revertArgs(error: ContractFunctionRevertedError): readonly unknown[] | undefined {
  const args = error.data?.args;
  return Array.isArray(args) ? (args as readonly unknown[]) : undefined;
}

/* ─────────────────────────────────────────────────────── revert copy ────── */

interface RevertCopy {
  readonly kind: ChainErrorKind;
  readonly title: string;
  readonly detail: string;
}

/**
 * Every custom error the contracts on this page can throw (SPEC §4),
 * written for the person who hit it.
 */
const REVERT_COPY: Readonly<Record<string, RevertCopy>> = {
  /* — ERC20 — */
  ERC20InsufficientBalance: {
    kind: 'insufficient-balance',
    title: 'Not enough $GRAM',
    detail: 'Your wallet holds less $GRAM than this payment requires.',
  },
  ERC20InsufficientAllowance: {
    kind: 'insufficient-allowance',
    title: 'Approval too small',
    detail:
      'The contract is not approved to move this much $GRAM yet. Run the approve step again.',
  },

  /* — Activation — */
  AlreadyActivated: {
    kind: 'reverted',
    title: 'Already activated',
    detail:
      'This account exists and it exists forever — the $5 is paid exactly once. Nothing was charged.',
  },
  NotActivated: {
    kind: 'reverted',
    title: 'Account not activated',
    detail:
      'This action needs an activated account. Pay the one-time $5 activation above and try again.',
  },
  PermitFailed: {
    kind: 'reverted',
    title: 'Permit rejected',
    detail:
      'The signed permit was not accepted. Approve in a separate transaction instead.',
  },
  InvalidPrice: {
    kind: 'reverted',
    title: 'Price not set',
    detail:
      'The USD price is not configured on chain, so no quote can be produced.',
  },

  /* — GroupRegistry — */
  InvalidMonths: {
    kind: 'reverted',
    title: 'Invalid term',
    detail: 'Room rent is paid 1 to 24 months at a time. Adjust the month stepper.',
  },
  NotDue: {
    kind: 'not-due',
    title: 'Renewal is not due yet',
    detail:
      'A permissionless renewal can only fire inside the last 3 days of a room’s paid term. Nothing was charged.',
  },
  AutoRenewOff: {
    kind: 'reverted',
    title: 'Auto-renew is off',
    detail: 'The room’s admin has auto-renew switched off, so nobody can trigger a renewal for it.',
  },
  NotAdmin: {
    kind: 'reverted',
    title: 'Not the room admin',
    detail:
      'Only the room’s admin can do this. Anyone may pay a room’s rent — but paying grants no control.',
  },
  InvalidGroup: {
    kind: 'reverted',
    title: 'Invalid room id',
    detail: 'The room id was empty or malformed. Nothing was changed.',
  },
  GroupExists: {
    kind: 'reverted',
    title: 'Room already exists',
    detail: 'A room with this id already exists on chain.',
  },
  UnknownGroup: {
    kind: 'reverted',
    title: 'Unknown room',
    detail: 'No room with this id exists. Refresh the page and try again.',
  },

  /* — Anchors — */
  RoomInactive: {
    kind: 'reverted',
    title: 'Room rent has lapsed',
    detail:
      'New messages are blocked while a room’s rent is unpaid. History and membership survive — paying the rent reopens it.',
  },
  NotRelayer: {
    kind: 'reverted',
    title: 'Not an approved relayer',
    detail: 'Only approved relayers may post batches. Self-posting a single drop always works.',
  },
  EmptyBatch: {
    kind: 'reverted',
    title: 'Empty batch',
    detail: 'A batch must contain at least one drop. Nothing was posted.',
  },
  BatchTooLarge: {
    kind: 'reverted',
    title: 'Batch too large',
    detail: 'A batch is capped at 64 drops. Nothing was posted.',
  },

  /* — Handles — */
  InvalidHandle: {
    kind: 'reverted',
    title: 'Invalid handle',
    detail:
      'A handle is 2–15 characters of a–z, 0–9 and _, and must start with a letter.',
  },
  HandleTaken: {
    kind: 'reverted',
    title: 'Handle taken',
    detail: 'Someone claimed this name first. Pick another.',
  },
  TierTooLow: {
    kind: 'reverted',
    title: 'Tier too low for this length',
    detail:
      'Short handles are reserved: 4 characters need BLOCK CAPTAIN, 3 need DISTRICT, 2 need KINGPIN. 5+ characters are open to every activated account.',
  },
  NoHandle: {
    kind: 'reverted',
    title: 'No handle to release',
    detail: 'This address holds no handle, so there is nothing to release.',
  },

  /* — RevenueVault — */
  NotNotifier: {
    kind: 'reverted',
    title: 'Not an approved notifier',
    detail: 'Only the Activation and GroupRegistry contracts may notify the vault of revenue.',
  },
  NothingToSeal: {
    kind: 'reverted',
    title: 'Nothing to seal',
    detail:
      'No revenue has arrived since the last epoch, so there is nothing to snapshot.',
  },
  TooSoon: {
    kind: 'reverted',
    title: 'Too soon to seal',
    detail: 'Epochs are at least 7 days apart. The countdown shows when sealing opens.',
  },
  AlreadyClaimed: {
    kind: 'reverted',
    title: 'Already claimed',
    detail: 'You have already claimed one of these epochs. Refresh and try again.',
  },
  UnknownEpoch: {
    kind: 'reverted',
    title: 'Unknown epoch',
    detail: 'That epoch does not exist. Refresh the page and try again.',
  },
  AlreadySwept: {
    kind: 'reverted',
    title: 'Epoch already swept',
    detail:
      'The 180-day claim window closed and the remainder moved to the treasury.',
  },
  ClaimWindowOpen: {
    kind: 'reverted',
    title: 'Claim window still open',
    detail: 'An epoch can only be swept once its 180-day claim window has closed.',
  },
  NotFunded: {
    kind: 'reverted',
    title: 'Vault balance too low',
    detail:
      'The vault does not hold enough $GRAM to back this epoch. This is a solvency failure — do not retry.',
  },
  InsufficientTreasury: {
    kind: 'reverted',
    title: 'Treasury balance too low',
    detail: 'The treasury has not accrued that much $GRAM.',
  },
  TooManyExcluded: {
    kind: 'reverted',
    title: 'Exclusion list full',
    detail: 'The vault allows at most 16 excluded addresses.',
  },
  ReentrancyGuardReentrantCall: {
    kind: 'reverted',
    title: 'Reentrant call blocked',
    detail: 'The vault refused a nested call into claim. Nothing moved.',
  },

  /* — Perks — */
  InvalidTier: {
    kind: 'reverted',
    title: 'Invalid tier',
    detail: 'Perk tiers run 1 to 4. Nothing was changed.',
  },
  InvalidThresholds: {
    kind: 'reverted',
    title: 'Invalid thresholds',
    detail: 'Tier thresholds must be non-zero and strictly increasing.',
  },

  /* — shared — */
  ZeroAddress: {
    kind: 'reverted',
    title: 'Zero address',
    detail: 'A required address was zero. Nothing was changed.',
  },
  FutureLookup: {
    kind: 'reverted',
    title: 'Snapshot is in the future',
    detail:
      'Historical balances can only be read for blocks that are already mined.',
  },
  OwnableUnauthorizedAccount: {
    kind: 'reverted',
    title: 'Not permitted',
    detail: 'This action is restricted to the contract owner.',
  },
  SafeERC20FailedOperation: {
    kind: 'reverted',
    title: 'Token transfer failed',
    detail: 'The $GRAM transfer did not succeed. Nothing was charged.',
  },
  InvalidRate: {
    kind: 'reverted',
    title: 'Invalid rate',
    detail: 'The price source rejected a zero rate. Nothing was changed.',
  },
};

/* ───────────────────────────────────────────────────────── public API ───── */

export interface DescribeOptions {
  /** What the user was doing, e.g. "Approving $GRAM". Used in fallback copy. */
  readonly action?: string;
}

/**
 * Turn anything thrown by wagmi/viem into something worth showing a person.
 *
 * @example
 * try { await activate(); }
 * catch (error) { setError(describeChainError(error, { action: 'Activating' })); }
 */
export function describeChainError(
  error: unknown,
  options: DescribeOptions = {},
): ChainErrorInfo {
  const action = options.action ?? 'The transaction';

  if (isRejection(error)) {
    return {
      kind: 'rejected',
      title: 'Rejected in your wallet',
      detail: `${action} was cancelled. Nothing was sent and nothing was charged.`,
      revertName: null,
    };
  }

  const revert = findRevert(error);
  if (revert !== null) {
    const name = revert.data?.errorName ?? null;
    const copy = name === null ? undefined : REVERT_COPY[name];

    if (copy !== undefined && name !== null) {
      const args = revertArgs(revert);
      let detail = copy.detail;

      if (name === 'ERC20InsufficientBalance') {
        const balance = amountOf(args, 1);
        const needed = amountOf(args, 2);
        if (balance !== null && needed !== null) {
          detail = `You hold ${balance} and this requires ${needed}. Top up and try again.`;
        }
      } else if (name === 'ERC20InsufficientAllowance') {
        const allowance = amountOf(args, 1);
        const needed = amountOf(args, 2);
        if (allowance !== null && needed !== null) {
          detail = `You approved ${allowance} but ${needed} is required. Run the approve step again.`;
        }
      }

      return { kind: copy.kind, title: copy.title, detail, revertName: name };
    }

    const reason = revert.reason;
    const fallback = name ?? messageOf(revert);
    return {
      kind: 'reverted',
      title: 'The contract rejected this',
      detail: clip(
        reason !== undefined && reason !== ''
          ? reason
          : fallback === ''
            ? 'The call reverted on chain. Nothing was charged.'
            : fallback,
      ),
      revertName: name,
    };
  }

  const message = messageOf(error);
  const lower = message.toLowerCase();

  if (lower.includes('insufficient funds')) {
    return {
      kind: 'insufficient-gas',
      title: 'Not enough ETH for gas',
      detail:
        'Robinhood Chain gas is paid in ETH — around a cent per transaction. Top up and try again.',
      revertName: null,
    };
  }

  if (
    lower.includes('fetch') ||
    lower.includes('network') ||
    lower.includes('timed out') ||
    lower.includes('timeout') ||
    lower.includes('http request failed')
  ) {
    return {
      kind: 'network',
      title: 'Could not reach the network',
      detail:
        'The RPC endpoint did not answer. Your funds are untouched — check your connection and try again.',
      revertName: null,
    };
  }

  return {
    kind: 'unknown',
    title: `${action} failed`,
    detail:
      message === ''
        ? 'The wallet returned no reason. Nothing was charged.'
        : clip(message),
    revertName: null,
  };
}
