# HOODGRAM — Canonical Build Spec (v4 — $5 FOREVER + ROOM RENT)

**This file is the single source of truth. Every agent conforms to the interfaces here exactly.
Do not invent alternative names, signatures, routes, or design tokens. If something is missing,
choose the simplest option consistent with what's here and note it in your return value.**

> **THE ECONOMIC MODEL:** an account is a **$5 one-time** activation, forever. A **room** (group)
> costs **$10/month**, paid by whoever runs it — members are free. **Messages are never charged**
> and are sent **gasless through the relay by default** (no wallet popup; the sender's address never
> appears on chain). Half of every payment is shared with **$THOOD holders**, pro-rata by holdings —
> no staking, no lock-up, no deposit. Holder perks are a **status ladder** (badges, short handles,
> capacity), never a claim on anyone's revenue. Any reference you find elsewhere to monthly
> subscription tiers (CHAT/GROUP/RELAYER), StakeGate, or per-message fees is stale: ignore it and
> follow this document.

---

## 0. Product

**HoodGram** — encrypted messaging with every message anchored on Robinhood Chain. Token **$THOOD**.

| Price | What it buys |
|---|---|
| **$5, once** | Your account, forever. Also the spam wall: every account on HoodGram cost somebody five dollars, so there are no bot floods. Includes an @handle. |
| **$10 / month per room** | A room, paid by its admin. Members free. Anyone may pay a room's rent (paying grants no control). Lapse blocks *new messages only* — history, keys, membership and administration all survive, and paying again reopens the room exactly as it was. |
| **$0 per message** | Relayed sends cost the user nothing (the relay batch-posts on chain from its own funded key). Self-posting is always available at ~1¢ gas. |

- Prices are set **in USD on-chain** and converted to $THOOD at purchase time (`IPriceSource`).
- Rooms: buy 1–24 months at a time; paying early extends from the current expiry, never burns time;
  opt-in **auto-renew** (admin approves an allowance once; permissionless `renewFor` buys one month
  inside a 3-day window). Cancelling = switching it off.
- Anyone may **sponsor a friend** (`activateFor`) — the payer pays, the recipient owns the account.

**50% of every payment goes to $THOOD holders, pro-rata by holdings.** Checkpointed balances, weekly
permissionless epoch seals, `claim`/`claimMany`, 180-day claim window — no staking anywhere.

**The holder status ladder** (`Perks`, thresholds in bps of supply, owner-tunable):

| Tier | Hold | Unlocks |
|---|---|---|
| 1 RESIDENT | 0.05% (500k) | Holder badge beside your name in every chat |
| 2 BLOCK CAPTAIN | 0.1% (1M) | + 4-char handles, bigger uploads, bigger rooms |
| 3 DISTRICT | 0.25% (2.5M) | + 3-char handles, early features |
| 4 KINGPIN | 0.5% (5M) | + 2-char handles, broadcast rooms |

A tier is judged on the **lower** of the live balance and the balance at the **last sealed revenue
snapshot** — it must be held through a weekly seal, cannot be flash-bought, and selling drops it
immediately. The revenue share itself stays pure pro-rata at every size; the ladder is status and
capacity only.

The honest security claim (use this copy everywhere — do NOT overclaim):

> **Message contents are unreadable by anyone but the recipient. Metadata is minimized, not eliminated.**

What we deliver: E2E encryption (X25519 + XSalsa20-Poly1305), per-message ephemeral sender keys,
fixed-size padded envelopes (no length leak), view-tag scanning (no plaintext recipient on chain),
and relayed posting by default (no sender address on chain). What we do NOT claim: anonymity against
a global observer, forward secrecy against long-term key compromise, or protection from the
sequencer operator observing timing. The relay holds only ciphertext and cannot forge a sender's
signature; it *could* refuse to post (censorship), which is why self-posting always remains open.
Say all of this plainly in the FAQ.

---

## 1. Chain config (VERIFIED LIVE 2026-07-29)

