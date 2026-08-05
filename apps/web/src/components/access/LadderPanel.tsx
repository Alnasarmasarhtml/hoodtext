'use client';

/**
 * The holder status ladder — pure status and capacity, never money.
 *
 * Four rungs (RESIDENT → KINGPIN), each drawn against the wallet's
 * `eligibleBalance`: the LOWER of the live balance and the balance at the last
 * sealed revenue snapshot. That single honest number is why a tier cannot be
 * flash-bought before a perk check and dumped after — and why selling drops it
 * immediately. The revenue share itself needs none of this: every holder is
 * paid pro-rata from the first token.
 */

import type { ReactNode } from 'react';
import type { Address } from 'viem';

import {
  PERK_LADDER,
  PerkTier,
  perkTierLabel,
  type PerkTierSpec,
} from '@/lib/abi';
import type { ContractAddresses } from '@/lib/chain';
import { cx } from '@/lib/cx';
import { formatToken } from '@/lib/format';
import { useConnectSheet } from '@/lib/ui-store';
import { Button, Eyebrow, Panel, PanelHeader } from '@/components/ui';
import { EmptyState } from './Notice';
import type { PerksState } from './use-access-data';
import s from './LadderPanel.module.css';

export interface LadderPanelProps {
  readonly contracts: ContractAddresses | null;
  readonly address: Address | null;
  readonly isConnected: boolean;
  readonly wrongNetwork: boolean;
  readonly perks: PerksState;
  /** Demo mode: render the held ladder from fixture perks with no chain reads. */
  readonly demo?: boolean;
}

/** Progress toward `threshold`, clamped to [0, 1], computed in bigint. */
function progressOf(balance: bigint | null, threshold: bigint | null): number {
  if (balance === null || threshold === null || threshold === 0n) return 0;
  if (balance >= threshold) return 1;
  return Number((balance * 1000n) / threshold) / 1000;
}

interface RungProps {
  readonly spec: PerkTierSpec;
  readonly threshold: bigint | null;
  readonly eligible: bigint | null;
  readonly held: boolean;
  readonly isCurrent: boolean;
}

function Rung({ spec, threshold, eligible, held, isCurrent }: RungProps): ReactNode {
  const progress = progressOf(eligible, threshold);
  const thresholdLabel =
    threshold === null
      ? `${formatToken(BigInt(spec.thood) * 10n ** 18n, { digits: 0, compact: true })} THOOD`
      : `${formatToken(threshold, { digits: 0, compact: true })} THOOD`;

  return (
    <li className={cx(s.rung, held && s.rungHeld, isCurrent && s.rungCurrent)}>
      <div className={s.rungHead}>
        <span className={s.rungTier}>{`T${spec.id}`}</span>
        <span className={s.rungName}>{spec.label}</span>
        <span className={s.rungThreshold}>
          {`${spec.supplyPct} · ${thresholdLabel}`}
        </span>
      </div>

      <div
        className={s.rungBar}
        role="img"
        aria-label={
          held
            ? `${spec.label}: held`
            : `${spec.label}: ${Math.floor(progress * 100)}% of the threshold`
        }
      >
        <span className={s.rungFill} style={{ width: `${(progress * 100).toFixed(1)}%` }} />
      </div>

      <ul className={s.rungUnlocks}>
        {spec.unlocks.map((unlock) => (
          <li className={s.rungUnlock} key={unlock}>
            <span className={s.rungUnlockMark} aria-hidden="true" />
            {unlock}
          </li>
        ))}
      </ul>
    </li>
  );
}

export function LadderPanel({
  contracts,
  address,
  isConnected,
  wrongNetwork,
  perks,
  demo = false,
}: LadderPanelProps): ReactNode {
  const openWallet = useConnectSheet((state) => state.open);

  if (!demo && (!isConnected || wrongNetwork || contracts === null)) {
    return (
      <Panel as="section" tone="raised" notch="tr" className={s.panel}>
        <PanelHeader label="Status ladder" note="Status and capacity — never money" />
        <EmptyState
          eyebrow={
            contracts === null ? 'Not deployed' : wrongNetwork ? 'Wrong network' : 'Not connected'
          }
          title={
            contracts === null
              ? 'No deployment here'
              : wrongNetwork
                ? 'Switch networks to read your tier'
                : 'Connect to see your rung'
          }
          body={
            contracts === null
              ? 'This build has no Perks address for the active chain.'
              : wrongNetwork
                ? 'The ladder lives on Robinhood Chain. Your wallet is pointed somewhere else.'
                : 'Four rungs, judged purely on how much $THOOD you hold — the revenue share itself needs no tier at all.'
          }
          action={
            contracts !== null && !wrongNetwork ? (
              <Button
                variant="primary"
                onClick={() => openWallet('Reading your perk tier from the chain.')}
              >
                Connect wallet
              </Button>
            ) : undefined
          }
          mark={false}
        />
      </Panel>
    );
  }

  const eligible = perks.eligibleBalance;

  return (
    <Panel as="section" tone="raised" notch="tr" className={s.panel} highlight>
      <PanelHeader label="Status ladder" note="Status and capacity — never money" />

      <div className={s.body}>
        <div className={s.rank}>
          <Eyebrow size="micro">Your rank</Eyebrow>
          <span className={cx(s.rankName, perks.tier === PerkTier.NONE && s.rankNone)}>
            {perks.tier === PerkTier.NONE ? 'NO TIER' : perkTierLabel(perks.tier)}
          </span>
          <span className={s.rankBalance}>
            {eligible === null
              ? 'reading…'
              : `eligible balance ${formatToken(eligible, { digits: 0, symbol: 'THOOD' })}`}
          </span>
        </div>

        <ol className={s.ladder}>
          {PERK_LADDER.map((spec, index) => (
            <Rung
              key={spec.id}
              spec={spec}
              threshold={perks.thresholds[index] ?? null}
              eligible={eligible}
              held={perks.tier >= spec.id}
              isCurrent={perks.tier === spec.id}
            />
          ))}
        </ol>

        <p className={s.mechanic}>
          Judged on the <strong>lower</strong> of your balance now and your balance at
          the last weekly snapshot — a tier must be held through a snapshot, so it
          cannot be flash-bought, and selling drops it immediately.
        </p>
        <p className={s.mechanic}>
          The revenue share needs no tier: every holder is paid pro-rata from the first
          token. The ladder is status and capacity, never a claim on anyone&apos;s money.
        </p>
      </div>
    </Panel>
  );
}
