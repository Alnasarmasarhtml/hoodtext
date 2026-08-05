'use client';

import { useEffect, useRef, type ReactNode } from 'react';

import s from './SignalField.module.css';

/**
 * The ambient layer that makes the whole site feel alive.
 *
 * A single fixed 2D canvas behind everything — no WebGL, no video, no library. Two things move on
 * it, both extremely quiet:
 *
 *   1. Four large radial glows drifting along mutually-prime Lissajous paths, so the field never
 *      visibly repeats. These carry the "breathing" quality behind every section.
 *   2. Falling hex columns — the CRT footage from the hero, rewritten as live type. Hex because
 *      that is honestly what a blobRef looks like.
 *
 * Cost control: capped at 30fps, DPR pinned to 1, the glow layer rendered into a bitmap 8x smaller
 * and regenerated every 6th frame, stopped entirely when the tab is hidden, and frozen to a single
 * static frame under `prefers-reduced-motion`.
 */

const GLYPHS = '0123456789abcdef';
const FRAME_MS = 1000 / 30;

interface Glow {
  readonly hue: string;
  readonly radius: number;
  readonly ax: number;
  readonly ay: number;
  readonly fx: number;
  readonly fy: number;
  readonly px: number;
  readonly py: number;
}

/* Mutually-prime-ish frequencies keep the four paths from ever syncing up. */
const GLOWS: readonly Glow[] = [
  { hue: 'rgba(0, 200, 5, 0.16)', radius: 0.62, ax: 0.30, ay: 0.20, fx: 0.026, fy: 0.038, px: 0.0, py: 1.7 },
  { hue: 'rgba(0, 200, 5, 0.11)', radius: 0.48, ax: 0.36, ay: 0.26, fx: 0.019, fy: 0.031, px: 2.1, py: 0.4 },
  { hue: 'rgba(0, 200, 5, 0.07)', radius: 0.80, ax: 0.22, ay: 0.30, fx: 0.013, fy: 0.022, px: 4.3, py: 3.1 },
  { hue: 'rgba(143, 163, 176, 0.055)', radius: 0.40, ax: 0.34, ay: 0.22, fx: 0.034, fy: 0.016, px: 1.2, py: 5.0 },
];

interface Column {
  x: number;
  y: number;
  speed: number;
  len: number;
  alpha: number;
  chars: string[];
}

function makeColumns(width: number, height: number, rand: () => number): Column[] {
  /* Roughly one column per 150px of width — dense enough to register, sparse
     enough that it never reads as "the Matrix effect". */
  const count = Math.max(10, Math.round(width / 78));
  const out: Column[] = [];
  for (let i = 0; i < count; i += 1) {
    const len = 8 + Math.floor(rand() * 18);
    const chars: string[] = [];
    for (let c = 0; c < len; c += 1) {
      chars.push(GLYPHS[Math.floor(rand() * GLYPHS.length)] ?? '0');
    }
    out.push({
      x: rand() * width,
      y: rand() * height * 1.6 - height * 0.3,
      speed: 26 + rand() * 58,
      len,
      alpha: 0.10 + rand() * 0.16,
      chars,
    });
  }
  return out;
}

/* Deterministic PRNG so the field is identical between server and client paint
   and does not flash a different arrangement on hydration. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function SignalField(): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (ctx === null) return;

    const reduced =
      typeof matchMedia === 'function' &&
      matchMedia('(prefers-reduced-motion: reduce)').matches;

    let width = 0;
    let height = 0;
    let columns: Column[] = [];
    let raf = 0;
    let last = 0;
    let glowAge = 0;
    let running = true;

    /* The four glows are enormous soft gradients. Painting them at full
       resolution every frame costs ~23M pixel writes and pinned this page at
       14fps. They contain no detail above a few pixels, so they are rendered
       into a tiny offscreen bitmap and scaled up — ~80x cheaper and visually
       identical. */
    const GLOW_DIV = 8;
    const GLOW_EVERY = 6; // frames between glow bitmap regenerations
    const glowCanvas = document.createElement('canvas');
    const glowCtx = glowCanvas.getContext('2d');

    const resize = (): void => {
      /* DPR 1 on purpose: this layer is soft gradients plus text at 2-5% alpha.
         Retina backing here doubles the cost and buys nothing visible. */
      width = innerWidth;
      height = innerHeight;
      canvas.width = width;
      canvas.height = height;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      glowCanvas.width = Math.max(2, Math.ceil(width / GLOW_DIV));
      glowCanvas.height = Math.max(2, Math.ceil(height / GLOW_DIV));
      glowAge = 0;
      columns = makeColumns(width, height, mulberry32(0x51f4));
    };

    const paintGlow = (tSec: number): void => {
      if (glowCtx === null) return;
      const gw = glowCanvas.width;
      const gh = glowCanvas.height;
      glowCtx.clearRect(0, 0, gw, gh);
      for (const g of GLOWS) {
        const cx = gw * (0.5 + g.ax * Math.sin(tSec * g.fx * Math.PI * 2 + g.px));
        const cy = gh * (0.5 + g.ay * Math.cos(tSec * g.fy * Math.PI * 2 + g.py));
        const r = Math.max(gw, gh) * g.radius;
        const grad = glowCtx.createRadialGradient(cx, cy, 0, cx, cy, r);
        grad.addColorStop(0, g.hue);
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        glowCtx.fillStyle = grad;
        glowCtx.fillRect(0, 0, gw, gh);
      }
    };

    const draw = (tSec: number): void => {
      ctx.clearRect(0, 0, width, height);

      if (glowAge <= 0) {
        paintGlow(tSec);
        glowAge = GLOW_EVERY;
      }
      glowAge -= 1;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(glowCanvas, 0, 0, width, height);

      ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textBaseline = 'top';
      for (const col of columns) {
        for (let i = 0; i < col.len; i += 1) {
          /* Fade toward the tail so each column reads as a trail, not a bar. */
          const fade = 1 - i / col.len;
          ctx.fillStyle = `rgba(0, 200, 5, ${(col.alpha * fade).toFixed(4)})`;
          ctx.fillText(col.chars[i] ?? '0', col.x, col.y - i * 15);
        }
      }
    };

    const step = (now: number): void => {
      raf = requestAnimationFrame(step);
      if (!running) return;
      if (now - last < FRAME_MS) return;
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;

      for (const col of columns) {
        col.y += col.speed * dt;
        if (col.y - col.len * 15 > height) {
          col.y = -20;
          col.x = Math.random() * width;
        }
      }
      draw(now / 1000);
    };

    const onVisibility = (): void => {
      running = document.visibilityState === 'visible';
    };

    resize();

    if (reduced) {
      draw(0);
      const onResizeStatic = (): void => {
        resize();
        draw(0);
      };
      addEventListener('resize', onResizeStatic);
      return () => removeEventListener('resize', onResizeStatic);
    }

    addEventListener('resize', resize);
    document.addEventListener('visibilitychange', onVisibility);
    raf = requestAnimationFrame(step);

    return () => {
      cancelAnimationFrame(raf);
      removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return (
    <div className={s.field} aria-hidden="true">
      <canvas ref={canvasRef} className={s.canvas} />
    </div>
  );
}
