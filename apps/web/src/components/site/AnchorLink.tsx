'use client';

import { useCallback, type MouseEvent, type ReactNode } from 'react';

import { useLenis } from '@/providers/LenisProvider';

export interface AnchorLinkProps {
  /** In-page target, including the `#`. */
  readonly href: `#${string}`;
  readonly className?: string;
  readonly children: ReactNode;
}

/** Sticky header height plus a little air, so a target never lands under it. */
const SCROLL_OFFSET = -76;

/**
 * In-page link that hands the scroll to Lenis when it is running.
 *
 * It stays a real `<a href="#…">`, so middle-click, "copy link" and a
 * JavaScript-free page all behave exactly as they should; the handler only
 * upgrades the jump when it can.
 */
export function AnchorLink({ href, className, children }: AnchorLinkProps): ReactNode {
  const { scrollTo, enabled } = useLenis();

  const onClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>): void => {
      if (!enabled) return;
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey) {
        return;
      }
      const target = document.querySelector(href);
      if (!(target instanceof HTMLElement)) return;
      event.preventDefault();
      scrollTo(target, SCROLL_OFFSET);
      // Keep the address bar honest even though the default jump was skipped.
      window.history.replaceState(null, '', href);
    },
    [enabled, href, scrollTo],
  );

  return (
    <a href={href} className={className} onClick={onClick}>
      {children}
    </a>
  );
}
