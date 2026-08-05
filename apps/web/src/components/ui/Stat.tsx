'use client';

import type { ComponentPropsWithoutRef, ReactNode } from 'react';

import { cx } from '@/lib/cx';
import { useCountUp } from '@/lib/use-count-up';
import s from './Stat.module.css';

export type StatTone = 'bone' | 'muted' | 'steel' | 'crimson' | 'green';
export type StatSize = 'sm' | 'md' | 'lg';

export interface StatProps extends Omit<ComponentPropsWithoutRef<'div'>, 'children'> {
  readonly label: ReactNode;
  /** The final, already-formatted value. Rendered as-is on the server. */
  readonly value: ReactNode;
  /**
   * Numeric target for the count-up. Only takes effect when `value` is a plain
   * string, because the animation writes `textContent`.
   */
  readonly countUp?: number;
  /** Formats intermediate count-up frames. Default: grouped integer. */
  readonly format?: (value: number) => string;
  readonly unit?: ReactNode;
  readonly hint?: ReactNode;
  readonly tone?: StatTone;
  readonly size?: StatSize;
  readonly align?: 'start' | 'end';
}

/**
 * A single figure, always tabular so columns of stats align to the digit.
 *
 * The count-up never changes what React renders — it animates the DOM text and
 * restores the exact rendered string on the last frame, so there is no
 * hydration mismatch and no-JS output is already correct.
 */
export function Stat({
  label,
  value,
  countUp,
  format,
  unit,
  hint,
  tone = 'bone',
  size = 'md',
  align = 'start',
  className,
  ...rest
}: StatProps): ReactNode {
  const animatable = countUp !== undefined && typeof value === 'string';
  const numberRef = useCountUp<HTMLSpanElement>(countUp ?? 0, {
    enabled: animatable,
    ...(format === undefined ? {} : { format }),
  });

  return (
    <div
      {...rest}
      className={cx(s.stat, s[tone], s[size], align === 'end' && s.end, className)}
    >
      <span className={s.label}>{label}</span>
      <span className={s.value}>
        <span className={s.number} ref={animatable ? numberRef : undefined}>
          {value}
        </span>
        {unit !== undefined && <span className={s.unit}>{unit}</span>}
      </span>
      {hint !== undefined && <span className={s.hint}>{hint}</span>}
    </div>
  );
}
