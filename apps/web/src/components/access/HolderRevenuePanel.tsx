'use client';

/**
 * The headline: 50% of every payment — $5 activations and $10/month room
 * rents — paid to holders by holdings.
 *
 * There is no staking contract, no lock-up and no deposit anywhere in this
 * product. Eligibility is a historical balance checkpoint (`balanceOfAt`) at
 * each epoch's snapshot block — holding $THOOD in your own wallet at that block
 * is the entire requirement (SPEC §4.5).
 */

import { useCallback, useMemo, type ReactNode } from 'react';
import type { Address } from 'viem';
import { useWriteContract } from 'wagmi';

import { revenueVaultAbi } from '@/lib/abi';
import type { ContractAddresses } from '@/lib/chain';
import { cx } from '@/lib/cx';
import { formatBps, formatCount, formatToken } from '@/lib/format';
import { useConnectSheet } from '@/lib/ui-store';
import { Button, Eyebrow, Panel, PanelHeader, Stat, useToast } from '@/components/ui';
import { EmptyState, Notice } from './Notice';
import { useTxState } from './use-tx';
import type {
  EpochsState,
  RevenueHistoryView,
  TokenState,
  VaultState,
} from './use-access-data';
import s from './HolderRevenuePanel.module.css';

/** Bounded so a wallet with a long tail of epochs cannot build an untenable tx. */
const MAX_CLAIM_BATCH = 32;

const FRAME = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export interface HolderRevenuePanelProps {
  readonly contracts: ContractAddresses | null;
  readonly address: Address | null;
  readonly isConnected: boolean;
  readonly wrongNetwork: boolean;
  readonly vault: VaultState;
  readonly epochs: EpochsState;
  readonly token: TokenState;
  readonly history: RevenueHistoryView;
  readonly onRefresh: () => void;
  /** Demo mode: fixture figures; "claim all" flips the fixtures locally. */
  readonly demo?: boolean;
  /** Demo only — flips the unclaimed epochs to claimed and zeroes claimable. */
  readonly onDemoClaimAll?: () => void;
}

function toDisplayNumber(value: bigint): number {
  return Number(value) / 1e18;
}

