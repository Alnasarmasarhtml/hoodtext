import type { Metadata, Viewport } from 'next';
import { GeistMono } from 'geist/font/mono';
import localFont from 'next/font/local';
import type { ReactNode } from 'react';

/**
 * Orbitron — the site face (SIL OFL). One variable file covers 400–900, so the
 * whole weight range costs 12 KB and no network round-trip: `next/font/local`
 * self-hosts it and inlines the `@font-face` with the right `basePath`, which
 * a hand-written rule in `globals.css` would not get right on GitHub Pages.
 */
const orbitron = localFont({
  src: './fonts/Orbitron-Variable.woff2',
  weight: '400 900',
  style: 'normal',
  display: 'swap',
  variable: '--font-orbitron',
  fallback: ['ui-sans-serif', 'system-ui', 'sans-serif'],
});

import { SignalField } from '@/components/site/SignalField';
import { SiteHeader } from '@/components/ui/SiteHeader';
import { asset } from '@/lib/asset';
import { Providers } from '@/providers';
import './globals.css';

/** Where the static export is served from; makes the OG image URL absolute. */
const SITE_URL = 'https://hoodgram.tech/';

/* The rendered platinum HG shield. Three sizes because each is a different
   drawing problem: 32 keeps only the silhouette, 180 is the iOS home screen,
   512 is what everything else scales down from. They go through asset() because
   a relative icon href resolves against the current route — /access/brand/… —
   and 404s on every page but the root. */
const ICON_32 = asset('/brand/mark-hg-32.png');
const ICON_180 = asset('/brand/mark-hg-180.png');
const ICON_512 = asset('/brand/mark-hg-512.png');

/* What a pasted hoodgram.tech link unfurls into, on X and everywhere else.
   Client copy, 2026-08-08 — do not paraphrase it. X truncates its card blurb
   near 200 characters, so the sentence that has to survive alone is first. */
const SHARE_DESCRIPTION =
  'HoodGram is an end-to-end encrypted messenger that lives on the open web and settles on Robinhood Chain. Every message becomes a permanent, verifiable anchor on a public network — proof it was sent, readable by no one but the recipient. There is no store to remove it from and no subscription to cancel. You buy in once.';

/* Relative on purpose: metadataBase makes it absolute for the crawler, and the
   1200×630 is what both X and Open Graph want for a large card. */
const SHARE_IMAGE = 'brand/og-card.jpg';

/**
 * Content Security Policy, delivered as a <meta> tag.
 *
 * `next.config.mjs` declares a header policy through `headers()`, but that is a
 * server feature and is silently dropped by `output: 'export'`, so on the static
 * host nothing was enforcing anything. A meta CSP is the only mechanism a static
 * host gives us, and it is worth having on a page that talks to a wallet.
 *
 * WHAT THIS DOES NOT DO: `frame-ancestors` is ignored by browsers when a policy
 * arrives via <meta> (CSP Level 3 §3.1), and X-Frame-Options cannot be set as a
 * meta tag at all. **There is therefore no clickjacking defence on the static
 * host.** Do not add `frame-ancestors` back here and believe it works — the fix
 * is a host that can set real response headers, at which point the `headers()`
 * block in next.config.mjs becomes live and this tag can go.
 *
 * Relaxations, each load-bearing:
 * - `'unsafe-inline'` script-src: Next inlines its hydration payload and the
 *   no-JS reveal fallback. Nonces would need a server to vary per response.
 * - `'wasm-unsafe-eval'`: libsodium ships its cipher as embedded WASM.
 */
