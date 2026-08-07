/**
 * Formatting for the Signals Desk.
 *
 * Every number this app shows is tabular, grouped, and locale-pinned to
 * `en-US` / `UTC`. Locale-pinning is not cosmetic: it is what keeps the
 * server-rendered string byte-identical to the client-rendered one, so numbers
 * never cause a hydration mismatch.
 *
 * Rounding is done on `bigint` before any conversion to `number`, so a
 * 1e27-wei balance formats exactly rather than through float precision.
 */

const GROUP = new Intl.NumberFormat('en-US', { useGrouping: true });

const DATE_TIME = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'UTC',
});

const DATE_ONLY = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  timeZone: 'UTC',
});

export const SECONDS_PER_MINUTE = 60;
export const SECONDS_PER_HOUR = 3600;
export const SECONDS_PER_DAY = 86_400;
/** `Subscription.MONTH` — 30 days, exactly as the contract defines it. */
export const SECONDS_PER_MONTH = 30 * SECONDS_PER_DAY;

/* ─────────────────────────────────────────────────── fixed-point core ───── */

interface Split {
  readonly negative: boolean;
  readonly int: bigint;
  readonly frac: string;
}

function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

/**
 * Round `value` (a fixed-point integer with `decimals` places) to `digits`
 * fractional digits, half-up, entirely in bigint space.
 */
function splitFixed(value: bigint, decimals: number, digits: number): Split {
  const negative = value < 0n;
  let v = negative ? -value : value;

  if (digits < decimals) {
    const divisor = pow10(decimals - digits);
    const remainder = v % divisor;
    v /= divisor;
    if (remainder * 2n >= divisor) v += 1n;
  } else if (digits > decimals) {
    v *= pow10(digits - decimals);
  }

  const scale = pow10(digits);
  const int = v / scale;
  const frac = digits === 0 ? '' : (v % scale).toString().padStart(digits, '0');
  return { negative, int, frac };
}

function assemble(split: Split, opts: { trim: boolean; group: boolean }): string {
  const head = opts.group ? GROUP.format(split.int) : split.int.toString();
  let frac = split.frac;
  if (opts.trim) frac = frac.replace(/0+$/, '');
  const body = frac === '' ? head : `${head}.${frac}`;
  return split.negative && (split.int !== 0n || frac !== '') ? `-${body}` : body;
}

export interface FixedFormatOptions {
  /** Fixed-point places in the input. Default 18. */
  readonly decimals?: number;
  /** Fractional digits to show. Default 4. */
  readonly digits?: number;
  /** Strip trailing zeros from the fraction. Default `true`. */
  readonly trim?: boolean;
  /** Thousands separators. Default `true`. */
  readonly group?: boolean;
}

/** Exact fixed-point → display string. The primitive every other helper uses. */
export function formatFixed(value: bigint, options: FixedFormatOptions = {}): string {
  const decimals = options.decimals ?? 18;
  const digits = options.digits ?? 4;
  return assemble(splitFixed(value, decimals, digits), {
    trim: options.trim ?? true,
    group: options.group ?? true,
  });
}

/* ────────────────────────────────────────────────────────────── token ───── */

export interface TokenFormatOptions extends FixedFormatOptions {
  /** Appended after a hair space, e.g. `GRAM`. */
  readonly symbol?: string;
  /** Collapse ≥ 10,000 to `12.4K` / `3.10M` / `1.24B`. Default `false`. */
  readonly compact?: boolean;
}

const COMPACT_STEPS = [
  { limit: 1_000_000_000_000n, suffix: 'T' },
  { limit: 1_000_000_000n, suffix: 'B' },
  { limit: 1_000_000n, suffix: 'M' },
  { limit: 10_000n, suffix: 'K' },
] as const;

function formatCompactWhole(int: bigint, negative: boolean): string | null {
  const abs = int < 0n ? -int : int;
  for (const step of COMPACT_STEPS) {
    if (abs < step.limit) continue;
    const unit = step.suffix === 'K' ? 1_000n : step.limit;
    const scaled = (abs * 100n) / unit;
    const whole = scaled / 100n;
    const frac = (scaled % 100n).toString().padStart(2, '0').replace(/0+$/, '');
    const body = frac === '' ? whole.toString() : `${whole}.${frac}`;
    return `${negative ? '-' : ''}${body}${step.suffix}`;
  }
  return null;
}

/**
 * $GRAM / any 18-decimal ERC20 amount.
 *
 * @example formatToken(1234567890123456789n) // "1.2346"
 * @example formatToken(25n * 10n ** 18n, { digits: 2, symbol: 'GRAM' }) // "25 GRAM"
 */
export function formatToken(value: bigint, options: TokenFormatOptions = {}): string {
  const decimals = options.decimals ?? 18;
  const digits = options.digits ?? 4;
  const split = splitFixed(value, decimals, digits);

  let body: string;
  if (options.compact === true) {
    body =
      formatCompactWhole(split.int, split.negative) ??
      assemble(split, { trim: options.trim ?? true, group: options.group ?? true });
  } else {
    body = assemble(split, {
      trim: options.trim ?? true,
      group: options.group ?? true,
    });
  }

  return options.symbol === undefined ? body : `${body} ${options.symbol}`;
}

