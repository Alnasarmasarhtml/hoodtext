/**
 * Hand-written viem ABIs for the nine HoodGram contracts (SPEC §4).
 *
 * These are `as const` so viem infers argument and return types at the call
 * site — `useReadContract({ abi: activationAbi, functionName: 'quote' })`
 * knows it returns `bigint`.
 *
 * Custom errors are included so failed transactions surface a real reason
 * instead of "execution reverted". Every function, event and error below is
 * diffed against the compiled artifacts in `./abi.generated.ts` (produced by
 * `node infra/scripts/sync-abis.mjs`); that file is the machine-checked source
 * of truth if the contracts change. Prefer importing from this module: it is
 * curated, documented, and carries the perk-tier helpers.
 */

/* ══════════════════════════════════════════════════ shared error shapes ══ */

const ownableErrors = [
  {
    type: 'error',
    name: 'OwnableUnauthorizedAccount',
    inputs: [{ name: 'account', type: 'address', internalType: 'address' }],
  },
  {
    type: 'error',
    name: 'OwnableInvalidOwner',
    inputs: [{ name: 'owner', type: 'address', internalType: 'address' }],
  },
] as const;

const ownableFunctions = [
  {
    type: 'function',
    name: 'owner',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'address' }],
  },
  {
    type: 'function',
    name: 'transferOwnership',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newOwner', type: 'address', internalType: 'address' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'renounceOwnership',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
  {
    type: 'event',
    name: 'OwnershipTransferred',
    inputs: [
      { name: 'previousOwner', type: 'address', indexed: true, internalType: 'address' },
      { name: 'newOwner', type: 'address', indexed: true, internalType: 'address' },
    ],
    anonymous: false,
  },
] as const;

const safeErrors = [
  {
    type: 'error',
    name: 'SafeERC20FailedOperation',
    inputs: [{ name: 'token', type: 'address', internalType: 'address' }],
  },
  {
    type: 'error',
    name: 'SafeCastOverflowedUintDowncast',
    inputs: [
      { name: 'bits', type: 'uint8', internalType: 'uint8' },
      { name: 'value', type: 'uint256', internalType: 'uint256' },
    ],
  },
] as const;

const dropTupleComponents = [
  { name: 'convoId', type: 'bytes32', internalType: 'bytes32' },
  { name: 'ephPub', type: 'bytes32', internalType: 'bytes32' },
  { name: 'blobRef', type: 'bytes32', internalType: 'bytes32' },
  { name: 'viewTag', type: 'uint8', internalType: 'uint8' },
  { name: 'size', type: 'uint32', internalType: 'uint32' },
] as const;

/* ══════════════════════════════════════════════════ 4.1 HoodGramToken ═══ */

/**
 * ERC20 + ERC20Permit + ICheckpointToken.
 *
 * `balanceOfAt` / `totalSupplyAt` are raw *balance* checkpoints (never
 * delegated votes) — they are what lets `RevenueVault` pay holders and `Perks`
 * judge tiers without any staking, deposit or delegation.
 */
