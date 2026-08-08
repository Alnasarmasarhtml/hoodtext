'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { useAccount } from 'wagmi';

import { asset } from '@/lib/asset';
import { ACTIVE_CHAIN_ID, activeChain } from '@/lib/chain';
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
  { href: '/app', label: 'Messenger', match: (p) => p.startsWith('/app') },
  { href: '/access', label: 'Access', match: (p) => p.startsWith('/access') },
];

/** The project's account. Change here and it changes everywhere it appears. */
const X_URL = 'https://x.com/hoodgram';

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
        <Link href="/" className={s.brand} aria-label="HoodGram — home">
          {/* The rendered platinum mark, not the old drawn glyph. It carries
              real material and a green inner edge, so it needs more than the
              17px the flat SVG lived at to read at all. */}
          <img
            className={s.mark}
            src={asset('/brand/mark-hg-512.png')}
            alt=""
            width={512}
            height={512}
            decoding="async"
          />
          <span className={s.wordmark}>HoodGram</span>
        </Link>

        <span className={s.chainChip}>
          <span className={s.chainDot} aria-hidden="true" />
          {activeChain.name}
        </span>

        <nav className={s.nav} aria-label="Primary">
          <NavLinks pathname={pathname} />
        </nav>

        <div className={s.side}>
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
