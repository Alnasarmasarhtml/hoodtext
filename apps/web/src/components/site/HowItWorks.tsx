'use client';

import type { ReactNode } from 'react';

import { SectionHead } from './SectionHead';
import s from './HowItWorks.module.css';

/**
 * Every glyph below is drawn by hand at hairline weight in a 96×64 grid.
 * No icon set, no illustration library, no emoji — the diagram is the same
 * material as the rest of the page.
 */

function GlyphCompose(): ReactNode {
  return (
    <svg className={s.glyph} viewBox="0 0 96 64" aria-hidden="true" focusable="false">
      <path d="M6 6h68l8 8v44H6z" />
      <path d="M16 24h50M16 33h34M16 42h44M16 51h20" opacity=".48" />
      <rect x="39" y="46.5" width="7" height="9" fill="currentColor" stroke="none" />
    </svg>
  );
}

function GlyphSeal(): ReactNode {
  return (
    <svg className={s.glyph} viewBox="0 0 96 64" aria-hidden="true" focusable="false">
      <g opacity=".5">
        <path d="M4 16h18M4 30h30M4 44h11" />
      </g>
      <path d="M38 30h9M43.5 26.5 47 30l-3.5 3.5" opacity=".8" />
      <path d="M56 16h12M56 30h20M56 44h7" />
      <path
        d="M68 16h22M76 30h14M63 44h27"
        strokeDasharray="2 3"
        opacity=".42"
      />
      <path d="M90 10v44" opacity=".7" />
    </svg>
  );
}

function GlyphAnchor(): ReactNode {
  return (
    <svg className={s.glyph} viewBox="0 0 96 64" aria-hidden="true" focusable="false">
      <path d="M2 54h92" opacity=".3" />
      <path d="M13 54v-6M35 54v-6M57 54v-6M79 54v-6" opacity=".3" />
      <path d="M4 20h14l4 4v20H4z" opacity=".45" />
      <path d="M26 20h14l4 4v20H26z" opacity=".45" />
      <path
        d="M48 20h14l4 4v20H48z"
        fill="currentColor"
        fillOpacity=".16"
      />
      <path d="M70 20h14l4 4v20H70z" opacity=".45" />
      <path d="M57 6v9M53.5 11.5 57 15l3.5-3.5" />
    </svg>
  );
}

function GlyphScan(): ReactNode {
  return (
    <svg className={s.glyph} viewBox="0 0 96 64" aria-hidden="true" focusable="false">
      <g opacity=".4">
        <path d="M10 6h28M10 16h28M10 36h28M10 46h28M10 56h28" />
      </g>
      <path d="M10 26h28" />
      <path d="M4 21h5M4 21v10M4 31h5M44 21h-5M44 21v10M44 31h-5" />
      <path d="M48 26h12M56.5 22.5 60 26l-3.5 3.5" opacity=".8" />
      <circle cx="71" cy="26" r="6.5" />
      <path d="M77.5 26H92M88 26v5" />
    </svg>
  );
}

interface Step {
  readonly index: string;
  readonly title: string;
  readonly body: string;
  readonly meta: string;
  readonly glyph: () => ReactNode;
}

const STEPS: readonly Step[] = [
  {
    index: '01',
    title: 'Compose',
    body: 'You write a message. It is JSON on your device and it never leaves it in that form.',
    meta: 'client only',
    glyph: GlyphCompose,
  },
  {
    index: '02',
    title: 'Pad, then seal',
    body: 'The payload is padded up to the smallest bucket that fits, then sealed to the recipient with a one-time ephemeral key.',
    meta: '256 · 1K · 4K · 16K',
    glyph: GlyphSeal,
  },
  {
    index: '03',
    title: 'The relay batches it on chain',
    body: 'Your sealed envelope rides a relay batch: no gas, no wallet popup, and your address never appears on chain. Or skip the relay and self-post for about a cent.',
    meta: 'relayed free · self-post always works',
    glyph: GlyphAnchor,
  },
  {
    index: '04',
    title: 'Recipient scans by view tag',
    body: 'Their client tests one byte against every anchor, opens the handful that match, and verifies the hash before decrypting.',
    meta: '≈1 in 256 false positives',
    glyph: GlyphScan,
  },
];

/** The four-step path a message takes, drawn rather than described. */
export function HowItWorks(): ReactNode {
  return (
    <div className="wrap">
      <SectionHead
        index="04"
        eyebrow="How a drop works"
        title="Four steps, and only one of them touches the chain."
        lede="Encryption happens on your device; the record lands on chain without your wallet ever opening. The chain stores a hash, a key and a size — that is all it ever holds, and none of it is ever charged for."
        aside="Envelope wire format · SPEC §5"
      />

      <ol className={s.steps}>
        {STEPS.map((step) => (
          <li className={s.step} key={step.index} data-reveal>
            <div className={s.stepHead}>
              <span className={s.stepIndex}>{step.index}</span>
              <span className={s.stepRule} aria-hidden="true" />
            </div>

            <div className={s.glyphBox}>{step.glyph()}</div>

            <h3 className={s.stepTitle}>{step.title}</h3>
            <p className={s.stepBody}>{step.body}</p>
            <span className={s.stepMeta}>{step.meta}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
