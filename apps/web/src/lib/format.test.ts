/**
 * Formatting is load-bearing twice over: these strings are rendered on the
 * server and again on the client, so any drift is a hydration mismatch, and the
 * money paths round in `bigint` space precisely so a 1e27-wei figure does not
 * pass through float. Both properties are pinned here.
 */
import { describe, expect, it } from 'vitest';

import {
  SECONDS_PER_DAY,
  SECONDS_PER_MONTH,
  formatBlock,
  formatBps,
  formatBytes,
  formatClock,
  formatCount,
  formatDate,
  formatDateTime,
  formatDuration,
  formatDurationLong,
  formatEth,
  formatFixed,
  formatPercent,
  formatRelativeTime,
  formatShare,
  formatToken,
  formatUsd,
  formatUsd18,
  secondsToDays,
  secondsToMonths,
  secondsUntil,
  splitDuration,
  truncateAddress,
  truncateHex,
  truncateRef,
} from './format';

const WEI = 10n ** 18n;
/** U+2009 — the separator `formatToken` puts before a symbol, not a plain space. */
const THIN = ' ';

describe('fixed-point formatting', () => {
  it('rounds half-up on the bigint, not on a float', () => {
    expect(formatFixed(1_234_567_890_123_456_789n)).toBe('1.2346');
    expect(formatFixed(5n, { decimals: 1, digits: 0 })).toBe('1');
    expect(formatFixed(4n, { decimals: 1, digits: 0 })).toBe('0');
  });

  it('formats a supply far beyond Number.MAX_SAFE_INTEGER exactly', () => {
    expect(formatFixed(1_000_000_000n * WEI, { digits: 0 })).toBe('1,000,000,000');
    expect(formatFixed(123_456_789_012_345_678_901_234_567_890n, { digits: 2 })).toBe(
      '123,456,789,012.35',
    );
  });

  it('pads up when more digits are asked for than the input carries', () => {
    expect(formatFixed(5n, { decimals: 1, digits: 3, trim: false })).toBe('0.500');
  });

  it('keeps the sign off a value that rounds to zero', () => {
    expect(formatFixed(-1n, { decimals: 18, digits: 4 })).toBe('0');
  });
});