export const hoodGramTokenAbi = [
  {
    type: 'constructor',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'treasury', type: 'address', internalType: 'address' }],
  },

  /* — ERC20 — */
  {
    type: 'function',
    name: 'name',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string', internalType: 'string' }],
  },
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string', internalType: 'string' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8', internalType: 'uint8' }],
  },
  {
    type: 'function',
    name: 'totalSupply',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
  },
  {
    type: 'function',
    name: 'MAX_SUPPLY',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address', internalType: 'address' }],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address', internalType: 'address' },
      { name: 'spender', type: 'address', internalType: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address', internalType: 'address' },
      { name: 'value', type: 'uint256', internalType: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool', internalType: 'bool' }],
  },
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address', internalType: 'address' },
      { name: 'value', type: 'uint256', internalType: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool', internalType: 'bool' }],
  },
  {
    type: 'function',
    name: 'transferFrom',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address', internalType: 'address' },
      { name: 'to', type: 'address', internalType: 'address' },
      { name: 'value', type: 'uint256', internalType: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool', internalType: 'bool' }],
  },

  /* — ICheckpointToken — */
  {
    type: 'function',
    name: 'balanceOfAt',
    stateMutability: 'view',
    inputs: [
      { name: 'account', type: 'address', internalType: 'address' },
      { name: 'timepoint', type: 'uint48', internalType: 'uint48' },
    ],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
  },
  {
    type: 'function',
    name: 'totalSupplyAt',
    stateMutability: 'view',
    inputs: [{ name: 'timepoint', type: 'uint48', internalType: 'uint48' }],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
  },
  {
    type: 'function',
    name: 'balanceCheckpointCount',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address', internalType: 'address' }],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
  },
  {
    type: 'function',
    name: 'totalSupplyCheckpointCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
  },

  /* — ERC20Permit (EIP-2612) — */
  {
    type: 'function',
    name: 'permit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'owner', type: 'address', internalType: 'address' },
      { name: 'spender', type: 'address', internalType: 'address' },
      { name: 'value', type: 'uint256', internalType: 'uint256' },
      { name: 'deadline', type: 'uint256', internalType: 'uint256' },
      { name: 'v', type: 'uint8', internalType: 'uint8' },
      { name: 'r', type: 'bytes32', internalType: 'bytes32' },
      { name: 's', type: 'bytes32', internalType: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'nonces',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address', internalType: 'address' }],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
  },
  {
    type: 'function',
    name: 'DOMAIN_SEPARATOR',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32', internalType: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'eip712Domain',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'fields', type: 'bytes1', internalType: 'bytes1' },
      { name: 'name', type: 'string', internalType: 'string' },
      { name: 'version', type: 'string', internalType: 'string' },
      { name: 'chainId', type: 'uint256', internalType: 'uint256' },
      { name: 'verifyingContract', type: 'address', internalType: 'address' },
      { name: 'salt', type: 'bytes32', internalType: 'bytes32' },
      { name: 'extensions', type: 'uint256[]', internalType: 'uint256[]' },
    ],
  },

  /* — events — */
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true, internalType: 'address' },
      { name: 'to', type: 'address', indexed: true, internalType: 'address' },
      { name: 'value', type: 'uint256', indexed: false, internalType: 'uint256' },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'Approval',
    inputs: [
      { name: 'owner', type: 'address', indexed: true, internalType: 'address' },
      { name: 'spender', type: 'address', indexed: true, internalType: 'address' },
      { name: 'value', type: 'uint256', indexed: false, internalType: 'uint256' },
    ],
    anonymous: false,
  },
  { type: 'event', name: 'EIP712DomainChanged', inputs: [], anonymous: false },

  /* — errors — */
  { type: 'error', name: 'FutureLookup', inputs: [] },
  { type: 'error', name: 'ZeroAddress', inputs: [] },
  { type: 'error', name: 'CheckpointUnorderedInsertion', inputs: [] },
  { type: 'error', name: 'ECDSAInvalidSignature', inputs: [] },
  {
    type: 'error',
    name: 'ECDSAInvalidSignatureLength',
    inputs: [{ name: 'length', type: 'uint256', internalType: 'uint256' }],
  },
  {
    type: 'error',
    name: 'ECDSAInvalidSignatureS',
    inputs: [{ name: 's', type: 'bytes32', internalType: 'bytes32' }],
  },
  {
    type: 'error',
    name: 'InvalidAccountNonce',
    inputs: [
      { name: 'account', type: 'address', internalType: 'address' },
      { name: 'currentNonce', type: 'uint256', internalType: 'uint256' },
    ],
  },
  {
    type: 'error',
    name: 'SafeCastOverflowedUintDowncast',
    inputs: [
      { name: 'bits', type: 'uint8', internalType: 'uint8' },
      { name: 'value', type: 'uint256', internalType: 'uint256' },
    ],
  },
  {
    type: 'error',
    name: 'ERC20InsufficientBalance',
    inputs: [
      { name: 'sender', type: 'address', internalType: 'address' },
      { name: 'balance', type: 'uint256', internalType: 'uint256' },
      { name: 'needed', type: 'uint256', internalType: 'uint256' },
    ],
  },
  {
    type: 'error',
    name: 'ERC20InsufficientAllowance',
    inputs: [
      { name: 'spender', type: 'address', internalType: 'address' },
      { name: 'allowance', type: 'uint256', internalType: 'uint256' },
      { name: 'needed', type: 'uint256', internalType: 'uint256' },
    ],
  },
  {
    type: 'error',
    name: 'ERC20InvalidSender',
    inputs: [{ name: 'sender', type: 'address', internalType: 'address' }],
  },
  {
    type: 'error',
    name: 'ERC20InvalidReceiver',
    inputs: [{ name: 'receiver', type: 'address', internalType: 'address' }],
  },
  {
    type: 'error',
    name: 'ERC20InvalidApprover',
    inputs: [{ name: 'approver', type: 'address', internalType: 'address' }],
  },
  {
    type: 'error',
    name: 'ERC20InvalidSpender',
    inputs: [{ name: 'spender', type: 'address', internalType: 'address' }],
  },
  {
    type: 'error',
    name: 'ERC2612ExpiredSignature',
    inputs: [{ name: 'deadline', type: 'uint256', internalType: 'uint256' }],
  },
  {
    type: 'error',
    name: 'ERC2612InvalidSigner',
    inputs: [
      { name: 'signer', type: 'address', internalType: 'address' },
      { name: 'owner', type: 'address', internalType: 'address' },
    ],
  },
] as const;

/* ═════════════════════════════════════════════ 4.2 ManualPriceSource ════ */

/** `thoodPerUsd()` — how many $THOOD (18dp) equal one US dollar. */
export const manualPriceSourceAbi = [
  {
    type: 'constructor',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'initialOwner', type: 'address', internalType: 'address' },
      { name: 'initialRate', type: 'uint256', internalType: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'thoodPerUsd',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
  },
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
    inputs: [
      { name: 'oldRate', type: 'uint256', indexed: false, internalType: 'uint256' },
      { name: 'newRate', type: 'uint256', indexed: false, internalType: 'uint256' },
    ],
    anonymous: false,
  },
  { type: 'error', name: 'InvalidRate', inputs: [] },
  ...ownableFunctions,
  ...ownableErrors,
] as const;

/* ═══════════════════════════════════════════════ 4.3 Activation ═════════ */

/**
 * The $5 handshake. One payment, in $THOOD, and the account exists forever.
 * `activate` is NOT payable in ETH — it pulls $THOOD and sends 100% of it to
 * the vault, where the 50/50 holder split happens at receipt.
 */