export function HolderRevenuePanel({
  contracts,
  address,
  isConnected,
  wrongNetwork,
  vault,
  epochs,
  token,
  history,
  onRefresh,
  demo = false,
  onDemoClaimAll,
}: HolderRevenuePanelProps): ReactNode {
  const toast = useToast();
  const openWallet = useConnectSheet((state) => state.open);
  const { writeContractAsync } = useWriteContract();
  const claimTx = useTxState();

  const totals = history.data;
  const holderBps = vault.holderBps ?? 5000n;
  const claimable = epochs.totalClaimable;
  const lifetime = epochs.lifetimeClaimed;

  const batch = useMemo(
    () => epochs.claimableIds.slice(0, MAX_CLAIM_BATCH),
    [epochs.claimableIds],
  );
  const remainder = epochs.claimableIds.length - batch.length;

  const canClaim = demo
    ? batch.length > 0
    : contracts !== null &&
      address !== null &&
      isConnected &&
      !wrongNetwork &&
      batch.length > 0 &&
      !claimTx.busy;

  const onClaim = useCallback(async (): Promise<void> => {
    if (demo) {
      /* No transaction: the fixture epochs flip to claimed and the claimable
         figure lands in lifetime — the same read-back a confirmed claimMany
         would produce. */
      onDemoClaimAll?.();
      toast.push({
        kind: 'success',
        title: 'Claimed — simulated',
        body: `${formatToken(claimable, { digits: 2, symbol: 'THOOD' })} across ${formatCount(batch.length)} ${batch.length === 1 ? 'epoch' : 'epochs'}. In the live app this is one claimMany() transaction, straight to your wallet.`,
      });
      return;
    }
    if (contracts === null || batch.length === 0) return;
    const ok = await claimTx.run(
      () =>
        writeContractAsync({
          address: contracts.revenueVault,
          abi: revenueVaultAbi,
          functionName: 'claimMany',
          args: [batch],
        }),
      'Claiming revenue',
    );
    if (ok) {
      onRefresh();
      toast.push({
        kind: 'success',
        title: 'Claimed',
        body: `${formatToken(claimable, { digits: 2, symbol: 'THOOD' })} from ${formatCount(batch.length)} ${batch.length === 1 ? 'epoch' : 'epochs'} is in your wallet.`,
      });
    }
  }, [batch, claimTx, claimable, contracts, demo, onDemoClaimAll, onRefresh, toast, writeContractAsync]);

  /* ── the claim column ────────────────────────────────────────────────── */

  let claimBody: ReactNode;

  if (!isConnected) {
    claimBody = (
      <EmptyState
        eyebrow="Not connected"
        title="Connect to see your share"
        body="Your share is computed from your own $THOOD balance at each snapshot block. Nothing to deposit, nothing to opt into — connect and it is already calculated."
        action={
          <Button
            variant="primary"
            onClick={() => openWallet('Reading your $THOOD balance at each epoch snapshot.')}
          >
            Connect wallet
          </Button>
        }
        mark={false}
      />
    );
  } else if (!demo && (wrongNetwork || contracts === null)) {
    claimBody = (
      <EmptyState
        eyebrow={wrongNetwork ? 'Wrong network' : 'Not deployed'}
        title={wrongNetwork ? 'Switch networks to claim' : 'No vault configured'}
        body={
          wrongNetwork
            ? 'The vault lives on Robinhood Chain. Switch networks to read and claim your share.'
            : 'This build has no RevenueVault address for the active chain.'
        }
        mark={false}
      />
    );
  } else if (vault.epochCount === 0) {
    claimBody = (
      <EmptyState
        eyebrow="No epochs yet"
        title="Nothing has been sealed"
        body="Revenue accrues continuously and is snapshotted into an epoch at most once every 7 days. The first seal creates the first claim."
        mark={false}
      />
    );
  } else if (claimable === 0n) {
    claimBody = (
      <EmptyState
        eyebrow="Nothing claimable"
        title={lifetime > 0n ? 'You are fully claimed up' : 'No share in the sealed epochs'}
        body={
          lifetime > 0n
            ? `You have taken ${formatToken(lifetime, { digits: 2, symbol: 'THOOD' })} so far. The next epoch seals on the countdown below.`
            : 'A share is your $THOOD balance at a snapshot block divided by the eligible supply at that block. Holding $THOOD before the next snapshot is all it takes.'
        }
        mark={false}
      />
    );
  } else {
    claimBody = (
      <div className={s.claim}>
        <Stat
          className={s.claimStat}
          label="Claimable now"
          value={formatToken(claimable, { digits: 2, trim: false })}
          unit="THOOD"
          countUp={toDisplayNumber(claimable)}
          format={(value) => FRAME.format(value)}
          tone="green"
          size="lg"
          hint={`Across ${formatCount(epochs.claimableIds.length)} ${
            epochs.claimableIds.length === 1 ? 'epoch' : 'epochs'
          } — one transaction takes all of it.`}
        />

        <Button
          variant="primary"
          size="lg"
          block
          loading={claimTx.busy}
          loadingLabel={claimTx.phase === 'confirming' ? 'Confirming' : 'Confirm in wallet'}
          disabled={!canClaim}
          onClick={() => void onClaim()}
        >
          {`Claim ${formatToken(claimable, { digits: 2, symbol: 'THOOD' })}`}
        </Button>

        {remainder > 0 && (
          <p className={s.claimNote}>
            {`Claiming the ${MAX_CLAIM_BATCH} most recent epochs in this transaction. ${formatCount(remainder)} older ${remainder === 1 ? 'epoch remains' : 'epochs remain'} — claim again afterwards.`}
          </p>
        )}
      </div>
    );
  }

  /* ── revenue figures ─────────────────────────────────────────────────── */

  const revenueUnavailable = history.isError || (totals === undefined && !history.isPending);

  return (
    <Panel as="section" tone="raised" notch="tr" className={s.panel} highlight>
      <PanelHeader
        label="Holder revenue"
        note="Paid by holdings, from a historical snapshot"
        aside={
          vault.isSolvent === false ? (
            <span className={s.solvency}>Solvency check failed</span>
          ) : undefined
        }
      />

      <div className={s.hero}>
        <div className={s.heroText}>
          <h2 className={s.heroTitle}>
            Half of every payment goes to{' '}
            <span className={s.wordmark}>$THOOD</span> holders.
          </h2>
          <p className={s.heroBody}>
            Every $5 activation and every $10 of room rent. Not to a staking pool, not
            to anyone who locked tokens up — to whoever held $THOOD in their own wallet
            at the moment an epoch was snapshotted, read straight off the token&apos;s
            balance checkpoints.
          </p>
          <ul className={s.chips}>
            <li className={s.chip}>No staking</li>
            <li className={s.chip}>No lock-up</li>
            <li className={s.chip}>No deposit</li>
            <li className={s.chip}>No delegation</li>
          </ul>
        </div>

        {/* The split, drawn. Two halves, hairline-separated, labelled. */}
        <div className={s.split}>
          <div className={s.splitBar} role="img" aria-label="Fifty percent to holders, fifty percent to the treasury">
            <span className={s.splitHolders} />
            <span className={s.splitTreasury} />
          </div>
          <div className={s.splitLegend}>
            <span className={s.splitItem}>
              <span className={cx(s.splitMark, s.splitMarkHolders)} aria-hidden="true" />
              {`${formatBps(holderBps)} holders`}
            </span>
            <span className={s.splitItem}>
              <span className={cx(s.splitMark, s.splitMarkTreasury)} aria-hidden="true" />
              {`${formatBps(10_000n - holderBps)} treasury`}
            </span>
          </div>
        </div>
      </div>

      <div className={s.grid}>
        <div className={s.figures}>
          <Eyebrow rule>Revenue to date</Eyebrow>

          {revenueUnavailable ? (
            <Notice
              tone="warn"
              title="Revenue history unavailable"
              body="The RevenueReceived log scan did not complete, so totals cannot be shown honestly. Per-epoch amounts below are read from contract state and are unaffected."
            />
          ) : (
            <>
              <div className={s.statRow}>
                <Stat
                  label="Total revenue"
                  value={
                    totals === undefined
                      ? '—'
                      : formatToken(totals.total, { digits: 2, trim: false })
                  }
                  unit="THOOD"
                  size="md"
                  hint={
                    totals === undefined
                      ? 'reading…'
                      : `${formatCount(totals.entries.length)} ${totals.entries.length === 1 ? 'payment' : 'payments'} — activations and rents`
                  }
                />
                <Stat
                  label="To holders"
                  value={
                    totals === undefined
                      ? '—'
                      : formatToken(totals.toHolders, { digits: 2, trim: false })
                  }
                  unit="THOOD"
                  size="md"
                  tone="bone"
                  hint="Split off the moment each payment arrives"
                />
                <Stat
                  label="To treasury"
                  value={
                    totals === undefined
                      ? '—'
                      : formatToken(totals.toTreasury, { digits: 2, trim: false })
                  }
                  unit="THOOD"
                  size="md"
                  tone="muted"
                  hint="Funds the product, not the holders' half"
                />
              </div>

              <div className={s.subRow}>
                <div className={s.subItem}>
                  <span className={s.subLabel}>Banked, not yet snapshotted</span>
                  <span className={s.subValue}>
                    {vault.pendingHolders === null
                      ? '—'
                      : formatToken(vault.pendingHolders, { digits: 2, symbol: 'THOOD' })}
                  </span>
                </div>
                <div className={s.subItem}>
                  <span className={s.subLabel}>Sealed and unclaimed</span>
                  <span className={s.subValue}>
                    {vault.sealedUnclaimed === null
                      ? '—'
                      : formatToken(vault.sealedUnclaimed, { digits: 2, symbol: 'THOOD' })}
                  </span>
                </div>
                <div className={s.subItem}>
                  <span className={s.subLabel}>Your lifetime claimed</span>
                  <span className={s.subValue}>
                    {isConnected
                      ? formatToken(lifetime, { digits: 2, symbol: 'THOOD' })
                      : 'not connected'}
                  </span>
                </div>
                <div className={s.subItem}>
                  <span className={s.subLabel}>Your $THOOD balance</span>
                  <span className={s.subValue}>
                    {token.balance === null
                      ? isConnected
                        ? '—'
                        : 'not connected'
                      : formatToken(token.balance, { digits: 2, symbol: 'THOOD' })}
                  </span>
                </div>
              </div>
            </>
          )}

          {totals !== undefined && totals.partial && (
            <Notice
              tone="info"
              title="Partial scan"
              body={`This endpoint capped the log query, so totals cover blocks ${formatCount(totals.scannedFrom)}–${formatCount(totals.scannedTo)} only. Older payments exist but were not read.`}
            />
          )}
        </div>

        <div className={s.claimColumn}>
          <Eyebrow rule>Your claim</Eyebrow>
          {claimBody}

          {claimTx.error !== null && (
            <Notice
              tone={claimTx.error.kind === 'rejected' ? 'info' : 'error'}
              title={claimTx.error.title}
              body={claimTx.error.detail}
              meta={
                claimTx.error.revertName === null
                  ? undefined
                  : `revert ${claimTx.error.revertName}()`
              }
            />
          )}

          {claimTx.phase === 'confirmed' && (
            <Notice
              tone="ok"
              title="Claimed"
              body="Your share was transferred straight to your wallet. Nothing stayed behind and nothing was locked."
              action={
                claimTx.explorerUrl === null ? undefined : (
                  <a
                    className={s.txLink}
                    href={claimTx.explorerUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    View transaction
                  </a>
                )
              }
            />
          )}
        </div>
      </div>
    </Panel>
  );
}
