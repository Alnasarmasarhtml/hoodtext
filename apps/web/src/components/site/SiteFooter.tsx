'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

import { LogoMark } from '@/components/ui/Logo';
import { activeChain } from '@/lib/chain';
import { RELAY_URL } from '@/lib/relay';
import s from './SiteFooter.module.css';
import { TokenMark } from './TokenMark';

const LINKS: readonly { readonly href: string; readonly label: string }[] = [
  { href: '/app', label: 'Messenger' },
  { href: '/access', label: 'Activate & claim' },
];

/**
 * Hairline colophon: the claim, the routes and the chain facts.
 *
 * The nine contract addresses used to be printed here. They came out once the
 * site went public: until the contracts are deployed to Robinhood Chain the
 * build only has local dev addresses, and publishing throwaway addresses beside
 * a real product reads as either a mistake or a trap. Put them back when there
 * are mainnet addresses worth verifying.
 */
export function SiteFooter(): ReactNode {
  const explorer = activeChain.blockExplorers?.default;

  return (
    <footer className={s.footer}>
      <div className="wrap">
        <div className={s.top}>
          <div className={s.brand}>
            <LogoMark size={15} className={s.mark} />
            <span className={s.wordmark}>HOODGRAM</span>
            <p className={s.claim}>
              Only the recipient can read your messages. Every one of them lands on
              Robinhood Chain with a permanent, verifiable receipt.
            </p>
          </div>

          <nav className={s.nav} aria-label="Footer">
            <span className={s.navLabel}>Product</span>
            {LINKS.map((link) => (
              <Link className={s.navLink} href={link.href} key={link.href}>
                {link.label}
              </Link>
            ))}
          </nav>

          <dl className={s.meta}>
            <div className={s.metaRow}>
              <dt className={s.metaLabel}>Chain</dt>
              <dd className={s.metaValue}>
                {activeChain.name} · {activeChain.id}
              </dd>
            </div>
            <div className={s.metaRow}>
              <dt className={s.metaLabel}>Token</dt>
              <dd className={s.metaValue}>
                <TokenMark /> · 1,000,000,000 supply
              </dd>
            </div>
            <div className={s.metaRow}>
              <dt className={s.metaLabel}>Relay</dt>
              <dd className={s.metaValue}>{RELAY_URL}</dd>
            </div>
            <div className={s.metaRow}>
              <dt className={s.metaLabel}>Explorer</dt>
              <dd className={s.metaValue}>
                {explorer === undefined ? (
                  'none for this chain'
                ) : (
                  <a
                    className={s.metaLink}
                    href={explorer.url}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {explorer.name}
                  </a>
                )}
              </dd>
            </div>
          </dl>
        </div>

        <div className={s.base}>
          <span className={s.baseText}>
            HoodGram is software. Anchors are public and permanent.
          </span>
          <span className={s.baseText}>
            $5 once · rooms $10/month · messages free · 50% to holders
          </span>
        </div>
      </div>
    </footer>
  );
}
