/**
 * Deterministic conversation and group identifiers.
 *
 * A 1:1 conversation id is a purely local threading key derived from the two participants'
 * X25519 public keys — it is deliberately NOT posted on chain for stealth drops, where
 * `convoId` is `0x0`. Group ids are posted, so they are derived from a creator-chosen salt
 * rather than from membership.
 */
import { sha256 } from '@noble/hashes/sha2';
import {
  assertByteLength,
  bytesToHex,
  compareBytes,
  concatBytes,
  hexToBytes,
  normalizeAddress,
  uint32ToLeBytes,
  utf8Encode,
} from './bytes';

/** X25519 public key size, in bytes. */
const PUBLIC_KEY_BYTES = 32;

/** Domain separator so a group id can never collide with a conversation id. */
const GROUP_ID_DOMAIN = 'HoodGram/groupId/v1';

/**
 * Derives the shared conversation id for two participants.
 *
 * `sha256` of the two X25519 public keys concatenated in ascending byte order, so both
 * sides compute the same value regardless of argument order.
 *
 * @throws {Error} when either key is not exactly 32 bytes.
 */
export function convoIdFor(a: Uint8Array, b: Uint8Array): `0x${string}` {
  assertByteLength(a, PUBLIC_KEY_BYTES, 'a');
  assertByteLength(b, PUBLIC_KEY_BYTES, 'b');
  const ordered: readonly [Uint8Array, Uint8Array] = compareBytes(a, b) <= 0 ? [a, b] : [b, a];
  return bytesToHex(sha256(concatBytes(ordered[0], ordered[1])));
}

/**
 * Derives a group id from its name, creator and salt.
 *
 * The two variable-length fields are length-prefixed and the whole preimage is domain
 * separated, so distinct inputs can never produce the same digest by concatenation
 * ambiguity. The creator address is lowercased first, making the result checksum-agnostic.
 *
 * @throws {Error} when `creator` is not a 20-byte address or `salt` is not even-length hex.
 */
export function groupIdFor(
  name: string,
  creator: `0x${string}`,
  salt: `0x${string}`,
): `0x${string}` {
  if (typeof name !== 'string') {
    throw new Error('name must be a string');
  }
  const nameBytes = utf8Encode(name);
  const creatorBytes = hexToBytes(normalizeAddress(creator, 'creator'), 'creator');
  const saltBytes = hexToBytes(salt, 'salt');

  return bytesToHex(
    sha256(
      concatBytes(
        utf8Encode(GROUP_ID_DOMAIN),
        uint32ToLeBytes(nameBytes.length),
        nameBytes,
        creatorBytes,
        uint32ToLeBytes(saltBytes.length),
        saltBytes,
      ),
    ),
  );
}
