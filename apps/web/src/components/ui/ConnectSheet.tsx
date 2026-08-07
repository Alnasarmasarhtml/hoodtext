'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi';

import { ACTIVE_CHAIN_ID, activeChain, chainById, explorerAddressUrl } from '@/lib/chain';
import { cx } from '@/lib/cx';
import { useConnectSheet } from '@/lib/ui-store';
import { Button } from './Button';
import { Eyebrow } from './Label';
import { Hex } from './Hex';
import s from './ConnectSheet.module.css';

const WALLET_LINKS: readonly { readonly label: string; readonly href: string }[] = [
  { label: 'MetaMask', href: 'https://metamask.io/download/' },
  { label: 'Rabby', href: 'https://rabby.io/' },
  { label: 'Coinbase Wallet', href: 'https://www.coinbase.com/wallet/downloads' },
];

function readableError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.split('\n')[0] ?? error.message;
    return message.length > 220 ? `${message.slice(0, 217)}…` : message;
  }
  return 'The wallet rejected the request.';
}

/**
 * Our own wallet sheet — never a third-party connect modal.
 *
 * The list is wagmi's EIP-6963 discovery output, so it shows the wallets the
 * browser actually announces, with their real names and icons. Open it from
 * anywhere with `useConnectSheet().open()`.
 */
