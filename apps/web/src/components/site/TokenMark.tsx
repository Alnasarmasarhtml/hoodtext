'use client';

import type { ReactNode } from 'react';

import { cx } from '@/lib/cx';
import s from './TokenMark.module.css';

export interface TokenMarkProps {
  /** Render matte instead of green — for prose where the mark repeats. */
  readonly quiet?: boolean;
  readonly className?: string;
}

/**
 * The `$THOOD` wordmark.
 *
 * One of the five places SPEC §7.1 permits green, so it is the only accent that
 * runs through body copy. Use `quiet` when the mark appears more than once in a
 * single paragraph — repeated green stops reading as an accent.
 */
export function TokenMark({ quiet = false, className }: TokenMarkProps): ReactNode {
  return (
    <span className={cx(s.mark, quiet && s.quiet, className)}>$THOOD</span>
  );
}
