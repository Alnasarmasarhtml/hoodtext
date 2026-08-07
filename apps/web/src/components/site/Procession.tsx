'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

import { buttonClassName } from '@/components/ui/Button';
import { asset } from '@/lib/asset';
import { cx } from '@/lib/cx';
import { MediaLoop } from './MediaLoop';
import s from './Procession.module.css';

/**
 * SECTION 04 — the procession. One figure marches out as the next one enters, endlessly.
 * The footage carries this; the copy is one line and the CTA, nothing else.
 */
export function Procession(): ReactNode {
  return (
    <section className={s.section} aria-label="Get access">
      <MediaLoop
        src={asset('/media/procession.mp4')}
        poster={asset('/art/figure-profile.png')}
      />
      <div className={s.veil} aria-hidden="true" />

      <div className={cx('wrap', s.inner)}>
        <div className={s.block} data-reveal>
          <h2 className={s.line}>Text forever.</h2>
          <Link
            href="/access"
            className={buttonClassName({ variant: 'primary', size: 'lg' })}
          >
            Get access — $5
          </Link>
        </div>
      </div>
    </section>
  );
}
