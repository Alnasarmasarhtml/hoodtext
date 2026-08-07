import type { ReactNode } from 'react';

import s from './Logo.module.css';

/**
 * The HoodGram mark.
 *
 * A block cut with the same 6px corner notch that shapes every button and panel on this site, taken
 * twice — top-right and bottom-left — so it reads as a sealed page. Two bars are knocked out of it:
 * one full line and one short one, the shape of a redacted paragraph.
 *
 * That is the product in one glyph: text you can see the shape of and cannot read. It is drawn as
 * geometry rather than set in a typeface, so it stays crisp from 16px favicon to a billboard, and it
 * inherits `currentColor` so a single component serves the header, the footer and the app chrome.
 */

export interface LogoMarkProps {
  /** Rendered size in px. The geometry is a 32-unit grid, so any size stays exact. */
  readonly size?: number;
  readonly className?: string;
}

export function LogoMark({ size = 16, className }: LogoMarkProps): ReactNode {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      {/* fillRule evenodd knocks the two bars out of the block, so the mark is a
          single path and the bars show whatever is behind the logo. */}
      <path
        fill="currentColor"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M3 3 H22 L29 10 V29 H10 L3 22 Z
           M9 12.6 H23 V15.8 H9 Z
           M9 18.1 H17 V21.3 H9 Z"
      />
    </svg>
  );
}

export interface LogoProps {
  /** Mark size in px; the wordmark scales alongside it. */
  readonly size?: number;
  /** Drop the wordmark and render the mark alone. */
  readonly markOnly?: boolean;
  readonly className?: string;
}

/** Mark plus wordmark, locked at the proportions the brand is set in. */
export function Logo({ size = 18, markOnly = false, className }: LogoProps): ReactNode {
  return (
    <span className={[s.lockup, className].filter(Boolean).join(' ')}>
      <LogoMark size={size} className={s.mark} />
      {!markOnly && (
        <span className={s.wordmark} style={{ fontSize: `${size * 0.95}px` }}>
          HOODGRAM
        </span>
      )}
    </span>
  );
}
