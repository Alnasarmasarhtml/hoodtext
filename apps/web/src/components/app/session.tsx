'use client';

import type { IdentityKeys } from '@hoodgram/crypto';
import { createContext, useContext, type ReactNode } from 'react';
import type { Address, Hex } from 'viem';

import type { IdentityStatus, UseActivationResult, UseDropsResult } from '@/hooks';

/**
 * Everything the messenger panes need, resolved once by the shell.
 *
 * `useIdentity` signs and `useDrops` scans; both must run exactly once per
 * session. Routing puts the thread and the conversation list on opposite sides
 * of a `children` boundary, so the resolved session travels by context rather
 * than by each pane mounting its own engine.
 */
export interface AppSession {
  readonly address: Address | null;
  /** Our own registered X25519 public key — one half of every conversation id. */
  readonly x25519Pub: Hex | null;
  /**
   * The full derived keypairs. The Ed25519 half signs relayed drops; the
   * X25519 half wraps room keys. Never rendered, never serialised.
   */
  readonly keys: IdentityKeys | null;
  readonly identityStatus: IdentityStatus;
  readonly activation: UseActivationResult;
  readonly drops: UseDropsResult;
}

const AppSessionContext = createContext<AppSession | null>(null);

export function AppSessionProvider({
  value,
  children,
}: {
  readonly value: AppSession;
  readonly children: ReactNode;
}): ReactNode {
  return <AppSessionContext.Provider value={value}>{children}</AppSessionContext.Provider>;
}

/** The active session. Throws outside the messenger, which is a real bug. */
export function useAppSession(): AppSession {
  const session = useContext(AppSessionContext);
  if (session === null) {
    throw new Error('useAppSession must be used inside the /app shell (AppSessionProvider).');
  }
  return session;
}
