'use client';

/**
 * React binding for the demo switch (`@/lib/demo`).
 *
 * `useSyncExternalStore` with a `false` server snapshot: every prerendered
 * byte is the real interface, and the demo decision lands only in the
 * browser — after hydration, without a mismatch. The flag cannot change
 * mid-session without a navigation (`?demo=1` requires a load, `exitDemo`
 * navigates away), so the subscription is a no-op.
 */

import { useSyncExternalStore } from 'react';

import { isDemoActive } from '@/lib/demo';

const subscribe = (): (() => void) => () => undefined;
const getSnapshot = (): boolean => isDemoActive();
const getServerSnapshot = (): boolean => false;

/** True when this tab is in demo mode. Always `false` during prerender. */
export function useDemoActive(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
