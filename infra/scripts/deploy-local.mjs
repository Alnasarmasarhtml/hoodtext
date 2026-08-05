#!/usr/bin/env node
/**
 * deploy-local.mjs — deploy the TeleHood contract set to a local anvil node and
 * write the resulting addresses back into `packages/crypto/src/deployments.ts`.
 *
 *   node infra/scripts/deploy-local.mjs [options]
 *
 * Options:
 *   --rpc <url>          JSON-RPC endpoint          (default $LOCAL_RPC_URL or http://127.0.0.1:8545)
 *   --key <0x...>        deployer private key       (default $DEPLOYER_PRIVATE_KEY or anvil account 0)
 *   --treasury <0x...>   treasury address           (default $TREASURY_ADDRESS or the deployer)
 *   --rate <wei>         initial thoodPerUsd, 18dp   (default $THOOD_PER_USD or 1000e18)
 *   --dry-run            do everything except rewriting deployments.ts
 *
 * Exit codes: 0 success, 1 failure.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { banner, blank, die, note, ok, step, table, warn } from './lib/console.mjs';
import { isAddress, isZeroAddress, selfTest, toChecksumAddress, ZERO_ADDRESS } from './lib/keccak.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONTRACTS_DIR = join(REPO_ROOT, 'contracts');
const DEPLOY_SCRIPT = join(CONTRACTS_DIR, 'script', 'Deploy.s.sol');
const DEPLOYMENTS_TS = join(REPO_ROOT, 'packages', 'crypto', 'src', 'deployments.ts');

const LOCAL_CHAIN_ID = 31337;
const ROBINHOOD_CHAIN_ID = 4663;

/** The well-known anvil account #0. Public, deterministic, worthless — safe to hard-code. */
const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ANVIL_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

/**
 * The nine addresses of a TeleHood deployment, in the order they are deployed.
 * The key is the field name in `Deployment` (SPEC 5); the value is the Solidity
 * contract name, which is how the broadcast artifact identifies it.
 * @type {readonly [string, string][]}
 */
const CONTRACTS = [
  ['token', 'TeleHoodToken'],
  ['priceSource', 'ManualPriceSource'],
  ['revenueVault', 'RevenueVault'],
  ['activation', 'Activation'],
  ['groupRegistry', 'GroupRegistry'],
  ['keyRegistry', 'KeyRegistry'],
  ['anchors', 'Anchors'],
  ['perks', 'Perks'],
  ['handles', 'Handles'],
];

const DEPLOYMENT_KEYS = CONTRACTS.map(([key]) => key);

// ─── argument + env plumbing ─────────────────────────────────────────────────

/**
 * @param {string[]} argv
 * @returns {Map<string, string | true>}
 */
function parseArgs(argv) {
  /** @type {Map<string, string | true>} */
  const args = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args.set(name, next);
      i += 1;
    } else {
      args.set(name, true);
    }
  }
  return args;
}

/**
 * Load `<root>/.env` into process.env without overriding anything already set.
 * Deliberately tiny: KEY=VALUE, `#` comments, optional surrounding quotes.
 * @returns {void}
 */
