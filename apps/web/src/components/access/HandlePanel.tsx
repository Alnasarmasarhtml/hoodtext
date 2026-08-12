'use client';

/**
 * @names — free with the $5 activation, one per address.
 *
 * The input validates locally against the same rules as `Handles.isValidName`
 * (2–15 chars of a–z 0–9 _, starting with a letter), checks availability live
 * via `addressOf`, and — for names shorter than 5 — states the perk tier the
 * length requires next to the tier the connected wallet actually holds. The
 * chain is still the authority; this panel just answers before the round trip.
 */

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import type { Address } from 'viem';
import { useWriteContract } from 'wagmi';

import { handlesAbi, PerkTier, perkTierLabel, CONTRACT_CONSTANTS } from '@/lib/abi';
import type { ContractAddresses } from '@/lib/chain';
import { cx } from '@/lib/cx';
import { PRELAUNCH } from '@/lib/launch';
import { useConnectSheet } from '@/lib/ui-store';
import { Button, Eyebrow, Field, Panel, PanelHeader, useToast } from '@/components/ui';
import { DemoNote } from './Demo';
import { EmptyState, Notice } from './Notice';
import { useTxState } from './use-tx';
import {
  requiredTierForLength,
  useDebounced,
  useHandleAvailability,
  validateHandle,
  type ActivationState,
  type HandleProblem,
  type HandleState,
  type PerksState,
} from './use-access-data';
import s from './HandlePanel.module.css';

export interface HandlePanelProps {
  readonly contracts: ContractAddresses | null;
  readonly address: Address | null;
  readonly isConnected: boolean;
  readonly wrongNetwork: boolean;
  readonly activation: ActivationState;
  readonly handle: HandleState;
  readonly perks: PerksState;
  readonly onRefresh: () => void;
  /** Demo mode: fixture state, and claim/release print a simulated note instead of transacting. */
  readonly demo?: boolean;
}

const PROBLEM_COPY: Readonly<Record<Exclude<HandleProblem, null>, string>> = {
  empty: '',
  'too-short': `At least ${CONTRACT_CONSTANTS.handleMinLength} characters.`,
  'too-long': `At most ${CONTRACT_CONSTANTS.handleMaxLength} characters.`,
  'bad-start': 'Must start with a letter.',
  'bad-chars': 'Only a–z, 0–9 and _ are allowed.',
};

