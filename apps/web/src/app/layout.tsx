import type { Metadata, Viewport } from 'next';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import type { ReactNode } from 'react';

import { SignalField } from '@/components/site/SignalField';
import { SiteHeader } from '@/components/ui/SiteHeader';
import { Providers } from '@/providers';
import './globals.css';

/* The TeleHood mark on void — a double-notched block with two redacted lines
   knocked out of it. Same geometry as <LogoMark />, inlined so the tab icon
   needs no network request. */
const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' fill='%2308090A'/%3E%3Cpath fill='%2300C805' fill-rule='evenodd' clip-rule='evenodd' d='M3 3H22L29 10V29H10L3 22ZM9 12.6H23V15.8H9ZM9 18.1H17V21.3H9Z'/%3E%3C/svg%3E";

export const metadata: Metadata = {
  title: {
    default: 'TeleHood — pay $5 once, text forever',
    template: '%s — TeleHood',
  },
  description:
    'E2E-encrypted messaging with every message anchored on Robinhood Chain. One $5 activation in $THOOD and your account exists forever. Messages are free — relayed with no gas, or self-posted for about a cent. Rooms cost $10/month, paid by whoever runs them; members are free. 50% of every payment goes to $THOOD holders, pro-rata by holdings, with no staking and no lock-up.',
  applicationName: 'TeleHood',
  keywords: [
    'TeleHood',
    'THOOD',
    'Robinhood Chain',
    'encrypted messaging',
    'on-chain messaging',
    'revenue share',
  ],
  authors: [{ name: 'TeleHood' }],
  icons: {
    icon: [{ url: FAVICON, type: 'image/svg+xml' }],
    shortcut: [{ url: FAVICON, type: 'image/svg+xml' }],
  },
  openGraph: {
    type: 'website',
    siteName: 'TeleHood',
    title: 'TeleHood — pay $5 once, text forever',
    description:
      'Message contents are unreadable by anyone but the recipient. Metadata is minimized, not eliminated. $5 activates your account forever; rooms are $10/month paid by their owner; half of every payment is shared with $THOOD holders.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'TeleHood — pay $5 once, text forever',
    description:
      'Pay $5 once in $THOOD. Messages free, forever. Rooms $10/month, members free. 50% of revenue to holders, by holdings, with no staking.',
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
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
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
