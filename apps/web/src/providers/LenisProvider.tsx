'use client';

import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import Lenis from 'lenis';
import { usePathname } from 'next/navigation';
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
  /**
   * The live instance, or `null` under reduced motion, on the messenger, or
   * before mount.
   */
  readonly lenis: Lenis | null;
  readonly enabled: boolean;
  /** Scroll to an element or offset. Falls back to native scrolling. */
  scrollTo: (target: number | string | HTMLElement, offset?: number) => void;
  /**
   * Freeze scrolling. A no-op wherever no instance exists, which is safe: the
   * connect sheet locks the page with `documentElement.style.overflow` rather
   * than this, so the sheet behaves the same with or without Lenis.
   */
  stop: () => void;
  start: () => void;
}

const LenisContext = createContext<LenisApi | null>(null);

/**
 * Is this the messenger?
 *
 * The static export sets `trailingSlash`, so the live host serves `/app/` while
 * `pnpm dev` serves `/app` — both have to match, and `/approach`-style siblings
 * must not. `usePathname` reports the route without `basePath`, so this stays
 * correct when the site is served from a sub-path.
 */
function isMessengerRoute(pathname: string): boolean {
  return pathname === '/app' || pathname.startsWith('/app/');
}

/**
 * Smooth scroll, wired to GSAP's ticker so ScrollTrigger stays in sync.
 *
 * Under `prefers-reduced-motion` no Lenis instance is created at all — the
 * page uses native scrolling and `scrollTo` degrades to `behavior: 'auto'`.
 * The preference is watched live, so toggling it mid-session takes effect
 * without a reload.
 *
 * No instance is created on the messenger either. Lenis defaults to
 * `allowNestedScroll: false`, and its wheel handler calls `preventDefault()` on
 * every event whose composed path carries no `data-lenis-prevent`, rerouting
 * the delta to `window` — which leaves the conversation rail and the message
 * log dead to wheel and trackpad while the page itself creeps. Marking each
 * pane would be a standing tax on every pane added later; the messenger is a
 * viewport-height shell with zero page scroll range, so there is nothing there
 * for Lenis to smooth in the first place. Easing would also fight the log's
 * programmatic jump to the floor on each new message. Marketing routes are
 * untouched — the instance is rebuilt on the way back out.
 */
export function LenisProvider({ children }: { children: ReactNode }): ReactNode {
  const reduced = usePrefersReducedMotion();
  const pathname = usePathname();
  const suppressed = reduced || isMessengerRoute(pathname);
  const [lenis, setLenis] = useState<Lenis | null>(null);
  const lenisRef = useRef<Lenis | null>(null);

  useEffect(() => {
    if (suppressed) {
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
  }, [suppressed]);

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
