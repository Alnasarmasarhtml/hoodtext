'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

import { buttonClassName } from '@/components/ui/Button';
import { CONTRACT_CONSTANTS } from '@/lib/abi';
import { formatBps, formatCount } from '@/lib/format';
import s from './RevenueShare.module.css';
import { SectionHead } from './SectionHead';
import { TokenMark } from './TokenMark';

/** 1,000,000,000 $THOOD — `TeleHoodToken.MAX_SUPPLY`, minted once at deploy. */
const MAX_SUPPLY = 1_000_000_000;

const DAY = 86_400;

interface Requirement {
  readonly label: string;
  readonly value: string;
  readonly required: boolean;
}

/**
 * The list is written as refusals on purpose. Every one of these is something a
 * revenue-share token normally asks for, and this one does not.
 */
const REQUIREMENTS: readonly Requirement[] = [
  { label: 'Deposit', value: 'not required', required: false },
  { label: 'Lock-up', value: 'not required', required: false },
  { label: 'Delegation', value: 'not required', required: false },
  { label: 'Staking', value: 'does not exist', required: false },
  { label: 'Hold $THOOD at the snapshot block', value: 'that is all', required: true },
];

interface Figure {
  readonly label: string;
  readonly value: string;
  readonly note: string;
}

const FIGURES: readonly Figure[] = [
  {
    label: 'Supply',
    value: formatCount(MAX_SUPPLY),
    note: 'Minted once. No mint path afterwards.',
  },
  {
    label: 'Holder share',
    value: formatBps(CONTRACT_CONSTANTS.holderBps),
    note: 'Of every activation and every rent, forever.',
  },
  {
    label: 'Snapshot cadence',
    value: `${CONTRACT_CONSTANTS.epochMinIntervalSeconds / DAY} days`,
    note: 'Minimum interval. Anyone may seal an epoch.',
  },
  {
    label: 'Claim window',
    value: `${CONTRACT_CONSTANTS.claimWindowSeconds / DAY} days`,
    note: 'Per epoch. Unclaimed value returns to treasury.',
  },
];

/**
 * The token section.
 *
 * The mechanism is the pitch: real protocol revenue — $5 activations and
 * $10/month room rents — split in half at the vault and paid out against
 * historical balance checkpoints, which is precisely why nobody has to stake
 * anything.
 */
export function RevenueShare(): ReactNode {
  return (
    <div className="wrap">
      <SectionHead
        index="06"
        eyebrow="Revenue share"
        title="50% of every payment goes to holders."
        lede={
          <>
            Written into <code className={s.code}>RevenueVault</code> and enforced on
            every payment — every $5 activation, every $10 of room rent. Half is set
            aside the moment it lands and paid out pro-rata by{' '}
            <strong>holdings</strong>.
          </>
        }
        aside="HOLDER_BPS = 5000"
      />

      <div className={s.headline} data-reveal>
        <div className={s.split}>
          <div className={s.splitBar} aria-hidden="true">
            <span className={s.splitHolders} />
            <span className={s.splitTreasury} />
          </div>
          <div className={s.splitLegend}>
            <span className={s.splitLabel}>
              <span className={s.swatchHolders} aria-hidden="true" />
              50% · holders, by holdings
            </span>
            <span className={s.splitLabel}>
              <span className={s.swatchTreasury} aria-hidden="true" />
              50% · treasury
            </span>
          </div>
        </div>

        <p className={s.claim}>
          No staking. No lock-up. Hold <TokenMark /> in your own wallet and you are
          counted at every weekly snapshot.
        </p>
      </div>

      <div className={s.body}>
        <div className={s.mechanism} data-reveal>
          <h3 className={s.mechanismTitle}>How an epoch pays out</h3>
          <ol className={s.sentences}>
            {/* The prose is wrapped, not left loose: `.sentence` is a grid, and a
                bare text node beside an inline element would split into two
                separate grid items instead of flowing as one sentence. */}
            <li className={s.sentence}>
              <span className={s.sentenceIndex}>01</span>
              <span className={s.sentenceText}>
                Every payment — a $5 activation or a room&apos;s rent — goes straight
                into the vault, and half of it is set aside for holders.
              </span>
            </li>
            <li className={s.sentence}>
              <span className={s.sentenceIndex}>02</span>
              <span className={s.sentenceText}>
                At least every seven days anyone can call{' '}
                <code className={s.code}>sealEpoch()</code>, which freezes that
                half against a past block — the snapshot.
              </span>
            </li>
            <li className={s.sentence}>
              <span className={s.sentenceIndex}>03</span>
              <span className={s.sentenceText}>
                Your share is your balance at that block divided by the eligible
                supply, and you can claim it any time in the next 180 days.
              </span>
            </li>
          </ol>

          <p className={s.recurring}>
            <span className={s.recurringKey}>It recurs.</span> Every new account is
            another $5; every month a room pays its rent, half of that payment is set
            aside again — against whoever holds <TokenMark quiet /> at that week’s
            snapshot.
          </p>

          <div className={s.actions}>
            <Link
              href="/access"
              className={buttonClassName({ variant: 'ghost', size: 'md' })}
            >
              Claim on /access
            </Link>
            <span className={s.actionNote}>
              Sealing an epoch is permissionless — you do not need us
            </span>
          </div>
        </div>

        <div className={s.aside}>
          <ul className={s.requirements} data-reveal>
            {REQUIREMENTS.map((requirement) => (
              <li
                className={requirement.required ? s.requirementYes : s.requirement}
                key={requirement.label}
              >
                <span className={s.requirementMark} aria-hidden="true" />
                <span className={s.requirementLabel}>{requirement.label}</span>
                <span className={s.requirementValue}>{requirement.value}</span>
              </li>
            ))}
          </ul>

          <dl className={s.figures} data-reveal>
            {FIGURES.map((figure) => (
              <div className={s.figure} key={figure.label}>
                <dt className={s.figureLabel}>{figure.label}</dt>
                <dd className={s.figureValue}>{figure.value}</dd>
                <dd className={s.figureNote}>{figure.note}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </div>
  );
}
