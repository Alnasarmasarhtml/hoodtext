'use client';

/**
 * The $5 handshake — one payment, and the account exists forever.
 *
 * Approve → activate, as a two-step machine with real chain errors. Nothing
 * here is optimistic: step 1 is only marked done once the on-chain allowance
 * actually covers the live quote, and step 2 only once the receipt came back
 * `success`. Once activated, the panel flips into its permanent state and
 * offers the one thing left to buy here: activating someone else
 * (`activateFor` — the payer pays, the recipient gets the account).
 */

import {
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { isAddress, type Address } from 'viem';
import { useReadContract, useWriteContract } from 'wagmi';

import { activationAbi, hoodGramTokenAbi, PRICES } from '@/lib/abi';
import type { ContractAddresses } from '@/lib/chain';
import { cx } from '@/lib/cx';
import { formatDate, formatToken, formatUsd18, truncateAddress } from '@/lib/format';
import { useConnectSheet } from '@/lib/ui-store';
import { Button, Eyebrow, Field, Panel, PanelHeader, useToast } from '@/components/ui';
import { DemoNote } from './Demo';
import { Notice } from './Notice';
import { useTxState } from './use-tx';
import { useDebounced, type ActivationState, type PricingState, type TokenState } from './use-access-data';
import s from './ActivationPanel.module.css';

export interface ActivationPanelProps {
  readonly contracts: ContractAddresses | null;
  readonly address: Address | null;
  readonly isConnected: boolean;
  readonly wrongNetwork: boolean;
  readonly pricing: PricingState;
  readonly activation: ActivationState;
  readonly token: TokenState;
  readonly onRefresh: () => void;
  /** Demo mode: fixture state, and actions print a simulated note instead of transacting. */
  readonly demo?: boolean;
}

type StepState = 'todo' | 'current' | 'busy' | 'done';

interface LedgerRowProps {
  readonly label: string;
  readonly value: ReactNode;
  readonly note?: ReactNode;
  readonly strong?: boolean;
}

function LedgerRow({ label, value, note, strong = false }: LedgerRowProps): ReactNode {
  return (
    <div className={cx(s.row, strong && s.rowStrong)}>
      <span className={s.rowLabel}>{label}</span>
      <span className={s.rowValue}>{value}</span>
      {note !== undefined && <span className={s.rowNote}>{note}</span>}
    </div>
  );
}

export function ActivationPanel({
  contracts,
  address,
  isConnected,
  wrongNetwork,
  pricing,
  activation,
  token,
  onRefresh,
  demo = false,
}: ActivationPanelProps): ReactNode {
  const toast = useToast();
  const openWallet = useConnectSheet((state) => state.open);
  const { writeContractAsync } = useWriteContract();
  const [simulated, setSimulated] = useState(false);

  const approveTx = useTxState();
  const activateTx = useTxState();
  const sponsorTx = useTxState();

  const quote = pricing.activationQuote;
  const usd = pricing.activationUsd;
  const balance = token.balance;
  const allowance = token.activationAllowance;

  const needsApproval = quote !== null && allowance !== null && allowance < quote;
  const shortOnBalance = quote !== null && balance !== null && balance < quote;

  const canWrite =
    contracts !== null && address !== null && isConnected && !wrongNetwork && quote !== null;

  /* ── sponsor-a-friend ────────────────────────────────────────────────── */

  const [friendRaw, setFriendRaw] = useState('');
  const friendInput = friendRaw.trim();
  const friendValid = friendInput !== '' && isAddress(friendInput, { strict: false });
  const friendError =
    friendInput !== '' && !friendValid ? 'Not a valid address.' : undefined;
  const friend = useDebounced(friendValid ? (friendInput as Address) : null, 300);
  const friendIsSelf =
    friend !== null && address !== null && friend.toLowerCase() === address.toLowerCase();

  const { data: friendActivatedRaw } = useReadContract({
    address: contracts?.activation ?? undefined,
    abi: activationAbi,
    functionName: 'isActivated',
    args: friend === null ? undefined : [friend],
    query: { enabled: contracts !== null && friend !== null, refetchInterval: 30_000 },
  });
  const friendActivated = friendActivatedRaw === true;

  /* ── writes ──────────────────────────────────────────────────────────── */

  const { reset: resetSponsor } = sponsorTx;

  /* A different target invalidates the last sponsor attempt. */
  useEffect(() => {
    resetSponsor();
  }, [friend, resetSponsor]);

  const onApprove = useCallback(async (): Promise<void> => {
    if (contracts === null || quote === null) return;
    const ok = await approveTx.run(
      () =>
        writeContractAsync({
          address: contracts.token,
          abi: hoodGramTokenAbi,
          functionName: 'approve',
          args: [contracts.activation, quote],
        }),
      'Approving $THOOD',
    );
    if (ok) {
      onRefresh();
      toast.push({
        kind: 'success',
        title: 'Approved',
        body: `The Activation contract may now move ${formatToken(quote, { digits: 2, symbol: 'THOOD' })} — and not a wei more.`,
      });
    }
  }, [approveTx, contracts, onRefresh, quote, toast, writeContractAsync]);

  const onActivate = useCallback(async (): Promise<void> => {
    if (contracts === null) return;
    const ok = await activateTx.run(
      () =>
        writeContractAsync({
          address: contracts.activation,
          abi: activationAbi,
          functionName: 'activate',
        }),
      'Activating',
    );
    if (ok) {
      onRefresh();
      toast.push({
        kind: 'success',
        title: 'Activated',
        body: 'Your account exists now, and it exists forever. Messages cost nothing from here on.',
      });
    }
  }, [activateTx, contracts, onRefresh, toast, writeContractAsync]);

  const onActivateFriend = useCallback(async (): Promise<void> => {
    if (contracts === null || friend === null) return;
    const ok = await sponsorTx.run(
      () =>
        writeContractAsync({
          address: contracts.activation,
          abi: activationAbi,
          functionName: 'activateFor',
          args: [friend],
        }),
      'Sponsoring an activation',
    );
    if (ok) {
      onRefresh();
      toast.push({
        kind: 'success',
        title: 'Account sponsored',
        body: `${truncateAddress(friend)} is activated forever. You paid; they own the account.`,
      });
    }
  }, [contracts, friend, onRefresh, sponsorTx, toast, writeContractAsync]);

  /* ── step states ─────────────────────────────────────────────────────── */

  const approveState: StepState = approveTx.busy
    ? 'busy'
    : quote === null || allowance === null
      ? 'todo'
      : needsApproval
        ? 'current'
        : 'done';

  const activateState: StepState = activateTx.busy
    ? 'busy'
    : activateTx.phase === 'confirmed'
      ? 'done'
      : approveState === 'done'
        ? 'current'
        : 'todo';

  const blocked = approveTx.busy || activateTx.busy || sponsorTx.busy;
  const activeError = activateTx.error ?? approveTx.error;

  /* ── gates ───────────────────────────────────────────────────────────── */

  const gate: ReactNode =
    contracts === null ? (
      <Notice
        tone="warn"
        title="No deployment configured"
        body="This build has no contract addresses for the active chain, so nothing can be quoted or paid. Deploy the contracts and set the NEXT_PUBLIC_ADDR_* variables."
      />
    ) : !isConnected ? (
      <Notice
        tone="info"
        title="Connect to activate"
        body="The price above is live from the chain. Connect a wallet to pay it once and own the account forever."
        action={
          <Button
            variant="primary"
            onClick={() => openWallet('HoodGram reads your activation status and $THOOD balance from the chain.')}
          >
            Connect wallet
          </Button>
        }
      />
    ) : wrongNetwork ? (
      <Notice
        tone="warn"
        title="Wrong network"
        body="Your wallet is on a different chain. Switch networks to activate."
      />
    ) : null;

  /* ── the sponsor block (shared by both states) ───────────────────────── */

  const sponsorNeedsApproval = needsApproval;
  const canSponsor = demo
    ? friend !== null && !friendIsSelf
    : canWrite && friend !== null && !friendActivated && !friendIsSelf && !blocked;

  const sponsor = (
    <div className={s.sponsor}>
      <div className={s.sponsorHead}>
        <Eyebrow>Sponsor a friend</Eyebrow>
        <span className={s.sponsorPrice}>
          {quote === null ? '—' : formatToken(quote, { digits: 2, symbol: 'THOOD' })}
        </span>
      </div>

      <p className={s.sponsorCopy}>
        <code className={s.code}>activateFor(them)</code> — you pay the same $5 once,
        they own the account forever. Nothing about it points back to you afterwards.
      </p>

      <div className={s.sponsorRow}>
        <Field
          className={s.sponsorField}
          label="Their address"
          mono
          placeholder="0x…"
          value={friendRaw}
          onChange={(event) => setFriendRaw(event.target.value)}
          error={friendError}
          hint={
            friendIsSelf
              ? 'That is your own address — use the activate flow above.'
              : friendActivated && friend !== null
                ? `${truncateAddress(friend)} is already activated. Nothing to pay.`
                : 'Any address — it does not need to have used HoodGram before.'
          }
          disabled={!isConnected || wrongNetwork}
          spellCheck={false}
          autoComplete="off"
        />

        <div className={s.sponsorActions}>
          {sponsorNeedsApproval && (
            <Button
              variant="ghost"
              loading={approveTx.busy}
              loadingLabel={approveTx.phase === 'confirming' ? 'Confirming' : 'Approve in wallet'}
              disabled={!canWrite || blocked}
              onClick={() => void onApprove()}
            >
              Approve
            </Button>
          )}
          <Button
            variant="primary"
            loading={sponsorTx.busy}
            loadingLabel={sponsorTx.phase === 'confirming' ? 'Confirming' : 'Confirm in wallet'}
            disabled={!canSponsor || sponsorNeedsApproval || shortOnBalance}
            onClick={() => {
              if (demo) {
                setSimulated(true);
                return;
              }
              void onActivateFriend();
            }}
          >
            Activate them
          </Button>
        </div>
      </div>

      {demo && simulated && <DemoNote />}

      {sponsorTx.error !== null && (
        <Notice
          tone={sponsorTx.error.kind === 'rejected' ? 'info' : 'error'}
          title={sponsorTx.error.title}
          body={sponsorTx.error.detail}
          meta={
            sponsorTx.error.revertName === null
              ? undefined
              : `revert ${sponsorTx.error.revertName}()`
          }
        />
      )}

      {sponsorTx.phase === 'confirmed' && (
        <Notice
          tone="ok"
          title="Account sponsored"
          body={
            friend === null
              ? 'The sponsored activation is confirmed on chain.'
              : `${truncateAddress(friend)} is activated forever — confirmed on chain.`
          }
          action={
            sponsorTx.explorerUrl === null ? undefined : (
              <a
                className={s.txLink}
                href={sponsorTx.explorerUrl}
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
  );

  /* ── activated: the permanent state ──────────────────────────────────── */

  if (activation.isActivated) {
    return (
      <Panel as="section" tone="raised" notch="tr" className={s.panel} highlight>
        <PanelHeader
          label="Activation"
          note="One payment, once, ever"
          aside={
            <span className={s.badge}>
              <span className={s.badgeDot} aria-hidden="true" />
              Activated
            </span>
          }
        />

        <div className={s.body}>
          <div className={s.done}>
            <span className={s.doneTitle}>
              ACTIVATED
              {activation.activatedAt > 0n && (
                <span className={s.doneDate}>{` — ${formatDate(activation.activatedAt)}`}</span>
              )}
              .
            </span>
            <span className={s.doneForever}>Forever.</span>
            <p className={s.doneCopy}>
              There is nothing to renew, nothing to top up and no way to lose this.
              Messages are free — relayed with no gas and no popups, or self-posted
              for about a cent. The only recurring price anywhere is a room&apos;s
              $10/month, paid by whoever runs it.
            </p>
          </div>

          {sponsor}

          {approveTx.error !== null && (
            <Notice
              tone={approveTx.error.kind === 'rejected' ? 'info' : 'error'}
              title={approveTx.error.title}
              body={approveTx.error.detail}
              meta={
                approveTx.error.revertName === null
                  ? undefined
                  : `revert ${approveTx.error.revertName}()`
              }
            />
          )}
        </div>
      </Panel>
    );
  }

  /* ── not yet activated: the $5 buy ───────────────────────────────────── */

  return (
    <Panel as="section" tone="raised" notch="tr" className={s.panel} highlight>
      <PanelHeader
        label="Activation"
        note="One payment, once, ever"
        aside={
          <span className={s.headTotal}>
            {quote === null ? '—' : formatToken(quote, { digits: 2, symbol: 'THOOD' })}
          </span>
        }
      />

      <div className={s.body}>
        <div className={s.pitch}>
          <span className={s.price}>
            {usd === null ? `$${PRICES.activationUsd}` : formatUsd18(usd, 0)}
          </span>
          <div className={s.pitchText}>
            <span className={s.pitchLead}>Once. Forever.</span>
            <p className={s.pitchCopy}>
              One payment in <span className={s.wordmark}>$THOOD</span> and your account
              exists permanently. It is also the spam wall: every account on HoodGram
              cost somebody five dollars, so there are no bot floods to wade through.
            </p>
          </div>
        </div>

        {gate}

        <div className={s.ledger}>
          <LedgerRow
            label="Price"
            value={usd === null ? `$${PRICES.activationUsd}.00` : formatUsd18(usd)}
            note="Fixed in USD on chain — the token can move; this cannot"
          />
          <LedgerRow
            label="Cost now"
            value={quote === null ? '—' : formatToken(quote, { digits: 4, symbol: 'THOOD' })}
            note="Live quote() at the current rate, pulled once at purchase"
            strong
          />
          <LedgerRow
            label="Your balance"
            value={
              balance === null
                ? isConnected
                  ? '—'
                  : 'not connected'
                : formatToken(balance, { digits: 2, symbol: 'THOOD' })
            }
            note={
              shortOnBalance && quote !== null && balance !== null
                ? `${formatToken(quote - balance, { digits: 2, symbol: 'THOOD' })} short`
                : undefined
            }
          />
          <LedgerRow
            label="Approved"
            value={
              allowance === null
                ? isConnected
                  ? '—'
                  : 'not connected'
                : formatToken(allowance, { digits: 2, symbol: 'THOOD' })
            }
            note="The most the Activation contract can ever move from your wallet"
          />
        </div>

        <ol className={s.steps}>
          <li className={s.step} data-state={approveState}>
            <span className={s.stepIndex} aria-hidden="true">
              1
            </span>
            <div className={s.stepBody}>
              <span className={s.stepTitle}>Approve $THOOD</span>
              <span className={s.stepNote}>
                {approveState === 'done'
                  ? 'Approved. The contract can move exactly this amount.'
                  : `One-off permission for the Activation contract to move ${
                      quote === null
                        ? 'the quoted amount'
                        : formatToken(quote, { digits: 2, symbol: 'THOOD' })
                    }.`}
              </span>
            </div>
            <Button
              className={s.stepAction}
              variant={approveState === 'current' ? 'primary' : 'ghost'}
              loading={approveTx.busy}
              loadingLabel={approveTx.phase === 'confirming' ? 'Confirming' : 'Approve in wallet'}
              disabled={!canWrite || blocked || approveState === 'done'}
              onClick={() => void onApprove()}
            >
              {approveState === 'done' ? 'Approved' : 'Approve'}
            </Button>
          </li>

          <li className={s.step} data-state={activateState}>
            <span className={s.stepIndex} aria-hidden="true">
              2
            </span>
            <div className={s.stepBody}>
              <span className={s.stepTitle}>Activate</span>
              <span className={s.stepNote}>
                {activateState === 'done'
                  ? 'Confirmed on chain.'
                  : 'Pays the quote in $THOOD. 100% of it goes to the vault, where half is set aside for holders.'}
              </span>
            </div>
            <Button
              className={s.stepAction}
              variant="primary"
              loading={activateTx.busy}
              loadingLabel={activateTx.phase === 'confirming' ? 'Confirming' : 'Confirm in wallet'}
              disabled={!canWrite || blocked || approveState !== 'done' || shortOnBalance}
              onClick={() => void onActivate()}
            >
              Activate
            </Button>
          </li>
        </ol>

        {shortOnBalance && quote !== null && balance !== null && (
          <Notice
            tone="warn"
            title="Not enough $THOOD"
            body={`Activation costs ${formatToken(quote, { digits: 2, symbol: 'THOOD' })} right now and your wallet holds ${formatToken(balance, { digits: 2, symbol: 'THOOD' })}. Top up and the quote refreshes automatically.`}
          />
        )}

        {activeError !== null && (
          <Notice
            tone={activeError.kind === 'rejected' ? 'info' : 'error'}
            title={activeError.title}
            body={activeError.detail}
            meta={activeError.revertName === null ? undefined : `revert ${activeError.revertName}()`}
          />
        )}

        {isConnected && !wrongNetwork && sponsor}
      </div>
    </Panel>
  );
}
