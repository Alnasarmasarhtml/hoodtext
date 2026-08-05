/**
 * Minimal terminal output helpers shared by the infra scripts.
 * ASCII only, colour disabled when NO_COLOR is set or stdout is not a TTY.
 */

const COLOR =
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== 'dumb' &&
  Boolean(process.stdout.isTTY);

/**
 * @param {string} code
 * @param {string} text
 * @returns {string}
 */
function paint(code, text) {
  return COLOR ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export const style = {
  /** @param {string} s @returns {string} */ dim: (s) => paint('2', s),
  /** @param {string} s @returns {string} */ bold: (s) => paint('1', s),
  /** @param {string} s @returns {string} */ red: (s) => paint('31', s),
  /** @param {string} s @returns {string} */ green: (s) => paint('32', s),
  /** @param {string} s @returns {string} */ amber: (s) => paint('33', s),
  /** @param {string} s @returns {string} */ steel: (s) => paint('36', s),
};

/** @param {string} name @returns {void} */
export function banner(name) {
  process.stdout.write(`${style.bold(name)}\n`);
}

/** @param {string} message @returns {void} */
export function step(message) {
  process.stdout.write(`${style.dim('  ->')} ${message}\n`);
}

/** @param {string} message @returns {void} */
export function ok(message) {
  process.stdout.write(`${style.green('  OK')} ${message}\n`);
}

/** @param {string} message @returns {void} */
export function warn(message) {
  process.stderr.write(`${style.amber('WARN')} ${message}\n`);
}

/** @param {string} message @returns {void} */
export function err(message) {
  process.stderr.write(`${style.red('FAIL')} ${message}\n`);
}

/** @param {string} message @returns {void} */
export function note(message) {
  process.stdout.write(`${style.dim(`     ${message}`)}\n`);
}

/** @returns {void} */
export function blank() {
  process.stdout.write('\n');
}

/**
 * Print `message`, plus optional remediation lines, then exit with `code`.
 * @param {string} message
 * @param {string[]} [hints]
 * @param {number} [code]
 * @returns {never}
 */
export function die(message, hints = [], code = 1) {
  err(message);
  for (const hint of hints) process.stderr.write(`     ${style.dim(hint)}\n`);
  process.exit(code);
}

/**
 * Render a fixed-width ASCII table. Columns are sized to their widest cell and
 * every cell is clamped to `maxColWidth` so a long selector can never wrap the
 * terminal into an unreadable mess.
 * @param {string[]} headers
 * @param {string[][]} rows
 * @param {{ maxColWidth?: number, indent?: string }} [options]
 * @returns {string}
 */
export function table(headers, rows, options = {}) {
  const maxColWidth = options.maxColWidth ?? 64;
  const indent = options.indent ?? '  ';

  /** @param {string} cell @returns {string} */
  const clamp = (cell) => {
    const text = cell ?? '';
    return text.length > maxColWidth ? `${text.slice(0, maxColWidth - 1)}…` : text;
  };

  const body = rows.map((row) => row.map(clamp));
  const head = headers.map(clamp);

  const widths = head.map((cell, index) => {
    let width = cell.length;
    for (const row of body) width = Math.max(width, (row[index] ?? '').length);
    return width;
  });

  /** @param {string[]} row @returns {string} */
  const line = (row) =>
    indent + row.map((cell, index) => (cell ?? '').padEnd(widths[index])).join('  ').trimEnd();

  const rule = indent + widths.map((width) => '-'.repeat(width)).join('  ');

  return [line(head), rule, ...body.map(line)].join('\n');
}
