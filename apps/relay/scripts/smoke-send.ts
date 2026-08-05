/**
 * End-to-end smoke test for the gasless send path against a LOCAL stack.
 *
 * Prerequisites: anvil on :8545 with the contracts deployed (`make deploy-local`)
 * and the relay on :8787 with a funded `RELAYER_PRIVATE_KEY`.
 *
 * What it proves, using only production code paths:
 *   1. identity derivation from a real EIP-712 signature (the exact ceremony the app runs)
 *   2. on-chain key registration (KeyRegistry)
 *   3. the $5 activation (treasury funds the user, approve, activate)
 *   4. seal -> POST /v1/blob -> signDrop -> POST /v1/send
 *   5. the relay batches it on chain and the indexer serves it back on /v1/drops
 *   6. the blob round-trips and decrypts to the original message
 *
 * Run: pnpm --filter @telehood/relay exec tsx scripts/smoke-send.ts
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  http,
  createPublicClient,
  createWalletClient,
  defineChain,
  parseAbi,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  IDENTITY_DOMAIN,
  IDENTITY_MESSAGE,
  IDENTITY_TYPES,
  deriveIdentity,
  open,
  seal,
  signDrop,
} from '@telehood/crypto';

const RPC = process.env['SMOKE_RPC'] ?? 'http://127.0.0.1:8545';
const RELAY = process.env['SMOKE_RELAY'] ?? 'http://localhost:8787';

/** anvil account #2 — a publicly known test key. */
const USER_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as Hex;
/** anvil account #0 — the local treasury holding the full supply. */
const TREASURY_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;

const chain = defineChain({
  id: 31337,
  name: 'anvil',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

const deploymentsPath = resolve(import.meta.dirname, '../../../contracts/deployments/31337.json');
const deployment = JSON.parse(readFileSync(deploymentsPath, 'utf8')) as Record<string, Hex>;

const abi = parseAbi([
  'function register(bytes32 x25519Pub, bytes32 ed25519Pub) external',
  'function quote() view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function transfer(address to, uint256 value) returns (bool)',
  'function activate() external',
  'function isActivated(address user) view returns (bool)',
]);

function toHex32(bytes: Uint8Array): Hex {
  return `0x${Buffer.from(bytes).toString('hex')}` as Hex;
}

function fail(step: string, detail: unknown): never {
  console.error(`FAIL at ${step}:`, detail);
  process.exit(1);
}

const publicClient = createPublicClient({ chain, transport: http(RPC) });
const user = createWalletClient({ chain, transport: http(RPC), account: privateKeyToAccount(USER_KEY) });
const treasury = createWalletClient({
  chain,
  transport: http(RPC),
  account: privateKeyToAccount(TREASURY_KEY),
});

async function write(
  client: typeof user,
  address: Hex,
  functionName: 'register' | 'approve' | 'transfer' | 'activate',
  args: readonly unknown[],
): Promise<void> {
  const hash = await client.writeContract({
    address,
    abi,
    functionName,
    args,
  } as Parameters<typeof client.writeContract>[0]);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') fail(functionName, receipt);
}

// 1 — identity, from the real EIP-712 ceremony
const signature = await user.signTypedData({
  domain: { ...IDENTITY_DOMAIN, chainId: chain.id },
  types: IDENTITY_TYPES,
  primaryType: 'Identity',
  message: IDENTITY_MESSAGE,
});
const identity = await deriveIdentity(signature);
console.log('1  identity derived');

// 2 — register keys
await write(user, deployment['keyRegistry'] as Hex, 'register', [
  toHex32(identity.x25519.publicKey),
  toHex32(identity.ed25519.publicKey),
]);
console.log('2  keys registered');

// 3 — activate ($5 once): treasury funds the exact quote, user approves + activates
const userAddress = user.account.address;
const alreadyActive = await publicClient.readContract({
  address: deployment['activation'] as Hex,
  abi,
  functionName: 'isActivated',
  args: [userAddress],
});
if (!alreadyActive) {
  const quote = await publicClient.readContract({
    address: deployment['activation'] as Hex,
    abi,
    functionName: 'quote',
  });
  await write(treasury, deployment['token'] as Hex, 'transfer', [userAddress, quote]);
  await write(user, deployment['token'] as Hex, 'approve', [deployment['activation'], quote]);
  await write(user, deployment['activation'] as Hex, 'activate', []);
  console.log(`3  activated (paid ${quote} wei of THOOD)`);
} else {
  console.log('3  already activated (previous run)');
}

// 4 — seal a message to ourselves, upload the blob, sign the drop, submit
const sealed = await seal(
  { v: 1, t: Date.now(), kind: 'text', body: 'smoke: gasless, signed, anchored' },
  identity.x25519.publicKey,
);

const upload = await fetch(`${RELAY}/v1/blob`, {
  method: 'POST',
  headers: { 'content-type': 'application/octet-stream' },
  body: Buffer.from(sealed.blob),
});
if (!upload.ok) fail('blob upload', await upload.text());

const drop = {
  convoId: `0x${'0'.repeat(64)}` as Hex,
  ephPub: sealed.ephPub,
  blobRef: sealed.blobRef,
  viewTag: sealed.viewTag,
  size: sealed.size,
};
const dropSignature = await signDrop(drop, identity.ed25519.privateKey);

const send = await fetch(`${RELAY}/v1/send`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sender: userAddress, signature: dropSignature, drop }),
});
if (!send.ok) fail('/v1/send', await send.text());
console.log('4  accepted by the relay:', await send.json());

// 5 — the relay batches on chain; the indexer must serve the drop back
const deadline = Date.now() + 30_000;
let found = false;
while (Date.now() < deadline && !found) {
  await new Promise((r) => setTimeout(r, 1_000));
  const res = await fetch(`${RELAY}/v1/drops?since=0&limit=1000`);
  if (!res.ok) continue;
  const body = (await res.json()) as { drops: { blobRef: string }[] };
  found = body.drops.some((d) => d.blobRef.toLowerCase() === sealed.blobRef.toLowerCase());
}
if (!found) fail('indexer', 'drop never appeared on /v1/drops within 30s');
console.log('5  anchored on chain and indexed');

// 6 — fetch the blob back and decrypt it
const blobRes = await fetch(`${RELAY}/v1/blob/${sealed.blobRef}`);
if (!blobRes.ok) fail('blob fetch', blobRes.status);
const roundTripped = new Uint8Array(await blobRes.arrayBuffer());
const opened = await open(roundTripped, identity.x25519.privateKey, identity.x25519.publicKey);
if (opened?.body !== 'smoke: gasless, signed, anchored') fail('decrypt', opened);
console.log('6  blob round-tripped and decrypted');

console.log('\nPASS — the full gasless path works end to end.');
process.exit(0);
