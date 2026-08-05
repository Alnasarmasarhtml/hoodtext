'use client';

import type { ReactNode } from 'react';

import { cx } from '@/lib/cx';
import s from './SectionHead.module.css';

export interface SectionHeadProps {
  /** Two-digit file number, e.g. `03`. The desk numbers everything. */
  readonly index: string;
  /** Uppercase mono section marker. */
  readonly eyebrow: string;
  readonly title: ReactNode;
  /** One or two sentences under the title. */
  readonly lede?: ReactNode;
  /** Right-aligned status or figure, kept on its own line below 760px. */
  readonly aside?: ReactNode;
  readonly className?: string;
}

/**
 * The masthead every section shares: a numbered slug over a hairline, the
 * headline, and an optional lede in the narrower measure a reader can hold.
 */
export function SectionHead({
  index,
  eyebrow,
  title,
  lede,
  aside,
  className,
}: SectionHeadProps): ReactNode {
  return (
    <header className={cx(s.head, className)}>
      <div className={s.slug} data-reveal>
        <span className={s.index}>{index}</span>
        <span className={s.rule} aria-hidden="true" />
        <span className={s.eyebrow}>{eyebrow}</span>
        {aside !== undefined && <span className={s.aside}>{aside}</span>}
      </div>

      <h2 className={s.title} data-reveal>
        {title}
      </h2>

      {lede !== undefined && (
        <p className={s.lede} data-reveal>
          {lede}
        </p>
      )}
    </header>
  );
}
