'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useState, type ReactNode } from 'react';
import { useAccount } from 'wagmi';

import { asset } from '@/lib/asset';
import { ACTIVE_CHAIN_ID, tryGetContracts } from '@/lib/chain';
import { cx } from '@/lib/cx';
import { truncateAddress } from '@/lib/format';
import { useConnectSheet } from '@/lib/ui-store';
import { Button } from './Button';
import s from './SiteHeader.module.css';

interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly match: (pathname: string) => boolean;
}

const NAV: readonly NavItem[] = [
  { href: '/', label: 'Overview', match: (p) => p === '/' },
  { href: '/record', label: 'The Record', match: (p) => p.startsWith('/record') },
  { href: '/app', label: 'Messenger', match: (p) => p.startsWith('/app') },
  { href: '/access', label: 'Access', match: (p) => p.startsWith('/access') },
];

/**
 * The token contract, click to copy.
 *
 * Read from the build's deployed set rather than hardcoded, so a token swap
 * moves this with everything else and the bar can never advertise a stale
 * address. Renders nothing when the build targets a chain with no deployment.
 */
function ContractChip(): ReactNode {
  const contracts = tryGetContracts(ACTIVE_CHAIN_ID);
  const [copied, setCopied] = useState(false);
  const token = contracts?.token ?? null;

  const onCopy = useCallback((): void => {
    if (token === null) return;
    void navigator.clipboard.writeText(token).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      },
      () => {
        /* clipboard blocked: the full address is in the tooltip either way */
      },
    );
  }, [token]);

  if (token === null) return null;

  return (
    <button
      type="button"
      className={s.contract}
      onClick={onCopy}
      title={`$GRAM contract ${token} — click to copy`}
      aria-label={`Copy the $GRAM contract address, ${token}`}
    >
      <span className={s.contractKey}>CA</span>
      <span className={s.contractValue}>
        {copied ? 'Copied' : `${token.slice(0, 6)}…${token.slice(-4)}`}
      </span>
    </button>
  );
}

/** The project's accounts. Change here and they change everywhere they appear. */
const X_URL = 'https://x.com/rhoodgram';
const TELEGRAM_URL = 'https://t.me/hoodgramrh';

/** The X glyph, drawn rather than loaded, so the bar needs no icon dependency. */
function XMark(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        stroke="none"
        d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117Z"
      />
    </svg>
  );
}

/** The Telegram glyph, drawn rather than loaded, matching the X mark's weight. */
function TelegramMark(): ReactNode {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        stroke="none"
        d="M21.94 3.42 18.7 20.05c-.24 1.17-.9 1.46-1.82.91l-5.03-3.71-2.43 2.34c-.27.27-.5.5-1.01.5l.36-5.13L18.1 6.5c.4-.36-.09-.56-.63-.2L5.94 13.6l-4.97-1.56c-1.08-.34-1.1-1.08.23-1.6L20.54 2.05c.9-.34 1.69.2 1.4 1.37Z"
      />
    </svg>
  );
}

function NavLinks({ pathname }: { pathname: string }): ReactNode {
  return (
    <>
      {NAV.map((item) => {
        const active = item.match(pathname);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cx(s.link, active && s.active)}
            aria-current={active ? 'page' : undefined}
          >
            {item.label}
          </Link>
        );
      })}
    </>
  );
}

/**
 * The site chrome: wordmark, the three routes, and the connect control.
 *
 * Nav collapses to a hairline strip under the bar below 760px rather than into
 * a hamburger — three destinations do not warrant a drawer, and a visible strip
 * keeps the current section readable at a glance.
 */
export function SiteHeader(): ReactNode {
  const pathname = usePathname();
  const openSheet = useConnectSheet((state) => state.open);
  const { address, chainId, isConnected } = useAccount();

  const wrongNetwork = isConnected && chainId !== ACTIVE_CHAIN_ID;

  return (
    <header className={s.header}>
      <div className={s.bar}>
        <Link href="/" className={s.brand} aria-label="HoodGram home">
          {/* The folded mark (client pick M10, 2026-08-12). Flat, so it holds
              its edges at sizes the rendered hood never could. */}
          <img
            className={s.mark}
            src={asset('/brand/mark-fold-512.png')}
            alt=""
            width={483}
            height={512}
            decoding="async"
          />
          <span className={s.wordmark}>HoodGram</span>
        </Link>

        {/* The chain chip left the masthead in the corporate pass: the network
            is stated on /access and in the footer, where the data lives. */}
        <nav className={s.nav} aria-label="Primary">
          <NavLinks pathname={pathname} />
        </nav>

        <ContractChip />

        <div className={s.side}>
          <a
            className={s.social}
            href={TELEGRAM_URL}
            target="_blank"
            rel="noreferrer noopener"
            aria-label="HoodGram on Telegram"
            title="HoodGram on Telegram"
          >
            <TelegramMark />
          </a>

          <a
            className={s.social}
            href={X_URL}
            target="_blank"
            rel="noreferrer noopener"
            aria-label="HoodGram on X"
            title="HoodGram on X"
          >
            <XMark />
          </a>

          {isConnected && address !== undefined ? (
            <button
              type="button"
              className={s.account}
              onClick={() => openSheet()}
              aria-label="Wallet details"
            >
              <span
                className={cx(s.statusDot, wrongNetwork && s.statusWrong)}
                aria-hidden="true"
              />
              <span className={s.accountText}>
                {wrongNetwork ? 'Wrong network' : truncateAddress(address)}
              </span>
            </button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              onClick={() => openSheet()}
            >
              Connect
            </Button>
          )}
        </div>
      </div>

      <nav className={s.navMobile} aria-label="Primary, compact">
        <NavLinks pathname={pathname} />
      </nav>
    </header>
  );
}
