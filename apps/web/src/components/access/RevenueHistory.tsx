'use client';

/**
 * The revenue history strip — a hairline sparkline drawn in code.
 *
 * No chart library: the geometry is computed from `RevenueReceived` logs and
 * emitted as one SVG path. The line is a staircase because revenue *is* a
 * staircase — it steps once per payment and is flat in between. Drawing it as a
 * smooth curve would invent data that does not exist.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefCallback,
} from 'react';

import { cx } from '@/lib/cx';
import { formatBlock, formatCount, formatDate, formatToken } from '@/lib/format';
import { Eyebrow, Panel, PanelHeader } from '@/components/ui';
import { EmptyState, Notice } from './Notice';
import type { RevenueEntry, RevenueHistoryResult } from './use-access-data';
import s from './RevenueHistory.module.css';

const HEIGHT = 96;
const PAD_TOP = 10;
const PAD_BOTTOM = 16;
const TICK = 5;

export interface RevenueHistoryProps {
  readonly history: RevenueHistoryResult;
}

function px(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Content-box width, matching what `ResizeObserver` reports.
 *
 * `getBoundingClientRect()` is the *border* box. The plot is padded, so
 * measuring it directly would size the first frame's SVG ~32px too wide and
 * scale the whole staircase until the observer corrected it.
 */
function contentWidth(node: HTMLElement): number {
  const rect = node.getBoundingClientRect();
  const style = getComputedStyle(node);
  const inset =
    px(style.paddingLeft) +
    px(style.paddingRight) +
    px(style.borderLeftWidth) +
    px(style.borderRightWidth);
  return Math.max(0, Math.round(rect.width - inset));
}

/** Element content width in CSS pixels, kept live by a `ResizeObserver`. */
function useMeasuredWidth<T extends HTMLElement>(): readonly [RefCallback<T>, number] {
  const [width, setWidth] = useState(0);
  const observerRef = useRef<ResizeObserver | null>(null);

  const ref = useCallback<RefCallback<T>>((node) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (node === null) return;

    setWidth(contentWidth(node));
    if (typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(node);
    observerRef.current = observer;
  }, []);

  useEffect(
    () => () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    },
    [],
  );

  return [ref, width];
}

interface Geometry {
  readonly path: string;
  readonly ticks: readonly number[];
  readonly lastX: number;
  readonly lastY: number;
}

function buildGeometry(
  entries: readonly RevenueEntry[],
  width: number,
  total: bigint,
): Geometry | null {
  if (entries.length === 0 || width <= 0 || total <= 0n) return null;

  const first = entries[0];
  const last = entries[entries.length - 1];
  if (first === undefined || last === undefined) return null;

  const plotHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const baseline = HEIGHT - PAD_BOTTOM;
  const span = last.blockNumber - first.blockNumber;

  /* Ratios are computed in bigint at 1e6 precision, so a 1e27-wei total never
     loses its smaller payments to float rounding. */
  const yFor = (cumulative: bigint): number => {
    const ratio = Number((cumulative * 1_000_000n) / total) / 1_000_000;
    return baseline - ratio * plotHeight;
  };

  const xFor = (entry: RevenueEntry, index: number): number => {
    if (span <= 0n) {
      return entries.length === 1
        ? width
        : (index / (entries.length - 1)) * width;
    }
    const offset = Number(((entry.blockNumber - first.blockNumber) * 1_000_000n) / span);
    return (offset / 1_000_000) * width;
  };

  const ticks: number[] = [];
  let cumulative = 0n;
  let path = `M 0 ${baseline.toFixed(2)}`;

  entries.forEach((entry, index) => {
    const x = xFor(entry, index);
    path += ` L ${x.toFixed(2)} ${yFor(cumulative).toFixed(2)}`;
    cumulative += entry.amount;
    path += ` L ${x.toFixed(2)} ${yFor(cumulative).toFixed(2)}`;
    ticks.push(x);
  });

  const lastX = ticks[ticks.length - 1] ?? width;
  const lastY = yFor(cumulative);
  path += ` L ${width.toFixed(2)} ${lastY.toFixed(2)}`;

  return { path, ticks, lastX, lastY };
}