function loadDotEnv() {
  const path = join(REPO_ROOT, '.env');
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    if (value !== '' && process.env[key] === undefined) process.env[key] = value;
  }
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function asString(value) {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

// ─── chain preflight ─────────────────────────────────────────────────────────

/**
 * @param {string} rpcUrl
 * @param {string} method
 * @param {unknown[]} params
 * @returns {Promise<string>}
 */
async function rpcCall(rpcUrl, method, params) {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  /** @type {{ result?: string, error?: { message?: string } }} */
  const body = await response.json();
  if (body.error) throw new Error(body.error.message ?? 'JSON-RPC error');
  if (typeof body.result !== 'string') throw new Error(`unexpected response to ${method}`);
  return body.result;
}

/**
 * Confirm anvil is up and reachable, retrying briefly so `make chain &&
 * make deploy-local` in quick succession does not race the node's startup.
 * @param {string} rpcUrl
 * @returns {Promise<{ chainId: number, blockNumber: number }>}
 */
async function waitForChain(rpcUrl) {
  /** @type {unknown} */
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const [chainIdHex, blockHex] = await Promise.all([
        rpcCall(rpcUrl, 'eth_chainId', []),
        rpcCall(rpcUrl, 'eth_blockNumber', []),
      ]);
      return { chainId: Number.parseInt(chainIdHex, 16), blockNumber: Number.parseInt(blockHex, 16) };
    } catch (error) {
      lastError = error;
      if (attempt < 5) await new Promise((r) => setTimeout(r, 600));
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  return die(`no JSON-RPC node answering at ${rpcUrl} (${reason})`, [
    'Start a local chain in another terminal:',
    '  make chain          # anvil --chain-id 31337 --block-time 1',
    'Or point this script elsewhere:',
    '  node infra/scripts/deploy-local.mjs --rpc <url>',
  ]);
}

// ─── forge ───────────────────────────────────────────────────────────────────

/**
 * Read the deploy script and pull out the name of the contract that extends
 * `Script`, so a repo that names it something other than `Deploy` still works.
 * @returns {string}
 */
function detectScriptContract() {
  const source = readFileSync(DEPLOY_SCRIPT, 'utf8');
  const withBase = source.match(/contract\s+([A-Za-z_]\w*)\s+is\s+[^{]*\bScript\b/);
  if (withBase) return withBase[1];
  const anyContract = source.match(/contract\s+([A-Za-z_]\w*)/);
  if (anyContract) return anyContract[1];
  return 'Deploy';
}

/**
 * @param {{ rpcUrl: string, privateKey: string, treasury: string, rate: string }} config
 * @returns {void}
 */
function runForgeDeploy(config) {
  const contractName = detectScriptContract();
  const target = `script/Deploy.s.sol:${contractName}`;

  const args = [
    'script',
    target,
    '--rpc-url',
    config.rpcUrl,
    '--private-key',
    config.privateKey,
    '--broadcast',
    '--slow',
    '-vv',
  ];

  // `vm.writeJson` cannot create the directory itself, and foundry.toml only grants
  // read-write on ./deployments — so make sure it is there before the script runs.
  mkdirSync(join(CONTRACTS_DIR, 'deployments'), { recursive: true });

  step(`forge ${args.slice(0, 2).join(' ')} --broadcast`);

  // The deploy script may read any of these; providing all of the common spellings
  // means we do not have to guess which convention contracts/ settled on.
  const env = {
    ...process.env,
    DEPLOYER_PRIVATE_KEY: config.privateKey,
    PRIVATE_KEY: config.privateKey,
    TREASURY_ADDRESS: config.treasury,
    TREASURY: config.treasury,
    TEXT_PER_USD: config.rate,
    INITIAL_TEXT_PER_USD: config.rate,
    FOUNDRY_PROFILE: process.env.FOUNDRY_PROFILE ?? 'default',
  };

  const result = spawnSync('forge', args, { cwd: CONTRACTS_DIR, stdio: 'inherit', env });

  if (result.error) {
    const isMissing = /** @type {NodeJS.ErrnoException} */ (result.error).code === 'ENOENT';
    die(isMissing ? '`forge` is not on PATH' : `could not run forge: ${result.error.message}`, [
      'Install Foundry: curl -L https://foundry.paradigm.xyz | bash && foundryup',
    ]);
  }
  if (result.status !== 0) {
    die(`forge script exited with code ${result.status}`, [
      'The deploy transaction was rejected or the script reverted. The forge output above has the reason.',
    ]);
  }
}

// ─── reading the addresses back ──────────────────────────────────────────────

/**
 * @param {string} path
 * @returns {unknown}
 */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Pull the seven addresses out of `contracts/deployments/<chainId>.json`.
 * Accepts either the `Deployment` field names or the Solidity contract names as
 * keys, matched case-insensitively, and tolerates one level of nesting.
 * @param {unknown} json
 * @returns {Record<string, string>}
 */
function addressesFromDeploymentsJson(json) {
  /** @type {Map<string, string>} */
  const flat = new Map();

  /** @param {unknown} node @param {number} depth @returns {void} */
  const walk = (node, depth) => {
    if (node === null || typeof node !== 'object' || Array.isArray(node) || depth > 3) return;
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string' && isAddress(value)) {
        const normalized = key.toLowerCase();
        if (!flat.has(normalized)) flat.set(normalized, value);
      } else {
        walk(value, depth + 1);
      }
    }
  };
  walk(json, 0);

  /** @type {Record<string, string>} */
  const found = {};
  for (const [field, contractName] of CONTRACTS) {
    const candidate = flat.get(field.toLowerCase()) ?? flat.get(contractName.toLowerCase());
    if (candidate !== undefined) found[field] = candidate;
  }
  return found;
}

