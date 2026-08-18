/**
 * Internal wire-format primitives shared by the 1:1 envelope and the group envelope.
 *
 * The blob layout is byte-exact and parsed independently by the relay and the web client:
 *
 * ```text
 *   [0]        version = 0x01
 *   [1..33)    ephemeral X25519 public key (32 bytes; 32 zero bytes for group drops)
 *   [33..57)   nonce (24 bytes)
 *   [57..]     authenticated ciphertext of the padded plaintext (+16 byte MAC)
 * ```
 *
 * The padded plaintext is `[4-byte LE length][utf8 JSON payload][zero padding]`, sized up
 * to the smallest bucket that fits. Because the bucket set is tiny and fixed, the on-wire
 * length reveals nothing beyond "which of four size classes" — a 5-character and a
 * 200-character message produce byte-identical blob lengths.
 *
 * This module is NOT part of the public barrel; `BUCKETS`, `Plaintext` and `SealedDrop`
 * are re-exported from `envelope.ts` where the spec places them.
 */
import { readUint32Le, uint32ToLeBytes, utf8Decode, utf8Encode } from './bytes';

/** Padded plaintext sizes, in bytes, smallest first. */
export const BUCKETS = [256, 1024, 4096, 16384] as const;

/** Every message kind the wire format carries. */
export const PLAINTEXT_KINDS = ['text', 'system', 'media', 'react'] as const;

/** A decrypted message body. */
export interface Plaintext {
  v: 1;
  t: number;
  /**
   * `text` is a chat message; `system` is app-generated (key handoffs, membership notes);
   * `media` carries a JSON descriptor pointing at a separately encrypted media blob;
   * `react` carries a JSON `{ target, emoji, op }` reaction toggle on an earlier drop.
   */
  kind: (typeof PLAINTEXT_KINDS)[number];
  body: string;
  /** Optional blobRef of the message this one replies to. */
  re?: `0x${string}`;
  /**
   * Optional author claim: the sender's wallet address, INSIDE the sealed payload so only
   * the recipient learns it. Never trust it bare — it is proven by `sig`, verified against
   * the address's registered Ed25519 key ({@link KeyRegistry.keysOf}). `from` and `sig`
   * travel together: one without the other is malformed. Both optional so v1 payloads
   * written before attribution existed still decode (and render unattributed).
   */
  from?: `0x${string}`;
  /** Detached Ed25519 author signature over the core payload; see `sign.ts#signAuthor`. */
  sig?: `0x${string}`;
}

/** Everything needed to anchor one message on chain. */
export interface SealedDrop {
  blob: Uint8Array;
  blobRef: `0x${string}`;
  ephPub: `0x${string}`;
  viewTag: number;
  size: number;
}

/** Blob format version byte. */
export const BLOB_VERSION = 0x01;
/** Offset of the ephemeral public key inside a blob. */
export const EPH_PUB_OFFSET = 1;
/** Offset of the nonce inside a blob. */
export const NONCE_OFFSET = 33;
/** Offset of the ciphertext inside a blob. */
export const CIPHERTEXT_OFFSET = 57;
/** X25519 public/private key size. */
export const KEY_BYTES = 32;
/** XSalsa20-Poly1305 nonce size, shared by `crypto_box` and `crypto_secretbox`. */
export const NONCE_BYTES = 24;
/** Poly1305 tag size, shared by `crypto_box` and `crypto_secretbox`. */
export const MAC_BYTES = 16;
/** Size of the little-endian length prefix inside the padded plaintext. */
export const LENGTH_PREFIX_BYTES = 4;
/** Largest payload that fits in the biggest bucket. */
export const MAX_PAYLOAD_BYTES = 16384 - LENGTH_PREFIX_BYTES;

/**
 * Canonically serialises a plaintext.
 *
 * Fields are written in a fixed order and unknown properties are dropped, so the encoding
 * depends only on the four documented fields.
 *
 * @throws {Error} when the plaintext is structurally invalid or too large to pad.
 */
export function encodePlaintext(pt: Plaintext): Uint8Array {
  if (typeof pt !== 'object' || pt === null) {
    throw new Error('plaintext must be an object');
  }
  if (pt.v !== 1) {
    throw new Error(`plaintext.v must be 1, received ${String(pt.v)}`);
  }
  if (typeof pt.t !== 'number' || !Number.isFinite(pt.t)) {
    throw new Error('plaintext.t must be a finite number');
  }
  if (!PLAINTEXT_KINDS.includes(pt.kind)) {
    throw new Error(`plaintext.kind must be one of ${PLAINTEXT_KINDS.join(', ')}, received ${String(pt.kind)}`);
  }
  if (typeof pt.body !== 'string') {
    throw new Error('plaintext.body must be a string');
  }
  if (pt.re !== undefined && !isHex32(pt.re)) {
    throw new Error('plaintext.re must be a 0x-prefixed 32-byte hex string when present');
  }
  if ((pt.from === undefined) !== (pt.sig === undefined)) {
    throw new Error('plaintext.from and plaintext.sig must be present together or not at all');
  }
  if (pt.from !== undefined && !isHexAddress(pt.from)) {
    throw new Error('plaintext.from must be a 0x-prefixed 20-byte hex address when present');
  }
  if (pt.sig !== undefined && !isHexSig(pt.sig)) {
    throw new Error('plaintext.sig must be a 0x-prefixed 64-byte hex signature when present');
  }
  const canonical = coreCanonical(pt);
  if (pt.sig !== undefined) {
    canonical['sig'] = pt.sig;
  }
  return utf8Encode(JSON.stringify(canonical));
}

