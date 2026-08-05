'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

import { buttonClassName } from '@/components/ui/Button';
import { asset } from '@/lib/asset';
import { activeChain, robinhoodChain } from '@/lib/chain';
import { AnchorLink } from './AnchorLink';
import { DropStream } from './DropStream';
import s from './Hero.module.css';
import { TokenMark } from './TokenMark';

interface HeroFact {
  readonly label: string;
  readonly value: ReactNode;
}

const FACTS: readonly HeroFact[] = [
  { label: 'Account', value: '$5, once, forever' },
  { label: 'Messages', value: 'Free · relayed' },
  { label: 'Rooms', value: '$10/mo, owner pays' },
  { label: 'To holders', value: '50% of revenue' },
];

/**
 * Asymmetric masthead: the wordmark and the honest claim on the left, the live
 * anchor log on the right. The stream is the product's only real hero image —
 * there is no illustration anywhere on this page.
 */
export function Hero(): ReactNode {
  return (
    <section className={s.hero} aria-labelledby="hero-title">
      {/* Real phosphor footage behind the masthead. It is the first thing on the
          page that moves, which is the whole point — the product is a live log,
          so the page should look alive before you have read a word of it. */}
      <div className={s.media} aria-hidden="true">
        <video
          className={s.video}
          poster={asset("/media/crt-poster.jpg")}
          muted
          loop
          playsInline
          autoPlay
          preload="auto"
        >
          <source src={asset("/media/crt-loop-seamless.webm")} type="video/webm" />
          <source src={asset("/media/crt-loop-seamless.mp4")} type="video/mp4" />
        </video>
        <div className={s.mediaScrim} />
      </div>

      <div className={s.wrap}>
        <div className={s.main}>
          <div className={s.slug} data-reveal>
            <span className={s.slugMark} aria-hidden="true" />
            <span className={s.slugText}>Signals desk</span>
            <span className={s.slugRule} aria-hidden="true" />
            <span className={s.slugText}>
              {activeChain.name} · {activeChain.id}
            </span>
          </div>

          <h1 className={s.wordmark} id="hero-title" data-reveal>
            TELEHOOD
          </h1>

          {/* The claim names Robinhood Chain, not `activeChain`: what this build is
              pointed at belongs in the slug above, and a local build must not rewrite
              the product into "anchored on Anvil". */}
          <p className={s.claim} data-reveal>
            <span className={s.claimLead}>
              Pay $5 once. Text forever — every message anchored on{' '}
              {robinhoodChain.name}.
            </span>{' '}
            <span className={s.claimTail}>
              Half of every payment goes back to the people holding <TokenMark />.
            </span>
          </p>

          <p className={s.sub} data-reveal>
            Messages are sealed on your device and free to send, forever: the relay
            posts them on chain with no gas, no popups, and your address never on
            chain — or you self-post for about a cent. Rooms cost $10 a month, paid by
            whoever runs the room; members ride free. Hold <TokenMark /> and you
            collect half of every payment the protocol takes, straight to your wallet.
          </p>

          <div className={s.ctas} data-reveal>
            <Link
              href="/app"
              className={buttonClassName({ variant: 'primary', size: 'lg' })}
            >
              Open the app
            </Link>
            <AnchorLink
              href="#pricing"
              className={buttonClassName({ variant: 'ghost', size: 'lg' })}
            >
              See pricing
            </AnchorLink>
          </div>

          <dl className={s.facts} data-reveal>
            {FACTS.map((fact) => (
              <div className={s.fact} key={fact.label}>
                <dt className={s.factLabel}>{fact.label}</dt>
                <dd className={s.factValue}>{fact.value}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className={s.rail} data-reveal>
          <DropStream />
        </div>
      </div>
    </section>
  );
}
