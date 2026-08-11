'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Address } from 'viem';

import {
  useAdminRentAlert,
  useHandle,
  usePerkTier,
  type UseActivationResult,
} from '@/hooks';
import { cx } from '@/lib/cx';
import { formatDuration, formatToken, truncateAddress } from '@/lib/format';
import { PerkChip } from './PerkChip';
import s from './AccountBadge.module.css';

export interface AccountBadgeProps {
  readonly activation: UseActivationResult;
  readonly address: Address | null;
  readonly connected: boolean;
}

/**
 * The persistent, quiet account readout in the app chrome (SPEC §7.3).
 *
 * An activated account shows its @handle (or short address) and holder rank —
 * there is nothing to expire, so there is no countdown. An unactivated one
 * shows the $5 one-time price, quoted live in $GRAM, with `/access` always
 * one step away. If a room this wallet administers is inside its 3-day rent
 * window, a quiet warning appears — a prompt, never a gate: rent lapse blocks
 * new messages in that room and nothing else.
 */
export function AccountBadge({
  activation,
  address,
  connected,
}: AccountBadgeProps): ReactNode {
  const handle = useHandle(connected ? address : null);
  const tier = usePerkTier(connected ? address : null);
  const rentAlert = useAdminRentAlert(connected ? address : null);

  if (!connected || address === null) {
    return (
      <span className={cx(s.badge, s.idle)}>
        <span className={s.label}>Account</span>
        <span className={s.value}>Not connected</span>
      </span>
    );
  }

  if (!activation.isDeployed) {
    return (
      <span className={cx(s.badge, s.idle)}>
        <span className={s.label}>Account</span>
        <span className={s.value}>No deployment</span>
      </span>
    );
  }

  if (activation.isLoading) {
    return (
      <span className={cx(s.badge, s.idle)} aria-busy="true">
        <span className={s.label}>Account</span>
        <span className={s.value}>Reading chain…</span>
      </span>
    );
  }

  if (!activation.isActivated) {
    const quote = activation.quote;
    return (
      <span className={cx(s.badge, s.locked)}>
        <span className={s.dot} aria-hidden="true" />
        <span className={s.label}>Account</span>
        <span className={s.value}>Not active</span>
        <Link href="/access" className={s.action}>
          {/* The live quote is the honest version of this CTA, but it is the
              first thing to give up when the strip runs out of room. */}
          <span className={s.actionLong}>
            {quote === null
              ? 'Activate · $5 once'
              : `Activate · ${formatToken(quote, { digits: 0, compact: true })} GRAM`}
          </span>
          <span className={s.actionShort}>Activate</span>
        </Link>
      </span>
    );
  }

  const name = handle === null ? truncateAddress(address) : `@${handle}`;

  if (rentAlert !== null) {
    const now = Math.floor(Date.now() / 1000);
    return (
      <span className={cx(s.badge, s.warn)}>
        <span className={s.dot} aria-hidden="true" />
        <span className={s.value}>{name}</span>
        <PerkChip tier={tier} />
        <Link
          href="/access"
          className={s.action}
          title={`Room “${rentAlert.room.name}”. Rent ${
            rentAlert.lapsed ? 'has lapsed' : `lapses in ${formatDuration(rentAlert.paidUntil - now)}`
          }. Paying reopens it exactly as it was.`}
        >
          <span className={s.actionLong}>
            {rentAlert.lapsed
              ? 'Room rent lapsed'
              : `Room rent · ${formatDuration(rentAlert.paidUntil - now, { showSeconds: false })}`}
          </span>
          <span className={s.actionShort}>Rent</span>
        </Link>
      </span>
    );
  }

  return (
    <span className={cx(s.badge, s.active)}>
      <span className={s.dot} aria-hidden="true" />
      <span className={s.value} title={address}>
        {name}
      </span>
      <PerkChip tier={tier} />
    </span>
  );
}
