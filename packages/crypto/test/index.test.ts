import { describe, expect, it } from 'vitest';
import * as pkg from '../src/index';
import type { Deployment, IdentityKeys, Plaintext, SealedDrop } from '../src/index';
import { freshIdentity, textMessage } from './helpers';

// Compile-time assertion that every type in spec §5 is reachable from the barrel.
type SpecTypes = [IdentityKeys, Plaintext, SealedDrop, Deployment];

describe('barrel', () => {
  it('re-exports every value the spec requires', () => {
    const expected = [
      'IDENTITY_DOMAIN',
      'IDENTITY_TYPES',
      'IDENTITY_MESSAGE',
      'deriveIdentity',
      'BUCKETS',
      'seal',
      'open',
      'computeViewTag',
      'scanMatches',
      'convoIdFor',
      'groupIdFor',
      'newGroupKey',
      'wrapGroupKey',
      'unwrapGroupKey',
      'sealToGroup',
      'openFromGroup',
      'memberRoot',
      'DEPLOYMENTS',
      'getDeployment',
    ];
    for (const name of expected) {
      expect(Object.hasOwn(pkg, name), `missing export: ${name}`).toBe(true);
    }
  });

  it('exports the functions as functions', () => {
    const functions = [
      'deriveIdentity',
      'seal',
      'open',
      'computeViewTag',
      'scanMatches',
      'convoIdFor',
      'groupIdFor',
      'newGroupKey',
      'wrapGroupKey',
      'unwrapGroupKey',
      'sealToGroup',
      'openFromGroup',
      'memberRoot',
      'getDeployment',
    ] as const;
    for (const name of functions) {
      expect(typeof pkg[name], name).toBe('function');
    }
  });

  it('does not leak internal helpers into the public surface', () => {
    for (const internal of [
      'ready',
      'padToBucket',
      'unpad',
      'parseBlob',
      'buildBlob',
      'encodePlaintext',
      'decodePlaintext',
      'bytesToHex',
      'hexToBytes',
      'randomBytes',
    ]) {
      expect(Object.hasOwn(pkg, internal), `leaked internal: ${internal}`).toBe(false);
    }
  });

  it('exports exactly the spec §5 surface and nothing extra', () => {
    const spec = [
      'IDENTITY_DOMAIN',
      'IDENTITY_TYPES',
      'IDENTITY_MESSAGE',
      'deriveIdentity',
      'BUCKETS',
      'seal',
      'open',
      'computeViewTag',
      'scanMatches',
      'convoIdFor',
      'groupIdFor',
      'newGroupKey',
      'wrapGroupKey',
      'unwrapGroupKey',
      'sealToGroup',
      'openFromGroup',
      'memberRoot',
      // media attachments
      'MEDIA_BUCKETS',
      'MAX_MEDIA_BYTES',
      'MEDIA_BLOB_VERSION',
      'sealMedia',
      'openMedia',
      // relay drop signatures
      'DROP_SIGNING_CONTEXT',
      'DROP_SIGNATURE_BYTES',
      'encodeDropForSigning',
      'signDrop',
      'verifyDrop',
      // in-payload author attribution
      'AUTHOR_SIGNING_CONTEXT',
      'AUTHOR_SIGNATURE_BYTES',
      'encodeAuthorTranscript',
      'signAuthor',
      'verifyAuthor',
      'encodePlaintextCore',
      'DEPLOYMENTS',
      'getDeployment',
    ];
    const actual = Object.keys(pkg).filter((name) => name !== 'default');
    expect(actual.sort()).toEqual(spec.sort());
  });

  it('satisfies the compile-time type surface', () => {
    const witness: SpecTypes[1] = { v: 1, t: 0, kind: 'text', body: '' };
    expect(witness.kind).toBe('text');
  });
});

describe('end-to-end', () => {
  it('carries a 1:1 message from sender to recipient via the public API only', async () => {
    const alice = await freshIdentity();
    const bob = await freshIdentity();

    const convoId = pkg.convoIdFor(alice.x25519.publicKey, bob.x25519.publicKey);
    expect(convoId).toBe(pkg.convoIdFor(bob.x25519.publicKey, alice.x25519.publicKey));

    const drop = await pkg.seal(textMessage('anchored'), bob.x25519.publicKey);
    const ephPub = drop.blob.slice(1, 33);

    expect(await pkg.scanMatches(ephPub, drop.viewTag, bob.x25519.privateKey)).toBe(true);
    const opened = await pkg.open(drop.blob, bob.x25519.privateKey, bob.x25519.publicKey);
    expect(opened?.body).toBe('anchored');
  });

  it('carries a group message through wrap, seal, unwrap and open', async () => {
    const admin = await freshIdentity();
    const guest = await freshIdentity();
    const stranger = await freshIdentity();

    const groupId = pkg.groupIdFor(
      'signals desk',
      '0x1234567890abcdef1234567890abcdef12345678',
      `0x${'11'.repeat(32)}`,
    );
    expect(groupId).toMatch(/^0x[0-9a-f]{64}$/);

    const epochKey = pkg.newGroupKey();
    const forGuest = await pkg.wrapGroupKey(epochKey, guest.x25519.publicKey);
    const guestKey = await pkg.unwrapGroupKey(
      forGuest,
      guest.x25519.privateKey,
      guest.x25519.publicKey,
    );
    expect(guestKey).not.toBeNull();

    const drop = await pkg.sealToGroup(textMessage('group up'), epochKey);
    expect(await pkg.openFromGroup(drop.blob, guestKey ?? new Uint8Array(32))).toEqual(
      textMessage('group up'),
    );
    expect(
      await pkg.unwrapGroupKey(forGuest, stranger.x25519.privateKey, stranger.x25519.publicKey),
    ).toBeNull();

    const root = pkg.memberRoot([
      '0x1234567890abcdef1234567890abcdef12345678',
      '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    ]);
    expect(root).toMatch(/^0x[0-9a-f]{64}$/);
    expect(admin.x25519.publicKey).toHaveLength(32);
  });

  it('does not confuse the two envelope formats', async () => {
    const bob = await freshIdentity();
    const groupKey = pkg.newGroupKey();

    const direct = await pkg.seal(textMessage('one to one'), bob.x25519.publicKey);
    const grouped = await pkg.sealToGroup(textMessage('to the group'), groupKey);

    expect(await pkg.openFromGroup(direct.blob, groupKey)).toBeNull();
    expect(await pkg.open(grouped.blob, bob.x25519.privateKey, bob.x25519.publicKey)).toBeNull();

    // Both formats hide length identically, so an observer cannot tell them apart by size.
    expect(direct.blob.length).toBe(grouped.blob.length);
  });

  it('keeps reading working for a lapsed subscriber', async () => {
    // Expiry is an on-chain posting gate; nothing in this package depends on it, so a user
    // with keys can always still decrypt what they already received.
    const bob = await freshIdentity();
    const drop = await pkg.seal(textMessage('received before expiry'), bob.x25519.publicKey);
    const opened = await pkg.open(drop.blob, bob.x25519.privateKey, bob.x25519.publicKey);
    expect(opened?.body).toBe('received before expiry');
  });
});
