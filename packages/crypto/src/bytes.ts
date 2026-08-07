/**
 * Internal byte / hex helpers shared across `@hoodgram/crypto`.
 *
 * Deliberately dependency-free and isomorphic: `TextEncoder`, `TextDecoder` and
 * `crypto.getRandomValues` are available in Node 18+ and every modern browser.
 *
 * This module is NOT part of the public barrel.
 */

const HEX_PATTERN = /^0x[0-9a-fA-F]*$/;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

const encoder = new TextEncoder();
/** `fatal` so that malformed UTF-8 throws instead of silently producing U+FFFD. */
const decoder = new TextDecoder('utf-8', { fatal: true });

/** UTF-8 encodes a string. */
export function utf8Encode(value: string): Uint8Array {
  return encoder.encode(value);
}

/** UTF-8 decodes bytes. Throws on malformed input — callers that must not throw wrap this. */
export function utf8Decode(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/** Lowercase `0x`-prefixed hex encoding. */
export function bytesToHex(bytes: Uint8Array): `0x${string}` {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return `0x${out}`;
}

/**
 * Decodes a `0x`-prefixed hex string.
 *
 * @param value - hex string, with or without a `0x` prefix.
 * @param label - name used in error messages so failures are actionable.
 * @throws {Error} when the input is not even-length hex.
 */
export function hexToBytes(value: string, label: string): Uint8Array {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a hex string`);
  }
  const prefixed = value.startsWith('0x') ? value : `0x${value}`;
  if (!HEX_PATTERN.test(prefixed)) {
    throw new Error(`${label} must be a 0x-prefixed hex string, received "${value}"`);
  }
  const body = prefixed.slice(2);
  if (body.length % 2 !== 0) {
    throw new Error(`${label} must contain an even number of hex digits, received ${body.length}`);
  }
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const byte = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
    out[i] = byte;
  }
  return out;
}

/**
 * Validates and lowercases a 20-byte EVM address.
 *
 * @throws {Error} when `value` is not a 20-byte hex address.
 */
export function normalizeAddress(value: string, label: string): `0x${string}` {
  if (typeof value !== 'string' || !ADDRESS_PATTERN.test(value)) {
    throw new Error(`${label} must be a 20-byte 0x-prefixed address, received "${String(value)}"`);
  }
  return value.toLowerCase() as `0x${string}`;
}

/** Concatenates byte arrays into a fresh buffer. */
export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) {
    total += part.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Little-endian uint32 encoding. */
export function uint32ToLeBytes(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
}

/**
 * Reads a little-endian uint32 at `offset`.
 *
 * @returns the value, or `null` when the slice is out of bounds.
 */
export function readUint32Le(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 4 > bytes.length) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(offset, true);
}

/** Lexicographic byte comparison. Returns <0, 0 or >0. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) {
      return left - right;
    }
  }
  return a.length - b.length;
}

/**
 * Cryptographically secure random bytes via WebCrypto.
 *
 * @throws {Error} when no WebCrypto implementation is available.
 */
export function randomBytes(length: number): Uint8Array {
  // Typed structurally rather than as the DOM `Crypto` so consumers compiling
  // without the DOM lib (the relay) can still typecheck this package's source.
  const webcrypto = (
    globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }
  ).crypto;
  if (webcrypto === undefined || typeof webcrypto.getRandomValues !== 'function') {
    throw new Error('@hoodgram/crypto requires a WebCrypto implementation (globalThis.crypto)');
  }
  return webcrypto.getRandomValues(new Uint8Array(length));
}

/**
 * Asserts that `value` is a `Uint8Array` of exactly `length` bytes.
 *
 * @throws {Error} with an actionable message when it is not.
 */
export function assertByteLength(value: Uint8Array, length: number, label: string): void {
  if (!(value instanceof Uint8Array)) {
    throw new Error(`${label} must be a Uint8Array`);
  }
  if (value.length !== length) {
    throw new Error(`${label} must be ${length} bytes, received ${value.length}`);
  }
}

/** Non-throwing variant of {@link assertByteLength}, for attacker-controlled input. */
export function isByteArrayOfLength(value: unknown, length: number): value is Uint8Array {
  return value instanceof Uint8Array && value.length === length;
}
