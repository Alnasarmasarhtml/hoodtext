'use client';

import {
  createElement,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from 'react';

import { cx } from '@/lib/cx';
import { shapeClass, type Notch } from '@/lib/notch';
import s from './Panel.module.css';

export type PanelTone = 'raised' | 'inset' | 'void';
export type PanelPadding = 'none' | 'sm' | 'md' | 'lg';

export type PanelTag =
  | 'div'
  | 'section'
  | 'article'
  | 'aside'
  | 'header'
  | 'footer'
  | 'nav'
  | 'form'
  | 'li'
  | 'ul'
  | 'ol';

export interface PanelProps extends ComponentPropsWithoutRef<'div'> {
  /** Semantic element. Default `div`. */
  readonly as?: PanelTag;
  /** `raised` = --panel, `inset` = --panel-2, `void` = --void. */
  readonly tone?: PanelTone;
  /** Corner notch. Default `tr` — panels and buttons cut opposite corners. */
  readonly notch?: Notch;
  /** Draw the 1px top highlight (the only shadow this system allows). */
  readonly highlight?: boolean;
  /** Use the brighter hairline. */
  readonly strong?: boolean;
  readonly padding?: PanelPadding;
  /** Hover/focus affordance for panels that are themselves clickable. */
  readonly interactive?: boolean;
}

/**
 * Matte surface with a true 1px hairline that follows the notch.
 *
 * The panel element paints the edge colour; a `::before` inset by exactly 1px
 * paints the interior. Both are clipped, so the diagonal never loses its line —
 * which is what a `border` + `clip-path` would do.
 */
export function Panel({
  as = 'div',
  tone = 'raised',
  notch = 'tr',
  highlight = false,
  strong = false,
  padding = 'none',
  interactive = false,
  className,
  children,
  ...rest
}: PanelProps): ReactNode {
  return createElement(
    as,
    {
      ...rest,
      className: cx(
        s.panel,
        s[tone],
        s[`pad-${padding}`],
        highlight && s.highlight,
        strong && s.strong,
        interactive && s.interactive,
        shapeClass(notch),
        className,
      ),
    },
    children,
  );
}

export interface PanelHeaderProps extends ComponentPropsWithoutRef<'div'> {
  /** Uppercase mono eyebrow — the panel's name. */
  readonly label: ReactNode;
  /** One quiet line under the label. */
  readonly note?: ReactNode;
  /** Right-aligned controls or status. */
  readonly aside?: ReactNode;
}

/** Hairline-separated header row. Keeps every panel titled the same way. */
export function PanelHeader({
  label,
  note,
  aside,
  className,
  children,
  ...rest
}: PanelHeaderProps): ReactNode {
  return (
    <div {...rest} className={cx(s.header, className)}>
      <div className={s.headerTitle}>
        <span className={s.headerLabel}>{label}</span>
        {note !== undefined && <span className={s.headerNote}>{note}</span>}
      </div>
      {(aside !== undefined || children !== undefined) && (
        <div className={s.headerAside}>
          {aside}
          {children}
        </div>
      )}
    </div>
  );
}
