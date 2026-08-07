'use client';

import type { ComponentPropsWithoutRef, ReactNode } from 'react';

import { cx } from '@/lib/cx';
import s from './Label.module.css';

export type LabelTone = 'muted' | 'dim' | 'bone' | 'steel' | 'crimson' | 'green';
export type EyebrowSize = 'micro' | 'default' | 'large';

export interface EyebrowProps extends ComponentPropsWithoutRef<'span'> {
  readonly tone?: LabelTone;
  readonly size?: EyebrowSize;
  /** Draw the short hairline that anchors the eyebrow to the column edge. */
  readonly rule?: boolean;
}

/**
 * Uppercase Geist Mono at .06em — the system's section marker.
 *
 * `tone="green"` is reserved for the active state, confirmed-on-chain status,
 * the live subscription badge and the $GRAM wordmark.
 */
export function Eyebrow({
  tone = 'muted',
  size = 'default',
  rule = false,
  className,
  children,
  ...rest
}: EyebrowProps): ReactNode {
  return (
    <span
      {...rest}
      className={cx(
        s.eyebrow,
        s[tone],
        size === 'micro' && s.micro,
        size === 'large' && s.large,
        rule && s.rule,
        className,
      )}
    >
      <span className={s.text}>{children}</span>
    </span>
  );
}

export interface LabelProps extends ComponentPropsWithoutRef<'label'> {
  /** Rendered on the right in lower-case, e.g. "optional". */
  readonly hint?: ReactNode;
  readonly tone?: LabelTone;
}

/** Form label. Pair with `Field`, or use directly for custom controls. */
export function Label({
  hint,
  tone = 'muted',
  className,
  children,
  ...rest
}: LabelProps): ReactNode {
  return (
    <label {...rest} className={cx(s.label, s[tone], className)}>
      <span className={s.labelText}>{children}</span>
      {hint !== undefined && <span className={s.optional}>{hint}</span>}
    </label>
  );
}
