'use client';

import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import Lenis from 'lenis';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { usePrefersReducedMotion } from '@/lib/use-prefers-reduced-motion';

export interface LenisApi {
  /** The live instance, or `null` under reduced motion / before mount. */
  readonly lenis: Lenis | null;
  readonly enabled: boolean;
  /** Scroll to an element or offset. Falls back to native scrolling. */
  scrollTo: (target: number | string | HTMLElement, offset?: number) => void;
  /** Freeze scrolling — used while the connect sheet is open. */
  stop: () => void;
  start: () => void;
}

const LenisContext = createContext<LenisApi | null>(null);

/**
 * Smooth scroll, wired to GSAP's ticker so ScrollTrigger stays in sync.
 *
 * Under `prefers-reduced-motion` no Lenis instance is created at all — the
 * page uses native scrolling and `scrollTo` degrades to `behavior: 'auto'`.
 * The preference is watched live, so toggling it mid-session takes effect
 * without a reload.
 */
export function LenisProvider({ children }: { children: ReactNode }): ReactNode {
  const reduced = usePrefersReducedMotion();
  const [lenis, setLenis] = useState<Lenis | null>(null);
  const lenisRef = useRef<Lenis | null>(null);

  useEffect(() => {
    if (reduced) {
      lenisRef.current = null;
      setLenis(null);
      return;
    }

    gsap.registerPlugin(ScrollTrigger);

    const instance = new Lenis({
      duration: 1.05,
      easing: (t: number) => 1 - Math.pow(1 - t, 3),
      smoothWheel: true,
      syncTouch: false,
      autoRaf: false,
    });

    lenisRef.current = instance;
    setLenis(instance);

    const unsubscribe = instance.on('scroll', () => {
      ScrollTrigger.update();
    });

    const tick = (time: number): void => {
      instance.raf(time * 1000);
    };

    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);

    return () => {
      unsubscribe();
      gsap.ticker.remove(tick);
      gsap.ticker.lagSmoothing(500, 33);
      instance.destroy();
      lenisRef.current = null;
      setLenis(null);
    };
  }, [reduced]);

  const api = useMemo<LenisApi>(
    () => ({
      lenis,
      enabled: lenis !== null,
      scrollTo: (target, offset = 0) => {
        const active = lenisRef.current;
        if (active !== null) {
          active.scrollTo(target, { offset, duration: 1.05 });
          return;
        }
        if (typeof window === 'undefined') return;
        if (typeof target === 'number') {
          window.scrollTo({ top: target + offset, behavior: 'auto' });
          return;
        }
        const element =
          typeof target === 'string' ? document.querySelector(target) : target;
        if (element instanceof HTMLElement) {
          const top = element.getBoundingClientRect().top + window.scrollY + offset;
          window.scrollTo({ top, behavior: 'auto' });
        }
      },
      stop: () => lenisRef.current?.stop(),
      start: () => lenisRef.current?.start(),
    }),
    [lenis],
  );

  return <LenisContext.Provider value={api}>{children}</LenisContext.Provider>;
}

/**
 * Access the smooth-scroll API. Safe outside the provider — returns a no-op
 * implementation backed by native scrolling.
 */
export function useLenis(): LenisApi {
  const ctx = useContext(LenisContext);
  return (
    ctx ?? {
      lenis: null,
      enabled: false,
      scrollTo: (target, offset = 0) => {
        if (typeof window === 'undefined') return;
        if (typeof target === 'number') {
          window.scrollTo({ top: target + offset, behavior: 'auto' });
        }
      },
      stop: () => undefined,
      start: () => undefined,
    }
  );
}
