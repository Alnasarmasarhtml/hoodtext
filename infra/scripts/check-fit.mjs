#!/usr/bin/env node
/**
 * check-fit.mjs — strict horizontal-overflow verification (SPEC 7.5).
 *
 *   node infra/scripts/check-fit.mjs http://localhost:3000
 *   node infra/scripts/check-fit.mjs http://localhost:3000/access --widths 1440,390
 *
 * Loads the URL at 1440 / 1024 / 760 / 390 px and asserts, for EVERY rendered
 * element on the page:
 *
 *   1. rect.right <= window.innerWidth + 1.5      element does not exceed the viewport
 *   2. rect.left  >= -1.5                          element does not start off-screen left
 *   3. rect.right <= offsetParent.right + 1.5      element does not exceed its own container
 *
 * These are per-element box assertions on purpose. `document.body.scrollWidth >
 * clientWidth` is the usual shortcut and it is not good enough: a CSS grid track
 * of `1fr` that refuses to shrink below its content pushes a *child* past its
 * container while the body stays exactly as wide as the viewport, so scrollWidth
 * reports nothing at all. That blowout is the failure mode this project keeps
 * hitting, so it is the one this script is built to catch. No scrollWidth
 * comparison appears anywhere below.
 *
 * The only exemption is explicit and greppable: descendants of an element marked
 * `data-fit-scroll` are not checked, because that attribute is the author stating
 * that the region scrolls horizontally on purpose (a wide epoch table, say). The
 * marked element itself is still checked in full, so the scroll region must fit
 * even when its contents do not. Nothing is exempt implicitly — a CSS
 * `overflow-x:auto` on its own buys nothing, since browsers also compute that
 * value for any box that merely scrolls vertically.
 *
 * Options:
 *   --widths <csv>    viewport widths in px       (default 1440,1024,760,390)
 *   --height <px>     viewport height             (default 900)
 *   --timeout <ms>    navigation timeout          (default 30000)
 *   --max-rows <n>    violation rows to print     (default 40)
 *   --settle <ms>     pause after scrolling       (default 500)
 *   --screenshot <dir> save a full-page png per width
 *
 * Exit codes: 0 clean, 1 violations found, 2 could not run the check.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { banner, blank, die, err, note, ok, step, style, table, warn } from './lib/console.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** SPEC 7.5. Sub-pixel layout rounding is real, so a 1.5px slack is the tolerance. */
const DEFAULT_WIDTHS = [1440, 1024, 760, 390];
const TOLERANCE = 1.5;

const EXIT_OK = 0;
const EXIT_VIOLATIONS = 1;
const EXIT_ERROR = 2;

// ─── options ─────────────────────────────────────────────────────────────────

/**
 * @param {string[]} argv
 * @returns {{ url: string, widths: number[], height: number, timeout: number, maxRows: number, settle: number, screenshotDir: string | null }}
 */
function parseArgs(argv) {
  /** @type {string | null} */
  let url = null;
  /** @type {Map<string, string>} */
  const flags = new Map();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      process.stdout.write(
        'Usage: node infra/scripts/check-fit.mjs <url> [--widths 1440,1024,760,390] [--height 900]\n' +
          '                                          [--timeout 30000] [--max-rows 40] [--settle 500]\n' +
          '                                          [--screenshot <dir>]\n',
      );
      process.exit(EXIT_OK);
    }
    if (token.startsWith('--')) {
      const name = token.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        die(`option --${name} needs a value`, [], EXIT_ERROR);
      }
      flags.set(name, value);
      i += 1;
      continue;
    }
    if (url === null) url = token;
  }

  if (url === null) {
    die('no URL given', ['Usage: node infra/scripts/check-fit.mjs http://localhost:3000'], EXIT_ERROR);
  }
  try {
    // eslint-disable-next-line no-new
    new URL(url);
  } catch {
    die(`not a valid URL: ${url}`, ['Example: node infra/scripts/check-fit.mjs http://localhost:3000'], EXIT_ERROR);
  }

  /**
   * @param {string} name
   * @param {number} fallback
   * @returns {number}
   */
  const num = (name, fallback) => {
    const raw = flags.get(name);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      die(`--${name} must be a positive number, got ${raw}`, [], EXIT_ERROR);
    }
    return parsed;
  };

  const widthsRaw = flags.get('widths');
  const widths = widthsRaw
    ? widthsRaw.split(',').map((part) => {
        const parsed = Number(part.trim());
        if (!Number.isFinite(parsed) || parsed <= 0) {
          die(`--widths contains a bad value: ${part}`, [], EXIT_ERROR);
        }
        return Math.round(parsed);
      })
    : DEFAULT_WIDTHS;

  const screenshot = flags.get('screenshot');

  return {
    url,
    widths,
    height: Math.round(num('height', 900)),
    timeout: Math.round(num('timeout', 30000)),
    maxRows: Math.round(num('max-rows', 40)),
    settle: Math.round(num('settle', 500)),
    screenshotDir: screenshot === undefined ? null : resolve(screenshot),
  };
}