```
name:        Robinhood Chain
chainId:     4663            (0x1237)
rpc:         https://rpc.mainnet.chain.robinhood.com/
explorer:    https://robinhoodchain.blockscout.com/
currency:    ETH (18)
gasPrice:    ~0.0275 gwei observed
ordering:    FCFS at sequencer, no priority-fee jumping
```
Local dev chain: `anvil` on `http://127.0.0.1:8545`, chainId 31337.

## 2. Repo layout & strict ownership

```
contracts/                  src/ test/ script/
packages/crypto/            @hoodgram/crypto — isomorphic TS
apps/relay/                 @hoodgram/relay — Fastify + node:sqlite + indexer + WS + gasless send
apps/web/                   @hoodgram/web — Next.js 15
infra/                      deploy scripts, fit-check, Makefile
docs/                       orchestrator-owned
```

## 3. Toolchain (pinned — do not substitute)

- Solidity `0.8.28`, Foundry, OpenZeppelin v5, forge-std.
- Node 24, **pnpm** workspaces, TypeScript 5.7 strict.
- Crypto: `libsodium-wrappers-sumo` (+ types), `@noble/hashes`.
- Chain client: `viem` 2.x everywhere; `wagmi` 2.x in web only.
- Relay: `fastify` 5, `@fastify/websocket`, `@fastify/cors`, `@fastify/rate-limit`, `zod`, built-in
  `node:sqlite` — no native deps.
- Web: `next` 15 (App Router) + React 19, `geist`, `gsap`, `lenis`, `zustand`.
- Tests: `forge test` for Solidity, `vitest` for TS. **No Docker.**

---

## 4. Contracts — EXACT interfaces

`pragma solidity ^0.8.28;`. OZ `Ownable` (constructor takes `initialOwner`). Custom errors, never
revert strings. Full NatSpec on every external function.

Deploy order (`script/Deploy.s.sol`): `HoodGramToken` → `ManualPriceSource` → `RevenueVault` →
`Activation` → `GroupRegistry` → `KeyRegistry` → `Anchors` → `Perks` → `Handles`. Wiring:
`vault.setNotifier(activation, true)`, `vault.setNotifier(groupRegistry, true)`,
`anchors.setRelayer($RELAYER_ADDRESS, true)`, `vault.setExcluded(treasury/vault, true)`. Writes
`./deployments/<chainid>.json`.

### 4.1 `HoodGramToken.sol` — ERC20 with historical balance checkpoints

Name `HoodGram`, symbol `THOOD`, 18 decimals, `MAX_SUPPLY = 1_000_000_000e18` minted once to the
treasury. No tax, no blacklist, no owner, no pause. `balanceOfAt` / `totalSupplyAt` via
`Checkpoints.Trace208` on raw balances (NEVER `ERC20Votes`); `FutureLookup()` on
`timepoint >= block.number`. Unchanged from v3.

### 4.2 `ManualPriceSource.sol` + `IPriceSource`

```solidity
interface IPriceSource { function thoodPerUsd() external view returns (uint256); } // 18dp per $1
```
Owner-set `rate`, non-zero, swappable for a TWAP later.

### 4.3 `Activation.sol` — the $5 handshake

```solidity
interface IActivation {
    function isActivated(address user) external view returns (bool);
    function activatedAt(address user) external view returns (uint64);
}

contract Activation is IActivation, Ownable {
    IERC20 public immutable THOOD;
    IRevenueVault public vault;           // setVault
    IPriceSource public priceSource;      // setPriceSource
    uint256 public priceUsd;              // default 5e18; setPriceUsd (non-zero)

    function quote() public view returns (uint256 thoodAmount);   // priceUsd * thoodPerUsd / 1e18
    function activate() external;                                  // once per address, forever
    function activateFor(address user) external;                   // sponsor: caller pays, user owns
    function activateWithPermit(uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external;
    function grant(address user) external onlyOwner;               // comped, never touches the vault

    event Activated(address indexed user, address indexed payer, uint256 thoodPaid, uint64 at);
    event Granted(address indexed user, uint64 at);
    // PriceSet / PriceSourceSet / VaultSet
    // errors: AlreadyActivated, InvalidPrice, PermitFailed, ZeroAddress
}
```
Payment: `THOOD.safeTransferFrom(payer, vault, quote())` then `vault.notifyRevenue(amount)` —
100% reaches the vault; the 50/50 split happens there. A failed permit still succeeds when the
standing allowance covers `value`; otherwise `PermitFailed`.

