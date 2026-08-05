'use client';

/**
 * The rooms the connected wallet runs, and their rent.
 *
 * Discovery is pure chain: `GroupCreated(admin = you)` and
 * `AdminTransferred(to = you)` logs produce the candidates, and the `groups()`
 * struct read is the authority on who admins what today. Per room: the rent
 * clock, a 1–24 month pay flow (anyone may pay a room's rent — paying grants
 * no control), and the auto-renew switch with the allowance that funds it made
 * visible. A lapsed room blocks new messages only — history and admin survive,
 * and paying here reopens it exactly as it was.
 */

import { useCallback, useState, type ReactNode } from 'react';
import type { Address } from 'viem';
import { useWriteContract } from 'wagmi';

import { groupRegistryAbi, teleHoodTokenAbi } from '@/lib/abi';
import type { ContractAddresses } from '@/lib/chain';
import { cx } from '@/lib/cx';
import {
  formatDate,
  formatDateTime,
  formatToken,
  formatUsd18,
  truncateRef,
} from '@/lib/format';
import { useConnectSheet } from '@/lib/ui-store';
import {
  Button,
  Countdown,
  Eyebrow,
  MonthStepper,
  Panel,
  PanelHeader,
  useToast,
} from '@/components/ui';
import { EmptyState, Notice } from './Notice';
import { useTxState } from './use-tx';
import {
  useDebounced,
  useRentQuote,
  type PricingState,
  type RoomRow,
  type RoomsState,
  type TokenState,
} from './use-access-data';
import s from './RoomsPanel.module.css';

export interface RoomsPanelProps {
  readonly contracts: ContractAddresses | null;
  readonly address: Address | null;
  readonly isConnected: boolean;
  readonly wrongNetwork: boolean;
  readonly pricing: PricingState;
  readonly rooms: RoomsState;
  readonly token: TokenState;
  readonly nowSeconds: bigint | null;
  readonly onRefresh: () => void;
}

/** How many whole months of rent the registry allowance covers. */
function monthsOfCover(allowance: bigint | null, monthly: bigint | null): number | null {
  if (allowance === null || monthly === null || monthly === 0n) return null;
  return Number(allowance / monthly);
}

/* ═══════════════════════════════════════════════════════════ room card ═══ */

interface RoomCardProps {
  readonly contracts: ContractAddresses;
  readonly room: RoomRow;
  readonly pricing: PricingState;
  readonly token: TokenState;
  readonly nowSeconds: bigint | null;
  readonly canWrite: boolean;
  readonly onRefresh: () => void;
}

