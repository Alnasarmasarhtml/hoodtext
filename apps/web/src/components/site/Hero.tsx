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
 * A HUD frame inset from the edges with four green corner marks and everything
 * that matters anchored bottom-left over a soft falloff. No opaque plate: the
 * procession stays fully visible and the copy still holds, because the
 * darkening sits only behind the type.
 *
 * The top of the frame is deliberately empty since the corporate pass: the
 * graffiti lockup and the chain chip both came out on 2026-08-12 (client:
 * "it doesn't look professional" / "not useful"). The header carries the
 * brand; the footer and /access state the network.
 *
 * The corner marks are the same device as the bracket boxes in the section
 * below, so the page opens and continues in one language.
 */
export function Hero(): ReactNode {
  return (
    <section className={s.hero} aria-label="HoodGram: the encrypted messenger that cannot be switched off">
      <MediaLoop
        className={s.film}
        src={asset('/media/procession.mp4')}
        poster={asset('/art/figure-profile.png')}
      />
      <div className={s.veil} aria-hidden="true" />

      {/* The fade belongs to the hero, not to the copy. As a pseudo-element of
          the `[data-reveal]` block it needed `z-index: -1`, and that block
          clears `will-change` once revealed. Destroying the stacking context
          and dropping the fade behind the video, which is how it kept
          vanishing. Sitting here at `inset: 0` it needs no z-index, cannot
          bleed past the viewport, and paints under everything after it. */}
      <span className={s.fade} aria-hidden="true" />

      <div className={s.frame} aria-hidden="true">
        <span className={cx(s.brk, s.brkTl)} />
        <span className={cx(s.brk, s.brkTr)} />
        <span className={cx(s.brk, s.brkBl)} />
        <span className={cx(s.brk, s.brkBr)} />
      </div>

      <div className={cx('wrap', s.inner)}>
        {/* R2, the institutional hero (client call, 2026-08-12): the claim in
            bone rather than green, one green rule, and the numbers as a stat
            row instead of a strip of slogans. The display face stays Orbitron;
            the register change is carried by colour and restraint, not by a
            font swap. */}
        <div className={s.block} data-reveal>
          <p className={s.kicker}>Encrypted messaging, settled on chain</p>
          <span className={s.rule} aria-hidden="true" />
          <h1 className={s.title}>The messenger that cannot be switched off.</h1>
          <p className={s.sub}>
            Sealed on your device. Anchored on Robinhood Chain. No store to remove it from, no
            keys to hand over, no subscription to cancel. Access is one $5 payment made in{' '}
            <TokenMark />, and half of every payment goes to the people holding it.
          </p>

          <dl className={s.stats}>
            <div className={s.stat}>
              <dt className={s.statKey}>once, in $GRAM</dt>
              <dd className={s.statValue}>$5</dd>
            </div>
            <div className={s.stat}>
              <dt className={s.statKey}>per message</dt>
              <dd className={s.statValue}>$0</dd>
            </div>
            <div className={s.stat}>
              <dt className={s.statKey}>of revenue to holders</dt>
              <dd className={s.statValue}>50%</dd>
            </div>
          </dl>

          <div className={s.actions}>
            <Link
              href="/access"
              className={buttonClassName({ variant: 'primary', size: 'lg' })}
            >
              Get access
            </Link>
            <Link
              href="/record"
              className={buttonClassName({ variant: 'ghost', size: 'lg' })}
            >
              Read the record
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
