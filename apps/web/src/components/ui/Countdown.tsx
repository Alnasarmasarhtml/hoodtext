'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { cx } from '@/lib/cx';
import { SECONDS_PER_DAY, secondsUntil, splitDuration } from '@/lib/format';
import s from './Countdown.module.css';

export type CountdownSize = 'sm' | 'md' | 'lg';

export interface CountdownProps {
  /** Unix seconds — pass `Subscription.expiresAt(user)` straight through. */
  readonly to: bigint | number;
  /** Turn crimson at or below this many seconds. Default 3 days. */
  readonly warnSeconds?: number;
  /** Show the seconds field even when days remain. Default false. */
  readonly showSeconds?: boolean;
  readonly size?: CountdownSize;
  /** Rendered once the target has passed. Default "Expired". */
  readonly expiredLabel?: string;
  /** Fires once, on the tick that crosses zero. */
  readonly onExpire?: () => void;
  readonly className?: string;
}

const pad = (n: number): string => n.toString().padStart(2, '0');

/**
 * Live expiry readout: days / hours / minutes, tabular so it never reflows.
 *
 * Renders a neutral placeholder until mount — remaining time depends on the
 * wall clock, and server and client clocks do not agree.
 */
export function Countdown({
  to,
  warnSeconds = 3 * SECONDS_PER_DAY,
  showSeconds = false,
  size = 'md',
  expiredLabel = 'Expired',
  onExpire,
  className,
}: CountdownProps): ReactNode {
  const [remaining, setRemaining] = useState<number | null>(null);
  const firedRef = useRef(false);
  const target = typeof to === 'bigint' ? Number(to) : to;

  useEffect(() => {
    firedRef.current = false;

    const tick = (): void => {
      const next = secondsUntil(target);
      setRemaining(next);
      if (next <= 0 && !firedRef.current) {
        firedRef.current = true;
        onExpire?.();
      }
    };

    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [onExpire, target]);

  const sizeClass = s[size];

  if (remaining === null) {
    return (
      <span
        className={cx(s.countdown, sizeClass, s.pending, className)}
        aria-hidden="true"
      >
        <span className={s.group}>
          <span className={s.num}>--</span>
          <span className={s.unit}>d</span>
        </span>
        <span className={s.group}>
          <span className={s.num}>--</span>
          <span className={s.unit}>h</span>
        </span>
        <span className={s.group}>
          <span className={s.num}>--</span>
          <span className={s.unit}>m</span>
        </span>
      </span>
    );
  }

  if (remaining <= 0) {
    return (
      <span className={cx(s.countdown, sizeClass, className)} role="status">
        <span className={s.dot} aria-hidden="true" />
        <span className={s.expired}>{expiredLabel}</span>
      </span>
    );
  }

  const parts = splitDuration(remaining);
  const warn = remaining <= warnSeconds;
  const withSeconds = showSeconds || parts.days === 0;

  return (
    <span
      className={cx(s.countdown, sizeClass, warn && s.warn, className)}
      role="timer"
      aria-live="off"
    >
      {warn && <span className={s.dot} aria-hidden="true" />}
      <span className={s.group}>
        <span className={s.num}>{pad(parts.days)}</span>
        <span className={s.unit}>d</span>
      </span>
      <span className={s.group}>
        <span className={s.num}>{pad(parts.hours)}</span>
        <span className={s.unit}>h</span>
      </span>
      <span className={s.group}>
        <span className={s.num}>{pad(parts.minutes)}</span>
        <span className={s.unit}>m</span>
      </span>
      {withSeconds && (
        <span className={s.group}>
          <span className={s.num}>{pad(parts.seconds)}</span>
          <span className={s.unit}>s</span>
        </span>
      )}
    </span>
  );
}
