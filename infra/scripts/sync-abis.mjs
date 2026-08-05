#!/usr/bin/env node
/**
 * sync-abis.mjs — lift the ABIs out of the forge build artifacts and emit them as
 * a single typed TypeScript module for the web app.
 *
 *   node infra/scripts/sync-abis.mjs [--check]
 *
 * Reads  contracts/out/<Name>.sol/<Name>.json
 * Writes apps/web/src/lib/abi.generated.ts   (every ABI exported `as const`)
 *
 * `apps/web/src/lib/abi.ts` is hand-written and owned by the web app. This script
 * never reads, writes, or otherwise touches it — the write target is asserted
 * before any file is opened.
 *
 * Options:
 *   --check   verify the generated file is up to date; write nothing, exit 1 if stale
 *
 * Exit codes: 0 success, 1 failure.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { banner, blank, die, note, ok, step, table, warn } from './lib/console.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = join(REPO_ROOT, 'contracts', 'out');
const WEB_LIB_DIR = join(REPO_ROOT, 'apps', 'web', 'src', 'lib');
const TARGET = join(WEB_LIB_DIR, 'abi.generated.ts');
const HANDWRITTEN = join(WEB_LIB_DIR, 'abi.ts');

/**
 * Concrete contracts. `file` is the .sol file name, `name` the contract inside it.
 * Every one of these must exist or the sync fails — a missing ABI in the web app
 * is a runtime crash, not a warning.
 * @type {readonly { file: string, name: string, export: string }[]}
 */
const REQUIRED = [
  { file: 'TeleHoodToken', name: 'TeleHoodToken', export: 'teleHoodTokenAbi' },
  { file: 'ManualPriceSource', name: 'ManualPriceSource', export: 'manualPriceSourceAbi' },
  { file: 'RevenueVault', name: 'RevenueVault', export: 'revenueVaultAbi' },
  { file: 'Activation', name: 'Activation', export: 'activationAbi' },
  { file: 'GroupRegistry', name: 'GroupRegistry', export: 'groupRegistryAbi' },
  { file: 'KeyRegistry', name: 'KeyRegistry', export: 'keyRegistryAbi' },
  { file: 'Anchors', name: 'Anchors', export: 'anchorsAbi' },
  { file: 'Perks', name: 'Perks', export: 'perksAbi' },
  { file: 'Handles', name: 'Handles', export: 'handlesAbi' },
];

/**
 * The interfaces from SPEC 4.1-4.4. Solidity does not constrain which file an
 * interface lives in — they may sit beside their implementation or be collected
 * into one header file — so these are located by artifact name anywhere under
 * contracts/out rather than by a fixed path. Emitted when found, skipped in
 * silence when not.
 * @type {readonly { name: string, export: string }[]}
 */
const OPTIONAL = [
  { name: 'ICheckpointToken', export: 'checkpointTokenAbi' },
  { name: 'IPriceSource', export: 'priceSourceAbi' },
  { name: 'IActivation', export: 'activationInterfaceAbi' },
  { name: 'IRooms', export: 'roomsInterfaceAbi' },
  { name: 'IPerks', export: 'perksInterfaceAbi' },
  { name: 'IRevenueVault', export: 'revenueVaultInterfaceAbi' },
];

/**
 * @param {{ file: string, name: string }} entry
 * @returns {string}
 */
function artifactPath(entry) {
  return join(OUT_DIR, `${entry.file}.sol`, `${entry.name}.json`);
}

/**
 * Find `<name>.json` in any `contracts/out/<something>.sol/` directory. Used for
 * interfaces, whose containing file is a free choice of the contract author.
 * @param {string} name
 * @returns {string | null} absolute path, or null when there is no such artifact
 */
