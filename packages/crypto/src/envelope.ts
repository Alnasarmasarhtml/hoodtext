/**
 * 1:1 message envelopes.
 *
 * Every drop uses a fresh ephemeral X25519 keypair, so nothing on chain links two messages
 * from the same sender to the same recipient. The recipient finds their own drops by
 * recomputing the Diffie-Hellman shared secret and comparing a one-byte view tag, which
 * keeps the recipient address off chain at the cost of a ~1/256 false-positive rate.
 *
 * Honest scope: contents are unreadable by anyone but the recipient, and length is hidden
 * by fixed-size padding. Metadata is minimised, not eliminated.
 */
import { sha256 } from '@noble/hashes/sha2';
import { assertByteLength, bytesToHex, isByteArrayOfLength } from './bytes';
import { ready } from './sodium';
import {
  BUCKETS,
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

export { BUCKETS };
export { encodePlaintextCore } from './wire';
export type { Plaintext, SealedDrop };

/**
 * Derives the one-byte view tag from a Diffie-Hellman shared secret.
 *
 * `viewTag = sha256(sharedSecret)[0]`.
 */
export function computeViewTag(sharedSecret: Uint8Array): number {
  return sha256(sharedSecret)[0] ?? 0;
}

/**
 * Encrypts a plaintext to a recipient's X25519 public key.
 *
 * The returned blob is the byte-exact wire format documented in the spec:
 * `[version][ephPub 32][nonce 24][crypto_box_easy(paddedPlaintext)]`.
 *
 * @param pt - the message to seal.
 * @param recipientX25519Pub - the recipient's 32-byte X25519 public key.
 * @throws {Error} when the plaintext is invalid or too large, or when the recipient key is
 *   not a valid 32-byte curve point.
 */
export async function seal(pt: Plaintext, recipientX25519Pub: Uint8Array): Promise<SealedDrop> {
  assertByteLength(recipientX25519Pub, KEY_BYTES, 'recipientX25519Pub');
  const padded = padToBucket(encodePlaintext(pt));
  const size = padded.length;

  const sodium = await ready();
  const ephemeral = sodium.crypto_box_keypair();
  const nonce = sodium.randombytes_buf(NONCE_BYTES);

  try {
    let sharedSecret: Uint8Array;
    let ciphertext: Uint8Array;
    try {
      sharedSecret = sodium.crypto_scalarmult(ephemeral.privateKey, recipientX25519Pub);
      ciphertext = sodium.crypto_box_easy(padded, nonce, recipientX25519Pub, ephemeral.privateKey);
    } catch (err: unknown) {
      throw new Error('recipientX25519Pub is not a valid X25519 public key', { cause: err });
    }

    const viewTag = computeViewTag(sharedSecret);
    sodium.memzero(sharedSecret);

    const blob = buildBlob(ephemeral.publicKey, nonce, ciphertext);
    return {
      blob,
      blobRef: bytesToHex(sha256(blob)),
      ephPub: bytesToHex(ephemeral.publicKey),
      viewTag,
      size,
    };
  } finally {
    sodium.memzero(padded);
    sodium.memzero(ephemeral.privateKey);
  }
}

/**
 * Decrypts a blob addressed to us.
 *
 * Returns `null` — never throws — for every failure mode: a wrong key, a tampered or
 * truncated blob, an unknown version byte, a malformed length prefix, invalid UTF-8, or a
 * payload that is not a well-formed plaintext. Blobs are attacker-controlled, so this is a
 * security property, not a convenience.
 *
 * @param blob - the raw envelope bytes.
 * @param myX25519Priv - our 32-byte X25519 private key.
 * @param myX25519Pub - our 32-byte X25519 public key. `crypto_box_open_easy` does not need
 *   it, but it is validated so a caller who passes mismatched key material gets `null`
 *   instead of a silent miss, and so the signature mirrors `unwrapGroupKey`.
 */
export async function open(
  blob: Uint8Array,
  myX25519Priv: Uint8Array,
  myX25519Pub: Uint8Array,
): Promise<Plaintext | null> {
  try {
    if (!isByteArrayOfLength(myX25519Priv, KEY_BYTES)) {
      return null;
    }
    if (!isByteArrayOfLength(myX25519Pub, KEY_BYTES)) {
      return null;
    }
    const parts = parseBlob(blob);
    if (parts === null) {
      return null;
    }

    const sodium = await ready();
    let padded: Uint8Array;
    try {
      padded = sodium.crypto_box_open_easy(
        parts.ciphertext,
        parts.nonce,
        parts.ephPub,
        myX25519Priv,
      );
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
 * Tests whether a drop's view tag matches the shared secret we would derive for it.
 *
 * A match means the drop is *probably* ours — roughly 1 in 256 drops match by chance, so a
 * match must always be followed by {@link open}. Returns `false` rather than throwing for
 * malformed input, because these values come straight off chain.
 */
export async function scanMatches(
  ephPub: Uint8Array,
  viewTag: number,
  myX25519Priv: Uint8Array,
): Promise<boolean> {
  try {
    if (!isByteArrayOfLength(ephPub, KEY_BYTES)) {
      return false;
    }
    if (!isByteArrayOfLength(myX25519Priv, KEY_BYTES)) {
      return false;
    }
    if (!Number.isInteger(viewTag) || viewTag < 0 || viewTag > 255) {
      return false;
    }

    const sodium = await ready();
    let sharedSecret: Uint8Array;
    try {
      sharedSecret = sodium.crypto_scalarmult(myX25519Priv, ephPub);
    } catch {
      return false;
    }
    const tag = computeViewTag(sharedSecret);
    sodium.memzero(sharedSecret);
    return tag === viewTag;
  } catch {
    return false;
  }
}
