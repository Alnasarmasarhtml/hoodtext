'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

import { Eyebrow, buttonClassName } from '@/components/ui';
import { PRICES } from '@/lib/abi';
import { cx } from '@/lib/cx';
import { formatToken, formatUsd, formatUsd18 } from '@/lib/format';
import { PRELAUNCH } from '@/lib/launch';
import type { UseActivationResult } from '@/hooks';
import s from './LockedNotice.module.css';

export interface LockedNoticeProps {
  readonly activation: UseActivationResult;
  /** `page` fills the empty pane; `inline` replaces the composer. */
  readonly variant?: 'page' | 'inline';
  readonly className?: string;
}

function priceLine(activation: UseActivationResult): string {
  const price =
    activation.priceUsd === null || PRELAUNCH
      ? formatUsd(PRICES.activationUsd, 0)
      : formatUsd18(activation.priceUsd, 0);
  if (PRELAUNCH || activation.quote === null) return `${price}, once, paid in $GRAM`;
  return `${price} once · ${formatToken(activation.quote, { digits: 2, symbol: 'GRAM' })} at today's rate`;
}

/**
 * The designed locked state (SPEC §7.3).
 *
 * Never a dead end and never a wall in front of history: activation is $5 in
 * $GRAM, once, forever — no subscription, no expiry, nothing to renew. It
 * quotes the price live, links to `/access`, and says plainly that reading
 * and receiving are unaffected. An unactivated wallet lacks the composer and
 * nothing else.
 */
export function LockedNotice({
  activation,
  variant = 'page',
  className,
}: LockedNoticeProps): ReactNode {
  if (variant === 'inline') {
    return (
      <div className={cx(s.inline, className)} role="note">
        <span className={s.inlineMark} aria-hidden="true" />
        <div className={s.inlineBody}>
          <span className={s.inlineTitle}>Sending needs an activated account</span>
          <p className={s.inlineText}>
            You can still read this thread and receive new messages. Nothing here is hidden or
            deleted. Activation is {priceLine(activation)}. Pay it once and it is yours forever.
          </p>
        </div>
        <Link
          href="/access"
          className={cx(buttonClassName({ variant: 'primary', size: 'sm' }), s.inlineCta)}
        >
          Activate
        </Link>
      </div>
    );
  }

  return (
    <section className={cx(s.panel, className)} aria-labelledby="locked-title">
      <div className={s.head}>
        <Eyebrow rule>Access · Activation</Eyebrow>
        <h2 id="locked-title" className={s.title}>
          $5. Once. Forever.
        </h2>
        <p className={s.lede}>
          One payment in $GRAM activates this account for good. No subscription, no tiers, no
          expiry, nothing to renew. The price is fixed in dollars on chain and converted to $GRAM
          at the moment you pay, so the dollar price is stable as the token moves.
        </p>
      </div>

      <dl className={s.facts}>
        <div className={s.fact}>
          <dt className={s.factLabel}>Price</dt>
          <dd className={s.factValue}>
            {activation.priceUsd === null
              ? formatUsd(PRICES.activationUsd, 0)
              : formatUsd18(activation.priceUsd, 0)}
            <span className={s.factUnit}>one time, forever</span>
          </dd>
        </div>
        <div className={s.fact}>
          <dt className={s.factLabel}>Paid in</dt>
          <dd className={s.factValue}>
            {PRELAUNCH || activation.quote === null ? (
              <>
                $GRAM
                <span className={s.factUnit}>at the live rate when you pay</span>
              </>
            ) : (
              <>
                {formatToken(activation.quote, { digits: 2 })}
                <span className={s.factUnit}>GRAM, at today&apos;s rate</span>
              </>
            )}
          </dd>
        </div>
        <div className={s.fact}>
          <dt className={s.factLabel}>Per message</dt>
          <dd className={s.factValue}>
            $0.00
            <span className={s.factUnit}>the relay posts for you</span>
          </dd>
        </div>
      </dl>

      <ul className={s.rules}>
        <li className={s.rule}>
          <span className={s.ruleMark} aria-hidden="true" />
          <span>
            Messages are never charged. The relay anchors your drops for you: no transaction, no
            gas, no wallet popup per message.
          </span>
        </li>
        <li className={s.rule}>
          <span className={s.ruleMark} aria-hidden="true" />
          <span>
            Activation also unlocks handles: claim a free @name so people can reach you without
            your address.
          </span>
        </li>
        <li className={s.rule}>
          <span className={s.ruleMark} aria-hidden="true" />
          <span>
            Rooms are the only recurring cost: ${PRICES.roomUsdPerMonth}/month per room, paid by
            whoever runs it. Being a member is free.
          </span>
        </li>
        <li className={s.rule}>
          <span className={s.ruleMark} aria-hidden="true" />
          <span>
            Half of every payment goes to $GRAM holders, by holdings. No staking, no lock-up.
          </span>
        </li>
      </ul>

      <div className={s.actions}>
        <Link href="/access" className={buttonClassName({ variant: 'primary', size: 'lg' })}>
          Activate for $5
        </Link>
        <span className={s.actionNote}>
          Reading and receiving keep working either way. Activation gates sending and nothing
          else.
        </span>
      </div>
    </section>
  );
}
