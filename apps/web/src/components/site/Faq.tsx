'use client';

import type { ReactNode } from 'react';

import { SectionHead } from './SectionHead';
import s from './Faq.module.css';
import { TokenMark } from './TokenMark';

interface Entry {
  readonly id: string;
  readonly question: string;
  readonly answer: ReactNode;
}

/** Straight answers about what TeleHood does and how it does it. */
const ENTRIES: readonly Entry[] = [
  {
    id: 'five-once',
    question: 'Is the $5 really once?',
    answer: (
      <>
        Yes. <code className={s.code}>Activation</code> stores a single flag against
        your address, forever — there is no expiry, no grant that runs out, no renewal
        and no way to lose it. The old idea of paying monthly for access is gone from
        the contracts entirely.
      </>
    ),
  },
  {
    id: 'why-five',
    question: 'Why charge anything at all?',
    answer: (
      <>
        The $5 is the spam wall. Every account on TeleHood cost somebody five dollars,
        so bot floods and burner swarms are uneconomical — and half of every one of
        those payments goes to <TokenMark quiet /> holders.
      </>
    ),
  },
  {
    id: 'room-lapse',
    question: 'What happens when a room’s rent lapses?',
    answer: (
      <>
        New messages stop. That is the entire consequence: history, membership and the
        admin role all survive untouched, and paying the rent — which{' '}
        <em>anyone</em> may do, not just the admin — reopens the room the same second.
        Nothing is ever deleted.
      </>
    ),
  },
  {
    id: 'relay-read',
    question: 'Can the relay read my messages?',
    answer: (
      <>
        No. The relay only ever holds ciphertext — messages are sealed on your device
        before it sees a byte. It verifies an identity signature and that the sender is
        activated, so it cannot forge you. What it <em>could</em> do is refuse to carry
        you, which is why self-posting straight to the chain always works.
      </>
    ),
  },
  {
    id: 'per-message',
    question: 'Am I charged per message?',
    answer: (
      <>
        Never. <code className={s.code}>Anchors.post</code> is not payable. Relayed
        messages cost you nothing at all — no gas, no popups — and self-posting costs
        about a cent of gas, paid to the network, not to us.
      </>
    ),
  },
  {
    id: 'staking',
    question: 'Why do $THOOD holders get paid without staking?',
    answer: (
      <>
        The token records balance history on chain, so the vault can read exactly what
        you held at each weekly snapshot block. Your share is computed from what is
        already in your wallet — there is nothing to deposit, nothing to lock and no
        staking contract anywhere in the system.
      </>
    ),
  },
  {
    id: 'tiers',
    question: 'How are the status tiers judged?',
    answer: (
      <>
        On the <strong>lower</strong> of your balance right now and your balance at the
        last sealed weekly snapshot. A tier has to be held through a snapshot, so it
        cannot be flash-bought before a check — and selling drops it immediately. The
        revenue share ignores tiers entirely: every holder is paid pro-rata.
      </>
    ),
  },
  {
    id: 'handles',
    question: 'Why can’t I claim a 2-letter handle?',
    answer: (
      <>
        Short names are the scarce flex: 4 characters need BLOCK CAPTAIN, 3 need
        DISTRICT, 2 need KINGPIN, while 5+ are open to every activated account. The
        tier is checked once, at claim time — a short handle you already hold is never
        revoked, whatever your balance does afterwards.
      </>
    ),
  },
  {
    id: 'encrypted',
    question: 'What exactly is encrypted?',
    answer: (
      <>
        Everything you write. Messages are sealed on your device with X25519 key
        agreement and XSalsa20-Poly1305 before they touch the network, and the
        recipient&rsquo;s key is the only key that opens them.
      </>
    ),
  },
  {
    id: 'chain-stores',
    question: 'What does the chain actually store?',
    answer: (
      <>
        A 32-byte content hash, a one-time public key, a one-byte scan tag and a
        padded size bucket. That record proves a message happened and when, and it
        is the entire public footprint — relayed drops do not even carry your address.
      </>
    ),
  },
  {
    id: 'keys',
    question: 'Where do my keys live?',
    answer: (
      <>
        On your device. One signature from your wallet derives them, they are
        cached in IndexedDB keyed to your address, and they are wiped the moment
        you disconnect. They are never transmitted anywhere.
      </>
    ),
  },
  {
    id: 'permanent',
    question: 'Are messages permanent?',
    answer: (
      <>
        Yes. Every anchor is a permanent public receipt on Robinhood Chain, so
        your history can be proven, verified and independently reconstructed for
        as long as the chain exists.
      </>
    ),
  },
];

/** Straight answers about how the product works. */
export function Faq(): ReactNode {
  return (
    <div className="wrap">
      <SectionHead
        index="09"
        eyebrow="Questions"
        title="How it works, in plain terms."
        lede="Everything here is enforced by the contracts and the client, and every claim is something you can verify yourself."
        aside="Straight answers"
      />

      <div className={s.list}>
        {ENTRIES.map((entry) => (
          <details className={s.entry} key={entry.id} name="faq" data-reveal>
            <summary className={s.summary}>
              <span className={s.marker} aria-hidden="true">
                <span className={s.markerH} />
                <span className={s.markerV} />
              </span>
              <span className={s.question}>{entry.question}</span>
            </summary>
            <div className={s.answer}>{entry.answer}</div>
          </details>
        ))}
      </div>
    </div>
  );
}
