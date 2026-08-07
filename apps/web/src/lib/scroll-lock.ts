/**
 * The one document scroll lock.
 *
 * There must be exactly one writer of `documentElement.style.overflow` in this
 * app, and this is it. The rule is not stylistic — two independent save/restore
 * pairs cannot be composed, and the failure is silent:
 *
 *   1. The connect sheet opens on `/`. It saves `''` and writes `hidden`.
 *   2. The user navigates to `/app` with the sheet still open. A second locker
 *      reads the CURRENT value and saves `hidden` as "the original".
 *   3. The sheet closes and writes back its `''`. `/app` is scrollable again,
 *      while the second locker still believes it holds the lock.
 *   4. The user leaves `/app`. The second locker restores its bogus `hidden`,
 *      and `/` is unscrollable until a reload.
 *
 * Steps 1–4 need no StrictMode and no exotic timing; `IdentityGate` opens the
 * same sheet from inside `/app`. The fix is a single refcount: the FIRST lock
 * records the inline styles that were there before anybody touched them, and
 * only the LAST release puts them back. Everything in between is arithmetic on
 * a counter and touches no DOM at all.
 *
 * The counter is module scope because the thing being locked is the document,
 * not a React subtree. Overlapping holders are normal and expected: StrictMode
 * double-invokes effects in development, a route transition can mount the next
 * tree before unmounting the last, and the sheet legitimately overlaps the
 * messenger shell.
 */

interface SavedOverflow {
  readonly root: string;
  readonly body: string;
}

/** How many holders currently want the document frozen. Never negative. */
let depth = 0;

/**
 * The inline values as they stood before the 0→1 transition, or `null` when
 * nothing is held. Empty strings are meaningful and must be written back
 * verbatim: an empty string hands the property back to the stylesheet, which is
 * what `body` wants — `globals.css` gives it `overflow-x: clip`.
 */
let saved: SavedOverflow | null = null;

/** Test-visible for assertions; also handy when debugging a stuck page. */
export function documentScrollLockDepth(): number {
  return depth;
}

/**
 * Freeze document scrolling for as long as the returned release is unspent.
 *
 * Both `documentElement` and `body` are pinned. The root's overflow is the one
 * that propagates to the viewport and so is the load-bearing half; `body` is
 * belt-and-braces for the mobile engines that still rubber-band a hidden root.
 *
 * Deliberately does NOT move the scroll position — a caller that needs the page
 * clamped to the top (the messenger does; the connect sheet very much does not,
 * since it opens over mid-page content) scrolls before it locks.
 *
 * @returns an idempotent release. Calling it twice is a no-op, because a stale
 *   closure invoked a second time would drive the shared counter below zero and
 *   leave every route unscrollable for the rest of the session.
 */
export function lockDocumentScroll(): () => void {
  /* Server render and the node test environment have no document. A no-op
     release keeps callers free of their own environment checks. */
  if (typeof document === 'undefined') return () => undefined;

  const root = document.documentElement;
  const { body } = document;

  if (depth === 0) {
    saved = { root: root.style.overflow, body: body.style.overflow };
    root.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
  }
  depth += 1;

  let released = false;
  return () => {
    if (released) return;
    released = true;

    depth -= 1;
    if (depth > 0) return;

    /* Belt: a release that somehow escaped the `released` guard cannot leave a
       negative counter behind, which would make the NEXT lock's 0→1 branch
       never run and so never freeze anything. */
    depth = 0;
    if (saved === null) return;

    /* Re-read the elements rather than trusting the ones captured at lock time:
       the holder that opened the lock may be long gone. */
    document.documentElement.style.overflow = saved.root;
    document.body.style.overflow = saved.body;
    saved = null;
  };
}
