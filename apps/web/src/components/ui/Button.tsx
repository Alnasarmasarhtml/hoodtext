'use client';

import type { ComponentPropsWithRef, ReactNode } from 'react';

import { cx } from '@/lib/cx';
import s from './Button.module.css';

export type ButtonVariant = 'primary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonStyleOptions {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly block?: boolean;
}

/**
 * Class string for the button surface.
 *
 * Exported so a `next/link` anchor can be a real CTA without wrapping a button
 * inside a link:
 * `<Link href="/access" className={buttonClassName({ variant: 'primary' })}>`
 */
export function buttonClassName(options: ButtonStyleOptions = {}): string {
  const { variant = 'ghost', size = 'md', block = false } = options;
  return cx(s.btn, s[variant], s[size], block && s.block);
}

/** Three staggered bars — a signal meter. Never a spinning circle. */
export function SignalBars({ className }: { className?: string }): ReactNode {
  return (
    <span className={cx(s.bars, className)} aria-hidden="true">
      <span className={s.bar} />
      <span className={s.bar} />
      <span className={s.bar} />
    </span>
  );
}

export interface ButtonProps
  extends Omit<ComponentPropsWithRef<'button'>, 'className'>,
    ButtonStyleOptions {
  /** Shows the 3-bar indicator and blocks interaction. */
  readonly loading?: boolean;
  /** Announced while `loading` is true. Default "Working". */
  readonly loadingLabel?: string;
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
  readonly className?: string;
}

export function Button({
  variant = 'ghost',
  size = 'md',
  block = false,
  loading = false,
  loadingLabel = 'Working',
  leading,
  trailing,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps): ReactNode {
  const isDisabled = disabled === true || loading;

  return (
    <button
      {...rest}
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={cx(
        buttonClassName({ variant, size, block }),
        loading && s.loading,
        className,
      )}
    >
      {loading ? <SignalBars /> : leading}
      <span className={s.label}>{children}</span>
      {loading ? <span className="sr-only">{loadingLabel}</span> : trailing}
    </button>
  );
}
