'use client';

/**
 * The one shape every non-blocking message in the messenger takes.
 *
 * A hairline rule, a mono title, one sentence of plain language, optional mono
 * metadata, and an optional action pinned to the right. Used for storage
 * warnings, relay failures, missing recipient keys and decoded chain errors —
 * so no state in `/app` is ever a bare string dropped into the layout.
 */

import type { ReactNode } from 'react';

import { cx } from '@/lib/cx';
import s from './AppNotice.module.css';

export type AppNoticeTone = 'info' | 'warn' | 'error';

export interface AppNoticeProps {
  /** `warn` and `error` are crimson-adjacent; `info` is steel. */
  readonly tone?: AppNoticeTone;
  readonly title: ReactNode;
  readonly body?: ReactNode;
  /** Small mono line under the body — a tx hash, a seq, a revert name. */
  readonly meta?: ReactNode;
  readonly action?: ReactNode;
  readonly className?: string;
}

export function AppNotice({
  tone = 'info',
  title,
  body,
  meta,
  action,
  className,
}: AppNoticeProps): ReactNode {
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
