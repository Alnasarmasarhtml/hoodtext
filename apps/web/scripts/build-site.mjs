#!/usr/bin/env node
/**
 * Build the static export that gets published to hoodgram.tech.
 *
 * The reason this exists rather than a plain `NEXT_EXPORT=1 next build`:
 * Next loads `.env.local` in every environment except test, and it OUTRANKS
 * `.env.production`. `.env.local` in this app holds the development config —
 * anvil 31337 and a loopback relay — so a plain build compiles those values
 * into the public bundle. The site was live for a day reading
 * "Anvil · 31337" in the header chip and "http://localhost:8787" in the footer
 * before anyone noticed, because nothing in the build says otherwise.
 *
 * Real process environment beats every .env file, so reading `.env.site` here
 * and passing it through `spawn` makes the dev config unable to win.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const envPath = join(appDir, '.env.site');

/**
 * Minimal `KEY=value` reader: comments, blanks and surrounding quotes only.
 * Deliberately not a dotenv dependency — this file must not be able to fail in
 * a way that silently produces a build with the wrong chain in it.
 */
function readEnvFile(path) {
  const out = {};
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const siteEnv = readEnvFile(envPath);

const chainId = siteEnv.NEXT_PUBLIC_CHAIN_ID;
if (chainId === undefined || chainId === '') {
  console.error('.env.site sets no NEXT_PUBLIC_CHAIN_ID — refusing to build.');
  process.exit(1);
}
/* An empty relay is a deliberate state; anvil in a public build never is. */
if (chainId === '31337') {
  console.error('.env.site points at anvil (31337) — refusing to build the public site.');
  process.exit(1);
}

console.log(`Building the public site: chain ${chainId}, RPC ${siteEnv.NEXT_PUBLIC_RPC_URL}`);
console.log(`Relay: ${siteEnv.NEXT_PUBLIC_RELAY_URL || '(none — footer shows "not public yet")'}`);

const result = spawnSync('pnpm', ['exec', 'next', 'build'], {
  cwd: appDir,
  stdio: 'inherit',
  env: { ...process.env, ...siteEnv, NEXT_EXPORT: '1', NODE_ENV: 'production' },
});

process.exit(result.status ?? 1);
