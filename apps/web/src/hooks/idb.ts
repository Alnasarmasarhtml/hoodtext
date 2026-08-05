/**
 * Minimal typed IndexedDB layer.
 *
 * Key material never touches `localStorage` (SPEC §7.3): private keys are
 * structured-cloned `Uint8Array`s in IndexedDB, keyed by wallet address and
 * wiped on disconnect. `localStorage` is a string store that is trivially
 * readable by any script on the origin and survives in browser backups; a
 * structured-clone store is the right primitive for raw secrets.
 *
 * No dependency: the `idb` package is not installed and this is ~150 lines.
 */

const DB_NAME = 'telehood';
/** v2 added the room stores (`rooms`, `roomKeys`). */
const DB_VERSION = 2;

export const STORE_IDENTITY = 'identity';
export const STORE_MESSAGES = 'messages';
export const STORE_PEERS = 'peers';
export const STORE_META = 'meta';
export const STORE_ROOMS = 'rooms';
/**
 * Group keys, one record per `groupId + epoch`. Old epochs are kept on
 * purpose: backfilled drops sealed before a rotation still need their key.
 */
export const STORE_ROOM_KEYS = 'roomKeys';

/** Index present on `messages` and `peers`, over the lower-cased owner. */
export const INDEX_BY_OWNER = 'by-owner';

/** Thrown when the browser has no usable IndexedDB (private mode, old WebView). */
export class StorageUnavailableError extends Error {
  constructor() {
    super(
      'This browser has no usable IndexedDB, so TeleHood cannot cache your identity key. ' +
        'Messaging still works, but you will be asked to sign again on every visit.',
    );
    this.name = 'StorageUnavailableError';
  }
}

export function hasIndexedDb(): boolean {
  return typeof globalThis.indexedDB !== 'undefined';
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (!hasIndexedDb()) {
      reject(new StorageUnavailableError());
      return;
    }

    const request = globalThis.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (): void => {
      const db = request.result;

      if (!db.objectStoreNames.contains(STORE_IDENTITY)) {
        db.createObjectStore(STORE_IDENTITY, { keyPath: 'address' });
      }
      if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
        const messages = db.createObjectStore(STORE_MESSAGES, { keyPath: 'id' });
        messages.createIndex(INDEX_BY_OWNER, 'owner', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_PEERS)) {
        const peers = db.createObjectStore(STORE_PEERS, { keyPath: 'id' });
        peers.createIndex(INDEX_BY_OWNER, 'owner', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE_ROOMS)) {
        const rooms = db.createObjectStore(STORE_ROOMS, { keyPath: 'id' });
        rooms.createIndex(INDEX_BY_OWNER, 'owner', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_ROOM_KEYS)) {
        const roomKeys = db.createObjectStore(STORE_ROOM_KEYS, { keyPath: 'id' });
        roomKeys.createIndex(INDEX_BY_OWNER, 'owner', { unique: false });
      }
    };

    request.onsuccess = (): void => {
      const db = request.result;
      // Another tab upgraded the schema: close so it is not blocked.
      db.onversionchange = (): void => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };

    request.onerror = (): void => {
      reject(request.error ?? new StorageUnavailableError());
    };

    request.onblocked = (): void => {
      reject(new Error('Another TeleHood tab is holding an older database version open.'));
    };
  });
}

function database(): Promise<IDBDatabase> {
  dbPromise ??= openDatabase().catch((error: unknown) => {
    dbPromise = null;
    throw error;
  });
  return dbPromise;
}

/** Resolves with the raw request result, typed as `unknown` — never `any`. */
function resultOf(request: IDBRequest): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    request.onsuccess = (): void => {
      const raw: unknown = request.result;
      resolve(raw);
    };
    request.onerror = (): void => {
      reject(request.error ?? new Error('IndexedDB request failed'));
    };
  });
}

function completionOf(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = (): void => resolve();
    tx.onabort = (): void => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    tx.onerror = (): void => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  });
}

/** Reads one record. Returns `null` when the key is absent. */
export async function idbGet(store: string, key: IDBValidKey): Promise<unknown> {
  const db = await database();
  const tx = db.transaction(store, 'readonly');
  const value = await resultOf(tx.objectStore(store).get(key));
  return value === undefined ? null : value;
}

/** Writes one record; the store's `keyPath` supplies the key. */
export async function idbPut(store: string, value: unknown): Promise<void> {
  const db = await database();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  await completionOf(tx);
}

/** Writes many records in a single transaction. */
export async function idbPutMany(store: string, values: readonly unknown[]): Promise<void> {
  if (values.length === 0) return;
  const db = await database();
  const tx = db.transaction(store, 'readwrite');
  const objectStore = tx.objectStore(store);
  for (const value of values) objectStore.put(value);
  await completionOf(tx);
}

export async function idbDelete(store: string, key: IDBValidKey): Promise<void> {
  const db = await database();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  await completionOf(tx);
}

/** All records whose `INDEX_BY_OWNER` value equals `owner`. */
export async function idbGetAllByOwner(store: string, owner: string): Promise<unknown[]> {
  const db = await database();
  const tx = db.transaction(store, 'readonly');
  const index = tx.objectStore(store).index(INDEX_BY_OWNER);
  const raw = await resultOf(index.getAll(owner));
  return Array.isArray(raw) ? (raw as unknown[]) : [];
}

/** Deletes every record in `store` owned by `owner`. */
export async function idbDeleteByOwner(store: string, owner: string): Promise<void> {
  const db = await database();
  const tx = db.transaction(store, 'readwrite');
  const objectStore = tx.objectStore(store);
  const index = objectStore.index(INDEX_BY_OWNER);
  const keys = await resultOf(index.getAllKeys(owner));
  if (Array.isArray(keys)) {
    for (const key of keys as IDBValidKey[]) objectStore.delete(key);
  }
  await completionOf(tx);
}

/** Empties a store completely. Used when wiping every cached identity. */
export async function idbClear(store: string): Promise<void> {
  const db = await database();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).clear();
  await completionOf(tx);
}
