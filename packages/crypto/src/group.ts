/**
 * Group messaging — sender-key with epoch rotation.
 *
 * **This is MLS-LITE, not RFC 9420 MLS.** Be honest about what it is: one symmetric group
 * key per epoch, wrapped individually to each member's X25519 public key. It gives
 * confidentiality against non-members and cheap fan-out, and rotating the epoch removes a
 * departing member going forward. It does NOT give the tree-based forward secrecy,
 * post-compromise security or formal agreement guarantees of real MLS. A member who kept a
 * previous epoch key can still read messages from that epoch.
 */
import { sha256 } from '@noble/hashes/sha2';
import {
  assertByteLength,
  bytesToHex,
  concatBytes,
  hexToBytes,
  isByteArrayOfLength,
  normalizeAddress,
  randomBytes,
} from './bytes';
import { computeViewTag } from './envelope';
import { ready } from './sodium';
import {
  KEY_BYTES,
  NONCE_BYTES,
  buildBlob,
  decodePlaintext,
  encodePlaintext,
  padToBucket,
  parseBlob,
  unpad,
} from './wire';
import type { Plaintext, SealedDrop } from './wire';

/** Symmetric group key size, in bytes (XSalsa20-Poly1305 secretbox key). */
const GROUP_KEY_BYTES = 32;
/** `crypto_box_seal` overhead: one ephemeral public key plus the Poly1305 tag. */
const SEAL_OVERHEAD_BYTES = 48;
/** Version byte on a wrapped group key. */
const WRAP_VERSION = 0x01;
/** Total length of a wrapped group key: version byte + sealed box. */
const WRAPPED_KEY_BYTES = 1 + SEAL_OVERHEAD_BYTES + GROUP_KEY_BYTES;
/** `ephPub` placeholder for group drops — group blobs carry no ephemeral key. */
const GROUP_EPH_PUB = new Uint8Array(KEY_BYTES);
/** Domain tag for Merkle leaves. */
const LEAF_TAG = new Uint8Array([0x00]);
/** Domain tag for Merkle internal nodes. */
const NODE_TAG = new Uint8Array([0x01]);
/** Root of an empty member set. */
const EMPTY_ROOT: `0x${string}` = `0x${'00'.repeat(32)}`;

function isAllZero(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte !== 0) {
      return false;
    }
  }
  return true;
}

/** Generates a fresh random group key for a new epoch. */
export function newGroupKey(): Uint8Array {
  return randomBytes(GROUP_KEY_BYTES);
}

/**
 * Wraps a group key for one member using an anonymous sealed box.
 *
 * Output layout: `[version 0x01][crypto_box_seal(groupKey, memberPub)]` — 81 bytes. The
 * sealed box carries its own throwaway ephemeral key, so the wrapping reveals nothing
 * about who produced it.
 *
 * @throws {Error} when the key or member public key has the wrong length, or when
 *   `memberPub` is not a valid curve point.
 */
export async function wrapGroupKey(key: Uint8Array, memberPub: Uint8Array): Promise<Uint8Array> {
  assertByteLength(key, GROUP_KEY_BYTES, 'key');
  assertByteLength(memberPub, KEY_BYTES, 'memberPub');

  const sodium = await ready();
  let sealed: Uint8Array;
  try {
    sealed = sodium.crypto_box_seal(key, memberPub);
  } catch (err: unknown) {
    throw new Error('memberPub is not a valid X25519 public key', { cause: err });
  }

  const wrapped = new Uint8Array(1 + sealed.length);
  wrapped[0] = WRAP_VERSION;
  wrapped.set(sealed, 1);
  return wrapped;
}

/**
 * Unwraps a group key addressed to us.
 *
 * Returns `null` — never throws — for a wrong key, a tampered or truncated wrapping, or an
 * unknown version byte. Wrapped keys are attacker-controlled input.
 */
export async function unwrapGroupKey(
  wrapped: Uint8Array,
  myPriv: Uint8Array,
  myPub: Uint8Array,
): Promise<Uint8Array | null> {
  try {
    if (!isByteArrayOfLength(wrapped, WRAPPED_KEY_BYTES)) {
      return null;
    }
    if (!isByteArrayOfLength(myPriv, KEY_BYTES) || !isByteArrayOfLength(myPub, KEY_BYTES)) {
      return null;
    }
    if (wrapped[0] !== WRAP_VERSION) {
      return null;
    }

    const sodium = await ready();
    let key: Uint8Array;
    try {
      key = sodium.crypto_box_seal_open(wrapped.slice(1), myPub, myPriv);
    } catch {
      return null;
    }
    return key.length === GROUP_KEY_BYTES ? key : null;
  } catch {
    return null;
  }
}

