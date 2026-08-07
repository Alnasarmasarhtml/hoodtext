/**
 * Live-chain implementations of the send pipeline's two ports: reads through a
 * viem public client, writes through a wallet client holding the relay's funded
 * key. Everything the pipeline checks per message is cached with a sensibly
 * scoped TTL — activation is permanent so it caches forever, identity keys
 * rotate rarely, room rent changes at most monthly.
 */

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Chain,
  type PublicClient,
  type WalletClient,
  type Account,
  type Transport,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { SignableDrop } from '@hoodgram/crypto';
import { POST_BATCH_ABI, RELAY_READS_ABI } from './abi.js';
import type { RelayConfig } from './config.js';
import type { BatchPoster, ChainGate } from './sender.js';

const ZERO_KEY = `0x${'0'.repeat(64)}`;

/** How long a registered identity key is trusted before re-reading it. */
const KEY_TTL_MS = 300_000;
/**
 * How long a room's rent status is trusted before re-reading it.
 *
 * This is a load-shedding knob, not a safety boundary. A rent lapse inside the
 * window can still let `submit()` accept a doomed drop — the chain rejects it
 * regardless, `SendPipeline` isolates it from its batch-mates, and the sender can
 * see the failure. Shrinking it only reduces how often that path is taken; it
 * cannot close the window, because rent can lapse after the read and before the
 * transaction lands. Hence: cheap here, correct there.
 */
const ROOM_TTL_MS = 15_000;

interface Cached<T> {
  readonly value: T;
  readonly expiresAt: number;
}

function chainFor(config: RelayConfig): Chain {
  return defineChain({
    id: config.chainId,
    name: `chain-${config.chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });
}

/**
 * {@link ChainGate} backed by contract reads.
 *
 * Requires `keyRegistryAddress`, `activationAddress` and `groupRegistryAddress`
 * in the config; {@link buildSendPorts} only constructs it when all three are set.
 */
export class ViemChainGate implements ChainGate {
  private readonly client: PublicClient;
  private readonly keyRegistry: `0x${string}`;
  private readonly activation: `0x${string}`;
  private readonly groupRegistry: `0x${string}`;

  private readonly activated = new Set<string>();
  private readonly keys = new Map<string, Cached<`0x${string}` | null>>();
  private readonly rooms = new Map<string, Cached<boolean>>();

  constructor(
    client: PublicClient,
    addresses: {
      keyRegistry: `0x${string}`;
      activation: `0x${string}`;
      groupRegistry: `0x${string}`;
    },
  ) {
    this.client = client;
    this.keyRegistry = addresses.keyRegistry;
    this.activation = addresses.activation;
    this.groupRegistry = addresses.groupRegistry;
  }

  async ed25519KeyOf(sender: `0x${string}`): Promise<`0x${string}` | null> {
    const cacheKey = sender.toLowerCase();
    const hit = this.keys.get(cacheKey);
    if (hit !== undefined && hit.expiresAt > Date.now()) return hit.value;

    const [, ed25519] = await this.client.readContract({
      address: this.keyRegistry,
      abi: RELAY_READS_ABI,
      functionName: 'keysOf',
      args: [sender],
    });
    const value = ed25519 === ZERO_KEY ? null : ed25519;
    this.keys.set(cacheKey, { value, expiresAt: Date.now() + KEY_TTL_MS });
    return value;
  }

  async isActivated(sender: `0x${string}`): Promise<boolean> {
    const cacheKey = sender.toLowerCase();
    // Activation is permanent, so a positive result never needs re-reading.
    if (this.activated.has(cacheKey)) return true;

    const active = await this.client.readContract({
      address: this.activation,
      abi: RELAY_READS_ABI,
      functionName: 'isActivated',
      args: [sender],
    });
    if (active) this.activated.add(cacheKey);
    return active;
  }

  async isRoomActive(
    groupId: `0x${string}`,
    options?: { readonly fresh?: boolean },
  ): Promise<boolean> {
    const cacheKey = groupId.toLowerCase();
    // `fresh` is how the send pipeline attributes a reverted batch to a specific
    // drop. Answering that from the same cache that let the drop in would just
    // re-confirm the stale value and blame nobody.
    if (options?.fresh !== true) {
      const hit = this.rooms.get(cacheKey);
      if (hit !== undefined && hit.expiresAt > Date.now()) return hit.value;
    }

    const active = await this.client.readContract({
      address: this.groupRegistry,
      abi: RELAY_READS_ABI,
      functionName: 'isActive',
      args: [groupId],
    });
    this.rooms.set(cacheKey, { value: active, expiresAt: Date.now() + ROOM_TTL_MS });
    return active;
  }
}

/** {@link BatchPoster} that signs and sends `Anchors.postBatch` with the relay key. */
export class ViemBatchPoster implements BatchPoster {
  private readonly wallet: WalletClient<Transport, Chain, Account>;
  private readonly anchors: `0x${string}`;

  constructor(wallet: WalletClient<Transport, Chain, Account>, anchors: `0x${string}`) {
    this.wallet = wallet;
    this.anchors = anchors;
  }

  async post(drops: readonly SignableDrop[]): Promise<`0x${string}`> {
    return this.wallet.writeContract({
      address: this.anchors,
      abi: POST_BATCH_ABI,
      functionName: 'postBatch',
      args: [
        drops.map((drop) => ({
          convoId: drop.convoId,
          ephPub: drop.ephPub,
          blobRef: drop.blobRef,
          viewTag: drop.viewTag,
          size: drop.size,
        })),
      ],
    });
  }
}

/**
 * Builds the pipeline's chain ports from config, or `null` when gasless send is
 * not fully configured. Send needs: a relayer private key, the Anchors address
 * (shared with the indexer) and the three read addresses.
 */
export function buildSendPorts(
  config: RelayConfig,
): { gate: ChainGate; poster: BatchPoster } | null {
  if (
    config.relayerPrivateKey === null ||
    config.anchorsAddress === null ||
    config.keyRegistryAddress === null ||
    config.activationAddress === null ||
    config.groupRegistryAddress === null
  ) {
    return null;
  }

  const chain = chainFor(config);
  const transport = http(config.rpcUrl, { timeout: config.rpcTimeoutMs });
  const publicClient = createPublicClient({ chain, transport });
  const account = privateKeyToAccount(config.relayerPrivateKey);
  const wallet = createWalletClient({ chain, transport, account });

  return {
    gate: new ViemChainGate(publicClient, {
      keyRegistry: config.keyRegistryAddress,
      activation: config.activationAddress,
      groupRegistry: config.groupRegistryAddress,
    }),
    poster: new ViemBatchPoster(wallet, config.anchorsAddress),
  };
}
