'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { useAccount } from 'wagmi';

import { ACTIVE_CHAIN_ID, activeChain } from '@/lib/chain';
import { cx } from '@/lib/cx';
import { truncateAddress } from '@/lib/format';
import { useConnectSheet } from '@/lib/ui-store';
import { Button } from './Button';
import { LogoMark } from './Logo';
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
          <LogoMark size={17} className={s.mark} />
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
