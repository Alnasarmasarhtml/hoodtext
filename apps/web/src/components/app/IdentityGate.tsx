'use client';

/**
 * The one-time identity ceremony, as a designed surface (SPEC §7.3).
 *
 * Three steps, always visible so the user knows how far the ceremony goes
 * before it starts:
 *
 *   1. Connect a wallet — our own sheet, never a third-party modal.
 *   2. Sign the EIP-712 identity message once. The signature is turned into an
 *      X25519 and an Ed25519 keypair by `deriveIdentity`; it authorises no
 *      transaction and moves no funds.
 *   3. Publish the two public keys to `KeyRegistry` — one transaction, gas
 *      only, free of any payment. You must be able to receive before you
 *      have ever paid.
 *
 * Every state here is a designed state: wrong network, missing deployment, a
 * rejected signature and a reverted registration all render as themselves.
 */

import { useCallback, useState, type ReactNode } from 'react';
import { useSwitchChain } from 'wagmi';

import { Button, Eyebrow, Hex } from '@/components/ui';
import type { IdentityStatus, UseIdentityResult } from '@/hooks';
import { ACTIVE_CHAIN_ID, activeChain, explorerTxUrl } from '@/lib/chain';
import { cx } from '@/lib/cx';
import { useConnectSheet } from '@/lib/ui-store';
import { AppNotice } from './AppNotice';
import s from './IdentityGate.module.css';

type StepState = 'done' | 'active' | 'todo';

interface Step {
  readonly key: string;
  readonly label: string;
  readonly note: string;
}

const STEPS: readonly Step[] = [
  {
    key: 'connect',
    label: 'Connect',
    note: 'Reads your activation and your holdings. Authorises nothing.',
  },
  {
    key: 'derive',
    label: 'Derive keys',
    note: 'One signature becomes your X25519 and Ed25519 messaging keys.',
  },
  {
    key: 'publish',
    label: 'Publish',
    note: 'Registers your public keys so other people can encrypt to you.',
  },
];

/** How far along the ceremony a status is — 0, 1 or 2. */
function stageOf(status: IdentityStatus): number {
  switch (status) {
    case 'idle':
    case 'wrong-network':
    case 'not-deployed':
      return 0;
    case 'loading':
    case 'locked':
    case 'unlocking':
      return 1;
    default:
      return 2;
  }
}

function stateFor(index: number, stage: number): StepState {
  if (index < stage) return 'done';
  return index === stage ? 'active' : 'todo';
}

interface Copy {
  readonly eyebrow: string;
  readonly title: string;
  readonly lede: string;
}

function copyFor(status: IdentityStatus, isRotation: boolean): Copy {
  switch (status) {
    case 'idle':
      return {
        eyebrow: 'Step 1 of 3 · Connect',
        title: 'Connect a wallet to open the desk.',
        lede:
          'TeleHood reads your activation and your key registration straight from the chain. Connecting signs nothing and moves nothing.',
      };
    case 'wrong-network':
      return {
        eyebrow: 'Wrong network',
        title: `Switch to ${activeChain.name}.`,
        lede: `The contracts this build talks to live on ${activeChain.name} (chain ${String(ACTIVE_CHAIN_ID)}). Your wallet is pointed somewhere else, so nothing on this page can be read yet.`,
      };
    case 'not-deployed':
      return {
        eyebrow: 'Not configured',
        title: 'This build has no contract addresses.',
        lede:
          'The messenger needs the deployed KeyRegistry, Activation and Anchors addresses before it can read or post anything. Deploy the contracts and set the NEXT_PUBLIC_ADDR_* variables, then reload.',
      };
    case 'loading':
      return {
        eyebrow: 'Step 2 of 3 · Derive keys',
        title: 'Reading your identity.',
        lede:
          'Checking this device for cached keys and asking KeyRegistry what it holds for your address.',
      };
    case 'locked':
    case 'unlocking':
      return {
        eyebrow: 'Step 2 of 3 · Derive keys',
        title: 'Sign once to derive your messaging keys.',
        lede:
          'Your keys come from a single EIP-712 signature, so the same wallet reproduces the same keys on any device. Nothing secret is ever transmitted, and signing this message cannot authorise a transaction.',
      };
    case 'unregistered':
    case 'registering':
      return isRotation
        ? {
            eyebrow: 'Step 3 of 3 · Publish',
            title: 'Your registered keys are out of date.',
            lede:
              'KeyRegistry holds different public keys for this address. Publishing again rotates them, so anything encrypted from now on reaches the keys this device actually holds.',
          }
        : {
            eyebrow: 'Step 3 of 3 · Publish',
            title: 'Publish your public keys.',
            lede:
              'One transaction writes your two public keys to KeyRegistry so other people can encrypt to you. Registration is free of any payment — you can receive before you have ever paid.',
          };
    default:
      return {
        eyebrow: 'Identity',
        title: 'Your identity is ready.',
        lede: 'Keys derived on this device and published on chain.',
      };
  }
}

export interface IdentityGateProps {
  readonly identity: UseIdentityResult;
  readonly className?: string;
}

