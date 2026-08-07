'use client';

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';

import s from './NewsTicker.module.css';

export interface NewsTickerProps {
  /** Headlines, printed verbatim. Nothing here may be paraphrased or added to. */
  readonly items: readonly string[];
  readonly ariaLabel: string;
}

/** Crawl speed in px/s — one constant, so every band on the page moves at the same pace. */
const SPEED = 72;

/** Loop time used until the track has been measured. */
const FALLBACK_SECONDS = 60;

/**
 * Each track repeats the copy until it holds at least this many items, so even a three-line band
 * builds a track wider than any viewport and the wrap never opens a gap.
 */
const MIN_TRACK_ITEMS = 8;

/**
 * The wire band between sections — black-on-bone TV-news crawl, content travelling leftward so
 * the eye picks each headline up at its start.
 *
 * Two identical tracks sit side by side and the pair translates from 0 to -50%; the moment the
 * second track reaches where the first began the animation restarts on a pixel-identical frame,
 * so the crawl is continuous and seamless with no gap or jump. Duration comes from the measured
 * track width so long and short bands crawl at the same px/s. Reduced motion freezes it.
 */
export function NewsTicker({ items, ariaLabel }: NewsTickerProps): ReactNode {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [seconds, setSeconds] = useState<number>(FALLBACK_SECONDS);

  const repeats = Math.max(1, Math.ceil(MIN_TRACK_ITEMS / Math.max(1, items.length)));
  const cells: string[] = [];
  for (let i = 0; i < repeats; i += 1) cells.push(...items);

  useEffect(() => {
    const track = trackRef.current;
    if (track === null) return;

    const measure = (): void => {
      const width = track.scrollWidth;
      if (width > 0) setSeconds(Math.max(20, Math.round(width / SPEED)));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    return () => observer.disconnect();
  }, [items, repeats]);

  const renderTrack = (measured: boolean): ReactNode => (
    <div className={s.track} ref={measured ? trackRef : undefined}>
      {cells.map((text, index) => (
        <span className={s.item} key={`${index}-${text.slice(0, 16)}`}>
          <span className={s.square} aria-hidden="true" />
          {text}
        </span>
      ))}
    </div>
  );

  return (
    <section className={s.band} aria-label={ariaLabel}>
      <div
        className={s.viewport}
        data-fit-scroll
        aria-hidden="true"
        style={{ '--crawl-seconds': `${seconds}s` } as CSSProperties}
      >
        <div className={s.crawl}>
          {renderTrack(true)}
          {renderTrack(false)}
        </div>
      </div>

      <span className={s.cap} aria-hidden="true">
        <span className={s.square} aria-hidden="true" />
        Wire
      </span>

      {/* The crawl is decorative motion; this is the same copy for readers and screen readers. */}
      <ul className="sr-only">
        {items.map((text) => (
          <li key={text}>{text}</li>
        ))}
      </ul>
    </section>
  );
}