export const activationAbi = [
  {
    type: 'constructor',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'initialOwner', type: 'address', internalType: 'address' },
      { name: 'thood_', type: 'address', internalType: 'address' },
      { name: 'priceSource_', type: 'address', internalType: 'address' },
      { name: 'vault_', type: 'address', internalType: 'address' },
    ],
  },

  /* — wiring — */
  {
    type: 'function',
    name: 'THOOD',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'contract IERC20' }],
  },
  {
    type: 'function',
    name: 'vault',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'contract IRevenueVault' }],
  },
  {
    type: 'function',
    name: 'priceSource',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'contract IPriceSource' }],
  },
  {
    type: 'function',
    name: 'priceUsd',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
  },

  /* — reads — */
  {
    type: 'function',
    name: 'isActivated',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address', internalType: 'address' }],
    outputs: [{ name: '', type: 'bool', internalType: 'bool' }],
  },
  {
    type: 'function',
    name: 'activatedAt',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address', internalType: 'address' }],
    outputs: [{ name: 'at', type: 'uint64', internalType: 'uint64' }],
  },
  {
    type: 'function',
    name: 'quote',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'thoodAmount', type: 'uint256', internalType: 'uint256' }],
  },

  /* — writes — */
  { type: 'function', name: 'activate', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  {
    type: 'function',
    name: 'activateFor',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'user', type: 'address', internalType: 'address' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'activateWithPermit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'value', type: 'uint256', internalType: 'uint256' },
      { name: 'deadline', type: 'uint256', internalType: 'uint256' },
      { name: 'v', type: 'uint8', internalType: 'uint8' },
      { name: 'r', type: 'bytes32', internalType: 'bytes32' },
      { name: 's', type: 'bytes32', internalType: 'bytes32' },
    ],
    outputs: [],
  },

  /* — owner — */
  {
    type: 'function',
    name: 'grant',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'user', type: 'address', internalType: 'address' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setPriceUsd',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'usd18', type: 'uint256', internalType: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setPriceSource',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'src', type: 'address', internalType: 'address' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setVault',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'v', type: 'address', internalType: 'address' }],
    outputs: [],
  },

  /* — events — */
  {
    type: 'event',
    name: 'Activated',
    inputs: [
      { name: 'user', type: 'address', indexed: true, internalType: 'address' },
      { name: 'payer', type: 'address', indexed: true, internalType: 'address' },
      { name: 'thoodPaid', type: 'uint256', indexed: false, internalType: 'uint256' },
      { name: 'at', type: 'uint64', indexed: false, internalType: 'uint64' },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'Granted',
    inputs: [
      { name: 'user', type: 'address', indexed: true, internalType: 'address' },
      { name: 'at', type: 'uint64', indexed: false, internalType: 'uint64' },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'PriceSet',
    inputs: [{ name: 'usd18', type: 'uint256', indexed: false, internalType: 'uint256' }],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'PriceSourceSet',
    inputs: [{ name: 'priceSource', type: 'address', indexed: true, internalType: 'address' }],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'VaultSet',
    inputs: [{ name: 'vault', type: 'address', indexed: true, internalType: 'address' }],
    anonymous: false,
  },

  /* — errors — */
  { type: 'error', name: 'AlreadyActivated', inputs: [] },
  { type: 'error', name: 'InvalidPrice', inputs: [] },
  { type: 'error', name: 'PermitFailed', inputs: [] },
  { type: 'error', name: 'ZeroAddress', inputs: [] },
  ...safeErrors,
  ...ownableFunctions,
  ...ownableErrors,
] as const;

/* ═══════════════════════════════════════════ 4.4 GroupRegistry ═════════ */

/**
 * Rooms at $10/month, paid by whoever runs them — members are free. Rent
 * lapsing blocks NEW MESSAGES only; administration, membership and history
 * all survive, and paying again reopens the room exactly as it was.
 */
export const groupRegistryAbi = [
  {
    type: 'constructor',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'initialOwner', type: 'address', internalType: 'address' },
      { name: 'thood_', type: 'address', internalType: 'address' },
      { name: 'activation_', type: 'address', internalType: 'address' },
      { name: 'priceSource_', type: 'address', internalType: 'address' },
      { name: 'vault_', type: 'address', internalType: 'address' },
    ],
  },

  /* — constants — */
  {
    type: 'function',
    name: 'MONTH',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint64', internalType: 'uint64' }],
  },
  {
    type: 'function',
    name: 'MAX_MONTHS',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8', internalType: 'uint8' }],
  },
  {
    type: 'function',
    name: 'RENEW_WINDOW',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint64', internalType: 'uint64' }],
  },

  /* — wiring — */
  {
    type: 'function',
    name: 'THOOD',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'contract IERC20' }],
  },
  {
    type: 'function',
    name: 'activation',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'contract IActivation' }],
  },
  {
    type: 'function',
    name: 'vault',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'contract IRevenueVault' }],
  },
  {
    type: 'function',
    name: 'priceSource',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'contract IPriceSource' }],
  },
  {
    type: 'function',
    name: 'rentUsdPerMonth',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
  },

  /* — state — */
  {
    type: 'function',
    name: 'groups',
    stateMutability: 'view',
    inputs: [{ name: 'groupId', type: 'bytes32', internalType: 'bytes32' }],
    outputs: [
      { name: 'admin', type: 'address', internalType: 'address' },
      { name: 'epoch', type: 'uint32', internalType: 'uint32' },
      { name: 'createdAt', type: 'uint64', internalType: 'uint64' },
      { name: 'memberRoot', type: 'bytes32', internalType: 'bytes32' },
      { name: 'paidUntil', type: 'uint64', internalType: 'uint64' },
      { name: 'autoRenew', type: 'bool', internalType: 'bool' },
      { name: 'exists', type: 'bool', internalType: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'isActive',
    stateMutability: 'view',
    inputs: [{ name: 'groupId', type: 'bytes32', internalType: 'bytes32' }],
    outputs: [{ name: '', type: 'bool', internalType: 'bool' }],
  },

  /* — quoting — */
  {
    type: 'function',
    name: 'quoteRent',
    stateMutability: 'view',
    inputs: [{ name: 'months', type: 'uint8', internalType: 'uint8' }],
    outputs: [{ name: 'thoodAmount', type: 'uint256', internalType: 'uint256' }],
  },
  {
    type: 'function',
    name: 'previewPaidUntil',
    stateMutability: 'view',
    inputs: [
      { name: 'groupId', type: 'bytes32', internalType: 'bytes32' },
      { name: 'months', type: 'uint8', internalType: 'uint8' },
    ],
    outputs: [{ name: '', type: 'uint64', internalType: 'uint64' }],
  },

  /* — writes — */
  {
    type: 'function',
    name: 'createGroup',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'groupId', type: 'bytes32', internalType: 'bytes32' },
      { name: 'memberRoot', type: 'bytes32', internalType: 'bytes32' },
      { name: 'months', type: 'uint8', internalType: 'uint8' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'payRent',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'groupId', type: 'bytes32', internalType: 'bytes32' },
      { name: 'months', type: 'uint8', internalType: 'uint8' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'renewFor',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'groupId', type: 'bytes32', internalType: 'bytes32' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setAutoRenew',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'groupId', type: 'bytes32', internalType: 'bytes32' },
      { name: 'on', type: 'bool', internalType: 'bool' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'rotateEpoch',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'groupId', type: 'bytes32', internalType: 'bytes32' },
      { name: 'newMemberRoot', type: 'bytes32', internalType: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'transferAdmin',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'groupId', type: 'bytes32', internalType: 'bytes32' },
      { name: 'newAdmin', type: 'address', internalType: 'address' },
    ],
    outputs: [],
  },

  /* — owner — */
  {
    type: 'function',
    name: 'grantRent',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'groupId', type: 'bytes32', internalType: 'bytes32' },
      { name: 'months', type: 'uint8', internalType: 'uint8' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setRentUsdPerMonth',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'usd18', type: 'uint256', internalType: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setActivation',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'a', type: 'address', internalType: 'address' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setPriceSource',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'src', type: 'address', internalType: 'address' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setVault',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'v', type: 'address', internalType: 'address' }],
    outputs: [],
  },

  /* — events — */
  {
    type: 'event',
    name: 'GroupCreated',
    inputs: [
      { name: 'groupId', type: 'bytes32', indexed: true, internalType: 'bytes32' },
      { name: 'admin', type: 'address', indexed: true, internalType: 'address' },
      { name: 'memberRoot', type: 'bytes32', indexed: false, internalType: 'bytes32' },
      { name: 'months', type: 'uint8', indexed: false, internalType: 'uint8' },
      { name: 'thoodPaid', type: 'uint256', indexed: false, internalType: 'uint256' },
      { name: 'paidUntil', type: 'uint64', indexed: false, internalType: 'uint64' },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'RentPaid',
    inputs: [
      { name: 'groupId', type: 'bytes32', indexed: true, internalType: 'bytes32' },
      { name: 'payer', type: 'address', indexed: true, internalType: 'address' },
      { name: 'months', type: 'uint8', indexed: false, internalType: 'uint8' },
      { name: 'thoodPaid', type: 'uint256', indexed: false, internalType: 'uint256' },
      { name: 'paidUntil', type: 'uint64', indexed: false, internalType: 'uint64' },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'RentGranted',
    inputs: [
      { name: 'groupId', type: 'bytes32', indexed: true, internalType: 'bytes32' },
      { name: 'months', type: 'uint8', indexed: false, internalType: 'uint8' },
      { name: 'paidUntil', type: 'uint64', indexed: false, internalType: 'uint64' },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'AutoRenewSet',
    inputs: [
      { name: 'groupId', type: 'bytes32', indexed: true, internalType: 'bytes32' },
      { name: 'on', type: 'bool', indexed: false, internalType: 'bool' },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'EpochRotated',
    inputs: [
      { name: 'groupId', type: 'bytes32', indexed: true, internalType: 'bytes32' },
      { name: 'epoch', type: 'uint32', indexed: false, internalType: 'uint32' },
      { name: 'memberRoot', type: 'bytes32', indexed: false, internalType: 'bytes32' },
      { name: 'at', type: 'uint64', indexed: false, internalType: 'uint64' },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'AdminTransferred',
    inputs: [
      { name: 'groupId', type: 'bytes32', indexed: true, internalType: 'bytes32' },
      { name: 'from', type: 'address', indexed: true, internalType: 'address' },
      { name: 'to', type: 'address', indexed: true, internalType: 'address' },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'RentPriceSet',
    inputs: [{ name: 'usd18', type: 'uint256', indexed: false, internalType: 'uint256' }],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'ActivationSet',
    inputs: [{ name: 'activation', type: 'address', indexed: true, internalType: 'address' }],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'PriceSourceSet',
    inputs: [{ name: 'priceSource', type: 'address', indexed: true, internalType: 'address' }],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'VaultSet',
    inputs: [{ name: 'vault', type: 'address', indexed: true, internalType: 'address' }],
    anonymous: false,
  },

  /* — errors — */
  { type: 'error', name: 'NotActivated', inputs: [] },
  { type: 'error', name: 'NotAdmin', inputs: [] },
  { type: 'error', name: 'InvalidGroup', inputs: [] },
  { type: 'error', name: 'GroupExists', inputs: [] },
  { type: 'error', name: 'UnknownGroup', inputs: [] },
  { type: 'error', name: 'InvalidMonths', inputs: [] },
  { type: 'error', name: 'InvalidPrice', inputs: [] },
  { type: 'error', name: 'NotDue', inputs: [] },
  { type: 'error', name: 'AutoRenewOff', inputs: [] },
  { type: 'error', name: 'ZeroAddress', inputs: [] },
  ...safeErrors,
  ...ownableFunctions,
  ...ownableErrors,
] as const;

/* ═══════════════════════════════════════════════ 4.5 RevenueVault ══════ */

/**
 * The 50/50 split, paid to holders by holdings.
 *
 * `claimable(user, epochId)` = `holderAmount * balanceOfAt(user, snapshot) /
 * eligibleSupply`. Holding $THOOD at the snapshot block is the entire
 * requirement — no deposit, no lock-up, no delegation.
 */
export const revenueVaultAbi = [
  {
    type: 'constructor',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'initialOwner', type: 'address', internalType: 'address' },
      { name: 'thood_', type: 'address', internalType: 'address' },
      { name: 'treasury_', type: 'address', internalType: 'address' },
    ],
  },

  /* — constants — */
  {
    type: 'function',
    name: 'HOLDER_BPS',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
  },
  {
    type: 'function',
    name: 'EPOCH_MIN_INTERVAL',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
  },
  {
    type: 'function',
    name: 'CLAIM_WINDOW',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
  },
  {
    type: 'function',
    name: 'MAX_EXCLUDED',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
  },

  /* — wiring — */
  {
    type: 'function',
    name: 'THOOD',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'contract IERC20' }],
  },
  {
    type: 'function',
    name: 'CHECKPOINTS',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'contract ICheckpointToken' }],
  },
  {
    type: 'function',
    name: 'treasury',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'address' }],
  },
  {
    type: 'function',
    name: 'isNotifier',
    stateMutability: 'view',
    inputs: [{ name: 'notifier', type: 'address', internalType: 'address' }],
    outputs: [{ name: 'allowed', type: 'bool', internalType: 'bool' }],
  },

  /* — state — */
  {
    type: 'function',
    name: 'epochs',
    stateMutability: 'view',
    inputs: [{ name: 'epochId', type: 'uint256', internalType: 'uint256' }],
    outputs: [
      { name: 'snapshot', type: 'uint48', internalType: 'uint48' },
      { name: 'sealedAt', type: 'uint64', internalType: 'uint64' },
      { name: 'holderAmount', type: 'uint256', internalType: 'uint256' },
      { name: 'eligibleSupply', type: 'uint256', internalType: 'uint256' },
      { name: 'claimed', type: 'uint256', internalType: 'uint256' },
      { name: 'swept', type: 'bool', internalType: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'epochCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
  },
  {
    type: 'function',
    name: 'hasClaimed',
    stateMutability: 'view',
    inputs: [
      { name: 'epochId', type: 'uint256', internalType: 'uint256' },
      { name: 'user', type: 'address', internalType: 'address' },
    ],
    outputs: [{ name: '', type: 'bool', internalType: 'bool' }],
  },
  {
    type: 'function',
    name: 'pendingHolders',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
  },
  {
    type: 'function',
    name: 'treasuryAccrued',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
  },
  {
    type: 'function',
    name: 'excludedCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
  },
  {
    type: 'function',
    name: 'excludedList',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address[]', internalType: 'address[]' }],
  },
  {
    type: 'function',
    name: 'isExcluded',
    stateMutability: 'view',
    inputs: [{ name: 'addr', type: 'address', internalType: 'address' }],
    outputs: [{ name: 'excludedFlag', type: 'bool', internalType: 'bool' }],
  },

  /* — IRevenueVault — */
  {
    type: 'function',
    name: 'notifyRevenue',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256', internalType: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'claimable',
    stateMutability: 'view',
    inputs: [
      { name: 'user', type: 'address', internalType: 'address' },
      { name: 'epochId', type: 'uint256', internalType: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
  },
  {
    type: 'function',
    name: 'claim',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'epochId', type: 'uint256', internalType: 'uint256' }],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
  },
  {
    type: 'function',
    name: 'claimMany',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'epochIds', type: 'uint256[]', internalType: 'uint256[]' }],
    outputs: [{ name: 'total', type: 'uint256', internalType: 'uint256' }],
  },
  {
    type: 'function',
    name: 'totalClaimable',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address', internalType: 'address' }],
    outputs: [{ name: 'total', type: 'uint256', internalType: 'uint256' }],
  },
  /** The snapshot block of the newest sealed epoch — the perk-tier anchor. */
  {
    type: 'function',
    name: 'latestSnapshot',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint48', internalType: 'uint48' }],
  },

  /* — epoch lifecycle — */
  {
    type: 'function',
    name: 'nextSealAt',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint64', internalType: 'uint64' }],
  },
  {
    type: 'function',
    name: 'lastSealAt',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint64', internalType: 'uint64' }],
  },
  {
    type: 'function',
    name: 'sealedUnclaimed',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
  },
  {
    type: 'function',
    name: 'totalObligations',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
  },
  {
    type: 'function',
    name: 'isSolvent',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bool', internalType: 'bool' }],
  },
  {
    type: 'function',
    name: 'sealEpoch',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [{ name: 'epochId', type: 'uint256', internalType: 'uint256' }],
  },
  {
    type: 'function',
    name: 'sweepExpired',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'epochId', type: 'uint256', internalType: 'uint256' }],
    outputs: [],
  },

  /* — owner — */
  {
    type: 'function',
    name: 'withdrawTreasury',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address', internalType: 'address' },
      { name: 'amount', type: 'uint256', internalType: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setExcluded',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'addr', type: 'address', internalType: 'address' },
      { name: 'excluded_', type: 'bool', internalType: 'bool' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setTreasury',
    stateMutability: 'nonpayable',
    inputs: [{ name: 't', type: 'address', internalType: 'address' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setNotifier',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'notifier', type: 'address', internalType: 'address' },
      { name: 'allowed', type: 'bool', internalType: 'bool' },
    ],
    outputs: [],
  },

  /* — events — */
  {
    type: 'event',
    name: 'RevenueReceived',
    inputs: [
      { name: 'from', type: 'address', indexed: true, internalType: 'address' },
      { name: 'amount', type: 'uint256', indexed: false, internalType: 'uint256' },
      { name: 'toHolders', type: 'uint256', indexed: false, internalType: 'uint256' },
      { name: 'toTreasury', type: 'uint256', indexed: false, internalType: 'uint256' },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'EpochSealed',
    inputs: [
      { name: 'epochId', type: 'uint256', indexed: true, internalType: 'uint256' },
      { name: 'snapshot', type: 'uint48', indexed: false, internalType: 'uint48' },
      { name: 'holderAmount', type: 'uint256', indexed: false, internalType: 'uint256' },
      { name: 'eligibleSupply', type: 'uint256', indexed: false, internalType: 'uint256' },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'Claimed',
    inputs: [
      { name: 'user', type: 'address', indexed: true, internalType: 'address' },
      { name: 'epochId', type: 'uint256', indexed: true, internalType: 'uint256' },
      { name: 'amount', type: 'uint256', indexed: false, internalType: 'uint256' },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'ExpiredSwept',
    inputs: [
      { name: 'epochId', type: 'uint256', indexed: true, internalType: 'uint256' },
      { name: 'amount', type: 'uint256', indexed: false, internalType: 'uint256' },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'TreasuryWithdrawn',
    inputs: [
      { name: 'to', type: 'address', indexed: true, internalType: 'address' },
      { name: 'amount', type: 'uint256', indexed: false, internalType: 'uint256' },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'ExcludedSet',
    inputs: [
      { name: 'addr', type: 'address', indexed: true, internalType: 'address' },
      { name: 'isExcluded', type: 'bool', indexed: false, internalType: 'bool' },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'PendingRoutedToTreasury',
    inputs: [
      { name: 'snapshot', type: 'uint48', indexed: false, internalType: 'uint48' },
      { name: 'amount', type: 'uint256', indexed: false, internalType: 'uint256' },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'TreasurySet',
    inputs: [{ name: 'treasury', type: 'address', indexed: true, internalType: 'address' }],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'NotifierSet',
    inputs: [
      { name: 'notifier', type: 'address', indexed: true, internalType: 'address' },
      { name: 'allowed', type: 'bool', indexed: false, internalType: 'bool' },
    ],
    anonymous: false,
  },

  /* — errors — */
  { type: 'error', name: 'NotNotifier', inputs: [] },
  { type: 'error', name: 'NothingToSeal', inputs: [] },
  { type: 'error', name: 'NotFunded', inputs: [] },
  { type: 'error', name: 'TooSoon', inputs: [] },
  { type: 'error', name: 'AlreadyClaimed', inputs: [] },
  { type: 'error', name: 'UnknownEpoch', inputs: [] },
  { type: 'error', name: 'AlreadySwept', inputs: [] },
  { type: 'error', name: 'ClaimWindowOpen', inputs: [] },
  { type: 'error', name: 'TooManyExcluded', inputs: [] },
  { type: 'error', name: 'InsufficientTreasury', inputs: [] },
  { type: 'error', name: 'ZeroAddress', inputs: [] },
  { type: 'error', name: 'ReentrancyGuardReentrantCall', inputs: [] },
  ...safeErrors,
  ...ownableFunctions,
  ...ownableErrors,
] as const;

/* ═══════════════════════════════════════════════ 4.6 KeyRegistry ═══════ */

/** Free identity registration — you can receive before you have ever paid. */
export const keyRegistryAbi = [
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
    name: 'register',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'x25519Pub', type: 'bytes32', internalType: 'bytes32' },
      { name: 'ed25519Pub', type: 'bytes32', internalType: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'isRegistered',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address', internalType: 'address' }],
    outputs: [{ name: '', type: 'bool', internalType: 'bool' }],
  },
  {
    type: 'event',
    name: 'KeysRegistered',
    inputs: [
      { name: 'user', type: 'address', indexed: true, internalType: 'address' },
      { name: 'x25519Pub', type: 'bytes32', indexed: false, internalType: 'bytes32' },
      { name: 'ed25519Pub', type: 'bytes32', indexed: false, internalType: 'bytes32' },
      { name: 'at', type: 'uint64', indexed: false, internalType: 'uint64' },
    ],
    anonymous: false,
  },
  { type: 'error', name: 'InvalidKey', inputs: [] },
] as const;

/* ══════════════════════════════════════════════════ 4.7 Anchors ════════ */

/**
 * The message log. **Not payable — there is no per-message fee.** Self-posting
 * requires an activated account; room drops additionally require the room's
 * rent to be current; batches are approved-relayer only.
 */
export const anchorsAbi = [
  {
    type: 'constructor',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'initialOwner', type: 'address', internalType: 'address' },
      { name: 'activation_', type: 'address', internalType: 'address' },
      { name: 'rooms_', type: 'address', internalType: 'address' },
    ],
  },
  {
    type: 'function',
    name: 'activation',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'contract IActivation' }],
  },
  {
    type: 'function',
    name: 'rooms',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'contract IRooms' }],
  },
  {
    type: 'function',
    name: 'isRelayer',
    stateMutability: 'view',
    inputs: [{ name: 'relayer', type: 'address', internalType: 'address' }],
    outputs: [{ name: 'approved', type: 'bool', internalType: 'bool' }],
  },
  {
    type: 'function',
    name: 'seq',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint64', internalType: 'uint64' }],
  },
  {
    type: 'function',
    name: 'MAX_BATCH',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
  },
  {
    type: 'function',
    name: 'post',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'd',
        type: 'tuple',
        internalType: 'struct Anchors.Drop',
        components: dropTupleComponents,
      },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'postBatch',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'd',
        type: 'tuple[]',
        internalType: 'struct Anchors.Drop[]',
        components: dropTupleComponents,
      },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setRelayer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'relayer', type: 'address', internalType: 'address' },
      { name: 'approved', type: 'bool', internalType: 'bool' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setActivation',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'a', type: 'address', internalType: 'address' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setRooms',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'r', type: 'address', internalType: 'address' }],
    outputs: [],
  },
  {
    type: 'event',
    name: 'Dropped',
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
    anonymous: false,
  },
  {
    type: 'event',
    name: 'ActivationSet',
    inputs: [{ name: 'activation', type: 'address', indexed: true, internalType: 'address' }],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'RoomsSet',
    inputs: [{ name: 'rooms', type: 'address', indexed: true, internalType: 'address' }],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'RelayerSet',
    inputs: [
      { name: 'relayer', type: 'address', indexed: true, internalType: 'address' },
      { name: 'approved', type: 'bool', indexed: false, internalType: 'bool' },
    ],
    anonymous: false,
  },
  { type: 'error', name: 'NotActivated', inputs: [] },
  { type: 'error', name: 'RoomInactive', inputs: [] },
  { type: 'error', name: 'NotRelayer', inputs: [] },
  { type: 'error', name: 'EmptyBatch', inputs: [] },
  { type: 'error', name: 'BatchTooLarge', inputs: [] },
  { type: 'error', name: 'ZeroAddress', inputs: [] },
  ...ownableFunctions,
  ...ownableErrors,
] as const;