// ─── playwright ──────────────────────────────────────────────────────────────

/**
 * Find a Playwright that can drive Chromium.
 *
 * Preference order:
 *   1. `playwright` / `playwright-core` / `@playwright/test` resolved from the
 *      workspace (repo root, apps/web, infra) — what you get after `pnpm add -D playwright`;
 *   2. the `playwright-core` Node package bundled inside an installed Python
 *      `playwright` wheel, which is a complete and current Node driver.
 *
 * @returns {Promise<{ chromium: import('playwright-core').BrowserType, origin: string }>}
 */
async function loadPlaywright() {
  const require = createRequire(join(REPO_ROOT, 'infra', 'scripts', 'noop.cjs'));
  const searchPaths = [
    join(REPO_ROOT, 'infra'),
    REPO_ROOT,
    join(REPO_ROOT, 'apps', 'web'),
    join(REPO_ROOT, 'packages', 'crypto'),
  ];

  for (const packageName of ['playwright', 'playwright-core', '@playwright/test']) {
    for (const from of searchPaths) {
      /** @type {string} */
      let entry;
      try {
        entry = require.resolve(packageName, { paths: [from] });
      } catch {
        continue;
      }
      try {
        const module = await import(pathToFileURL(entry).href);
        const chromium = module.chromium ?? module.default?.chromium;
        if (chromium) return { chromium, origin: `${packageName} (${from.slice(REPO_ROOT.length + 1) || '.'})` };
      } catch {
        /* fall through to the next candidate */
      }
    }
  }

  const bundled = findPythonBundledDriver();
  if (bundled !== null) {
    const module = await import(pathToFileURL(bundled).href);
    const chromium = module.chromium ?? module.default?.chromium;
    if (chromium) return { chromium, origin: 'playwright-core bundled with the Python playwright package' };
  }

  return die(
    'Playwright is not available, so the fit check cannot run.',
    [
      'Install it into the workspace (this also fetches Chromium):',
      '  pnpm add -Dw playwright && pnpm exec playwright install chromium',
      '',
      'Or install the Python package, whose bundled Node driver this script will reuse:',
      '  pip install playwright && playwright install chromium',
    ],
    EXIT_ERROR,
  );
}

/**
 * The Python `playwright` wheel ships the full Node `playwright-core` package at
 * `<site-packages>/playwright/driver/package`. Ask the interpreter where that is.
 * @returns {string | null} absolute path to index.mjs, or null
 */
function findPythonBundledDriver() {
  for (const interpreter of ['python3', 'python', 'python3.14', 'python3.13', 'python3.12']) {
    const probe = spawnSync(
      interpreter,
      ['-c', 'import playwright, os; print(os.path.dirname(playwright.__file__))'],
      { encoding: 'utf8', timeout: 10000 },
    );
    if (probe.status !== 0 || typeof probe.stdout !== 'string') continue;
    const entry = join(probe.stdout.trim(), 'driver', 'package', 'index.mjs');
    if (existsSync(entry)) return entry;
  }
  return null;
}

// ─── the in-page measurement ─────────────────────────────────────────────────

/**
 * Runs inside the browser. Returns one record per failing (element, rule) pair.
 *
 * Skipped, because they are not rendered boxes and would only add noise:
 *   - non-visual tags (script/style/link/meta/head/title/base/template/noscript/br);
 *   - `display:none` and `visibility:hidden` subtrees;
 *   - boxes smaller than 2x2 px, which covers the standard screen-reader-only
 *     idioms (1px clip, `clip-path:inset(50%)`, `clip:rect(0,0,0,0)`).
 *
 *   - descendants of `[data-fit-scroll]`, an explicit author declaration that the
 *     region scrolls horizontally on purpose. The marked element itself is checked.
 *
 * Nothing else is exempt. A plain `overflow:hidden` or `overflow-x:auto` ancestor
 * does NOT excuse an overflowing child: clipped content is still content the user
 * cannot reach, which is exactly what SPEC 7.5 forbids.
 *
 * @param {number} tolerance
 * @returns {{ elementsChecked: number, exempted: number, exemptRoots: string[], innerWidth: number, docWidth: number, violations: { path: string, rule: string, overflow: number, tag: string, label: string, container: string }[] }}
 */
