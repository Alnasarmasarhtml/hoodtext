'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

import { buttonClassName } from '@/components/ui/Button';
import { PERK_LADDER } from '@/lib/abi';
import { formatCount } from '@/lib/format';
import s from './PerksLadder.module.css';
import { SectionHead } from './SectionHead';
import { TokenMark } from './TokenMark';

/**
 * The holder status ladder, stated as what it is: status and capacity, never
 * money. The revenue share deliberately sits outside it — every holder is paid
 * pro-rata from the first token — so the rungs can be pure flex without ever
 * becoming a claim on anyone else's share.
 */
export function PerksLadder(): ReactNode {
  return (
    <div className="wrap">
      <SectionHead
        index="07"
        eyebrow="Holder status"
        title="Four rungs of status. Zero claim on anyone's money."
        lede={
          <>
            Hold enough <TokenMark quiet /> and the app treats you differently — badge,
            short handle, bigger rooms. The ladder is <strong>status and
            capacity</strong>; the revenue share needs no tier at all.
          </>
        }
        aside="Perks.tierOf · 4 tiers"
      />

      <ol className={s.rungs}>
        {PERK_LADDER.map((spec) => (
          <li className={s.rung} key={spec.id} data-reveal>
            <div className={s.rungHead}>
              <span className={s.rungIndex}>{`T${spec.id}`}</span>
              <span className={s.rungRule} aria-hidden="true" />
            </div>

            <h3 className={s.rungName}>{spec.label}</h3>

            <div className={s.rungThreshold}>
              <span className={s.rungPct}>{spec.supplyPct}</span>
              <span className={s.rungAmount}>
                {`of supply · ${formatCount(spec.thood)} THOOD`}
              </span>
            </div>

            <ul className={s.unlocks}>
              {spec.unlocks.map((unlock) => (
                <li className={s.unlock} key={unlock}>
                  <span className={s.unlockMark} aria-hidden="true" />
                  {unlock}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>

      <div className={s.mechanics} data-reveal>
        <div className={s.mechanic}>
          <span className={s.mechanicLabel}>No flash-buying a rank</span>
          <p className={s.mechanicBody}>
            A tier is judged on the <strong>lower</strong> of your balance now and your
            balance at the last weekly revenue snapshot. It has to be held through a
            snapshot to count — and selling drops it immediately.
          </p>
        </div>

        <div className={s.mechanic}>
          <span className={s.mechanicLabel}>The money needs no ladder</span>
          <p className={s.mechanicBody}>
            The revenue share is paid pro-rata to <strong>every</strong> holder from day
            one, at every size. The ladder is status and capacity, never a claim on
            anyone else&apos;s money.
          </p>
        </div>

        <div className={s.mechanicAction}>
          <Link
            href="/access"
            className={buttonClassName({ variant: 'ghost', size: 'md' })}
          >
            See your rung on /access
          </Link>
        </div>
      </div>
    </div>
  );
}
