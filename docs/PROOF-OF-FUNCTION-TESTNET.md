# HoodGram — Proof of Function on a Real Public Network

**Run date:** 2026-08-08, 00:59:13Z → 01:00:40Z (87 seconds of wall clock).
**Chain:** Robinhood Chain **testnet**, chain id `46630` (`0xb626`), an Arbitrum Nitro rollup
(`nitro/v3.11.3-rc.9-beb2108`), ~0.2 s blocks, gas price `0.01 gwei`.
**RPC:** `https://rpc.testnet.chain.robinhood.com` · **Explorer:** `https://explorer.testnet.chain.robinhood.com`
**Result: PASS** for everything attempted. Three demonstrations from the anvil proof were **not
attempted** because they require time travel, which does not exist on a public chain — they are
listed in §11, not quietly skipped.

Every hash in this document is a real transaction on a real public network and can be checked by
anyone, right now, without reproducing anything. All 25 of them were independently re-read from the
chain after the run (`eth_getTransactionReceipt`) and all 25 returned `status: success`.

This is the companion to `docs/PROOF-OF-FUNCTION.md` (the anvil run). Where the two differ — gas,
tier state, the identity domain, what could and could not be proven — the difference is called out.

---

## 1. Headline result

| # | Demonstration (as briefed) | Result |
|---|---|---|
| 1 | ALICE and BOB both **ACTIVATED on chain** via the real payment path (`approve` + `activate`) | **PROVEN** |
| 2 | Both **register identity keys**; on-chain `keysOf` matches locally derived keys byte-for-byte | **PROVEN** |
| 3 | Both **claim a handle**; lookup both directions; a nonexistent handle → zero address | **PROVEN** |
| 4 | **ALICE → BOB TEXT**: sealed, anchored, BOB decrypts exactly; third party gets nothing; plaintext bytes absent from the blob | **PROVEN** |
| 5 | **ALICE → BOB FILE** (537,737 bytes): sha256 identical before/after **and** a byte-level comparison | **PROVEN** |
| 6 | **BOB → ALICE reply** — round trip in both directions | **PROVEN** |
| 7 | **Room on chain**: created, rent paid, BOB invited by wrapped-key drop, both post, both read, a non-member gets nothing | **PROVEN** |
| 8 | **THE GASLESS RELAY PATH**: ALICE spends 0 wei, the RELAYER pays, ALICE's address is nowhere in the anchoring transaction | **PROVEN** |
| — | Extras: self-post fallback, `payRent` extension, a genuine two-member `memberRoot` on chain, `rotateEpoch` removal, the handle tier ladder at tier 0 *and* tier 4 | **PROVEN** |
| — | Rent lapse · epoch seal · holder claim · the anvil §9.1 cache race | **NOT PROVABLE HERE** — see §11 |

**Final on-chain state:** `Anchors.seq() = 8` — eight anchored messages, all eight indexed and served
back by the relay (`/v1/stats` → `{"head":8,"totalDrops":8,"totalBlobs":10,"uniquePosters":2,"indexedBlock":98193562}`).

**Total cost of this entire proof: 0.0000218913 ETH** (21,891,270,000,000 wei) across 25 transactions.

---

## 2. Exactly what was run, so anyone can reproduce it

### 2.1 Prerequisites

`node v24.14.0`. `tsx` is not on `PATH`; it lives at
`/Users/nik/Desktop/TELEHOOD/apps/relay/node_modules/.bin/tsx`.
Nothing was built or deployed for this run — all nine contracts were already deployed and verified on
46630 (see §3). The web app was not started.

### 2.2 The relay, pointed at testnet

The relay reads its configuration from the process environment. **The relayer's private key was never
placed on a command line, in a flag, or in an inline env assignment.** It was read with
`readFileSync` from `/tmp/hoodgram-testnet/accounts.json` inside a launcher script, which passed it
straight into the child process's environment:

```sh
node /tmp/hoodgram-testnet-proof/start-relay.mjs
```

`start-relay.mjs` spawns `apps/relay/src/index.ts` under `tsx` with:

```
RPC_URL                = https://rpc.testnet.chain.robinhood.com
CHAIN_ID               = 46630
START_BLOCK            = 98182509          # the Anchors deploy block
RELAY_PORT             = 8788
RELAY_HOST             = 127.0.0.1
RELAY_DB_PATH          = /tmp/hoodgram-testnet-proof/relay-testnet.db   # fresh file
RELAY_LOG_LEVEL        = debug
RELAY_INDEX_CHUNK      = 20000
RELAY_POLL_MS          = 1000
RELAY_RPC_TIMEOUT_MS   = 30000
WEB_ORIGIN             = *
ANCHORS_ADDRESS        = 0x030d3dCa4283c7feA2E053C05Dcca7BAF482d51D
ACTIVATION_ADDRESS     = 0xd1a671E60CC00e9c6E037CbB979cBFEFdd93E990
GROUP_REGISTRY_ADDRESS = 0x20F2C6f1376a6c6462c43902518a9821a26f1Ee1
KEY_REGISTRY_ADDRESS   = 0x8a7d1a0748Fb89b49375Ec8bd734ec2B5AaF600F
RELAYER_PRIVATE_KEY    = <read from accounts.json at runtime; never on a command line>
```

**`START_BLOCK` matters here in a way it never did on anvil.** The chain is ~98.2 million blocks
deep. `START_BLOCK=0` would ask the indexer to scan the entire history. Setting it to the `Anchors`
deploy block means the indexer still covers every anchor that contract can ever have emitted, while
back-filling only ~11 k blocks. The first health check after boot — 18 seconds in — already reported
`indexerLagBlocks: 0`, and it stayed there for the whole run.

### 2.3 The proof harness

```sh
cd /tmp/hoodgram-testnet-proof
/Users/nik/Desktop/TELEHOOD/apps/relay/node_modules/.bin/tsx /tmp/hoodgram-testnet-proof/prooft.ts
```

`prooft.ts` (878 lines) + `libt.ts` (468 lines) are adapted from the anvil harness
(`/tmp/hoodgram-proof/proof.ts` + `lib.ts`). `node_modules` in that directory contains symlinks to the
workspace's real `@hoodgram/crypto` and `viem`, so the harness links against the **shipped source**,
not a copy. What changed for a public network:

- the chain id is a parameter (`PROOF_CHAIN_ID`, default 46630) instead of a hardcoded `31337`;
- actor keys are `readFileSync`-ed from `accounts.json` inside the script;
- the viem HTTP transport retries (6 attempts, 45 s timeout) and every read/write goes through an
  exponential-backoff wrapper that deliberately does **not** retry contract reverts;
- nonces are tracked locally per sender, so a lagging `pending` nonce on a public node cannot start a
  "nonce too low" cascade;
- `increaseTime()` was **deleted**, along with every demonstration that depended on it.

Raw artifacts from this run (session scratch, not committed):
`/tmp/hoodgram-testnet-proof/run.log` (full transcript), `evidence.jsonl` (machine-readable, one JSON
object per event), `summary.json`, `relay.log`, `verified-hashes.json` (the independent re-read of
every hash), `roundtrip-mail-sealed.mp4` (the recovered file), `keyscan.mjs` (§12).

### 2.4 Verifying it without re-running it

```sh
# any of the 25 hashes in this document
curl -s https://explorer.testnet.chain.robinhood.com/api/v2/transactions/<hash>
# or open https://explorer.testnet.chain.robinhood.com/tx/<hash>
```

---

## 3. Contract addresses (all nine, live on 46630)

Deployer / treasury / owner: `0xa50E073fE5b58a4322A9EE1F33e672049Ef32084`.
Relayer: `0x55BA22d6F48f7c25982f20EaD4F4c14A93921b9A`.
`thoodPerUsd = 1000e18`. Source of truth: `/tmp/hoodgram-testnet/deployment.json` and
`packages/crypto/src/deployments.ts` under the `46630` key.

