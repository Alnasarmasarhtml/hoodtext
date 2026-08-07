'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

import { buttonClassName } from '@/components/ui/Button';
import { asset } from '@/lib/asset';
import { cx } from '@/lib/cx';
import { MediaLoop } from './MediaLoop';
import { TokenMark } from './TokenMark';
import s from './Hero.module.css';

/**
 * SECTION 01 — the viewfinder.
 *
 * A HUD frame inset from the edges with four green corner marks, the mark and a
 * status line along the top, and everything that matters anchored bottom-left
 * over a soft falloff. No opaque plate: the procession stays fully visible and
 * the copy still holds, because the darkening sits only behind the type.
 *
 * The corner marks are the same device as the bracket boxes in the section
 * below, so the page opens and continues in one language.
 */
export function Hero(): ReactNode {
  return (
    <section className={s.hero} aria-label="HoodGram — pay $5 once, text forever">
      <MediaLoop
        className={s.film}
        src={asset('/media/procession.mp4')}
        poster={asset('/art/figure-profile.png')}
      />
      <div className={s.veil} aria-hidden="true" />

      <div className={s.frame} aria-hidden="true">
        <span className={cx(s.brk, s.brkTl)} />
        <span className={cx(s.brk, s.brkTr)} />
        <span className={cx(s.brk, s.brkBl)} />
        <span className={cx(s.brk, s.brkBr)} />
      </div>

      <div className={cx('wrap', s.inner)}>
        {/* The fade is a sibling, never a pseudo-element of the revealing block.
            `[data-reveal]` sets `will-change: opacity` and then clears it to
            `auto` once revealed — which destroys the stacking context it had
            been creating, so a `z-index: -1` child escapes and paints behind
            the video. That is exactly how this fade kept disappearing. Sitting
            first in DOM order with the content positioned after it needs no
            z-index at all. */}
        <span className={s.fade} aria-hidden="true" />

        <div className={s.hudTop} data-reveal>
          <img
            className={s.logo}
            src={asset('/brand/logo-primary.png')}
            alt="HOODGRAM"
            width={3383}
            height={912}
            decoding="async"
            fetchPriority="high"
          />
          <p className={s.hudMeta}>
            <span className={s.hudDot} aria-hidden="true" />
            Chain 4663 · Live
          </p>
        </div>

        <div className={s.block} data-reveal>
          <p className={s.kicker}>Encrypted · Anchored · Unremovable</p>
          <h1 className={s.title}>Pay $5 once. Text forever.</h1>
          <p className={s.claim}>
            Every message anchored on Robinhood Chain. Half of every payment goes back to the
            people holding <TokenMark />.
          </p>
          <p className={s.sub}>
            Messages are sealed on your device and free to send, forever — the relay posts them on
            chain with no gas and your address never on chain. Rooms are $10 a month, paid by
            whoever runs them; members ride free.
          </p>

          <div className={s.actions}>
            <Link
              href="/access"
              className={buttonClassName({ variant: 'primary', size: 'lg' })}
            >
              Get access — $5
            </Link>
            <Link
              href="/app?demo=1"
              className={buttonClassName({ variant: 'ghost', size: 'lg' })}
            >
              View demo
            </Link>
          </div>

          <p className={s.meta}>
            $5 once · rooms $10/mo · messages free · 50% of revenue to holders
          </p>
        </div>
      </div>
    </section>
  );
}
