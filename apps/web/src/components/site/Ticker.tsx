'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { getDrops, getStats, type DropRow } from '@/lib/relay';
import s from './Ticker.module.css';

/**
 * The continuous horizontal flow under the masthead.
 *
 * Most sites put marketing metrics in this slot. We put the actual anchor log: content hashes, scan
 * tags and size buckets streaming past. It is the same argument the cipher band makes, in motion —
 * this is everything the chain holds, and none of it means anything to you.
 *
 * The marquee is pure CSS on a duplicated track, so it costs no JavaScript per frame and keeps
 * running while the main thread is busy. It pauses on hover and stops dead under
 * `prefers-reduced-motion`.
 */

interface Cell {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly live: boolean;
}

const BUCKET_LABEL: Record<number, string> = {
  256: '256 B',
  1024: '1.0 KB',
  4096: '4.0 KB',
  16384: '16.0 KB',
};

function short(hex: string): string {
  return hex.length > 14 ? `${hex.slice(0, 10)}…${hex.slice(-4)}` : hex;
}

function toCells(drops: readonly DropRow[]): Cell[] {
  return drops.map((d) => ({
    key: `d${d.seq}`,
    label: `#${d.blockNumber.toLocaleString('en-US')}`,
    value: short(d.blobRef),
    live: true,
  }));
}

/* Deterministic filler so the strip is never empty and never differs between the
   server and the first client paint. Labelled honestly in the rail. */
function seededCells(): Cell[] {
  const out: Cell[] = [];
  let a = 0x9e3779b9;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const buckets = [256, 1024, 4096, 16384];
  for (let i = 0; i < 14; i += 1) {
    let hex = '0x';
    for (let c = 0; c < 14; c += 1) hex += '0123456789abcdef'[Math.floor(next() * 16)];
    out.push({
      key: `s${i}`,
      label: BUCKET_LABEL[buckets[Math.floor(next() * 4)] ?? 256] ?? '256 B',
      value: `${hex.slice(0, 10)}…${hex.slice(-4)}`,
      live: false,
    });
  }
  return out;
}

export function Ticker(): ReactNode {
  const seeded = useMemo(seededCells, []);
  const [cells, setCells] = useState<Cell[]>(seeded);
  const [live, setLive] = useState(false);
  const [head, setHead] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    const pull = async (): Promise<void> => {
      try {
        const [page, stats] = await Promise.all([
          getDrops({ limit: 18 }, { signal: controller.signal, timeoutMs: 6000 }),
          getStats({ signal: controller.signal, timeoutMs: 6000 }),
        ]);
        if (cancelled) return;
        setHead(stats.totalDrops);
        if (page.drops.length > 0) {
          setCells(toCells([...page.drops].sort((x, y) => y.seq - x.seq)));
          setLive(true);
        }
      } catch {
        /* Relay down is not an error state for a decorative strip — the seeded
           rows stay up and the rail keeps saying they are a sample. */
      }
    };

    void pull();
    const id = setInterval(() => void pull(), 20_000);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(id);
    };
  }, []);

  /* Two identical tracks butted together give a seamless -50% translation. */
  const track = (
    <div className={s.track} aria-hidden="true">
      {cells.map((c) => (
        <span className={s.cell} key={c.key}>
          <span className={s.mark} aria-hidden="true" />
          <span className={s.value}>{c.value}</span>
          <span className={s.label}>{c.label}</span>
        </span>
      ))}
    </div>
  );

  return (
    <div className={s.rail}>
      <div className={s.status}>
        <span className={live ? s.dotLive : s.dot} aria-hidden="true" />
        <span className={s.statusText}>
          {live
            ? `Anchor log · ${head === null ? '' : `${head.toLocaleString('en-US')} total`}`
            : 'Anchor log · sample'}
        </span>
      </div>

      {/* A marquee track is wider than its frame by definition. `overflow:hidden`
          clips it and the page never scrolls horizontally (verified), so this
          declares the region intentional rather than leaving ~100 expected
          violations in `make fit` for everyone to learn to ignore. */}
      <div className={s.viewport} data-fit-scroll>
        <div className={s.marquee}>
          {track}
          {track}
        </div>
        <div className={s.fadeL} aria-hidden="true" />
        <div className={s.fadeR} aria-hidden="true" />
      </div>

      <p className={s.sr}>
        A continuously scrolling list of on-chain message anchors: content hash and block number for
        each. Decorative; the same data is available in the anchor log above.
      </p>
    </div>
  );
}
