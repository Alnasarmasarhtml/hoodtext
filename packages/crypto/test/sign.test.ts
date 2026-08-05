import { describe, expect, it } from 'vitest';
import {
  DROP_SIGNING_CONTEXT,
  deriveIdentity,
  encodeDropForSigning,
  signDrop,
  verifyDrop,
} from '../src/index';
import type { SignableDrop } from '../src/index';

const SIG_A: `0x${string}` = `0x${'ab'.repeat(65)}`;

function drop(overrides: Partial<SignableDrop> = {}): SignableDrop {
  return {
    convoId: `0x${'11'.repeat(32)}`,
    ephPub: `0x${'22'.repeat(32)}`,
    blobRef: `0x${'33'.repeat(32)}`,
    viewTag: 200,
    size: 1024,
    ...overrides,
  };
}

async function keys(seedHex = 'aa') {
  return deriveIdentity(`0x${seedHex.repeat(65)}`);
}

describe('encodeDropForSigning', () => {
  it('is deterministic and domain-separated', () => {
    const a = encodeDropForSigning(drop());
    const b = encodeDropForSigning(drop());
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(Buffer.from(a.slice(0, DROP_SIGNING_CONTEXT.length)).toString('utf8')).toBe(
      DROP_SIGNING_CONTEXT,
    );
    expect(a.length).toBe(DROP_SIGNING_CONTEXT.length + 32 + 32 + 32 + 1 + 4);
  });

  it('changes when any field changes', () => {
    const base = Buffer.from(encodeDropForSigning(drop()));
    expect(base.equals(Buffer.from(encodeDropForSigning(drop({ viewTag: 201 }))))).toBe(false);
    expect(base.equals(Buffer.from(encodeDropForSigning(drop({ size: 4096 }))))).toBe(false);
    expect(
      base.equals(Buffer.from(encodeDropForSigning(drop({ convoId: `0x${'44'.repeat(32)}` })))),
    ).toBe(false);
  });

  it('rejects malformed fields', () => {
    expect(() => encodeDropForSigning(drop({ convoId: '0x1234' }))).toThrow();
    expect(() => encodeDropForSigning(drop({ viewTag: 256 }))).toThrow();
    expect(() => encodeDropForSigning(drop({ viewTag: -1 }))).toThrow();
    expect(() => encodeDropForSigning(drop({ size: -1 }))).toThrow();
    expect(() => encodeDropForSigning(drop({ size: 1.5 }))).toThrow();
  });
});

describe('signDrop / verifyDrop', () => {
  it('round-trips with the derived identity keys', async () => {
    const identity = await keys();
    const signature = await signDrop(drop(), identity.ed25519.privateKey);

    expect(signature).toMatch(/^0x[0-9a-f]{128}$/);
    expect(await verifyDrop(drop(), signature, identity.ed25519.publicKey)).toBe(true);
  });

  it('rejects a signature from a different key', async () => {
    const alice = await keys('aa');
    const bob = await keys('bb');
    const signature = await signDrop(drop(), alice.ed25519.privateKey);

    expect(await verifyDrop(drop(), signature, bob.ed25519.publicKey)).toBe(false);
  });

  it('rejects when any signed field was altered afterwards', async () => {
    const identity = await keys();
    const signature = await signDrop(drop(), identity.ed25519.privateKey);

    expect(await verifyDrop(drop({ viewTag: 0 }), signature, identity.ed25519.publicKey)).toBe(false);
    expect(await verifyDrop(drop({ size: 256 }), signature, identity.ed25519.publicKey)).toBe(false);
    expect(
      await verifyDrop(drop({ blobRef: `0x${'55'.repeat(32)}` }), signature, identity.ed25519.publicKey),
    ).toBe(false);
  });

  it('returns false, never throws, for garbage input', async () => {
    const identity = await keys();

    expect(await verifyDrop(drop(), '0xnothex' as `0x${string}`, identity.ed25519.publicKey)).toBe(false);
    expect(await verifyDrop(drop(), SIG_A, identity.ed25519.publicKey)).toBe(false); // 65 bytes
    expect(await verifyDrop(drop(), `0x${'00'.repeat(64)}`, identity.ed25519.publicKey)).toBe(false);
    expect(
      await verifyDrop(drop(), await signDrop(drop(), identity.ed25519.privateKey), new Uint8Array(31)),
    ).toBe(false);
    expect(
      await verifyDrop(
        drop({ convoId: 'garbage' as `0x${string}` }),
        SIG_A,
        identity.ed25519.publicKey,
      ),
    ).toBe(false);
  });

  it('signatures are stable for the same drop and key', async () => {
    const identity = await keys();
    const one = await signDrop(drop(), identity.ed25519.privateKey);
    const two = await signDrop(drop(), identity.ed25519.privateKey);
    expect(one).toBe(two); // Ed25519 is deterministic
  });
});
