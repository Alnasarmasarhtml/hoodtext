/**
 * Minimal viem ABI for the one thing the relay watches: `Anchors.Dropped`
 * (SPEC §4.6).
 *
 * Deliberately not the full `Anchors` ABI — the relay never writes to the chain,
 * so anything beyond this event would be dead weight that could drift out of sync
 * with the contracts package.
 */

import type { Abi, AbiEvent } from 'viem';

/**
 * ```solidity
 * event Dropped(
 *     bytes32 indexed convoId, uint64 indexed seq, address indexed poster,
 *     bytes32 ephPub, bytes32 blobRef, uint8 viewTag, uint32 size, uint64 timestamp
 * );
 * ```
 */
export const DROPPED_EVENT = {
  type: 'event',
  name: 'Dropped',
  anonymous: false,
  inputs: [
    { name: 'convoId', type: 'bytes32', indexed: true, internalType: 'bytes32' },
    { name: 'seq', type: 'uint64', indexed: true, internalType: 'uint64' },
    { name: 'poster', type: 'address', indexed: true, internalType: 'address' },
    { name: 'ephPub', type: 'bytes32', indexed: false, internalType: 'bytes32' },
    { name: 'blobRef', type: 'bytes32', indexed: false, internalType: 'bytes32' },
    { name: 'viewTag', type: 'uint8', indexed: false, internalType: 'uint8' },
    { name: 'size', type: 'uint32', indexed: false, internalType: 'uint32' },
    { name: 'timestamp', type: 'uint64', indexed: false, internalType: 'uint64' },
  ],
} as const satisfies AbiEvent;

/** The ABI passed to `watchContractEvent`. */
export const ANCHORS_ABI = [DROPPED_EVENT] as const satisfies Abi;

/** Event name used by `watchContractEvent({ eventName })`. */
export const DROPPED_EVENT_NAME = 'Dropped' as const;

/**
 * Read functions the send pipeline verifies against before batching:
 * `KeyRegistry.keysOf`, `Activation.isActivated`, `GroupRegistry.isActive`.
 */
export const RELAY_READS_ABI = [
  {
    type: 'function',
    name: 'keysOf',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address', internalType: 'address' }],
    outputs: [
      { name: 'x25519', type: 'bytes32', internalType: 'bytes32' },
      { name: 'ed25519', type: 'bytes32', internalType: 'bytes32' },
      { name: 'updatedAt', type: 'uint64', internalType: 'uint64' },
    ],
  },
  {
    type: 'function',
    name: 'isActivated',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address', internalType: 'address' }],
    outputs: [{ name: '', type: 'bool', internalType: 'bool' }],
  },
  {
    type: 'function',
    name: 'isActive',
    stateMutability: 'view',
    inputs: [{ name: 'groupId', type: 'bytes32', internalType: 'bytes32' }],
    outputs: [{ name: '', type: 'bool', internalType: 'bool' }],
  },
] as const satisfies Abi;

/** `Anchors.postBatch` — the one write the relay ever makes. */
export const POST_BATCH_ABI = [
  {
    type: 'function',
    name: 'postBatch',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'd',
        type: 'tuple[]',
        internalType: 'struct Anchors.Drop[]',
        components: [
          { name: 'convoId', type: 'bytes32', internalType: 'bytes32' },
          { name: 'ephPub', type: 'bytes32', internalType: 'bytes32' },
          { name: 'blobRef', type: 'bytes32', internalType: 'bytes32' },
          { name: 'viewTag', type: 'uint8', internalType: 'uint8' },
          { name: 'size', type: 'uint32', internalType: 'uint32' },
        ],
      },
    ],
    outputs: [],
  },
] as const satisfies Abi;

/**
 * `ManualPriceSource` — everything the price keeper touches: the current rate,
 * the owner-only setter, and the event it emits.
 */
export const PRICE_SOURCE_ABI = [
  {
    type: 'function',
    name: 'rate',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
  },
  {
    type: 'function',
    name: 'setRate',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newRate', type: 'uint256', internalType: 'uint256' }],
    outputs: [],
  },
  {
    type: 'event',
    name: 'RateSet',
    anonymous: false,
    inputs: [
      { name: 'oldRate', type: 'uint256', indexed: false, internalType: 'uint256' },
      { name: 'newRate', type: 'uint256', indexed: false, internalType: 'uint256' },
    ],
  },
] as const satisfies Abi;

/**
 * The slice of a pons.fun-style bonding curve the price keeper reads:
 * virtual reserves (spot price = quote/token) and the graduation flag that
 * marks the moment liquidity leaves for a DEX and this source goes stale.
 * Established against the deployed curve on Robinhood Chain; the contract is
 * unverified bytecode, so any revert here is treated as feed failure.
 */
export const PONS_CURVE_ABI = [
  {
    type: 'function',
    name: 'getReserves',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'quoteReserve_', type: 'uint256', internalType: 'uint256' },
      { name: 'tokenReserve_', type: 'uint256', internalType: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'graduated',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bool', internalType: 'bool' }],
  },
] as const satisfies Abi;
