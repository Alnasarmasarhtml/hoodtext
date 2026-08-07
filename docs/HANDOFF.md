# HOODGRAM — PROJECT HANDOFF

Everything a new session needs to know. Written 2026-08-07.

---

## 1. WHAT IT IS

**HoodGram** — an end-to-end encrypted messenger where every message is anchored on
**Robinhood Chain** (chainId **4663**). Token: **$THOOD**.

The one line: **Pay $5 once. Text forever.**

| Price | What it buys |
|---|---|
| **$5, one time** | An account, forever. Never renews, never expires. It is also the spam wall — every account on HoodGram cost somebody five dollars, so there are no bot floods. Includes an @handle. |
| **$10 / month per room** | A group chat, paid by whoever runs it. Members are free. *Anyone* may pay a room's rent (paying grants no control). Rent lapsing pauses NEW messages only — history, keys, membership and admin all survive, and paying again reopens it instantly. |
| **$0 per message** | Messages are free and gasless: a relay batch-posts them on chain, so no wallet popup, no gas, and the sender's address never appears on chain. Self-posting on chain is always available (~1¢ gas) and is the censorship escape hatch. |

**50% of every payment** — every $5 activation, every month of room rent — is paid to **$THOOD
holders**, pro-rata by holdings, via weekly checkpoint epochs. **No staking, no lock-up, no
deposit.** Hold it in your own wallet at the snapshot and claim.

**The holder ladder** (status and capacity only — never money, never fee discounts):

| Tier | Hold | Unlocks |
|---|---|---|
| RESIDENT | 0.05% of supply | Holder badge beside your name in every chat |
| BLOCK CAPTAIN | 0.10% | + 4-character @handles, bigger uploads, bigger rooms |
| DISTRICT | 0.25% | + 3-character @handles, early features |
| KINGPIN | 0.50% | + 2-character @handles, broadcast rooms |

Short @handles are the scarce flex. A tier is judged on the **lower** of your live balance and your
balance at the last weekly snapshot — it must be *held*, not visited, so it can't be flash-bought,
and selling drops it immediately. The revenue share itself needs no tier: every holder is paid
pro-rata from the first token.

**The honest security claim — use verbatim, never overclaim:**

> Message contents are unreadable by anyone but the recipient. Metadata is minimized, not eliminated.

What we do NOT claim: anonymity against a global observer, forward secrecy against long-term key
compromise, or protection from the sequencer operator observing timing. The relay holds only
ciphertext, cannot read anything, and cannot forge a sender's signature — but it *can* refuse to
post (censor), which is exactly why self-posting is permissionless forever.

**Never imply Robinhood Markets Inc. endorses or is affiliated with this.** HoodGram is native *to*
Robinhood Chain, never "by Robinhood".

---

## 2. THE NARRATIVE (verified facts — do not embellish)

The pitch is that private messaging is being legislated against, and HoodGram is built so it
cannot be switched off. Every claim below is checkable. **Accuracy is the whole strategy** — the
facts are stronger than paranoia, and one false claim gets the project fact-checked to death.

- **9 July 2026** — "Chat Control 1.0" came back into force in the EU. Parliament tried to reject
  the Council's revival and voted 314–276 against mass scanning, but rejection needed an absolute
  majority of **361**, so it **failed by 47 votes**. Large **unencrypted** messaging services may
  now scan every user's messages **without any prior suspicion**.
- **CRITICAL ACCURACY GUARDRAIL:** an amendment **explicitly excludes end-to-end encrypted
  communications** from Chat Control 1.0. Signal, WhatsApp and Telegram are formally *out of scope*
  of the voluntary regime. **NEVER write "the EU is scanning your encrypted messages."** It is false
  today and it is the single claim that would discredit the project.
- **September 2026** — **CSAR** ("Chat Control 2.0") returns to trilogue. That one is **mandatory
  and permanent**, and it is the venue where **client-side scanning could reach inside encryption**.
  The honest, still-damning line: *they carved out encryption this round; the next round starts in September.*