/**
 * Fallback: reconstruct the addresses from the forge broadcast artifact, which
 * records every CREATE with its contract name.
 * @returns {Record<string, string>}
 */
function addressesFromBroadcast() {
  const broadcastRoot = join(CONTRACTS_DIR, 'broadcast');
  if (!existsSync(broadcastRoot)) return {};

  /** @type {string[]} */
  const runFiles = [];
  for (const scriptDir of readdirSync(broadcastRoot)) {
    const runPath = join(broadcastRoot, scriptDir, String(LOCAL_CHAIN_ID), 'run-latest.json');
    if (existsSync(runPath)) runFiles.push(runPath);
  }
  if (runFiles.length === 0) return {};

  /** @type {Record<string, string>} */
  const found = {};
  for (const runPath of runFiles) {
    /** @type {any} */
    let run;
    try {
      run = readJson(runPath);
    } catch {
      continue;
    }
    const transactions = Array.isArray(run?.transactions) ? run.transactions : [];
    for (const tx of transactions) {
      if (tx?.transactionType !== 'CREATE' && tx?.transactionType !== 'CREATE2') continue;
      const name = typeof tx?.contractName === 'string' ? tx.contractName : '';
      const address = typeof tx?.contractAddress === 'string' ? tx.contractAddress : '';
      if (!isAddress(address)) continue;
      const entry = CONTRACTS.find(([, contractName]) => contractName === name);
      // Later runs win, so a redeploy overwrites a stale address.
      if (entry) found[entry[0]] = address;
    }
  }
  return found;
}

/**
 * @param {string} rpcUrl
 * @param {Record<string, string>} addresses
 * @returns {Promise<void>}
 */
async function assertCodeAtAddresses(rpcUrl, addresses) {
  /** @type {string[]} */
  const empty = [];
  for (const [field, address] of Object.entries(addresses)) {
    try {
      const code = await rpcCall(rpcUrl, 'eth_getCode', [address, 'latest']);
      if (code === '0x' || code === '0x0') empty.push(`${field} @ ${address}`);
    } catch (error) {
      warn(`could not verify code at ${field} (${error instanceof Error ? error.message : error})`);
    }
  }
  if (empty.length > 0) {
    die('the deploy reported addresses that hold no bytecode on this chain:', [
      ...empty,
      'The node was probably restarted between the deploy and this check. Re-run make deploy-local.',
    ]);
  }
}

// ─── rewriting packages/crypto/src/deployments.ts ────────────────────────────

/**
 * Escape a string for literal use inside a RegExp.
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Every spelling the key of a chain entry may take in the source:
 * `31337:`, `'31337':`, `"31337":`, and computed `[SOME_CONST]:` where that const
 * is bound to the chain id. Resolving the alias matters — packages/crypto is free
 * to write `const LOCAL_CHAIN_ID = 31337` and key the record with it.
 * @param {string} source
 * @param {number} chainId
 * @returns {string[]}
 */
function keySpellings(source, chainId) {
  const spellings = [`${chainId}`, `'${chainId}'`, `"${chainId}"`];
  const alias = new RegExp(
    `\\bconst\\s+([A-Za-z_$][\\w$]*)\\s*(?::[^=;]+)?=\\s*${chainId}\\b`,
    'g',
  );
  for (const match of source.matchAll(alias)) spellings.push(`[${match[1]}]`);
  return spellings;
}

/**
 * Walk `source` from `start`, returning the index just past the value expression
 * that begins there. Strings, template literals and comments are respected, and
 * nesting is tracked across all three bracket kinds, so the scan stops at the
 * comma or closing brace that genuinely terminates the entry.
 * @param {string} source
 * @param {number} start index of the first character of the value
 * @returns {number} exclusive end index
 */