### 4.4 `GroupRegistry.sol` — rooms with rent

```solidity
interface IRooms { function isActive(bytes32 groupId) external view returns (bool); }

contract GroupRegistry is IRooms, Ownable {
    uint64 public constant MONTH = 30 days;
    uint8  public constant MAX_MONTHS = 24;
    uint64 public constant RENEW_WINDOW = 3 days;
    uint256 public rentUsdPerMonth;                    // default 10e18; setRentUsdPerMonth

    struct Group { address admin; uint32 epoch; uint64 createdAt; bytes32 memberRoot;
                   uint64 paidUntil; bool autoRenew; bool exists; }
    mapping(bytes32 => Group) public groups;

    function isActive(bytes32 groupId) public view returns (bool);       // exists && paidUntil > now
    function quoteRent(uint8 months) public view returns (uint256);      // validates 1..24
    function previewPaidUntil(bytes32 groupId, uint8 months) external view returns (uint64);

    function createGroup(bytes32 groupId, bytes32 memberRoot, uint8 months) external; // requires isActivated(sender)
    function payRent(bytes32 groupId, uint8 months) external;            // ANYONE; extends max(now, paidUntil)
    function renewFor(bytes32 groupId) external;                         // permissionless keeper; admin allowance; 1 month; RENEW_WINDOW
    function setAutoRenew(bytes32 groupId, bool on) external;            // admin only
    function rotateEpoch(bytes32 groupId, bytes32 newMemberRoot) external; // admin only, NOT rent-gated
    function transferAdmin(bytes32 groupId, address newAdmin) external;  // admin only; switches autoRenew OFF
    function grantRent(bytes32 groupId, uint8 months) external onlyOwner;

    event GroupCreated(bytes32 indexed groupId, address indexed admin, bytes32 memberRoot, uint8 months, uint256 thoodPaid, uint64 paidUntil);
    event RentPaid(bytes32 indexed groupId, address indexed payer, uint8 months, uint256 thoodPaid, uint64 paidUntil);
    event RentGranted(bytes32 indexed groupId, uint8 months, uint64 paidUntil);
    event AutoRenewSet(bytes32 indexed groupId, bool on);
    // EpochRotated / AdminTransferred / RentPriceSet / ActivationSet / PriceSourceSet / VaultSet
    // errors: NotActivated, NotAdmin, InvalidGroup, GroupExists, UnknownGroup, InvalidMonths,
    //         InvalidPrice, ZeroAddress, NotDue, AutoRenewOff
}
```
Rent payments move payer→vault then `notifyRevenue`, exactly like activation. Administration is
deliberately never rent-gated.

### 4.5 `RevenueVault.sol` — the 50/50 split (mechanics unchanged from v3)

Changes from v3 only:
- `address public subscription` → `mapping(address => bool) public isNotifier` +
  `setNotifier(address, bool)`; `notifyRevenue` requires `isNotifier[msg.sender]`
  (error `NotNotifier`, event `NotifierSet`). Notifiers: `Activation`, `GroupRegistry`.
- New view `latestSnapshot() returns (uint48)` — the newest epoch's snapshot block, 0 before the
  first seal. `Perks` anchors to it.

Everything else exactly as v3: `HOLDER_BPS 5000`, `EPOCH_MIN_INTERVAL 7 days`, `CLAIM_WINDOW 180
days`, permissionless `sealEpoch` (snapshot `block.number - 1`, frozen `eligibleSupply` minus
excluded), exact pro-rata `claim`/`claimMany`, `sweepExpired`, the solvency invariant
`THOOD.balanceOf(vault) >= treasuryAccrued + pendingHolders + Σ unswept (holderAmount - claimed)`.

