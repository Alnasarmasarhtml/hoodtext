'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

import { buttonClassName } from '@/components/ui/Button';
import { PRICES } from '@/lib/abi';
import { SectionHead } from './SectionHead';
import s from './Pricing.module.css';
import { TokenMark } from './TokenMark';

interface Rule {
  readonly title: string;
  readonly body: ReactNode;
}

/** The four things that make two prices fair. All of them are on-chain. */
const RULES: readonly Rule[] = [
  {
    title: 'Priced in dollars',
    body: (
      <>
        Both prices are stored on chain in USD and converted to <TokenMark quiet /> at
        the moment you pay. The token can move; your bill does not.
      </>
    ),
  },
  {
    title: 'Members never pay',
    body: 'One person runs a room and pays its rent. Everyone they invite rides free — no seat charges, no per-member anything.',
  },
  {
    title: 'Lapse pauses, never deletes',
    body: 'When rent runs out, new messages stop — that is all. History, membership and the admin role survive, and paying reopens the room the same second.',
  },
  {
    title: 'Anyone can pay a room’s rent',
    body: 'payRent is permissionless: the community can keep its own room alive. Paying grants no control — the admin stays the admin.',
  },
];

/**
 * Two big numbers, and the four rules that govern them.
 *
 * The closing line is the real product claim: $5 buys the account, $10 keeps a
 * room open, and nothing else — least of all a message — is ever metered.
 */
export function Pricing(): ReactNode {
  return (
    <div className="wrap">
      <SectionHead
        index="03"
        eyebrow="Pricing"
        title="Two prices. Nothing else is ever metered."
        lede={
          <>
            Five dollars, once, for an account that exists forever. Ten dollars a month
            for a room, paid by whoever runs it. Messages cost{' '}
            <strong>nothing</strong> — relayed with no gas, or self-posted for about a
            cent.
          </>
        }
        aside="Fixed in USD · paid in $THOOD"
      />

      <div className={s.grid}>
        {/* ── the $5 ─────────────────────────────────────────────────────── */}
        <article className={s.card} data-reveal>
          <div className={s.cardHead}>
            <span className={s.amount}>{`$${PRICES.activationUsd}`}</span>
            <span className={s.cadence}>once</span>
          </div>

          <h3 className={s.cardTitle}>Your account. Forever.</h3>
          <p className={s.cardBody}>
            One payment in <TokenMark quiet /> at the live rate and your account exists
            permanently — nothing renews, nothing expires, nothing to lose.
          </p>
          <p className={s.cardBody}>
            It is also the spam wall: every account on TeleHood cost somebody five
            bucks, so there are no bot floods and no burner swarms.
          </p>

          <div className={s.cardFoot}>
            <Link
              href="/access"
              className={buttonClassName({ variant: 'primary', size: 'md', block: true })}
            >
              Activate — $5, once
            </Link>
            <span className={s.cardNote}>Live $THOOD quote on /access</span>
            <Link className={s.demoLink} href="/app?demo=1">
              or view the demo first — no wallet needed
            </Link>
          </div>
        </article>

        {/* ── the $10 ────────────────────────────────────────────────────── */}
        <article className={s.card} data-reveal>
          <div className={s.cardHead}>
            <span className={s.amount}>{`$${PRICES.roomUsdPerMonth}`}</span>
            <span className={s.cadence}>/month per room</span>
          </div>

          <h3 className={s.cardTitle}>A room, paid by whoever runs it.</h3>
          <p className={s.cardBody}>
            The room&apos;s owner covers the rent — 1 to 24 months at a time — and every
            member rides free. Anyone may pay a room&apos;s rent; paying grants no
            control.
          </p>
          <p className={s.cardBody}>
            If rent lapses, new messages pause. Nothing is ever deleted: history,
            members and admin survive, and paying reopens the room instantly.
          </p>

          <div className={s.cardFoot}>
            {/* Until the contracts are live this lands in the demo, where the
                rooms panel is populated — never a dead end. */}
            <Link
              href="/access?demo=1"
              className={buttonClassName({ variant: 'ghost', size: 'md', block: true })}
            >
              Manage your rooms
            </Link>
            <span className={s.cardNote}>Rooms are opened from the app</span>
          </div>
        </article>
      </div>

      <ol className={s.rules}>
        {RULES.map((rule, index) => (
          <li className={s.rule} key={rule.title} data-reveal>
            <span className={s.ruleIndex} aria-hidden="true">
              {`0${index + 1}`}
            </span>
            <h3 className={s.ruleTitle}>{rule.title}</h3>
            <p className={s.ruleBody}>{rule.body}</p>
          </li>
        ))}
      </ol>

      <div className={s.close} data-reveal>
        <div className={s.closeBody}>
          <p className={s.closeLead}>Messages are never charged.</p>
          <p className={s.closeSub}>
            There are no per-message fees and no usage charges of any kind.{' '}
            <code className={s.code}>Anchors.post</code> is not payable. The relay posts
            for you with no gas and no wallet popups — and your address never touches
            the chain — or you self-post yourself for about a cent.
          </p>
        </div>

        <div className={s.closeAction}>
          <Link
            href="/access"
            className={buttonClassName({ variant: 'primary', size: 'lg' })}
          >
            Pay $5 once
          </Link>
          <span className={s.closeNote}>Quote in $THOOD, live, on /access</span>
        </div>
      </div>
    </div>
  );
}
