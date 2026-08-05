/**
 * Drop signatures for the gasless relay path.
 *
 * When the relay posts anchors on a sender's behalf ({@link https://— Anchors.postBatch}),
 * the chain no longer proves who authored the drop — so the sender proves it to the relay
 * instead, with a detached Ed25519 signature over the drop's exact on-chain fields. The
 * relay verifies the signature against the sender's registered Ed25519 key and their
 * activation before batching. Senders never sign wallet transactions per message and their
 * wallet address never appears on chain.
 */
import { bytesToHex, hexToBytes, utf8Encode } from './bytes';
import { ready } from './sodium';

/** Domain-separation prefix, so a drop signature can never be replayed as anything else. */
export const DROP_SIGNING_CONTEXT = 'telehood.drop.v1';

/** Detached Ed25519 signature size, in bytes. */
export const DROP_SIGNATURE_BYTES = 64;

/** The on-chain fields of a drop, exactly as they will be anchored. */
export interface SignableDrop {
  convoId: `0x${string}`;
  ephPub: `0x${string}`;
  blobRef: `0x${string}`;
  viewTag: number;
  size: number;
}

/**
 * Canonical byte encoding of a drop for signing:
 * `utf8(context) || convoId(32) || ephPub(32) || blobRef(32) || viewTag(1) || size(4 LE)`.
 *
 * @throws {Error} when any field is malformed.
 */
export function encodeDropForSigning(drop: SignableDrop): Uint8Array {
  const convoId = hexToBytes(drop.convoId, 'convoId');
  const ephPub = hexToBytes(drop.ephPub, 'ephPub');
  const blobRef = hexToBytes(drop.blobRef, 'blobRef');
  if (convoId.length !== 32 || ephPub.length !== 32 || blobRef.length !== 32) {
    throw new Error('convoId, ephPub and blobRef must each be 32 bytes');
  }
  if (!Number.isInteger(drop.viewTag) || drop.viewTag < 0 || drop.viewTag > 255) {
    throw new Error('viewTag must be an integer in 0..255');
  }
  if (!Number.isInteger(drop.size) || drop.size < 0 || drop.size > 0xffffffff) {
    throw new Error('size must be a uint32');
  }

  const context = utf8Encode(DROP_SIGNING_CONTEXT);
  const message = new Uint8Array(context.length + 32 + 32 + 32 + 1 + 4);
  let offset = 0;
  message.set(context, offset);
  offset += context.length;
  message.set(convoId, offset);
  offset += 32;
  message.set(ephPub, offset);
  offset += 32;
  message.set(blobRef, offset);
  offset += 32;
  message[offset] = drop.viewTag;
  offset += 1;
  message[offset] = drop.size & 0xff;
  message[offset + 1] = (drop.size >>> 8) & 0xff;
  message[offset + 2] = (drop.size >>> 16) & 0xff;
  message[offset + 3] = (drop.size >>> 24) & 0xff;
  return message;
}

/**
 * Signs a drop with the sender's Ed25519 identity key.
 *
 * @returns the `0x`-prefixed 64-byte detached signature.
 * @throws {Error} when the drop or the key is malformed.
 */
export async function signDrop(
  drop: SignableDrop,
  ed25519Priv: Uint8Array,
): Promise<`0x${string}`> {
  const message = encodeDropForSigning(drop);
  const sodium = await ready();
  const signature = sodium.crypto_sign_detached(message, ed25519Priv);
  return bytesToHex(signature);
}

/**
 * Verifies a drop signature against a sender's registered Ed25519 public key.
 *
 * Returns `false` — never throws — for any malformed input: drops and signatures reaching a
 * relay are attacker-controlled.
 */
export async function verifyDrop(
  drop: SignableDrop,
  signature: `0x${string}`,
  ed25519Pub: Uint8Array,
): Promise<boolean> {
  try {
    const message = encodeDropForSigning(drop);
    const signatureBytes = hexToBytes(signature, 'signature');
    if (signatureBytes.length !== DROP_SIGNATURE_BYTES) {
      return false;
    }
    if (!(ed25519Pub instanceof Uint8Array) || ed25519Pub.length !== 32) {
      return false;
    }
    const sodium = await ready();
    return sodium.crypto_sign_verify_detached(signatureBytes, message, ed25519Pub);
  } catch {
    return false;
  }
}
