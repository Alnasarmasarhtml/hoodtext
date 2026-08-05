'use client';

import { useEffect, useRef, type ReactNode } from 'react';

import { formatBytes } from '@/lib/format';
import { usePrefersReducedMotion } from '@/lib/use-prefers-reduced-motion';
import { BUCKETS } from './demo-stream';
import { SectionHead } from './SectionHead';
import s from './NoiseFloor.module.css';

/* Geometry of the readout, in CSS pixels. */
const BAR_W = 3;
const BAR_GAP = 3;
const STEP = BAR_W + BAR_GAP;
/** One column of traffic per this many ms. Slow enough to read. */
const MS_PER_BAR = 150;

/** Bar half-height per bucket, as a fraction of the plot's half-height. */
const AMPLITUDE: readonly number[] = [0.24, 0.44, 0.7, 1];

/** Fraction of the width where the confirmed peak sits. */
const CURSOR = 0.68;

function readToken(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value === '' ? fallback : value;
}

/**
 * The padding guarantee, drawn.
 *
 * Every envelope is one of four sizes, so the only thing this plot can tell you
 * is which bucket a message landed in — never how long it was, never whether a
 * given column carries a conversation or cover traffic. The single green column
 * is yours because you sent it; to everyone else it is just another sample.
 */
export function NoiseFloor(): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const labelRef = useRef<HTMLSpanElement | null>(null);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    const shell = shellRef.current;
    if (canvas === null || shell === null) return;

    const context = canvas.getContext('2d');
    if (context === null) return;

    const dim = readToken('--dim', '#4A5157');
    const green = readToken('--green', '#FFA318');
    const line = readToken('--line-2', 'rgba(255,255,255,.13)');

    let width = 0;
    let height = 0;
    let bars: number[] = [];
    let phase = 0;
    let last = 0;
    let frame: number | null = null;
    let running = false;
    let shownBucket = -1;

    /* Traffic is mostly short messages; every one of them still fills a
       256-byte envelope, which is the entire point of the picture. */
    const pickBucket = (): number => {
      const roll = Math.random();
      if (roll < 0.56) return 0;
      if (roll < 0.82) return 1;
      if (roll < 0.95) return 2;
      return 3;
    };

    const fill = (): void => {
      const count = Math.ceil(width / STEP) + 2;
      if (bars.length > count) {
        bars = bars.slice(bars.length - count);
        return;
      }
      while (bars.length < count) bars.push(pickBucket());
    };

    const cursorIndex = (): number =>
      Math.min(bars.length - 1, Math.max(0, Math.round(bars.length * CURSOR)));

    const paint = (): void => {
      context.clearRect(0, 0, width, height);
      if (width <= 0 || height <= 0) return;

      const midY = height / 2;
      const maxAmp = midY - 8;
      const marked = cursorIndex();
      const offset = -phase * STEP;

      context.fillStyle = line;
      context.fillRect(0, Math.round(midY), width, 1);

      for (let i = 0; i < bars.length; i += 1) {
        const bucket = bars[i] ?? 0;
        const amp = (AMPLITUDE[bucket] ?? 0.24) * maxAmp;
        const x = Math.round(i * STEP + offset);
        if (x + BAR_W < 0 || x > width) continue;
        context.fillStyle = i === marked ? green : dim;
        context.fillRect(x, midY - amp, BAR_W, amp * 2);
      }

      const bucket = bars[marked] ?? 0;
      if (bucket !== shownBucket) {
        shownBucket = bucket;
        const label = labelRef.current;
        if (label !== null) {
          label.textContent = `anchored · ${formatBytes(BUCKETS[bucket] ?? 256)}`;
        }
      }
    };

    const step = (now: number): void => {
      if (!running) return;
      const delta = last === 0 ? 0 : now - last;
      last = now;

      phase += delta / MS_PER_BAR;
      while (phase >= 1) {
        phase -= 1;
        bars.shift();
        bars.push(pickBucket());
      }

      paint();
      frame = requestAnimationFrame(step);
    };

    const stop = (): void => {
      running = false;
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
    };

    const start = (): void => {
      if (running || reduced) return;
      running = true;
      last = 0;
      frame = requestAnimationFrame(step);
    };

    const resize = (): void => {
      const rect = shell.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.max(1, Math.floor(rect.width));
      height = Math.max(1, Math.floor(rect.height));
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      fill();
      paint();
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(shell);
    resize();

    let observer: IntersectionObserver | null = null;
    if (typeof IntersectionObserver === 'undefined') {
      start();
    } else {
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) start();
            else stop();
          }
        },
        { rootMargin: '64px' },
      );
      observer.observe(shell);
    }

    return () => {
      stop();
      resizeObserver.disconnect();
      observer?.disconnect();
    };
  }, [reduced]);

  return (
    <div className="wrap">
      <SectionHead
        index="05"
        eyebrow="The noise floor"
        title="A short message and a long one leave the same trace."
        lede="Envelopes are padded to one of four fixed sizes before they are sealed. A five-character message and a five-hundred-character message leave an identical footprint."
        aside="4 buckets · 256 B – 16 KB"
      />

      <div className={s.layout}>
        <figure className={s.plot} data-reveal>
          <div className={s.shell} ref={shellRef}>
            <canvas
              className={s.canvas}
              ref={canvasRef}
              role="img"
              aria-label="A stream of message envelopes, every one padded to one of four fixed sizes. One envelope is marked as confirmed on chain; the rest are indistinguishable from it."
            />
            <span className={s.cursor} aria-hidden="true" />
            <span className={s.cursorLabel} ref={labelRef} aria-hidden="true">
              anchored
            </span>
          </div>

          <figcaption className={s.caption}>
            <span className={s.captionRule} aria-hidden="true" />
            You know which column is yours because you sent it. Nobody watching the
            chain can pick it out of the others.
          </figcaption>
        </figure>

        <aside className={s.side}>
          <ul className={s.buckets} data-reveal>
            {BUCKETS.map((bucket, index) => (
              <li className={s.bucket} key={bucket}>
                <span
                  className={s.bucketBar}
                  style={{ height: `${8 + index * 9}px` }}
                  aria-hidden="true"
                />
                <span className={s.bucketSize}>{formatBytes(bucket)}</span>
                <span className={s.bucketNote}>
                  {index === 0
                    ? 'most conversation'
                    : index === 3
                      ? 'long-form ceiling'
                      : 'overflow'}
                </span>
              </li>
            ))}
          </ul>

          <div className={s.notes} data-reveal>
            <p className={s.note}>
              <span className={s.noteKey}>No length leak.</span> A five-character
              reply and a two-hundred-character one produce byte-identical
              envelopes.
            </p>
            <p className={s.note}>
              <span className={s.noteKey}>No recipient on chain.</span> Anchors
              carry a one-byte scan tag, so a reader tests every drop cheaply
              without anyone learning who they are.
            </p>
            <p className={s.note}>
              <span className={s.noteKey}>What this does not hide.</span> Timing.
              The sequencer sees when a transaction arrives, and so does anyone
              reading the chain.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
