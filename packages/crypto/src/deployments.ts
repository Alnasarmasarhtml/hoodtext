/**
 * Contract addresses per chain.
 *
 * Entries start zeroed and are filled in by the deploy script, which writes
 * `contracts/deployments/<chainid>.json` and syncs the values here.
 */

/** The nine HoodGram contracts, in deployment order. */
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
/** Robinhood Chain testnet (0xb626) — where a release is rehearsed. */
const ROBINHOOD_TESTNET_CHAIN_ID = 46630;

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
  // Robinhood Chain testnet — deployed 2026-08-08 from block 98182458.
  // Deployer / treasury / owner: 0xa50E073fE5b58a4322A9EE1F33e672049Ef32084.
  [ROBINHOOD_TESTNET_CHAIN_ID]: {
    token: '0x597AC1E5826F0FE6A1845a934Dc3f5bB25c4573F',
    priceSource: '0xC9e4Bb2A49faE742d9082E26a2AF6a1d24249B5f',
    revenueVault: '0x080B60Cd7c46C3D3B2D49C1E4dF5455402cdDB7c',
    activation: '0xd1a671E60CC00e9c6E037CbB979cBFEFdd93E990',
    groupRegistry: '0x20F2C6f1376a6c6462c43902518a9821a26f1Ee1',
    keyRegistry: '0x8a7d1a0748Fb89b49375Ec8bd734ec2B5AaF600F',
    anchors: '0x030d3dCa4283c7feA2E053C05Dcca7BAF482d51D',
    perks: '0x53d88E8Dc39d5381823a50a59Ac9056C75Fe6074',
    handles: '0xA5d2c689f89A525869Ad3b4F9f12207cB2Edc867',
  },
  // Robinhood Chain mainnet — deployed 2026-08-18 from block 39819111, wired to the external
  // test token ($5 = 5,000 tokens at thoodPerUsd 1000e18). The real $GRAM arrives on launch day
  // via `setToken` on Activation / GroupRegistry / Perks / RevenueVault — the token address here
  // changes then; the other eight do not.
  // Deployer / treasury / owner: 0x58b2ed2ed3AEEB756B30aD15EaD8974CeDc9A5aC.
  [ROBINHOOD_CHAIN_ID]: {
    token: '0x24DAC33de87dBFf11a7B1CBF02dB4b0668C5e3D6',
    priceSource: '0xAA164D5E19F2EeEca56aF3CBBe677533e962f109',
    revenueVault: '0x168946858dB2890022d598C328a4235b2aaE32d5',
    activation: '0x063c91F8311b7183B3EEC8099Ee7961c11Dbdc14',
    groupRegistry: '0x20695Cb87aff1263C4FF60D6e783bd19B465498a',
    keyRegistry: '0x70cF5a2Fcc2869d39B803dBc23907b19f7F6d3Fc',
    anchors: '0x69eD2E0f5257A90cb88920B0E4Fa4C7792428237',
    perks: '0xadAf0D8E2c07dBE120961dadA9f5D1B5f53C6bB9',
    handles: '0xc1A4a50aaF556d08b7D4EB36265Ab1Bd6f44E934',
  },
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
      `@hoodgram/crypto has no deployment for chainId ${String(chainId)}. Known chains: ${known}.`,
    );
  }
  return deployment;
}
