/**
 * Minimal class-name joiner. No dependency, no `any`.
 *
 * Falsy entries are dropped, so `cx(s.btn, active && s.active)` is safe.
 */
export type ClassValue = string | false | null | undefined;

export function cx(...values: readonly ClassValue[]): string {
  let out = '';
  for (const v of values) {
    if (!v) continue;
    out = out.length === 0 ? v : `${out} ${v}`;
  }
  return out;
}
