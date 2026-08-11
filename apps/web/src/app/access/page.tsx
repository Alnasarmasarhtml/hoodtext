import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { AccessPage } from '@/components/access/AccessPage';

/**
 * `/access` — activate, run your rooms, and take the holders' half (SPEC §7.4).
 *
 * The route itself is a server component so the description below is real
 * metadata rather than a client-rendered afterthought; every figure on the page
 * is read from the chain inside `<AccessPage>`.
 *
 * Nothing here is reveal-animated. The page exists to state numbers, and a
 * number that starts at `opacity: 0` is a number the reader cannot check.
 */
export const metadata: Metadata = {
  title: 'Access & revenue',
  description:
    'Activate your account for $5, once, forever. Priced in dollars on chain, paid in $GRAM at the live rate. Rooms cost $10/month, paid by whoever runs them; members are free and messages are never charged. Half of every payment goes to $GRAM holders, pro-rata by holdings, with no staking, no lock-up and no deposit.',
  openGraph: {
    type: 'website',
    siteName: 'HoodGram',
    title: 'Access & revenue · HoodGram',
    description:
      'One $5 payment and your account exists forever. Rooms are $10/month, paid by their admin. Messages are free. 50% of every payment is shared with holders by holdings, read from historical balance checkpoints.',
    /* Declaring an openGraph block here replaces the root one wholesale rather
       than merging, so the card image has to be repeated or a shared /access
       link unfurls as a large card with an empty picture well. */
    images: [{ url: 'brand/og-card-messenger.jpg', width: 1200, height: 630, alt: 'HoodGram' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Access & revenue · HoodGram',
    description:
      'Pay $5 once, text forever. Rooms $10/month, members free. 50% of revenue to holders, by holdings, with no staking.',
    images: ['brand/og-card-messenger.jpg'],
  },
};

export default function Access(): ReactNode {
  return <AccessPage />;
}