/** Native ETH, 4 dp by default — gas figures stay readable. */
export function formatEth(value: bigint, digits = 4): string {
  return formatToken(value, { digits, symbol: 'ETH' });
}

/**
 * USD held on-chain as an 18-decimal integer (`priceUsdPerMonth`, `costUsd`).
 * Always two decimals, always a leading `$`.
 */
export function formatUsd18(value: bigint, digits = 2): string {
  const split = splitFixed(value, 18, digits);
  const body = assemble(split, { trim: false, group: true });
  return body.startsWith('-') ? `-$${body.slice(1)}` : `$${body}`;
}

/** USD already in JS number space (a price, a rate). */
export function formatUsd(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '$—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/** Grouped integer: `1,284,003`. Accepts bigint so counters never lose bits. */
export function formatCount(value: bigint | number): string {
  if (typeof value === 'number' && !Number.isFinite(value)) return '—';
  return GROUP.format(value);
}

/** Basis points → percent: `5000` → `50%`. */
export function formatBps(bps: bigint | number, digits = 0): string {
  const n = typeof bps === 'bigint' ? Number(bps) : bps;
  if (!Number.isFinite(n)) return '—';
  return `${(n / 100).toFixed(digits)}%`;
}

/** Ratio → percent: `0.1834` → `18.34%`. */
export function formatPercent(ratio: number, digits = 2): string {
  if (!Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

/**
 * Numerator/denominator share as a percent, computed in bigint to avoid
 * overflow on 1e27-scale supplies.
 */
export function formatShare(part: bigint, whole: bigint, digits = 4): string {
  if (whole === 0n) return '0%';
  const scaled = (part * pow10(digits + 2)) / whole;
  return `${formatFixed(scaled, { decimals: digits, digits, trim: true })}%`;
}

/** Padded envelope sizes: `256 B`, `1.0 KB`, `16.0 KB`. */
export function formatBytes(bytes: number | bigint): string {
  const n = typeof bytes === 'bigint' ? Number(bytes) : bytes;
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Block heights read as heights, not quantities: `#12,884,901`. */
export function formatBlock(block: bigint | number): string {
  return `#${GROUP.format(block)}`;
}

/* ───────────────────────────────────────────────────────────── hex/id ───── */

const HEX_RE = /^0x[0-9a-fA-F]*$/;

/**
 * `0x1234…cdef`. Never widens its container: pair with `text-overflow` only
 * when you want the *fallback*; this is the deterministic truncation.
 */
export function truncateHex(value: string, lead = 6, tail = 4): string {
  if (!HEX_RE.test(value)) return value;
  const body = value.slice(2);
  if (body.length <= lead + tail) return value;
  return `0x${body.slice(0, lead)}…${body.slice(body.length - tail)}`;
}

/** Addresses: `0x1a2b3c…9f8e`. */
export function truncateAddress(address: string): string {
  return truncateHex(address, 6, 4);
}

/** 32-byte refs (blobRef, convoId, ephPub): a little more head, still compact. */
export function truncateRef(ref: string): string {
  return truncateHex(ref, 8, 6);
}

/* ─────────────────────────────────────────────────────────────── time ───── */

export interface DurationParts {
  readonly negative: boolean;
  readonly days: number;
  readonly hours: number;
  readonly minutes: number;
  readonly seconds: number;
  readonly totalSeconds: number;
}

/** Break a second count into days/hours/minutes/seconds. */
export function splitDuration(seconds: number | bigint): DurationParts {
  const raw = typeof seconds === 'bigint' ? Number(seconds) : seconds;
  const safe = Number.isFinite(raw) ? Math.trunc(raw) : 0;
  const negative = safe < 0;
  const abs = Math.abs(safe);
  return {
    negative,
    days: Math.floor(abs / SECONDS_PER_DAY),
    hours: Math.floor((abs % SECONDS_PER_DAY) / SECONDS_PER_HOUR),
    minutes: Math.floor((abs % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE),
    seconds: abs % SECONDS_PER_MINUTE,
    totalSeconds: abs,
  };
}

const pad2 = (n: number): string => n.toString().padStart(2, '0');

export interface DurationFormatOptions {
  /** Include the seconds field. Default `false` above one day. */
  readonly showSeconds?: boolean;
  /** `'short'` → `24d 06h 12m`; `'clock'` → `24:06:12`. Default `'short'`. */
  readonly style?: 'short' | 'clock';
  /** Shown when the duration is zero or negative. Default `'expired'`. */
  readonly zeroLabel?: string;
}

/**
 * Expiry countdowns. Fixed-width by construction — every field is zero-padded,
 * so the string never reflows as it ticks.
 */
export function formatDuration(
  seconds: number | bigint,
  options: DurationFormatOptions = {},
): string {
  const parts = splitDuration(seconds);
  if (parts.totalSeconds <= 0 || parts.negative) return options.zeroLabel ?? 'expired';

  const showSeconds = options.showSeconds ?? parts.days === 0;

  if (options.style === 'clock') {
    const head = parts.days > 0 ? `${parts.days}:` : '';
    return showSeconds
      ? `${head}${pad2(parts.hours)}:${pad2(parts.minutes)}:${pad2(parts.seconds)}`
      : `${head}${pad2(parts.hours)}:${pad2(parts.minutes)}`;
  }

  const out: string[] = [];
  if (parts.days > 0) out.push(`${parts.days}d`);
  if (parts.days > 0 || parts.hours > 0) out.push(`${pad2(parts.hours)}h`);
  out.push(`${pad2(parts.minutes)}m`);
  if (showSeconds) out.push(`${pad2(parts.seconds)}s`);
  return out.join(' ');
}

/** `30 days` / `1 day` / `18 hours` — prose form, for explanatory copy. */
export function formatDurationLong(seconds: number | bigint): string {
  const parts = splitDuration(seconds);
  if (parts.totalSeconds <= 0 || parts.negative) return 'no time remaining';
  if (parts.days >= 1) return `${parts.days} ${parts.days === 1 ? 'day' : 'days'}`;
  if (parts.hours >= 1) return `${parts.hours} ${parts.hours === 1 ? 'hour' : 'hours'}`;
  if (parts.minutes >= 1) {
    return `${parts.minutes} ${parts.minutes === 1 ? 'minute' : 'minutes'}`;
  }
  return `${parts.seconds} ${parts.seconds === 1 ? 'second' : 'seconds'}`;
}

/**
 * Remaining seconds against a subscription expiry, in *seconds* (the contract's
 * unit). Never negative.
 */
export function secondsUntil(expiresAt: bigint | number, nowMs = Date.now()): number {
  const target = typeof expiresAt === 'bigint' ? Number(expiresAt) : expiresAt;
  if (!Number.isFinite(target)) return 0;
  return Math.max(0, Math.floor(target - nowMs / 1000));
}

/** Carried/purchased seconds expressed in months, e.g. `1.8` months. */
export function secondsToMonths(seconds: number | bigint, digits = 1): string {
  const raw = typeof seconds === 'bigint' ? Number(seconds) : seconds;
  if (!Number.isFinite(raw) || raw <= 0) return '0';
  return (raw / SECONDS_PER_MONTH).toFixed(digits).replace(/\.0+$/, '');
}

/** Carried/purchased seconds expressed in days, e.g. `18` days. */
export function secondsToDays(seconds: number | bigint, digits = 1): string {
  const raw = typeof seconds === 'bigint' ? Number(seconds) : seconds;
  if (!Number.isFinite(raw) || raw <= 0) return '0';
  const days = raw / SECONDS_PER_DAY;
  return days >= 10 ? Math.round(days).toString() : days.toFixed(digits).replace(/\.0+$/, '');
}

function toMillis(input: number | bigint | Date): number {
  if (input instanceof Date) return input.getTime();
  const n = typeof input === 'bigint' ? Number(input) : input;
  if (!Number.isFinite(n)) return Number.NaN;
  // Anything below ~Sep 2001 in ms is unambiguously a seconds timestamp.
  return n < 1e12 ? n * 1000 : n;
}

const RELATIVE_STEPS = [
  { limit: 60, unit: 's', per: 1 },
  { limit: 3600, unit: 'm', per: 60 },
  { limit: 86_400, unit: 'h', per: 3600 },
  { limit: 30 * 86_400, unit: 'd', per: 86_400 },
] as const;

/**
 * `now`, `12s ago`, `4m ago`, `3h ago`, `6d ago`, then an absolute UTC date.
 *
 * Depends on wall-clock time, so render it on the client (or pass a stable
 * `nowMs`) if the surrounding markup is server-rendered.
 */
export function formatRelativeTime(
  input: number | bigint | Date,
  nowMs = Date.now(),
): string {
  const ms = toMillis(input);
  if (Number.isNaN(ms)) return '—';

  const deltaSeconds = Math.round((nowMs - ms) / 1000);
  const future = deltaSeconds < 0;
  const abs = Math.abs(deltaSeconds);

  if (abs < 5) return 'now';

  for (const step of RELATIVE_STEPS) {
    if (abs >= step.limit) continue;
    const value = Math.floor(abs / step.per);
    return future ? `in ${value}${step.unit}` : `${value}${step.unit} ago`;
  }

  return DATE_ONLY.format(new Date(ms));
}

/** Absolute timestamp, pinned to UTC so it is identical on every machine. */
export function formatDateTime(input: number | bigint | Date): string {
  const ms = toMillis(input);
  if (Number.isNaN(ms)) return '—';
  return `${DATE_TIME.format(new Date(ms))} UTC`;
}

/** Absolute date without the time-of-day. */
export function formatDate(input: number | bigint | Date): string {
  const ms = toMillis(input);
  if (Number.isNaN(ms)) return '—';
  return DATE_ONLY.format(new Date(ms));
}

/** Fixed-width `HH:MM:SS` UTC clock, for stream rows. */
export function formatClock(input: number | bigint | Date): string {
  const ms = toMillis(input);
  if (Number.isNaN(ms)) return '--:--:--';
  const d = new Date(ms);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}
