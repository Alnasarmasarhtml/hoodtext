'use client';

import {
  useCallback,
  useId,
  useRef,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';

import { cx } from '@/lib/cx';
import s from './MonthStepper.module.css';

export interface MonthStepperProps {
  readonly value: number;
  readonly onChange: (months: number) => void;
  /** Default 1. */
  readonly min?: number;
  /** Default 24 — `Subscription.MAX_MONTHS`. */
  readonly max?: number;
  readonly disabled?: boolean;
  /** Accessible name. Default "Months". */
  readonly label?: string;
  /** Quick picks under the track. Pass `[]` to hide them. */
  readonly presets?: readonly number[];
  readonly className?: string;
}

const DEFAULT_PRESETS = [1, 3, 6, 12, 24] as const;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * The month control for `/access`.
 *
 * A segmented track of discrete months: click a tick, drag across the track, or
 * drive it from the keyboard as a real `role="slider"`. No native number input,
 * no range slider — both look like every other site and neither shows the whole
 * 1–24 range at a glance.
 */
export function MonthStepper({
  value,
  onChange,
  min = 1,
  max = 24,
  disabled = false,
  label = 'Months',
  presets = DEFAULT_PRESETS,
  className,
}: MonthStepperProps): ReactNode {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const labelId = useId();
  const current = clamp(value, min, max);
  const count = max - min + 1;

  const commit = useCallback(
    (next: number): void => {
      if (disabled) return;
      const clamped = clamp(next, min, max);
      if (clamped !== current) onChange(clamped);
    },
    [current, disabled, max, min, onChange],
  );

  const fromPointer = useCallback(
    (clientX: number): number => {
      const track = trackRef.current;
      if (track === null) return current;
      const rect = track.getBoundingClientRect();
      if (rect.width <= 0) return current;
      const ratio = (clientX - rect.left) / rect.width;
      const index = Math.floor(ratio * count);
      return clamp(min + index, min, max);
    },
    [count, current, max, min],
  );

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>): void => {
      if (disabled) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      trackRef.current?.focus();
      commit(fromPointer(event.clientX));
    },
    [commit, disabled, fromPointer],
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>): void => {
      if (disabled) return;
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
      commit(fromPointer(event.clientX));
    },
    [commit, disabled, fromPointer],
  );

  const handlePointerUp = useCallback((event: PointerEvent<HTMLDivElement>): void => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      if (disabled) return;
      const step = event.shiftKey ? 3 : 1;
      switch (event.key) {
        case 'ArrowLeft':
        case 'ArrowDown':
          event.preventDefault();
          commit(current - step);
          return;
        case 'ArrowRight':
        case 'ArrowUp':
          event.preventDefault();
          commit(current + step);
          return;
        case 'PageDown':
          event.preventDefault();
          commit(current - 3);
          return;
        case 'PageUp':
          event.preventDefault();
          commit(current + 3);
          return;
        case 'Home':
          event.preventDefault();
          commit(min);
          return;
        case 'End':
          event.preventDefault();
          commit(max);
          return;
        default:
      }
    },
    [commit, current, disabled, max, min],
  );

  const ticks: ReactNode[] = [];
  for (let i = 0; i < count; i += 1) {
    const month = min + i;
    ticks.push(
      <span
        key={month}
        className={cx(
          s.tick,
          month <= current && s.filled,
          month === current && s.head,
          month % 6 === 0 && s.marker,
          disabled && s.disabled,
        )}
      >
        <span className={s.tickInner} />
      </span>,
    );
  }

  return (
    <div className={cx(s.stepper, className)}>
      <div className={s.row}>
        <button
          type="button"
          className={s.key}
          onClick={() => commit(current - 1)}
          disabled={disabled || current <= min}
          aria-label="One month fewer"
        >
          <svg className={s.glyph} viewBox="0 0 12 12" aria-hidden="true">
            <path d="M1 6h10" />
          </svg>
        </button>

        <div
          ref={trackRef}
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-labelledby={labelId}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={current}
          aria-valuetext={`${current} ${current === 1 ? 'month' : 'months'}`}
          aria-disabled={disabled || undefined}
          className={cx(s.track, disabled && s.trackDisabled)}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onKeyDown={handleKeyDown}
        >
          {ticks}
        </div>

        <button
          type="button"
          className={s.key}
          onClick={() => commit(current + 1)}
          disabled={disabled || current >= max}
          aria-label="One month more"
        >
          <svg className={s.glyph} viewBox="0 0 12 12" aria-hidden="true">
            <path d="M6 1v10M1 6h10" />
          </svg>
        </button>
      </div>

      <div className={s.readout}>
        <span className={s.value}>
          <span id={labelId} className="sr-only">
            {label}
          </span>
          {current}
          <span className={s.valueUnit}>{current === 1 ? 'month' : 'months'}</span>
        </span>

        {presets.length > 0 && (
          <span className={s.presets}>
            {presets.map((preset) => (
              <button
                key={preset}
                type="button"
                className={cx(s.preset, preset === current && s.presetOn)}
                onClick={() => commit(preset)}
                disabled={disabled || preset < min || preset > max}
                aria-pressed={preset === current}
              >
                {preset}m
              </button>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}
