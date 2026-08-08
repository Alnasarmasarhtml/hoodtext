'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

import { buttonClassName } from '@/components/ui/Button';
import { asset } from '@/lib/asset';
import { ACTIVE_CHAIN_ID } from '@/lib/chain';
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

      {/* The fade belongs to the hero, not to the copy. As a pseudo-element of
          the `[data-reveal]` block it needed `z-index: -1`, and that block
          clears `will-change` once revealed — destroying the stacking context
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
        <div className={s.hudTop} data-reveal>
          {/* Set, not shipped as a picture. The rendered banner this replaced
              had the wordmark in it twice — a clean one with a second, garbled
              one drawn across it — because the generator wrote the letters
              itself. Real type in the site's own face also stays sharp at every
              width and costs 2 MB less. */}
          <div className={s.logo}>
            <img
              className={s.logoMark}
              src={asset('/brand/mark-hg-512.png')}
              alt=""
              width={512}
              height={512}
              decoding="async"
              fetchPriority="high"
            />
            <span className={s.logoWord}>HOODGRAM</span>
          </div>
          <p className={s.hudMeta}>
            <span className={s.hudDot} aria-hidden="true" />
            Chain {ACTIVE_CHAIN_ID} · Live
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
