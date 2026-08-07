/**
 * Device-local cache for derived identity keys.
 *
 * The keys are re-derivable at any time from one wallet signature
 * (`deriveIdentity` is deterministic), so this cache is a convenience, never a
 * source of truth. It exists purely so a returning user is not asked to sign on
 * every page load.
 *
 * Rules, from SPEC §7.3:
 *   · IndexedDB only — never `localStorage`, for any part of the key material.
 *   · Keyed by wallet address, so two accounts on one device never collide.
 *   · Wiped on disconnect.
 */
import type { IdentityKeys } from '@hoodgram/crypto';
import type { Address } from 'viem';

import {
  STORE_IDENTITY,
  StorageUnavailableError,
  hasIndexedDb,
  idbClear,
  idbDelete,
  idbGet,
  idbPut,
} from './idb';

const KEY_BYTES = 32;
const SECRET_KEY_BYTES = 32;
const SIGN_SECRET_KEY_BYTES = 64;

interface StoredIdentity {
  readonly address: string;
  readonly x25519Pub: Uint8Array;
  readonly x25519Priv: Uint8Array;
  readonly ed25519Pub: Uint8Array;
  readonly ed25519Priv: Uint8Array;
  readonly createdAt: number;
}

/** Lower-cased address — the object-store key. */
export function identityKeyFor(address: Address): string {
  return address.toLowerCase();
}

function isBytes(value: unknown, length: number): value is Uint8Array {
  return value instanceof Uint8Array && value.length === length;
}

function toIdentityKeys(raw: unknown): IdentityKeys | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;

  const x25519Pub = record['x25519Pub'];
  const x25519Priv = record['x25519Priv'];
  const ed25519Pub = record['ed25519Pub'];
  const ed25519Priv = record['ed25519Priv'];

  if (
    !isBytes(x25519Pub, KEY_BYTES) ||
    !isBytes(x25519Priv, SECRET_KEY_BYTES) ||
    !isBytes(ed25519Pub, KEY_BYTES) ||
    !isBytes(ed25519Priv, SIGN_SECRET_KEY_BYTES)
  ) {
    return null;
  }

  return {
    x25519: { publicKey: x25519Pub, privateKey: x25519Priv },
    ed25519: { publicKey: ed25519Pub, privateKey: ed25519Priv },
  };
}

/**
 * Cached keys for `address`, or `null` when this device has none.
 *
 * A storage failure is not fatal — it degrades to "sign again", so it resolves
 * `null` rather than throwing.
 */
export async function loadIdentity(address: Address): Promise<IdentityKeys | null> {
  if (!hasIndexedDb()) return null;
  try {
    const raw = await idbGet(STORE_IDENTITY, identityKeyFor(address));
    return raw === null ? null : toIdentityKeys(raw);
  } catch {
    return null;
  }
}

/**
 * Caches `keys` for `address`.
 *
 * @throws {StorageUnavailableError} when the browser has no IndexedDB, so the
 *   caller can tell the user they will be asked to sign again next visit.
 */
export async function saveIdentity(address: Address, keys: IdentityKeys): Promise<void> {
  if (!hasIndexedDb()) throw new StorageUnavailableError();

  const record: StoredIdentity = {
    address: identityKeyFor(address),
    x25519Pub: Uint8Array.from(keys.x25519.publicKey),
    x25519Priv: Uint8Array.from(keys.x25519.privateKey),
    ed25519Pub: Uint8Array.from(keys.ed25519.publicKey),
    ed25519Priv: Uint8Array.from(keys.ed25519.privateKey),
    createdAt: Math.floor(Date.now() / 1000),
  };
  await idbPut(STORE_IDENTITY, record);
}

/** Removes the cached keys for one address. Never throws. */
export async function wipeIdentity(address: Address): Promise<void> {
  if (!hasIndexedDb()) return;
  try {
    await idbDelete(STORE_IDENTITY, identityKeyFor(address));
  } catch {
    /* A failed wipe must not break disconnect; the keys stay re-derivable. */
  }
}

/** Removes every cached identity on this device. Never throws. */
export async function wipeAllIdentities(): Promise<void> {
  if (!hasIndexedDb()) return;
  try {
    await idbClear(STORE_IDENTITY);
  } catch {
    /* see wipeIdentity */
  }
}
