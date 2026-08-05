'use client';

import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { useEffect, useRef, type ReactNode } from 'react';

import { usePrefersReducedMotion } from '@/lib/use-prefers-reduced-motion';

export interface RevealRootProps {
  readonly children: ReactNode;
  readonly className?: string;
}

/** Stagger between siblings entering together, and its ceiling. */
const STAGGER_MS = 45;
const MAX_STAGGER_MS = 180;

/**
 * Drives the `[data-reveal]` → `[data-revealed]` contract declared in
 * `globals.css` with GSAP ScrollTrigger.
 *
 * The *motion* lives in CSS (420ms, `power3.out`, 16px travel) — this only
 * decides when each element is allowed to arrive. That split means reduced
 * motion, no-JS and a GSAP failure all resolve to "visible" instead of a page
 * of invisible sections.
 */
export function RevealRoot({ children, className }: RevealRootProps): ReactNode {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;

    const nodes = Array.from(root.querySelectorAll<HTMLElement>('[data-reveal]'));
    if (nodes.length === 0) return;

    const reveal = (node: HTMLElement, delayMs: number): void => {
      node.style.transitionDelay = delayMs <= 0 ? '' : `${delayMs}ms`;
      node.setAttribute('data-revealed', '');
    };

    const revealAll = (): void => {
      for (const node of nodes) reveal(node, 0);
    };

    if (reduced) {
      revealAll();
      return;
    }

    let triggers: readonly ScrollTrigger[] = [];
    try {
      gsap.registerPlugin(ScrollTrigger);
      triggers = ScrollTrigger.batch(nodes, {
        start: 'top 88%',
        once: true,
        onEnter: (batch) => {
          batch.forEach((element, index) => {
            if (element instanceof HTMLElement) {
              reveal(element, Math.min(index * STAGGER_MS, MAX_STAGGER_MS));
            }
          });
        },
      });
      // Anything already on screen when JS boots must not wait for a scroll.
      ScrollTrigger.refresh();
    } catch {
      // Motion is an enhancement; never let it withhold content.
      revealAll();
      return;
    }

    return () => {
      for (const trigger of triggers) trigger.kill();
    };
  }, [reduced]);

  return (
    <div ref={rootRef} className={className}>
      {children}
    </div>
  );
}