### 4.6 `KeyRegistry.sol` — identity (unchanged)

Free, ungated `register(bytes32 x25519Pub, bytes32 ed25519Pub)`; re-registering rotates keys.

### 4.7 `Anchors.sol` — the message log (NO fee, ever)

```solidity
contract Anchors is Ownable {
    uint256 public constant MAX_BATCH = 64;
    IActivation public activation;                 // setActivation
    IRooms public rooms;                           // setRooms
    mapping(address => bool) public isRelayer;     // setRelayer(addr, approved)
    uint64 public seq;

    struct Drop { bytes32 convoId; bytes32 ephPub; bytes32 blobRef; uint8 viewTag; uint32 size; }

    function post(Drop calldata d) external;
    // requires activation.isActivated(msg.sender); if convoId != 0, requires rooms.isActive(convoId)
    function postBatch(Drop[] calldata d) external;
    // requires isRelayer[msg.sender]; room rent still enforced PER DROP; sender activation is
    // verified OFF-chain by the relay (drops are stealth — the chain cannot attribute them)

    event Dropped(bytes32 indexed convoId, uint64 indexed seq, address indexed poster,
                  bytes32 ephPub, bytes32 blobRef, uint8 viewTag, uint32 size, uint64 timestamp);
    // errors: NotActivated, RoomInactive, NotRelayer, EmptyBatch, BatchTooLarge, ZeroAddress
}
```
`convoId` is `0x0` for stealth 1:1 drops and the group id for room drops. Not payable, ever.

### 4.8 `Perks.sol` — the holder status ladder (view-only over checkpoints)

```solidity
interface IPerks { function tierOf(address user) external view returns (uint8); } // 0..4

contract Perks is IPerks, Ownable {
    uint8 public constant TIER_COUNT = 4;
    uint16[4] public thresholdsBps;                // default [5, 10, 25, 50]; setThresholdsBps
    // validation: non-zero, strictly increasing, <= 10000

    function tierOf(address user) external view returns (uint8);
    function eligibleBalance(address user) public view returns (uint256);
    // min(balanceOf(user), balanceOfAt(user, vault.latestSnapshot())); live balance alone before the first seal
    function thresholdAmount(uint8 tier) external view returns (uint256); // supply * bps / 10000
}
```

### 4.9 `Handles.sol` — @names

```solidity
contract Handles {
    uint256 public constant MIN_LENGTH = 2;
    uint256 public constant MAX_LENGTH = 15;

    function handleOf(address user) external view returns (string memory);   // '' when none
    function addressOf(string calldata name) external view returns (address);
    function requiredTier(uint256 length) public pure returns (uint8);       // 5+:0, 4:2, 3:3, 2:4
    function isValidName(string memory name) public pure returns (bool);     // [a-z][a-z0-9_]{1,14}
    function claim(string calldata name) external;  // requires activation; frees the caller's old name
    function release() external;

    event HandleClaimed(address indexed user, string handle);
    event HandleReleased(address indexed user, string handle);
    // errors: NotActivated, InvalidHandle, HandleTaken, TierTooLow, NoHandle, ZeroAddress
}
```
The perk gate is checked at claim time only — status earned is never clawed back.

### 4.10 Tests

One file per contract + `Integration.t.sol`; `forge test` fully green (142 tests as of v4).
Critical invariants pinned: activation is forever and exactly-once; rent extends from
`max(now, paidUntil)`; `renewFor` can never move unapproved funds; room lapse blocks posting (self
AND relayed) at the exact second while administration survives; batch seq continuity; the vault's
pro-rata math to the wei with the solvency invariant asserted after every state change; perk tiers
flash-buy-proof; handle validation and tier gates.

---

## 5. `@hoodgram/crypto` — EXACT API