function RoomCard({
  contracts,
  room,
  pricing,
  token,
  nowSeconds,
  canWrite,
  onRefresh,
}: RoomCardProps): ReactNode {
  const toast = useToast();
  const { writeContractAsync } = useWriteContract();

  const approveTx = useTxState();
  const payTx = useTxState();
  const autoRenewTx = useTxState();

  const [months, setMonths] = useState(1);
  const settledMonths = useDebounced(months, 220);
  const { quote, isLoading: quoting } = useRentQuote(contracts, settledMonths);
  const quoteStale = months !== settledMonths || quoting;

  const active = nowSeconds !== null && room.paidUntil > nowSeconds;
  const lapsed = nowSeconds !== null && room.paidUntil <= nowSeconds;
  const nearLapse =
    active &&
    nowSeconds !== null &&
    room.paidUntil - nowSeconds <= 7n * 86_400n;

  const allowance = token.registryAllowance;
  const balance = token.balance;
  const needsApproval = quote !== null && allowance !== null && allowance < quote;
  const shortOnBalance = quote !== null && balance !== null && balance < quote;

  const busy = approveTx.busy || payTx.busy || autoRenewTx.busy;

  const onApprove = useCallback(async (): Promise<void> => {
    if (quote === null) return;
    const ok = await approveTx.run(
      () =>
        writeContractAsync({
          address: contracts.token,
          abi: teleHoodTokenAbi,
          functionName: 'approve',
          args: [contracts.groupRegistry, quote],
        }),
      'Approving $THOOD',
    );
    if (ok) {
      onRefresh();
      toast.push({
        kind: 'success',
        title: 'Approved',
        body: `The room registry may now move ${formatToken(quote, { digits: 2, symbol: 'THOOD' })} — and not a wei more.`,
      });
    }
  }, [approveTx, contracts, onRefresh, quote, toast, writeContractAsync]);

  const onPay = useCallback(async (): Promise<void> => {
    const ok = await payTx.run(
      () =>
        writeContractAsync({
          address: contracts.groupRegistry,
          abi: groupRegistryAbi,
          functionName: 'payRent',
          args: [room.id, settledMonths],
        }),
      'Paying rent',
    );
    if (ok) {
      onRefresh();
      toast.push({
        kind: 'success',
        title: lapsed ? 'Room reopened' : 'Rent paid',
        body: `${settledMonths} ${settledMonths === 1 ? 'month' : 'months'} added. ${
          lapsed ? 'New messages flow again — nothing was ever deleted.' : 'The clock extends from the current paid-until date.'
        }`,
      });
    }
  }, [contracts, lapsed, onRefresh, payTx, room.id, settledMonths, toast, writeContractAsync]);

  const onToggleAutoRenew = useCallback(async (): Promise<void> => {
    const next = !room.autoRenew;
    const ok = await autoRenewTx.run(
      () =>
        writeContractAsync({
          address: contracts.groupRegistry,
          abi: groupRegistryAbi,
          functionName: 'setAutoRenew',
          args: [room.id, next],
        }),
      next ? 'Turning auto-renew on' : 'Turning auto-renew off',
    );
    if (ok) {
      onRefresh();
      toast.push({
        kind: 'success',
        title: next ? 'Auto-renew on' : 'Auto-renew off',
        body: next
          ? 'Inside the last 3 days of the term, anyone can buy this room 1 month — funded only by your own allowance.'
          : 'Nothing else changed. The room keeps whatever time it has.',
      });
    }
  }, [autoRenewTx, contracts, onRefresh, room.autoRenew, room.id, toast, writeContractAsync]);

  const cardError = payTx.error ?? approveTx.error ?? autoRenewTx.error;

  return (
    <li className={s.room} data-lapsed={lapsed ? 'true' : undefined}>
      {/* ── identity + clock ─────────────────────────────────────────────── */}
      <div className={s.roomHead}>
        <div className={s.roomId}>
          <span className={s.roomIdValue} title={room.id}>
            {truncateRef(room.id)}
          </span>
          <span className={s.roomCreated}>
            {`opened ${room.createdAt > 0n ? formatDate(room.createdAt) : '—'}`}
          </span>
        </div>

        <div className={s.roomClock}>
          {lapsed ? (
            <span className={s.lapsedBadge}>
              <span className={s.lapsedDot} aria-hidden="true" />
              Lapsed
            </span>
          ) : nearLapse ? (
            <Countdown to={room.paidUntil} size="md" warnSeconds={7 * 86_400} />
          ) : (
            <span className={s.roomUntilValue}>
              {room.paidUntil > 0n ? `active until ${formatDate(room.paidUntil)}` : '—'}
            </span>
          )}
          <span className={s.roomUntilNote}>
            {lapsed
              ? 'new messages blocked — history and admin survive'
              : formatDateTime(room.paidUntil)}
          </span>
        </div>
      </div>

      {lapsed && (
        <Notice
          tone="warn"
          title="Rent lapsed — nothing was deleted"
          body="Members, history and your admin role are all intact. Paying any number of months below reopens the room the same second."
        />
      )}

      {/* ── pay rent ─────────────────────────────────────────────────────── */}
      <div className={s.pay}>
        <div className={s.payControls}>
          <MonthStepper
            className={s.stepper}
            value={months}
            onChange={setMonths}
            max={pricing.maxMonths}
            label={`Months of rent for room ${truncateRef(room.id)}`}
            presets={[1, 3, 6, 12]}
            disabled={busy}
          />

          <div className={s.payQuote}>
            <span className={s.payQuoteLabel}>
              {`${settledMonths} ${settledMonths === 1 ? 'month' : 'months'} in $THOOD`}
            </span>
            <span className={cx(s.payQuoteValue, quoteStale && s.payQuoteStale)}>
              {quote === null ? '—' : formatToken(quote, { digits: 2, symbol: 'THOOD' })}
            </span>
            <span className={s.payQuoteNote}>
              {pricing.rentUsdPerMonth === null
                ? 'rate unavailable'
                : `${formatUsd18(pricing.rentUsdPerMonth)}/month, fixed in USD`}
            </span>
          </div>
        </div>

        <div className={s.payActions}>
          {needsApproval && (
            <Button
              variant="ghost"
              loading={approveTx.busy}
              loadingLabel={approveTx.phase === 'confirming' ? 'Confirming' : 'Approve in wallet'}
              disabled={!canWrite || busy || quote === null}
              onClick={() => void onApprove()}
            >
              Approve
            </Button>
          )}
          <Button
            variant="primary"
            loading={payTx.busy}
            loadingLabel={payTx.phase === 'confirming' ? 'Confirming' : 'Confirm in wallet'}
            disabled={
              !canWrite || busy || quote === null || needsApproval || shortOnBalance || quoteStale
            }
            onClick={() => void onPay()}
          >
            {lapsed ? 'Pay & reopen' : 'Pay rent'}
          </Button>
        </div>
      </div>

      {/* ── auto-renew ───────────────────────────────────────────────────── */}
      <div className={s.auto}>
        <div className={s.autoText}>
          <span className={s.autoLabel}>Auto-renew</span>
          <span className={s.autoNote}>
            On: anyone may call <code className={s.code}>renewFor</code> in the last 3
            days and buy 1 month — paid only from the allowance you approved below.
          </span>
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={room.autoRenew}
          aria-label={`Auto-renew for room ${truncateRef(room.id)}`}
          className={cx(s.switch, room.autoRenew && s.switchOn)}
          disabled={!canWrite || busy}
          onClick={() => void onToggleAutoRenew()}
        >
          <span className={s.switchTrack} aria-hidden="true">
            <span className={s.switchKnob} />
          </span>
          <span className={s.switchLabel}>
            {autoRenewTx.busy ? '···' : room.autoRenew ? 'ON' : 'OFF'}
          </span>
        </button>
      </div>

      {shortOnBalance && quote !== null && balance !== null && (
        <Notice
          tone="warn"
          title="Not enough $THOOD"
          body={`This term costs ${formatToken(quote, { digits: 2, symbol: 'THOOD' })} and your wallet holds ${formatToken(balance, { digits: 2, symbol: 'THOOD' })}. Pay fewer months or top up.`}
        />
      )}

      {cardError !== null && (
        <Notice
          tone={cardError.kind === 'rejected' ? 'info' : 'error'}
          title={cardError.title}
          body={cardError.detail}
          meta={cardError.revertName === null ? undefined : `revert ${cardError.revertName}()`}
        />
      )}

      {payTx.phase === 'confirmed' && payTx.explorerUrl !== null && (
        <Notice
          tone="ok"
          title="Rent anchored"
          body="The payment is confirmed on chain — half of it is already set aside for holders."
          action={
            <a
              className={s.txLink}
              href={payTx.explorerUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              View transaction
            </a>
          }
        />
      )}
    </li>
  );
}

/* ═══════════════════════════════════════════════════════════ the panel ═══ */

export function RoomsPanel({
  contracts,
  address,
  isConnected,
  wrongNetwork,
  pricing,
  rooms,
  token,
  nowSeconds,
  onRefresh,
}: RoomsPanelProps): ReactNode {
  const toast = useToast();
  const openWallet = useConnectSheet((state) => state.open);
  const { writeContractAsync } = useWriteContract();
  const allowanceTx = useTxState();

  const canWrite = contracts !== null && address !== null && isConnected && !wrongNetwork;
  const monthly = pricing.rentMonthQuote;
  const cover = monthsOfCover(token.registryAllowance, monthly);

  const setAllowance = useCallback(
    async (amount: bigint, label: string): Promise<void> => {
      if (contracts === null) return;
      const ok = await allowanceTx.run(
        () =>
          writeContractAsync({
            address: contracts.token,
            abi: teleHoodTokenAbi,
            functionName: 'approve',
            args: [contracts.groupRegistry, amount],
          }),
        label,
      );
      if (ok) {
        onRefresh();
        toast.push({
          kind: 'success',
          title: amount === 0n ? 'Allowance revoked' : 'Allowance updated',
          body:
            amount === 0n
              ? 'No renewal can be funded now, whatever any toggle says.'
              : `Rent payments and renewals may draw up to ${formatToken(amount, { digits: 2, symbol: 'THOOD' })} in total.`,
        });
      }
    },
    [allowanceTx, contracts, onRefresh, toast, writeContractAsync],
  );

  const count = rooms.rooms.length;

  /* ── states with nothing to show ─────────────────────────────────────── */

  if (!isConnected || wrongNetwork || contracts === null) {
    return (
      <Panel as="section" tone="raised" notch="tr" className={s.panel}>
        <PanelHeader label="Your rooms" note="$10/month each, paid by whoever runs the room" />
        <EmptyState
          eyebrow={
            contracts === null ? 'Not deployed' : wrongNetwork ? 'Wrong network' : 'Not connected'
          }
          title={
            contracts === null
              ? 'No deployment here'
              : wrongNetwork
                ? 'Switch networks to see your rooms'
                : 'Connect to see the rooms you run'
          }
          body={
            contracts === null
              ? 'This build has no GroupRegistry address for the active chain.'
              : wrongNetwork
                ? 'Rooms live on Robinhood Chain. Your wallet is pointed somewhere else.'
                : 'Rooms you admin are found from the chain itself — GroupCreated and AdminTransferred events against your address. Members always ride free.'
          }
          action={
            contracts !== null && !wrongNetwork ? (
              <Button
                variant="primary"
                onClick={() => openWallet('Reading the rooms you admin from the chain.')}
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

  return (
    <Panel as="section" tone="raised" notch="tr" className={s.panel} highlight>
      <PanelHeader
        label="Your rooms"
        note="$10/month each, paid by whoever runs the room — members free"
        aside={
          count > 0 ? (
            <span className={s.count}>{`${count} ${count === 1 ? 'room' : 'rooms'}`}</span>
          ) : undefined
        }
      />

      {rooms.isError ? (
        <div className={s.pad}>
          <Notice
            tone="warn"
            title="Room scan failed"
            body="The RPC endpoint refused the event query, so your rooms cannot be listed right now. Nothing about the rooms themselves changed."
          />
        </div>
      ) : rooms.isLoading && count === 0 ? (
        <div className={s.pad}>
          <div className={s.skeleton} aria-hidden="true">
            <span className={s.skeletonLine} />
          </div>
          <span className={s.skeletonNote}>Scanning the chain for your rooms…</span>
        </div>
      ) : count === 0 ? (
        <EmptyState
          eyebrow="No rooms"
          title="No rooms yet — open one from the app"
          body="Creating a room happens in the messenger. Whoever opens it pays its $10/month rent here; everyone they invite rides free, forever."
        />
      ) : (
        <>
          <ul className={s.list}>
            {rooms.rooms.map((room) => (
              <RoomCard
                key={room.id}
                contracts={contracts}
                room={room}
                pricing={pricing}
                token={token}
                nowSeconds={nowSeconds}
                canWrite={canWrite}
                onRefresh={onRefresh}
              />
            ))}
          </ul>

          {/* ── the renewal allowance, shared across rooms ───────────────── */}
          <div className={s.allowance}>
            <div className={s.allowanceText}>
              <Eyebrow>Renewal allowance</Eyebrow>
              <p className={s.allowanceCopy}>
                Auto-renew is funded <strong>only</strong> by this allowance — approve the
                registry for about a month of rent and anyone can renew you inside the
                3-day window. It can never move money you did not approve. Setting it to
                zero stops every renewal, whatever the toggles say.
              </p>
            </div>

            <div className={s.allowanceGrid}>
              <div className={s.allowanceRow}>
                <span className={s.allowanceLabel}>Approved</span>
                <span className={s.allowanceValue}>
                  {token.registryAllowance === null
                    ? '—'
                    : formatToken(token.registryAllowance, { digits: 2, symbol: 'THOOD' })}
                </span>
              </div>
              <div className={s.allowanceRow}>
                <span className={s.allowanceLabel}>Covers</span>
                <span className={s.allowanceValue}>
                  {cover === null
                    ? '—'
                    : cover === 0
                      ? 'no renewals at the current rate'
                      : `${cover} ${cover === 1 ? 'month' : 'months'} of one room's rent`}
                </span>
              </div>
              <div className={s.allowanceActions}>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!canWrite || monthly === null || allowanceTx.busy}
                  loading={allowanceTx.busy}
                  onClick={() => {
                    if (monthly === null) return;
                    void setAllowance(monthly * 12n, 'Approving 12 months of rent');
                  }}
                >
                  Approve 12 months
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={
                    !canWrite ||
                    allowanceTx.busy ||
                    token.registryAllowance === null ||
                    token.registryAllowance === 0n
                  }
                  onClick={() => void setAllowance(0n, 'Revoking the allowance')}
                >
                  Revoke
                </Button>
              </div>
            </div>

            {allowanceTx.error !== null && (
              <Notice
                tone={allowanceTx.error.kind === 'rejected' ? 'info' : 'error'}
                title={allowanceTx.error.title}
                body={allowanceTx.error.detail}
              />
            )}
          </div>

          <div className={s.foot}>
            <p className={s.footText}>
              Anyone may pay any room&apos;s rent — <code className={s.code}>payRent</code>{' '}
              is permissionless, and paying grants no control over the room. Rent lapse
              blocks new messages only; history, membership and the admin role survive,
              and paying reopens the room exactly as it was.
            </p>
            {rooms.partial && (
              <p className={s.footText}>
                The event scan was bounded by this RPC endpoint, so very old rooms may
                not be listed.
              </p>
            )}
          </div>
        </>
      )}
    </Panel>
  );
}