/* ═══════════════════════════════════════════════════ 4.8 Perks ═════════ */

/**
 * The holder status ladder — pure status and capacity, never a claim on
 * anyone's revenue. `tierOf` judges the LOWER of the live balance and the
 * balance at the last sealed revenue snapshot, so a tier cannot be rented.
 */
export const perksAbi = [
  {
    type: 'constructor',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'initialOwner', type: 'address', internalType: 'address' },
      { name: 'thood_', type: 'address', internalType: 'address' },
      { name: 'vault_', type: 'address', internalType: 'address' },
    ],
  },
  {
    type: 'function',
    name: 'TIER_COUNT',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8', internalType: 'uint8' }],
  },
  {
    type: 'function',
    name: 'THOOD',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'contract IERC20' }],
  },
  {
    type: 'function',
    name: 'vault',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'contract IRevenueVault' }],
  },
  {
    type: 'function',
    name: 'thresholdsBps',
    stateMutability: 'view',
    inputs: [{ name: 'index', type: 'uint256', internalType: 'uint256' }],
    outputs: [{ name: '', type: 'uint16', internalType: 'uint16' }],
  },
  {
    type: 'function',
    name: 'tierOf',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address', internalType: 'address' }],
    outputs: [{ name: '', type: 'uint8', internalType: 'uint8' }],
  },
  {
    type: 'function',
    name: 'eligibleBalance',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address', internalType: 'address' }],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
  },
  {
    type: 'function',
    name: 'thresholdAmount',
    stateMutability: 'view',
    inputs: [{ name: 'tier', type: 'uint8', internalType: 'uint8' }],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
  },
  {
    type: 'function',
    name: 'setThresholdsBps',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'bps', type: 'uint16[4]', internalType: 'uint16[4]' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setVault',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'v', type: 'address', internalType: 'address' }],
    outputs: [],
  },
  {
    type: 'event',
    name: 'ThresholdsSet',
    inputs: [{ name: 'bps', type: 'uint16[4]', indexed: false, internalType: 'uint16[4]' }],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'VaultSet',
    inputs: [{ name: 'vault', type: 'address', indexed: true, internalType: 'address' }],
    anonymous: false,
  },
  { type: 'error', name: 'InvalidThresholds', inputs: [] },
  { type: 'error', name: 'InvalidTier', inputs: [] },
  { type: 'error', name: 'ZeroAddress', inputs: [] },
  ...ownableFunctions,
  ...ownableErrors,
] as const;

