import type { ReactNode } from 'react';

import { Faq } from '@/components/site/Faq';
import { Hero } from '@/components/site/Hero';
import { HowItWorks } from '@/components/site/HowItWorks';
import { LiveStats } from '@/components/site/LiveStats';
import { NoiseFloor } from '@/components/site/NoiseFloor';
import { PerksLadder } from '@/components/site/PerksLadder';
import { Pricing } from '@/components/site/Pricing';
import { RevealRoot } from '@/components/site/RevealRoot';
import { RevenueShare } from '@/components/site/RevenueShare';
import { SiteFooter } from '@/components/site/SiteFooter';
import { Ticker } from '@/components/site/Ticker';
import s from './page.module.css';

/**
 * `[data-reveal]` starts at `opacity: 0` so GSAP can bring it in. Without
 * JavaScript nothing would ever set `[data-revealed]`, so the page would be
 * blank — this hands every section straight back to the reader instead.
 */
const NOSCRIPT_REVEAL = '[data-reveal]{opacity:1!important;transform:none!important}';

/**
 * TeleHood — the marketing page (SPEC §7.2), in the Signals Desk direction.
 *
 * Section order is fixed: masthead and the live anchor log, the three truths,
 * the monthly tiers, how a drop works, the padding guarantee, the revenue
 * share, live figures from the relay, the limitations, and the colophon.
 */
export default function HomePage(): ReactNode {
  return (
    <>
      <noscript>
        <style>{NOSCRIPT_REVEAL}</style>
      </noscript>

      <RevealRoot className={s.page}>
        {/* 01 · masthead — 02 · the drop stream rides in its right rail */}
        <Hero />

        {/* 02b · the flow: live anchors streaming under the masthead */}
        <Ticker />


        {/* 04 */}
        <section className={s.band} id="pricing">
          <Pricing />
        </section>

        {/* 05 */}
        <section className={s.band} id="how">
          <HowItWorks />
        </section>

        {/* 06 */}
        <section className={s.band} id="noise">
          <NoiseFloor />
        </section>

        {/* 07 */}
        <section className={s.band} id="revenue">
          <RevenueShare />
        </section>

        {/* 08 */}
        <section className={s.band} id="perks">
          <PerksLadder />
        </section>

        {/* 09 */}
        <section className={s.bandTight} id="stats">
          <LiveStats />
        </section>

        {/* 10 */}
        <section className={s.band} id="faq">
          <Faq />
        </section>

        {/* 11 */}
        <SiteFooter />
      </RevealRoot>
    </>
  );
}
