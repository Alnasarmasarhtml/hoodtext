import { describe, expect, it } from 'vitest';
import {
  deriveIdentity,
  encodePlaintextCore,
  seal,
  open,
  signAuthor,
  verifyAuthor,
} from '../src/index';
import { decodePlaintext, encodePlaintext, type Plaintext } from '../src/wire';

/** Deterministic identities for both ends. */
async function testKeys(seed: string) {
  return deriveIdentity(`0x${seed.repeat(130 / seed.length + 1).slice(0, 130)}` as `0x${string}`);
}

const FROM = '0x37bce0d2ce5d89e957bc3b5d751ad1321d2fb2bf' as const;
const SIG_ZERO = `0x${'0'.repeat(128)}` as const;

function pt(overrides: Partial<Plaintext> = {}): Plaintext {
  return { v: 1, t: 1_724_000_000, kind: 'text', body: 'hello', ...overrides };
}

describe('wire from/sig', () => {
  it('round-trips a payload carrying from and sig', () => {
    const encoded = encodePlaintext(pt({ from: FROM, sig: SIG_ZERO }));
    const decoded = decodePlaintext(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded?.from).toBe(FROM);
    expect(decoded?.sig).toBe(SIG_ZERO);
  });

  it('still decodes a legacy payload without from/sig', () => {
    const decoded = decodePlaintext(encodePlaintext(pt()));
    expect(decoded).not.toBeNull();
    expect(decoded?.from).toBeUndefined();
    expect(decoded?.sig).toBeUndefined();
  });

  it('rejects from without sig, and sig without from', () => {
    expect(() => encodePlaintext(pt({ from: FROM }))).toThrow();
    expect(() => encodePlaintext(pt({ sig: SIG_ZERO }))).toThrow();
    const loneFrom = JSON.stringify({ v: 1, t: 1, kind: 'text', body: 'x', from: FROM });
    expect(decodePlaintext(new TextEncoder().encode(loneFrom))).toBeNull();
    const loneSig = JSON.stringify({ v: 1, t: 1, kind: 'text', body: 'x', sig: SIG_ZERO });
    expect(decodePlaintext(new TextEncoder().encode(loneSig))).toBeNull();
  });

  it('rejects malformed from and sig values', () => {
    const bad = JSON.stringify({ v: 1, t: 1, kind: 'text', body: 'x', from: '0x1234', sig: SIG_ZERO });
    expect(decodePlaintext(new TextEncoder().encode(bad))).toBeNull();
    const badSig = JSON.stringify({ v: 1, t: 1, kind: 'text', body: 'x', from: FROM, sig: '0xdead' });
    expect(decodePlaintext(new TextEncoder().encode(badSig))).toBeNull();
  });

  it('lowercases from on decode so attribution keys are stable', () => {
    const upper = FROM.replace('0x', '0x').toUpperCase().replace('0X', '0x') as `0x${string}`;
    const raw = JSON.stringify({ v: 1, t: 1, kind: 'text', body: 'x', from: upper, sig: SIG_ZERO });
    const decoded = decodePlaintext(new TextEncoder().encode(raw));
    expect(decoded?.from).toBe(FROM);
  });

  it('the core encoding excludes sig and is stable under its presence', () => {
    const withSig = pt({ from: FROM, sig: SIG_ZERO });
    const withoutSig = pt({ from: FROM, sig: SIG_ZERO });
    expect(encodePlaintextCore(withSig)).toEqual(encodePlaintextCore(withoutSig));
    const text = new TextDecoder().decode(encodePlaintextCore(withSig));
    expect(text).not.toContain('sig');
    expect(text).toContain('from');
  });
});

describe('author signatures', () => {
  it('signs and verifies bound to the recipient scope', async () => {
    const alice = await testKeys('a1');
    const core = encodePlaintextCore(pt({ from: FROM, sig: SIG_ZERO }));
    const scope = new Uint8Array(32).fill(7);
    const sig = await signAuthor(core, scope, alice.ed25519.privateKey);
    await expect(verifyAuthor(core, scope, sig, alice.ed25519.publicKey)).resolves.toBe(true);
  });

  it('fails on a different scope (no cross-recipient or cross-room replay)', async () => {
    const alice = await testKeys('a1');
    const core = encodePlaintextCore(pt({ from: FROM, sig: SIG_ZERO }));
    const scopeA = new Uint8Array(32).fill(7);
    const scopeB = new Uint8Array(32).fill(8);
    const sig = await signAuthor(core, scopeA, alice.ed25519.privateKey);
    await expect(verifyAuthor(core, scopeB, sig, alice.ed25519.publicKey)).resolves.toBe(false);
  });

  it('fails on a tampered payload and on the wrong key', async () => {
    const alice = await testKeys('a1');
    const mallory = await testKeys('b2');
    const scope = new Uint8Array(32).fill(7);
    const core = encodePlaintextCore(pt({ from: FROM, sig: SIG_ZERO }));
    const sig = await signAuthor(core, scope, alice.ed25519.privateKey);
    const tampered = encodePlaintextCore(pt({ body: 'hello!', from: FROM, sig: SIG_ZERO }));
    await expect(verifyAuthor(tampered, scope, sig, alice.ed25519.publicKey)).resolves.toBe(false);
    await expect(verifyAuthor(core, scope, sig, mallory.ed25519.publicKey)).resolves.toBe(false);
  });

  it('never throws on garbage', async () => {
    const scope = new Uint8Array(32);
    await expect(
      verifyAuthor(new Uint8Array(0), scope, '0xnothex' as `0x${string}`, new Uint8Array(32)),
    ).resolves.toBe(false);
    await expect(
      verifyAuthor(new Uint8Array(3), scope, SIG_ZERO, new Uint8Array(5)),
    ).resolves.toBe(false);
  });

  it('a sealed drop carries the attribution end to end', async () => {
    const alice = await testKeys('a1');
    const bob = await testKeys('b2');
    const core = pt({ from: FROM, sig: SIG_ZERO });
    const coreBytes = encodePlaintextCore(core);
    const sig = await signAuthor(coreBytes, bob.x25519.publicKey, alice.ed25519.privateKey);
    const sealed = await seal({ ...core, sig }, bob.x25519.publicKey);
    const opened = await open(sealed.blob, bob.x25519.privateKey, bob.x25519.publicKey);
    expect(opened).not.toBeNull();
    expect(opened?.from).toBe(FROM);
    const openedCore = encodePlaintextCore(opened as Plaintext);
    await expect(
      verifyAuthor(openedCore, bob.x25519.publicKey, (opened as Plaintext).sig as `0x${string}`, alice.ed25519.publicKey),
    ).resolves.toBe(true);
  });
});
