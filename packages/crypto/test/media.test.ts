import { describe, expect, it } from 'vitest';
import { MAX_MEDIA_BYTES, MEDIA_BUCKETS, openMedia, sealMedia } from '../src/index';

function bytes(length: number, fill = 7): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

describe('sealMedia / openMedia', () => {
  it('round-trips exactly', async () => {
    const data = crypto.getRandomValues(new Uint8Array(10_000));
    const sealed = await sealMedia(data);

    const opened = await openMedia(sealed.blob, sealed.key);
    expect(opened).not.toBeNull();
    expect(Buffer.from(opened ?? new Uint8Array()).equals(Buffer.from(data))).toBe(true);
  });

  it('pads to the smallest fitting bucket so exact sizes are hidden', async () => {
    const small = await sealMedia(bytes(1_000));
    const alsoSmall = await sealMedia(bytes(60_000));
    expect(small.blob.length).toBe(alsoSmall.blob.length, );

    const bigger = await sealMedia(bytes(70_000));
    expect(bigger.blob.length).toBeGreaterThan(small.blob.length);

    // overhead = version(1) + nonce(24) + mac(16)
    expect(small.blob.length).toBe(MEDIA_BUCKETS[0] + 41);
  });

  it('every seal uses a fresh key', async () => {
    const a = await sealMedia(bytes(10));
    const b = await sealMedia(bytes(10));
    expect(Buffer.from(a.key).equals(Buffer.from(b.key))).toBe(false);
    expect(a.blobRef).not.toBe(b.blobRef);
  });

  it('the wrong key opens nothing', async () => {
    const sealed = await sealMedia(bytes(10));
    const wrongKey = new Uint8Array(32).fill(1);
    expect(await openMedia(sealed.blob, wrongKey)).toBeNull();
  });

  it('tampering is detected', async () => {
    const sealed = await sealMedia(bytes(100));
    const tampered = sealed.blob.slice();
    const lastIndex = tampered.length - 1;
    tampered[lastIndex] = (tampered[lastIndex] ?? 0) ^ 0xff;
    expect(await openMedia(tampered, sealed.key)).toBeNull();
  });

  it('rejects malformed blobs without throwing', async () => {
    const sealed = await sealMedia(bytes(10));

    expect(await openMedia(new Uint8Array(0), sealed.key)).toBeNull();
    expect(await openMedia(new Uint8Array(10), sealed.key)).toBeNull();
    expect(await openMedia(sealed.blob.slice(0, 100), sealed.key)).toBeNull();
    expect(await openMedia(sealed.blob, new Uint8Array(31))).toBeNull();

    const wrongVersion = sealed.blob.slice();
    wrongVersion[0] = 0x03;
    expect(await openMedia(wrongVersion, sealed.key)).toBeNull();
  });

  it('enforces the size ceiling', async () => {
    await expect(sealMedia(bytes(MAX_MEDIA_BYTES + 1))).rejects.toThrow(/too large/);

    const max = await sealMedia(bytes(MAX_MEDIA_BYTES));
    expect(max.blob.length).toBe(MEDIA_BUCKETS[MEDIA_BUCKETS.length - 1]! + 41);
  }, 30_000);
});