- **3–4 August 2026** — **Telegram was removed from Apple's App Store worldwide** over prohibited
  content posted by a user. Restored only after Telegram removed it and banned the account. Pavel
  Durov blamed "takedown extortionists." A billion-user messenger vanished on one company's decision.
- **UK Online Safety Act** — Ofcom may order platforms to deploy "accredited technology" to scan
  private messages.
- **25+ US states** now require ID checks to access ordinary websites. **October 2025** — 70,000 ID
  photos leaked from a single age-verification breach. Ireland opened a government digital wallet
  pilot in **April 2026**; Google is bringing digital ID to Android in the UK.

**HoodGram's answer:** it is a **web app — there is no app store to be removed from**; messages are
E2E encrypted so there is nothing readable to hand over; every message is anchored on chain; and
self-posting is permissionless forever, so even the operators cannot silence a user.

**Tone:** punchy, factual, confident, a little defiant. Short sentences. Cite dates. **Never
tinfoil, never "they don't want you to know", never ranting.** The client explicitly rejected an
earlier direction for sounding like "someone that believes in any dirty conspiratorial theory."

---

## 3. REPO + STACK

Path: **`~/Desktop/TELEHOOD`** — the folder name is **stale**. The product was renamed
HoodText → TeleHood → **HoodGram**; all code, contracts, tests and docs already say HoodGram.
Do not rename the folder unless asked; nothing depends on it.

```
contracts/          Foundry. 9 contracts + full suite.  142 tests green.
packages/crypto/    @hoodgram/crypto — isomorphic TS.   176 tests green.
apps/relay/         @hoodgram/relay — Fastify 5 + node:sqlite + viem indexer + WS + gasless send.
                                                        91 tests green.
apps/web/           @hoodgram/web — Next.js 15 App Router + React 19.
infra/scripts/      deploy-local.mjs, sync-abis.mjs, check-fit.mjs
docs/               SPEC.md (v4, binding), ECONOMICS.md, NARRATIVE.md, this file
```

**Contracts:** `HoodGramToken` (ERC20 + permit + balance checkpoints), `ManualPriceSource`
(`thoodPerUsd`), `RevenueVault` (50/50 split, weekly epochs, pro-rata claims), `Activation` ($5
once), `GroupRegistry` (rooms + $10/mo rent), `KeyRegistry` (free identity keys), `Anchors` (the
message log, relayer allowlist), `Perks` (the ladder), `Handles` (@names).

**Routes that already exist and WORK — do not break them:**
- `/` marketing homepage
- `/app` the messenger (conversations, rooms, handles, perk badges, media, replies, reactions)
- `/app/thread`, `/app/rooms/new`
- `/access` the money page (activation, handle claim, ladder, rooms, holder revenue claims)

**Demo mode:** `?demo=1` on `/app` or `/access` drives the real components with a fixture world so
anyone can walk the entire product without a wallet. Source of truth: `apps/web/src/lib/demo.ts`.
There is a visible "SIMULATED DATA" banner on every demo surface. **Keep this working.**

**Deployment:** GitHub repo `Alnasarmasarhtml/hoodtext`. `main` = source, `gh-pages` = built static
export. Live at **https://alnasarmasarhtml.github.io/hoodtext/**. Build command:

```sh
cd apps/web && rm -rf .next out && \
NEXT_EXPORT=1 NEXT_BASE_PATH=/hoodtext NEXT_PUBLIC_BASE_PATH=/hoodtext pnpm build
```

---

## 4. DESIGN SYSTEM

Direction: **techno-brutalist intelligence dossier** — a declassified surveillance file crossed
with a 1990s Japanese cyberpunk artbook. Dense hairline-ruled panel grids, fake telemetry, small
mono annotation as texture, big blocky uppercase headlines in inverted slabs.

Tokens already live in `apps/web/src/app/globals.css`:

```
--void #08090a   --panel #0e1012   --panel-2 #14171a
--line rgba(255,255,255,.07)       --line-2 rgba(255,255,255,.13)
--bone #e8eaeb   --muted #7a8288   --dim #4a5157
--green #00c805  ← THE reserved accent (Robinhood green)
--steel #8fa3b0  --crimson #e23d28
```

