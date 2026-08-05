/**
 * Encrypted media attachments.
 *
 * A media file is encrypted under its own random key with `crypto_secretbox` and stored as
 * a separate content-addressed blob; the chat message that "contains" it is an ordinary
 * sealed envelope of kind `media` whose body is a JSON descriptor `{ mime, name, bytes,
 * ref, key }` — so the key travels only inside E2E-encrypted envelopes and the relay holds
 * ciphertext it can never read.
 *
 * Media blobs are padded to power-of-two buckets (64KB..4MB), which hides the exact file
 * size at the cost of revealing its size class — the same honest trade the text envelopes
 * make with their four buckets.
 */
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, readUint32Le, uint32ToLeBytes } from './bytes';
import { ready } from './sodium';
import { NONCE_BYTES } from './wire';

/** Padded media sizes, in bytes, smallest first: 64KB, 256KB, 1MB, 4MB. */
export const MEDIA_BUCKETS = [65_536, 262_144, 1_048_576, 4_194_304] as const;

/** Largest media payload that fits in the biggest bucket. */
export const MAX_MEDIA_BYTES = MEDIA_BUCKETS[MEDIA_BUCKETS.length - 1]! - 4;

/** Media blob format version byte (text envelopes use 0x01). */
export const MEDIA_BLOB_VERSION = 0x02;

/** Offset of the nonce inside a media blob. */
const MEDIA_NONCE_OFFSET = 1;
/** Offset of the ciphertext inside a media blob. */
const MEDIA_CIPHERTEXT_OFFSET = 1 + NONCE_BYTES;
/** Poly1305 tag size. */
const MAC_BYTES = 16;
/** secretbox key size. */
const MEDIA_KEY_BYTES = 32;

/** An encrypted media blob plus the key that opens it. */
export interface SealedMedia {
  /** The encrypted, padded blob to upload to the relay's blob store. */
  blob: Uint8Array;
  /** `sha256(blob)` — the content address the descriptor references. */
  blobRef: `0x${string}`;
  /** The random secretbox key. Travels ONLY inside E2E-encrypted descriptor messages. */
  key: Uint8Array;
}

/** The JSON descriptor carried in a `kind: 'media'` plaintext body. */
export interface MediaDescriptor {
  /** MIME type, e.g. `image/png`. */
  mime: string;
  /** Original file name, display only. */
  name: string;
  /** Original file size in bytes. */
  bytes: number;
  /** blobRef of the encrypted media blob. */
  ref: `0x${string}`;
  /** Hex-encoded secretbox key. */
  key: `0x${string}`;
}

/**
 * Encrypts a media file under a fresh random key.
 *
 * @throws {Error} when the file exceeds {@link MAX_MEDIA_BYTES}.
 */
export async function sealMedia(data: Uint8Array): Promise<SealedMedia> {
  const needed = 4 + data.length;
  const bucket = MEDIA_BUCKETS.find((candidate) => candidate >= needed);
  if (bucket === undefined) {
    throw new Error(`media is too large: ${data.length} bytes exceeds the ${MAX_MEDIA_BYTES} byte maximum`);
  }

  const padded = new Uint8Array(bucket);
  padded.set(uint32ToLeBytes(data.length), 0);
  padded.set(data, 4);

  const sodium = await ready();
  const key = sodium.randombytes_buf(MEDIA_KEY_BYTES);
  const nonce = sodium.randombytes_buf(NONCE_BYTES);

  try {
    const ciphertext = sodium.crypto_secretbox_easy(padded, nonce, key);
    const blob = new Uint8Array(MEDIA_CIPHERTEXT_OFFSET + ciphertext.length);
    blob[0] = MEDIA_BLOB_VERSION;
    blob.set(nonce, MEDIA_NONCE_OFFSET);
    blob.set(ciphertext, MEDIA_CIPHERTEXT_OFFSET);

    return { blob, blobRef: bytesToHex(sha256(blob)), key };
  } finally {
    sodium.memzero(padded);
  }
}

/**
 * Decrypts a media blob with the key from its descriptor.
 *
 * Returns `null` — never throws — for a wrong key, tampered bytes, an unknown version, or
 * a malformed length prefix. Blobs come from the relay and are attacker-controlled.
 */
export async function openMedia(blob: Uint8Array, key: Uint8Array): Promise<Uint8Array | null> {
  try {
    if (!(blob instanceof Uint8Array) || !(key instanceof Uint8Array)) {
      return null;
    }
    if (key.length !== MEDIA_KEY_BYTES) {
      return null;
    }
    if (blob.length < MEDIA_CIPHERTEXT_OFFSET + 4 + MAC_BYTES) {
      return null;
    }
    if (blob[0] !== MEDIA_BLOB_VERSION) {
      return null;
    }
    const paddedLength = blob.length - MEDIA_CIPHERTEXT_OFFSET - MAC_BYTES;
    if (!(MEDIA_BUCKETS as readonly number[]).includes(paddedLength)) {
      return null;
    }

    const nonce = blob.slice(MEDIA_NONCE_OFFSET, MEDIA_NONCE_OFFSET + NONCE_BYTES);
    const ciphertext = blob.slice(MEDIA_CIPHERTEXT_OFFSET);

    const sodium = await ready();
    let padded: Uint8Array;
    try {
      padded = sodium.crypto_secretbox_open_easy(ciphertext, nonce, key);
    } catch {
      return null;
    }

    const declared = readUint32Le(padded, 0);
    if (declared === null || declared > padded.length - 4) {
      sodium.memzero(padded);
      return null;
    }
    const data = padded.slice(4, 4 + declared);
    sodium.memzero(padded);
    return data;
  } catch {
    return null;
  }
}