/**
 * Encrypts a plaintext to a group's current epoch key.
 *
 * The blob uses the same byte layout as a 1:1 envelope so the relay and the padding
 * guarantee are identical, but the ciphertext is a `crypto_secretbox` under the group key
 * and the ephemeral public key slot is 32 zero bytes. The view tag is derived from the
 * group key, which lets members tell at a glance which epoch a drop belongs to without
 * revealing anything beyond the group id already published on chain.
 *
 * @throws {Error} when the plaintext is invalid or too large, or the key is the wrong size.
 */
export async function sealToGroup(pt: Plaintext, groupKey: Uint8Array): Promise<SealedDrop> {
  assertByteLength(groupKey, GROUP_KEY_BYTES, 'groupKey');
  const padded = padToBucket(encodePlaintext(pt));
  const size = padded.length;

  const sodium = await ready();
  const nonce = sodium.randombytes_buf(NONCE_BYTES);
  try {
    const ciphertext = sodium.crypto_secretbox_easy(padded, nonce, groupKey);
    const blob = buildBlob(GROUP_EPH_PUB, nonce, ciphertext);
    return {
      blob,
      blobRef: bytesToHex(sha256(blob)),
      ephPub: bytesToHex(GROUP_EPH_PUB),
      viewTag: computeViewTag(groupKey),
      size,
    };
  } finally {
    sodium.memzero(padded);
  }
}

/**
 * Decrypts a group blob.
 *
 * Returns `null` — never throws — for a wrong epoch key, a tampered or truncated blob, an
 * unknown version byte, or a malformed payload.
 */
export async function openFromGroup(
  blob: Uint8Array,
  groupKey: Uint8Array,
): Promise<Plaintext | null> {
  try {
    if (!isByteArrayOfLength(groupKey, GROUP_KEY_BYTES)) {
      return null;
    }
    const parts = parseBlob(blob);
    if (parts === null) {
      return null;
    }
    // The ephemeral-key slot is not an input to secretbox, so without this check any of its
    // 32 bytes could be altered and the blob would still decrypt — yielding a second, valid
    // blobRef for identical content. Rejecting a non-zero slot keeps group blobs
    // non-malleable and keeps the content-addressed relay honest.
    if (!isAllZero(parts.ephPub)) {
      return null;
    }

    const sodium = await ready();
    let padded: Uint8Array;
    try {
      padded = sodium.crypto_secretbox_open_easy(parts.ciphertext, parts.nonce, groupKey);
    } catch {
      return null;
    }

    const payload = unpad(padded);
    sodium.memzero(padded);
    if (payload === null) {
      return null;
    }
    return decodePlaintext(payload);
  } catch {
    return null;
  }
}

/**
 * Commits to a group's membership as a Merkle root over the sorted, de-duplicated member
 * addresses.
 *
 * Addresses are lowercased, de-duplicated and sorted before hashing, so the root is a
 * function of the member *set* — reordering the input cannot change it. Leaves and
 * internal nodes are domain separated to prevent second-preimage confusion. An odd node at
 * any level is paired with itself. An empty membership hashes to 32 zero bytes.
 *
 * @throws {Error} when any entry is not a 20-byte address.
 */
export function memberRoot(members: `0x${string}`[]): `0x${string}` {
  if (!Array.isArray(members)) {
    throw new Error('members must be an array of addresses');
  }
  const unique = [
    ...new Set(members.map((member, index) => normalizeAddress(member, `members[${index}]`))),
  ].sort();
  if (unique.length === 0) {
    return EMPTY_ROOT;
  }

  let level: Uint8Array[] = unique.map((address) =>
    sha256(concatBytes(LEAF_TAG, hexToBytes(address, 'member'))),
  );

  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      if (left === undefined) {
        continue;
      }
      const right = level[i + 1] ?? left;
      next.push(sha256(concatBytes(NODE_TAG, left, right)));
    }
    level = next;
  }

  const root = level[0];
  if (root === undefined) {
    return EMPTY_ROOT;
  }
  return bytesToHex(root);
}
