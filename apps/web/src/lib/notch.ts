/**
 * The 6px corner notch is the product's signature shape.
 *
 * Components style themselves from two custom properties — `--shape` (the outer
 * clip) and `--shape-in` (the same clip inset by 1px, so a hairline border
 * keeps an even 1px width along the diagonal). The `sh-*` utility classes in
 * `globals.css` set both at once.
 */
export type Notch = 'diag' | 'tr' | 'br' | 'bl' | 'tl' | 'none';

const SHAPE_CLASS: Readonly<Record<Notch, string>> = {
  diag: 'sh-diag',
  tr: 'sh-tr',
  br: 'sh-br',
  bl: 'sh-bl',
  tl: 'sh-tl',
  none: 'sh-none',
};

/** Global utility class that points `--shape` / `--shape-in` at `notch`. */
export function shapeClass(notch: Notch): string {
  return SHAPE_CLASS[notch];
}
