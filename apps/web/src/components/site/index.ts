/**
 * Sections of the marketing page (`/`), in the order they appear.
 *
 * Everything here is composed from `@/components/ui` and the tokens in
 * `globals.css` — no second design system, no icon set, no illustration.
 */

export { RevealRoot } from './RevealRoot';
export type { RevealRootProps } from './RevealRoot';

export { SectionHead } from './SectionHead';
export type { SectionHeadProps } from './SectionHead';

export { AnchorLink } from './AnchorLink';
export type { AnchorLinkProps } from './AnchorLink';

export { TokenMark } from './TokenMark';
export type { TokenMarkProps } from './TokenMark';

export { Hero } from './Hero';
export { DropStream } from './DropStream';
export { Pricing } from './Pricing';
export { HowItWorks } from './HowItWorks';
export { NoiseFloor } from './NoiseFloor';
export { RevenueShare } from './RevenueShare';
export { PerksLadder } from './PerksLadder';
export { LiveStats } from './LiveStats';
export { Faq } from './Faq';
export { SiteFooter } from './SiteFooter';

export {
  BUCKETS,
  MAX_STREAM_ROWS,
  formatViewTag,
  makeDemoSeed,
  toStreamRow,
} from './demo-stream';
export type { DemoSeed, DemoStream, StreamRow } from './demo-stream';
