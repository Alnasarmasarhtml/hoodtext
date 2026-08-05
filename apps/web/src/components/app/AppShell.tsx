'use client';

/**
 * The messenger shell (SPEC §7.3).
 *
 * Mounted once by `/app/layout.tsx`, so the identity ceremony and the receive
 * engine run exactly once per session and survive navigation between threads.
 * The resolved session travels to the panes by context rather than each pane
 * starting its own scanner.
 *
 * Order of operations, and the reasoning behind it:
 *
 *  1. `useIdentity` — connect, sign once, register keys. Until keys exist there
 *     is nothing to decrypt with, so the gate stands in front of the desk.
 *  2. `useDrops` — backfills `GET /v1/drops`, follows the relay WebSocket,
 *     scans by view tag, verifies each blob against its on-chain `blobRef` and
 *     opens what is ours. It is attached the moment keys exist, *not* when the
 *     account is activated: receiving is never gated on payment.
 *  3. `useActivation` — drives the quiet badge and the composer only. $5,
 *     once, forever; it never hides history.
 */

import { usePathname } from 'next/navigation';
import { useMemo, type ReactNode } from 'react';
import { useAccount } from 'wagmi';

import { useActivation, useDrops, useIdentity, useRelayStatus } from '@/hooks';
import { AccountBadge } from './AccountBadge';
import { AppNotice } from './AppNotice';
import { ConversationList } from './ConversationList';
import { IdentityGate } from './IdentityGate';
import { RelayStatus } from './RelayStatus';
import { TamperBanner } from './TamperBanner';
import { AppSessionProvider, type AppSession } from './session';
import s from './AppShell.module.css';

const THREAD_PATH = /^\/app\/(.+)$/;

/** The pane-selecting segment currently open, or `null` on `/app` itself. */
function activeConvoIdFrom(pathname: string): string | null {
  const match = THREAD_PATH.exec(pathname);
  const segment = match?.[1];
  if (segment === undefined || segment === '') return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export interface AppShellProps {
  readonly children: ReactNode;
}

export function AppShell({ children }: AppShellProps): ReactNode {
  const pathname = usePathname();
  const { isConnected } = useAccount();

  const identity = useIdentity();
  const activation = useActivation();
  const drops = useDrops({ owner: identity.address, keys: identity.keys });
  const relay = useRelayStatus();

  const activeConvoId = activeConvoIdFrom(pathname);

  const session = useMemo<AppSession>(
    () => ({
      address: identity.address,
      x25519Pub: identity.x25519Pub,
      keys: identity.keys,
      identityStatus: identity.status,
      activation,
      drops,
    }),
    [activation, drops, identity.address, identity.keys, identity.status, identity.x25519Pub],
  );

  const ready = identity.status === 'ready';

  return (
    <div className={s.shell}>
      <div className={s.chrome}>
        <div className={s.chromeLeft}>
          <span className={s.deskMark} aria-hidden="true" />
          <span className={s.deskName}>Desk</span>
          <span className={s.chromeRule} aria-hidden="true" />
          <RelayStatus relay={relay} drops={drops} />
        </div>

        <div className={s.chromeRight}>
          <AccountBadge
            activation={activation}
            address={identity.address}
            connected={isConnected}
          />
        </div>
      </div>

      <TamperBanner events={drops.tamperEvents} />

      {ready && identity.storageWarning !== null && (
        <AppNotice
          className={s.strip}
          tone="warn"
          title="Keys are not cached on this device"
          body={identity.storageWarning}
        />
      )}

      {ready && activation.error !== null && (
        <AppNotice
          className={s.strip}
          tone="warn"
          title="Activation could not be read"
          body={`${activation.error} Reading and receiving are unaffected — this only clouds the badge and the composer.`}
        />
      )}

      {!ready ? (
        <div className={s.gate}>
          <IdentityGate identity={identity} />
        </div>
      ) : (
        <AppSessionProvider value={session}>
          <div className={s.desk} data-view={activeConvoId === null ? 'list' : 'thread'}>
            <aside className={s.rail} aria-label="Conversation rail">
              <ConversationList activeConvoId={activeConvoId} />
            </aside>

            <div className={s.pane}>{children}</div>
          </div>
        </AppSessionProvider>
      )}
    </div>
  );
}
