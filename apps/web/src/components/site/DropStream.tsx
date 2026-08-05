'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { cx } from '@/lib/cx';
import { formatBlock, formatBytes, truncateHex } from '@/lib/format';
import {
  getDrops,
  subscribeRelayStream,
  type RelayStreamStatus,
} from '@/lib/relay';
import { usePrefersReducedMotion } from '@/lib/use-prefers-reduced-motion';
import {
  MAX_STREAM_ROWS,
  formatViewTag,
  makeDemoSeed,
  toStreamRow,
  type DemoSeed,
  type StreamRow,
} from './demo-stream';
import s from './DropStream.module.css';

/**
 * `probing` — the relay has not answered yet.
 * `live`    — real anchors, streamed from `WS /v1/stream`.
 * `demo`    — simulated, and labelled as such on every frame.
 */
/**
 * Two different situations both fall back to the simulated stream, and they need different copy:
 * the relay answered but has indexed nothing yet, versus the relay could not be reached at all.
 * Telling someone to "start the relay" while it is demonstrably online reads as a broken page.
 */
type StreamMode = 'probing' | 'live' | 'demo-empty' | 'demo-unreachable';

const PROBE_TIMEOUT_MS = 6_000;

/** Lazily create the seeded feed once, and keep the same generator for the ticker. */
function useDemoSeed(): DemoSeed {
  const ref = useRef<DemoSeed | null>(null);
  const current = ref.current;
  if (current !== null) return current;
  const created = makeDemoSeed();
  ref.current = created;
  return created;
}

function statusNote(status: RelayStreamStatus): string {
  switch (status) {
    case 'open':
      return 'Streaming';
    case 'connecting':
      return 'Connecting';
    case 'reconnecting':
      return 'Reconnecting';
    case 'unsupported':
      return 'No WebSocket in this browser';
    case 'closed':
      return 'Stream closed';
  }
}

/**
 * The signature hero visual: a column of anchors as they land.
 *
 * Every row is what the chain actually stores — a content hash, a one-byte scan
 * filter, a padded bucket size and a block. There is no plaintext here because
 * there is no plaintext on chain.
 */
export function DropStream(): ReactNode {
  const seed = useDemoSeed();
  const reduced = usePrefersReducedMotion();

  const [rows, setRows] = useState<readonly StreamRow[]>(seed.rows);
  const [mode, setMode] = useState<StreamMode>('probing');
  const [note, setNote] = useState('Contacting relay');
  const [onScreen, setOnScreen] = useState(true);

  const frameRef = useRef<HTMLDivElement | null>(null);

  /* ── pause the simulation while the hero is scrolled away ─────────────── */
  useEffect(() => {
    const node = frameRef.current;
    if (node === null || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setOnScreen(entry.isIntersecting);
      },
      { rootMargin: '96px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  /* ── probe the relay once, then decide what this column is showing ────── */
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    getDrops(
      { limit: MAX_STREAM_ROWS },
      { signal: controller.signal, timeoutMs: PROBE_TIMEOUT_MS },
    )
      .then((page) => {
        if (cancelled) return;
        if (page.drops.length === 0) {
          setMode('demo-empty');
          setNote('Relay online, no anchors yet');
          return;
        }
        const newestFirst = [...page.drops]
          .sort((a, b) => b.seq - a.seq)
          .slice(0, MAX_STREAM_ROWS)
          .map((drop) => toStreamRow(drop, false));
        setRows(newestFirst);
        setMode('live');
        setNote('Streaming');
      })
      .catch(() => {
        if (cancelled) return;
        setMode('demo-unreachable');
        setNote('Relay unreachable');
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  /* ── live: push every new anchor onto the top of the column ───────────── */
  useEffect(() => {
    if (mode !== 'live') return;

    return subscribeRelayStream({
      onDrop: (drop) => {
        setRows((previous) => {
          if (previous.some((row) => row.seq === drop.seq)) return previous;
          return [toStreamRow(drop, true), ...previous].slice(0, MAX_STREAM_ROWS);
        });
      },
      onStatus: (status) => setNote(statusNote(status)),
    });
  }, [mode]);

  /* ── demo: a jittered ticker that stops when nobody is looking ────────── */
  useEffect(() => {
    if (mode === 'live' || !onScreen) return;

    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (): void => {
      const gap = seed.demo.gap();
      timer = setTimeout(
        () => {
          setRows((previous) =>
            [seed.demo.next(true), ...previous].slice(0, MAX_STREAM_ROWS),
          );
          schedule();
        },
        reduced ? gap * 3 : gap,
      );
    };

    schedule();
    return () => {
      if (timer !== null) clearTimeout(timer);
    };
  }, [mode, onScreen, reduced, seed]);

  const live = mode === 'live';
  const label = live ? 'Live anchor stream' : 'Demo stream';

  return (
    <section className={s.stream} aria-label={label}>
      <header className={s.head}>
        <span className={cx(s.badge, live ? s.badgeLive : s.badgeDemo)}>
          <span className={s.dot} aria-hidden="true" />
          {label}
        </span>
        <span className={s.note} role="status">
          {note}
        </span>
      </header>

      {!live && (
        <p className={s.disclaimer}>
          Simulated anchors, generated in your browser. Not chain data —{' '}
          {mode === 'demo-empty'
            ? 'the relay is connected, but nothing has been anchored on chain yet.'
            : 'start the relay to watch the real log.'}
        </p>
      )}

      <div className={s.frame} ref={frameRef}>
        <div className={s.columns} aria-hidden="true">
          <span className={s.colSeq}>seq</span>
          <span>blobRef</span>
          <span className={s.colTag}>tag</span>
          <span className={s.colBytes}>bytes</span>
          <span className={s.colBlock}>block</span>
        </div>

        <ol className={s.rows}>
          {rows.map((row) => (
            <li
              key={row.id}
              className={cx(s.row, row.fresh && s.fresh)}
              /* Announcing every anchor would flood a screen reader; the column
                 is decorative repetition of data stated elsewhere. */
              aria-hidden="true"
            >
              <span className={cx(s.cell, s.colSeq)}>{row.seq}</span>
              <span className={cx(s.cell, s.ref)}>
                {truncateHex(row.blobRef, 10, 6)}
              </span>
              <span className={cx(s.cell, s.colTag)}>{formatViewTag(row.viewTag)}</span>
              <span className={cx(s.cell, s.colBytes)}>{formatBytes(row.size)}</span>
              <span className={cx(s.cell, s.colBlock)}>
                {formatBlock(row.blockNumber)}
              </span>
            </li>
          ))}
        </ol>

        <div className={s.fade} aria-hidden="true" />
      </div>

      <footer className={s.foot}>
        <span>Content hash · scan tag · padded size · block</span>
        <span className={s.footRule} aria-hidden="true" />
        <span>No plaintext, no recipient</span>
      </footer>
    </section>
  );
}
