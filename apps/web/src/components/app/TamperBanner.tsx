'use client';

/**
 * The integrity alarm (SPEC §7.3).
 *
 * Every fetched ciphertext is re-hashed and compared with the `blobRef` that
 * was anchored on chain. A mismatch means the relay served bytes that are not
 * what was committed to — the one condition in this product that earns crimson
 * and a permanent, un-dismissable banner.
 *
 * It is stated precisely: nothing was decrypted, nothing was trusted, and the
 * anchored digest is still the authority. The relay is a cache, not a witness.
 */

import { useState, type ReactNode } from 'react';

import { Hex as HexValue } from '@/components/ui';
import type { TamperEvent } from '@/hooks';
import { cx } from '@/lib/cx';
import { formatCount, formatDateTime, truncateAddress } from '@/lib/format';
import s from './TamperBanner.module.css';

export interface TamperBannerProps {
  readonly events: readonly TamperEvent[];
  readonly className?: string;
}

export function TamperBanner({ events, className }: TamperBannerProps): ReactNode {
  const [expanded, setExpanded] = useState(false);

  if (events.length === 0) return null;

  return (
    <section className={cx(s.banner, className)} role="alert" aria-label="Integrity failure">
      <div className={s.bar}>
        <span className={s.mark} aria-hidden="true" />

        <div className={s.body}>
          <span className={s.title}>
            {events.length === 1
              ? 'A blob did not match its on-chain hash'
              : `${formatCount(events.length)} blobs did not match their on-chain hashes`}
          </span>
          <p className={s.text}>
            The relay returned bytes whose sha256 is not the <code className={s.code}>blobRef</code>{' '}
            recorded by <code className={s.code}>Anchors.Dropped</code>. Those bytes were discarded
            without being decrypted. Nothing you can read here was affected: the chain digest is
            the authority and the relay is only a cache.
          </p>
        </div>

        <button
          type="button"
          className={s.toggle}
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          {expanded ? 'Hide detail' : 'Show detail'}
        </button>
      </div>

      {expanded && (
        <ul className={s.list}>
          {events.map((event) => (
            <li key={`${String(event.seq)}:${event.blobRef}`} className={s.entry}>
              <span className={s.entryKey}>seq {formatCount(event.seq)}</span>
              <span className={s.entryPair}>
                <span className={s.entryLabel}>anchored</span>
                <HexValue
                  value={event.blobRef}
                  label="Anchored blob reference"
                  lead={10}
                  tail={8}
                  size="sm"
                  tone="muted"
                  href={null}
                />
              </span>
              <span className={s.entryPair}>
                <span className={s.entryLabel}>served</span>
                <HexValue
                  value={event.computed}
                  label="Recomputed digest of the served bytes"
                  lead={10}
                  tail={8}
                  size="sm"
                  tone="muted"
                  href={null}
                />
              </span>
              <span className={s.entryMeta}>
                {truncateAddress(event.poster)} · {formatDateTime(event.at)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