| Contract | Address | Deploy tx | Block | Deploy gas | Runtime bytes |
|---|---|---|---|---|---|
| HoodGramToken | [`0x597AC1E5826F0FE6A1845a934Dc3f5bB25c4573F`](https://explorer.testnet.chain.robinhood.com/address/0x597AC1E5826F0FE6A1845a934Dc3f5bB25c4573F) | [`0x97693119…0ba5bde`](https://explorer.testnet.chain.robinhood.com/tx/0x97693119df6812891d2fa26b26cbfe2eff9736ad9f0c452513bd336550ba5bde) | 98182458 | 1,744,991 | 5,812 |
| ManualPriceSource | [`0xC9e4Bb2A49faE742d9082E26a2AF6a1d24249B5f`](https://explorer.testnet.chain.robinhood.com/address/0xC9e4Bb2A49faE742d9082E26a2AF6a1d24249B5f) | [`0xc1bb32ef…1b798c9d`](https://explorer.testnet.chain.robinhood.com/tx/0xc1bb32ef985ff095fd814befdaaf24256dc444a32eedce4a82ae2f5d1b798c9d) | 98182478 | 307,811 | 722 |
| RevenueVault | [`0x080B60Cd7c46C3D3B2D49C1E4dF5455402cdDB7c`](https://explorer.testnet.chain.robinhood.com/address/0x080B60Cd7c46C3D3B2D49C1E4dF5455402cdDB7c) | [`0xaa2cf54e…0b60584cc1`](https://explorer.testnet.chain.robinhood.com/tx/0xaa2cf54e137fe79f569f018a892db708c59786bc9c11c05573397a0b60584cc1) | 98182483 | 2,018,830 | 7,555 |
| Activation | [`0xd1a671E60CC00e9c6E037CbB979cBFEFdd93E990`](https://explorer.testnet.chain.robinhood.com/address/0xd1a671E60CC00e9c6E037CbB979cBFEFdd93E990) | [`0xf02ba77e…d3685c1ab`](https://explorer.testnet.chain.robinhood.com/tx/0xf02ba77ecdbe55d16a82b75b9e104230f78f76402732706c03eb935d3685c1ab) | 98182492 | 968,974 | 3,209 |
| GroupRegistry | [`0x20F2C6f1376a6c6462c43902518a9821a26f1Ee1`](https://explorer.testnet.chain.robinhood.com/address/0x20F2C6f1376a6c6462c43902518a9821a26f1Ee1) | [`0xa34d6aca…ca78d2abc7`](https://explorer.testnet.chain.robinhood.com/tx/0xa34d6aca3fba8ab6114ae1dcda3488dba0248a558a76ff6d45dbb6ca78d2abc7) | 98182495 | 1,572,350 | 5,581 |
| KeyRegistry | [`0x8a7d1a0748Fb89b49375Ec8bd734ec2B5AaF600F`](https://explorer.testnet.chain.robinhood.com/address/0x8a7d1a0748Fb89b49375Ec8bd734ec2B5AaF600F) | [`0x1fd3585c…acc8d705`](https://explorer.testnet.chain.robinhood.com/tx/0x1fd3585ce7f13a05de01c0581b472957c4013dcfa83dc1e39e4581dcacc8d705) | 98182499 | 215,652 | 597 |
| Anchors | [`0x030d3dCa4283c7feA2E053C05Dcca7BAF482d51D`](https://explorer.testnet.chain.robinhood.com/address/0x030d3dCa4283c7feA2E053C05Dcca7BAF482d51D) | [`0x222ed7d4…52b4d530`](https://explorer.testnet.chain.robinhood.com/tx/0x222ed7d406cd85848df853c4e34060e9a9ab4e32d96320d4e541a7ba52b4d530) | 98182509 | 845,965 | 2,824 |
| Perks | [`0x53d88E8Dc39d5381823a50a59Ac9056C75Fe6074`](https://explorer.testnet.chain.robinhood.com/address/0x53d88E8Dc39d5381823a50a59Ac9056C75Fe6074) | [`0xc840c50e…3ef6c7bf4`](https://explorer.testnet.chain.robinhood.com/tx/0xc840c50e7952168dadbf86d17ce7aec73e0eca4a5a751f1ec94c1a73ef6c7bf4) | 98182512 | 909,696 | 3,022 |
| Handles | [`0xA5d2c689f89A525869Ad3b4F9f12207cB2Edc867`](https://explorer.testnet.chain.robinhood.com/address/0xA5d2c689f89A525869Ad3b4F9f12207cB2Edc867) | [`0x214208ef…afb2269d`](https://explorer.testnet.chain.robinhood.com/tx/0x214208ef51730edf69cf93acc4e0103397a0053b042253ee5dec9923afb2269d) | 98182525 | 970,108 | 3,666 |

Re-verified at proof time by `eth_getCode` — every one returned non-empty runtime bytecode at the
byte counts above — and `Anchors.isRelayer(0x55BA…1b9A) == true`.

### 3.1 The accounts

These are **testnet** keys, funded from a human-gated faucet. There was exactly one grant and it
cannot be re-run.

| Role | Address | Used for |
|---|---|---|
| TREASURY / owner / deployer | `0xa50E073fE5b58a4322A9EE1F33e672049Ef32084` | holds the supply; the counterparty for the tier-ladder test |
| RELAYER | `0x55BA22d6F48f7c25982f20EaD4F4c14A93921b9A` | `Anchors.postBatch` — pays for every relayed message |
| **ALICE** | `0xD8BCf13c7fe33838C337e8B15373586c6C5B3682` | party 1 |
| **BOB** | `0x50143eEccD264a9b05D3e81420030E4F386EB0Cf` | party 2 |
| CAROL | `0x2Bb8884f5D2622BffC5a797D34137df8404CAABE` | the third party |

**Honest note on CAROL.** On anvil she was a funded default account. Here she is a **freshly
generated, completely unfunded key** — the faucet is human-gated and there was no grant for a fifth
account. She therefore never sends a transaction. She does local cryptography (which needs no chain)
and `eth_call` simulations (which cost no gas and need no balance). That is exactly the role she
played on anvil, but it means her four "revert" results in this document are **simulated against live
chain state, not mined failed transactions** — see §11.

ALICE and BOB were funded with 10,000,000 and 5,000,000 $THOOD by the deployment script *before* this
proof started. That is the one material difference from the anvil run's initial conditions, and it is
why §6 looks different.

---

## 4. Step-by-step transcript

### 4.1 Identity derivation — and one thing the anvil proof got wrong

`IDENTITY_DOMAIN` is now signed **verbatim**, exactly as `apps/web/src/hooks/useIdentity.ts` and
`apps/relay/scripts/smoke-send.ts` both sign it:

```
domain  {"name":"HoodGram","version":"1","chainId":4663}     <- pinned, NOT the connected chain
```

The anvil proof (§9.2) reported these two code paths disagreeing and overrode `chainId` to the
connected chain. That divergence has since been fixed in `packages/crypto/src/identity.ts`, and **this
run does not override anything** — the harness signs the same bytes the browser signs. Note that the
domain says 4663 while the transactions land on 46630; that is deliberate (identity must be stable
across networks) and is documented at length in `identity.ts`.

```
ALICE  0xD8BCf13c7fe33838C337e8B15373586c6C5B3682
  sig      0x12c71c3d741cf2009ae9450a0dd378d8c0813ac457f28bbe3f8734028f634a8e
           76159f476bde5cffa9aee6eaf1cf9d7eb0ab94aa412d3ffef08165490c54d29a1b
  x25519   0x30cec76130bd610fba1314a0134050327dd863c1a52d93758e0f80799f01b940
  ed25519  0x246d3d61a1850f0a2caed36477bbbc1cad2d3b87d9263d674c1ace1952bb662d

BOB    0x50143eEccD264a9b05D3e81420030E4F386EB0Cf
  sig      0x1b9f4866f9e8b69be312a2e7f119e58d1309cd6fd743d720b39f87ae2369cc77
           5387deaaa8ab8cb22f105f471af164868d9e74ec9a9da09791f3494b53a5a1021c
  x25519   0x87924deee9a6c7fd114cda8f7d0d80527c970ef7e615b8235f4c69ad90e60c6c
  ed25519  0x05f0ca00a2da4e12a6d5176c81e91954a0055842f24b73fe5ccf99259f613ece

CAROL  0x2Bb8884f5D2622BffC5a797D34137df8404CAABE
  x25519   0x3a6f053a0d0cdd87b0e19ccd1a63c5f34ce404588f4724c5a47a8ff59a2f5d3e
  ed25519  0x229a814a2f9999cae8d249203e6eeb6aa2b1d21210eeaab278a14e3a0f1e904d
```

ALICE's identity was derived a second time from a second signing of the same message and came out
**byte-identical** in both keypairs. The three identities are mutually distinct.

### 4.2 On-chain key registration — `KeyRegistry` *(brief item 2)*

| Who | Tx | Block | Gas |
|---|---|---|---|
| ALICE `register(x25519, ed25519)` | [`0x42a875c6c4bf4d1b0857936d12703b8f4ef2c3dc81c9cb3afdd10d0b1e1d2901`](https://explorer.testnet.chain.robinhood.com/tx/0x42a875c6c4bf4d1b0857936d12703b8f4ef2c3dc81c9cb3afdd10d0b1e1d2901) | 98193162 | 98,282 |
| BOB `register(x25519, ed25519)` | [`0xfd457362497b479fde212c5eb8a9b01cdc2ddd8867c2101a21d3753f007d2ecc`](https://explorer.testnet.chain.robinhood.com/tx/0xfd457362497b479fde212c5eb8a9b01cdc2ddd8867c2101a21d3753f007d2ecc) | 98193168 | 98,270 |

`keysOf()` read back off the chain, next to the locally derived bytes:

```
ALICE  on chain keysOf().x25519  = 0x30cec76130bd610fba1314a0134050327dd863c1a52d93758e0f80799f01b940
       local            x25519  = 0x30cec76130bd610fba1314a0134050327dd863c1a52d93758e0f80799f01b940   IDENTICAL
       on chain keysOf().ed25519 = 0x246d3d61a1850f0a2caed36477bbbc1cad2d3b87d9263d674c1ace1952bb662d
       local            ed25519  = 0x246d3d61a1850f0a2caed36477bbbc1cad2d3b87d9263d674c1ace1952bb662d   IDENTICAL

BOB    on chain keysOf().x25519  = 0x87924deee9a6c7fd114cda8f7d0d80527c970ef7e615b8235f4c69ad90e60c6c
       local            x25519  = 0x87924deee9a6c7fd114cda8f7d0d80527c970ef7e615b8235f4c69ad90e60c6c   IDENTICAL
       on chain keysOf().ed25519 = 0x05f0ca00a2da4e12a6d5176c81e91954a0055842f24b73fe5ccf99259f613ece
       local            ed25519  = 0x05f0ca00a2da4e12a6d5176c81e91954a0055842f24b73fe5ccf99259f613ece   IDENTICAL
```

`isRegistered()` true for both, `isRegistered(CAROL) == false` throughout.

### 4.3 Activation — the $5 handshake, paid in $THOOD *(brief item 1)*

`priceUsd = 5000000000000000000` ($5, 18dp) × `thoodPerUsd = 1000e18` ÷ 1e18 →
`quote() = 5000000000000000000000` = **5,000 $THOOD**.

| Step | Tx | Block | Gas |
|---|---|---|---|
| ALICE `approve(Activation, quote)` | [`0xc099052e625b70c57694fcddbdd410a29f8d55139e560131c6e4e070ff0a6fef`](https://explorer.testnet.chain.robinhood.com/tx/0xc099052e625b70c57694fcddbdd410a29f8d55139e560131c6e4e070ff0a6fef) | 98193181 | 55,102 |
| **ALICE `activate()`** | [`0x168f185874ac3912e80d44528d817d21904b12ad03aafa9126a1a94186b221c1`](https://explorer.testnet.chain.robinhood.com/tx/0x168f185874ac3912e80d44528d817d21904b12ad03aafa9126a1a94186b221c1) | 98193194 | **228,185** |
| BOB `approve(Activation, quote)` | [`0xc2a6b1b57ec4dfb690eab66dbfcf8f3e4236f24fe8c4bb369c451003a4d758a9`](https://explorer.testnet.chain.robinhood.com/tx/0xc2a6b1b57ec4dfb690eab66dbfcf8f3e4236f24fe8c4bb369c451003a4d758a9) | 98193203 | 55,102 |
| **BOB `activate()`** | [`0x0fdf81a60432c187e02e8f30db76c2058242318e7193d95ced1e9a99b1860d8f`](https://explorer.testnet.chain.robinhood.com/tx/0x0fdf81a60432c187e02e8f30db76c2058242318e7193d95ced1e9a99b1860d8f) | 98193211 | **162,168** |

`isActivated()` true for both. `activatedAt` = 1786150765 (ALICE, 2026-08-08T00:59:25Z) and 1786150769
(BOB, 00:59:29Z). A second `activate()` from ALICE reverts **`AlreadyActivated()`**.

**Revenue split verified on the spot.** The vault's $THOOD balance went `0 → 10000000000000000000000`
= exactly `2 × quote`, splitting `5000000000000000000000` to `pendingHolders` and
`5000000000000000000000` to `treasuryAccrued` — exactly `HOLDER_BPS = 5000` (50/50).

*Observation worth recording:* ALICE's `activate()` cost **41% more gas than BOB's** (228,185 vs
162,168) for identical work. The first activation writes the `RevenueVault`'s accounting slots from
zero; the second only updates non-zero slots. This is ordinary EVM cold/warm storage pricing, and it
is invisible on a chain where nobody has gone first.

### 4.4 Handles — claim, then search *(brief item 3)*

| Who | Handle | Tx | Block | Gas |
|---|---|---|---|---|
| ALICE | `alicehood` | [`0x16bf776fae051739d1beded064cfb8fdd1f030649c5c25fca7bd7faa1c57bb18`](https://explorer.testnet.chain.robinhood.com/tx/0x16bf776fae051739d1beded064cfb8fdd1f030649c5c25fca7bd7faa1c57bb18) | 98193237 | 88,365 |
| BOB | `bobhood` | [`0x1d3eab653a681512524958cbab794d75382d33f4adfd29f9fbf1f623849448e7`](https://explorer.testnet.chain.robinhood.com/tx/0x1d3eab653a681512524958cbab794d75382d33f4adfd29f9fbf1f623849448e7) | 98193241 | 87,829 |

Read straight off the chain, both directions, plus two handles that were never claimed:

```
addressOf("alicehood")     -> 0xD8BCf13c7fe33838C337e8B15373586c6C5B3682   == ALICE
addressOf("bobhood")       -> 0x50143eEccD264a9b05D3e81420030E4F386EB0Cf   == BOB
handleOf(ALICE)            -> "alicehood"
handleOf(BOB)              -> "bobhood"
addressOf("nosuchuser")    -> 0x0000000000000000000000000000000000000000   (never claimed)
addressOf("definitelynot") -> 0x0000000000000000000000000000000000000000   (never claimed)
```

`requiredTier()`, read from the deployed contract: `2 chars → 4`, `3 → 3`, `4 → 2`, `5/9/15 → 0`.

Negative cases, each reverting with the named custom error:

| Attempt | Revert |
|---|---|
| BOB claims `alicehood` (already taken) | `HandleTaken()` |
| ALICE claims `Alice` (uppercase) | `InvalidHandle()` |
| CAROL claims `carolhood` (never activated) | `NotActivated()` |
| ALICE claims `al1c` while at tier 0 (§4.5) | `TierTooLow()` |
| ALICE claims `al` while at tier 0 (§4.5) | `TierTooLow()` |

### 4.5 The tier ladder, proven on chain with one account

On anvil both accounts happened to be tier 0 when they claimed, because they had just spent
everything on activation. Here both were funded to tier 4 before the run started, so the ladder was
exercised **deliberately**, with real transfers, on the real chain.

`Perks.thresholdAmount(1) = 500,000e18` (0.05% of supply) · `thresholdAmount(4) = 5,000,000e18` (0.50%).

| Step | Tx | Block | Gas | Result |
|---|---|---|---|---|
| ALICE parks 9,895,000 THOOD with TREASURY | [`0xf6667f2fdfddc2ec1bf8599741675dafa0b4365e953a3403a835ec04d91a5d7a`](https://explorer.testnet.chain.robinhood.com/tx/0xf6667f2fdfddc2ec1bf8599741675dafa0b4365e953a3403a835ec04d91a5d7a) | 98193255 | 104,243 | `tierOf(ALICE)` 4 → **0** |
| ALICE claims `al1c` (4 chars, needs tier 2) | — | — | — | **`TierTooLow()`** |
| ALICE claims `al` (2 chars, needs tier 4) | — | — | — | **`TierTooLow()`** |
| TREASURY returns 9,895,000 THOOD | [`0x0111200f9c83f3a02451e1811c611bb30060ba10de41d1cab37a3cdc21613ed4`](https://explorer.testnet.chain.robinhood.com/tx/0x0111200f9c83f3a02451e1811c611bb30060ba10de41d1cab37a3cdc21613ed4) | 98193274 | 104,195 | `tierOf(ALICE)` 0 → **4** |
| **ALICE claims `al`** | [`0x54ea6f2c4ad22f8ccf508ec7786b1c14914812901679801e6d9a050757e2ba31`](https://explorer.testnet.chain.robinhood.com/tx/0x54ea6f2c4ad22f8ccf508ec7786b1c14914812901679801e6d9a050757e2ba31) | 98193280 | 93,681 | **succeeds** |

```
addressOf("al")        -> 0xD8BCf13c7fe33838C337e8B15373586c6C5B3682
handleOf(ALICE)        -> "al"
addressOf("alicehood") -> 0x0000…0000     (the old handle was released automatically)
```

Same account, same contract, same chain — refused at tier 0, allowed at tier 4.

*Also observed:* BOB read as **tier 3**, not tier 4, immediately after activating — paying 5,000
THOOD took him from 5,000,000 to 4,995,000, one thousandth of a percent under the 0.50% tier-4
threshold. Tiers 0, 3 and 4 were all observed on chain during this run.

### 4.6 ALICE → BOB, a text message *(brief item 4)*

Plaintext (71 bytes): `Bob — the vault audit is at 14:00 tomorrow. Bring the cold wallet. -A`

```
seal(pt, BOB.x25519pub) ->
  sealed blob   329 bytes   (payload padded to bucket 256 of 256/1024/4096/16384)
  blobRef       0x8370b398efdb3653c0e52f4333cf178f7e9a0d74f07cbd7348eca10e8def06db
  ephPub        0x946b15fdf47cf59e94f23ed50d97f3ea5f931bcc05b8578833daaed03e1b7264
  viewTag       200
  ciphertext    01946b15fdf47cf59e94f23ed50d97f3ea5f931bcc05b8578833daaed03e1b7264
                02638911fdf91443d6c0b77250ff67…
```

**The plaintext is not in the blob.** Checked as raw bytes, four ways: the full 71-byte UTF-8
sequence, the same string as latin-1, and the fragments `vault audit` and `cold wallet`. None occur
anywhere in the 329-byte ciphertext. A positive control (searching a buffer that *does* contain the
needle) passes, so the search itself is not vacuous.

Path: `POST /v1/blob` (the relay content-addressed it to the same ref) → `signDrop()` with ALICE's
Ed25519 identity key → `POST /v1/send` → the relay batched it → `Anchors.postBatch` on chain.

**Anchor: seq `1`, tx [`0xa095325e411b13318f776253428cf0b508ea825df74134562c5e7c5a6fb7916f`](https://explorer.testnet.chain.robinhood.com/tx/0xa095325e411b13318f776253428cf0b508ea825df74134562c5e7c5a6fb7916f), block 98193298.**
On-chain `convoId` is `0x00…0` (stealth) and the on-chain `poster` is the **relayer's** address.

**BOB found it the way the app does.** He scanned every anchored drop the relay served and ran
`scanMatches(ephPub, viewTag, bobPriv)` on each, matching exactly his own. He fetched the blob
(`GET /v1/blob/<ref>`; the returned bytes re-hash to the ref) and ran `open()`:

```
BOB decrypts  "Bob — the vault audit is at 14:00 tomorrow. Bring the cold wallet. -A"
```

Byte-for-byte identical, `kind == 'text'`.

**The third party gets nothing.** CAROL, handed the identical ciphertext from the public relay:

| | Result |
|---|---|
| `scanMatches(ephPub, viewTag, CAROL_priv)` | `false` |
| `open(blob, CAROL_priv, CAROL_pub)` | `null` |
| `open(blob, ALICE_priv, ALICE_pub)` — the *sender* | `null` (the ephemeral secret is discarded at seal time) |

**The relay is not a blind pipe:**

```
POST /v1/send, signature with one byte flipped
  -> 401 {"error":"bad_signature","message":"signature does not match the drop and the registered identity key"}
POST /v1/send, sender = CAROL (no key on chain)
  -> 401 {"error":"unknown_key","message":"sender has no registered identity key; call KeyRegistry.register first"}
```

### 4.7 ALICE → BOB, a real file *(brief item 5)*

Real file from this repo: `apps/web/public/media/mail-sealed.mp4` — deliberately larger than the
anvil run's 177 KB PNG, so a **different media bucket** is exercised.

```
bytes           537,737
sha256 BEFORE   e12c4b51282f6f504e85fe2b41306fe20ba2c2e62c6e6615b19567853a97a6e7
```

Two-blob flow, exactly as `apps/web/src/hooks/useSendMessage.ts` does it:

1. `sealMedia(fileBytes)` → media blob **1,048,617 bytes** (padded up to the **1 MiB** bucket — the
   anvil run only ever touched 262,144),
   `blobRef 0x198c5d0328cafdc54606aca13f53d93e8556e314f91e010ad742c9791d606a3c`,
   key `0xefa43090b44ef7d8e5a5e72b016c951bd44304801684e77daa479c0502b7c40a`.
2. `POST /v1/blob` with the media ciphertext — the relay returned the same ref.
3. A descriptor `{mime, name, bytes, ref, key}` sealed to BOB as a `kind:'media'` drop
   (`blobRef 0x9925b89d05f0757ad2474bd18bb0bf223722bc62e3ef91ef1c01f87eae70113b`, bucket 1024) and
   anchored. **The decryption key travels only inside the E2E envelope; the relay stores two opaque
   ciphertexts and never sees the key.**

**Anchor: seq `2`, tx [`0xbdc66e3f72157d27e3e980f7d3d171fb09ec5ee7f78a8db930b167ae43911f1f`](https://explorer.testnet.chain.robinhood.com/tx/0xbdc66e3f72157d27e3e980f7d3d171fb09ec5ee7f78a8db930b167ae43911f1f), block 98193314.**

BOB opened the envelope, read the descriptor (`mail-sealed.mp4 video/mp4 537737 bytes ref
0x198c5d03…`), fetched the media ciphertext by that ref, and ran `openMedia()`:

```
sha256 AFTER    e12c4b51282f6f504e85fe2b41306fe20ba2c2e62c6e6615b19567853a97a6e7
```

**Three independent confirmations, not just the digest:**

1. `sha256` identical before and after.
2. Length identical (537,737 = 537,737).
3. **An element-wise byte comparison over all 537,737 bytes — first differing offset: none.**
   Plus `Buffer.equals()` as a second implementation of the same check.

The recovered file was written to `/tmp/hoodgram-testnet-proof/roundtrip-mail-sealed.mp4`, and
verified **outside the harness** with the system tools:

```
$ cmp apps/web/public/media/mail-sealed.mp4 /tmp/hoodgram-testnet-proof/roundtrip-mail-sealed.mp4
$ echo $?
0
$ shasum -a 256 both files
e12c4b51282f6f504e85fe2b41306fe20ba2c2e62c6e6615b19567853a97a6e7  (original)
e12c4b51282f6f504e85fe2b41306fe20ba2c2e62c6e6615b19567853a97a6e7  (recovered)
```

CAROL, holding both ciphertexts: `open(envelope)` → `null`; `openMedia(mediaBlob, randomKey)` →
`null`. She recovers neither the key nor the file.

### 4.8 BOB → ALICE, the reply *(brief item 6)*

Plaintext: `Got it. 14:00 confirmed. Cold wallet + the paper backup. -B`, sealed to ALICE with
`re: 0x8370b398…06db` — a thread pointer back to ALICE's original message.

**Anchor: seq `3`, tx [`0xaa880611e52bc823119588235fefcb5d02e64a177677f8f6b942a6f858d44a40`](https://explorer.testnet.chain.robinhood.com/tx/0xaa880611e52bc823119588235fefcb5d02e64a177677f8f6b942a6f858d44a40), block 98193330.**

ALICE decrypted it exactly and the `re` field survived. BOB — the sender — could **not** re-open his
own ciphertext (`null`), the same asymmetry ALICE had. Both sides independently computed the same 1:1
thread id, `convoIdFor(A,B) == convoIdFor(B,A) ==
0x02e95317b71545352ab09faad284c29573848dd6f126ffe4ef50f8e65c76917e`; the on-chain `convoId` for a DM
stays `0x00…0` by design.

### 4.9 Self-post fallback — anchoring without the relay

BOB called `Anchors.post(...)` from his own wallet:
tx [`0xe6b55db77fafe4ee86efe42dc13d74a59bddfc55fca133cc2383ed9145b45de2`](https://explorer.testnet.chain.robinhood.com/tx/0xe6b55db77fafe4ee86efe42dc13d74a59bddfc55fca133cc2383ed9145b45de2),
block 98193336, gas 52,649. The receipt's `Dropped` event carried **seq 4** and
`poster = 0x50143eEc…B0Cf` — BOB's own address, which is the documented trade-off of self-posting.
The relay's indexer picked it up and served it back like any other anchor. CAROL attempting the same
reverts **`NotActivated()`**. Censorship resistance is real: an activated account can always anchor
without the relay's cooperation, and this now holds on a network the relay operator does not control.

---

## 5. The room *(brief item 7)*

### 5.1 Creation and rent

```
name         "vault-ops"
salt         0x4cd6758b7beb5cfe8b711bdf1b241a89
groupId      0xea96b0d1ee975df7022ee650d2b9f244b787bde7dd24d76c011d71366615d3c4
             (= groupIdFor(name, ALICE, salt))
memberRoot   0x428793a2c9f76cb07c4d97b865074b1a564f708874d5812c04402cc031ad8177
             (= memberRoot([ALICE]))
rent         rentUsdPerMonth = 10e18 ($10/mo); quoteRent(2) = 20,000e18 $THOOD
```

| Step | Tx | Block | Gas |
|---|---|---|---|
| ALICE `approve(GroupRegistry, 20,000e18)` | [`0x69a717586adc1aac4065e68afd20d1a045c5b671f7cec1796293a68d9bdb4a8b`](https://explorer.testnet.chain.robinhood.com/tx/0x69a717586adc1aac4065e68afd20d1a045c5b671f7cec1796293a68d9bdb4a8b) | 98193370 | 55,102 |
| **ALICE `createGroup(groupId, root, 2)`** | [`0xfe102fffcc0a2e1e8b6b5e1d56e6386be3adb62511edd2420fae093151b48151`](https://explorer.testnet.chain.robinhood.com/tx/0xfe102fffcc0a2e1e8b6b5e1d56e6386be3adb62511edd2420fae093151b48151) | 98193390 | 221,081 |
| ALICE `approve(GroupRegistry, 10,000e18)` | [`0xdffc8f4e92d1d7822a93d8cf4713b0bc075a6e5254a19f721feeaed8f5106abd`](https://explorer.testnet.chain.robinhood.com/tx/0xdffc8f4e92d1d7822a93d8cf4713b0bc075a6e5254a19f721feeaed8f5106abd) | 98193398 | 55,102 |
| **ALICE `payRent(groupId, 1)`** | [`0xa0dad2a82bc8d90c2ff40b33db6c89262842dd5282739efd4303a87315bf5d29`](https://explorer.testnet.chain.robinhood.com/tx/0xa0dad2a82bc8d90c2ff40b33db6c89262842dd5282739efd4303a87315bf5d29) | 98193409 | 149,815 |

On-chain state read back: `admin = ALICE`, `epoch = 0`, `memberRoot = 0x428793a2…`,
`paidUntil = 1791334806` (2026-10-07T01:00:06Z), `isActive = true`. `payRent(+1 month)` then moved
`paidUntil` to `1793926806` — exactly `+2,592,000 s` = 30.00 days. **`payRent` is new here; the anvil
run never exercised it.** Total rent paid into the vault: 30,000 $THOOD.

### 5.2 The invite — what a user actually shares

Membership is **not** a list on chain. Only a commitment (`memberRoot`) goes on chain; adding a member
is an off-chain key delivery. ALICE read BOB's registered key from `KeyRegistry.keysOf(BOB).x25519`,
then `wrapGroupKey(groupKey, bobX25519)` → 81 bytes = `[0x01][crypto_box_seal(...)]`:

```json
{
  "type": "roomKey",
  "groupId": "0xea96b0d1ee975df7022ee650d2b9f244b787bde7dd24d76c011d71366615d3c4",
  "epoch": 0,
  "name": "vault-ops",
  "wrapped": "0x01f6e8e199f002964c4516815cf4bfa50cc7f81235caff2e93e5822101c1db2c0c00d3301f64d6b0941ff1421e5bf7a636e382b6e88dfd39e8d389f32ebba301f63e2e1fcb4d5e062b9d0f15e4e3223047"
}
```

Sealed to BOB as a `kind:'system'` drop and anchored: **seq `5`, tx
[`0xad5c5c6420ec5e50a76aff7e28cb63e59dc13ed0b145feac47723bb47f12f85b`](https://explorer.testnet.chain.robinhood.com/tx/0xad5c5c6420ec5e50a76aff7e28cb63e59dc13ed0b145feac47723bb47f12f85b), block 98193424**,
with `convoId = 0x00…0`, so the room membership itself is never announced on chain.

BOB opened it and ran `unwrapGroupKey()`:

```
BOB's unwrapped room key   0x6e4123c594548ddc888999c5c8c2392b6ebdabcab4327ac58ff78bb831a91434
ALICE's room key           0x6e4123c594548ddc888999c5c8c2392b6ebdabcab4327ac58ff78bb831a91434
```

Byte-identical. CAROL, given the same 81 bytes, got `null`.

### 5.3 Talking in the room, from both accounts

Both messages were sealed with `sealToGroup()` — which zeroes the `ephPub` slot and derives the
`viewTag` from the room key (both verified) — and anchored with `convoId = groupId`, which the
contract rent-gates per drop.

| From | Message | Anchor |
|---|---|---|
| ALICE | `ALICE in #vault-ops: rotating the multisig signers on Friday.` | seq `6`, tx [`0x477da41e864e7860f4148b080e554fc0391a6d0e340f56a9cc33f78fecaaa2a2`](https://explorer.testnet.chain.robinhood.com/tx/0x477da41e864e7860f4148b080e554fc0391a6d0e340f56a9cc33f78fecaaa2a2), block 98193448 |
| BOB | `BOB in #vault-ops: ack. I will prep the 3-of-5 proposal.` | seq `7`, tx [`0x720922e6ecdd666dc97514401831a70cef582d9f7609d0be87e340ab3a1407c0`](https://explorer.testnet.chain.robinhood.com/tx/0x720922e6ecdd666dc97514401831a70cef582d9f7609d0be87e340ab3a1407c0), block 98193466 |

BOB read ALICE's message, ALICE read BOB's, both via `openFromGroup()`, both exact. A non-member (a
fresh random room key) got `null`; CAROL, trying the DM path on the same ciphertext, also got `null`.
`GET /v1/drops/convo/0xea96b0d1…` returned exactly those 2 anchors (seq 6, 7).

### 5.4 Removing a member — `rotateEpoch`

```
memberRoot([ALICE, BOB]) = 0xcc9a2a9856ba7bc7db5b674cb8c3e644e713478f9efb9d44942be063271cabef
memberRoot([BOB, ALICE]) = 0xcc9a2a9856ba7bc7db5b674cb8c3e644e713478f9efb9d44942be063271cabef   (identical — it commits to the SET)
memberRoot([ALICE])      = 0x428793a2c9f76cb07c4d97b865074b1a564f708874d5812c04402cc031ad8177   (distinct)
```

The anvil document carried an honest caveat here: the on-chain root never actually held a two-member
set. **That gap is closed on testnet.** Two rotations were performed:

| Step | Tx | Block | Gas | On-chain result |
|---|---|---|---|---|
| `rotateEpoch(groupId, memberRoot([ALICE,BOB]))` | [`0xa2ee0f022a7bf54656840bc70c398cdc7a47317425e182c4af989df0c62de6f2`](https://explorer.testnet.chain.robinhood.com/tx/0xa2ee0f022a7bf54656840bc70c398cdc7a47317425e182c4af989df0c62de6f2) | 98193481 | 45,753 | epoch 0 → 1, root = the **two-member** root |
| `rotateEpoch(groupId, memberRoot([ALICE]))` — kick BOB | [`0x2eda690ff359ebc81ef30ad844c1dd39c3a3bce4dcbf9eb99e9dbfafbc0829d0`](https://explorer.testnet.chain.robinhood.com/tx/0x2eda690ff359ebc81ef30ad844c1dd39c3a3bce4dcbf9eb99e9dbfafbc0829d0) | 98193489 | 45,753 | epoch 1 → 2, root back to the solo root |

Then, honestly:

- BOB **cannot** read a message sealed with the new epoch key → `null`. Removal works going forward.
- BOB **can** still read the epoch-0 history he already held the key for. This is the documented
  MLS-**lite** limitation in `packages/crypto/src/group.ts`, and it is real.

---

## 6. The revenue engine — what was and was not proven

Read off the chain at the end of the run:

```
vault balance     40000000000000000000000
pendingHolders    20000000000000000000000
treasuryAccrued   20000000000000000000000      (pending + accrued == balance, split exactly 50/50)
```

That total is 2 activations at 5,000 + 2 months' rent at 10,000 + 1 month at 10,000 = 40,000 $THOOD.
Every wei that entered the vault is accounted for.

**The epoch seal could not be run.** `RevenueVault.nextSealAt() = 1786753234` = 2026-08-15T00:20:34Z;
chain time at the end of the run was 1786150828 = 2026-08-08T01:00:28Z. That is **6.97 days away**,
because `EPOCH_MIN_INTERVAL` is 7 days and the contract was deployed today. Calling `sealEpoch()`
reverts **`TooSoon()`**, which is the correct behaviour and is recorded as the result. `epochCount()`
is still `0`, so no `claimable()` and no holder claim could be demonstrated. See §11.

---

## 7. The gasless relay path, measured *(brief item 8)*

This is the product's core promise and the thing the anvil run proved least convincingly. It was
measured directly, around one isolated send with nothing else in the relay's queue.

**Message:** `This message cost me zero gas. The relayer paid, and my address is nowhere in that transaction. -A`
**Anchor: seq `8`, tx [`0x0a4e8e950a57a0a1b363fa9f7fe98ae686a01144a3f7e07befcfe4d438b100ca`](https://explorer.testnet.chain.robinhood.com/tx/0x0a4e8e950a57a0a1b363fa9f7fe98ae686a01144a3f7e07befcfe4d438b100ca), block 98193531.**

| | ALICE (the sender) | RELAYER |
|---|---|---|
| ETH before | `2486787600000000` wei | `2496630020000000` wei |
| ETH after | `2486787600000000` wei | `2496115500000000` wei |
| **Delta** | **`0` wei** | **`−514520000000` wei** |
| Nonce before → after | **15 → 15** (no transaction sent) | 6 → 7 (exactly one) |

The anchoring transaction itself:

```
tx.from       0x55ba22d6f48f7c25982f20ead4f4c14a93921b9a   == RELAYER
tx.to         0x030d3dca4283c7fea2e053c05dcca7baf482d51d   == Anchors
gasUsed       51,452      effectiveGasPrice 10,000,000 wei      fee 514,520,000,000 wei
calldata      228 bytes
```

The relayer's balance fell by **exactly** `gasUsed × effectiveGasPrice` — `514520000000` wei against a
receipt fee of `514520000000` wei, an exact match with no L2 surcharge or refund left over.

**ALICE's address does not occur in that transaction.** The check searched the concatenation of the
raw calldata, every log topic and every log data field for the 20-byte address:

```
search for 0xD8BCf13c7fe33838C337e8B15373586c6C5B3682  (ALICE, the sender)     NOT FOUND
search for 0x50143eEccD264a9b05D3e81420030E4F386EB0Cf  (BOB, the recipient)    NOT FOUND
search for 0x55BA22d6F48f7c25982f20EaD4F4c14A93921b9A  (RELAYER, control)      FOUND
```

The positive control matters: the same search *does* find the relayer, so the search is not vacuous.

**The same check was then run over every relayed anchor in the run** — all seven — and neither
ALICE's nor BOB's address appears in any of them:

| Anchor tx | Gas | Fee (wei) | Drops in batch |
|---|---|---|---|
| [`0xa095325e…6fb7916f`](https://explorer.testnet.chain.robinhood.com/tx/0xa095325e411b13318f776253428cf0b508ea825df74134562c5e7c5a6fb7916f) | 68,601 | 686,010,000,000 | 1 |
| [`0xbdc66e3f…43911f1f`](https://explorer.testnet.chain.robinhood.com/tx/0xbdc66e3f72157d27e3e980f7d3d171fb09ec5ee7f78a8db930b167ae43911f1f) | 51,064 | 510,640,000,000 | 1 |
| [`0xaa880611…f858d44a40`](https://explorer.testnet.chain.robinhood.com/tx/0xaa880611e52bc823119588235fefcb5d02e64a177677f8f6b942a6f858d44a40) | 51,501 | 515,010,000,000 | 1 |
| [`0xad5c5c64…b47f12f85b`](https://explorer.testnet.chain.robinhood.com/tx/0xad5c5c6420ec5e50a76aff7e28cb63e59dc13ed0b145feac47723bb47f12f85b) | 51,113 | 511,130,000,000 | 1 |
| [`0x477da41e…fecaaa2a2`](https://explorer.testnet.chain.robinhood.com/tx/0x477da41e864e7860f4148b080e554fc0391a6d0e340f56a9cc33f78fecaaa2a2) | 57,311 | 573,110,000,000 | 1 |
| [`0x720922e6…3a1407c0`](https://explorer.testnet.chain.robinhood.com/tx/0x720922e6ecdd666dc97514401831a70cef582d9f7609d0be87e340ab3a1407c0) | 57,408 | 574,080,000,000 | 1 |
| [`0x0a4e8e95…d438b100ca`](https://explorer.testnet.chain.robinhood.com/tx/0x0a4e8e950a57a0a1b363fa9f7fe98ae686a01144a3f7e07befcfe4d438b100ca) | 51,452 | 514,520,000,000 | 1 |
| **total** | **388,450** | **3,884,500,000,000** (0.0000038845 ETH) | 7 |

**Cost per relayed message: about 55,500 gas ≈ 555 gwei ≈ 0.000000555 ETH.** Room drops (`convoId`
non-zero, seq 6 and 7 at ~57.3 k) cost ~6 k more than DMs (`convoId` zero, ~51.1 k) because the
non-zero indexed topic is not free. The first anchor cost 68,601 — cold storage again.

**End-to-end latency, measured from the relay's own log:** `POST /v1/send` returning 200 → the
`postBatch` transaction confirmed took **1,284–2,922 ms** (the relay's flush interval is 1,500 ms),
and the indexer served the anchor back **1,163–1,666 ms** after that. A user therefore sees their
message anchored and readable in **under 5 seconds**, end to end, having paid nothing.

**One precise statement of what this proves and what it does not.** ALICE's address does appear on
chain elsewhere in this run — she sent 12 transactions of her own (register, approve ×3, activate,
claim ×2, transfer, createGroup, payRent, rotateEpoch ×2), and her nonce moved 3 → 15. The claim
proven here is narrower, and it is the one that matters for a messenger: **no message anchor reveals
who sent it or who it was for.** The chain sees the relayer posting opaque, bucket-padded blob
references.

---

## 8. The full anchor ledger

`Anchors.seq() = 8`. All eight indexed and served by the relay
(`/v1/stats` → `{"head":8,"totalDrops":8,"totalBlobs":10,"uniquePosters":2,"indexedBlock":98193562}`).

| seq | What | convoId | Poster | Size | Block | Tx |
|---|---|---|---|---|---|---|
| 1 | ALICE → BOB text | DM (stealth) | relayer | 256 | 98193298 | [`0xa095325e…6fb7916f`](https://explorer.testnet.chain.robinhood.com/tx/0xa095325e411b13318f776253428cf0b508ea825df74134562c5e7c5a6fb7916f) |
| 2 | ALICE → BOB file envelope | DM (stealth) | relayer | 1024 | 98193314 | [`0xbdc66e3f…43911f1f`](https://explorer.testnet.chain.robinhood.com/tx/0xbdc66e3f72157d27e3e980f7d3d171fb09ec5ee7f78a8db930b167ae43911f1f) |
| 3 | BOB → ALICE reply | DM (stealth) | relayer | 256 | 98193330 | [`0xaa880611…f858d44a40`](https://explorer.testnet.chain.robinhood.com/tx/0xaa880611e52bc823119588235fefcb5d02e64a177677f8f6b942a6f858d44a40) |
| 4 | BOB self-post (no relay) | DM (stealth) | **BOB** | 256 | 98193336 | [`0xe6b55db7…45b45de2`](https://explorer.testnet.chain.robinhood.com/tx/0xe6b55db77fafe4ee86efe42dc13d74a59bddfc55fca133cc2383ed9145b45de2) |
| 5 | Room invite to BOB | DM (stealth) | relayer | 1024 | 98193424 | [`0xad5c5c64…b47f12f85b`](https://explorer.testnet.chain.robinhood.com/tx/0xad5c5c6420ec5e50a76aff7e28cb63e59dc13ed0b145feac47723bb47f12f85b) |
| 6 | ALICE → #vault-ops | `0xea96b0d1…` | relayer | 256 | 98193448 | [`0x477da41e…fecaaa2a2`](https://explorer.testnet.chain.robinhood.com/tx/0x477da41e864e7860f4148b080e554fc0391a6d0e340f56a9cc33f78fecaaa2a2) |
| 7 | BOB → #vault-ops | `0xea96b0d1…` | relayer | 256 | 98193466 | [`0x720922e6…3a1407c0`](https://explorer.testnet.chain.robinhood.com/tx/0x720922e6ecdd666dc97514401831a70cef582d9f7609d0be87e340ab3a1407c0) |
| 8 | ALICE → BOB (gasless, measured) | DM (stealth) | relayer | 256 | 98193531 | [`0x0a4e8e95…d438b100ca`](https://explorer.testnet.chain.robinhood.com/tx/0x0a4e8e950a57a0a1b363fa9f7fe98ae686a01144a3f7e07befcfe4d438b100ca) |

Every DM sits under `convoId 0x00…0` and is posted by the relayer. Every size is a padded bucket, so
message length leaks nothing — a 537 KB video and a 71-byte text produce anchors of size 1024 and 256.

---

## 9. Real gas costs, and how they compare to anvil

Gas price on 46630 was `0.01 gwei` (`10,000,000` wei) for every transaction in this run.

### 9.1 Same operation, anvil vs testnet

| Operation | anvil gas | testnet gas | Δ |
|---|---|---|---|
| `KeyRegistry.register` (ALICE) | 90,915 | 98,282 | +8.1% |
| `KeyRegistry.register` (BOB) | 90,915 | 98,270 | +8.1% |
| `Handles.claim("alicehood")` | 78,075 | 88,365 | +13.2% |
| `Handles.claim("bobhood")` | 77,539 | 87,829 | +13.3% |
| `Handles.claim("al")` | 83,391 | 93,681 | +12.3% |
| `Anchors.post` (self-post) | 39,240 | 52,649 | **+34.2%** |
| `GroupRegistry.rotateEpoch` | 34,264 | 45,753 | **+33.5%** |
| Deploy: HoodGramToken | 1,519,832 | 1,744,991 | +14.8% |
| Deploy: RevenueVault | 1,780,562 | 2,018,830 | +13.4% |
| Deploy: Anchors | 741,029 | 845,965 | +14.2% |
| Deploy: all nine contracts | 8,357,386 | 9,554,377 | +14.3% |

The pattern is consistent and has a known cause: this is an **Arbitrum Nitro** chain, and the L1
data-posting cost is folded into the gas units the chain reports. The surcharge scales with calldata,
not with computation — which is why the two *smallest* operations (`Anchors.post`, `rotateEpoch`,
both dominated by their calldata rather than their storage writes) take the biggest relative hit,
while the big storage-heavy deploys sit near +14%.

**Practical consequence: budget roughly +15% over a local estimate for storage-heavy calls and up to
+35% for small calldata-heavy ones.** Anything derived from an anvil gas benchmark will
under-estimate on this chain.

### 9.2 Operations with no anvil counterpart

| Operation | testnet gas |
|---|---|
| `Activation.activate()` — first ever (ALICE) | 228,185 |
| `Activation.activate()` — second (BOB) | 162,168 |
| `HoodGramToken.approve` | 55,102 |
| `HoodGramToken.transfer` (checkpointed) | 104,195–104,243 |
| `GroupRegistry.createGroup(2 months)` | 221,081 |
| `GroupRegistry.payRent(1 month)` | 149,815 |
| `Anchors.postBatch` — 1 DM drop | 51,064–51,501 |
| `Anchors.postBatch` — 1 room drop (non-zero convoId) | 57,311–57,408 |
| `Anchors.postBatch` — first ever (cold storage) | 68,601 |

### 9.3 What the whole proof cost

| Account | Start | End | Spent |
|---|---|---|---|
| TREASURY | 0.00239776099 | 0.00239671904 | 0.00000104195 ETH |
| ALICE | 0.00249919224 | 0.00248678760 | 0.00001240464 ETH |
| BOB | 0.00250000000 | 0.00249543982 | 0.00000456018 ETH |
| RELAYER | 0.00250000000 | 0.00249611550 | 0.00000388450 ETH |
| **total** | **0.00989695323** | **0.00987506196** | **0.00002189127 ETH** |

18 user transactions (1,800,677 gas) + 7 relayer transactions (388,450 gas) = **25 transactions,
2,189,127 gas, 0.0000218913 ETH** — about 0.22% of the faucet grant. The binding constraint on
repeating this is ALICE, who does most of the work: her remaining balance funds ~200 more runs of
this size (the relayer's funds ~640).

**Cost of running HoodGram at this gas price:** a relayed message averaged 55,493 gas =
554,928,571 wei ≈ 0.000000555 ETH. At $3,000/ETH that is **$0.00166 per message** — the relayer could
carry ~600 messages per dollar.

---

## 10. What behaved differently from anvil

Reported because the brief asked, and because some of it is operationally important.

1. **`START_BLOCK` stops being cosmetic.** On a chain 98.2 M blocks deep, an unset or zero
   `START_BLOCK` would make the indexer scan the entire history before serving anything. Setting it
   to the `Anchors` deploy block (98182509) gave a full, correct index in under 12 seconds. This is a
   deployment-time footgun that anvil cannot expose.
2. **`eth_getLogs` on this RPC accepted a 100,000-block range** without complaint (probed before the
   run at 2 k / 5 k / 10 k / 20 k / 100 k spans, all ~215 ms). No pagination workaround was needed.
3. **Zero visible RPC failures.** The harness's backoff/retry wrapper was written for this run and
   never fired once — it logs every retry and `run.log` contains none, across 25 transactions and
   several hundred reads. (viem's transport-level retry sits below that wrapper and is silent, so a
   single transparently-retried request cannot be ruled out; nothing ever reached the harness.) The
   indexer logged `lastError: null` throughout and never lost its connection.
4. **No reorgs were observed.** `indexerLagBlocks` was `0` at every check. The indexer's 32-block
   re-scan path exists but was never triggered by an actual reorg, so it remains untested in anger.
5. **Blocks are ~0.2 s, not 1 s.** Waiting for receipts was *faster* than on anvil with
   `--block-time 1`. The whole proof took 87 seconds of wall clock.
6. **Cold-storage costs are visible and asymmetric.** ALICE's first `activate()` cost 41% more than
   BOB's identical second one; the first `postBatch` cost 34% more than the ones after it. On a fresh
   anvil chain every run pays first-writer prices, so the asymmetry never shows up.
7. **Nonce management mattered enough to build.** The harness tracks nonces locally per sender rather
   than trusting `eth_getTransactionCount(pending)` on every send. It was never observed to fail, so
   this is a precaution that was not stress-tested, not a fix for an observed problem.
8. **Every relayer batch held exactly one drop** — because the harness sends one message and waits for
   its anchor before sending the next. Batching at scale is therefore still unproven (see §11).

---

## 11. What could NOT be proven, and why

Stated plainly. None of the following was faked, approximated, or quietly skipped.

### 11.1 Blocked by the absence of time travel — the honest core of this section

`evm_increaseTime` does not exist on a public chain. Three demonstrations from the anvil document
depend on it and were **deliberately not attempted**:

1. **Rent lapse.** Proving that a room whose rent runs out stops accepting messages requires waiting
   31 real days. The anvil proof showed both the contract (`RoomInactive()`) and the relay (`403`)
   enforcing it; nothing equivalent could be run here. What *was* shown on testnet is the positive
   side: rent is charged, `paidUntil` is set, `payRent` extends it by exactly 30 days, and `isActive`
   is true throughout.
2. **`RevenueVault.sealEpoch()` and a holder claim.** `EPOCH_MIN_INTERVAL` is 7 days and the vault was
   deployed today; `nextSealAt` is 2026-08-15T00:20:34Z. Calling it now reverts `TooSoon()`, which is
   recorded in §6 as the correct refusal. Consequently `claimable()`, `claim()`, `AlreadyClaimed()`,
   `latestSnapshot()` and the entire snapshot-based holder payout are **unproven on this network**.
   They were proven on anvil.
3. **The anvil §9.1 rent-cache race.** Reproducing it needs a rent lapse, so it needs time travel.
   Note that `apps/relay/src/sender.ts` has since been changed to quarantine the offending drops and
   requeue their batch-mates rather than evicting the lot — that fix is **not verified by this run**.

Both become provable on this deployment by simply waiting: **#2 from 2026-08-15** (`nextSealAt`), and
**#1 from about 2026-09-07** if a one-month room is created now. Nothing in this document should be
read as evidence about either of them today.

### 11.2 Not exercised at all

4. **The browser UI.** Not one React component, wallet-connect flow, or rendered pixel. Everything
   here went through the *same* `@hoodgram/crypto` functions and the *same* relay HTTP API that the
   UI calls — but "the library and the API work" is not the claim "the UI works", and I am not making
   the second one. (Unlike the anvil run, the identity domain now matches what the browser signs, so a
   browser account on this chain *would* derive the same keys proven here.)
5. **`Activation.activateWithPermit`** — the gasless-approval variant. Only `approve` + `activate`.
6. **`GroupRegistry`: `renewFor`, `setAutoRenew`, `transferAdmin`, `grantRent`.** `createGroup`,
   `payRent` and `rotateEpoch` were exercised.
7. **`RevenueVault`: `claimMany`, `sweepExpired`, `withdrawTreasury`, multi-epoch accumulation** —
   all downstream of §11.1 #2.
8. **Perks tiers 1 and 2.** Tiers 0, 3 and 4 were observed on chain. `Handles.requiredTier` for
   3-character names was never exercised against a real tier-3 holder.
9. **`Handles.release()`** as an explicit call. Release was proven only as the implicit side effect of
   re-claiming (`alicehood` → `al`).
10. **Batching at scale.** `Anchors.MAX_BATCH = 64`; every batch in this run held exactly 1 drop.
    Nothing here proves behaviour at 64, nor `BatchTooLarge()` / `EmptyBatch()`, nor the per-drop gas
    saving batching is supposed to deliver.
11. **The websocket `/v1/stream`.** All reads went over HTTP polling.
12. **The 4 MiB media bucket and the `413 payload_too_large` boundary.** The 1 MiB bucket was
    exercised (a first — anvil only reached 262,144); 65,536 and 4,194,304 were not.
13. **`kind:'react'` reactions**, and blob retention/pruning (`RELAY_BLOB_TTL_DAYS`, off by default).
14. **Multi-relay / censorship in practice.** The self-post fallback was proven to *work* (§4.9), but
    no scenario was run in which the relay actively refuses and a client falls back to it.
15. **Concurrency, contention and sustained load.** One sender at a time, sequential, ~25 transactions
    over 87 seconds. Nothing here says anything about mempool contention, nonce races between
    processes, or the relay under parallel load.
16. **Reorg handling.** No reorg occurred; the 32-block re-scan path was never triggered.

### 11.3 Proven, but with a caveat you should know about

17. **Every "revert" in this document is an `eth_call` simulation against live chain state, not a
    mined failed transaction.** `AlreadyActivated()`, `HandleTaken()`, `InvalidHandle()`,
    `NotActivated()` ×2, `TierTooLow()` ×2 and `TooSoon()` were all obtained via `eth_call` at the real
    head of the real chain — which is how a client learns a call would fail — but no failed
    transaction was mined for any of them. This was also true of the anvil run; it is stated here
    explicitly.
18. **CAROL never sent a transaction.** She is an unfunded key (§3.1). Her negative results are local
    cryptography and `eth_call` simulations. A funded third party attempting the same on chain was not
    tested.
19. **A drop's `poster` for relayed messages is the relayer**, so "the sender never appears on chain"
    is proven — and it also means the chain alone cannot attribute a relayed message to its author.
    Attribution rests on the relay's off-chain signature check, proven to work in §4.6, but a trust
    assumption exactly as `sender.ts` documents.
20. **The tier-ladder test moved real tokens back and forth between ALICE and the TREASURY.** That is
    a contrived economic scenario. It proves the contract logic honestly (same account, refused at
    tier 0, allowed at tier 4) but it is not how a user would ever arrive at tier 4.
21. **This is testnet, not mainnet.** Chain 46630 is not chain 4663. Gas *prices* on mainnet may
    differ; gas *units* should not. Nothing here says anything about mainnet liquidity, real $THOOD
    pricing, or the behaviour of `ManualPriceSource` under a live feed.

---

## 12. Credential handling

The relayer, deployer, ALICE and BOB private keys were read **only** by `readFileSync` from
`/tmp/hoodgram-testnet/accounts.json` inside `prooft.ts` and `start-relay.mjs`. No key was ever
placed on a command line, in a CLI flag, in an inline environment assignment, or in any output.

This was verified, not asserted. `/tmp/hoodgram-testnet-proof/keyscan.mjs` reads the four keys and
searches every file under `/tmp/hoodgram-testnet-proof`, `/tmp/hoodgram-testnet`, `/tmp/hoodgram-proof`,
the entire `TELEHOOD` repository (excluding `node_modules` and `.git`), and the shell histories, for
those exact byte sequences with and without the `0x` prefix in both cases. It prints file paths and
match counts only.

```
scanned 1450 files (skipped 0 unreadable/oversized)

files containing testnet private key material:
  /tmp/hoodgram-testnet/accounts.json  (role DEPLOYER, 1 occurrence)
  /tmp/hoodgram-testnet/accounts.json  (role ALICE,    1 occurrence)
  /tmp/hoodgram-testnet/accounts.json  (role BOB,      1 occurrence)
  /tmp/hoodgram-testnet/accounts.json  (role RELAYER,  1 occurrence)

RESULT: PASS — private key material appears in exactly ONE file, /tmp/hoodgram-testnet/accounts.json,
and nowhere else.
```

Nothing in this document, in `run.log`, in `evidence.jsonl`, in `summary.json`, in `relay.log` or in
the relay's SQLite database contains a private key.

---

## 13. Independent verification of every hash

After the run, all 25 transaction hashes referenced in `summary.json` were re-read from the chain with
`eth_getTransactionReceipt` and `eth_getTransactionByHash`
(`/tmp/hoodgram-testnet-proof/verify-hashes.mjs`, output in `verified-hashes.json`):

```
unique tx hashes referenced: 25
failed receipts: 0
```

Every one returned `status: success`, with the `from`, `to`, block number and gas figures quoted in
this document. A reviewer can repeat that check against the public RPC or the explorer without any of
the tooling here.

---

## 14. Cleanup

The relay was stopped after the run. Scratch artifacts live under `/tmp/hoodgram-testnet-proof/` and
`/tmp/hoodgram-testnet/` and are not part of the repository; **this document is the only file added.**

No repository source was modified to make any of the above pass. No security property was weakened,
relaxed or worked around at any point — where the system refused something (§4.4, §4.5, §4.6, §4.9,
§6), the refusal is recorded as the result.
