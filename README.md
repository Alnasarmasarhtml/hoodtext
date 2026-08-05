# TeleHood

Encrypted messaging with every message anchored on Robinhood Chain. Token: **$THOOD**.

**Pay $5 once. Text forever.** A room costs its admin $10/month — members are free. Messages are
never charged and are sent gasless through the relay by default: no wallet popup, no gas, and the
sender's address never appears on chain. Half of every payment — every $5 activation, every month
of room rent — is distributed to $THOOD holders in proportion to their holdings. There is no
staking, no lock-up and no deposit anywhere in the system.

Message contents are encrypted end-to-end in the browser and never leave it in the clear. What goes
on chain is a fixed-size anchor — an ephemeral public key, a SHA-256 reference to the ciphertext, a
one-byte view tag and a padded size bucket. The ciphertext itself is stored off chain and addressed
by its hash, so the chain holds an ordered, tamper-evident log of *that a message happened* and
nothing about what it said.

---

## The security claim

> **Message contents are unreadable by anyone but the recipient. Metadata is minimized, not
> eliminated.**

That sentence is the whole claim. It is deliberately narrower than what a messaging product is
usually sold on, and the limitations below are part of the specification rather than a caveat
appended to it.

### What this protects against

| Threat | How |
|---|---|
| Anyone reading message contents | X25519 key agreement + XSalsa20-Poly1305 authenticated encryption. Keys are derived in the browser from a wallet signature and never transmitted. |
| Correlating a message to its recipient by reading the chain | No recipient address is written. Each drop carries a per-message ephemeral public key and a 1-byte view tag; recipients scan by trial key agreement. |
| Linking a sender address to a message | The default: the relay batch-posts on the sender's behalf, so the sender's address never appears on chain at all. |
| Inferring content from message length | Plaintext is padded to one of four fixed buckets (256 / 1024 / 4096 / 16384 bytes). Media is padded to power-of-two buckets (64KB–4MB). |
| A relay serving altered ciphertext | The on-chain `blobRef` is the SHA-256 of the envelope. The client recomputes it and rejects any mismatch. |
| A relay forging messages from you | Every relayed drop carries a detached Ed25519 signature over its exact on-chain fields, verified against your registered identity key. The relay cannot manufacture one. |
| A compromised relay reading messages | The relay only ever holds ciphertext. It has no keys and cannot decrypt anything — including media, whose keys travel only inside E2E-encrypted descriptor messages. |

### What this does **not** protect against

| Not covered | Why |
|---|---|
| **Anonymity against a global observer** | Someone who can watch both the network and the chain can correlate timing and traffic volume. We do not run mixnets or cover traffic. |
| **Forward secrecy against long-term key compromise** | Identity keys are derived deterministically from a wallet signature. An attacker who obtains your X25519 private key can decrypt every message ever sent to you, past included. There is no ratchet. |
| **A relay refusing to post** | The relay is trusted for *liveness*, not content: it can censor by declining to batch a drop. The escape hatch is structural — self-posting via `Anchors.post` is permissionless forever (~1¢ gas), and more relayers can be approved. |
| **The sequencer operator observing timing** | Robinhood Chain is a single-sequencer chain. |
| **Group messaging with RFC 9420 guarantees** | Rooms use a sender-key scheme with epoch rotation. It is MLS-*like*, not MLS. No post-compromise security. |
| **Metadata already public by construction** | Message count, timing, size bucket and — for self-posted drops — the poster's address are on a public chain permanently. |
| **A malicious or coerced client** | Everything rests on the browser holding your keys. A compromised device is a total compromise. |
| **Loss of your wallet** | Identity keys derive from a wallet signature. Lose the wallet, lose the ability to decrypt history. No recovery, no escrow. |

---

## Economics

