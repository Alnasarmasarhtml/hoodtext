import { createRequire } from 'node:module';

/**
 * `libsodium-wrappers-sumo@0.7.16` ships a BROKEN ESM bundle: `dist/modules-sumo-esm/` contains only
 * `libsodium-wrappers.mjs`, which does `import './libsodium-sumo.mjs'` — a sibling that was never
 * published. Node dodges this at runtime (packages/crypto/src/sodium.ts falls back to `createRequire`),
 * but webpack resolves the ESM entry statically and fails the build.
 *
 * The CJS build is intact and browser-safe (the WASM is embedded), so we resolve it from the package
 * that actually declares the dependency and alias the bare specifier to it. Revisit when upstream
 * publishes the missing file.
 */
const LIBSODIUM_CJS = createRequire(
  new URL('../../packages/crypto/src/sodium.ts', import.meta.url),
).resolve('libsodium-wrappers-sumo');

/**
 * TeleHood — Next.js 15 (App Router).
 *
 * The App Router is the only router in this app: routing lives in `src/app`.
 * `@telehood/crypto` is a source-only workspace package (its `main` points at
 * TypeScript), so it must be transpiled by Next rather than consumed as a
 * pre-built dependency.
 *
 * @type {import('next').NextConfig}
 */
/**
 * Static-export mode, used for the GitHub Pages build (`NEXT_EXPORT=1`).
 *
 * Pages serves a project site from a sub-path, so the bundle needs `basePath`/`assetPrefix` baked
 * in at build time. `headers()` is a server feature and is dropped in this mode — the same policies
 * are set as <meta> tags in the document head instead.
 */
const EXPORTING = process.env.NEXT_EXPORT === '1';
const BASE_PATH = process.env.NEXT_BASE_PATH ?? '';

const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@telehood/crypto'],
  poweredByHeader: false,
  ...(EXPORTING
    ? {
        output: 'export',
        basePath: BASE_PATH,
        assetPrefix: BASE_PATH === '' ? undefined : `${BASE_PATH}/`,
        images: { unoptimized: true },
        trailingSlash: true,
      }
    : {}),

  eslint: {
    // Type errors must fail the build; lint runs as its own step.
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: false,
  },

  experimental: {
    optimizePackageImports: ['viem', 'wagmi', '@tanstack/react-query'],
  },

  /**
   * `wagmi/connectors` is a barrel: importing `injected` from it also drags in every other
   * connector, including Coinbase's, which reaches `@coinbase/cdp-sdk` and from there the `@x402/*`
   * payment packages. Those are OPTIONAL peers of the CDP SDK — they are not installed, and
   * TeleHood never touches the x402 payment path (we configure `injected()` only, see
   * src/providers/config.ts).
   *
   * Aliasing them to `false` resolves them to an empty module so the bundle builds. If a connector
   * that genuinely needs x402 is ever added, remove these aliases and install the real packages —
   * do not leave a stub sitting in the path of live payment code.
   */
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      'libsodium-wrappers-sumo$': LIBSODIUM_CJS,
      '@x402/core/client': false,
      '@x402/evm': false,
      '@x402/evm/exact/client': false,
      '@x402/evm/upto/client': false,
      '@x402/svm/exact/client': false,
    };
    return config;
  },

  ...(EXPORTING ? {} : {
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
          },
        ],
      },
    ];
  },
  }),
};

export default nextConfig;
