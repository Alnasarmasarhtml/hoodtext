/**
 * Resolve a path under `public/` for the current deployment.
 *
 * Next rewrites its own links and imports when `basePath` is set, but it does NOT touch raw markup
 * attributes — a literal `<source src="/media/x.webm">` stays absolute and resolves against the
 * domain root. On a GitHub Pages project site that is a 404, which is exactly how the hero video
 * silently broke on the first deploy while working perfectly in dev.
 *
 * Anything referenced by a raw `src`/`href` attribute has to go through here.
 */
const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

export function asset(path: string): string {
  const normalised = path.startsWith('/') ? path : `/${path}`;
  return `${BASE}${normalised}`;
}