Everything from v3 (identity derivation, sealed envelopes, view tags, groups, convo ids, buckets
[256, 1024, 4096, 16384]) plus:

```ts
// identity.ts — domain renamed
export const IDENTITY_DOMAIN = { name: 'HoodGram', version: '1', chainId: 4663 } as const;
export const IDENTITY_MESSAGE = { purpose: 'HoodGram identity key derivation. Signing this does not authorize any transaction.', version: 1n };

// wire.ts — Plaintext extended
export interface Plaintext { v: 1; t: number; kind: 'text' | 'system' | 'media' | 'react'; body: string; re?: `0x${string}` }
// 'media' body = JSON {mime, name, bytes, ref, key}; 'react' body = JSON {target, emoji}; `re` = reply blobRef

// sign.ts — relay drop signatures
export const DROP_SIGNING_CONTEXT = 'hoodgram.drop.v1';
export interface SignableDrop { convoId: `0x${string}`; ephPub: `0x${string}`; blobRef: `0x${string}`; viewTag: number; size: number }
export function encodeDropForSigning(drop: SignableDrop): Uint8Array;
// utf8(context) || convoId(32) || ephPub(32) || blobRef(32) || viewTag(1) || size(4 LE)
export function signDrop(drop: SignableDrop, ed25519Priv: Uint8Array): Promise<`0x${string}`>;
export function verifyDrop(drop: SignableDrop, signature: `0x${string}`, ed25519Pub: Uint8Array): Promise<boolean>; // never throws

// media.ts — encrypted attachments
export const MEDIA_BUCKETS = [65_536, 262_144, 1_048_576, 4_194_304] as const;  // pow2 padding
export function sealMedia(data: Uint8Array): Promise<{ blob: Uint8Array; blobRef: `0x${string}`; key: Uint8Array }>;
export function openMedia(blob: Uint8Array, key: Uint8Array): Promise<Uint8Array | null>;
// blob = [0x02][nonce 24][secretbox(padded)]; key travels ONLY inside E2E descriptor messages

// deployments.ts — nine contracts
export interface Deployment { token; priceSource; revenueVault; activation; groupRegistry;
                              keyRegistry; anchors; perks; handles }  // all `0x${string}`
```
Vitest suite green (176 tests as of v4), including sign round-trip/tamper and media round-trip/
tamper/size-hiding.

---

## 6. `@hoodgram/relay` — EXACT API

Fastify on `:8787`, SQLite via `node:sqlite`. Everything from v3 plus the gasless send pipeline:

```
POST /v1/blob          raw bytes (max 4,194,345 = 4MB media bucket + 41B overhead) → { blobRef }
GET  /v1/blob/:ref     → raw bytes
POST /v1/send          JSON { sender, signature, drop:{convoId,ephPub,blobRef,viewTag,size} }
                       → 200 { accepted: true, queued }
                       → 503 send_disabled | 400 invalid_json/invalid_body | 409 blob_missing
                       | 401 unknown_key/bad_signature | 403 not_activated/room_inactive
                       | 429 queue_full          (all { error, message })
GET  /v1/drops?since=&limit=      GET /v1/drops/convo/:convoId
GET  /v1/stats         GET /v1/health            WS /v1/stream
```

Send pipeline (`sender.ts`): verify registered ed25519 key (KeyRegistry) → `verifyDrop` → activation
→ room rent (room drops) → queue (cap `RELAY_SEND_QUEUE_MAX`, default 512) → flush every
`RELAY_SEND_FLUSH_MS` (default 1500) as `Anchors.postBatch` (≤64) from `RELAYER_PRIVATE_KEY`, with
exponential backoff on failure and stale eviction after 5 minutes. Blob must exist before a send is
accepted. Activation results cache forever; identity keys 5 min; room rent 15 s. Without
`RELAYER_PRIVATE_KEY` + the four contract addresses (`ANCHORS_ADDRESS`, `ACTIVATION_ADDRESS`,
`GROUP_REGISTRY_ADDRESS`, `KEY_REGISTRY_ADDRESS`) the endpoint answers 503 and everything else
still works.

