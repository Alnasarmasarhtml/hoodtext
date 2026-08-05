'use client';

/**
 * The demo strip — honesty as chrome.
 *
 * One hairline band above the desk, steel on panel, that says exactly what
 * the visitor is looking at and offers the one action that matters: leaving.
 * Never green — simulated data does not get the live accent.
 */

import { useCallback, type ReactNode } from 'react';

import { DEMO_BANNER_COPY, exitDemo } from '@/lib/demo';
import { cx } from '@/lib/cx';
import s from './DemoBanner.module.css';

export interface DemoBannerProps {
  readonly className?: string;
}

export function DemoBanner({ className }: DemoBannerProps): ReactNode {
  const onExit = useCallback((): void => {
    exitDemo();
  }, []);

  return (
    <div className={cx(s.banner, className)} role="note" aria-label="Demo mode">
      <span className={s.mark} aria-hidden="true" />
      <span className={s.copy}>{DEMO_BANNER_COPY}</span>
      <button type="button" className={s.exit} onClick={onExit}>
        Exit demo
      </button>
    </div>
  );
}
