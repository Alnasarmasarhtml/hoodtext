/**
 * Cover for the operational footgun: `RELAY_TRUST_PROXY` defaults to 0, which is
 * the only safe posture for a directly-exposed relay — trusting `X-Forwarded-For`
 * blindly lets one header mint a fresh rate-limit bucket per request.
 *
 * But deployed behind Fly / Render / Cloudflare / nginx, `request.ip` becomes the
 * proxy's single address and *every* per-IP ceiling silently becomes a ceiling
 * for the entire user base combined: `WS /v1/stream` at 30/min means the 31st
 * user of any minute cannot open a socket at all. Nothing about that failure
 * looks like a misconfiguration from the outside — it looks like the relay is
 * broken.
 *
 * So the misconfiguration has to announce itself: a warning the first time an
 * `X-Forwarded-For` header is actually observed with 0 trusted hops, and a
 * standing `proxy` block in `/v1/health` an operator can read at any time.
 */

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';

interface ProxyHealth {
  proxy: { trustedProxyHops: number; forwardedHeaderSeen: boolean };
}

/** Collects the relay's log lines so a test can assert on what it warned about. */
class LogSink {
  readonly lines: string[] = [];

  write(line: string): void {
    this.lines.push(line);
  }

  /** Parsed records at pino's `warn` level (40) or above. */
  warnings(): Array<{ level: number; msg: string }> {
    return this.lines
      .map((line) => JSON.parse(line) as { level: number; msg: string })
      .filter((record) => record.level >= 40);
  }

  matching(needle: string): Array<{ level: number; msg: string }> {
    return this.warnings().filter((record) => record.msg.includes(needle));
  }
}

const FORWARDED = { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' } as const;
const NEEDLE = 'RELAY_TRUST_PROXY=0';

async function appWith(
  sink: LogSink,
  trustProxyHops: number,
): Promise<FastifyInstance> {
  return buildServer({
    env: {},
    config: { dbPath: ':memory:', indexerEnabled: false, logLevel: 'silent', trustProxyHops },
    logDestination: sink,
  });
}

describe('reverse-proxy misconfiguration announces itself', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it('warns the first time an X-Forwarded-For arrives with 0 trusted hops', async () => {
    const sink = new LogSink();
    app = await appWith(sink, 0);

    expect(sink.matching(NEEDLE)).toHaveLength(0);

    await app.inject({ method: 'GET', url: '/v1/health', headers: FORWARDED });

    const warnings = sink.matching(NEEDLE);
    expect(warnings).toHaveLength(1);
    // The message has to name the consequence, not just the header, or an
    // operator reads it as noise and leaves every limit global.
    expect(warnings[0]?.msg).toContain('ALL');
    expect(warnings[0]?.msg).toContain('per-IP rate limit');
  });

  it('warns once, not once per request', async () => {
    const sink = new LogSink();
    app = await appWith(sink, 0);

    for (let i = 0; i < 5; i += 1) {
      await app.inject({ method: 'GET', url: '/v1/health', headers: FORWARDED });
    }

    expect(sink.matching(NEEDLE)).toHaveLength(1);
  });

  it('stays quiet when no proxy header is ever seen', async () => {
    const sink = new LogSink();
    app = await appWith(sink, 0);

    await app.inject({ method: 'GET', url: '/v1/health' });
    await app.inject({ method: 'GET', url: '/v1/stats' });

    expect(sink.matching(NEEDLE)).toHaveLength(0);
  });

  it('stays quiet when the operator has configured the hop count', async () => {
    const sink = new LogSink();
    app = await appWith(sink, 1);

    await app.inject({ method: 'GET', url: '/v1/health', headers: FORWARDED });

    expect(sink.matching(NEEDLE)).toHaveLength(0);
  });
});

describe('GET /v1/health reports the proxy posture', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it('flips forwardedHeaderSeen once a proxied request arrives', async () => {
    app = await buildServer({
      env: {},
      config: { dbPath: ':memory:', indexerEnabled: false, logLevel: 'silent', trustProxyHops: 0 },
    });

    const before = (await app.inject({ method: 'GET', url: '/v1/health' })).json<ProxyHealth>();
    expect(before.proxy).toEqual({ trustedProxyHops: 0, forwardedHeaderSeen: false });

    await app.inject({ method: 'GET', url: '/v1/stats', headers: FORWARDED });

    // trustedProxyHops 0 + forwardedHeaderSeen true is the misconfiguration,
    // readable by an operator or an uptime check without grepping logs.
    const after = (await app.inject({ method: 'GET', url: '/v1/health' })).json<ProxyHealth>();
    expect(after.proxy).toEqual({ trustedProxyHops: 0, forwardedHeaderSeen: true });
  });

  it('reports the configured hop count when the relay is set up correctly', async () => {
    app = await buildServer({
      env: {},
      config: { dbPath: ':memory:', indexerEnabled: false, logLevel: 'silent', trustProxyHops: 2 },
    });

    await app.inject({ method: 'GET', url: '/v1/stats', headers: FORWARDED });

    const body = (await app.inject({ method: 'GET', url: '/v1/health' })).json<ProxyHealth>();
    expect(body.proxy).toEqual({ trustedProxyHops: 2, forwardedHeaderSeen: true });
  });
});

describe('RELAY_TRUST_PROXY is documented where an operator will find it', () => {
  it('is present in .env.example with the global-limit warning', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { resolve, dirname } = await import('node:path');

    // `<repo>/apps/relay/src/__tests__/` -> `<repo>/.env.example`
    const here = dirname(fileURLToPath(import.meta.url));
    const example = await readFile(resolve(here, '../../../../.env.example'), 'utf8');

    expect(example).toContain('RELAY_TRUST_PROXY=0');
    // The undocumented knob was the whole defect: the value alone is not enough,
    // the consequence of leaving it at 0 behind a proxy has to be spelled out.
    expect(example).toMatch(/GLOBAL limit/);
    expect(example).toMatch(/X-Forwarded-For/);
    expect(example).toMatch(/\/v1\/stream/);
  });
});
