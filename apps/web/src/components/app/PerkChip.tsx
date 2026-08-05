'use client';

import type { ReactNode } from 'react';

import { perkTierLabel } from '@/lib/abi';
import { cx } from '@/lib/cx';
import s from './PerkChip.module.css';

export interface PerkChipProps {
  /** `Perks.tierOf` value; renders nothing for 0 or unknown. */
  readonly tier: number;
  readonly className?: string;
}

/**
 * The holder rank, worn beside a name.
 *
 * A hairline chip in mono uppercase — status, never a control. Deliberately
 * outside the green budget: rank is not the accent, so the ladder runs
 * dim → muted → steel, with only KINGPIN reaching bone.
 */
export function PerkChip({ tier, className }: PerkChipProps): ReactNode {
  if (tier < 1 || tier > 4 || !Number.isInteger(tier)) return null;
  return (
    <span
      className={cx(s.chip, s[`tier${String(tier)}`], className)}
      title={`Holder rank: ${perkTierLabel(tier)}`}
    >
      {perkTierLabel(tier)}
    </span>
  );
}
