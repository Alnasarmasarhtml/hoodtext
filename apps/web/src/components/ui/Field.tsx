'use client';

import { useId, type ComponentPropsWithoutRef, type ReactNode } from 'react';

import { cx } from '@/lib/cx';
import { Label } from './Label';
import s from './Field.module.css';

export interface FieldProps
  extends Omit<ComponentPropsWithoutRef<'input'>, 'children' | 'prefix'> {
  readonly label: ReactNode;
  /** Quiet explanation under the control. Hidden while `error` is set. */
  readonly hint?: ReactNode;
  /** Right-aligned note on the label row, e.g. "optional". */
  readonly labelHint?: ReactNode;
  /** Non-empty string switches the field into its invalid state. */
  readonly error?: string;
  /** Mono input face — use for addresses, hex and amounts. */
  readonly mono?: boolean;
  readonly prefix?: ReactNode;
  readonly suffix?: ReactNode;
  /** Class for the outer wrapper (the input keeps its own styling). */
  readonly className?: string;
}

/**
 * Underlined input. The resting hairline sits at `--line-2`; on focus an green
 * hairline wipes in over it from the left — the only motion in the control, and
 * the only place green appears in a form.
 */
export function Field({
  label,
  hint,
  labelHint,
  error,
  mono = false,
  prefix,
  suffix,
  className,
  id,
  disabled,
  ...rest
}: FieldProps): ReactNode {
  const generatedId = useId();
  const inputId = id ?? `field-${generatedId}`;
  const describedBy = `${inputId}-note`;
  const invalid = error !== undefined && error !== '';

  return (
    <div className={cx(s.field, mono && s.mono, invalid && s.invalid, className)}>
      <Label htmlFor={inputId} hint={labelHint}>
        {label}
      </Label>

      <div className={s.control}>
        {prefix !== undefined && <span className={s.affix}>{prefix}</span>}
        <input
          {...rest}
          id={inputId}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid || hint !== undefined ? describedBy : undefined}
          className={s.input}
        />
        {suffix !== undefined && <span className={s.affix}>{suffix}</span>}
      </div>

      {invalid ? (
        <p id={describedBy} className={s.error} role="alert">
          <span className={s.errorMark} aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : (
        hint !== undefined && (
          <p id={describedBy} className={s.footnote}>
            {hint}
          </p>
        )
      )}
    </div>
  );
}