export function ConnectSheet(): ReactNode {
  const isOpen = useConnectSheet((state) => state.isOpen);
  const reason = useConnectSheet((state) => state.reason);
  const close = useConnectSheet((state) => state.close);

  const { address, chainId, isConnected, connector: active } = useAccount();
  const { connectors, connectAsync, error: connectError, reset } = useConnect();
  const { disconnectAsync } = useDisconnect();
  const { switchChainAsync, isPending: switching } = useSwitchChain();

  const [mounted, setMounted] = useState(false);
  const [pendingUid, setPendingUid] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [hasInjected, setHasInjected] = useState(true);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    setHasInjected(typeof window !== 'undefined' && 'ethereum' in window);
  }, [isOpen]);

  /* Escape to close, and lock the page behind the sheet. */
  useEffect(() => {
    if (!isOpen) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKeyDown);

    const root = document.documentElement;
    const previousOverflow = root.style.overflow;
    root.style.overflow = 'hidden';

    const raf = requestAnimationFrame(() => {
      panelRef.current?.focus();
    });

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      root.style.overflow = previousOverflow;
      cancelAnimationFrame(raf);
    };
  }, [close, isOpen]);

  useEffect(() => {
    if (!isOpen) {
      setPendingUid(null);
      setLocalError(null);
    }
  }, [isOpen]);

  const onConnect = useCallback(
    async (uid: string): Promise<void> => {
      const target = connectors.find((c) => c.uid === uid);
      if (target === undefined) return;
      setLocalError(null);
      setPendingUid(uid);
      try {
        await connectAsync({ connector: target, chainId: ACTIVE_CHAIN_ID });
        close();
      } catch (error) {
        setLocalError(readableError(error));
      } finally {
        setPendingUid(null);
      }
    },
    [close, connectAsync, connectors],
  );

  const onDisconnect = useCallback(async (): Promise<void> => {
    setLocalError(null);
    try {
      await disconnectAsync();
      reset();
      close();
    } catch (error) {
      setLocalError(readableError(error));
    }
  }, [close, disconnectAsync, reset]);

  const onSwitch = useCallback(async (): Promise<void> => {
    setLocalError(null);
    try {
      await switchChainAsync({ chainId: ACTIVE_CHAIN_ID });
    } catch (error) {
      setLocalError(readableError(error));
    }
  }, [switchChainAsync]);

  if (!mounted || !isOpen) return null;

  const wrongNetwork = isConnected && chainId !== ACTIVE_CHAIN_ID;
  const currentChainName =
    chainId === undefined ? 'Unknown' : (chainById(chainId)?.name ?? `Chain ${chainId}`);
  const message = localError ?? (connectError === null ? null : readableError(connectError));

  const sheet = (
    <>
      <div className={s.scrim} onClick={close} aria-hidden="true" />

      <div
        ref={panelRef}
        className={s.sheet}
        role="dialog"
        aria-modal="true"
        aria-label="Wallet"
        tabIndex={-1}
      >
        <div className={s.inner}>
          <div className={s.head}>
            <div className={s.headText}>
              <Eyebrow rule>Wallet</Eyebrow>
              <span className={s.title}>
                {isConnected ? 'Connected' : 'Connect a wallet'}
              </span>
              <span className={s.reason}>
                {reason ??
                  (isConnected
                    ? 'Your keys stay in your wallet. HoodGram never sees them.'
                    : 'HoodGram reads your subscription and holdings from the chain. Connecting does not authorise any transaction.')}
              </span>
            </div>
            <button
              type="button"
              className={s.close}
              onClick={close}
              aria-label="Close wallet sheet"
            >
              <svg className={s.closeIcon} viewBox="0 0 11 11" aria-hidden="true">
                <path d="M1 1l9 9M10 1l-9 9" />
              </svg>
            </button>
          </div>

          <div className={s.scroll}>
            {isConnected && address !== undefined ? (
              <div className={s.section}>
                <div className={s.account}>
                  <div className={s.accountRow}>
                    <span className={s.accountLabel}>Address</span>
                    <Hex
                      value={address}
                      label="Wallet address"
                      href={explorerAddressUrl(address)}
                    />
                  </div>

                  <div className={s.accountRow}>
                    <span className={s.accountLabel}>Network</span>
                    <span className={cx(s.chainChip, wrongNetwork && s.chainWrong)}>
                      <span className={s.dot} aria-hidden="true" />
                      <span>{currentChainName}</span>
                    </span>
                  </div>

                  {active !== undefined && (
                    <div className={s.accountRow}>
                      <span className={s.accountLabel}>Wallet</span>
                      <span className={s.rowNote}>{active.name}</span>
                    </div>
                  )}
                </div>

                {wrongNetwork && (
                  <>
                    <p className={s.note}>
                      HoodGram is deployed on {activeChain.name}. Switch networks to read
                      your subscription and post messages.
                    </p>
                    <Button
                      variant="primary"
                      block
                      loading={switching}
                      onClick={() => void onSwitch()}
                    >
                      Switch to {activeChain.name}
                    </Button>
                  </>
                )}
              </div>
            ) : hasInjected && connectors.length > 0 ? (
              <div className={s.list}>
                {connectors.map((connector) => (
                  <button
                    key={connector.uid}
                    type="button"
                    className={s.row}
                    onClick={() => void onConnect(connector.uid)}
                    disabled={pendingUid !== null}
                  >
                    <span className={s.rowIcon}>
                      {connector.icon === undefined ? (
                        <span className={s.rowInitial}>
                          {connector.name.slice(0, 1).toUpperCase()}
                        </span>
                      ) : (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={connector.icon} alt="" width={18} height={18} />
                      )}
                    </span>
                    <span className={s.rowBody}>
                      <span className={s.rowName}>{connector.name}</span>
                      <span className={s.rowNote}>
                        {pendingUid === connector.uid ? 'Approve in wallet' : 'Browser wallet'}
                      </span>
                    </span>
                    <svg className={s.rowMark} viewBox="0 0 12 12" aria-hidden="true">
                      <path d="M4 1.5 8.5 6 4 10.5" />
                    </svg>
                  </button>
                ))}
              </div>
            ) : (
              <div className={s.empty}>
                <span className={s.emptyTitle}>No wallet detected</span>
                <p className={s.note}>
                  HoodGram connects to any EIP-1193 browser wallet. Install one, then
                  reopen this sheet — nothing else is needed to read the chain.
                </p>
                <div className={s.links}>
                  {WALLET_LINKS.map((link) => (
                    <a
                      key={link.href}
                      className={s.link}
                      href={link.href}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {link.label}
                    </a>
                  ))}
                </div>
              </div>
            )}

            {message !== null && (
              <div className={s.section}>
                <p className={s.error} role="alert">
                  {message}
                </p>
              </div>
            )}
          </div>

          {isConnected && (
            <div className={s.foot}>
              <Button variant="danger" block onClick={() => void onDisconnect()}>
                Disconnect
              </Button>
              <p className={s.note}>
                Disconnecting wipes the cached identity key for this address from this
                device. Your history stays on chain and your keys can be re-derived by
                signing again.
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );

  return createPortal(sheet, document.body);
}
