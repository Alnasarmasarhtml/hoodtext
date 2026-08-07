import type { ReactNode } from 'react';

import { asset } from '@/lib/asset';
import { cx } from '@/lib/cx';
import { MediaLoop } from './MediaLoop';
import { TokenMark } from './TokenMark';
import s from './WhatThisIs.module.css';

interface Block {
  readonly index: string;
  readonly title: string;
  readonly body: ReactNode;
}

/** The product, in the order the money moves. All figures are SPEC values, not marketing. */
const BLOCKS: readonly Block[] = [
  {
    index: '01',
    title: 'Five dollars, once',
    body: (
      <>
        A $5 activation, paid in <TokenMark quiet />, creates your account and includes your
        @handle. It never renews and never expires — the account is yours for as long as the chain
        exists. The price is also the spam wall: every account on HoodGram cost somebody five
        dollars, which is five dollars more than a bot flood wants to spend. No free tier, no
        burner armies.
      </>
    ),
  },
  {
    index: '02',
    title: 'Rooms run on rent',
    body: (
      <>
        A room is a group chat with rent: $10 a month, paid by whoever runs it. Members never pay.
        Anyone may pay a room&rsquo;s rent — paying grants no control. If the rent lapses, the room
        pauses new messages and deletes nothing: history, keys, membership and admin all survive,
        and paying again reopens it instantly.
      </>
    ),
  },
  {
    index: '03',
    title: 'Messages are free',
    body: (
      <>
        Sending costs nothing. A relay batch-posts your sealed message on chain and pays the gas —
        no wallet popup, no fee, and your address never appears on chain. Prefer not to trust even
        that? Post it yourself for about a cent. Self-posting is permissionless and always will
        be.
      </>
    ),
  },
  {
    index: '04',
    title: 'Anchored, permanently',
    body: (
      <>
        Every message is anchored on Robinhood Chain. What the chain holds is a sealed, padded
        envelope and a timestamp — proof the message happened, with nothing inside for anyone to
        read. Your history cannot be quietly edited or deleted by a company, because it does not
        live at a company.
      </>
    ),
  },
];

/**
 * Four corner marks instead of a continuous border — the box reads as a
 * registration frame over the footage rather than a card sitting on top of it.
 */
function Brackets(): ReactNode {
  return (
    <>
      <span className={cx(s.brk, s.brkTl)} aria-hidden="true" />
      <span className={cx(s.brk, s.brkTr)} aria-hidden="true" />
      <span className={cx(s.brk, s.brkBl)} aria-hidden="true" />
      <span className={cx(s.brk, s.brkBr)} aria-hidden="true" />
    </>
  );
}

interface Tier {
  readonly name: string;
  readonly hold: string;
  readonly unlocks: string;
}

const TIERS: readonly Tier[] = [
  { name: 'Resident', hold: '0.05%', unlocks: 'Holder badge beside your name in every chat' },
  {
    name: 'Block Captain',
    hold: '0.10%',
    unlocks: '+ 4-character @handles, bigger uploads, bigger rooms',
  },
  { name: 'District', hold: '0.25%', unlocks: '+ 3-character @handles, early features' },
  { name: 'Kingpin', hold: '0.50%', unlocks: '+ 2-character @handles, broadcast rooms' },
];

/**
 * SECTION 02 — the whole description of the project, as readable body copy over the client's
 * crowd render. The veil is deliberately heavy; the footage is texture here, not the message.
 */
export function WhatThisIs(): ReactNode {
  return (
    <section className={s.section} id="what">
      <MediaLoop src={asset('/media/crowd-march.mp4')} poster={asset('/art/crowd.png')} />
      <div className={s.veil} aria-hidden="true" />

      <div className={cx('wrap', s.inner)}>
        <div className={s.fileRow} data-reveal>
          <span>File 02 — What this is</span>
          <span className={s.fileRule} aria-hidden="true" />
          <span>Robinhood Chain · 4663</span>
        </div>

        <header className={s.head} data-reveal>
          <h2 className={s.title}>A messenger that cannot be switched off.</h2>
          <p className={s.lede}>
            HoodGram is an end-to-end encrypted messenger that lives on the open web and settles
            on Robinhood Chain. Every message becomes a permanent, verifiable anchor on a public
            network — proof it was sent, readable by no one but the recipient. There is no store
            to remove it from and no subscription to cancel. You buy in once.
          </p>
        </header>

        <div className={s.grid}>
          {BLOCKS.map((block) => (
            <article className={s.block} data-reveal key={block.index}>
              <Brackets />
              <h3 className={s.blockHead}>
                <span className={s.blockIndex}>{block.index}</span>
                {block.title}
              </h3>
              <p className={s.body}>{block.body}</p>
            </article>
          ))}

          <article className={cx(s.block, s.wide)} data-reveal>
            <Brackets />
            <h3 className={s.blockHead}>
              <span className={s.blockIndex}>05</span>
              Half goes back
            </h3>
            <p className={s.body}>
              50% of every payment — every $5 activation, every month of room rent — is paid to{' '}
              <TokenMark /> holders, pro-rata by holdings, in weekly epochs. No staking, no
              lock-up, no deposit contract. Hold in your own wallet at the weekly snapshot, then
              claim.
            </p>
          </article>

          <article className={cx(s.block, s.wide)} data-reveal>
            <Brackets />
            <h3 className={s.blockHead}>
              <span className={s.blockIndex}>06</span>
              The ladder
            </h3>
            <p className={s.body}>
              Holding more unlocks status, never money — a badge, shorter @handles, bigger rooms.
              A tier is judged on the lower of your live balance and the last weekly snapshot, so
              it must be held, not visited: it cannot be flash-bought, and selling drops it
              immediately. The revenue share itself needs no tier — every holder is paid pro-rata
              from the first token.
            </p>

            <table className={s.ladder}>
              <thead>
                <tr>
                  <th scope="col">Tier</th>
                  <th scope="col">Hold</th>
                  <th scope="col">Unlocks</th>
                </tr>
              </thead>
              <tbody>
                {TIERS.map((tier) => (
                  <tr key={tier.name}>
                    <th scope="row">{tier.name}</th>
                    <td className={s.ladderHold}>{tier.hold}</td>
                    <td className={s.ladderUnlocks}>{tier.unlocks}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </article>

        </div>

        {/* Set apart from the numbered file: centred, unnumbered, the one passage
            that is about the world rather than the product. */}
        <div className={s.why} data-reveal>
          <Brackets />
          <span className={s.whyRule} aria-hidden="true" />
          <h3 className={s.whyHead}>Why this exists</h3>
          <p className={s.whyBody}>
            For two decades, private messaging has lived in app stores and on company servers —
            places with owners, and owners can be ordered. The scanning law now in force in the
            EU applies to unencrypted services; encrypted messengers were carved out this round,
            and the next round starts in September. In August, a billion-user messenger
            disappeared from the App Store for two days on one company&rsquo;s decision. HoodGram
            is built for the day one of those votes goes the other way: a web app with no store
            to remove it from, sealed messages with nothing readable to hand over, and a
            self-post door that no one — including us — can close.
          </p>
          <span className={s.whyRule} aria-hidden="true" />
        </div>

        <aside className={cx('hairFrame', s.plate)} data-reveal>
          <div className={s.plateIn}>
            <p className={s.plateEyebrow}>The honest claim</p>
            <p className={s.plateText}>
              Message contents are unreadable by anyone but the recipient. Metadata is minimized,
              not eliminated.
            </p>
          </div>
        </aside>
      </div>
    </section>
  );
}
