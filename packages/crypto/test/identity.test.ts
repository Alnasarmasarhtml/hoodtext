import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  IDENTITY_DOMAIN,
  IDENTITY_MESSAGE,
  IDENTITY_TYPES,
  deriveIdentity,
  open,
  seal,
} from '../src/index';
import { FIXED_SIGNATURE, OTHER_SIGNATURE, textMessage } from './helpers';

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

describe('identity constants', () => {
  it('pins the EIP-712 domain', () => {
    expect(IDENTITY_DOMAIN).toEqual({ name: 'TeleHood', version: '1', chainId: 4663 });
  });

  it('pins the EIP-712 types', () => {
    expect(IDENTITY_TYPES).toEqual({
      Identity: [
        { name: 'purpose', type: 'string' },
        { name: 'version', type: 'uint256' },
      ],
    });
  });

  it('pins the message the user signs', () => {
    expect(IDENTITY_MESSAGE.purpose).toBe(
      'TeleHood identity key derivation. Signing this does not authorize any transaction.',
    );
    expect(IDENTITY_MESSAGE.version).toBe(1n);
  });

  it('states plainly that signing authorizes nothing', () => {
    expect(IDENTITY_MESSAGE.purpose).toContain('does not authorize any transaction');
  });
});

describe('deriveIdentity', () => {
  it('is deterministic across repeated calls', async () => {
    const a = await deriveIdentity(FIXED_SIGNATURE as `0x${string}`);
    const b = await deriveIdentity(FIXED_SIGNATURE as `0x${string}`);
    const c = await deriveIdentity(FIXED_SIGNATURE as `0x${string}`);

    expect(toHex(b.x25519.publicKey)).toBe(toHex(a.x25519.publicKey));
    expect(toHex(b.x25519.privateKey)).toBe(toHex(a.x25519.privateKey));
    expect(toHex(b.ed25519.publicKey)).toBe(toHex(a.ed25519.publicKey));
    expect(toHex(b.ed25519.privateKey)).toBe(toHex(a.ed25519.privateKey));
    expect(toHex(c.x25519.publicKey)).toBe(toHex(a.x25519.publicKey));
  });

  it('matches a pinned key-derivation vector', async () => {
    const keys = await deriveIdentity(FIXED_SIGNATURE as `0x${string}`);
    expect(toHex(keys.x25519.publicKey)).toBe(
      '3c91c53cd45f9f25bae4eccbbc69a18451cb1139b655a39aed91bc87c8f53048',
    );
    expect(toHex(keys.x25519.privateKey)).toBe(
      'cc1281a2246c0863dbf0c8ea4f6f7693dddb1de1e1283fee95a620b79800d42a',
    );
    expect(toHex(keys.ed25519.publicKey)).toBe(
      '90b5694b84170cc304748b9b870789464ea9cfbee2e99222f16d71e48fd69900',
    );
  });

  it('really is blake2b(signature, 64) split into two seeds', async () => {
    // Cross-checked against Node's own BLAKE2b/SHA-512 rather than against libsodium, so a
    // change of derivation scheme cannot pass by being self-consistent.
    const signatureBytes = Buffer.from(FIXED_SIGNATURE.slice(2), 'hex');
    const seed = createHash('blake2b512').update(signatureBytes).digest();
    expect(seed).toHaveLength(64);

    // libsodium's crypto_box_seed_keypair sets sk = sha512(seed)[0..32].
    const expectedX25519Priv = createHash('sha512').update(seed.subarray(0, 32)).digest();
    const keys = await deriveIdentity(FIXED_SIGNATURE as `0x${string}`);
    expect(toHex(keys.x25519.privateKey)).toBe(
      expectedX25519Priv.subarray(0, 32).toString('hex'),
    );

    // libsodium's crypto_sign_seed_keypair puts the seed in the first half of the secret key.
    expect(toHex(keys.ed25519.privateKey).slice(0, 64)).toBe(
      seed.subarray(32, 64).toString('hex'),
    );
  });

  it('derives different keys for different signatures', async () => {
    const a = await deriveIdentity(FIXED_SIGNATURE as `0x${string}`);
    const b = await deriveIdentity(OTHER_SIGNATURE as `0x${string}`);
    expect(toHex(a.x25519.publicKey)).not.toBe(toHex(b.x25519.publicKey));
    expect(toHex(a.ed25519.publicKey)).not.toBe(toHex(b.ed25519.publicKey));
  });

  it('avalanches on a single-bit signature change', async () => {
    const flipped = `${FIXED_SIGNATURE.slice(0, -1)}c` as `0x${string}`;
    const a = await deriveIdentity(FIXED_SIGNATURE as `0x${string}`);
    const b = await deriveIdentity(flipped);
    expect(toHex(a.x25519.publicKey)).not.toBe(toHex(b.x25519.publicKey));
  });

  it('produces keys of the correct sizes', async () => {
    const keys = await deriveIdentity(FIXED_SIGNATURE as `0x${string}`);
    expect(keys.x25519.publicKey).toHaveLength(32);
    expect(keys.x25519.privateKey).toHaveLength(32);
    expect(keys.ed25519.publicKey).toHaveLength(32);
    expect(keys.ed25519.privateKey).toHaveLength(64);
  });

  it('produces an X25519 keypair that actually decrypts', async () => {
    const keys = await deriveIdentity(FIXED_SIGNATURE as `0x${string}`);
    const drop = await seal(textMessage('derived keys work'), keys.x25519.publicKey);
    const opened = await open(drop.blob, keys.x25519.privateKey, keys.x25519.publicKey);
    expect(opened?.body).toBe('derived keys work');
  });

  it('produces X25519 and Ed25519 public keys that differ', async () => {
    const keys = await deriveIdentity(FIXED_SIGNATURE as `0x${string}`);
    expect(toHex(keys.x25519.publicKey)).not.toBe(toHex(keys.ed25519.publicKey));
  });

  it('accepts hex without a 0x prefix', async () => {
    const prefixed = await deriveIdentity(FIXED_SIGNATURE as `0x${string}`);
    const bare = await deriveIdentity(FIXED_SIGNATURE.slice(2) as `0x${string}`);
    expect(toHex(bare.x25519.publicKey)).toBe(toHex(prefixed.x25519.publicKey));
  });

  it('rejects an empty signature', async () => {
    await expect(deriveIdentity('0x')).rejects.toThrow(/must not be empty/);
  });

  it('rejects non-hex input', async () => {
    await expect(deriveIdentity('0xzzzz' as `0x${string}`)).rejects.toThrow(/hex string/);
  });

  it('rejects odd-length hex', async () => {
    await expect(deriveIdentity('0xabc' as `0x${string}`)).rejects.toThrow(/even number/);
  });
});
