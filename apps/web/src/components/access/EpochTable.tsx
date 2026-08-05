'use client';

/**
 * Every sealed epoch, with the arithmetic on show.
 *
 * `share = holderAmount × balanceOfAt(you, snapshot) ÷ eligibleSupply`, exactly
 * as `RevenueVault` computes it. The snapshot block is a link, the balance is
 * the historical checkpoint the vault itself reads, and the share is derived
 * from those two — nothing here is a server-side opinion.
 *
 * `sealEpoch()` is permissionless: once 7 days have passed and revenue is
 * waiting, *anyone* can seal, and this button says so.
 */

import { useCallback, type ReactNode } from 'react';
import type { Address } from 'viem';
import { useWriteContract } from 'wagmi';

import { revenueVaultAbi } from '@/lib/abi';
import { explorerBlockUrl, type ContractAddresses } from '@/lib/chain';
import { cx } from '@/lib/cx';
import {
  formatBlock,
  formatCount,
  formatDate,
  formatShare,
  formatToken,
} from '@/lib/format';
import { Button, Countdown, Panel, PanelHeader, useToast } from '@/components/ui';
import { EmptyState, Notice } from './Notice';
import { useTxState } from './use-tx';
import type { EpochRow, EpochsState, VaultState } from './use-access-data';
import s from './EpochTable.module.css';

export interface EpochTableProps {
  readonly contracts: ContractAddresses | null;
  readonly address: Address | null;
  readonly isConnected: boolean;
  readonly wrongNetwork: boolean;
  readonly vault: VaultState;
  readonly epochs: EpochsState;
  readonly nowSeconds: bigint | null;
  readonly onRefresh: () => void;
  /** Demo mode: fixture epochs — snapshot heights are synthetic, so no explorer links. */
  readonly demo?: boolean;
}

type RowStatus = 'claimed' | 'claimable' | 'swept' | 'none';

function statusOf(row: EpochRow, isConnected: boolean): RowStatus {
  if (!isConnected) return 'none';
  if (row.hasClaimed) return 'claimed';
  if (row.userClaimable > 0n) return 'claimable';
  if (row.swept) return 'swept';
  return 'none';
}

const STATUS_LABEL: Readonly<Record<RowStatus, string>> = {
  claimed: 'Claimed',
  claimable: 'Claimable',
  swept: 'Swept',
  none: 'No share',
};

interface CellProps {
  readonly label: string;
  readonly children: ReactNode;
  readonly className?: string;
}

function Cell({ label, children, className }: CellProps): ReactNode {
  return (
    <div className={cx(s.cell, className)} role="cell">
      <span className={s.cellLabel} aria-hidden="true">
        {label}
      </span>
      <span className={s.cellValue}>{children}</span>
    </div>
  );
}

