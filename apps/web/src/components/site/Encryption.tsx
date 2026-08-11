import type { ReactNode } from 'react';

import { asset } from '@/lib/asset';
import { cx } from '@/lib/cx';
import { MediaLoop } from './MediaLoop';
import s from './Encryption.module.css';

interface Point {
  readonly term: string;
  readonly detail: string;
}

const POINTS: readonly Point[] = [
  {
    term: 'Sealed end-to-end',
    detail:
      'Keys are generated on your device and never leave it. Every message is sealed to the ' +
      'recipient’s registered key before anything touches the network. There is no server-side ' +
      'plaintext, because there is no plaintext anywhere but the two ends.',
  },
  {
    term: 'Padded to a fixed size',
    detail:
      'Every envelope is padded to a fixed size before it ships, so a three-word reply and a ' +
      'three-paragraph confession look identical from the outside. Length is metadata too.',
  },
  {
    term: 'No address on the envelope',
    detail:
      'Recipients find their mail by scanning view tags, a cryptographic “possibly for me”, ' +
      'so no recipient address ever appears on chain. The chain sees sealed envelopes arriving; ' +
      'it never sees for whom.',
  },
  {
    term: 'The relay holds only ciphertext',
    detail:
      'It batches sealed envelopes on chain, pays the gas, and keeps your address off the ' +
      'record. It cannot read a message and it cannot forge your signature. The most it could ' +
      'ever do is refuse to post.',
  },
  {
    term: 'Which is why the exit exists',
    detail:
      'Self-posting on chain is permissionless, costs about a cent, and works forever. If every ' +
      'relay on earth refused you, including ours, your messages still go through. Even we ' +
      'cannot silence you.',
  },
];

/**
 * SECTION 03 — the encryption itself. Text left; the cage loop and the strongest still ride a
 * sticky right rail like plates in a technical file. Stacks to one column below 960px with the
 * media after the text.
 */
export function Encryption(): ReactNode {
  return (
    <section className={s.section} id="seal">
      <div className={cx('wrap', s.inner)}>
        <div className={s.fileRow} data-reveal>
          <span>File 03 · The seal</span>
          <span className={s.fileRule} aria-hidden="true" />
          <span>E2E · padded · unaddressed</span>
        </div>

        <div className={s.cols}>
          <div className={s.text}>
            <h2 className={s.title} data-reveal>
              Sealed on your device. Unreadable everywhere else.
            </h2>

            <dl className={s.list}>
              {POINTS.map((point) => (
                <div className={s.point} data-reveal key={point.term}>
                  <dt className={s.term}>{point.term}</dt>
                  <dd className={s.detail}>{point.detail}</dd>
                </div>
              ))}
            </dl>
          </div>

          <aside className={s.rail}>
            <figure className={s.fig} data-reveal>
              <div className="hairFrame">
                <div className={s.figMedia}>
                  <MediaLoop src={asset('/media/cage.mp4')} poster={asset('/art/cage.png')} />
                </div>
              </div>
              <figcaption className={s.caption}>
                <span className={s.figLabel}>Fig. 01</span> The envelope. Structure visible,
                contents not.
              </figcaption>
            </figure>

            {/* A diptych, not one frame: the argument is a before/after, and two
                panels side by side hold far more detail at this size than one
                wide frame trying to carry both halves. Both loops close on
                their own opening frame, so `loop` alone is seamless. Nothing
                here may add a fade. */}
            <figure className={s.fig} data-reveal>
              <div className={s.plates}>
                <div className={s.plate}>
                  <MediaLoop
                    src={asset('/media/mail-opened.mp4')}
                    poster={asset('/art/mail-opened.jpg')}
                  />
                </div>
                <div className={s.plate}>
                  <MediaLoop
                    src={asset('/media/mail-sealed.mp4')}
                    poster={asset('/art/mail-sealed.jpg')}
                  />
                </div>
              </div>
              <figcaption className={s.caption}>
                <span className={s.figLabel}>Fig. 02</span> What a scanning order needs is
                readable mail. HoodGram never produces any.
              </figcaption>
            </figure>
          </aside>
        </div>
      </div>
    </section>
  );
}