function measureInPage(tolerance) {
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'LINK', 'META', 'HEAD', 'TITLE', 'BASE',
    'TEMPLATE', 'NOSCRIPT', 'BR', 'PARAM', 'SOURCE', 'TRACK', 'WBR',
  ]);

  /**
   * @param {Element} el
   * @returns {string}
   */
  function selectorPath(el) {
    /** @type {string[]} */
    const parts = [];
    /** @type {Element | null} */
    let cur = el;
    while (cur !== null && cur.nodeType === 1 && parts.length < 5) {
      let piece = cur.tagName.toLowerCase();
      const id = cur.getAttribute('id');
      if (id !== null && id !== '') {
        parts.unshift(`${piece}#${id}`);
        break;
      }
      const classAttr = cur.getAttribute('class') ?? '';
      const classes = classAttr
        .trim()
        .split(/\s+/)
        .filter((c) => c !== '')
        .slice(0, 2);
      if (classes.length > 0) piece += `.${classes.join('.')}`;
      const parent = cur.parentElement;
      if (parent !== null) {
        const twins = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (twins.length > 1) piece += `:nth-of-type(${twins.indexOf(cur) + 1})`;
      }
      parts.unshift(piece);
      cur = parent;
    }
    return parts.join(' > ');
  }

  /**
   * @param {Element} el
   * @returns {string}
   */
  function labelFor(el) {
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text !== '') return text.length > 28 ? `${text.slice(0, 27)}…` : text;
    const alt = el.getAttribute('alt') ?? el.getAttribute('aria-label') ?? '';
    return alt.slice(0, 28);
  }

  /**
   * @param {Node} root
   * @param {Element[]} sink
   * @returns {void}
   */
  function collect(root, sink) {
    const walker = /** @type {ParentNode} */ (root).querySelectorAll?.('*');
    if (!walker) return;
    for (const el of walker) {
      sink.push(el);
      if (el.shadowRoot) collect(el.shadowRoot, sink);
    }
  }

  /** @type {Element[]} */
  const elements = [];
  collect(document, elements);

  const innerWidth = window.innerWidth;
  /** @type {{ path: string, rule: string, overflow: number, tag: string, label: string, container: string }[]} */
  const violations = [];
  /** @type {Set<string>} */
  const exemptRoots = new Set();
  let elementsChecked = 0;
  let exempted = 0;

  for (const el of elements) {
    if (SKIP_TAGS.has(el.tagName)) continue;

    const cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;

    const rect = el.getBoundingClientRect();
    if (rect.width < 2 && rect.height < 2) continue;

    // The declared scroll region itself is checked; only what is inside it is not.
    const scrollRoot = el.parentElement?.closest('[data-fit-scroll]') ?? null;
    if (scrollRoot !== null) {
      exempted += 1;
      exemptRoots.add(selectorPath(scrollRoot));
      continue;
    }

    elementsChecked += 1;

    if (rect.right > innerWidth + tolerance) {
      violations.push({
        path: selectorPath(el),
        rule: 'viewport-right',
        overflow: rect.right - innerWidth,
        tag: el.tagName.toLowerCase(),
        label: labelFor(el),
        container: `viewport ${innerWidth}px`,
      });
    }

    if (rect.left < -tolerance) {
      violations.push({
        path: selectorPath(el),
        rule: 'viewport-left',
        overflow: -rect.left,
        tag: el.tagName.toLowerCase(),
        label: labelFor(el),
        container: `viewport ${innerWidth}px`,
      });
    }

    // offsetParent is null for position:fixed and for detached/hidden elements;
    // both are correctly out of scope for a containment check.
    const parent = /** @type {HTMLElement | null} */ (
      /** @type {HTMLElement} */ (el).offsetParent ?? null
    );
    if (parent !== null) {
      const parentRect = parent.getBoundingClientRect();
      if (rect.right > parentRect.right + tolerance) {
        violations.push({
          path: selectorPath(el),
          rule: 'container-right',
          overflow: rect.right - parentRect.right,
          tag: el.tagName.toLowerCase(),
          label: labelFor(el),
          container: selectorPath(parent),
        });
      }
    }
  }

  return {
    elementsChecked,
    exempted,
    exemptRoots: [...exemptRoots],
    innerWidth,
    docWidth: Math.round(document.documentElement.getBoundingClientRect().width),
    violations,
  };
}

