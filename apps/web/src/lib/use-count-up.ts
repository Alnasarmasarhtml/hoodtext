'use client';

import { useCallback, useEffect, useRef, type RefCallback } from 'react';
import { usePrefersReducedMotion } from './use-prefers-reduced-motion';

export interface CountUpOptions {
  /** Animation length in ms. Default 900. */
  readonly duration?: number;
  /** Render a raw number as display text. Default: `en-US` grouped integer. */
  readonly format?: (value: number) => string;
  /** Start value. Default 0. */
  readonly from?: number;
  /** Turn the animation off without changing the rendered value. Default true. */
  readonly enabled?: boolean;
  /** Only start once the element is on screen. Default true. */
  readonly whenVisible?: boolean;
}

const DEFAULT_FORMAT = new Intl.NumberFormat('en-US');

function defaultFormat(value: number): string {
  return DEFAULT_FORMAT.format(Math.round(value));
}

/** easeOutExpo — settles hard, like a readout locking on. */
function ease(t: number): number {
  return t >= 1 ? 1 : 1 - 2 ** (-10 * t);
}

/**
 * Count-up that cannot cause a hydration mismatch.
 *
 * React renders the *final* value; this hook then drives `textContent`
 * imperatively from `from` → `value` and restores the exact rendered string at
 * the end. The React tree is therefore identical on server and client, the DOM
 * is already correct with JavaScript disabled, and `prefers-reduced-motion`
 * simply leaves the rendered value untouched.
 *
 * @example
 * const ref = useCountUp<HTMLSpanElement>(totalDrops);
 * return <span ref={ref}>{formatCount(totalDrops)}</span>;
 */
export function useCountUp<T extends HTMLElement>(
  value: number,
  options: CountUpOptions = {},
): RefCallback<T> {
  const {
    duration = 900,
    format = defaultFormat,
    from = 0,
    enabled = true,
    whenVisible = true,
  } = options;

  const reduced = usePrefersReducedMotion();

  /* Latest-value refs keep inline option literals from restarting the
     animation on every render. */
  const formatRef = useRef(format);
  const durationRef = useRef(duration);
  const fromRef = useRef(from);
  formatRef.current = format;
  durationRef.current = duration;
  fromRef.current = from;

  const nodeRef = useRef<T | null>(null);
  const frameRef = useRef<number | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const finalTextRef = useRef<string>('');

  const stop = useCallback((): void => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  const run = useCallback((): void => {
    const node = nodeRef.current;
    if (node === null) return;

    stop();
    const start = performance.now();
    const begin = fromRef.current;
    const total = durationRef.current;
    const delta = value - begin;

    const step = (now: number): void => {
      const t = total <= 0 ? 1 : Math.min(1, (now - start) / total);
      if (t >= 1) {
        node.textContent = finalTextRef.current;
        frameRef.current = null;
        return;
      }
      node.textContent = formatRef.current(begin + delta * ease(t));
      frameRef.current = requestAnimationFrame(step);
    };

    node.textContent = formatRef.current(begin);
    frameRef.current = requestAnimationFrame(step);
  }, [stop, value]);

  useEffect(() => {
    const node = nodeRef.current;
    if (node === null) return;

    // Whatever React rendered is the authoritative final string.
    finalTextRef.current = node.textContent ?? '';

    if (!enabled || reduced || !Number.isFinite(value)) {
      stop();
      node.textContent = finalTextRef.current;
      return;
    }

    if (!whenVisible || typeof IntersectionObserver === 'undefined') {
      run();
      return stop;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          observer.disconnect();
          observerRef.current = null;
          run();
        }
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.01 },
    );
    observer.observe(node);
    observerRef.current = observer;

    return () => {
      observer.disconnect();
      observerRef.current = null;
      stop();
    };
  }, [enabled, reduced, run, stop, value, whenVisible]);

  return useCallback(
    (node: T | null) => {
      if (node === null) {
        observerRef.current?.disconnect();
        observerRef.current = null;
        stop();
      }
      nodeRef.current = node;
    },
    [stop],
  );
}
