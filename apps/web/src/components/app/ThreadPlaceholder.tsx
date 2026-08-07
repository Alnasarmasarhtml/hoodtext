'use client';

/**
 * The default pane at `/app` — the state the messenger sits in before a thread
 * is chosen. Never blank (SPEC §7.3).
 *
 * It has two faces:
 *
 *  · **Locked** — the account is not activated. The designed locked state
 *    explains the $5 one-time activation, quotes it live in $THOOD and links
 *    to `/access`. The rail beside it stays live, because reading and
 *    receiving are never gated on payment.
 *  · **Open** — a live readout of the scanner plus the four steps a drop takes,
 *    so an empty desk still tells you what the product is doing on your behalf.
 */

import type { ReactNode } from 'react';

import { Eyebrow } from '@/components/ui';
import { useConversations } from '@/hooks';
import { formatCount } from '@/lib/format';
import { LockedNotice } from './LockedNotice';
import { useAppSession } from './session';
import s from './ThreadPlaceholder.module.css';

interface Step {
  readonly key: string;
  readonly index: string;
  readonly label: string;
  readonly note: string;
}

const DROP_STEPS: readonly Step[] = [
  {
    key: 'compose',
    index: '01',
    label: 'Compose',
    note: 'Plaintext never leaves this device unencrypted.',
  },
  {
    key: 'seal',
    index: '02',
    label: 'Pad + seal',
    note: 'Padded to one of four fixed buckets, then sealed to a fresh ephemeral key.',
  },
  {
    key: 'relay',
    index: '03',
    label: 'Relay anchors it',
    note: 'You sign the drop; the relay posts it on chain. No gas, no wallet popup — self-post stays one toggle away.',
  },
  {
    key: 'scan',
    index: '04',
    label: 'Scan',
    note: 'They find it by view tag, fetch the blob and verify it against the chain.',
  },
];

export function ThreadPlaceholder(): ReactNode {
  const session = useAppSession();
  const { conversations, isHydrated, totalMessages } = useConversations();
  const drops = session.drops;

  if (!session.activation.isActivated) {
    return (
      <div className={s.pane}>
        <LockedNotice activation={session.activation} className={s.locked} />
        <p className={s.lockedNote}>
          The rail beside this stays live. Every thread already on this device is readable, and
          new messages keep arriving and decrypting before you have paid anything — activation
          unlocks the composer and nothing else.
        </p>
      </div>
    );
  }

  const hasThreads = conversations.length > 0;

  return (
    <div className={s.pane}>
      <header className={s.head}>
        <Eyebrow rule>{hasThreads ? 'No thread selected' : 'Desk ready'}</Eyebrow>
        <h1 className={s.title}>
          {hasThreads
            ? 'Pick a conversation from the rail.'
            : 'Open a conversation, or start a room.'}
        </h1>
        <p className={s.lede}>
          {hasThreads
            ? 'DM threads live on this device: the conversation id is derived from your key and theirs, and is never posted on chain. Rooms are announced by id, their membership is not. Nothing here is fetched from a server that knows who you talk to.'
            : 'Paste a @handle or wallet address into the rail — HoodGram reads their registered X25519 key from KeyRegistry, a free view call, and the thread opens with no transaction. Or open a room: $10/month, members free.'}
        </p>
      </header>

      <dl className={s.readout}>
        <div className={s.metric}>
          <dt className={s.metricKey}>Anchors scanned</dt>
          <dd className={s.metricValue}>{formatCount(drops.scanned)}</dd>
          <dd className={s.metricNote}>this session</dd>
        </div>
        <div className={s.metric}>
          <dt className={s.metricKey}>View-tag hits</dt>
          <dd className={s.metricValue}>{formatCount(drops.matched)}</dd>
          <dd className={s.metricNote}>≈1 in 256 by chance</dd>
        </div>
        <div className={s.metric}>
          <dt className={s.metricKey}>Log position</dt>
          <dd className={s.metricValue}>
            {formatCount(Math.max(drops.head, drops.scannedSeq))}
          </dd>
          <dd className={s.metricNote}>
            {drops.isBackfilling ? `backfilling from ${formatCount(drops.scannedSeq)}` : 'up to date'}
          </dd>
        </div>
        <div className={s.metric}>
          <dt className={s.metricKey}>Messages held</dt>
          <dd className={s.metricValue}>
            {isHydrated ? formatCount(totalMessages) : '—'}
          </dd>
          <dd className={s.metricNote}>on this device only</dd>
        </div>
      </dl>

      <section className={s.steps} aria-label="How a drop works">
        <span className={s.stepsLabel}>How a drop works</span>
        <ol className={s.stepList}>
          {DROP_STEPS.map((step) => (
            <li key={step.key} className={s.step}>
              <span className={s.stepIndex}>{step.index}</span>
              <span className={s.stepLabel}>{step.label}</span>
              <span className={s.stepNote}>{step.note}</span>
            </li>
          ))}
        </ol>
      </section>

      <p className={s.footnote}>
        Message contents are unreadable by anyone but the recipients. Metadata is minimized, not
        eliminated — a global observer still sees that an anchor was posted, and when.
      </p>
    </div>
  );
}
