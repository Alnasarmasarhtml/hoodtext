'use client';

/**
 * Route-level error boundary for `/access`.
 *
 * This page moves money, so a crash must say the one thing that actually
 * matters — nothing was signed, so nothing was spent — and then offer a real
 * way out. A blank screen on a payment page is the worst possible failure mode.
 *
 * The thrown value is run through the same decoder every write on this page
 * uses, so an RPC or contract failure that escaped a panel is still named
 * rather than dumped.
 */

import Link from 'next/link';
import type { ReactNode } from 'react';

import { describeChainError } from '@/components/access/chain-errors';
import { Button, Eyebrow, Panel, PanelHeader, buttonClassName } from '@/components/ui';
import s from './error.module.css';

export interface AccessErrorProps {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}

export default function AccessError({ error, reset }: AccessErrorProps): ReactNode {
  /* Next already reports the boundary's error to its own channel, and the
     digest below is the handle for a production trace — so this file stays at
     the app-wide zero-`console` bar (SPEC §8). */
  const decoded = describeChainError(error, { action: 'Loading /access' });

  return (
    <div className={s.page}>
      <Panel as="section" tone="raised" notch="tr" className={s.panel} highlight>
        <PanelHeader label="Access unavailable" note="Nothing was signed" />

        <div className={s.body}>
          <Eyebrow rule tone="crimson">
            {decoded.revertName ?? (decoded.kind === 'unknown' ? 'Read failed' : decoded.kind)}
          </Eyebrow>

          <h1 className={s.title}>{decoded.title}</h1>
          <p className={s.detail}>{decoded.detail}</p>

          <p className={s.assurance}>
            This is a failure to <strong>read</strong>. No transaction was created, no
            allowance changed, and no $THOOD moved. Your account, your keys and your
            history are exactly as they were.
          </p>

          <div className={s.actions}>
            <Button variant="primary" onClick={reset}>
              Try again
            </Button>
            <Link className={buttonClassName({ variant: 'ghost' })} href="/">
              Back to the site
            </Link>
          </div>

          {error.digest !== undefined && (
            <span className={s.digest}>{`digest ${error.digest}`}</span>
          )}
        </div>
      </Panel>
    </div>
  );
}