// ─── driving the page ────────────────────────────────────────────────────────

/**
 * Fire every scroll-triggered reveal, then return to the top so measurements are
 * taken against the settled layout rather than a mid-animation frame.
 * @param {import('playwright-core').Page} page
 * @param {number} settle
 * @returns {Promise<void>}
 */
async function scrollThrough(page, settle) {
  await page.evaluate(async () => {
    const step = Math.max(200, window.innerHeight * 0.8);
    const limit = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    for (let y = 0; y < limit; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 40)));
    }
    window.scrollTo(0, limit);
    await new Promise((r) => setTimeout(r, 120));
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(settle);
}

/**
 * @param {import('playwright-core').Browser} browser
 * @param {{ url: string, width: number, height: number, timeout: number, settle: number, screenshotDir: string | null }} options
 * @returns {Promise<{ elementsChecked: number, exempted: number, exemptRoots: string[], innerWidth: number, docWidth: number, violations: { path: string, rule: string, overflow: number, tag: string, label: string, container: string }[] }>}
 */
async function checkWidth(browser, options) {
  const context = await browser.newContext({
    viewport: { width: options.width, height: options.height },
    deviceScaleFactor: 1,
    // A device-width mobile viewport is the honest test for 390px.
    isMobile: false,
  });
  const page = await context.newPage();

  /** @type {string[]} */
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  try {
    const response = await page.goto(options.url, {
      waitUntil: 'domcontentloaded',
      timeout: options.timeout,
    });
    if (response !== null && !response.ok()) {
      throw new Error(`${options.url} returned HTTP ${response.status()} ${response.statusText()}`);
    }

    // Dev servers keep an HMR socket open, so networkidle may never arrive.
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
    // The FontFaceSet itself is not serializable, so resolve it to undefined.
    await page.evaluate(() => document.fonts.ready.then(() => undefined)).catch(() => undefined);
    await scrollThrough(page, options.settle);

    if (options.screenshotDir !== null) {
      mkdirSync(options.screenshotDir, { recursive: true });
      await page.screenshot({
        path: join(options.screenshotDir, `fit-${options.width}.png`),
        fullPage: true,
      });
    }

    const result = await page.evaluate(measureInPage, TOLERANCE);
    for (const message of pageErrors.slice(0, 3)) {
      warn(`page error at ${options.width}px: ${message}`);
    }
    return result;
  } finally {
    await context.close();
  }
}

// ─── reporting ───────────────────────────────────────────────────────────────

/**
 * @param {number} value
 * @returns {string}
 */
function px(value) {
  return `${value.toFixed(1)}px`;
}

/**
 * @param {Map<string, { path: string, rule: string, tag: string, label: string, container: string, byWidth: Map<number, number> }>} aggregate
 * @param {number[]} widths
 * @param {number} maxRows
 * @returns {void}
 */