| Price | What it buys |
|---|---|
| **$5, once** | Your account, forever. Also the spam wall — every account here cost somebody five dollars. Includes an @handle. |
| **$10 / month per room** | Paid by whoever runs the room; members free; anyone may pay (paying grants no control). Lapse pauses new messages, never deletes anything. |
| **$0 per message** | Relayed sends are free to the user. Self-posting is ~1¢ gas, always available. |

Prices are fixed **in USD on-chain** and converted to $THOOD at purchase. 50% of every payment goes
to holders via weekly checkpoint epochs — hold $THOOD in your own wallet at the snapshot and claim;
nothing to stake, nothing to lock.

**The holder status ladder** (status and capacity only — never a claim on anyone's revenue):

| Tier | Hold | Unlocks |
|---|---|---|
| RESIDENT | 0.05% of supply | Holder badge in every chat |
| BLOCK CAPTAIN | 0.1% | + 4-char handles, bigger uploads and rooms |
| DISTRICT | 0.25% | + 3-char handles, early features |
| KINGPIN | 0.5% | + 2-char handles, broadcast rooms |

A tier is judged on the **lower** of your balance now and at the last weekly revenue snapshot —
held, not visited. Full model and revenue math: [`docs/ECONOMICS.md`](docs/ECONOMICS.md).

---

## Architecture

```
   ┌────────────────────────────────────────────────────────────────────────────┐
   │ browser                                                                    │
   │                                                                            │
   │  apps/web — Next.js 15 / React 19                                          │
   │    /          marketing        /app     messenger                          │
   │    /access    activate ($5), handles, ladder, rooms, claim revenue         │
   │                                                                            │
   │  packages/crypto — isomorphic TS, keys client-side only                    │
   │    deriveIdentity(sig) ── blake2b ─→ X25519 + Ed25519 keypairs             │
   │    seal / open ──────── pad to bucket, crypto_box, sha256 → blobRef        │
   │    signDrop ─────────── Ed25519 over the drop's exact on-chain fields      │
   │    sealMedia / openMedia ─ per-file random keys, keys travel E2E only      │
   │                                                                            │
   │  keys live in IndexedDB, keyed by address, wiped on disconnect             │
   └───────┬──────────────────────────────────────────┬─────────────────────────┘
           │ ciphertext + signed drop                 │ (fallback) self-post tx
           │ (gasless — the default)                  │ gas only; not payable
           v                                          v
   ┌───────────────────────────────┐   ┌────────────────────────────────────────┐
   │ apps/relay — Fastify :8787    │   │ contracts/                             │
   │                               │   │                                        │
   │  POST /v1/blob  content-      │   │  TeleHoodToken     ERC20 + balance     │
   │                 addressed     │   │                    checkpoints         │
   │  POST /v1/send  verify sig +  │   │  ManualPriceSource thoodPerUsd (18dp)  │
   │       activation + room rent, │   │  Activation        $5 once, forever    │
   │       queue, batch ≤64        │──►│  GroupRegistry     rooms, $10/mo rent  │
   │  GET  /v1/drops /stats        │   │  RevenueVault      50/50 split, weekly │
   │  GET  /v1/health  WS /stream  │   │                    epochs, pro-rata    │
   │                               │   │  KeyRegistry       pubkeys, free       │
   │  node:sqlite (WAL)            │   │  Anchors           the message log     │
   │  data/telehood.db             │   │  Perks             holder ladder       │
   │                               │   │  Handles           @names              │
   │  indexer ─ viem watchContract │◄──┤                                        │
   │  Event(Anchors.Dropped)       │   │  no fee on post(), no staking anywhere │
   └───────────────────────────────┘   └────────────────────────────────────────┘
           the relay holds ciphertext only          Robinhood Chain (4663)
           and has no keys                          or anvil (31337) locally
```

Payment flow, end to end (activation shown; room rent is identical from `GroupRegistry`):

```
  buyer ──approve──► Activation.activate()
                          │
                          ├─ quote:   priceUsd × thoodPerUsd / 1e18        ($5 → $THOOD)
                          ├─ transferFrom(buyer → RevenueVault)            100% of the payment
                          └─ vault.notifyRevenue(amount)
                                   │
                                   ├─ 50% → pendingHolders  ──sealEpoch()──► claimable pro-rata
                                   └─ 50% → treasuryAccrued
```

Gasless send, end to end:

```
  sender ── seal() ──► POST /v1/blob ──► signDrop(ed25519) ──► POST /v1/send
                                                                   │ verify: registered key,
                                                                   │ signature, activation,
                                                                   │ room rent
                                                                   ▼
                                              queue ──≤64──► Anchors.postBatch (relay's key)
                                                                   │
                            recipient ◄── WS /v1/stream ◄── indexer ◄── Dropped event
                            scans by view tag, fetches blob, verifies sha256, decrypts
```

---

## Chain configuration

| | Robinhood Chain | Local |
|---|---|---|
| Chain ID | `4663` (`0x1237`) | `31337` |
| RPC | `https://rpc.mainnet.chain.robinhood.com/` | `http://127.0.0.1:8545` |
| Explorer | `https://robinhoodchain.blockscout.com/` | — |
| Currency | ETH (18 decimals) | ETH |
| Gas price | ~0.0275 gwei observed | 0 |
| Block time | ~100 ms | 1 s (`--block-time 1`) |

Measured live on 2026-07-29. Re-measure before launch.

---

## Local quickstart

Requirements: Node 24+, pnpm 9, [Foundry](https://getfoundry.sh) (`forge` and `anvil`). No Docker.

```sh
make install          # pnpm workspaces; contracts libraries vendored under contracts/lib
cp .env.example .env  # defaults already point at anvil
make build            # forge build -> sync ABIs -> build every package
```

Then four terminals, in order:

```sh
make chain            # 1 — anvil --chain-id 31337 --block-time 1
make deploy-local     # 2 — deploys all nine contracts, verifies bytecode,
                      #     rewrites packages/crypto/src/deployments.ts (31337 entry)
make dev              # 3+4 — @telehood/relay on :8787 and @telehood/web on :3000
```

For gasless send locally, set in `.env` before starting the relay: `RELAYER_PRIVATE_KEY` (anvil
account #1 works), `RELAYER_ADDRESS` (its address — the deploy script approves it on `Anchors`),
and the four contract addresses printed by the deploy (`ANCHORS_ADDRESS`, `ACTIVATION_ADDRESS`,
`GROUP_REGISTRY_ADDRESS`, `KEY_REGISTRY_ADDRESS`). Without them the relay serves everything except
`/v1/send` (503) and the app falls back to self-posting.

Tests:

```sh
make test             # forge test (142) + crypto vitest (176) + relay vitest (91)
```

---

## Repo layout

```
contracts/                Foundry. Nine contracts + full test suite.
  src/                      TeleHoodToken, ManualPriceSource, RevenueVault, Activation,
                            GroupRegistry, KeyRegistry, Anchors, Perks, Handles
  script/Deploy.s.sol       deploy + wire + deployments/<chainid>.json
packages/crypto/          @telehood/crypto — isomorphic TypeScript
  src/                      identity, envelope, convo, group, media, sign, deployments
apps/relay/               @telehood/relay — Fastify 5 + node:sqlite + viem indexer + WS
  src/                      server, db, indexer, stream, sender (gasless pipeline), config
  data/telehood.db          created on first run (WAL); gitignored
apps/web/                 @telehood/web — Next.js 15 App Router, React 19
infra/scripts/            deploy-local.mjs, sync-abis.mjs, check-fit.mjs
docs/ECONOMICS.md         the money, measured
SPEC.md                   the canonical build spec (v4)
```

| Make target | What it does |
|---|---|
| `make install` | install every workspace |
| `make build` | forge build → sync ABIs → build all packages |
| `make test` | every test suite in the repo |
| `make chain` | local anvil |
| `make deploy-local` | deploy + wire + write addresses back into the repo |
| `make dev` | run `@telehood/relay` and `@telehood/web` together |
