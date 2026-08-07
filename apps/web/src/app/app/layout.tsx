import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { AppShell } from '@/components/app/AppShell';

/**
 * The messenger segment.
 *
 * `AppShell` lives here rather than in each page so the identity ceremony and
 * the drop scanner mount once and survive navigation between threads — moving
 * between `/app` and `/app/[convoId]` re-renders the pane, never the engine.
 *
 * That lifetime is also what scopes the shell's document scroll lock: this
 * layout is the boundary of the `/app` segment, so the shell survives every
 * thread-to-thread move (the lock holds) and unmounts on the way out to `/` or
 * `/access` (the lock releases). Do not lift `AppShell` any higher.
 */

export const metadata: Metadata = {
  title: 'Messenger',
  description:
    'Encrypted 1:1 messaging anchored on Robinhood Chain. Message contents are unreadable by anyone but the recipient; metadata is minimized, not eliminated.',
  // A private surface: nothing here belongs in a search index.
  robots: { index: false, follow: false },
};

export default function MessengerLayout({
  children,
}: {
  readonly children: ReactNode;
}): ReactNode {
  return <AppShell>{children}</AppShell>;
}
