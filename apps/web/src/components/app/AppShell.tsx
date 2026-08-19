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
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAccount } from 'wagmi';

import {
  DEMO_X25519_PUB,
  demoDropsSnapshot,
  demoRelaySnapshot,
  seedDemoWorld,
  useActivation,
  useDemoActive,
  useDrops,
  useIdentity,
  useRelayStatus,
} from '@/hooks';
import { DEMO_ME } from '@/lib/demo';
import { lockDocumentScroll } from '@/lib/scroll-lock';
import { AccountBadge } from './AccountBadge';
import { CallProvider } from './CallProvider';
import { AppNotice } from './AppNotice';
import { ConversationList } from './ConversationList';
import { DemoBanner } from './DemoBanner';
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

  /* The non-arithmetic half of the no-page-scroll guarantee.
     `AppShell.module.css` already sizes the shell to the viewport minus the site
     header, but arithmetic can be defeated — a browser that does not understand
     a unit drops the whole declaration carrying it — so while the messenger is
     mounted the document is simply not a scroll container, whatever the layout
     ends up measuring.

     Held for the whole life of this component, which is the whole life of the
     `/app` segment since the layout mounts the shell once. The lock is the
     shared refcounted one in `@/lib/scroll-lock`: the connect sheet holds the
     same counter, so neither can restore the other's `overflow: hidden` as if it
     were the original value. Leaving the segment spends this holder's release,
     and `/` and `/access` get their scrolling back the moment nothing else
     wants it. */
  useEffect(() => {
    /* Clamp before locking, not inside the lock — this is the messenger's
       requirement, not the sheet's. Arriving mid-scroll and freezing at a
       non-zero offset would strand the header off-screen with no way to reach
       it, a worse bug than the one being fixed. The sheet, by contrast, opens
       over mid-page content and must leave the offset alone. `hidden` (unlike
       `clip`) keeps the viewport programmatically scrollable, so this still
       works when the sheet already holds the lock. */
    window.scrollTo(0, 0);
    return lockDocumentScroll();
  }, []);

  /* Demo resolves to true only in the browser, after hydration — every
     prerendered byte is the real interface. */
  const demo = useDemoActive();
  const [demoSeeded, setDemoSeeded] = useState(false);
  useEffect(() => {
    if (!demo) return;
    seedDemoWorld();
    setDemoSeeded(true);
  }, [demo]);

  const identity = useIdentity();
  const activation = useActivation();
  /* In demo the engine never attaches: null owner and keys hold it off, so
     no relay backfill, no WebSocket, no chain reads. */
  const drops = useDrops({
    owner: demo ? null : identity.address,
    keys: demo ? null : identity.keys,
  });
  const relay = useRelayStatus(!demo);

  const activeConvoId = activeConvoIdFrom(pathname);

  const session = useMemo<AppSession>(
    () =>
      demo
        ? {
            address: DEMO_ME.address,
            x25519Pub: DEMO_X25519_PUB,
            keys: null,
            identityStatus: 'ready',
            activation,
            drops: demoDropsSnapshot(),
          }
        : {
            address: identity.address,
            x25519Pub: identity.x25519Pub,
            keys: identity.keys,
            identityStatus: identity.status,
            activation,
            drops,
          },
    [
      activation,
      demo,
      // The snapshot's numbers change once the world seeds.
      demoSeeded,
      drops,
      identity.address,
      identity.keys,
      identity.status,
      identity.x25519Pub,
    ],
  );

  const chromeDrops = demo ? session.drops : drops;
  const chromeRelay = demo ? demoRelaySnapshot() : relay;
  const ready = demo ? demoSeeded : identity.status === 'ready';

  return (
    <div className={s.shell}>
      {demo && <DemoBanner />}

      <div className={s.chrome}>
        <div className={s.chromeLeft}>
          <span className={s.deskMark} aria-hidden="true" />
          <span className={s.deskName}>Desk</span>
          <RelayStatus relay={chromeRelay} drops={chromeDrops} />
        </div>

        <div className={s.chromeRight}>
          <AccountBadge
            activation={activation}
            address={demo ? DEMO_ME.address : identity.address}
            connected={demo ? true : isConnected}
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
          body={`${activation.error} Reading and receiving are unaffected. This only clouds the badge and the composer.`}
        />
      )}

      {!ready ? (
        /* Demo skips the ceremony entirely; the seed lands one effect tick
           after mount, so the gate must not flash in between. */
        demo ? (
          <div className={s.gate} aria-hidden="true" />
        ) : (
          <div className={s.gate}>
            <IdentityGate identity={identity} />
          </div>
        )
      ) : (
        <AppSessionProvider value={session}>
          <CallProvider>
            <div className={s.desk} data-view={activeConvoId === null ? 'list' : 'thread'}>
              <aside className={s.rail} aria-label="Conversation rail">
                <ConversationList activeConvoId={activeConvoId} />
              </aside>

              <div className={s.pane}>{children}</div>
            </div>
          </CallProvider>
        </AppSessionProvider>
      )}
    </div>
  );
}