describe('token and currency', () => {
  it('appends a symbol after a thin space and trims the fraction', () => {
    expect(formatToken(25n * WEI, { digits: 2, symbol: 'GRAM' })).toBe(`25${THIN}GRAM`);
    expect(formatEth(WEI)).toBe(`1${THIN}ETH`);
  });

  it('collapses to compact units only from 10,000 up', () => {
    expect(formatToken(9_999n * WEI, { compact: true })).toBe('9,999');
    expect(formatToken(12_400n * WEI, { compact: true })).toBe('12.4K');
    expect(formatToken(3_100_000n * WEI, { compact: true })).toBe('3.1M');
    expect(formatToken(1_240_000_000n * WEI, { compact: true })).toBe('1.24B');
    expect(formatToken(-12_400n * WEI, { compact: true })).toBe('-12.4K');
  });

  it('always shows two decimals and a leading $ for on-chain USD', () => {
    expect(formatUsd18(1_234_500_000_000_000_000n)).toBe('$1.23');
    expect(formatUsd18(5n * WEI)).toBe('$5.00');
    expect(formatUsd18(-5n * WEI)).toBe('-$5.00');
  });

  it('degrades non-finite input to a dash instead of NaN', () => {
    expect(formatUsd(Number.NaN)).toBe('$—');
    expect(formatCount(Number.POSITIVE_INFINITY)).toBe('—');
    expect(formatBps(Number.NaN)).toBe('—');
    expect(formatPercent(Number.NaN)).toBe('—');
    expect(formatBytes(-1)).toBe('—');
  });

  it('converts bps and ratios', () => {
    expect(formatBps(5000)).toBe('50%');
    expect(formatBps(1234, 2)).toBe('12.34%');
    expect(formatPercent(0.1834)).toBe('18.34%');
  });

  it('computes a share in bigint space', () => {
    expect(formatShare(1n, 3n)).toBe('33.3333%');
    expect(formatShare(1n, 0n)).toBe('0%');
    expect(formatShare(10n ** 27n, 4n * 10n ** 27n)).toBe('25%');
  });

  it('labels padded envelope buckets', () => {
    expect(formatBytes(256)).toBe('256 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(16 * 1024)).toBe('16.0 KB');
    expect(formatBytes(4 * 1024 * 1024)).toBe('4.0 MB');
  });

  it('reads a block height as a height', () => {
    expect(formatBlock(12_884_901)).toBe('#12,884,901');
  });
});

describe('hex truncation', () => {
  it('truncates only when there is something to truncate', () => {
    expect(truncateHex('0xdeadbeef')).toBe('0xdeadbeef');
    expect(truncateAddress(`0x${'1'.repeat(40)}`)).toBe('0x111111…1111');
    expect(truncateRef(`0x${'a'.repeat(64)}`)).toBe('0xaaaaaaaa…aaaaaa');
  });

  it('passes non-hex through untouched', () => {
    expect(truncateHex('hoodgram.eth')).toBe('hoodgram.eth');
  });
});

describe('durations', () => {
  it('splits a second count into fields', () => {
    expect(splitDuration(90_061)).toMatchObject({
      negative: false,
      days: 1,
      hours: 1,
      minutes: 1,
      seconds: 1,
    });
    expect(splitDuration(-5)).toMatchObject({ negative: true, totalSeconds: 5 });
  });

  it('is fixed width so a countdown never reflows', () => {
    expect(formatDuration(90_061)).toBe('1d 01h 01m');
    expect(formatDuration(3661)).toBe('01h 01m 01s');
    expect(formatDuration(61)).toBe('01m 01s');
    expect(formatDuration(90_061, { style: 'clock' })).toBe('1:01:01');
    expect(formatDuration(3661, { style: 'clock' })).toBe('01:01:01');
  });

  it('collapses a spent or negative duration to one label', () => {
    expect(formatDuration(0)).toBe('expired');
    expect(formatDuration(-1)).toBe('expired');
    expect(formatDuration(0, { zeroLabel: 'lapsed' })).toBe('lapsed');
    expect(formatDurationLong(0)).toBe('no time remaining');
  });

  it('says the largest whole unit in prose', () => {
    expect(formatDurationLong(2 * SECONDS_PER_DAY)).toBe('2 days');
    expect(formatDurationLong(SECONDS_PER_DAY)).toBe('1 day');
    expect(formatDurationLong(3600)).toBe('1 hour');
    expect(formatDurationLong(120)).toBe('2 minutes');
    expect(formatDurationLong(1)).toBe('1 second');
  });

  it('never counts a subscription down past zero', () => {
    expect(secondsUntil(1000, 500_000)).toBe(500);
    expect(secondsUntil(1000, 2_000_000)).toBe(0);
  });

  it('expresses purchased seconds in months and days', () => {
    expect(secondsToMonths(SECONDS_PER_MONTH)).toBe('1');
    expect(secondsToMonths(1.8 * SECONDS_PER_MONTH)).toBe('1.8');
    expect(secondsToMonths(0)).toBe('0');
    expect(secondsToDays(18 * SECONDS_PER_DAY)).toBe('18');
    expect(secondsToDays(1.5 * SECONDS_PER_DAY)).toBe('1.5');
  });
});

describe('timestamps', () => {
  const NOW_MS = 1_700_000_000_000;

  it('treats a small number as seconds and a large one as milliseconds', () => {
    expect(formatClock(1_700_000_000)).toBe('22:13:20');
    expect(formatClock(NOW_MS)).toBe('22:13:20');
    expect(formatClock(new Date(NOW_MS))).toBe('22:13:20');
  });

  it('renders relative time in the unit that fits', () => {
    expect(formatRelativeTime(NOW_MS - 2_000, NOW_MS)).toBe('now');
    expect(formatRelativeTime(NOW_MS - 12_000, NOW_MS)).toBe('12s ago');
    expect(formatRelativeTime(NOW_MS - 4 * 60_000, NOW_MS)).toBe('4m ago');
    expect(formatRelativeTime(NOW_MS - 3 * 3_600_000, NOW_MS)).toBe('3h ago');
    expect(formatRelativeTime(NOW_MS - 6 * 86_400_000, NOW_MS)).toBe('6d ago');
    expect(formatRelativeTime(NOW_MS + 30_000, NOW_MS)).toBe('in 30s');
  });

  it('falls back to an absolute UTC date beyond a month', () => {
    expect(formatRelativeTime(NOW_MS - 40 * 86_400_000, NOW_MS)).toBe(
      formatDate(NOW_MS - 40 * 86_400_000),
    );
    expect(formatDate(NOW_MS)).toMatch(/^Nov 14, 2023$/);
    expect(formatDateTime(NOW_MS)).toMatch(/^Nov 14, 2023,? 22:13 UTC$/);
  });

  it('degrades an unusable timestamp instead of printing "Invalid Date"', () => {
    expect(formatDateTime(Number.NaN)).toBe('—');
    expect(formatDate(Number.NaN)).toBe('—');
    expect(formatClock(Number.NaN)).toBe('--:--:--');
    expect(formatRelativeTime(Number.NaN, NOW_MS)).toBe('—');
  });
});
