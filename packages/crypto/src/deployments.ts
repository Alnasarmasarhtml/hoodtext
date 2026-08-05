/**
 * Contract addresses per chain.
 *
 * Entries start zeroed and are filled in by the deploy script, which writes
 * `contracts/deployments/<chainid>.json` and syncs the values here.
 */

/** The nine TeleHood contracts, in deployment order. */
export interface Deployment {
  token: `0x${string}`;
  priceSource: `0x${string}`;
  revenueVault: `0x${string}`;
  activation: `0x${string}`;
  groupRegistry: `0x${string}`;
  keyRegistry: `0x${string}`;
  anchors: `0x${string}`;
  perks: `0x${string}`;
  handles: `0x${string}`;
}

/** The all-zero address, used as the "not deployed yet" placeholder. */
const ZERO_ADDRESS: `0x${string}` = '0x0000000000000000000000000000000000000000';

function undeployed(): Deployment {
  return {
    token: ZERO_ADDRESS,
    priceSource: ZERO_ADDRESS,
    revenueVault: ZERO_ADDRESS,
    activation: ZERO_ADDRESS,
    groupRegistry: ZERO_ADDRESS,
    keyRegistry: ZERO_ADDRESS,
    anchors: ZERO_ADDRESS,
    perks: ZERO_ADDRESS,
    handles: ZERO_ADDRESS,
  };
}

/** Local anvil dev chain. */
const LOCAL_CHAIN_ID = 31337;
/** Robinhood Chain mainnet (0x1237). */
const ROBINHOOD_CHAIN_ID = 4663;

/** Known deployments, keyed by chain id. Local addresses are synced by `make deploy-local`. */
export const DEPLOYMENTS: Record<number, Deployment> = {
  [LOCAL_CHAIN_ID]: {
    token: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    priceSource: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
    revenueVault: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0',
    activation: '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9',
    groupRegistry: '0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9',
    keyRegistry: '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707',
    anchors: '0x0165878A594ca255338adfa4d48449f69242Eb8F',
    perks: '0xa513E6E4b8f2a923D98304ec87F64353C4D5C853',
    handles: '0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6',
  },
  [ROBINHOOD_CHAIN_ID]: undeployed(),
};

/**
 * Looks up the deployment for a chain.
 *
 * @throws {Error} naming the requested chain and the chains that are known, so a
 *   wrong-network bug is obvious from the message alone.
 */
export function getDeployment(chainId: number): Deployment {
  // Own-property check so inherited members such as `toString` can never be mistaken for a
  // deployment when this is called from untyped JavaScript.
  const deployment = Object.prototype.hasOwnProperty.call(DEPLOYMENTS, chainId)
    ? DEPLOYMENTS[chainId]
    : undefined;
  if (deployment === undefined) {
    const known = Object.keys(DEPLOYMENTS).join(', ');
    throw new Error(
      `@telehood/crypto has no deployment for chainId ${String(chainId)}. Known chains: ${known}.`,
    );
  }
  return deployment;
}
