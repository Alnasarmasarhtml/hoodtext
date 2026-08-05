import { deriveIdentity } from '../src/index';
import type { IdentityKeys, Plaintext } from '../src/index';

/** A realistic 65-byte ECDSA signature, used wherever a fixed identity is needed. */
export const FIXED_SIGNATURE =
  '0x9d5c1f2a7b3e4d6081a2c3e4f50617283940a1b2c3d4e5f60718293a4b5c6d7e' +
  '1f2e3d4c5b6a798807162534435261708f9e0d1c2b3a49586776859403a2b1c0' +
  '1b';

/** A second fixed signature that must derive a completely different identity. */
export const OTHER_SIGNATURE =
  '0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20' +
  '2122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40' +
  '1c';

/** Deterministic timestamp so JSON encodings are stable across runs. */
export const FIXED_TIME = 1_700_000_000_000;

/** Builds a plaintext with the fixed timestamp. */
export function textMessage(body: string, t: number = FIXED_TIME): Plaintext {
  return { v: 1, t, kind: 'text', body };
}

/** Number of bytes the JSON envelope adds around an ASCII body. */
export function jsonOverhead(t: number = FIXED_TIME): number {
  return JSON.stringify({ v: 1, t, kind: 'text', body: '' }).length;
}

/**
 * Builds an ASCII body whose serialised plaintext exactly fills `bucket` bytes once the
 * 4-byte length prefix is added.
 */
export function bodyFillingBucket(bucket: number, t: number = FIXED_TIME): string {
  const length = bucket - 4 - jsonOverhead(t);
  if (length < 0) {
    throw new Error(`bucket ${bucket} is too small for the JSON envelope`);
  }
  return 'x'.repeat(length);
}

let counter = 0;

/** Derives a fresh, unique identity without needing a wallet. */
export async function freshIdentity(): Promise<IdentityKeys> {
  counter += 1;
  const seed = `${counter.toString(16).padStart(8, '0')}${Date.now().toString(16)}`;
  const padded = seed.padEnd(130, '0').slice(0, 130);
  return deriveIdentity(`0x${padded}`);
}

/** Deterministic pseudo-random bytes, so fuzz failures are reproducible. */
export function seededBytes(seed: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = (seed ^ 0x9e3779b9) >>> 0;
  for (let i = 0; i < length; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = (state >>> 24) & 0xff;
  }
  return out;
}

/** Returns a copy of `bytes` with the bit at `index` flipped. */
export function flipByte(bytes: Uint8Array, index: number): Uint8Array {
  const copy = bytes.slice();
  copy[index] = ((copy[index] ?? 0) ^ 0x01) & 0xff;
  return copy;
}