/** The canonical field set WITHOUT the author signature — what the signature covers. */
function coreCanonical(pt: Plaintext): Record<string, unknown> {
  const canonical: Record<string, unknown> = { v: pt.v, t: pt.t, kind: pt.kind, body: pt.body };
  if (pt.re !== undefined) {
    canonical['re'] = pt.re;
  }
  if (pt.from !== undefined) {
    canonical['from'] = pt.from.toLowerCase();
  }
  return canonical;
}

/**
 * Canonically serialises the SIGNED portion of a plaintext: every field except `sig`,
 * in the same fixed order {@link encodePlaintext} writes. The author signature is computed
 * over exactly these bytes, so signing and verifying can never disagree about the message.
 */
export function encodePlaintextCore(pt: Plaintext): Uint8Array {
  return utf8Encode(JSON.stringify(coreCanonical(pt)));
}

/** Whether a value is a `0x`-prefixed 32-byte lowercase-tolerant hex string. */
function isHex32(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

/** Whether a value is a `0x`-prefixed 20-byte hex address. */
function isHexAddress(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

/** Whether a value is a `0x`-prefixed 64-byte hex detached signature. */
function isHexSig(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{128}$/.test(value);
}

/**
 * Validates and re-materialises a plaintext from its JSON encoding.
 *
 * Never throws — returns `null` for anything that is not a well-formed plaintext, because
 * the bytes reaching this function may have been chosen by an attacker.
 */
export function decodePlaintext(payload: Uint8Array): Plaintext | null {
  let json: string;
  try {
    json = utf8Decode(payload);
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;

  const t = record['t'];
  const kind = record['kind'];
  const body = record['body'];
  const re = record['re'];
  const from = record['from'];
  const sig = record['sig'];

  if (record['v'] !== 1) {
    return null;
  }
  if (typeof t !== 'number' || !Number.isFinite(t)) {
    return null;
  }
  if (typeof kind !== 'string' || !(PLAINTEXT_KINDS as readonly string[]).includes(kind)) {
    return null;
  }
  if (typeof body !== 'string') {
    return null;
  }
  if (re !== undefined && !isHex32(re)) {
    return null;
  }
  if ((from === undefined) !== (sig === undefined)) {
    return null;
  }
  if (from !== undefined && !isHexAddress(from)) {
    return null;
  }
  if (sig !== undefined && !isHexSig(sig)) {
    return null;
  }
  const pt: Plaintext = { v: 1, t, kind: kind as Plaintext['kind'], body };
  if (re !== undefined) {
    pt.re = re;
  }
  if (from !== undefined && sig !== undefined) {
    pt.from = (from as string).toLowerCase() as `0x${string}`;
    pt.sig = sig as `0x${string}`;
  }
  return pt;
}

/**
 * Pads a payload up to the smallest bucket that can hold it.
 *
 * @throws {Error} when the payload exceeds the largest bucket.
 */
export function padToBucket(payload: Uint8Array): Uint8Array {
  const needed = LENGTH_PREFIX_BYTES + payload.length;
  const bucket = BUCKETS.find((candidate) => candidate >= needed);
  if (bucket === undefined) {
    throw new Error(
      `message is too large: ${payload.length} bytes exceeds the ${MAX_PAYLOAD_BYTES} byte maximum`,
    );
  }
  const padded = new Uint8Array(bucket);
  padded.set(uint32ToLeBytes(payload.length), 0);
  padded.set(payload, LENGTH_PREFIX_BYTES);
  return padded;
}

/**
 * Reverses {@link padToBucket}.
 *
 * Never throws — returns `null` when the padded plaintext is not a valid bucket or the
 * declared length does not fit.
 */
export function unpad(padded: Uint8Array): Uint8Array | null {
  if (!(padded instanceof Uint8Array)) {
    return null;
  }
  if (!(BUCKETS as readonly number[]).includes(padded.length)) {
    return null;
  }
  const declared = readUint32Le(padded, 0);
  if (declared === null || declared > padded.length - LENGTH_PREFIX_BYTES) {
    return null;
  }
  return padded.slice(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + declared);
}

/**
 * Splits a blob into its three fixed-size regions plus the ciphertext.
 *
 * Never throws — returns `null` for any blob that is malformed, truncated, or carries an
 * unknown version byte.
 */
export function parseBlob(
  blob: Uint8Array,
): { ephPub: Uint8Array; nonce: Uint8Array; ciphertext: Uint8Array } | null {
  if (!(blob instanceof Uint8Array)) {
    return null;
  }
  if (blob.length < CIPHERTEXT_OFFSET + LENGTH_PREFIX_BYTES + MAC_BYTES) {
    return null;
  }
  if (blob[0] !== BLOB_VERSION) {
    return null;
  }
  const ciphertextLength = blob.length - CIPHERTEXT_OFFSET;
  if (!(BUCKETS as readonly number[]).includes(ciphertextLength - MAC_BYTES)) {
    return null;
  }
  return {
    ephPub: blob.slice(EPH_PUB_OFFSET, EPH_PUB_OFFSET + KEY_BYTES),
    nonce: blob.slice(NONCE_OFFSET, NONCE_OFFSET + NONCE_BYTES),
    ciphertext: blob.slice(CIPHERTEXT_OFFSET),
  };
}

/** Assembles a blob from its regions. */
export function buildBlob(
  ephPub: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array {
  const blob = new Uint8Array(CIPHERTEXT_OFFSET + ciphertext.length);
  blob[0] = BLOB_VERSION;
  blob.set(ephPub, EPH_PUB_OFFSET);
  blob.set(nonce, NONCE_OFFSET);
  blob.set(ciphertext, CIPHERTEXT_OFFSET);
  return blob;
}
