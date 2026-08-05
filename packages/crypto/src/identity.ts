/**
 * TeleHood identity keys.
 *
 * A user's messaging keys are derived deterministically from one EIP-712 signature, so the
 * same wallet always reproduces the same keypairs on any device without the private keys
 * ever being stored or transmitted. Signing the identity message authorises nothing on
 * chain — it is a pure key-derivation ceremony.
 */
import { hexToBytes } from './bytes';
import { ready } from './sodium';

/** EIP-712 domain for the identity signature. */
export const IDENTITY_DOMAIN = { name: 'TeleHood', version: '1', chainId: 4663 } as const;

/** EIP-712 type definition for the identity signature. */
export const IDENTITY_TYPES = {
  Identity: [
    { name: 'purpose', type: 'string' },
    { name: 'version', type: 'uint256' },
  ],
} as const;

/** The exact message a user signs to derive their identity keys. */
export const IDENTITY_MESSAGE = {
  purpose: 'TeleHood identity key derivation. Signing this does not authorize any transaction.',
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