function report(aggregate, widths, maxRows) {
  const ordered = [...aggregate.values()].sort((a, b) => {
    const worst = (entry) => Math.max(...entry.byWidth.values());
    return worst(b) - worst(a);
  });

  const rows = ordered.slice(0, maxRows).map((entry) => {
    const failing = widths.filter((w) => entry.byWidth.has(w));
    const worst = Math.max(...entry.byWidth.values());
    return [
      entry.path,
      entry.rule,
      failing.map((w) => `${w}`).join(','),
      px(worst),
      entry.rule === 'container-right' ? entry.container : entry.label,
    ];
  });

  process.stdout.write(
    `${table(['ELEMENT', 'RULE', 'FAILS AT', 'OVERFLOW', 'CONTAINER / THOOD'], rows, { maxColWidth: 58 })}\n`,
  );
  if (ordered.length > rows.length) {
    blank();
    note(`… and ${ordered.length - rows.length} more (raise --max-rows to see them all)`);
  }
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  const options = parseArgs(process.argv.slice(2));

  banner('HoodGram — fit check');
  note(`url     ${options.url}`);
  note(`widths  ${options.widths.join(', ')} px`);
  note(`rules   rect.right <= innerWidth+${TOLERANCE} · rect.left >= -${TOLERANCE} · rect.right <= offsetParent.right+${TOLERANCE}`);
  blank();

  const { chromium, origin } = await loadPlaywright();
  step(`using ${origin}`);

  /** @type {import('playwright-core').Browser} */
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    return die(
      `could not launch Chromium: ${error instanceof Error ? error.message : String(error)}`,
      ['Install the browser binary:', '  pnpm exec playwright install chromium'],
      EXIT_ERROR,
    );
  }

  /** @type {Map<string, { path: string, rule: string, tag: string, label: string, container: string, byWidth: Map<number, number> }>} */
  const aggregate = new Map();
  /** @type {Set<string>} */
  const exemptRoots = new Set();
  let totalViolations = 0;
  let totalExempted = 0;

  try {
    for (const width of options.widths) {
      /** @type {Awaited<ReturnType<typeof checkWidth>>} */
      let result;
      try {
        result = await checkWidth(browser, {
          url: options.url,
          width,
          height: options.height,
          timeout: options.timeout,
          settle: options.settle,
          screenshotDir: options.screenshotDir,
        });
      } catch (error) {
        // Playwright appends a multi-line, ANSI-coloured call log; the first line
        // is the actual reason and the rest is noise in a CI log.
        const raw = error instanceof Error ? error.message : String(error);
        const message = raw.split('\n')[0].replace(/\u001b\[[0-9;]*m/g, '').trim();
        return die(`could not load ${options.url} at ${width}px — ${message}`, [
          'Is the dev server running?',
          '  make dev            # relay on :8787 and web on :3000',
        ], EXIT_ERROR);
      }

      totalViolations += result.violations.length;
      totalExempted = Math.max(totalExempted, result.exempted);
      for (const root of result.exemptRoots) exemptRoots.add(root);

      for (const violation of result.violations) {
        const key = `${violation.path} ${violation.rule}`;
        const existing = aggregate.get(key);
        if (existing === undefined) {
          aggregate.set(key, {
            path: violation.path,
            rule: violation.rule,
            tag: violation.tag,
            label: violation.label,
            container: violation.container,
            byWidth: new Map([[width, violation.overflow]]),
          });
        } else {
          const previous = existing.byWidth.get(width) ?? 0;
          existing.byWidth.set(width, Math.max(previous, violation.overflow));
        }
      }

      const count = result.violations.length;
      const line = `${String(width).padStart(4)}px  ${String(result.elementsChecked).padStart(5)} elements  `;
      if (count === 0) {
        process.stdout.write(`  ${style.green('PASS')}  ${line}0 violations\n`);
      } else {
        process.stdout.write(`  ${style.red('FAIL')}  ${line}${count} violation${count === 1 ? '' : 's'}\n`);
      }
    }
  } finally {
    await browser.close();
  }

  blank();

  // Exemptions are never silent: name every scroll region that claimed one.
  if (totalExempted > 0) {
    warn(
      `${totalExempted} element${totalExempted === 1 ? '' : 's'} skipped inside ${exemptRoots.size} declared [data-fit-scroll] region${
        exemptRoots.size === 1 ? '' : 's'
      }`,
    );
    for (const root of exemptRoots) note(root);
    blank();
  }

  if (aggregate.size === 0) {
    ok(`no element overflows its container or the viewport at ${options.widths.join(' / ')} px`);
    process.exit(EXIT_OK);
  }

  err(
    `${aggregate.size} element${aggregate.size === 1 ? '' : 's'} overflow (${totalViolations} assertion failure${
      totalViolations === 1 ? '' : 's'
    } across ${options.widths.length} widths)`,
  );
  blank();
  report(aggregate, options.widths, options.maxRows);
  blank();
  note('viewport-right  : element extends past the right edge of the window');
  note('viewport-left   : element starts left of the window');
  note('container-right : element extends past its own offsetParent — usually a grid');
  note('                  track declared `1fr` instead of `minmax(0,1fr)`, or a flex');
  note('                  child missing `min-width:0` (SPEC 7.5).');
  process.exit(EXIT_VIOLATIONS);
}

main().catch((error) => {
  die(error instanceof Error ? error.message : String(error), [], EXIT_ERROR);
});