export function IdentityGate({ identity, className }: IdentityGateProps): ReactNode {
  const openSheet = useConnectSheet((state) => state.open);
  const { switchChainAsync, isPending: switching } = useSwitchChain();
  const [switchError, setSwitchError] = useState<string | null>(null);

  const stage = stageOf(identity.status);
  const copy = copyFor(identity.status, identity.isRotation);

  const onConnect = useCallback((): void => {
    openSheet(
      'TeleHood needs your address to read your activation and to derive your messaging keys. Connecting authorises nothing.',
    );
  }, [openSheet]);

  const onSwitch = useCallback((): void => {
    setSwitchError(null);
    void switchChainAsync({ chainId: ACTIVE_CHAIN_ID }).catch((error: unknown) => {
      setSwitchError(
        error instanceof Error
          ? error.message.split('\n')[0] ?? 'The network switch was rejected.'
          : 'The network switch was rejected.',
      );
    });
  }, [switchChainAsync]);

  const registerTxUrl =
    identity.registerTxHash === null ? null : explorerTxUrl(identity.registerTxHash);

  let action: ReactNode = null;
  switch (identity.status) {
    case 'idle':
      action = (
        <Button variant="primary" size="lg" onClick={onConnect}>
          Connect a wallet
        </Button>
      );
      break;
    case 'wrong-network':
      action = (
        <Button variant="primary" size="lg" loading={switching} onClick={onSwitch}>
          {`Switch to ${activeChain.name}`}
        </Button>
      );
      break;
    case 'locked':
    case 'unlocking':
      action = (
        <Button
          variant="primary"
          size="lg"
          loading={identity.status === 'unlocking'}
          loadingLabel="Waiting for your wallet"
          onClick={identity.unlock}
        >
          Sign identity message
        </Button>
      );
      break;
    case 'unregistered':
    case 'registering':
      action = (
        <Button
          variant="primary"
          size="lg"
          loading={identity.status === 'registering'}
          loadingLabel="Registering your keys"
          onClick={identity.register}
        >
          {identity.isRotation ? 'Rotate registered keys' : 'Publish public keys'}
        </Button>
      );
      break;
    default:
      action = null;
  }

  return (
    <section className={cx(s.gate, className)} aria-labelledby="identity-gate-title">
      <div className={s.panel}>
        <header className={s.head}>
          <Eyebrow rule>{copy.eyebrow}</Eyebrow>
          <h1 id="identity-gate-title" className={s.title}>
            {copy.title}
          </h1>
          <p className={s.lede}>{copy.lede}</p>
        </header>

        <ol className={s.steps}>
          {STEPS.map((step, index) => {
            const state = stateFor(index, stage);
            return (
              <li key={step.key} className={cx(s.step, s[state])} data-state={state}>
                <span className={s.stepIndex}>{String(index + 1).padStart(2, '0')}</span>
                <span className={s.stepBody}>
                  <span className={s.stepLabel}>{step.label}</span>
                  <span className={s.stepNote}>{step.note}</span>
                </span>
                <span className={s.stepMark} aria-hidden="true" />
                <span className="sr-only">
                  {state === 'done'
                    ? ' — done'
                    : state === 'active'
                      ? ' — current step'
                      : ' — not started'}
                </span>
              </li>
            );
          })}
        </ol>

        {identity.address !== null && (
          <dl className={s.facts}>
            <div className={s.fact}>
              <dt className={s.factLabel}>Wallet</dt>
              <dd className={s.factValue}>
                <Hex value={identity.address} label="Wallet address" size="sm" href={null} />
              </dd>
            </div>
            {identity.x25519Pub !== null && (
              <div className={s.fact}>
                <dt className={s.factLabel}>X25519</dt>
                <dd className={s.factValue}>
                  <Hex
                    value={identity.x25519Pub}
                    label="Your X25519 public key"
                    lead={8}
                    tail={6}
                    size="sm"
                    tone="muted"
                    href={null}
                  />
                </dd>
              </div>
            )}
            {identity.onChain !== null && (
              <div className={s.fact}>
                <dt className={s.factLabel}>Registered</dt>
                <dd className={s.factValue}>
                  <Hex
                    value={identity.onChain.x25519}
                    label="Registered X25519 public key"
                    lead={8}
                    tail={6}
                    size="sm"
                    tone={identity.isRotation ? 'dim' : 'muted'}
                    href={null}
                  />
                </dd>
              </div>
            )}
          </dl>
        )}

        {action !== null && (
          <div className={s.actions}>
            {action}
            <p className={s.actionNote}>
              {identity.status === 'unregistered' || identity.status === 'registering'
                ? 'Gas only — KeyRegistry charges nothing and needs no activation.'
                : 'Your private keys never leave this device. They live in IndexedDB, keyed by address, and are wiped the moment you disconnect.'}
            </p>
          </div>
        )}

        {identity.status === 'loading' && (
          <div className={s.pending} role="status">
            <span className={s.pendingBar} aria-hidden="true" />
            <span className={s.pendingText}>Reading the key registry…</span>
          </div>
        )}

        {registerTxUrl !== null && identity.status === 'registering' && (
          <AppNotice
            tone="info"
            title="Registration submitted"
            body="Waiting for the receipt. You can leave this page open; the desk unlocks the moment it confirms."
            meta={
              <a
                className={s.txLink}
                href={registerTxUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                {identity.registerTxHash}
              </a>
            }
          />
        )}

        {switchError !== null && (
          <AppNotice
            tone="warn"
            title="The network was not switched"
            body={switchError}
            action={
              <Button size="sm" onClick={() => setSwitchError(null)}>
                Dismiss
              </Button>
            }
          />
        )}

        {identity.error !== null && (
          <AppNotice
            tone="error"
            title="That did not go through"
            body={identity.error}
            action={
              <Button size="sm" onClick={identity.clearError}>
                Dismiss
              </Button>
            }
          />
        )}

        {identity.storageWarning !== null && (
          <AppNotice tone="warn" title="Keys are not cached" body={identity.storageWarning} />
        )}
      </div>
    </section>
  );
}
