import type { ReactNode } from 'react';

import { cx } from '@/lib/cx';
import { COUNTERWEIGHT, SECTIONS } from './entries';
import type { Entry, EntryKind } from './entries';
import s from './RecordPage.module.css';

/**
 * `/record` — the dossier.
 *
 * Every entry states what an instrument does, what it does not do, and where to
 * read it yourself. The second of those is the point: a reader who catches one
 * overstatement will disbelieve the other twenty, and almost everything written
 * about these laws overstates them. Nothing is reveal-animated for the same
 * reason nothing is on /access — a claim that starts at `opacity: 0` is a claim
 * the reader cannot check.
 */

const KIND_LABEL: Readonly<Record<EntryKind, string>> = {
  'in-force': 'In force',
  proposed: 'Proposed',
  court: 'Before a court',
  blocked: 'Network block',
  breach: 'Breach',
};

/* CSS-module members are typed as possibly-undefined under this tsconfig, so
   the map is too and `cx` drops anything missing rather than emitting
   "undefined" as a class name. */
const KIND_CLASS: Readonly<Record<EntryKind, string | undefined>> = {
  'in-force': s.kindForce,
  proposed: s.kindProposed,
  court: s.kindCourt,
  blocked: s.kindBlocked,
  breach: s.kindBreach,
};

function EntryCard({ entry, index }: { entry: Entry; index: number }): ReactNode {
  return (
    <article className={s.entry} id={entry.id}>
      <div className={s.entryHead}>
        <span className={s.num}>{String(index).padStart(2, '0')}</span>
        <span className={s.jurisdiction}>{entry.jurisdiction}</span>
        <span className={cx(s.kind, KIND_CLASS[entry.kind])}>{KIND_LABEL[entry.kind]}</span>
      </div>

      <p className={s.date}>{entry.date}</p>
      <h3 className={s.entryTitle}>{entry.title}</h3>
      <p className={s.body}>{entry.body}</p>

      <div className={s.not}>
        <span className={s.notLabel}>What it does not do</span>
        <p className={s.notBody}>{entry.notThis}</p>
      </div>

      {entry.caveat !== undefined && <p className={s.caveat}>{entry.caveat}</p>}

      <a
        className={s.source}
        href={entry.sourceUrl}
        target="_blank"
        rel="noreferrer noopener"
      >
        <span className={s.sourceText}>{entry.sourceLabel}</span>
        <span className={s.sourceArrow} aria-hidden="true">
          ↗
        </span>
      </a>
    </article>
  );
}

export function RecordPage(): ReactNode {
  /* One running number across the whole page, so an entry can be cited as
     "record 14" and stay findable. */
  let counter = 0;

  return (
    <main className={s.page}>
      <section className={s.hero}>
        <div className="wrap">
          <p className={s.eyebrow}>File 00 · The record</p>
          <h1 className={s.title}>
            Private messaging is being legislated against.
            <span className={s.titleDim}> These are the receipts.</span>
          </h1>
          <p className={s.lede}>
            Everything below is a real instrument: a regulation, a statute, a court order, or a
            measured network block. Each entry says what it does, what it does not do, and links to
            the source so you can read it without us in the way.
          </p>
        </div>
      </section>

      <section className={s.method}>
        <div className="wrap">
          <div className={s.methodInner}>
            <h2 className={s.methodTitle}>How to read this</h2>
            <div className={s.methodGrid}>
              <p className={s.methodItem}>
                <strong className={s.methodStrong}>A proposal is not a law.</strong> Four of the
                things most often described as European surveillance law have never been adopted.
                They are marked <em>Proposed</em> and nothing else.
              </p>
              <p className={s.methodItem}>
                <strong className={s.methodStrong}>Most blocks have no order behind them.</strong>{' '}
                Where a government published nothing, the entry says so and cites the network
                measurement instead of pretending there is a document.
              </p>
              <p className={s.methodItem}>
                <strong className={s.methodStrong}>Nothing here compels decryption.</strong> Not one
                instrument on this page has ever produced the contents of an end-to-end encrypted
                message. What they reach is reachability, metadata and identity.
              </p>
            </div>
          </div>
        </div>
      </section>

      {SECTIONS.map((section) => (
        <section className={s.section} key={section.id} id={section.id}>
          <div className="wrap">
            <header className={s.sectionHead}>
              <h2 className={s.sectionTitle}>{section.label}</h2>
              <p className={s.sectionNote}>{section.note}</p>
            </header>
            <div className={s.grid}>
              {section.entries.map((entry) => {
                counter += 1;
                return <EntryCard entry={entry} index={counter} key={entry.id} />;
              })}
            </div>
          </div>
        </section>
      ))}

      <section className={`${s.section} ${s.other}`} id="other-side">
        <div className="wrap">
          <header className={s.sectionHead}>
            <h2 className={s.sectionTitle}>The other side of the record</h2>
            <p className={s.sectionNote}>
              A record that only accuses is a pitch. These two cut the other way, and they belong
              here for the same reason as everything else.
            </p>
          </header>
          <div className={s.grid}>
            {COUNTERWEIGHT.map((entry) => {
              counter += 1;
              return <EntryCard entry={entry} index={counter} key={entry.id} />;
            })}
          </div>
        </div>
      </section>

      <section className={s.close}>
        <div className="wrap">
          <div className={s.closeInner}>
            <p className={s.closeLead}>
              None of this was decided by a company, and none of it can be undone by one.
            </p>
            <p className={s.closeBody}>
              The pattern across every jurisdiction is the same. Nobody has taken the contents of an
              encrypted message. What they take is the ability to reach a service, the record of who
              you spoke to, and the identity you had to show to get in. Which is why the design
              matters more than the promise: a service that never holds your keys has nothing to
              hand over, a service on the open web has no store to be removed from, and a message
              anchored on a public chain has no owner who can quietly delete it.
            </p>
            <p className={s.closeNote}>
              Found something wrong, out of date, or overstated? It should be corrected. The whole
              value of this page is that it survives being checked.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
