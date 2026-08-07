'use client';

import { useEffect, useRef, type ReactNode } from 'react';

import { cx } from '@/lib/cx';
import { usePrefersReducedMotion } from '@/lib/use-prefers-reduced-motion';
import s from './MediaLoop.module.css';

export interface MediaLoopProps {
  /** mp4 URL, already resolved through `asset()`. */
  readonly src: string;
  /** Poster still URL, already resolved through `asset()`. */
  readonly poster: string;
  readonly className?: string;
}

/**
 * A background film loop, done the only way this project allows.
 *
 * Every file in `public/media/` is authored so its last frame is pixel-identical to its first
 * (verified at infinite PSNR), which makes a plain `loop` attribute genuinely seamless. Nothing
 * here — and nothing layered on top of this component — may add fades, crossfades or JS restart
 * logic; that is what made earlier attempts feel wrong.
 *
 * Under `prefers-reduced-motion` the poster renders instead of footage. Offscreen loops are
 * paused so four simultaneous videos never spend decode time on sections nobody is looking at.
 */
export function MediaLoop({ src, poster, className }: MediaLoopProps): ReactNode {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    const video = videoRef.current;
    if (video === null) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            void video.play().catch(() => undefined);
          } else {
            video.pause();
          }
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(video);
    return () => observer.disconnect();
  }, [reduced]);

  if (reduced) {
    return <img className={cx(s.media, className)} src={poster} alt="" />;
  }

  return (
    <video
      ref={videoRef}
      className={cx(s.media, className)}
      src={src}
      poster={poster}
      autoPlay
      muted
      loop
      playsInline
      preload="metadata"
      tabIndex={-1}
      aria-hidden="true"
    />
  );
}