/* ═════════════════════════════════════════════════ 4.9 Handles ═════════ */

/**
 * @names. Free with the $5 activation, one per address; short names are the
 * scarce flex, reserved by perk tier (4 chars: BLOCK CAPTAIN, 3: DISTRICT,
 * 2: KINGPIN).
 */
export const handlesAbi = [
  {
    type: 'constructor',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'activation_', type: 'address', internalType: 'address' },
      { name: 'perks_', type: 'address', internalType: 'address' },
    ],
  },
  {
    type: 'function',
    name: 'MIN_LENGTH',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
  },
  {
    type: 'function',
    name: 'MAX_LENGTH',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
  },
  {
    type: 'function',
    name: 'ACTIVATION',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'contract IActivation' }],
  },
  {
    type: 'function',
    name: 'PERKS',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'contract IPerks' }],
  },
  {
    type: 'function',
    name: 'handleOf',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address', internalType: 'address' }],
    outputs: [{ name: '', type: 'string', internalType: 'string' }],
  },
  {
    type: 'function',
    name: 'addressOf',
    stateMutability: 'view',
    inputs: [{ name: 'name', type: 'string', internalType: 'string' }],
    outputs: [{ name: '', type: 'address', internalType: 'address' }],
  },
  {
    type: 'function',
    name: 'ownerOfHash',
    stateMutability: 'view',
    inputs: [{ name: 'nameHash', type: 'bytes32', internalType: 'bytes32' }],
    outputs: [{ name: 'owner', type: 'address', internalType: 'address' }],
  },
  {
    type: 'function',
    name: 'requiredTier',
    stateMutability: 'pure',
    inputs: [{ name: 'length', type: 'uint256', internalType: 'uint256' }],
    outputs: [{ name: '', type: 'uint8', internalType: 'uint8' }],
  },
  {
    type: 'function',
    name: 'isValidName',
    stateMutability: 'pure',
    inputs: [{ name: 'name', type: 'string', internalType: 'string' }],
    outputs: [{ name: '', type: 'bool', internalType: 'bool' }],
  },
  {
    type: 'function',
    name: 'claim',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'name', type: 'string', internalType: 'string' }],
    outputs: [],
  },
  { type: 'function', name: 'release', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  {
    type: 'event',
    name: 'HandleClaimed',
    inputs: [
      { name: 'user', type: 'address', indexed: true, internalType: 'address' },
      { name: 'handle', type: 'string', indexed: false, internalType: 'string' },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'HandleReleased',
    inputs: [
      { name: 'user', type: 'address', indexed: true, internalType: 'address' },
      { name: 'handle', type: 'string', indexed: false, internalType: 'string' },
    ],
    anonymous: false,
  },
  { type: 'error', name: 'NotActivated', inputs: [] },
  { type: 'error', name: 'InvalidHandle', inputs: [] },
  { type: 'error', name: 'HandleTaken', inputs: [] },
  { type: 'error', name: 'TierTooLow', inputs: [] },
  { type: 'error', name: 'NoHandle', inputs: [] },
  { type: 'error', name: 'ZeroAddress', inputs: [] },
] as const;

/* ═════════════════════════════════════════════════ perk tiers ══════════ */

/** `Perks.tierOf` values: 0 none, then the four rungs of the ladder. */
export const PerkTier = {
  NONE: 0,
  RESIDENT: 1,
  BLOCK_CAPTAIN: 2,
  DISTRICT: 3,
  KINGPIN: 4,
} as const;

export type PerkTierId = (typeof PerkTier)[keyof typeof PerkTier];
export type HeldPerkTierId = Exclude<PerkTierId, typeof PerkTier.NONE>;

export interface PerkTierSpec {
  readonly id: HeldPerkTierId;
  /** Display name, uppercase — it is a rank, not a sentence. */
  readonly label: string;
  /** Holding requirement as a percentage of total supply. */
  readonly supplyPct: string;
  /** Deploy-default threshold in basis points; the contract read wins. */
  readonly bps: number;
  /** Threshold in $THOOD at the fixed 1B supply, for copy. */
  readonly thood: number;
  /** What this rung unlocks, most important first. */
  readonly unlocks: readonly string[];
}

/**
 * The ladder, as configured on deploy. `Perks.thresholdsBps` is the runtime
 * source of truth; these drive copy and first paint.
 */
export const PERK_TIERS: Readonly<Record<HeldPerkTierId, PerkTierSpec>> = {
  [PerkTier.RESIDENT]: {
    id: PerkTier.RESIDENT,
    label: 'RESIDENT',
    supplyPct: '0.05%',
    bps: 5,
    thood: 500_000,
    unlocks: ['Holder badge beside your name in every chat'],
  },
  [PerkTier.BLOCK_CAPTAIN]: {
    id: PerkTier.BLOCK_CAPTAIN,
    label: 'BLOCK CAPTAIN',
    supplyPct: '0.1%',
    bps: 10,
    thood: 1_000_000,
    unlocks: ['4-character handles', 'Bigger uploads', 'Bigger rooms'],
  },
  [PerkTier.DISTRICT]: {
    id: PerkTier.DISTRICT,
    label: 'DISTRICT',
    supplyPct: '0.25%',
    bps: 25,
    thood: 2_500_000,
    unlocks: ['3-character handles', 'Early features'],
  },
  [PerkTier.KINGPIN]: {
    id: PerkTier.KINGPIN,
    label: 'KINGPIN',
    supplyPct: '0.5%',
    bps: 50,
    thood: 5_000_000,
    unlocks: ['2-character handles', 'Broadcast rooms'],
  },
};

/** The four rungs, lowest first. */
export const PERK_LADDER: readonly PerkTierSpec[] = [
  PERK_TIERS[PerkTier.RESIDENT],
  PERK_TIERS[PerkTier.BLOCK_CAPTAIN],
  PERK_TIERS[PerkTier.DISTRICT],
  PERK_TIERS[PerkTier.KINGPIN],
];

export function isPerkTierId(value: number): value is PerkTierId {
  return value === 0 || value === 1 || value === 2 || value === 3 || value === 4;
}

export function isHeldPerkTierId(value: number): value is HeldPerkTierId {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

/** Human label for any perk tier value, including 0 and unknown ones. */
export function perkTierLabel(tier: number): string {
  if (isHeldPerkTierId(tier)) return PERK_TIERS[tier].label;
  return tier === PerkTier.NONE ? 'None' : 'Unknown';
}

/** Spec for a held tier, or `null` for NONE/unknown. */
export function perkTierSpec(tier: number): PerkTierSpec | null {
  return isHeldPerkTierId(tier) ? PERK_TIERS[tier] : null;
}

/* ─────────────────────────────────────────── pricing constants ────────── */

/**
 * Deploy-default prices. The contracts are the source of truth at runtime
 * (`Activation.priceUsd`, `GroupRegistry.rentUsdPerMonth`); these drive copy
 * and first paint before the reads resolve.
 */
export const PRICES = {
  /** One-time account activation, USD. */
  activationUsd: 5,
  /** Monthly room rent, USD, paid by the room's admin. */
  roomUsdPerMonth: 10,
} as const;

/* ─────────────────────────────────────────── contract constants ───────── */

/** Mirrors of the on-chain constants in SPEC §4. Chain reads still win. */
export const CONTRACT_CONSTANTS = {
  /** `GroupRegistry.MONTH` — 30 days in seconds. */
  monthSeconds: 30 * 86_400,
  /** `GroupRegistry.MAX_MONTHS`. */
  maxMonths: 24,
  /** `GroupRegistry.RENEW_WINDOW` — 3 days in seconds. */
  renewWindowSeconds: 3 * 86_400,
  /** `RevenueVault.HOLDER_BPS` — 50% to holders. */
  holderBps: 5_000,
  /** `RevenueVault.EPOCH_MIN_INTERVAL` — 7 days in seconds. */
  epochMinIntervalSeconds: 7 * 86_400,
  /** `RevenueVault.CLAIM_WINDOW` — 180 days in seconds. */
  claimWindowSeconds: 180 * 86_400,
  /** `Anchors.postBatch` cap. */
  maxBatch: 64,
  /** `Handles.MIN_LENGTH` / `MAX_LENGTH`. */
  handleMinLength: 2,
  handleMaxLength: 15,
} as const;