export function RevenueHistory({ history }: RevenueHistoryProps): ReactNode {
  const [plotRef, width] = useMeasuredWidth<HTMLDivElement>();
  const data = history.data;

  const geometry = useMemo(
    () =>
      data === undefined ? null : buildGeometry(data.entries, width, data.total),
    [data, width],
  );

  const first = data?.entries[0];
  const last = data === undefined ? undefined : data.entries[data.entries.length - 1];

  return (
    <Panel as="section" tone="raised" notch="tr" className={s.panel}>
      <PanelHeader
        label="Revenue history"
        note="RevenueReceived, read from the chain"
        aside={
          data === undefined ? undefined : (
            <span className={s.headTotal}>
              {formatToken(data.total, { digits: 2, symbol: 'THOOD' })}
            </span>
          )
        }
      />

      {history.isError ? (
        <div className={s.pad}>
          <Notice
            tone="warn"
            title="Log scan failed"
            body="The RPC endpoint refused the RevenueReceived query, so no history can be drawn. Per-epoch amounts are read from contract state and remain correct."
          />
        </div>
      ) : data === undefined ? (
        <div className={s.pad}>
          <div className={s.skeleton} aria-hidden="true">
            <span className={s.skeletonLine} />
          </div>
          <span className={s.skeletonNote}>Reading the chain…</span>
        </div>
      ) : data.entries.length === 0 ? (
        <EmptyState
          eyebrow="No revenue yet"
          title="Nothing has been paid in"
          body="The first payment lands here the moment it clears — a $5 activation or a room's rent, 50% banked for holders, 50% for the treasury, split at the instant it arrives."
        />
      ) : (
        <>
          <div className={s.plot} ref={plotRef}>
            {width > 0 && geometry !== null && (
              <svg
                className={s.svg}
                width={width}
                height={HEIGHT}
                viewBox={`0 0 ${width} ${HEIGHT}`}
                role="img"
                aria-label={`Cumulative revenue across ${formatCount(
                  data.entries.length,
                )} payments, totalling ${formatToken(data.total, { digits: 2, symbol: 'THOOD' })}`}
              >
                {/* baseline */}
                <line
                  className={s.axis}
                  x1={0}
                  y1={HEIGHT - PAD_BOTTOM}
                  x2={width}
                  y2={HEIGHT - PAD_BOTTOM}
                />

                {/* one tick per payment */}
                {geometry.ticks.map((x, index) => (
                  <line
                    key={`${x}-${index}`}
                    className={s.tick}
                    x1={x}
                    y1={HEIGHT - PAD_BOTTOM}
                    x2={x}
                    y2={HEIGHT - PAD_BOTTOM + TICK}
                  />
                ))}

                {/* the staircase */}
                <path className={s.line} d={geometry.path} pathLength={1} />

                {/* the confirmed peak — the one green mark on this panel */}
                <rect
                  className={s.peak}
                  x={Math.min(geometry.lastX, width - 3) - 1.5}
                  y={geometry.lastY - 1.5}
                  width={3}
                  height={3}
                />
              </svg>
            )}
          </div>

          <div className={s.legend}>
            <div className={s.legendItem}>
              <Eyebrow size="micro">From</Eyebrow>
              <span className={s.legendValue}>
                {first === undefined ? '—' : formatBlock(first.blockNumber)}
              </span>
              <span className={s.legendNote}>
                {data.firstAt === null ? 'block' : formatDate(data.firstAt)}
              </span>
            </div>

            <div className={s.legendItem}>
              <Eyebrow size="micro">Payments</Eyebrow>
              <span className={s.legendValue}>{formatCount(data.entries.length)}</span>
              <span className={s.legendNote}>activations and room rents</span>
            </div>

            <div className={s.legendItem}>
              <Eyebrow size="micro">To holders</Eyebrow>
              <span className={cx(s.legendValue, s.legendStrong)}>
                {formatToken(data.toHolders, { digits: 2 })}
              </span>
              <span className={s.legendNote}>THOOD, half of the total</span>
            </div>

            <div className={s.legendItem}>
              <Eyebrow size="micro">To</Eyebrow>
              <span className={s.legendValue}>
                {last === undefined ? '—' : formatBlock(last.blockNumber)}
              </span>
              <span className={s.legendNote}>
                {data.lastAt === null ? 'block' : formatDate(data.lastAt)}
              </span>
            </div>
          </div>

          {data.partial && (
            <div className={s.pad}>
              <Notice
                tone="info"
                title="Bounded scan"
                body={`This endpoint limits log queries, so the strip covers blocks ${formatCount(data.scannedFrom)}–${formatCount(data.scannedTo)}. Anything earlier is not drawn.`}
              />
            </div>
          )}
        </>
      )}
    </Panel>
  );
}