function findArtifactByName(name) {
  /** @type {string[]} */
  let dirs;
  try {
    dirs = readdirSync(OUT_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = join(OUT_DIR, dir, `${name}.json`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * @param {string} path
 * @param {string} name
 * @returns {unknown[]}
 */
function readAbi(path, name) {
  /** @type {unknown} */
  let artifact;
  try {
    artifact = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `${path.slice(REPO_ROOT.length + 1)} is not readable JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (artifact === null || typeof artifact !== 'object' || !('abi' in artifact)) {
    throw new Error(`${path.slice(REPO_ROOT.length + 1)} has no "abi" key — is it a forge artifact?`);
  }
  const abi = /** @type {{ abi: unknown }} */ (artifact).abi;
  if (!Array.isArray(abi)) {
    throw new Error(`${name}: "abi" is ${typeof abi}, expected an array`);
  }
  return abi;
}

/**
 * Count the externally visible surface of an ABI, purely for the summary table.
 * @param {unknown[]} abi
 * @returns {{ functions: number, events: number, errors: number }}
 */
function summarize(abi) {
  let functions = 0;
  let events = 0;
  let errors = 0;
  for (const item of abi) {
    if (item === null || typeof item !== 'object') continue;
    const type = /** @type {{ type?: unknown }} */ (item).type;
    if (type === 'function') functions += 1;
    else if (type === 'event') events += 1;
    else if (type === 'error') errors += 1;
  }
  return { functions, events, errors };
}

/**
 * @param {{ name: string, export: string, abi: unknown[] }[]} entries
 * @returns {string}
 */
function render(entries) {
  const header = [
    '// GENERATED FILE — DO NOT EDIT.',
    '//',
    '// Produced by `node infra/scripts/sync-abis.mjs` from contracts/out/<Name>.sol/<Name>.json.',
    '// Re-run it (or `make build`) after any change to contracts/src.',
    '//',
    '// Hand-written ABI helpers belong in ./abi.ts, which this file never touches.',
    '',
    '/* eslint-disable */',
    '',
  ].join('\n');

  const blocks = entries.map(
    (entry) => `/** ABI for \`${entry.name}\`. */\nexport const ${entry.export} = ${JSON.stringify(entry.abi, null, 2)} as const;\n`,
  );

  const registry = [
    '/** Every generated ABI, keyed by Solidity contract name. */',
    'export const GENERATED_ABIS = {',
    ...entries.map((entry) => `  ${entry.name}: ${entry.export},`),
    '} as const;',
    '',
    '/** Solidity contract names for which an ABI was generated. */',
    'export type GeneratedContractName = keyof typeof GENERATED_ABIS;',
    '',
  ].join('\n');

  return `${header}\n${blocks.join('\n')}\n${registry}`;
}

/**
 * @param {string[]} argv
 * @returns {{ check: boolean }}
 */
function parseArgs(argv) {
  const unknown = argv.filter((token) => token.startsWith('--') && token !== '--check');
  if (unknown.length > 0) {
    die(`unknown option: ${unknown[0]}`, ['Usage: node infra/scripts/sync-abis.mjs [--check]']);
  }
  return { check: argv.includes('--check') };
}

function main() {
  const { check } = parseArgs(process.argv.slice(2));

  banner('TeleHood — ABI sync');
  note(`from  contracts/out`);
  note(`to    apps/web/src/lib/abi.generated.ts`);
  blank();

  // Guard the write target. abi.ts is hand-written and owned by apps/web.
  if (basename(TARGET) !== 'abi.generated.ts' || resolve(TARGET) === resolve(HANDWRITTEN)) {
    die('refusing to write: the output path is not abi.generated.ts');
  }

  if (!existsSync(OUT_DIR)) {
    die('contracts/out does not exist — nothing has been compiled yet', [
      'Build the contracts first:',
      '  forge build --root contracts    (or: make build)',
    ]);
  }

  /** @type {{ name: string, export: string, abi: unknown[] }[]} */
  const entries = [];
  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  const missing = [];

  for (const entry of REQUIRED) {
    const path = artifactPath(entry);
    if (!existsSync(path)) {
      missing.push(`${entry.name}  (expected contracts/out/${entry.file}.sol/${entry.name}.json)`);
      continue;
    }
    const abi = readAbi(path, entry.name);
    entries.push({ name: entry.name, export: entry.export, abi });
    const counts = summarize(abi);
    rows.push([
      entry.name,
      entry.export,
      String(counts.functions),
      String(counts.events),
      String(counts.errors),
    ]);
  }

  if (missing.length > 0) {
    die(`${missing.length} required artifact(s) missing:`, [
      ...missing,
      '',
      'Compile the contracts first:',
      '  forge build --root contracts    (or: make build)',
    ]);
  }

  for (const entry of OPTIONAL) {
    const path = findArtifactByName(entry.name);
    if (path === null) continue;
    const abi = readAbi(path, entry.name);
    entries.push({ name: entry.name, export: entry.export, abi });
    const counts = summarize(abi);
    rows.push([
      entry.name,
      entry.export,
      String(counts.functions),
      String(counts.events),
      String(counts.errors),
    ]);
  }

  const source = render(entries);
  const existing = existsSync(TARGET) ? readFileSync(TARGET, 'utf8') : null;
  const changed = existing !== source;

  if (check) {
    if (changed) {
      die('apps/web/src/lib/abi.generated.ts is out of date', [
        'Regenerate it: node infra/scripts/sync-abis.mjs',
      ]);
    }
    ok(`abi.generated.ts is up to date (${entries.length} ABIs)`);
    return;
  }

  mkdirSync(WEB_LIB_DIR, { recursive: true });
  if (changed) {
    writeFileSync(TARGET, source, 'utf8');
  }

  if (existsSync(HANDWRITTEN)) {
    step('apps/web/src/lib/abi.ts left untouched');
  }

  process.stdout.write(`${table(['CONTRACT', 'EXPORT', 'FNS', 'EVENTS', 'ERRORS'], rows)}\n`);
  blank();

  const optionalCount = entries.length - REQUIRED.length;
  if (optionalCount < OPTIONAL.length) {
    warn(`${OPTIONAL.length - optionalCount} interface artifact(s) not found — skipped`);
  }
  ok(
    `${changed ? 'wrote' : 'unchanged'} apps/web/src/lib/abi.generated.ts (${entries.length} ABIs, ${
      Math.round(source.length / 1024)
    } KB)`,
  );
}

try {
  main();
} catch (error) {
  die(error instanceof Error ? error.message : String(error));
}
