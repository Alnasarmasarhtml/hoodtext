'use client';

/**
 * The two demo-mode surfaces on `/access`.
 *
 * `DemoBanner` is the honesty strip: a thin hairline band in steel — never
 * green, green is reserved for live/confirmed — stating that everything below
 * is the real interface over a fixture world, with the one action that leaves.
 * `DemoNote` is the inline receipt a simulated action prints instead of a
 * transaction, so the demo never pretends something reached a chain.
 */

import type { ReactNode } from 'react';

import { DEMO_BANNER_COPY, exitDemo } from '@/lib/demo';
import { Button } from '@/components/ui';
import s from './Demo.module.css';

export function DemoBanner(): ReactNode {
  return (
    <div className={s.banner} role="status" aria-label="Demo mode is on">
      <div className={s.inner}>
        <span className={s.mark} aria-hidden="true" />
        <span className={s.tag}>Demo</span>
        <span className={s.copy} title={DEMO_BANNER_COPY}>
          {DEMO_BANNER_COPY}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className={s.exit}
          onClick={() => exitDemo()}
        >
          Exit demo
        </Button>
      </div>
    </div>
  );
}

export interface DemoNoteProps {
  readonly children?: ReactNode;
  readonly className?: string;
}

/** Small mono note shown where a live build would have sent a transaction. */
export function DemoNote({ children, className }: DemoNoteProps): ReactNode {
  return (
    <p className={className === undefined ? s.note : `${s.note} ${className}`} role="status">
      {children ?? 'Simulated — in the live app this is an on-chain transaction.'}
    </p>
  );
}