**Green is scarce and reserved.** Permitted only on: primary CTAs, active nav/tab state,
confirmed-on-chain status, live badges, the $THOOD wordmark, and ticker separators. Never on
borders, never on body text, never as decoration. **Mostly black, then bone, then a little green.**

Type: **Geist Mono** for labels/eyebrows/tickers (uppercase, +.06em tracking), **Geist Sans** for
prose. `font-variant-numeric: tabular-nums` on all numbers.

Shape: 1px hairlines, max 2px radius, and the signature **6px corner notch** via `clip-path` —
use the `shapeClass()` helper in `apps/web/src/lib/notch.ts` and the `sh-*` utilities.
3% `feTurbulence` film grain overlay.

**BANNED:** gradients, glassmorphism, glow as decoration, big rounded cards, emoji as iconography,
neon cyan/purple, stock illustration, everything-centred layouts.

Reusable primitives in `apps/web/src/components/ui/` (treat as read-only): `Button`, `Panel`,
`Field`, `Label`, `Stat`, `Hex`, `Countdown`, `ConnectSheet`, `SiteHeader`, `MonthStepper`,
`Toast`, `Logo`.

---

## 5. ASSETS — all in `apps/web/public/`, all final

### Logo (`public/brand/`)
The client made the logo themselves; it was delivered with a **fake checkerboard painted into the
pixels**, which has been keyed out properly (including inside the enclosed letter counters) to give
real alpha.

| File | Use |
|---|---|
| **`logo-primary.png`** | **THE primary logo.** White, transparent, 3383×912 (~3.7:1). Heavy grotesk "HOODGRAM" with an **HG monogram inside the second O**, plus graffiti-style "HOODGRAM" sub-lettering beneath. Letter counters are knocked out, so background video shows through them — this is intentional and looks excellent over footage. |
| `logo-primary-dark.png` | Black version of the same, for light surfaces. |
| `logo-alt.png` | Second keyed variant. |
| `mark-white/black/green.png`, `mark-bare-white.png` | Standalone monogram (hood arch + visor slit) for favicon / app icon / PFP. Readable down to 26px. |
| `wordmark-*.png`, `lockup-*.png` | Earlier code-built wordmarks. Superseded by `logo-primary.png`. |

### Video (`public/media/`) — every one is a **verified seamless loop**
Each was generated in Seedance 2.0 / MiniMax H3 with the **same image locked as both start frame
and end frame**, then the final 0.6s was forced onto the exact opening frame with ffmpeg. Loop
closure was measured: **first frame is pixel-identical to last frame (infinite PSNR)**. A plain
`<video loop>` is therefore genuinely seamless — **do not add fades, JS restart logic, or
crossfade hacks.**

| File | Size | Content |
|---|---|---|
| `hero-rain.mp4` | 5 MB | Matrix-style falling symbols. Mostly black, white/grey katakana, scattered green glyphs. Calm enough to put text over. |
| `crowd-march.mp4` | 14 MB, 15s | **The client's own MiniMax H3 render.** Hooded crowd marching *toward* and *passing under* the camera. Needs a heavy dark overlay for text on top. |
| `cage.mp4` | 8 MB | Geodesic encryption lattice rotating a full 360°. Small/inset use. |
| `procession.mp4` | 13 MB | Hooded figure in profile marching out of frame as the next identical one enters — endless procession. |

### Stills (`public/art/`) — also serve as video posters
`matrix-rain.png` (poster for hero-rain) · `crowd.png` (poster for crowd-march) · `cage.png`
(poster for cage) · `figure-profile.png` (poster for procession) · `eye.png` (surveillance dossier
eye, green iris) · `scan-vs-sealed.png` (**the Chat Control argument in one image** — mail sliced
open by a scanning beam on the left, one envelope sealed in a green lattice with the beam
scattering on the right) · `dossier.png` (full-bleed technical grid texture) · `character.png`
(hooded figure, blank chest plate) · `panel-texture.png` · `hero-eye.png`

