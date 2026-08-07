/**
 * Chain and relay errors, turned into something a person can act on.
 *
 * viem stacks four or five wrapper errors around a revert; showing the raw
 * `message` gives the user a wall of RPC noise. This walks to the cause that
 * actually matters and maps our own custom errors to plain sentences.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  UserRejectedRequestError,
} from 'viem';

import { RelayError } from '@/lib/relay';

const MAX_LENGTH = 220;

function trim(message: string): string {
  const first = message.split('\n')[0] ?? message;
  return first.length > MAX_LENGTH ? `${first.slice(0, MAX_LENGTH - 1)}…` : first;
}

/** Custom errors from SPEC §4, in the wording the messenger should use. */
const REVERT_COPY: Readonly<Record<string, string>> = {
  NotActivated:
    'The chain rejected this: the account is not activated. Activation is $5 in $GRAM, once, forever — nothing was lost.',
  AlreadyActivated: 'This account is already activated — there is nothing to pay twice.',
  RoomInactive:
    'This room’s rent has lapsed, so new messages are blocked. Any member can pay rent to reopen it — history and membership are untouched.',
  NotAdmin: 'Only the room’s admin can do that.',
  UnknownGroup: 'That room does not exist on chain.',
  GroupExists: 'A room with that id already exists — the random salt should make this unreachable; try again.',
  InvalidGroup: 'The room id is invalid.',
  InvalidMonths: 'Rent is paid 1–24 months at a time.',
  NotDue: 'The room is not inside its renewal window yet.',
  AutoRenewOff: 'Auto-renew is switched off for this room.',
  InvalidPrice: 'The price source returned an invalid rate. Try again in a moment.',
  InvalidHandle:
    'That name is not a valid handle: 2–15 characters, a–z, 0–9 and underscore, starting with a letter.',
  HandleTaken: 'That handle is already claimed.',
  TierTooLow:
    'Short handles are reserved by perk tier — hold more $GRAM, or pick a longer name.',
  NoHandle: 'This address has no handle to release.',
  EmptyBatch: 'The relayer batch was empty.',
  BatchTooLarge: 'A relayer batch may carry at most 64 drops.',
  NotRelayer: 'That address is not an approved relayer.',
  InvalidKey: 'The key registry rejected that public key.',
  ZeroAddress: 'The contract was given the zero address.',
  ERC20InsufficientBalance:
    'This wallet does not hold enough $GRAM for that payment.',
  ERC20InsufficientAllowance:
    'The contract’s $GRAM allowance is too small — approve first, then pay.',
};

/**
 * A single readable sentence for any failure the app can hit.
 *
 * @param fallback - used when the error carries nothing useful at all.
 */
export function describeChainError(
  error: unknown,
  fallback = 'The transaction could not be completed.',
): string {
  if (error instanceof RelayError) {
    if (error.isOffline) {
      return 'The relay is unreachable, so the ciphertext could not be stored. Your message was not sent.';
    }
    if (error.isNotFound) return 'The relay does not have that object.';
    return trim(error.message);
  }

  if (error instanceof BaseError) {
    const rejected: unknown = error.walk((e) => e instanceof UserRejectedRequestError);
    if (rejected instanceof UserRejectedRequestError) {
      return 'You rejected the request in your wallet.';
    }

    const reverted: unknown = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName;
      if (name !== undefined) {
        return REVERT_COPY[name] ?? `The contract rejected this call (${name}).`;
      }
      return trim(reverted.shortMessage);
    }

    return trim(error.shortMessage);
  }

  if (error instanceof Error) return trim(error.message);
  return fallback;
}
