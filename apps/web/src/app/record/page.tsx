import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { RecordPage } from '@/components/record/RecordPage';

/**
 * `/record` — twenty-four sourced entries on what is actually being done to
 * private communication, and what is not.
 *
 * A server component so the description below is real metadata rather than
 * something rendered after the fact, and so every source link is in the HTML a
 * crawler sees.
 */
export const metadata: Metadata = {
  title: 'The Record',
  description:
    'Twenty-four sourced entries on the laws, court orders and network blocks affecting private communication worldwide. What each one does, what it does not do, and a link to read it yourself. Compiled 8 August 2026 from primary legislative text, court records, regulators and network measurement.',
  openGraph: {
    type: 'website',
    siteName: 'HoodGram',
    title: 'The Record · HoodGram',
    description:
      'What is actually being done to private communication, with sources. Every entry says what the instrument does, what it does not do, and where to read it. Nothing on the list has ever produced the contents of an encrypted message.',
    images: [{ url: 'brand/og-card-messenger.jpg', width: 1200, height: 630, alt: 'HoodGram' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'The Record · HoodGram',
    description:
      'Laws, court orders and network blocks against private messaging. What each does, what it does not, and a link to the source.',
    images: ['brand/og-card-messenger.jpg'],
  },
};

export default function Record(): ReactNode {
  return <RecordPage />;
}
