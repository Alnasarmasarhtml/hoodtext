import type { ReactNode } from 'react';

import { Encryption } from '@/components/site/Encryption';
import { Hero } from '@/components/site/Hero';
import { NewsTicker } from '@/components/site/NewsTicker';
import { Procession } from '@/components/site/Procession';
import { RevealRoot } from '@/components/site/RevealRoot';
import { SiteFooter } from '@/components/site/SiteFooter';
import { WhatThisIs } from '@/components/site/WhatThisIs';
import s from './page.module.css';

/**
 * `[data-reveal]` starts at `opacity: 0` so GSAP can bring it in. Without
 * JavaScript nothing would ever set `[data-revealed]`, so the page would be
 * blank — this hands every section straight back to the reader instead.
 */
const NOSCRIPT_REVEAL = '[data-reveal]{opacity:1!important;transform:none!important}';

/**
 * Wire copy — VERBATIM, and the page's entire propaganda budget (the 80/20
 * rule: sections explain the product; only these bands editorialise).
 *
 * Every line is a verified fact with a date. Do not add lines, and never add
 * anything implying encrypted messages are being scanned today — they are
 * explicitly carved out of Chat Control 1.0, and that carve-out is the one
 * thing this page must not get wrong.
 */
const WIRE_LAW: readonly string[] = [
  "9 JULY 2026: CHAT CONTROL 1.0 BACK IN FORCE. PARLIAMENT'S REJECTION FAILED: 361 VOTES NEEDED, NOT REACHED.",
  'UNENCRYPTED MESSAGING MAY NOW BE SCANNED WITHOUT ANY SUSPICION.',
  'SEPTEMBER 2026: CSAR RETURNS TO TRILOGUE. THE MANDATORY ONE. THE PERMANENT ONE.',
  'CSAR IS THE VENUE WHERE CLIENT-SIDE SCANNING COULD REACH INSIDE ENCRYPTION.',
  'THEY CARVED OUT ENCRYPTION THIS ROUND. NEXT ROUND STARTS IN SEPTEMBER.',
];

const WIRE_ID: readonly string[] = [
  'UK ONLINE SAFETY ACT: OFCOM MAY ORDER PLATFORMS TO DEPLOY "ACCREDITED TECHNOLOGY" TO SCAN PRIVATE MESSAGES.',
  '25+ US STATES NOW REQUIRE ID TO ACCESS ORDINARY WEBSITES.',
  'OCTOBER 2025: 70,000 ID PHOTOS LEAKED FROM A SINGLE AGE-VERIFICATION BREACH.',
  'IRELAND OPENED A GOVERNMENT DIGITAL WALLET PILOT IN APRIL 2026.',
  'GOOGLE IS BRINGING DIGITAL ID TO ANDROID IN THE UK.',
];

const WIRE_PLATFORM: readonly string[] = [
  '3–4 AUGUST 2026: TELEGRAM REMOVED FROM THE APP STORE WORLDWIDE.',
  "A BILLION-USER MESSENGER VANISHED ON ONE COMPANY'S DECISION.",
  'HOODGRAM IS A WEB APP. THERE IS NO STORE TO REMOVE IT FROM.',
];

/**
 * HoodGram — the launch homepage. Exactly four content sections, separated by
 * the wire bands: the hero, the whole product in readable copy, the seal, and
 * the procession. Then the colophon with the nine contract addresses.
 */
export default function HomePage(): ReactNode {
  return (
    <>
      <noscript>
        <style>{NOSCRIPT_REVEAL}</style>
      </noscript>

      <RevealRoot className={s.page}>
        {/* 01 — full-viewport hero under the rain */}
        <Hero />

        <NewsTicker items={WIRE_LAW} ariaLabel="The record. EU scanning law" />

        {/* 02 — the whole product, over the crowd */}
        <WhatThisIs />

        <NewsTicker items={WIRE_ID} ariaLabel="The record. Identity checks and their leaks" />

        {/* 03 — the encryption, text left / cage right */}
        <Encryption />

        <NewsTicker items={WIRE_PLATFORM} ariaLabel="The record. Platform removals" />

        {/* 04 — the procession, one line and the CTA */}
        <Procession />

        <SiteFooter />
      </RevealRoot>
    </>
  );
}