export function HandlePanel({
  contracts,
  address,
  isConnected,
  wrongNetwork,
  activation,
  handle,
  perks,
  onRefresh,
  demo = false,
}: HandlePanelProps): ReactNode {
  const toast = useToast();
  const openWallet = useConnectSheet((state) => state.open);
  const { writeContractAsync } = useWriteContract();
  const [simulated, setSimulated] = useState(false);

  const claimTx = useTxState();
  const releaseTx = useTxState();

  const [raw, setRaw] = useState('');
  const name = raw.trim().toLowerCase();
  const problem = name === '' ? 'empty' : validateHandle(name);
  const valid = problem === null;

  const settled = useDebounced(valid ? name : null, 300);
  const availability = useHandleAvailability(contracts, settled);
  /* Availability only speaks for the name it was asked about. */
  const availabilityCurrent = settled === name && valid;

  const requiredTier = useMemo(
    () => (valid ? requiredTierForLength(name.length) : PerkTier.NONE),
    [name.length, valid],
  );
  const tierShort = requiredTier !== PerkTier.NONE && perks.tier < requiredTier;

  const isMine =
    availabilityCurrent &&
    availability.owner !== null &&
    address !== null &&
    availability.owner.toLowerCase() === address.toLowerCase();

  const taken =
    availabilityCurrent && availability.available === false && !isMine;

  const canWrite =
    contracts !== null && address !== null && isConnected && !wrongNetwork;

  /* Demo: the field stays live and the tier rules still gate, but there is no
     availability read — a valid, tier-covered name is claimable (simulated). */
  const interactive = demo || canWrite;

  const canClaim = demo
    ? valid && !tierShort
    : canWrite &&
      activation.isActivated &&
      valid &&
      availabilityCurrent &&
      availability.available === true &&
      !tierShort &&
      !claimTx.busy &&
      !releaseTx.busy;

  const onClaim = useCallback(async (): Promise<void> => {
    if (contracts === null || !valid) return;
    const ok = await claimTx.run(
      () =>
        writeContractAsync({
          address: contracts.handles,
          abi: handlesAbi,
          functionName: 'claim',
          args: [name],
        }),
      'Claiming the handle',
    );
    if (ok) {
      onRefresh();
      setRaw('');
      toast.push({
        kind: 'success',
        title: `@${name} is yours`,
        body: 'Claimed at claim-time. Selling tokens later never revokes a handle you already hold.',
      });
    }
  }, [claimTx, contracts, name, onRefresh, toast, valid, writeContractAsync]);

  const onRelease = useCallback(async (): Promise<void> => {
    if (contracts === null || handle.handle === null) return;
    const released = handle.handle;
    const ok = await releaseTx.run(
      () =>
        writeContractAsync({
          address: contracts.handles,
          abi: handlesAbi,
          functionName: 'release',
        }),
      'Releasing the handle',
    );
    if (ok) {
      onRefresh();
      toast.push({
        kind: 'success',
        title: `@${released} released`,
        body: 'The name is free for anyone to claim, including you. Under the same tier rules.',
      });
    }
  }, [contracts, handle.handle, onRefresh, releaseTx, toast, writeContractAsync]);

  /* ── field messaging ─────────────────────────────────────────────────── */

  let fieldError: string | undefined;
  if (name !== '' && problem !== null && problem !== 'empty') {
    fieldError = PROBLEM_COPY[problem];
  } else if (taken) {
    fieldError = 'Taken. Someone claimed this name first.';
  }

  let fieldHint: ReactNode = `2–15 characters, a–z 0–9 _, starting with a letter. 5+ characters are open to every activated account.`;
  if (valid) {
    if (requiredTier !== PerkTier.NONE) {
      fieldHint = tierShort
        ? `${name.length}-character names need ${perkTierLabel(requiredTier)}. You are ${
            perks.tier === PerkTier.NONE ? 'below RESIDENT' : perkTierLabel(perks.tier)
          }. Hold more $GRAM through a weekly snapshot to unlock this length.`
        : `${name.length}-character names need ${perkTierLabel(requiredTier)}. Your ${perkTierLabel(perks.tier)} tier covers it.`;
    } else if (availabilityCurrent && availability.available === true) {
      fieldHint = 'Available. Claiming costs one transaction. The name itself is free.';
    } else if (isMine) {
      fieldHint = 'This one is already yours.';
    } else if (availability.isLoading || settled !== name) {
      fieldHint = 'Checking availability…';
    }
  }

  const claimError = claimTx.error ?? releaseTx.error;

  /* ── unconnected states ──────────────────────────────────────────────── */

  if (PRELAUNCH && !demo) {
    return (
      <Panel as="section" tone="raised" notch="tr" className={s.panel}>
        <PanelHeader label="Handle" note="@names, free with activation" />
        <EmptyState
          eyebrow="At launch"
          title="Handles open with activation"
          body="A handle is an @name bound to your address on chain. It comes free with the $5 activation, paid in $GRAM, one per account, and the short ones are reserved for the holder tiers."
          mark={false}
        />
      </Panel>
    );
  }

  if (!demo && (!isConnected || wrongNetwork || contracts === null)) {
    return (
      <Panel as="section" tone="raised" notch="tr" className={s.panel}>
        <PanelHeader label="Handle" note="@names, free with activation" />
        <EmptyState
          eyebrow={
            contracts === null ? 'Not deployed' : wrongNetwork ? 'Wrong network' : 'Not connected'
          }
          title={
            contracts === null
              ? 'No deployment here'
              : wrongNetwork
                ? 'Switch networks to see your handle'
                : 'Connect to claim a name'
          }
          body={
            contracts === null
              ? 'This build has no contract addresses for the active chain, so there is no handle registry to read.'
              : wrongNetwork
                ? 'Handles live on Robinhood Chain. Your wallet is pointed somewhere else.'
                : 'A handle is an @name bound to your address on chain. Free with the $5 activation, paid in $GRAM, one per account.'
          }
          action={
            contracts !== null && !wrongNetwork ? (
              <Button
                variant="primary"
                onClick={() => openWallet('Reading your @handle from the chain.')}
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
        label="Handle"
        note="@names, free with activation"
        aside={
          handle.handle !== null ? (
            <span className={s.current}>@{handle.handle}</span>
          ) : undefined
        }
      />

      <div className={s.body}>
        {handle.handle !== null ? (
          <div className={s.held}>
            <div className={s.heldText}>
              <Eyebrow size="micro">Your handle</Eyebrow>
              <span className={s.heldName}>@{handle.handle}</span>
              <span className={s.heldNote}>
                One per address. Release it to claim a different one.
              </span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              loading={releaseTx.busy}
              loadingLabel={releaseTx.phase === 'confirming' ? 'Confirming' : 'Confirm in wallet'}
              disabled={demo ? false : !canWrite || claimTx.busy}
              onClick={() => {
                if (demo) {
                  setSimulated(true);
                  return;
                }
                void onRelease();
              }}
            >
              Release
            </Button>
          </div>
        ) : (
          !activation.isActivated && (
            <Notice
              tone="info"
              title="Activation first"
              body="Handles are free, but only activated accounts can claim one. That is what keeps squatting bots out. Pay the one-time $5 in $GRAM above and come back."
            />
          )
        )}

        <div className={s.claimRow}>
          <Field
            className={s.claimField}
            label={handle.handle === null ? 'Claim a name' : 'Claim a different name'}
            labelHint="free"
            mono
            prefix="@"
            placeholder="yourname"
            value={raw}
            onChange={(event) => setRaw(event.target.value)}
            error={fieldError}
            hint={fieldHint}
            disabled={!interactive || claimTx.busy || releaseTx.busy}
            spellCheck={false}
            autoComplete="off"
            maxLength={CONTRACT_CONSTANTS.handleMaxLength + 2}
          />

          <div className={s.claimAction}>
            <Button
              variant="primary"
              loading={claimTx.busy}
              loadingLabel={claimTx.phase === 'confirming' ? 'Confirming' : 'Confirm in wallet'}
              disabled={!canClaim || (handle.handle !== null && name === handle.handle)}
              onClick={() => {
                if (demo) {
                  setSimulated(true);
                  return;
                }
                void onClaim();
              }}
            >
              Claim
            </Button>
          </div>
        </div>

        {demo && simulated && (
          <DemoNote>Simulated. In the live app this is an on-chain claim.</DemoNote>
        )}

        {/* The length ladder, stated once — short names are the scarce flex. */}
        <div className={s.lengths} role="list" aria-label="Handle length requirements">
          <div className={s.length} role="listitem" data-open={requiredTier === PerkTier.NONE && valid ? 'true' : undefined}>
            <span className={s.lengthChars}>5–15</span>
            <span className={s.lengthTier}>any activated account</span>
          </div>
          <div className={s.length} role="listitem">
            <span className={s.lengthChars}>4</span>
            <span className={cx(s.lengthTier, perks.tier >= PerkTier.BLOCK_CAPTAIN && s.lengthMet)}>
              BLOCK CAPTAIN
            </span>
          </div>
          <div className={s.length} role="listitem">
            <span className={s.lengthChars}>3</span>
            <span className={cx(s.lengthTier, perks.tier >= PerkTier.DISTRICT && s.lengthMet)}>
              DISTRICT
            </span>
          </div>
          <div className={s.length} role="listitem">
            <span className={s.lengthChars}>2</span>
            <span className={cx(s.lengthTier, perks.tier >= PerkTier.KINGPIN && s.lengthMet)}>
              KINGPIN
            </span>
          </div>
        </div>

        <p className={s.foot}>
          The tier is checked once, at claim time. A short handle you already hold is
          never revoked, whatever your balance does afterwards.
        </p>

        {claimError !== null && (
          <Notice
            tone={claimError.kind === 'rejected' ? 'info' : 'error'}
            title={claimError.title}
            body={claimError.detail}
            meta={claimError.revertName === null ? undefined : `revert ${claimError.revertName}()`}
          />
        )}

        {claimTx.phase === 'confirmed' && claimTx.explorerUrl !== null && (
          <Notice
            tone="ok"
            title="Claimed"
            body="Your handle is anchored on chain."
            action={
              <a
                className={s.txLink}
                href={claimTx.explorerUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                View transaction
              </a>
            }
          />
        )}
      </div>
    </Panel>
  );
}