export function EpochTable({
  contracts,
  address,
  isConnected,
  wrongNetwork,
  vault,
  epochs,
  nowSeconds,
  onRefresh,
  demo = false,
}: EpochTableProps): ReactNode {
  const toast = useToast();
  const { writeContractAsync } = useWriteContract();
  const sealTx = useTxState();

  const pending = vault.pendingHolders ?? 0n;
  const nextSealAt = vault.nextSealAt;
  const dueByTime = nowSeconds !== null && nextSealAt !== null && nowSeconds >= nextSealAt;
  const hasSomethingToSeal = pending > 0n;
  const canSeal =
    contracts !== null &&
    address !== null &&
    isConnected &&
    !wrongNetwork &&
    dueByTime &&
    hasSomethingToSeal &&
    !sealTx.busy;

  const onSeal = useCallback(async (): Promise<void> => {
    if (contracts === null) return;
    const ok = await sealTx.run(
      () =>
        writeContractAsync({
          address: contracts.revenueVault,
          abi: revenueVaultAbi,
          functionName: 'sealEpoch',
        }),
      'Sealing the epoch',
    );
    if (ok) {
      onRefresh();
      toast.push({
        kind: 'success',
        title: 'Epoch sealed',
        body: 'A snapshot block is now fixed. Every holder at that block can claim their share.',
      });
    }
  }, [contracts, onRefresh, sealTx, toast, writeContractAsync]);

  const sealReason = !hasSomethingToSeal
    ? 'No revenue has arrived since the last seal, so there is nothing to snapshot.'
    : !dueByTime
      ? 'Epochs are at least 7 days apart. Sealing opens when the countdown reaches zero.'
      : !isConnected
        ? 'Connect a wallet to send the transaction. Any address may seal — it does not have to be yours.'
        : wrongNetwork
          ? 'Switch to Robinhood Chain to send the transaction.'
          : 'Ready. Anyone may seal — it costs only gas and pays the caller nothing.';

  return (
    <Panel as="section" tone="raised" notch="tr" className={s.panel}>
      <PanelHeader
        label="Epochs"
        note={`${formatCount(vault.epochCount)} sealed · snapshots are historical balances, not deposits`}
      />

      {/* ── the seal control ─────────────────────────────────────────────── */}
      <div className={s.seal}>
        <div className={s.sealMeta}>
          <span className={s.sealLabel}>Next seal opens in</span>
          {nextSealAt === null ? (
            <span className={s.sealPending}>—</span>
          ) : (
            <Countdown
              to={nextSealAt}
              size="md"
              warnSeconds={0}
              expiredLabel="Open now"
              showSeconds
            />
          )}
          <span className={s.sealNote}>{sealReason}</span>
        </div>

        <div className={s.sealSide}>
          <span className={s.permissionless}>
            <span className={s.permissionlessMark} aria-hidden="true" />
            Permissionless
          </span>
          <Button
            variant={canSeal ? 'primary' : 'ghost'}
            loading={sealTx.busy}
            loadingLabel={sealTx.phase === 'confirming' ? 'Confirming' : 'Confirm in wallet'}
            disabled={!canSeal}
            onClick={() => void onSeal()}
          >
            Seal epoch
          </Button>
        </div>
      </div>

      {sealTx.error !== null && (
        <div className={s.sealNotice}>
          <Notice
            tone={sealTx.error.kind === 'rejected' ? 'info' : 'error'}
            title={sealTx.error.title}
            body={sealTx.error.detail}
            meta={
              sealTx.error.revertName === null
                ? undefined
                : `revert ${sealTx.error.revertName}()`
            }
          />
        </div>
      )}

      {/* ── the table ────────────────────────────────────────────────────── */}
      {epochs.rows.length === 0 ? (
        <EmptyState
          eyebrow="No epochs"
          title="Nothing has been snapshotted yet"
          body="Revenue from activations and room rents accrues to the vault continuously. Sealing turns whatever has accrued into a fixed pool and pins the block that decides who is owed what."
        />
      ) : (
        <div className={s.tableWrap}>
          <div className={s.table} role="table" aria-label="Sealed revenue epochs">
            <div className={cx(s.row, s.headRow)} role="row">
              <span className={s.headCell} role="columnheader">
                Epoch
              </span>
              <span className={s.headCell} role="columnheader">
                Snapshot
              </span>
              <span className={s.headCell} role="columnheader">
                Holders&apos; pool
              </span>
              <span className={s.headCell} role="columnheader">
                Your balance then
              </span>
              <span className={s.headCell} role="columnheader">
                Your share
              </span>
              <span className={s.headCell} role="columnheader">
                Status
              </span>
            </div>

            {epochs.rows.map((row) => {
              const status = statusOf(row, isConnected);
              /* A demo snapshot height points at no real block — never link it. */
              const blockUrl = demo ? null : explorerBlockUrl(row.snapshot);

              return (
                <div key={row.id} className={s.row} role="row" data-status={status}>
                  <Cell label="Epoch" className={s.cellId}>
                    <span className={s.id}>{`#${row.id}`}</span>
                    <span className={s.idNote}>
                      {row.sealedAt > 0n ? formatDate(row.sealedAt) : '—'}
                    </span>
                  </Cell>

                  <Cell label="Snapshot">
                    {blockUrl === null ? (
                      <span className={s.mono}>{formatBlock(row.snapshot)}</span>
                    ) : (
                      <a
                        className={cx(s.mono, s.blockLink)}
                        href={blockUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        {formatBlock(row.snapshot)}
                      </a>
                    )}
                    <span className={s.cellNote}>
                      {`eligible ${formatToken(row.eligibleSupply, { digits: 0, compact: true })}`}
                    </span>
                  </Cell>

                  <Cell label="Holders' pool">
                    <span className={s.mono}>
                      {formatToken(row.holderAmount, { digits: 2 })}
                    </span>
                    <span className={s.cellNote}>
                      {`${formatToken(row.claimed, { digits: 2 })} claimed`}
                    </span>
                  </Cell>

                  <Cell label="Your balance then">
                    <span className={s.mono}>
                      {row.userBalanceAt === null
                        ? '—'
                        : formatToken(row.userBalanceAt, { digits: 2 })}
                    </span>
                    <span className={s.cellNote}>
                      {row.userBalanceAt === null || row.eligibleSupply === 0n
                        ? isConnected
                          ? 'no eligible supply'
                          : 'not connected'
                        : `${formatShare(row.userBalanceAt, row.eligibleSupply, 4)} of supply`}
                    </span>
                  </Cell>

                  <Cell label="Your share">
                    <span className={cx(s.mono, s.share)}>
                      {row.userShare === null
                        ? '—'
                        : formatToken(row.userShare, { digits: 4 })}
                    </span>
                    <span className={s.cellNote}>THOOD</span>
                  </Cell>

                  <Cell label="Status" className={s.cellStatus}>
                    <span className={cx(s.status, s[`status_${status}`])}>
                      <span className={s.statusDot} aria-hidden="true" />
                      {STATUS_LABEL[status]}
                    </span>
                  </Cell>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className={s.foot}>
        <p className={s.footText}>
          A share is fixed the moment an epoch seals: it depends only on your $THOOD
          balance at the snapshot block. Buying after the snapshot earns nothing from that
          epoch; selling after it changes nothing — the share is still yours.
        </p>
        {vault.claimWindowSeconds !== null && (
          <p className={s.footText}>
            {`Unclaimed revenue can be swept to the treasury after ${formatCount(
              vault.claimWindowSeconds / 86_400n,
            )} days, so claim within the window.`}
          </p>
        )}
        {epochs.truncated && (
          <p className={s.footText}>
            Showing the most recent epochs only. Older ones are past the claim window.
          </p>
        )}
      </div>
    </Panel>
  );
}
