'use client';

import { Suspense, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';

import { ThreadRoute } from '@/components/app/Thread';

/**
 * `/app/thread?c=<convoId>` — one thread.
 *
 * The id is a purely local threading key: `sha256` of the two participants' X25519 public keys,
 * sorted. It is never posted on chain (1:1 drops carry `convoId = 0x0`), so this route resolves
 * entirely against what this device already holds.
 *
 * It reads the id from a query parameter rather than a path segment because the site ships as a
 * static export: a `[convoId]` path segment would require every possible conversation id to be
 * known at build time, which is impossible for a hash of two keys. `ThreadRoute` validates whatever
 * arrives and renders a designed state for anything malformed or unknown.
 */
function Thread(): ReactNode {
  const params = useSearchParams();
  return <ThreadRoute convoId={params.get('c') ?? ''} />;
}

export default function ThreadPage(): ReactNode {
  /* useSearchParams needs a Suspense boundary in a prerendered page. */
  return (
    <Suspense fallback={null}>
      <Thread />
    </Suspense>
  );
}