---

## 7. `@hoodgram/web` — Next.js 15

Routes: `/` marketing · `/app` messenger · `/app/thread` · `/access` activation + handles + ladder +
rooms + revenue claims.

### 7.1 DESIGN SYSTEM — unchanged and non-negotiable

"Signals Desk": the token set as BUILT in `globals.css` (`--void #08090A`, `--panel`, `--line`,
`--bone`, `--muted`, `--dim`, **`--green #00c805`** — Robinhood green, THE reserved accent,
permitted only on primary CTAs / active state / confirmed-on-chain / live badge / the $THOOD
wordmark — `--steel`, `--crimson`), Geist Mono display + Geist Sans body, tabular-nums, 1px
hairlines, 6px corner-notch clip-path, 3% grain, Lenis + GSAP reveals, banned list unchanged
(no matrix-green *washes* — the accent is a single reserved green, never a theme — no neon,
gradients, glassmorphism, big radii, emoji iconography).

### 7.2 Site content (`/`)

Hero ("Pay $5 once. Text forever." + live Drop Stream) → honest security claim → **the two prices**
($5 once / $10 per room per month, USD-fixed, paid in $THOOD) with "messages are free and instant —
relayed, no gas, no popups, your address never on chain" → How a drop works (compose → pad+seal →
relay batches on chain, or self-post → recipient scans by view tag) → Noise Floor → **the perks
ladder** (four rungs, thresholds, unlocks, the anti-flash-buy line, "revenue share needs no tier") →
**Revenue share: 50% of every activation and every month of rent to holders, pro-rata, NO STAKING**
→ live stats → FAQ (including relay trust, stated honestly) → footer with all nine contract
addresses.

### 7.3 App (`/app`)

Connect → sign identity (IndexedDB by address) → register keys if needed → gate on
`Activation.isActivated`; locked state explains the $5-once model with the live quote and links
`/access`. **Send = gasless by default:** seal → POST blob → `signDrop` → POST /v1/send → optimistic
row → anchored when the WS drop with the same blobRef lands (attribute own messages by blobRef, not
poster). Self-post toggle (wallet + ~1¢ gas) always available; relay rejections surfaced verbatim.
Rooms: create ($10/month flow: approve → createGroup), sender-key wrap/unwrap via 1:1 `system`
drops, member add (wrap current key) / kick (new key + `rotateEpoch`), rent countdown in the room
header, lapsed → composer disabled + "anyone can pay" rent flow. @handles resolve everywhere
addresses would show; perk-tier chips beside names (never amber). Media (≤4MB, `sealMedia`),
replies (`re`), reactions (`react`). Reading/receiving must keep working in every locked state.

### 7.4 Access (`/access`)

Activation panel ($5 once, live quote, approve→activate, activated-forever state, sponsor a friend)
→ handle panel (claim, validity, availability, short-name tier gates) → ladder panel (your tier,
eligible balance vs the four thresholds) → rooms panel (rooms you admin from logs: rent status,
pay rent 1–24 months, auto-renew toggle with the allowance explanation) → holder revenue panel
(totals, claim all) → epoch table (+ permissionless seal button) → revenue history sparkline.
Every state designed: not-connected, wrong-network, not-deployed, empty.

### 7.5 Fit verification (MANDATORY)

No element may overflow its container or the viewport at **1440 / 1024 / 760 / 390** px.
`grid-template-columns: minmax(0,1fr)` — never a bare `1fr`. `min-width:0` on every flex/grid child.
Side panels single-column. Long hex truncates with ellipsis and never widens its container.

---

## 8. Conventions

- Every package: `build`, `dev`, `test`, `typecheck` scripts. TypeScript strict, no `any`, no `@ts-ignore`.
- Env via `.env` at root, `.env.example` committed. Never commit secrets or a private key.
- Zero `console.log` in shipped web code; the relay uses fastify's logger.
- Every file you create must compile. If you cannot verify, say so explicitly in your return value.
