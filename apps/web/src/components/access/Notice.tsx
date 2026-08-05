'use client';

/**
 * The two shapes every state on `/access` is allowed to take.
 *
 * `Notice` is an inline strip — a wrong network, a decoded chain error, a
 * caveat about a bounded log scan. `EmptyState` fills a panel that has nothing
 * to show, and always says *why* it is empty and what happens next. SPEC §7.4:
 * never a blank.
 */

import type { ReactNode } from 'react';

import { cx } from '@/lib/cx';
import s from './Notice.module.css';

export type NoticeTone = 'info' | 'warn' | 'error' | 'ok';

export interface NoticeProps {
  readonly tone?: NoticeTone;
  readonly title: ReactNode;
  readonly body?: ReactNode;
  /** Buttons or links. Kept to the right on wide rows, below on narrow ones. */
  readonly action?: ReactNode;
  /** Small mono line under the body — a tx hash, a block range, a revert name. */
  readonly meta?: ReactNode;
  readonly className?: string;
}

export function Notice({
  tone = 'info',
  title,
  body,
  action,
  meta,
  className,
}: NoticeProps): ReactNode {
  return (
    <div
      className={cx(s.notice, s[tone], className)}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      <span className={s.rule} aria-hidden="true" />

      <div className={s.body}>
        <span className={s.title}>{title}</span>
        {body !== undefined && <p className={s.text}>{body}</p>}
        {meta !== undefined && <span className={s.meta}>{meta}</span>}
      </div>

      {action !== undefined && <div className={s.action}>{action}</div>}
    </div>
  );
}

export interface EmptyStateProps {
  /** Mono uppercase kicker, e.g. "NOT ACTIVATED". */
  readonly eyebrow?: string;
  readonly title: ReactNode;
  readonly body: ReactNode;
  readonly action?: ReactNode;
  /** Renders the hairline diagram block. Default true. */
  readonly mark?: boolean;
  readonly className?: string;
}

export function EmptyState({
  eyebrow,
  title,
  body,
  action,
  mark = true,
  className,
}: EmptyStateProps): ReactNode {
  return (
    <div className={cx(s.empty, className)}>
      {mark && (
        <svg className={s.mark} viewBox="0 0 44 30" aria-hidden="true">
          <path d="M.5 21.5h9l4-13 5 21 5-16 3.5 8h16.5" />
        </svg>
      )}

      {eyebrow !== undefined && <span className={s.emptyEyebrow}>{eyebrow}</span>}
      <span className={s.emptyTitle}>{title}</span>
      <p className={s.emptyBody}>{body}</p>
      {action !== undefined && <div className={s.emptyAction}>{action}</div>}
    </div>
  );
}
