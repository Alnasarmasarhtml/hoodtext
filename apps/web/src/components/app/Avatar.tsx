'use client';

import { useId, type ReactNode } from 'react';

import { cx } from '@/lib/cx';
import s from './Avatar.module.css';

/**
 * The identity mark: everyone wears the hood.
 *
 * Every user renders as the same hooded figure, drawn fresh from their address
 * at render time. Nothing is stored, nothing is fetched, and nobody chooses a
 * look, which is exactly why nobody can choose YOUR look: the address decides
 * the eye colour, the plate tint, the hood tone, the tilt, the facing and the
 * eye style, so a copycat's hood betrays them in every list.
 *
 * Deterministic and viewer-independent: the same address draws the same hood
 * on every device, forever. Rooms wear the same hood on a square plate with
 * the house corner cut, so room-versus-person reads from shape alone.
 *
 * Colour discipline:
 *  · The eye and the plate carry the colour, at full saturation on the eye and
 *    jewel-dark on the plate. The hood itself stays in the bone family with a
 *    whisper of the plate hue, because the figure is the constant and the
 *    colour is the identity.
 *  · The 95°–155° green band is cut from every hue roll. Green is the reserved
 *    accent: it means "on chain", and it is the logo's own eye.
 */

/** FNV-1a, 32-bit, over the lowercased seed. */
function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/** Small deterministic stream: xorshift over the seed hash, values in [0,1). */
function makeStream(seed: string): () => number {
  let h = hash32(seed.toLowerCase()) || 0x9e3779b9;
  return () => {
    h ^= h << 13;
    h >>>= 0;
    h ^= h >> 17;
    h ^= h << 5;
    h >>>= 0;
    return h / 4294967296;
  };
}

/** A hue that is never the reserved green (95°–155°), uniform elsewhere. */
function hueFor(roll: number): number {
  const raw = Math.floor(roll * 300);
  return raw < 95 ? raw : raw + 60;
}

export type AvatarSize = 'sm' | 'md' | 'lg';

export interface AvatarProps {
  /** What the hood is derived from: an address, a group id, a convo id. */
  readonly seed: string;
  readonly size?: AvatarSize;
  /** Rooms get the notched square plate; people get the circle. */
  readonly square?: boolean;
  readonly className?: string;
}

export function Avatar({ seed, size = 'md', square = false, className }: AvatarProps): ReactNode {
  const uid = useId();
  const rnd = makeStream(seed);

  /* One roll per trait, in a fixed order so looks never shift between builds. */
  const eyeHue = hueFor(rnd());
  const plateHue = hueFor(rnd());
  const flip = rnd() < 0.5;
  const tone = 58 + Math.floor(rnd() * 26); /* hood lightness, 58..83 */
  const tilt = (rnd() * 2 - 1) * 8;
  const eyeW = 14 + Math.floor(rnd() * 7); /* 14..20 */
  const twin = rnd() < 0.18; /* the rare second slash */
  const plateLight = 13 + Math.floor(rnd() * 6); /* 13..18 */

  const eye = `hsl(${eyeHue} 100% 62%)`;
  const plateTop = `hsl(${plateHue} 52% ${plateLight + 5}%)`;
  const plateBottom = `hsl(${plateHue} 62% ${Math.max(7, plateLight - 5)}%)`;
  const hood = `hsl(${plateHue} 9% ${tone}%)`;
  const hoodDark = `hsl(${plateHue} 11% ${tone - 19}%)`;
  const hoodRim = `hsl(${plateHue} 14% ${Math.min(94, tone + 17)}%)`;

  const gradId = `${uid}g`;
  const clipId = `${uid}c`;

  const plate = square ? (
    <path d="M0 0 H52.5 L64 11.5 V64 H11.5 L0 52.5 Z" fill={`url(#${gradId})`} />
  ) : (
    <circle cx="32" cy="32" r="32" fill={`url(#${gradId})`} />
  );

  const clipShape = square ? (
    <path d="M0 0 H52.5 L64 11.5 V64 H11.5 L0 52.5 Z" />
  ) : (
    <circle cx="32" cy="32" r="32" />
  );

  /* The eye: a blurred copy underneath for the glow, then the core slash. A
     layered-rect glow was tried first to avoid filters and it read as a solid
     pill at list size; the real blur is what makes the line read as light. */
  const eyeX = 42 - eyeW / 2;
  const blurId = `${uid}b`;

  return (
    <span className={cx(s.avatar, s[size], className)} aria-hidden="true">
      <svg viewBox="0 0 64 64" role="img">
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0.4" y2="1">
            <stop offset="0" stopColor={plateTop} />
            <stop offset="1" stopColor={plateBottom} />
          </linearGradient>
          <clipPath id={clipId}>{clipShape}</clipPath>
          <filter id={blurId} x="-80%" y="-400%" width="260%" height="900%">
            <feGaussianBlur stdDeviation="2.4" />
          </filter>
        </defs>

        {plate}

        <g clipPath={`url(#${clipId})`}>
          <g transform={flip ? 'translate(64 0) scale(-1 1)' : undefined}>
            {/* back fold */}
            <path
              d="M20 56 C14 40 16 24 30 15 C44 7 56 16 57 32 C58 44 54 52 50 56 Z"
              fill={hoodDark}
            />
            {/* main cowl */}
            <path
              d="M14 56 C8 38 12 20 28 12 C40 6 50 12 52 24 C48 22 42 22 38 26 C30 33 28 44 30 56 Z"
              fill={hood}
            />
            {/* rim light along the leading edge */}
            <path
              d="M28 12 C40 6 50 12 52 24 C50 23 48 22.5 46 22.6 C44 15 36 11 28 12 Z"
              fill={hoodRim}
            />
            {/* the opening */}
            <path
              d="M30 56 C28 44 30 33 38 26 C44 21 50 22 52 24 C54 34 53 47 50 56 Z"
              fill="#050607"
            />
            {/* the eye */}
            <g transform={`rotate(${tilt.toFixed(1)} 42 38)`}>
              <rect
                x={eyeX}
                y="36.6"
                width={eyeW}
                height="2.8"
                rx="1.4"
                fill={eye}
                opacity="0.55"
                filter={`url(#${blurId})`}
              />
              <rect x={eyeX} y="36.6" width={eyeW} height="2.8" rx="1.4" fill={eye} />
              {twin && (
                <rect
                  x={eyeX + eyeW * 0.28}
                  y="42.4"
                  width={eyeW * 0.5}
                  height="2.1"
                  rx="1.05"
                  fill={eye}
                  opacity="0.7"
                />
              )}
            </g>
          </g>
        </g>
      </svg>
    </span>
  );
}