function scanValueExpression(source, start) {
  let depth = 0;
  /** @type {string | null} */
  let quote = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (char === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{' || char === '[' || char === '(') {
      depth += 1;
      continue;
    }
    if (char === '}' || char === ']' || char === ')') {
      if (depth === 0) return i; // the brace closing the record
      depth -= 1;
      continue;
    }
    if (char === ',' && depth === 0) return i;
  }
  return source.length;
}

/**
 * Locate one chain's entry in `DEPLOYMENTS`, whatever shape its value takes —
 * an inline object literal, a call such as `undeployed()`, or an identifier.
 * @param {string} source
 * @param {number} chainId
 * @returns {{ valueStart: number, valueEnd: number, indent: string } | null}
 */
function findChainEntry(source, chainId) {
  for (const spelling of keySpellings(source, chainId)) {
    const opener = new RegExp(`(^|[\\s,{])(${escapeRegExp(spelling)})\\s*:\\s*`, 'm');
    const match = opener.exec(source);
    if (!match) continue;

    const valueStart = match.index + match[0].length;
    // Trim the whitespace the scan runs through before the terminating `,` or `}`
    // so a last entry with no trailing comma does not lose its line break.
    let valueEnd = scanValueExpression(source, valueStart);
    while (valueEnd > valueStart && /\s/.test(source[valueEnd - 1])) valueEnd -= 1;

    const lineStart = source.lastIndexOf('\n', match.index) + 1;
    const indentMatch = /^[ \t]*/.exec(source.slice(lineStart));
    return { valueStart, valueEnd, indent: indentMatch === null ? '  ' : indentMatch[0] };
  }
  return null;
}

/**
 * @param {string} block
 * @returns {Record<string, string>}
 */
function addressesFromBlock(block) {
  /** @type {Record<string, string>} */
  const found = {};
  for (const field of DEPLOYMENT_KEYS) {
    const match = new RegExp(`\\b${field}\\s*:\\s*(['"\`])(0x[0-9a-fA-F]{40})\\1`).exec(block);
    if (match) found[field] = match[2];
  }
  return found;
}

/**
 * @param {Record<string, string>} addresses
 * @param {string} indent
 * @returns {string}
 */
function renderEntry(addresses, indent) {
  return DEPLOYMENT_KEYS.map(
    (field) => `${indent}${field}: '${addresses[field] ?? ZERO_ADDRESS}',`,
  ).join('\n');
}

/**
 * Produce the whole file. Used when `deployments.ts` does not exist yet, or when
 * its 31337 entry cannot be updated surgically. Matches the API in SPEC 5 exactly.
 * @param {Record<string, string>} local
 * @param {Record<string, string>} robinhood
 * @returns {string}
 */
function renderDeploymentsFile(local, robinhood) {
  return `// Addresses for chain ${LOCAL_CHAIN_ID} are written by \`node infra/scripts/deploy-local.mjs\`.
// The ${ROBINHOOD_CHAIN_ID} (Robinhood Chain) entry is maintained by hand and is preserved across runs.

export interface Deployment {
  token: \`0x\${string}\`;
  priceSource: \`0x\${string}\`;
  revenueVault: \`0x\${string}\`;
  activation: \`0x\${string}\`;
  groupRegistry: \`0x\${string}\`;
  keyRegistry: \`0x\${string}\`;
  anchors: \`0x\${string}\`;
  perks: \`0x\${string}\`;
  handles: \`0x\${string}\`;
}

export const DEPLOYMENTS: Record<number, Deployment> = {
  // anvil — local development
  ${LOCAL_CHAIN_ID}: {
${renderEntry(local, '    ')}
  },
  // Robinhood Chain — mainnet
  ${ROBINHOOD_CHAIN_ID}: {
${renderEntry(robinhood, '    ')}
  },
};

/**
 * @throws {Error} when no deployment is recorded for \`chainId\`
 */
export function getDeployment(chainId: number): Deployment {
  const deployment = DEPLOYMENTS[chainId];
  if (deployment === undefined) {
    const known = Object.keys(DEPLOYMENTS).join(', ');
    throw new Error(
      \`TeleHood is not deployed on chain \${chainId}. Known chains: \${known}.\`,
    );
  }
  return deployment;
}
`;
}

/**
 * Rewrite the 31337 addresses in `packages/crypto/src/deployments.ts`.
 *
 * `packages/crypto` owns this file, so the update is surgical: only the value of
 * the 31337 entry is replaced, with a plain object literal carrying the real
 * addresses. Every other byte — the interface, the helpers, `getDeployment`, the
 * comments and the whole 4663 entry — is left exactly as it was. That holds
 * regardless of how the entry is currently written: an inline object literal, a
 * factory call like `undeployed()`, or a shared constant.
 *
 * A full regeneration is the last resort, used only when the file is missing or
 * has no 31337 entry at all.
 *
 * @param {Record<string, string>} local
 * @param {boolean} dryRun
 * @returns {{ mode: 'surgical' | 'regenerated' | 'created', robinhood: Record<string, string>, previous: string }}
 */
function writeDeploymentsTs(local, dryRun) {
  if (!existsSync(DEPLOYMENTS_TS)) {
    warn(`${relative(DEPLOYMENTS_TS)} does not exist yet — creating it`);
    note('packages/crypto owns this file; a full regeneration matches the API in SPEC 5.');
    if (!dryRun) {
      mkdirSync(dirname(DEPLOYMENTS_TS), { recursive: true });
      writeFileSync(DEPLOYMENTS_TS, renderDeploymentsFile(local, {}), 'utf8');
    }
    return { mode: 'created', robinhood: {}, previous: '(none)' };
  }

  const source = readFileSync(DEPLOYMENTS_TS, 'utf8');

  const robinhoodEntry = findChainEntry(source, ROBINHOOD_CHAIN_ID);
  const robinhood = robinhoodEntry
    ? addressesFromBlock(source.slice(robinhoodEntry.valueStart, robinhoodEntry.valueEnd))
    : {};

  const localEntry = findChainEntry(source, LOCAL_CHAIN_ID);
  if (localEntry !== null) {
    // One line, for the log. An inline object literal is many lines long.
    const raw = source.slice(localEntry.valueStart, localEntry.valueEnd).trim().replace(/\s+/g, ' ');
    const previous = raw.length > 60 ? `${raw.slice(0, 59)}…` : raw;
    const fieldIndent = `${localEntry.indent}  `;
    const literal = `{\n${renderEntry(local, fieldIndent)}\n${localEntry.indent}}`;
    const next = source.slice(0, localEntry.valueStart) + literal + source.slice(localEntry.valueEnd);
    if (!dryRun) writeFileSync(DEPLOYMENTS_TS, next, 'utf8');
    return { mode: 'surgical', robinhood, previous };
  }

  warn(`no ${LOCAL_CHAIN_ID} entry found in deployments.ts — regenerating the file`);
  if (!robinhoodEntry) {
    warn(`no ${ROBINHOOD_CHAIN_ID} entry found either — writing zero addresses for it`);
  }
  if (!dryRun) writeFileSync(DEPLOYMENTS_TS, renderDeploymentsFile(local, robinhood), 'utf8');
  return { mode: 'regenerated', robinhood, previous: '(whole file replaced)' };
}

/**
 * @param {string} path
 * @returns {string}
 */
function relative(path) {
  return path.startsWith(REPO_ROOT) ? path.slice(REPO_ROOT.length + 1) : path;
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  selfTest();
  loadDotEnv();

  const args = parseArgs(process.argv.slice(2));
  const dryRun = args.get('dry-run') === true;

  const rpcUrl =
    asString(args.get('rpc')) ?? asString(process.env.LOCAL_RPC_URL) ?? 'http://127.0.0.1:8545';
  const privateKey =
    asString(args.get('key')) ?? asString(process.env.DEPLOYER_PRIVATE_KEY) ?? ANVIL_KEY;
  const treasuryRaw =
    asString(args.get('treasury')) ?? asString(process.env.TREASURY_ADDRESS) ?? ANVIL_ADDRESS;
  const rate = asString(args.get('rate')) ?? asString(process.env.TEXT_PER_USD) ?? '1000000000000000000000';

  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    die('deployer key must be a 0x-prefixed 32-byte hex private key', [
      'Set DEPLOYER_PRIVATE_KEY in .env, or pass --key.',
      'Leaving it unset uses the standard public anvil account #0.',
    ]);
  }
  if (!isAddress(treasuryRaw)) {
    die(`treasury is not a valid address: ${treasuryRaw}`, ['Set TREASURY_ADDRESS in .env, or pass --treasury.']);
  }
  const treasury = toChecksumAddress(treasuryRaw);

  banner('TeleHood — local deploy');
  note(`rpc       ${rpcUrl}`);
  note(`treasury  ${treasury}`);
  note(`deployer  ${privateKey === ANVIL_KEY ? `${ANVIL_ADDRESS} (anvil #0)` : 'from DEPLOYER_PRIVATE_KEY'}`);
  blank();

  if (!existsSync(DEPLOY_SCRIPT)) {
    die(`missing ${relative(DEPLOY_SCRIPT)}`, [
      'The contracts package owns that file. Nothing can be deployed until it exists.',
    ]);
  }

  step(`checking for a node on ${rpcUrl}`);
  const chain = await waitForChain(rpcUrl);
  if (chain.chainId !== LOCAL_CHAIN_ID) {
    die(`the node at ${rpcUrl} reports chain id ${chain.chainId}, expected ${LOCAL_CHAIN_ID}`, [
      'This script only deploys to the local anvil chain.',
      'Start it with: make chain',
    ]);
  }
  ok(`anvil up — chain ${chain.chainId}, block ${chain.blockNumber}`);

  runForgeDeploy({ rpcUrl, privateKey, treasury, rate });
  blank();

  const jsonPath = join(CONTRACTS_DIR, 'deployments', `${LOCAL_CHAIN_ID}.json`);
  /** @type {Record<string, string>} */
  let addresses = {};
  /** @type {string} */
  let addressSource;

  if (existsSync(jsonPath)) {
    addresses = addressesFromDeploymentsJson(readJson(jsonPath));
    addressSource = relative(jsonPath);
  } else {
    warn(`${relative(jsonPath)} was not written by the deploy script`);
    addresses = {};
    addressSource = 'contracts/broadcast/**/run-latest.json';
  }

  const missing = DEPLOYMENT_KEYS.filter((field) => !isAddress(addresses[field] ?? ''));
  if (missing.length > 0) {
    const fallback = addressesFromBroadcast();
    for (const field of missing) {
      if (isAddress(fallback[field] ?? '')) addresses[field] = fallback[field];
    }
    if (existsSync(jsonPath) && Object.keys(fallback).length > 0) {
      addressSource = `${addressSource} + broadcast artifact`;
    } else if (!existsSync(jsonPath)) {
      addressSource = 'contracts/broadcast/**/run-latest.json';
    }
  }

  const stillMissing = DEPLOYMENT_KEYS.filter(
    (field) => !isAddress(addresses[field] ?? '') || isZeroAddress(addresses[field] ?? ''),
  );
  if (stillMissing.length > 0) {
    die(`the deploy did not yield an address for: ${stillMissing.join(', ')}`, [
      `Looked in ${relative(jsonPath)} and contracts/broadcast/**/run-latest.json.`,
      'SPEC 4.8 requires script/Deploy.s.sol to vm.writeJson every address to ./deployments/<chainid>.json.',
    ]);
  }

  /** @type {Record<string, string>} */
  const checksummed = {};
  for (const field of DEPLOYMENT_KEYS) checksummed[field] = toChecksumAddress(addresses[field]);

  await assertCodeAtAddresses(rpcUrl, checksummed);

  const result = writeDeploymentsTs(checksummed, dryRun);

  ok(`addresses read from ${addressSource}`);
  blank();
  process.stdout.write(
    `${table(
      ['CONTRACT', 'FIELD', 'ADDRESS'],
      CONTRACTS.map(([field, name]) => [name, field, checksummed[field]]),
    )}\n`,
  );
  blank();

  if (dryRun) {
    warn(`--dry-run: ${relative(DEPLOYMENTS_TS)} was NOT modified (would have been ${result.mode})`);
  } else {
    ok(`${relative(DEPLOYMENTS_TS)} updated (${result.mode}), chain ${LOCAL_CHAIN_ID}`);
    const preserved = DEPLOYMENT_KEYS.filter((field) => isAddress(result.robinhood[field] ?? '')).length;
    if (result.mode === 'surgical') {
      note(`replaced the ${LOCAL_CHAIN_ID} value only — was ${result.previous}`);
      note(`chain ${ROBINHOOD_CHAIN_ID} entry and the rest of the file untouched`);
    } else {
      note(`chain ${ROBINHOOD_CHAIN_ID} entry carried over (${preserved}/${DEPLOYMENT_KEYS.length} addresses)`);
    }
  }

  blank();
  note('Next: node infra/scripts/sync-abis.mjs   (or: make build)');
}

main().catch((error) => {
  die(error instanceof Error ? error.message : String(error), [
    error instanceof Error && error.stack ? error.stack.split('\n').slice(1, 4).join('\n     ') : '',
  ].filter(Boolean));
});
