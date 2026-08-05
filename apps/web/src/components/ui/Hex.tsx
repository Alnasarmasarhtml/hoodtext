'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { cx } from '@/lib/cx';
import { truncateHex } from '@/lib/format';
import s from './Hex.module.css';

export type HexTone = 'bone' | 'muted' | 'dim' | 'steel';

export interface HexProps {
  readonly value: string;
  /** Leading hex characters after `0x`. Default 6. */
  readonly lead?: number;
  /** Trailing hex characters. Default 4. */
  readonly tail?: number;
  /** Show the whole value; CSS still keeps it from widening its column. */
  readonly full?: boolean;
  /** Screen-reader prefix, e.g. "Anchors contract". */
  readonly label?: string;
  /** Explorer URL. `null` renders no link, which is the honest state offline. */
  readonly href?: string | null;
  /** Default true. */
  readonly copy?: boolean;
  readonly tone?: HexTone;
  readonly size?: 'sm' | 'md';
  readonly className?: string;
}

type CopyState = 'idle' | 'copied' | 'failed';

async function writeClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through to the legacy path — clipboard access may be denied */
    }
  }

  if (typeof document === 'undefined') return false;
  const scratch = document.createElement('textarea');
  scratch.value = text;
  scratch.setAttribute('readonly', '');
  scratch.style.position = 'fixed';
  scratch.style.top = '-1000px';
  scratch.style.opacity = '0';
  document.body.appendChild(scratch);
  scratch.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(scratch);
  return ok;
}

/**
 * Truncated hex with click-to-copy.
 *
 * Truncation is deterministic (`0x1a2b3c…9f8e`) rather than CSS-only, so the
 * tail — the part people actually compare — is always visible, and the element
 * can never widen its column (SPEC §7.5).
 */
export function Hex({
  value,
  lead = 6,
  tail = 4,
  full = false,
  label,
  href,
  copy = true,
  tone = 'bone',
  size = 'md',
  className,
}: HexProps): ReactNode {
  const [state, setState] = useState<CopyState>('idle');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  const onCopy = useCallback((): void => {
    void writeClipboard(value).then((ok) => {
      setState(ok ? 'copied' : 'failed');
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setState('idle'), 1400);
    });
  }, [value]);

  const shown = full ? value : truncateHex(value, lead, tail);
  const toneClass = tone === 'bone' ? undefined : s[tone];

  return (
    <span className={cx(s.hex, size === 'sm' && s.sm, toneClass, className)}>
      <span className={s.value} title={value}>
        {label !== undefined && <span className="sr-only">{label}: </span>}
        {shown}
      </span>

      {copy && (
        <button
          type="button"
          className={s.action}
          onClick={onCopy}
          aria-label={`Copy ${label ?? 'value'}`}
        >
          <svg className={s.icon} viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3.5 3.5V1.5h7v7h-2" />
            <path d="M1.5 3.5h7v7h-7z" />
          </svg>
        </button>
      )}

      {href !== undefined && href !== null && (
        <a
          className={s.action}
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          aria-label={`Open ${label ?? 'value'} in the block explorer`}
        >
          <svg className={s.icon} viewBox="0 0 12 12" aria-hidden="true">
            <path d="M4.5 1.5h6v6" />
            <path d="M10.5 1.5 4 8" />
            <path d="M8 10.5H1.5V4" />
          </svg>
        </a>
      )}

      {state !== 'idle' && (
        <span
          className={cx(s.copied, state === 'failed' && s.failed)}
          role="status"
        >
          {state === 'copied' ? 'Copied' : 'Copy blocked'}
        </span>
      )}
    </span>
  );
}
