/**
 * HoodGram identity keys.
 *
 * A user's messaging keys are derived deterministically from one EIP-712 signature, so the
 * same wallet always reproduces the same keypairs on any device without the private keys
 * ever being stored or transmitted. Signing the identity message authorises nothing on
 * chain — it is a pure key-derivation ceremony.
 */
import { hexToBytes } from './bytes';
import { ready } from './sodium';

/**
 * EIP-712 domain for the identity signature.
 *
 * THIS OBJECT IS THE DERIVATION. Sign it EXACTLY as written — never spread it and override a
 * field, never substitute the connected chain, never bump `version` without treating it as a
 * deliberate, irreversible rotation of every user's keys. The signature is the only input to
 * {@link deriveIdentity}, so ANY difference in the domain produces a different signature, which
 * produces different keypairs, which means a wallet holds two identities that cannot read each
 * other's messages. There is no recovery from that: the old ciphertext stays sealed to the old key.
 *
 * WHY `chainId` IS PINNED TO 4663 AND NOT THE CONNECTED CHAIN
 * (this divergence has already shipped once — `smoke-send.ts` used to sign with
 * `{ ...IDENTITY_DOMAIN, chainId: chain.id }`, so the browser and the script derived different
 * identities for the same wallet on every chain that is not 4663):
 *
 *  1. An identity must be STABLE for the life of the account. If the domain followed the wallet's
 *     current network, then switching networks — or connecting on a chain the app does not target —
 *     would silently derive a different key and lock the user out of their own history. Chain
 *     selection is a transport detail; it must not be an input to a user's cryptographic identity.
 *  2. Pinning costs nothing in security. This signature authorises no transaction, is never
 *     submitted on chain, and is never verified by a contract, so the replay protection that
 *     `chainId` normally buys is not a property anyone here relies on. `name` + `version` already
 *     separate this payload from every other domain a wallet might be asked to sign.
 *  3. It matches SPEC §5, which pins this exact object as part of the frozen `@hoodgram/crypto`
 *     API, and the pin test in `test/identity.test.ts`.
 *
 * THE KNOWN COST, AND WHY IT IS ACCEPTED: MetaMask (and Rabby, and others) reject
 * `eth_signTypedData_v4` when a domain carries a `chainId` that is not the wallet's active chain —
 * "Provided chainId ... must match the active chainId ...". For real users this never fires: the
 * app only reaches the ceremony when the wallet is on the chain the build targets, which in
 * production is 4663. It DOES fire for a developer running the web app against anvil on 31337.
 * The fix for that is to move the dev chain to this id — `anvil --chain-id 4663`, deploy, and run
 * the web app with `NEXT_PUBLIC_CHAIN_ID=4663 NEXT_PUBLIC_RPC_URL=http://127.0.0.1:8545` — never to
 * bend the domain to the chain. Dropping `chainId` from the domain entirely would also work (wallets
 * only run that check when the field is present), but it would change every derived key and break
 * the SPEC-frozen API, so it is deliberately not done here.
 */
export const IDENTITY_DOMAIN = { name: 'HoodGram', version: '1', chainId: 4663 } as const;

/** EIP-712 type definition for the identity signature. */
export const IDENTITY_TYPES = {
  Identity: [
    { name: 'purpose', type: 'string' },
    { name: 'version', type: 'uint256' },
  ],
} as const;

/** The exact message a user signs to derive their identity keys. */
export const IDENTITY_MESSAGE = {
  purpose: 'HoodGram identity key derivation. Signing this does not authorize any transaction.',
  version: 1n,
};

/** A user's messaging keypairs: X25519 for encryption, Ed25519 for signatures. */
export interface IdentityKeys {
  x25519: { publicKey: Uint8Array; privateKey: Uint8Array };
  ed25519: { publicKey: Uint8Array; privateKey: Uint8Array };
}

/** Length, in bytes, of the BLAKE2b master seed. */
const SEED_BYTES = 64;
/** Length, in bytes, of each half of the master seed. */
const HALF_SEED_BYTES = 32;

/**
 * Derives a user's X25519 and Ed25519 keypairs from their identity signature.
 *
 * `seed = blake2b(signature, 64)`; the first 32 bytes seed the X25519 keypair and the last
 * 32 bytes seed the Ed25519 keypair. The derivation is fully deterministic: the same
 * signature always yields byte-identical keys.
 *
 * The intermediate seed is zeroed before returning.
 *
 * @param signature - the `0x`-prefixed EIP-712 signature over {@link IDENTITY_MESSAGE}.
 * @throws {Error} when `signature` is not non-empty, even-length hex.
 */
export async function deriveIdentity(signature: `0x${string}`): Promise<IdentityKeys> {
  const signatureBytes = hexToBytes(signature, 'signature');
  if (signatureBytes.length === 0) {
    throw new Error('signature must not be empty');
  }

  const sodium = await ready();
  const seed = sodium.crypto_generichash(SEED_BYTES, signatureBytes, null);
  const x25519Seed = seed.slice(0, HALF_SEED_BYTES);
  const ed25519Seed = seed.slice(HALF_SEED_BYTES, SEED_BYTES);

  try {
    const x25519 = sodium.crypto_box_seed_keypair(x25519Seed);
    const ed25519 = sodium.crypto_sign_seed_keypair(ed25519Seed);
    return {
      x25519: { publicKey: x25519.publicKey, privateKey: x25519.privateKey },
      ed25519: { publicKey: ed25519.publicKey, privateKey: ed25519.privateKey },
    };
  } finally {
    sodium.memzero(seed);
    sodium.memzero(x25519Seed);
    sodium.memzero(ed25519Seed);
  }
}
