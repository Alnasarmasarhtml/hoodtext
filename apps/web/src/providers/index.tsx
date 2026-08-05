'use client';

import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { WagmiProvider, type State } from 'wagmi';

import { ConnectSheet } from '@/components/ui/ConnectSheet';
import { ToastProvider } from '@/components/ui/Toast';
import { wagmiConfig } from './config';
import { LenisProvider } from './LenisProvider';
import { getQueryClient } from './query';

export interface ProvidersProps {
  readonly children: ReactNode;
  /**
   * Optional hydrated wagmi state. Left undefined so the root layout stays
   * statically renderable; wagmi restores the connection from cookie storage on
   * mount instead.
   */
  readonly initialState?: State;
}

/**
 * Everything the app needs at the root, in dependency order:
 * wagmi → react-query → smooth scroll → toasts, with the wallet sheet mounted
 * last so `useConnectSheet().open()` works from any surface.
 */
export function Providers({ children, initialState }: ProvidersProps): ReactNode {
  const queryClient = getQueryClient();

  return (
    <WagmiProvider config={wagmiConfig} initialState={initialState}>
      <QueryClientProvider client={queryClient}>
        <LenisProvider>
          <ToastProvider>
            {children}
            <ConnectSheet />
          </ToastProvider>
        </LenisProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

export { wagmiConfig } from './config';
export { getQueryClient } from './query';
export { LenisProvider, useLenis } from './LenisProvider';
export type { LenisApi } from './LenisProvider';
