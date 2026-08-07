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
 * SECTION 01 — the full-viewport opener.
 *
 * Falling symbols under a light veil; the client's logo dead-centre above the promise. The logo
 * PNG has its letter counters knocked out so the rain shows through them — that is intentional,
 * so nothing opaque may ever be placed behind the mark.
 */
export function Hero(): ReactNode {
  return (
    <section className={s.hero} aria-label="HoodGram — pay $5 once, text forever">
      <MediaLoop src={asset('/media/hero-rain.mp4')} poster={asset('/art/matrix-rain.png')} />
      <div className={s.veil} aria-hidden="true" />

      <div className={cx('wrap', s.inner)}>
        <img
          className={s.logo}
          src={asset('/brand/logo-primary.png')}
          alt="HOODGRAM"
          width={3383}
          height={912}
          decoding="async"
          fetchPriority="high"
          data-reveal
        />

        <div className={s.pitch} data-reveal>
          <h1 className={s.title}>Pay $5 once. Text forever.</h1>
          <p className={s.claim}>
            Every message anchored on Robinhood Chain. Half of every payment goes back to the
            people holding <TokenMark />.
          </p>
          <p className={s.sub}>
            Messages are sealed on your device and free to send, forever: the relay posts them on
            chain with no gas, no popups, and your address never on chain — or you self-post for
            about a cent. Rooms cost $10 a month, paid by whoever runs the room; members ride
            free. Hold <TokenMark quiet /> and you collect half of every payment the protocol
            takes, straight to your wallet.
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

          <p className={s.meta}>$5 once · rooms $10/mo · messages free · 50% of revenue to holders</p>
        </div>
      </div>

      <div className={s.cue} aria-hidden="true">
        <span className={s.cueLine} />
        <span className={s.cueText}>Scroll</span>
      </div>
    </section>
  );
}