---

## 6. HARD-WON TRAPS — check these first when something breaks

1. **`asset()` is mandatory.** Anything referenced by a raw `src`/`href`/`poster` attribute for a
   file under `public/` MUST go through `asset()` in `apps/web/src/lib/asset.ts`. Next rewrites its
   own imports for `basePath`, but **not** raw markup attributes — a literal `/media/x.mp4` 404s on
   GitHub Pages. This has already broken the hero video once.
2. **wagmi `chains[0]` must be the ACTIVE chain.** With no wallet connected `useChainId()` returns
   `chains[0]`; `tryGetContracts()` returns null for any other chain, so every read silently drops
   and the UI shows "price unavailable" while everything is actually healthy.
3. **`libsodium-wrappers-sumo@0.7.16` ships a broken ESM bundle.** `next.config.mjs` aliases it to
   the CJS build. Don't remove that alias.
4. **`wagmi/connectors` is a barrel** that drags in the Coinbase SDK → optional `@x402/*` packages
   that aren't installed. They're aliased to `false` in `next.config.mjs`.
5. **Never run `next build` while `next dev` is running** — they share `.next` and it corrupts the
   dev server.
6. **No `.js` extensions on relative TS imports** in the web app — passes tsc, breaks the bundler.
7. **Fit check is mandatory.** Nothing may overflow at **1440 / 1024 / 760 / 390** px.
   `grid-template-columns: minmax(0,1fr)` — never a bare `1fr`; `min-width:0` on every flex/grid
   child; long hex truncates with ellipsis. Checker: `node infra/scripts/check-fit.mjs <url>`.
8. **`IDENTITY_DOMAIN` is signed verbatim — everywhere, no exceptions.** It is pinned to
   `chainId: 4663` in `packages/crypto/src/identity.ts` and is deliberately **not** the connected
   chain: the signature is the only input to the key derivation, so a domain that follows the
   network would hand the same wallet a different identity per chain and orphan every message
   sealed to the old key. `smoke-send.ts` used to sign `{ ...IDENTITY_DOMAIN, chainId: chain.id }`
   and therefore derived a different identity than the browser on every local chain
   (`docs/PROOF-OF-FUNCTION.md` §9.2). Fixed — app and script now sign the identical object, and
   `packages/crypto/test/identity.test.ts` pins its exact shape.
   Never spread-and-override it, and treat any edit to the domain, types or message as an
   irreversible rotation of every user's keys.
   *Consequence for local dev:* MetaMask and Rabby reject `signTypedData_v4` when `domain.chainId`
   is not the wallet's active chain, so the browser ceremony cannot complete against anvil on
   31337. Run the local node as **`anvil --chain-id 4663`**, deploy to it, and start the web app
   with `NEXT_PUBLIC_CHAIN_ID=4663 NEXT_PUBLIC_RPC_URL=http://127.0.0.1:8545`; point the smoke test
   at the same node with `SMOKE_CHAIN_ID=4663`. Real users on Robinhood Chain are never affected.
   `useIdentity` detects this specific wallet rejection and explains it instead of surfacing the raw
   RPC error.

---

## 7. STATE AS OF THIS HANDOFF

**Done and verified:** all 9 contracts + 142 forge tests; crypto package + 176 tests; relay with
gasless `/v1/send` + 91 tests; a real end-to-end gasless smoke test that passes against a local
chain (`apps/relay/scripts/smoke-send.ts`); the `/app` messenger; the `/access` money page; demo
mode; deployment pipeline to GitHub Pages. Full rename to HoodGram across the repo.

**Not done — this is the remaining work:** the **new homepage** described in the build prompt.
The old marketing components are still in `apps/web/src/components/site/` in their committed state
and are what `/` currently renders.

**Uncommitted changes exist** in the working tree (~99 files) from the branding/asset work. The
site components were deliberately reverted to their committed state so the homepage can be built
cleanly.
