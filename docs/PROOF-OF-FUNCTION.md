# HoodGram — Proof of Function

**Run date:** 2026-08-07 · **Chain:** anvil, chain id `31337`, `--block-time 1` · **Result: PASS**, with two defects found and documented in §9.

Everything below happened on a real chain, with real contracts, real libsodium encryption, real
transactions and real transaction hashes. Nothing in this document is mocked, simulated, stubbed or
replayed from a fixture. Every hash here can be looked up on a freshly reproduced chain.

Because the chain is deterministic (anvil's default mnemonic, deployer nonce 0), the **contract
addresses reproduce exactly** on every clean run. The transaction hashes and block numbers do not —
they depend on wall-clock timestamps — so the hashes below are from this specific run and are
recorded verbatim.

---

## 1. Headline result

| # | Demonstration | Result |
|---|---|---|
| 1 | Local chain up, nine contracts deployed, every address recorded | **PROVEN** |
| 2 | Two independent accounts (ALICE, BOB) funded and activated on chain | **PROVEN** |
| 3 | Both register identity keys via `KeyRegistry` | **PROVEN** |
| 4 | Both claim a handle; handle lookup resolves to the right address, both directions | **PROVEN** |
| 5 | ALICE → BOB text: sealed, anchored, decrypted; a third party gets nothing | **PROVEN** |
| 6 | ALICE → BOB file (177 KB PNG): byte-for-byte round trip, sha256 identical | **PROVEN** |
| 7 | BOB → ALICE reply: round trip proven in both directions | **PROVEN** |
| 8 | Room created on chain, rent paid, BOB invited, both talk in it, both read it | **PROVEN** |
| 9 | Extras: self-post fallback, member removal via `rotateEpoch`, rent lapse, revenue split, epoch seal, a real holder claim | **PROVEN** |
| — | Adversarial: rent lapse inside the relay's cache window | **SECURITY HELD, DEFECT FOUND** (§9.1) |

**Final on-chain state:** `Anchors.seq() = 9` — nine anchored messages, all nine indexed and served
back by the relay (`/v1/stats` → `{"head":9,"totalDrops":9,"totalBlobs":14,"uniquePosters":2}`).

---

## 2. Exactly what was run, so anyone can reproduce it

### 2.1 Prerequisites verified on this machine

`node v24.14.0` · `pnpm 9.15.0` · `forge 1.5.1-stable` (`forge`/`anvil`/`cast` at `~/.foundry/bin/`).
`tsx` is not on `PATH`; it exists at `apps/relay/node_modules/.bin/tsx`.

### 2.2 Bring up the stack

```sh
# terminal 0 — build (do NOT run `pnpm -r build`; it runs `next build` in apps/web)
cd /Users/nik/Desktop/TELEHOOD
forge build --root contracts
node infra/scripts/sync-abis.mjs

# terminal 1 — the chain, left running
anvil --chain-id 31337 --block-time 1

# terminal 2 — deploy all nine contracts
cd /Users/nik/Desktop/TELEHOOD
node infra/scripts/deploy-local.mjs

# terminal 3 — the relay. It does NOT read .env; every var must be passed inline.
# Do NOT `source .env` — that file points RPC_URL/CHAIN_ID at Robinhood mainnet.
cd /Users/nik/Desktop/TELEHOOD/apps/relay && \
RPC_URL=http://127.0.0.1:8545 \
CHAIN_ID=31337 \
START_BLOCK=0 \
WEB_ORIGIN='*' \
RELAY_PORT=8787 \
RELAY_DB_PATH=./data/proof.db \
RELAY_LOG_LEVEL=info \
ANCHORS_ADDRESS=0x0165878A594ca255338adfa4d48449f69242Eb8F \
ACTIVATION_ADDRESS=0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9 \
GROUP_REGISTRY_ADDRESS=0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9 \
KEY_REGISTRY_ADDRESS=0x5FC8d32690cc91D4c39d9d3abcBD16989F875707 \
RELAYER_PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d \
pnpm exec tsx src/index.ts
```

Use a **fresh** `RELAY_DB_PATH` on a fresh chain: the indexer cursor is persisted in SQLite, and a
cursor left over from a previous anvil sits past the new head, so nothing is ever scanned.

### 2.3 Run the proof

The proof harness is **not committed to the repo** (per the brief, the only repo change is this
document). It lived at `/tmp/hoodgram-proof/proof.ts` + `/tmp/hoodgram-proof/lib.ts` for this run and
was executed with:

```sh
cd /tmp/hoodgram-proof
/Users/nik/Desktop/TELEHOOD/apps/relay/node_modules/.bin/tsx /tmp/hoodgram-proof/proof.ts
```

It imports `@hoodgram/crypto` and `viem` through symlinks in `/tmp/hoodgram-proof/node_modules`
pointing at the workspace's real packages, so it links against the **shipped source**, not a copy.
Every section below states exactly which production function it called, so the harness can be
rebuilt from this document alone.

A committed subset already exists: `apps/relay/scripts/smoke-send.ts` reproduces §5's gasless path
(identity → register → activate → seal → blob → send → anchor → decrypt) and can be run with
`pnpm --filter @hoodgram/relay exec tsx scripts/smoke-send.ts`.

Raw artifacts from this run (session-scratch, not committed):
`/tmp/hoodgram-proof/run.log` (full transcript), `evidence.jsonl` (machine-readable),
`summary.json`, `relay.log`, `anvil.log`, `roundtrip-lockup-on-dark.png` (the recovered file).

---

## 3. Contract addresses and deployment transactions

Deployer / treasury / owner: `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` (anvil #0).
Relayer: `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` (anvil #1).
`thoodPerUsd = 1000000000000000000000` (1000e18). Source of truth: `contracts/deployments/31337.json`.

| Contract | Address | Deploy tx | Block | Gas |
|---|---|---|---|---|
| HoodGramToken | `0x5FbDB2315678afecb367f032d93F642f64180aa3` | `0xcca1c6623aa0fdae490f7739e2f5495cb634c7634443c8849fd98d8345e80872` | 6 | 1,519,832 |
| ManualPriceSource | `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` | `0x8b0656d5aa512e1ccc93575c2773c5a09f9c3c59865809a6022593960ba6cdae` | 7 | 261,232 |
| RevenueVault | `0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0` | `0xddae14dcd1babbf1bc191a67e7291063f6720d012eeec7fc7cff9810c3d7f560` | 8 | 1,780,562 |
| Activation | `0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9` | `0x6934781c9d9a17a006af8aff26327130cacbd7de2102e723f69577ae0eaa72b3` | 9 | 847,933 |
| GroupRegistry | `0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9` | `0xbaac5fcf2d9df98ef9d2e3ccbf4ccd829e1f6e86e4ff81486b5e371b3e4bfd0d` | 10 | 1,384,798 |
| KeyRegistry | `0x5FC8d32690cc91D4c39d9d3abcBD16989F875707` | `0x8c89f2253446c690e6e74a27f28d7ff1431f37c66b45846892c6e5573e899565` | 11 | 182,075 |
| Anchors | `0x0165878A594ca255338adfa4d48449f69242Eb8F` | `0x0aa251ba8337a370fd8240b45473437a9640ea06b6532b33e9c8f904e0e6b9f1` | 12 | 741,029 |
| Perks | `0xa513E6E4b8f2a923D98304ec87F64353C4D5C853` | `0xf7b1211a96ed7e0bb302ef9ad305086f468bc13d187357810c6d7b9cc0ca85c3` | 13 | 793,866 |
| Handles | `0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6` | `0xb7ee5c3b223170fe15bb733eff3c173bb95026f74d87f848f221117f5124c815` | 14 | 846,059 |

Post-deploy wiring, same script:

| Call | Tx | Block |
|---|---|---|
| `RevenueVault.setNotifier(Activation, true)` | `0xeb9987041709e95552c659b2be59896f337ad510da785ca30919d36d4a89af99` | 15 |
| `RevenueVault.setNotifier(GroupRegistry, true)` | `0x50f39f45f51e71366b7fb040e3e773447c72167db388b2e0f7388ddea6bb715e` | 16 |
| `Anchors.setRelayer(0x7099…79C8, true)` | `0x615b3ba443d18a8af38026eff79484f9b2d31cbcaadad6f22baab71b069684f6` | 17 |
| `RevenueVault.setExcluded(…)` ×2 | `0x29d5a557…fd92fb38d`, `0x91e109b5…56de86644` | 18, 19 |

Verified independently at proof time: `eth_getCode` returned non-empty runtime bytecode for all nine
(HoodGramToken 5,812 bytes; RevenueVault 7,555; GroupRegistry 5,581; Handles 3,666; Activation 3,209;
Perks 3,022; Anchors 2,824; ManualPriceSource 722; KeyRegistry 597), and
`Anchors.isRelayer(0x7099…79C8) == true`.

`apps/web/.env.local` already carries these exact nine `NEXT_PUBLIC_ADDR_*` values, so the web app is
wired to the same deployment.

---

## 4. The accounts

All are anvil defaults — publicly known test keys, local chain only.

| Role | Address | Key | Used for |
|---|---|---|---|
| TREASURY / owner | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` | anvil #0 | holds the whole supply; funds the others |
| RELAYER | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` | anvil #1 | `Anchors.postBatch` |
| **ALICE** | `0x90F79bf6EB2c4f870365E785982E1f101E93b906` | anvil #3 | party 1 |
| **BOB** | `0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65` | anvil #4 | party 2 |
| CAROL | `0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc` | anvil #5 | the third party — deliberately never registered, never activated |

`HoodGramToken` mints `1,000,000,000e18` to the treasury in its constructor and has **no mint
function and no owner**. Every test wallet therefore had to be funded by a real `transfer` from
anvil #0. There was no faucet and no shortcut.

---

## 5. Step-by-step transcript

### 5.1 Identity derivation (the real EIP-712 ceremony)

Each party signed the app's exact typed-data message with their wallet
(`domain {name:'HoodGram', version:'1', chainId:31337}`, `types` = `IDENTITY_TYPES`,
`message` = `IDENTITY_MESSAGE`), and the signature was fed to `deriveIdentity()` from
`@hoodgram/crypto`.

```
ALICE  0x90F79bf6EB2c4f870365E785982E1f101E93b906
  sig      0x91fe537844167de5d58e0ae62d6abed7bc17e5917540fae2a1615c2937c8cce4
           2115db0ebe54042c1bee04c3ea850f4b3e22300fe302aab961066becddb3e3e21b
  x25519   0x4ff4e7aff6d11321dd194aa9174342446b1ca2e6bd3abfee529c857cd907ae09
  ed25519  0xa0e8db02bfab86b1232112cb6da685645ae89ac0a40e59b0c82be816fd83a93f

BOB    0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65
  sig      0x97bec998cc95f4f50913c494b9f1c1bcf0d3971c6a5932fba5f400644d6614a1
           761731a1182e6adb0ccc15299afeec072d547b3ca6e7d351611d1ba3a756870b1b
  x25519   0x4ac3a7afb7f851ac5691c05a6138d45838899f2589a365212eba34ed44c9ff59
  ed25519  0x891a6a14287c30f7acc7273cd477f04eafa6d6f45585b2f73062c6be33f7ca07

CAROL  0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc
  x25519   0xce686ca27dc6e07791b2159caedf0a6a56436496e7a141b1f1ea422d767a8877
  ed25519  0xa27c61d079f56bbd77279260b15e763312da1e674c08484699a9582383c1b6f8
```

ALICE's identity was derived a second time from a second signing of the same message and came out
**byte-identical** — the derivation is deterministic, as designed (blake2b(sig, 64) split into two
seeds). The three identities are mutually distinct.

### 5.2 On-chain key registration — `KeyRegistry`

| Who | Tx | Block | Gas |
|---|---|---|---|
| ALICE `register(x25519, ed25519)` | `0xaba274a4dc06cd21f67f5717ef5ca191568ca6ca18801358de695a0a81a1a93c` | 36 | 90,915 |
| BOB `register(x25519, ed25519)` | `0x615395e19aac097bae7d2bf0facbcf74f0ca1d3f39038db6d3f739a8a5341139` | 40 | 90,915 |

`isRegistered()` returned true for both, and `keysOf()` returned exactly the locally derived public
keys for both. `isRegistered(CAROL) == false` throughout.

### 5.3 Activation — the $5 one-time handshake, paid in $THOOD

`priceUsd = 5000000000000000000` ($5, 18dp) × `thoodPerUsd = 1000e18` ÷ 1e18 →
`quote() = 5000000000000000000000` = **5,000 $THOOD**.

| Step | Tx | Block |
|---|---|---|
| TREASURY → ALICE 5,000 THOOD | `0x0861b192c615316a5ff3ccc1ae0016b34ca0593a7032348f7a16161b8b82e851` | 44 |
| ALICE `approve(Activation, quote)` | `0x33e819ea143370b4c80aa24c5f7c8f7c2c54f597c22b9593abe03447ff2f9c65` | 48 |
| **ALICE `activate()`** | `0xd69719d65fb818e6ff9469a236f093fb6275622156f176b2626204e4851eac8f` | 52 |
| TREASURY → BOB 5,000 THOOD | `0x3f21e93ca4bb3da572085bae2a1db97f2d96bddcbd8cac4d2ab602ca7c0a937e` | 56 |
| BOB `approve(Activation, quote)` | `0x76202ad16897d24a96c0f17f95aae1b8d3b2857018aa9a05e1131e9674fa4138` | 60 |
| **BOB `activate()`** | `0x92f2a07c4382b61192f805cabf608acced106a5923ec9f6b1e644915ed9da389` | 64 |

`isActivated()` true for both (`activatedAt` 1786126647 and 1786126659). A second `activate()` from
ALICE reverted **`AlreadyActivated()`**.

**Revenue split verified on the spot.** The vault's $THOOD balance rose by exactly `2 × quote` =
`10000000000000000000000`, and that split `5000000000000000000000` to `pendingHolders` /
`5000000000000000000000` to `treasuryAccrued` — exactly `HOLDER_BPS = 5000` (50/50).

### 5.4 Handles — claim, then search

Both accounts were tier 0 at this point (they held ~0 $THOOD after paying to activate), so both were
restricted to 5–15 character handles.

| Who | Handle | Tx | Block | Gas |
|---|---|---|---|---|
| ALICE | `alicehood` | `0x760917b8513f65e902edaffcbb86889a7c4b77c13af5f84e680aaedd55187742` | 68 | 78,075 |
| BOB | `bobhood` | `0x82b7e8b6d1dd7c3689c3c54ad99255c12f3d9ba31db02401feb9e07c5348b85e` | 72 | 77,539 |

**The lookup the client asked for** — forward and reverse, read straight off the chain:

```
addressOf("alicehood")  -> 0x90F79bf6EB2c4f870365E785982E1f101E93b906   == ALICE
addressOf("bobhood")    -> 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65   == BOB
handleOf(ALICE)         -> "alicehood"
handleOf(BOB)           -> "bobhood"
addressOf("nosuchuser") -> 0x0000000000000000000000000000000000000000   (unclaimed)
```

Negative cases, all reverting on chain with the named custom error:

| Attempt | Revert |
|---|---|
| BOB claims `alicehood` (already taken) | `HandleTaken()` |
| ALICE claims `al1c` (4 chars, she is tier 0) | `TierTooLow()` |
| ALICE claims `Alice` (uppercase) | `InvalidHandle()` |
| CAROL claims `carolhood` (never activated) | `NotActivated()` |

The tier ladder was then proven positively — see §7.3, where ALICE reaches tier 4 and claims the
2-character handle `al`.

### 5.5 ALICE → BOB, a text message

Plaintext (71 bytes): `Bob — the vault audit is at 14:00 tomorrow. Bring the cold wallet. -A`

```
seal(pt, BOB.x25519pub) ->
  sealed blob   329 bytes   (payload padded to bucket 256 of 256/1024/4096/16384)
  blobRef       0xdf2689650078dd65641e852d379e7a24134c1a9ec6d072b4d73a7226eb3b4952
  ephPub        0xb91b0bb67a54b6b5671275bdb3b498fccb5367e34f8718a51611b230a91f6a64
  viewTag       111
  ciphertext    01b91b0bb67a54b6b5671275bdb3b498fccb5367e34f8718a51611b230a91f6a64
                859d5957903aa7247bf04be3ce57a3…
```

The 71 plaintext bytes do **not** occur anywhere inside the 329-byte blob (checked by byte search).

Path: `POST /v1/blob` (relay content-addressed it to the same ref) → `signDrop()` with ALICE's
Ed25519 identity key → `POST /v1/send` → relay batched it → `Anchors.postBatch` on chain.

**Anchor: seq `1`, tx `0x80cd890aeb0b542e7fb4fe80faf9fbfd5d03558992c431296e4d1f1a4917dfb2`, block 78.**
On-chain `convoId` is `0x00…0` (stealth — DMs never put a recipient on chain) and the on-chain
`poster` is the *relayer's* address, not ALICE's.

**BOB found it the way the app does**, with no help: he scanned every anchored drop the relay served
and ran `scanMatches(ephPub, viewTag, bobPriv)` on each. He matched exactly his own. He then fetched
the blob (`GET /v1/blob/<ref>`; the returned bytes re-hash to the ref) and ran `open()`:

```
BOB decrypts  "Bob — the vault audit is at 14:00 tomorrow. Bring the cold wallet. -A"
```

Byte-for-byte identical to what ALICE sent, `kind == 'text'`.

**The third party gets nothing.** CAROL, given the identical ciphertext from the public relay:

| | Result |
|---|---|
| `scanMatches(ephPub, viewTag, CAROL_priv)` | `false` |
| `open(blob, CAROL_priv, CAROL_pub)` | `null` |
| `open(blob, ALICE_priv, ALICE_pub)` — the *sender* | `null` (the ephemeral secret is discarded at seal time) |

**The relay is not a blind pipe**, also verified:

```
POST /v1/send, signature with one byte flipped  -> 401 {"error":"bad_signature", …}
POST /v1/send, sender = CAROL (unregistered)    -> 401 {"error":"unknown_key", …}
```

### 5.6 ALICE → BOB, a real file

Real file from this repo: `apps/web/public/brand/lockup-on-dark.png`.

```
bytes           177,123
sha256 BEFORE   b94c402c17fadde695bb56aa9cfd518942817417aa3fe2cd7910d70b64c260f6
```

Two-blob flow, exactly as `apps/web/src/hooks/useSendMessage.ts` does it:

1. `sealMedia(fileBytes)` → media blob **262,185 bytes** (padded up to the 262,144 bucket),
   `blobRef 0x8c8921fbe7ed1c32927b6c6f8266ac121e093d46823df3120bdf3259d06b2e04`,
   key `0x1a50da41ee569b4692e09a35c0fae7cbc29b3e4c3730102995e8f8377731de18`.
2. `POST /v1/blob` with the media ciphertext — the relay returned the same ref.
3. A descriptor `{mime, name, bytes, ref, key}` was sealed to BOB as a normal `kind:'media'` drop
   (`blobRef 0xc0a01d5d97fd815aa95f8dd0e9efe9ced91fafc184eff4c967472ee5b8b9971c`, bucket 1024) and
   anchored. **The decryption key travels only inside the E2E envelope; the relay stores two opaque
   ciphertexts and never sees the key.**

**Anchor: seq `2`, tx `0xcf709c7f5337a443388ef9a5ecaac9c15ddf0e63898e6be74458996d0df3b5df`, block 82.**

BOB opened the envelope, read the descriptor
(`lockup-on-dark.png image/png 177123 bytes ref 0x8c8921fb…`), fetched the media ciphertext by that
ref, and ran `openMedia()`:

```
sha256 AFTER    b94c402c17fadde695bb56aa9cfd518942817417aa3fe2cd7910d70b64c260f6
```

**Identical.** Also verified: same byte length (177,123) and a full `Buffer.equals()` comparison. The
recovered file was written to `/tmp/hoodgram-proof/roundtrip-lockup-on-dark.png` and `cmp` against
the original reports no differences.

CAROL, holding both ciphertexts: `open(envelope)` → `null`; `openMedia(mediaBlob, wrongKey)` →
`null`. She recovers neither the key nor the file.

### 5.7 BOB → ALICE, the reply (round trip, both directions)

Plaintext: `Got it. 14:00 confirmed. Cold wallet + the paper backup. -B`, sealed to ALICE with
`re: 0xdf268965…4952` (a thread pointer back to ALICE's original message).

**Anchor: seq `3`, tx `0x4d355a1e0711d19cda17904b701cf63e4ed97e64ca456e34266c029f185a852c`, block 87.**

ALICE decrypted it exactly, and the `re` field survived intact. BOB — the sender — could **not**
re-open his own ciphertext (`null`), same as ALICE could not re-open hers.

Both sides independently computed the same 1:1 thread id:
`convoIdFor(A,B) == convoIdFor(B,A) == 0xded75205d28c9ffe031be947ce2ecbc9afb513a8cb1bf1b9fe001d0a1ba1ed2d`.
That id is a **local** thread key only; the on-chain `convoId` for a DM stays `0x00…0` by design.

### 5.8 Self-post fallback — anchoring without the relay

BOB called `Anchors.post(...)` directly from his own wallet:
tx `0x9cba6aa492867425b0950360c39cde27917d4d052f62f523932dec911c3200f0`, block 89, gas 39,240.
The receipt's `Dropped` event carried **seq 4** and `poster = 0x15d34AAf…6A65` — BOB's own address,
which is the documented trade-off of self-posting. The relay's indexer picked it up and served it
back like any other anchor.

CAROL attempting the same reverted **`NotActivated()`**. Censorship resistance is real: an activated
account can always anchor without the relay's cooperation.

---

## 6. The room / group

### 6.1 Creation and rent

```
name         "vault-ops"
salt         0x01136ceca2b543d98307cd77427bd165
groupId      0x7dffb31fb1ed2fbca91d3bfe6ee19173dd828b3075ebae4fbcd9255b5cefc663
             (= groupIdFor(name, ALICE, salt))
memberRoot   0xdccaa7cb0f4646ade05601920f951091423a574eca96e8b03a4a9f934d9473c1
             (= memberRoot([ALICE]) — the solo roster the app creates with)
rent         rentUsdPerMonth = 10e18 ($10/mo); quoteRent(2) = 20,000e18 $THOOD
```

| Step | Tx | Block |
|---|---|---|
| TREASURY → ALICE 20,000 THOOD | `0xefb044146d801587447965d474706e2c43bcd3f1ee240b4d4c38246a1376f4fa` | 95 |
| ALICE `approve(GroupRegistry, rent)` | `0xe765181f2850ea5be279036f7a4bc335633c02c136d8dcf19a5d7c37f4bc5c75` | 99 |
| **ALICE `createGroup(groupId, root, 2)`** | `0xe7d087289bcaf423befe40e17ae8f8c5edd3a037757e3ba54bd3e913cfd1b79c` | 103 |

On-chain state read back: `admin = ALICE`, `epoch = 0`, `memberRoot = 0xdccaa7cb…`,
`paidUntil = 1791310698` (2026-10-06T18:18:18Z), `isActive = true`.

### 6.2 The invite — what a user actually shares

Membership is **not** a list on chain. Only a commitment (`memberRoot`) goes on chain; adding a
member is an off-chain key delivery. The invite is the epoch key, sealed to the invitee's registered
X25519 key, delivered as a stealth key-drop.

ALICE read BOB's registered key from `KeyRegistry.keysOf(BOB).x25519`, then
`wrapGroupKey(groupKey, bobX25519)` → 81 bytes = `[0x01][crypto_box_seal(...)]`. The invite payload:

```json
{
  "type": "roomKey",
  "groupId": "0x7dffb31fb1ed2fbca91d3bfe6ee19173dd828b3075ebae4fbcd9255b5cefc663",
  "epoch": 0,
  "name": "vault-ops",
  "wrapped": "0x017b1d79376538781defb3a931bdcfaba9c6f10c16674e7c524a26ec6a0c1acd2e5bf16ab61aa3aa3a3fd320506f241e8a0e1a5c80f64a964475ca519dc925f40bb9a1e2c8858d86fc4beac71d4c09bc02"
}
```

That JSON was sealed to BOB as a `kind:'system'` drop and anchored:
**seq `5`, tx `0x43066f8d64a6365389c11ac47b77a119f57ec306cf8ef13ed81849b4f3cd38ff`, block 108**
(with `convoId = 0x00…0`, so the room membership itself is not announced on chain).

BOB opened it and ran `unwrapGroupKey()`:

```
BOB's unwrapped room key   0x3708c241b4b8ec4b4f8ed1f7989ce61719dd2fc672baa3adcf02cb3d62cf7abc
ALICE's room key           0x3708c241b4b8ec4b4f8ed1f7989ce61719dd2fc672baa3adcf02cb3d62cf7abc
```

Byte-identical. CAROL, given the same 81 bytes, got `null` — the invite is cryptographically bound to
BOB's key.

### 6.3 Talking in the room, from both accounts

Both messages were sealed with `sealToGroup()` (which zeroes the `ephPub` slot and derives the
`viewTag` from the room key — both drops correctly showed `ephPub = 0x00…0` and `viewTag = 136`) and
anchored with `convoId = groupId`, which the contract rent-gates per drop.

| From | Message | Anchor |
|---|---|---|
| ALICE | `ALICE in #vault-ops: rotating the multisig signers on Friday.` | seq `6`, tx `0x79407031ff7ace89a8b4e90c4d06ed5b6d9c616aa709c6177e504ed18827b2d8`, block 111 |
| BOB | `BOB in #vault-ops: ack. I will prep the 3-of-5 proposal.` | seq `7`, tx `0xa17f5669af938893334fb21caf21a7a0e441597d911d374c53e94686ac88aa5f`, block 114 |

BOB read ALICE's message and ALICE read BOB's, both via `openFromGroup()`, both exact. A non-member
(a fresh random key) got `null`.

`GET /v1/drops/convo/0x7dffb31f…` returned exactly those 2 anchors (seq 6, 7) — room history is
retrievable on chain by its groupId.

### 6.4 Removing a member — `rotateEpoch`

```
memberRoot([ALICE, BOB]) = 0x69e4340efeaa279046185fdc6a4e8da3b380da823cbac3077c982df10e740119
memberRoot([BOB, ALICE]) = 0x69e4340efeaa279046185fdc6a4e8da3b380da823cbac3077c982df10e740119   (identical — it commits to the SET, not the order)
memberRoot([ALICE])      = 0xdccaa7cb0f4646ade05601920f951091423a574eca96e8b03a4a9f934d9473c1   (distinct)
```

ALICE generated a fresh epoch key and called
`rotateEpoch(groupId, memberRoot([ALICE]))` —
tx `0x71eca3996aacdf352d4211ed6b5294ddce3443212a8616bde273c39fe2144bb3`, block 118, gas 34,264.
On-chain `epoch` advanced **0 → 1**.

Then, honestly:

- BOB **cannot** read a message sealed with the new epoch-1 key → `null`. Removal works going forward.
- BOB **can** still read the epoch-0 history he already held the key for. This is the documented
  MLS-**lite** limitation in `packages/crypto/src/group.ts`, and it is real: a departed member keeps
  whatever epoch he had.

**One honest caveat about the on-chain root in this run:** because HoodGram adds members off chain
and only *removals* move the root, and because the only removal returned the set to `{ALICE}`, the
on-chain `memberRoot` value was `0xdccaa7cb…` both before and after the rotation. The root never
committed to `{ALICE, BOB}` at any point on chain. The set-commitment property was proven locally
(the three values above) but the chain never held a two-member root during this run.

---

## 7. Extras exercised

### 7.1 Rent lapse

A second room, `short-lease`
(`groupId 0xf13443bc7d169a99cdadaade224416fe45c2eb15a7aa0a4ec49c03cc5a1ecb45`), was created with
**one** month of rent (tx `0xa6815d4c434efbac83016a953bc24896bd3c2dd8d928bbc0360c06eea8c7e067`,
block 130). A message posted while the rent was current anchored fine —
**seq `8`, tx `0x3b2da5c541585ee4e8c5d3f2777750a3adb7acd0a6a13d2a6008598521052d83`, block 135**.

The chain was then advanced **31 days** with anvil's `evm_increaseTime` — a local-chain device,
disclosed here explicitly. Afterwards:

```
isActive(short-lease)        false      (1 month, lapsed)
isActive(vault-ops, 2 months) true      (still paid)

Anchors.post(...) into the lapsed room  -> reverted RoomInactive()
POST /v1/send into the lapsed room      -> 403 {"error":"room_inactive", …}
```

History survived: the message anchored while the rent was current still decrypts with the room key
after the lapse. A lapse blocks **new** messages only — exactly as specified.

### 7.2 Revenue split, epoch seal, and a real claim

TREASURY transferred ALICE 10,000,000 $THOOD (1.00% of supply, tx `0x8533a167…b705a1ef`, block 156)
and BOB 5,000,000 (0.50%, tx `0x5fa59bbe…859bd3dc`, block 160). Both then read as **Perks tier 4**.

Vault accounting was checked and balances exactly:

```
vault balance     40000000000000000000000
pendingHolders    20000000000000000000000
treasuryAccrued   20000000000000000000000     (pending + accrued == balance)
```

(That total is 2 activations at 5,000 + 2 months' rent at 10,000 + 1 month at 10,000 = 40,000 $THOOD,
split exactly 50/50.)

`RevenueVault.sealEpoch()` — tx `0x3b064ecd5623a422326beb2092cba8d07f2630bb4164190978110a2199ddf84c`,
block 168, gas 177,474 — sealed **epoch 0** at snapshot block 167. (Epoch ids are 0-based;
`epochCount()` is the length.)

```
claimable(ALICE, 0)   13333333333333333333333 wei
claimable(BOB,   0)    6666666666666666666666 wei     (exactly 2:1, matching their 10M : 5M holdings)
```

**ALICE claimed for real** — tx `0xdd9226fe959fe87273fbf7c8e8dc5467209dbb582e4f2edc2575aa6115c6f021`,
block 172. Her $THOOD balance moved
`10000000000000000000000000 → 10013333333333333333333333`, i.e. **+13333333333333333333333 wei,
exactly her computed share**. `isSolvent()` stayed true. A second claim on the same epoch reverted
`AlreadyClaimed()`.

### 7.3 The handle tier ladder, proven positively

Now at tier 4, ALICE claimed the 2-character handle `al` —
tx `0x317796ca3abe3abfb5695188fe29eb42669bf19dacee73a3951d45df395abd3a`, block 164, gas 83,391.

```
addressOf("al")         -> 0x90F79bf6EB2c4f870365E785982E1f101E93b906
handleOf(ALICE)         -> "al"
addressOf("alicehood")  -> 0x0000…0000    (the old handle was released automatically)
```

Combined with the `TierTooLow()` revert in §5.4, this proves the ladder end to end: the same account,
same contract, unable to claim a short handle at tier 0 and able to at tier 4.

---

## 8. The full anchor ledger

`Anchors.seq() = 9`. All nine indexed and served by the relay
(`/v1/stats` → `{"head":9,"totalDrops":9,"totalBlobs":14,"uniquePosters":2,"indexedBlock":627}`).

| seq | What | convoId | Poster | Size | Block | Tx |
|---|---|---|---|---|---|---|
| 1 | ALICE → BOB text | DM (stealth) | relayer | 256 | 78 | `0x80cd890aeb0b542e7fb4fe80faf9fbfd5d03558992c431296e4d1f1a4917dfb2` |
| 2 | ALICE → BOB file envelope | DM (stealth) | relayer | 1024 | 82 | `0xcf709c7f5337a443388ef9a5ecaac9c15ddf0e63898e6be74458996d0df3b5df` |
| 3 | BOB → ALICE reply | DM (stealth) | relayer | 256 | 87 | `0x4d355a1e0711d19cda17904b701cf63e4ed97e64ca456e34266c029f185a852c` |
| 4 | BOB self-post | DM (stealth) | **BOB** | 256 | 89 | `0x9cba6aa492867425b0950360c39cde27917d4d052f62f523932dec911c3200f0` |
| 5 | Room invite to BOB | DM (stealth) | relayer | 1024 | 108 | `0x43066f8d64a6365389c11ac47b77a119f57ec306cf8ef13ed81849b4f3cd38ff` |
| 6 | ALICE → #vault-ops | `0x7dffb31f…` | relayer | 256 | 111 | `0x79407031ff7ace89a8b4e90c4d06ed5b6d9c616aa709c6177e504ed18827b2d8` |
| 7 | BOB → #vault-ops | `0x7dffb31f…` | relayer | 256 | 114 | `0xa17f5669af938893334fb21caf21a7a0e441597d911d374c53e94686ac88aa5f` |
| 8 | ALICE → #short-lease (rent current) | `0xf13443bc…` | relayer | 256 | 135 | `0x3b2da5c541585ee4e8c5d3f2777750a3adb7acd0a6a13d2a6008598521052d83` |
| 9 | ALICE → #race-lease (see §9.1) | `0xd913cba5…` | relayer | 256 | 185 | `0x7fe8173e233d51380bccde74e7200b1d6eb5b99cc9cf789971ce44e1866943c4` |

Every DM sits under `convoId 0x00…0` and is posted by the relayer, so neither the sender nor the
recipient of a 1:1 message appears on chain. Every size is a padded bucket, so message length leaks
nothing.

---

## 9. Defects found

These were found *by* this exercise. They are reported because they are real, not because anything
in the brief asked for them.

### 9.1 A rent lapse inside the relay's 15-second cache window causes silent message loss

**Security holds. Durability does not.**

`apps/relay/src/sender-chain.ts:31` caches `isRoomActive` for `ROOM_TTL_MS = 15_000`. If a room's
rent lapses inside that window, `/v1/send` still consults the stale `true` and accepts the drop.

Reproduced deliberately in step 13 of the run. A room `race-lease`
(`groupId 0xd913cba59b4a2fe297653a62975557212463a334540735444e36d79dcb3637e5`) was created with one
month of rent; a message was sent (which anchored as seq 9 **and warmed the cache**); the chain was
then advanced 31 days and a second message sent immediately:

```
POST /v1/send  (lapsed room, inside the cache window)  -> 200 {"accepted":true,"queued":1}
POST /v1/send  (an ordinary DM, nothing wrong with it) -> 200 {"accepted":true,"queued":2}
```

What actually happened, from the relay's own log:

- `Anchors.postBatch` reverted `RoomInactive()` (selector `0x4b414e2c`) — **the contract refused it,
  as it must.** The lapsed-room drop was never anchored, at 60 s or at 320 s. The rent gate is sound.
- But the two drops were batched **together**, so the innocent DM reverted with it. The relay logged
  `relayed batch failed; will retry` with `drops: 2` **thirteen times** over five minutes with
  growing backoff.
- At 300 s the stale sweep fired: `evicted stale relayed drops that could not be posted in time`,
  `evicted: 2`. **Both** drops were discarded — including the perfectly valid DM
  (`blobRef 0x59da89f63921ca70bb7fd4a6a41671fbd9a5376fc28cd203aa602e6e5b7e1e19`, `convoId 0x00…0`).

Net effect: **two messages the sender was told were `accepted` were silently dropped five minutes
later, one of them for no reason of its own.** The client never learns; there is no failure callback,
no status endpoint for a queued drop, and no dead-letter record.

Two independent contributing causes, both in `apps/relay/src/sender.ts`:

1. `flushNow()` posts a batch atomically, so **one un-postable drop fails every drop batched with
   it** (head-of-line blocking, up to `MAX_BATCH = 64` at a time).
2. `evictStale()` filters the whole queue by age, so drops enqueued within the same window as the
   poisoned one are evicted alongside it, whether or not they were ever the problem.

Worth noting this is reachable without an attacker — a room's rent simply expiring at the wrong
moment is enough. It is also trivially reachable *by* an attacker: any activated account can send one
drop into a just-lapsed room and stall the relay's queue for five minutes.

Suggested directions (not implemented — outside this task's file scope): re-check room rent at flush
time rather than trusting the submit-time cache; drop the TTL to below one block; on a batch revert,
bisect or re-validate and quarantine only the offending drop; and give the client a way to learn that
a queued drop was abandoned.

### 9.2 The app and the shipped smoke test derive different identity keys on a local chain

`packages/crypto/src/identity.ts:13` hard-codes `IDENTITY_DOMAIN.chainId = 4663` (Robinhood Chain).
`apps/web/src/hooks/useIdentity.ts:192` passes `IDENTITY_DOMAIN` **unmodified**, while
`apps/relay/scripts/smoke-send.ts:101` overrides it to the live chain id. Different EIP-712 domain →
different signature → **different identity keys for the same wallet**.

So on chain 31337, an account created in the browser and an account created by a script are two
different identities, and messages sealed to one cannot be opened by the other. This proof followed
the smoke-send convention (chainId 31337) throughout, consistently, so nothing here is affected — but
the two code paths disagree and one of them is wrong. Whichever is intended, they should match.

---

## 10. What could NOT be proven, and why

Stated plainly. None of the following was faked, approximated, or quietly skipped.

**Not exercised at all:**

1. **The browser UI.** Not a single React component, wallet-connect flow, or rendered pixel was
   exercised. The brief forbids running `pnpm dev`/`pnpm build` in `apps/web` (the orchestrator owns
   the shared `.next` directory), so the UI could not be driven. Everything here went through the
   *same* `@hoodgram/crypto` functions and the *same* relay HTTP API that the UI calls, and
   `apps/web/.env.local` is already pointed at these nine addresses — but "the library and the API
   work" is not the same claim as "the UI works", and I am not making the second one. Combined with
   §9.2, a browser account on this chain would in fact derive *different* identity keys than the ones
   proven here.
2. **A real network.** Everything ran on anvil (chain 31337) with 1-second blocks and instant
   finality. Nothing here says anything about Robinhood Chain (4663) gas costs, mempool behaviour,
   reorgs, or RPC reliability.
3. **`Activation.activateWithPermit`** — the gasless-approval variant. Only the
   `approve` + `activate` path was proven.
4. **`GroupRegistry`: `payRent` (extending an existing room), `renewFor`, `setAutoRenew`,
   `transferAdmin`, `grantRent`.** Only `createGroup` and `rotateEpoch` were exercised.
5. **`RevenueVault`: `claimMany`, `sweepExpired`, `withdrawTreasury`, multi-epoch accumulation.**
   One epoch was sealed and one claim was made.
6. **Perks tiers 1, 2 and 3.** Only tier 0 (both accounts at the start) and tier 4 (ALICE after
   funding) were observed. `Handles.requiredTier` for 3-character names was never exercised against a
   real tier-3 holder.
7. **`Handles.release()`** as an explicit call. Release was proven only as the implicit side effect
   of re-claiming (`alicehood` → `al`).
8. **Batching at scale.** `Anchors.MAX_BATCH = 64`, but every batch in this run held 1 or 2 drops.
   Nothing here proves behaviour at 64, nor `BatchTooLarge()`/`EmptyBatch()`.
9. **The websocket `/v1/stream`.** All reads went over HTTP polling.
10. **Larger media tiers.** Only the 262,144-byte bucket was used. The 1 MiB and 4 MiB buckets, and
    the `413 payload_too_large` boundary at `MAX_BLOB_BYTES`, were not exercised.
11. **`kind:'react'` reactions**, and blob retention/pruning (`RELAY_BLOB_TTL_DAYS`, off by default).
12. **Multi-relay / censorship-in-practice.** The self-post fallback was proven to *work* (§5.8), but
    no scenario was run in which the relay actively refuses and a client falls back to it.

**Proven, but with a caveat you should know about:**

13. **Time was advanced artificially.** The rent-lapse test (§7.1), the epoch-interval gate
    (`EPOCH_MIN_INTERVAL = 7 days`) and the §9.1 race all required jumping the chain forward with
    anvil's `evm_increaseTime` (31 days, twice). That is a local-chain device and cannot be done on a
    real network. Everything else ran in real elapsed time.
14. **The on-chain `memberRoot` never held a two-member set** during this run — see the caveat at the
    end of §6.4. The set-commitment property was proven locally, not on chain.
15. **A drop's `poster` for relayed messages is the relayer**, so "the sender never appears on chain"
    is proven — but it also means the chain alone cannot attribute a relayed message to its author.
    Attribution rests on the relay's off-chain signature check, which was proven to work (§5.5) but
    which is a trust assumption, exactly as `sender.ts` documents.

---

## 11. Cleanup

The chain and the relay were both stopped after the run. Scratch artifacts live under
`/tmp/hoodgram-proof/` and are not part of the repository; this document is the only file added.

No repository source was modified to make any of the above pass. No security property was weakened,
relaxed, or worked around at any point — where the system refused something (§5.4, §5.5, §5.8, §7.1,
§9.1), the refusal is recorded as the result.