const CSP_ORIGINS: readonly string[] = (() => {
  /* Mirrors the fallbacks in lib/relay.ts and lib/chain.ts. Reading the env
     directly rather than importing those modules keeps viem out of this file;
     the values must stay in step, so any change there belongs here too. */
  const relayFallback = process.env.NODE_ENV === 'production' ? '' : 'http://localhost:8787';
  const relayHttp = process.env.NEXT_PUBLIC_RELAY_URL?.trim() || relayFallback;
  const relayWs =
    process.env.NEXT_PUBLIC_RELAY_WS?.trim() ||
    (relayHttp === '' ? '' : relayHttp.replace(/^http/, 'ws'));
  const rpc = process.env.NEXT_PUBLIC_RPC_URL?.trim() || '';

  const origins = new Set<string>([
    'https://rpc.mainnet.chain.robinhood.com',
    'https://robinhoodchain.blockscout.com',
  ]);

  /* Loopback is allowed only when this build is actually pointed at a local
     chain or relay. A production build that also permits connections to
     127.0.0.1 hands any injected script a free local-port scanner, and the
     public site has no use for it — but `next build && next start` against
     anvil does, so the permission follows the configuration rather than being
     unconditional. */
  const LOOPBACK = /^(https?|wss?):\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i;
  if ([relayHttp, relayWs, rpc].some((url) => LOOPBACK.test(url))) {
    for (const local of [
      'http://127.0.0.1:8545',
      'http://localhost:8545',
      'http://127.0.0.1:8787',
      'http://localhost:8787',
      'ws://127.0.0.1:8787',
      'ws://localhost:8787',
    ]) {
      origins.add(local);
    }
  }
  for (const url of [relayHttp, relayWs, rpc]) {
    if (url === '') continue;
    try {
      origins.add(new URL(url).origin);
    } catch {
      /* a malformed override must not take the whole policy down with it */
    }
  }
  return [...origins];
})();

const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  `connect-src 'self' data: blob: ${CSP_ORIGINS.join(' ')}`,
].join('; ');

/**
 * Only the production bundle carries the policy. `next dev` compiles every
 * module inside `eval()` for React Refresh, which any CSP without
 * `'unsafe-eval'` blocks outright — a blank page and a console full of
 * violations. Granting `'unsafe-eval'` to ship just to keep dev alive would be
 * the wrong trade, so dev simply runs without the tag.
 */
const CSP_ENABLED = process.env.NODE_ENV === 'production';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'HoodGram — pay $5 once, text forever',
    template: '%s — HoodGram',
  },
  description:
    'HoodGram is an end-to-end encrypted messenger with every message anchored on Robinhood Chain. One $5 activation in $GRAM and your account exists forever. Messages are free — relayed with no gas, or self-posted for about a cent. Rooms cost $10/month, paid by whoever runs them; members are free. 50% of every payment goes to $GRAM holders, pro-rata by holdings, with no staking and no lock-up.',
  applicationName: 'HoodGram',
  keywords: [
    'HoodGram',
    'GRAM',
    'Robinhood Chain',
    'encrypted messaging',
    'on-chain messaging',
    'revenue share',
  ],
  authors: [{ name: 'HoodGram' }],
  icons: {
    icon: [
      { url: ICON_32, type: 'image/png', sizes: '32x32' },
      { url: ICON_512, type: 'image/png', sizes: '512x512' },
    ],
    shortcut: [{ url: ICON_32, type: 'image/png' }],
    apple: [{ url: ICON_180, sizes: '180x180' }],
  },
  openGraph: {
    type: 'website',
    siteName: 'HoodGram',
    title: 'HoodGram — pay $5 once, text forever',
    description: SHARE_DESCRIPTION,
    images: [{ url: SHARE_IMAGE, width: 1200, height: 630, alt: 'HoodGram' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'HoodGram — pay $5 once, text forever',
    description: SHARE_DESCRIPTION,
    images: [SHARE_IMAGE],
  },
  robots: {
    index: true,
    follow: true,
  },
};

export const viewport: Viewport = {
  themeColor: '#08090A',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  readonly children: ReactNode;
}): ReactNode {
  return (
    <html lang="en" className={`${orbitron.variable} ${GeistMono.variable}`}>
      <head>
        {CSP_ENABLED && <meta httpEquiv="Content-Security-Policy" content={CSP} />}
        {/* Of the header policies, only CSP and `referrer` survive as meta tags.
            X-Content-Type-Options, X-Frame-Options and Permissions-Policy are
            ignored when delivered this way — see the CSP note above. */}
        <meta name="referrer" content="strict-origin-when-cross-origin" />
      </head>
      <body suppressHydrationWarning>
        {/* Ambient signal field — drifting glows and a whisper of falling hex.
            It sits UNDER the grain so the noise lands on top of the glow and the
            two read as one material rather than two stacked effects. */}
        <SignalField />

        {/* 3% fractal-noise grain, fixed and behind every surface so it never
            lands on fine text. */}
        <div className="grain" aria-hidden="true" />

        <Providers>
          <div className="shell">
            <a className="skip" href="#main">
              Skip to content
            </a>

            <SiteHeader />

            <main id="main" tabIndex={-1}>
              {children}
            </main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
