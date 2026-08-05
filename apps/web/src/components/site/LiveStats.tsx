'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { Stat } from '@/components/ui/Stat';
import { cx } from '@/lib/cx';
import { formatBlock, formatCount } from '@/lib/format';
import {
  getStats,
  RELAY_URL,
  subscribeRelayStream,
  type RelayStats,
  type RelayStreamStatus,
} from '@/lib/relay';
import s from './LiveStats.module.css';
import { SectionHead } from './SectionHead';

type Health = 'probing' | 'online' | 'offline';

const ZERO: RelayStats = {
  head: 0,
  totalDrops: 0,
  totalBlobs: 0,
  uniquePosters: 0,
  indexedBlock: 0,
};

/** Refresh interval used only while the WebSocket is not carrying the numbers. */
const POLL_MS = 30_000;

interface Readout {
  readonly label: string;
  readonly value: number;
  readonly display: string;
  readonly hint: string;
  readonly format?: (value: number) => string;
}

function readouts(stats: RelayStats): readonly Readout[] {
  return [
    {
      label: 'Anchors posted',
      value: stats.totalDrops,
      display: formatCount(stats.totalDrops),
      hint: 'Dropped events indexed',
    },
    {
      label: 'Envelopes stored',
      value: stats.totalBlobs,
      display: formatCount(stats.totalBlobs),
      hint: 'Content-addressed ciphertext',
    },
    {
      label: 'Unique posters',
      value: stats.uniquePosters,
      display: formatCount(stats.uniquePosters),
      hint: 'Addresses seen on chain',
    },
    {
      label: 'Stream head',
      value: stats.head,
      display: formatCount(stats.head),
      hint: 'Highest sequence number',
    },
    {
      label: 'Indexed block',
      value: stats.indexedBlock,
      display: formatBlock(stats.indexedBlock),
      hint: 'Indexer cursor',
      format: (value: number) => formatBlock(Math.round(value)),
    },
  ];
}

/**
 * Figures straight off `GET /v1/stats`, kept current by the stats frame the
 * relay pushes every ten seconds.
 *
 * When the relay is not running the figures are honest zeros with the reason
 * printed next to them — never a fabricated number, and never a blank panel.
 */
export function LiveStats(): ReactNode {
  const [stats, setStats] = useState<RelayStats>(ZERO);
  const [health, setHealth] = useState<Health>('probing');
  const streamRef = useRef<RelayStreamStatus>('connecting');

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    const load = (): void => {
      getStats({ signal: controller.signal, timeoutMs: 8_000 })
        .then((next) => {
          if (cancelled) return;
          setStats(next);
          setHealth('online');
        })
        .catch(() => {
          if (cancelled) return;
          setHealth('offline');
        });
    };

    load();

    const unsubscribe = subscribeRelayStream({
      onStats: (next) => {
        if (cancelled) return;
        setStats(next);
        setHealth('online');
      },
      onStatus: (status) => {
        streamRef.current = status;
      },
    });

    const timer = setInterval(() => {
      if (streamRef.current !== 'open') load();
    }, POLL_MS);

    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
      unsubscribe();
    };
  }, []);

  const online = health === 'online';
  const statusText =
    health === 'probing'
      ? 'Contacting relay'
      : online
        ? 'Relay online'
        : 'Relay unreachable';

  return (
    <div className="wrap">
      <SectionHead
        index="08"
        eyebrow="Live stats"
        title="What the indexer has actually seen."
        lede="Read live from the relay, straight off the chain as anchors land."
        aside={RELAY_URL}
      />

      <div className={s.bar} data-reveal>
        <span className={cx(s.status, online ? s.statusOn : s.statusOff)}>
          <span className={s.dot} aria-hidden="true" />
          {statusText}
        </span>
        <span className={s.barRule} aria-hidden="true" />
        <span className={s.endpoint}>GET /v1/stats · WS /v1/stream</span>
      </div>

      <div className={s.grid}>
        {readouts(stats).map((readout) => (
          <div className={s.cell} key={readout.label} data-reveal>
            <Stat
              label={readout.label}
              value={readout.display}
              countUp={readout.value}
              hint={readout.hint}
              tone={online ? 'bone' : 'muted'}
              size="lg"
              {...(readout.format === undefined ? {} : { format: readout.format })}
            />
          </div>
        ))}
      </div>

      {!online && health !== 'probing' && (
        <p className={s.offline} data-reveal>
          The relay at <code className={s.code}>{RELAY_URL}</code> did not answer.
          Start it with <code className={s.code}>pnpm --filter @telehood/relay dev</code>{' '}
          and these figures fill in on their own — the page does not need a reload.
        </p>
      )}
    </div>
  );
}
