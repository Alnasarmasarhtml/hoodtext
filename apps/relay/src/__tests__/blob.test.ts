import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_BLOB_BYTES } from '../config.js';
import { BINARY, newApp } from './helpers.js';

interface BlobResponse {
  blobRef: string;
}

function sha256Ref(bytes: Uint8Array): string {
  return `0x${createHash('sha256').update(bytes).digest('hex')}`;
}

describe('blob store', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await newApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('round-trips a blob byte for byte', async () => {
    const payload = randomBytes(4_096);

    const post = await app.inject({
      method: 'POST',
      url: '/v1/blob',
      headers: BINARY,
      payload,
    });
    expect(post.statusCode).toBe(200);

    const { blobRef } = post.json<BlobResponse>();
    const get = await app.inject({ method: 'GET', url: `/v1/blob/${blobRef}` });

    expect(get.statusCode).toBe(200);
    expect(get.headers['content-type']).toBe('application/octet-stream');
    expect(Buffer.compare(get.rawPayload, payload)).toBe(0);
  });

  it('derives the ref from the bytes and ignores anything the client supplies', async () => {
    const payload = Buffer.from('telehood envelope', 'utf8');
    const lie = `0x${'ff'.repeat(32)}`;

    const post = await app.inject({
      method: 'POST',
      url: `/v1/blob?ref=${lie}`,
      headers: { ...BINARY, 'x-blob-ref': lie },
      payload,
    });

    expect(post.statusCode).toBe(200);
    expect(post.json<BlobResponse>().blobRef).toBe(sha256Ref(payload));
    expect(post.json<BlobResponse>().blobRef).not.toBe(lie);
  });

  it('gives different bytes different refs and stores both', async () => {
    const a = Buffer.from('alpha', 'utf8');
    const b = Buffer.from('beta', 'utf8');

    const first = await app.inject({ method: 'POST', url: '/v1/blob', headers: BINARY, payload: a });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/blob',
      headers: BINARY,
      payload: b,
    });

    expect(first.json<BlobResponse>().blobRef).not.toBe(second.json<BlobResponse>().blobRef);
    expect(app.db.countBlobs()).toBe(2);
  });

  it('is an idempotent no-op when the same blob is stored twice', async () => {
    const payload = randomBytes(1_024);

    const first = await app.inject({
      method: 'POST',
      url: '/v1/blob',
      headers: BINARY,
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/blob',
      headers: BINARY,
      payload,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json<BlobResponse>().blobRef).toBe(first.json<BlobResponse>().blobRef);
    expect(app.db.countBlobs()).toBe(1);

    const stored = app.db.getBlob(first.json<BlobResponse>().blobRef);
    expect(stored).not.toBeNull();
    expect(stored?.size).toBe(payload.byteLength);
  });

  it('accepts a blob of exactly 64KB', async () => {
    const payload = randomBytes(MAX_BLOB_BYTES);
    const post = await app.inject({ method: 'POST', url: '/v1/blob', headers: BINARY, payload });

    expect(post.statusCode).toBe(200);
    expect(app.db.countBlobs()).toBe(1);
  });

  it('rejects a blob larger than 64KB', async () => {
    const payload = randomBytes(MAX_BLOB_BYTES + 1);
    const post = await app.inject({ method: 'POST', url: '/v1/blob', headers: BINARY, payload });

    expect(post.statusCode).toBe(413);
    expect(post.json<{ error: string }>().error).toBe('payload_too_large');
    expect(app.db.countBlobs()).toBe(0);
  });

  it('rejects an empty body', async () => {
    const post = await app.inject({
      method: 'POST',
      url: '/v1/blob',
      headers: BINARY,
      payload: Buffer.alloc(0),
    });

    expect(post.statusCode).toBe(400);
    expect(post.json<{ error: string }>().error).toBe('empty_body');
  });

  it('accepts raw bytes under any content type, including none at all', async () => {
    // `fetch(url, { method: 'POST', body: uint8array })` sends no content-type —
    // the web client must not have to fake one.
    const payload = Buffer.from('content-type agnostic', 'utf8');
    const expected = sha256Ref(payload);

    for (const headers of [
      {},
      { 'content-type': 'application/octet-stream' },
      { 'content-type': 'application/json' },
      { 'content-type': 'text/plain' },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/v1/blob', headers, payload });
      expect(res.statusCode, JSON.stringify(headers)).toBe(200);
      expect(res.json<BlobResponse>().blobRef).toBe(expected);
    }
    expect(app.db.countBlobs()).toBe(1);
  });

  it('accepts a ref with or without the 0x prefix', async () => {
    const payload = Buffer.from('prefix agnostic', 'utf8');
    const { blobRef } = (
      await app.inject({ method: 'POST', url: '/v1/blob', headers: BINARY, payload })
    ).json<BlobResponse>();

    const withPrefix = await app.inject({ method: 'GET', url: `/v1/blob/${blobRef}` });
    const without = await app.inject({ method: 'GET', url: `/v1/blob/${blobRef.slice(2)}` });

    expect(withPrefix.statusCode).toBe(200);
    expect(without.statusCode).toBe(200);
    expect(Buffer.compare(without.rawPayload, payload)).toBe(0);
  });

  it('404s an unknown ref and 400s a malformed one', async () => {
    const unknown = await app.inject({ method: 'GET', url: `/v1/blob/0x${'ab'.repeat(32)}` });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json<{ error: string }>().error).toBe('not_found');

    const malformed = await app.inject({ method: 'GET', url: '/v1/blob/not-a-hash' });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json<{ error: string }>().error).toBe('invalid_ref');
  });
});
