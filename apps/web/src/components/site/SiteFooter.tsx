'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

import { Hex } from '@/components/ui/Hex';
import { LogoMark } from '@/components/ui/Logo';
import {
  activeChain,
  explorerAddressUrl,
  tryGetContracts,
  type ContractAddresses,
  type ContractName,
} from '@/lib/chain';
import { RELAY_URL } from '@/lib/relay';
import s from './SiteFooter.module.css';
import { TokenMark } from './TokenMark';

const LINKS: readonly { readonly href: string; readonly label: string }[] = [
  { href: '/app', label: 'Messenger' },
  { href: '/access', label: 'Activate & claim' },
];

interface ContractRow {
  readonly key: ContractName;
  readonly label: string;
  readonly note: string;
}

/** All nine contracts (SPEC §4), in the order the money flows. */
const CONTRACTS: readonly ContractRow[] = [
  { key: 'token', label: 'TeleHoodToken', note: '$THOOD — balance checkpoints' },
  { key: 'priceSource', label: 'PriceSource', note: 'USD → $THOOD rate' },
  { key: 'activation', label: 'Activation', note: '$5, once, forever' },
  { key: 'groupRegistry', label: 'GroupRegistry', note: 'rooms · $10/month rent' },
  { key: 'revenueVault', label: 'RevenueVault', note: '50/50 split · epochs · claims' },
  { key: 'keyRegistry', label: 'KeyRegistry', note: 'free identity keys' },
  { key: 'anchors', label: 'Anchors', note: 'the message log — not payable' },
  { key: 'perks', label: 'Perks', note: 'holder status ladder' },
  { key: 'handles', label: 'Handles', note: '@names' },
];

/**
 * Hairline colophon: the claim, the routes, and every contract address with an
 * explorer link. When the build has no addresses it says so instead of
 * printing zeroes.
 */
export function SiteFooter(): ReactNode {
  const explorer = activeChain.blockExplorers?.default;
  const contracts: ContractAddresses | null = tryGetContracts();

  return (
    <footer className={s.footer}>
      <div className="wrap">
        <div className={s.top}>
          <div className={s.brand}>
            <LogoMark size={15} className={s.mark} />
            <span className={s.wordmark}>TELEHOOD</span>
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

        {/* ── the nine contracts ─────────────────────────────────────────── */}
        <div className={s.contracts}>
          <div className={s.contractsHead}>
            <span className={s.contractsLabel}>Contracts</span>
            <span className={s.contractsRule} aria-hidden="true" />
            <span className={s.contractsNote}>
              {contracts === null
                ? 'not deployed on this build'
                : `${CONTRACTS.length} deployed · ${activeChain.name}`}
            </span>
          </div>

          <ul className={s.contractList}>
            {CONTRACTS.map((row) => {
              const address = contracts?.[row.key] ?? null;
              return (
                <li className={s.contract} key={row.key}>
                  <span className={s.contractName}>{row.label}</span>
                  <span className={s.contractNote}>{row.note}</span>
                  <span className={s.contractAddress}>
                    {address === null ? (
                      <span className={s.contractMissing}>awaiting deployment</span>
                    ) : (
                      <Hex
                        value={address}
                        label={`${row.label} contract`}
                        href={explorerAddressUrl(address)}
                        size="sm"
                        tone="muted"
                      />
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>

        <div className={s.base}>
          <span className={s.baseText}>
            TeleHood is software. Anchors are public and permanent.
          </span>
          <span className={s.baseText}>
            $5 once · rooms $10/month · messages free · 50% to holders
          </span>
        </div>
      </div>
    </footer>
  );
}
