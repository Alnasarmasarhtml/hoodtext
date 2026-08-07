/**
 * The page scrolling on `/app` has been reported three times. Twice the shell's
 * own lock was correct in isolation and defeated by the connect sheet's private
 * save/restore of the same property, so the property under test here is not
 * "does it set overflow" — it is "do two overlapping holders compose".
 *
 * The environment is node, so there is no real document. A minimal stand-in is
 * enough: the module only ever reads and writes `style.overflow` on
 * `documentElement` and `body`, and reads them through the global at call time.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { documentScrollLockDepth, lockDocumentScroll } from './scroll-lock';

interface FakeDocument {
  documentElement: { style: { overflow: string } };
  body: { style: { overflow: string } };
}

const host = globalThis as unknown as { document?: FakeDocument };

let doc: FakeDocument;

function overflows(): readonly [string, string] {
  return [doc.documentElement.style.overflow, doc.body.style.overflow];
}

beforeEach(() => {
  doc = {
    documentElement: { style: { overflow: '' } },
    body: { style: { overflow: '' } },
  };
  host.document = doc;
});

afterEach(() => {
  delete host.document;
  // Every test below balances its own locks; if one did not, say so loudly
  // rather than leaking a stuck counter into the next test.
  expect(documentScrollLockDepth()).toBe(0);
});

describe('lockDocumentScroll', () => {
  it('freezes both scroll surfaces and hands the originals back', () => {
    const release = lockDocumentScroll();
    expect(overflows()).toEqual(['hidden', 'hidden']);

    release();
    expect(overflows()).toEqual(['', '']);
  });

  it('writes back the inline values that were there, not a hardcoded default', () => {
    doc.documentElement.style.overflow = 'scroll';
    doc.body.style.overflow = 'auto';

    const release = lockDocumentScroll();
    expect(overflows()).toEqual(['hidden', 'hidden']);

    release();
    expect(overflows()).toEqual(['scroll', 'auto']);
  });

  /**
   * The reported defect, step for step. Before the shared counter this ended
   * with the messenger scrollable at step 3 and `/` frozen forever at step 4.
   */
  it('survives the sheet-open-across-navigation sequence', () => {
    // 1. The connect sheet opens on `/`.
    const releaseSheet = lockDocumentScroll();
    expect(overflows()).toEqual(['hidden', 'hidden']);

    // 2. The user navigates to `/app` with it still open; the shell locks too.
    const releaseShell = lockDocumentScroll();
    expect(documentScrollLockDepth()).toBe(2);

    // 3. The sheet closes. `/app` must STILL be frozen — this is the step that
    //    used to silently undo the shell's lock.
    releaseSheet();
    expect(overflows()).toEqual(['hidden', 'hidden']);

    // 4. The user leaves `/app`. Only now is the original restored.
    releaseShell();
    expect(overflows()).toEqual(['', '']);
  });

  it('restores on the last release regardless of which holder locked first', () => {
    const first = lockDocumentScroll();
    const second = lockDocumentScroll();

    // Unlocking out of order (the shell unmounts while the sheet is still open).
    first();
    expect(overflows()).toEqual(['hidden', 'hidden']);

    second();
    expect(overflows()).toEqual(['', '']);
  });

  it('ignores a release spent twice instead of driving the counter negative', () => {
    const release = lockDocumentScroll();
    release();
    release();
    release();
    expect(documentScrollLockDepth()).toBe(0);

    // A negative counter would make this lock's 0→1 branch never run, leaving
    // `/app` scrollable for the rest of the session.
    const again = lockDocumentScroll();
    expect(overflows()).toEqual(['hidden', 'hidden']);
    again();
    expect(overflows()).toEqual(['', '']);
  });

  it('re-saves the true original after a full unlock', () => {
    const first = lockDocumentScroll();
    first();

    doc.documentElement.style.overflow = 'visible';
    const second = lockDocumentScroll();
    second();
    expect(doc.documentElement.style.overflow).toBe('visible');
  });

  it('is inert with no document, so a server render cannot throw', () => {
    delete host.document;

    const release = lockDocumentScroll();
    expect(documentScrollLockDepth()).toBe(0);
    release();
    expect(documentScrollLockDepth()).toBe(0);

    host.document = doc;
  });
});
