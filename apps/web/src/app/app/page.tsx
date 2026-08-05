import type { ReactNode } from 'react';

import { ThreadPlaceholder } from '@/components/app/ThreadPlaceholder';

/**
 * `/app` — the desk with no thread open.
 *
 * The conversation rail is rendered by the segment layout, so this route owns
 * only the right-hand pane: the designed locked state when there is no active
 * CHAT tier, and a live readout of the scanner when there is.
 */
export default function MessengerIndexPage(): ReactNode {
  return <ThreadPlaceholder />;
}
