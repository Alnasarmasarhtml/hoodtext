'use client';

import type { ReactNode } from 'react';

import { cx } from '@/lib/cx';
import { formatCount } from '@/lib/format';
import type { UseDropsResult, UseRelayStatusResult } from '@/hooks';
import s from './RelayStatus.module.css';

export interface RelayStatusProps {
  readonly relay: UseRelayStatusResult;
  readonly drops: UseDropsResult;
}

interface Readout {
  readonly tone: 'live' | 'wait' | 'down';
  readonly label: string;
  readonly note: string;
}

function readoutFor(relay: UseRelayStatusResult, drops: UseDropsResult): Readout {
  if (drops.isBackfilling) {
    return {
      tone: 'wait',
      label: 'Scanning',
      note: `seq ${formatCount(drops.scannedSeq)} of ${formatCount(Math.max(drops.head, drops.scannedSeq))}`,
    };
  }

  switch (relay.status) {
    case 'open':
      return relay.isLagging
        ? {
            tone: 'wait',
            label: 'Indexer behind',
            note: `${formatCount(relay.indexerLag ?? 0)} blocks`,
          }
        : {
            tone: 'live',
            label: 'Live',
            note: `seq ${formatCount(Math.max(drops.head, drops.scannedSeq))}`,
          };
    case 'connecting':
      return { tone: 'wait', label: 'Connecting', note: 'relay stream' };
    case 'reconnecting':
      return { tone: 'wait', label: 'Reconnecting', note: 'backing off' };
    case 'unsupported':
      return { tone: 'down', label: 'No websocket', note: 'polling only' };
    default:
      return { tone: 'down', label: 'Relay offline', note: 'history still readable' };
  }
}

/**
 * Relay connectivity — and only when there is something to say about it.
 *
 * Working is the default, so it needs no announcement: while the stream is
 * live this renders nothing at all, exactly as every messenger people already
 * use behaves. It appears when connecting, when the indexer falls behind, or
 * when the relay is down. It used to sit there permanently reading
 * "Live · seq 41,214", which told a user nothing they could act on.
 *
 * "Offline" is not a failure state either: anchors already scanned stay on the
 * device and stay readable, so the note says so rather than implying the
 * messenger is broken.
 */
export function RelayStatus({ relay, drops }: RelayStatusProps): ReactNode {
  const readout = readoutFor(relay, drops);

  if (readout.tone === 'live') return null;

  return (
    <span className={cx(s.status, s[readout.tone])} role="status">
      <span className={s.dot} aria-hidden="true" />
      <span className={s.label}>{readout.label}</span>
      <span className={s.note}>{readout.note}</span>
    </span>
  );
}
