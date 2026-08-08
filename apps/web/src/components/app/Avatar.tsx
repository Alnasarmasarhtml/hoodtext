'use client';

import type { ReactNode } from 'react';

import { cx } from '@/lib/cx';
import s from './Avatar.module.css';

/**
 * The identity disc.
 *
 * Almost everyone in this app is a wallet address until they register a handle,
 * and four rows reading `0x8f2a…`, `0x8f31…`, `0x8fa0…`, `0x8f0c…` are, at a
 * glance, the same row four times. A colour derived from the address fixes that
 * for free: it is stable forever, costs no storage and no request, and unlike a
 * pixel identicon it does not make the messenger look like a wallet.
 *
 * Two rules the colour has to obey:
 *
 *  · **Never green.** `--green` is the one reserved accent on this site. An
 *    avatar wandering into that hue would dilute the only colour that means
 *    something, so the green band is skipped outright.
 *  · **Same seed, same disc, forever.** The hash is over the lowercased
 *    identifier, so a checksummed and an unchecksummed address agree.
 */

/** FNV-1a, 32-bit. Small, fast, and good enough to scatter hue evenly. */
function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    /* The classic 16777619 multiply, done in 32-bit pieces so it stays exact
       in a double. */
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/**
 * A hue that is never the reserved green.
 *
 * Hues run 0–359. Roughly 95°–155° is green, so the wheel is treated as 300
 * wide and anything landing in that band is pushed past it. The result is still
 * uniform — no hue is twice as likely as another.
 */
function hueFor(seed: string): number {
  const raw = hash32(seed) % 300;
  return raw < 95 ? raw : raw + 60;
}

/** Up to two characters. Letters if there are any, otherwise hex. */
function monogramFor(label: string, seed: string): string {
  const letters = label.replace(/[^\p{L}\p{N}]/gu, '');
  if (letters.length > 0) return letters.slice(0, 2).toUpperCase();
  /* An address with no label: the two characters after `0x` are as good a
     token as any, and they visibly differ between similar addresses. */
  return seed.replace(/^0x/i, '').slice(0, 2).toUpperCase();
}

export type AvatarSize = 'sm' | 'md' | 'lg';

export interface AvatarProps {
  /** What the disc is derived from — an address, a group id, a convo id. */
  readonly seed: string;
  /** What it is called, for the monogram. Falls back to the seed's hex. */
  readonly label?: string;
  readonly size?: AvatarSize;
  /** Rooms get a square with the house corner cut; people get a circle. */
  readonly square?: boolean;
  readonly className?: string;
}

export function Avatar({
  seed,
  label = '',
  size = 'md',
  square = false,
  className,
}: AvatarProps): ReactNode {
  const key = seed.toLowerCase();
  const hue = hueFor(key);

  return (
    <span
      className={cx(s.avatar, s[size], square && s.square, className)}
      style={{
        /* Two stops off one hue: flat fills read as chips, a slight gradient
           reads as an object. */
        backgroundImage: `linear-gradient(145deg, hsl(${hue} 46% 52%), hsl(${hue} 54% 30%))`,
      }}
      aria-hidden="true"
    >
      {monogramFor(label, key)}
    </span>
  );
}
