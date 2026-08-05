/**
 * Deterministic stand-in anchors for the hero stream.
 *
 * The relay is a separate process and is frequently not running — a marketing
 * page that renders an empty box in that case is worse than useless. So the
 * stream falls back to a simulated feed, and the UI labels it **demo stream**
 * every single time it is showing one. Nothing here is ever presented as real
 * chain data.
 *
 * The generator is seeded, so the first frame is byte-identical on the server
 * and on the client: no hydration mismatch, and no empty flash before the
 * relay probe resolves.
 */

import type { DropRow } from '@/lib/relay';

/** Padded plaintext buckets — SPEC §5, `BUCKETS`. */
export const BUCKETS = [256, 1024, 4096, 16384] as const;

/**
 * Weighted so the feed looks like real conversation: most messages are short,
 * and every short message still pads up to a full 256-byte envelope.
 */
const BUCKET_DRAW: readonly number[] = [256, 256, 256, 256, 1024, 1024, 4096, 16384];

export interface StreamRow {
  /** Stable React key. Real rows use their sequence number, demo rows a counter. */
  readonly id: string;
  readonly seq: number;
  readonly blobRef: string;
  /** One byte, 0–255. */
  readonly viewTag: number;
  /** Padded bucket size in bytes. */
  readonly size: number;
  readonly blockNumber: number;
  /**
   * Arrived after first paint. Drives the one-shot green flash; rows present on
   * the initial render must not all flash at once.
   */
  readonly fresh: boolean;
}

/** Rows kept on screen. Older ones fall off the bottom of the column. */
export const MAX_STREAM_ROWS = 20;

/* ──────────────────────────────────────────────────────────────── prng ───── */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const HEX_DIGITS = '0123456789abcdef';

function randomHex(rand: () => number, bytes: number): string {
  let out = '0x';
  for (let i = 0; i < bytes * 2; i += 1) {
    out += HEX_DIGITS[Math.floor(rand() * 16)] ?? '0';
  }
  return out;
}

function pick<T>(rand: () => number, values: readonly T[], fallback: T): T {
  if (values.length === 0) return fallback;
  return values[Math.floor(rand() * values.length)] ?? fallback;
}

/* ───────────────────────────────────────────────────────────── generator ─── */

export interface DemoStream {
  /** Next simulated anchor. `fresh` controls the arrival flash. */
  next: (fresh: boolean) => StreamRow;
  /** Milliseconds to wait before the next one, jittered like real traffic. */
  gap: () => number;
}

export interface DemoSeed {
  readonly demo: DemoStream;
  /** Newest first, matching the rendered order. */
  readonly rows: readonly StreamRow[];
}

/** Arbitrary but fixed, so every render of the page starts from the same feed. */
const SEED = 0x48_54_58_54;
const START_SEQ = 48_211;
const START_BLOCK = 8_140_662;

function createDemoStream(): DemoStream {
  const rand = mulberry32(SEED);
  let seq = START_SEQ;
  let block = START_BLOCK;

  return {
    next: (fresh: boolean): StreamRow => {
      seq += 1;
      block += 1 + Math.floor(rand() * 3);
      return {
        id: `demo-${seq}`,
        seq,
        blobRef: randomHex(rand, 32),
        viewTag: Math.floor(rand() * 256),
        size: pick(rand, BUCKET_DRAW, 256),
        blockNumber: block,
        fresh,
      };
    },
    gap: (): number => 900 + Math.floor(rand() * 1700),
  };
}

/**
 * A generator plus the rows it has already produced. Both come from one call so
 * the sequence never repeats itself when the ticker takes over.
 */
export function makeDemoSeed(count: number = MAX_STREAM_ROWS): DemoSeed {
  const demo = createDemoStream();
  const rows: StreamRow[] = [];
  for (let i = 0; i < count; i += 1) rows.unshift(demo.next(false));
  return { demo, rows };
}

/* ───────────────────────────────────────────────────────────── adapters ──── */

/** Project a relay row onto what the stream actually displays. */
export function toStreamRow(drop: DropRow, fresh: boolean): StreamRow {
  return {
    id: `drop-${drop.seq}-${drop.blobRef}`,
    seq: drop.seq,
    blobRef: drop.blobRef,
    viewTag: drop.viewTag,
    size: drop.size,
    blockNumber: drop.blockNumber,
    fresh,
  };
}

/** `0x7f` — the one-byte scan filter, always two digits. */
export function formatViewTag(tag: number): string {
  const byte = Number.isFinite(tag) ? Math.abs(Math.trunc(tag)) % 256 : 0;
  return `0x${byte.toString(16).padStart(2, '0')}`;
}
