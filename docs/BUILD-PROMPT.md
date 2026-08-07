# BUILD PROMPT — paste this into a new session

---

Build the new HoodGram homepage. Read `~/Desktop/TELEHOOD/docs/HANDOFF.md` first — it has the full
product, narrative, design system, asset inventory and known traps. This prompt is the spec for the
page itself.

Work in **`~/Desktop/TELEHOOD`** (folder name is stale; the product is HoodGram). The web app is
`apps/web` — Next.js 15 App Router, React 19, CSS modules, TypeScript strict.

The bar is **AAA — point perfect**. This is a launch surface. Take the time to get spacing,
rhythm, type scale and motion right. Do not ship something merely tidy.

## TERRITORY

Edit **only**:
- `apps/web/src/components/site/**`
- `apps/web/src/app/page.tsx`
- `apps/web/src/app/layout.tsx` (metadata only)
- `apps/web/src/app/globals.css` (you may ADD tokens/utilities; do not break existing ones — other
  routes depend on them)

Do **not** touch: `components/app/**`, `components/access/**`, `hooks/**`, `lib/**`,
`app/app/**`, `app/access/**`. `components/ui/**` is shared and read-only — reuse those primitives.

**`/app` and `/access` must keep working and stay reachable from the nav.** Demo mode (`?demo=1`)
must keep working. Old marketing components that no longer fit (Pricing, PerksLadder, RevenueShare,
HowItWorks, Faq, NoiseFloor, SectionHead…) should stop being rendered; deleting their files is fine
**only if nothing outside your territory imports them** — verify with grep first.

## THE PAGE — exactly four content sections, separated by scrolling ticker bands

### THE LOGO — above everything
`/brand/logo-primary.png` — transparent white PNG, 3383×912 (~3.7:1). Centred horizontally, sitting
**in the middle of the screen above the hero content**. It is the first thing you see over the hero
video. Size it generously: roughly **40–55% of viewport width** on desktop, ~80% on mobile. Its
letter counters are knocked out so the video shows through them — that is intentional, do not put a
solid plate behind it.

### SECTION 1 — HERO
Full viewport. Background: looping video **`/media/hero-rain.mp4`** (matrix falling symbols),
poster `/art/matrix-rain.png`. Over it: the logo (above), the line **"Pay $5 once. Text forever."**,
one short supporting line, and two actions — primary → `/access`, secondary "VIEW DEMO" →
`/app?demo=1`.

### SECTION 2 — WHAT THIS IS  *(the main event)*
Background: looping video **`/media/crowd-march.mp4`** (hooded crowd marching toward and passing
under the camera, 15s), poster `/art/crowd.png`, with a **heavy dark overlay** so text is fully
readable. On top: **the whole description of the project**, as genuine readable body copy —
- what HoodGram is
- $5 once, forever, and that the fee is the spam wall
- $10/month rooms, owner pays, members free, anyone may pay a room's rent, lapse pauses new
  messages and deletes nothing
- messages free and gasless via the relay, sender's address never on chain, self-post always
  available
- every message anchored on Robinhood Chain
- 50% of every payment to $THOOD holders, pro-rata, weekly, no staking
- the ladder: RESIDENT 0.05% / BLOCK CAPTAIN 0.10% / DISTRICT 0.25% / KINGPIN 0.50%, status and
  short @handles only, judged on the lower of now and the last snapshot
- a short, calm passage on **why this is needed** (private messaging is being legislated against —
  see the narrative section of the handoff)
- close with, verbatim: *"Message contents are unreadable by anyone but the recipient. Metadata is
  minimized, not eliminated."*

### SECTION 3 — TEXT LEFT / CAGE VIDEO RIGHT
Two columns. **Left:** heading + copy on the encryption itself — E2E, padded fixed-size envelopes,
view-tag scanning so no recipient address is on chain, the relay only ever holds ciphertext and can
neither read nor forge, self-posting permissionless forever so even we cannot silence you.
**Right:** a **small** looping video **`/media/cage.mp4`** (rotating geodesic lattice), poster
`/art/cage.png`. Also use one or two of the content stills where they compose best —
`/art/scan-vs-sealed.png` is the strongest (it is the Chat Control argument in a single image),
plus `/art/eye.png` or `/art/dossier.png`. On narrow screens stack to one column, video below text.

### SECTION 4 — THE PROCESSION
Full-width looping video **`/media/procession.mp4`** (hooded figure marching out as the next enters),
poster `/art/figure-profile.png`. Minimal text — one closing line and the CTA. Let the footage carry it.

Then the existing **`SiteFooter`** (keep it — it lists the nine contract addresses).

### THE TICKER BANDS — between every section
Full-width horizontal band, TV-news style, text scrolling **left to right** (content travels
rightward), **continuously and seamlessly** — duplicate the content track and translate so it wraps
with no gap or jump. Pause on `prefers-reduced-motion`. Style: Geist Mono, uppercase, tight; bone on
near-black, or inverted black-on-bone for alternating bands; a small green square or the mark as the
separator between items; hairline rules top and bottom.

**Ticker copy — use verbatim. Do not invent extra claims. Do not add anything implying encrypted
messages are being scanned today — they are explicitly carved out, and that is the one thing that
must not be got wrong.**

```
9 JULY 2026 — CHAT CONTROL 1.0 BACK IN FORCE. PARLIAMENT'S REJECTION FAILED: 361 VOTES NEEDED, NOT REACHED.
UNENCRYPTED MESSAGING MAY NOW BE SCANNED WITHOUT ANY SUSPICION.
SEPTEMBER 2026 — CSAR RETURNS TO TRILOGUE. THE MANDATORY ONE. THE PERMANENT ONE.
CSAR IS THE VENUE WHERE CLIENT-SIDE SCANNING COULD REACH INSIDE ENCRYPTION.
THEY CARVED OUT ENCRYPTION THIS ROUND. NEXT ROUND STARTS IN SEPTEMBER.
UK ONLINE SAFETY ACT — OFCOM MAY ORDER PLATFORMS TO DEPLOY "ACCREDITED TECHNOLOGY" TO SCAN PRIVATE MESSAGES.
25+ US STATES NOW REQUIRE ID TO ACCESS ORDINARY WEBSITES.
OCTOBER 2025 — 70,000 ID PHOTOS LEAKED FROM A SINGLE AGE-VERIFICATION BREACH.
IRELAND OPENED A GOVERNMENT DIGITAL WALLET PILOT IN APRIL 2026.
GOOGLE IS BRINGING DIGITAL ID TO ANDROID IN THE UK.
3–4 AUGUST 2026 — TELEGRAM REMOVED FROM THE APP STORE WORLDWIDE.
A BILLION-USER MESSENGER VANISHED ON ONE COMPANY'S DECISION.
HOODGRAM IS A WEB APP. THERE IS NO STORE TO REMOVE IT FROM.
```

## COPY BALANCE — 80 / 20

**80% product explanation, 20% propaganda.** The client was explicit. The ticker bands ARE the 20% —
do not add propaganda anywhere else. Everything in the four sections is calm, confident explanation
of what the product is and why it is needed. No ranting, no all-caps outside the tickers, no
conspiracy tone, no manifesto voice.

## VIDEO IMPLEMENTATION — non-negotiable

Every video: `autoPlay muted loop playsInline preload="metadata"` + a `poster`, no controls,
`object-fit: cover`. **Every file is authored so the last frame is pixel-identical to the first
(verified at infinite PSNR) — a plain `loop` attribute is genuinely seamless. Do NOT add fades,
crossfades, or JS restart logic.** Respect `prefers-reduced-motion` by rendering the poster image
instead of the video. Videos must never cause horizontal scroll.

**Every `src` / `poster` / `href` pointing at `public/` MUST go through `asset()` from
`src/lib/asset.ts`** — raw paths lose the GitHub Pages basePath and 404 on deploy. This has already
broken the hero video once.

## ART DIRECTION

Mostly black (`--void #08090a`), bone text, and **one reserved accent — Robinhood green
`#00c805`** — used scarcely: primary CTAs, active state, ticker separators, the odd highlighted
number, the $THOOD wordmark. Never as decoration, never on borders or body text. Geist Mono for
labels/eyebrows/tickers (uppercase, +.06em), Geist Sans for prose, `tabular-nums` on numbers. 1px
hairlines, max 2px radius, the signature 6px corner notch via `shapeClass()` in `src/lib/notch.ts`,
film-grain overlay. **Banned:** gradients, glassmorphism, glow, big rounded cards, emoji icons.

## QUALITY GATES — all must pass before you report done

1. `cd apps/web && pnpm typecheck` — zero errors.
2. Static export builds:
   `rm -rf .next out && NEXT_EXPORT=1 NEXT_BASE_PATH=/hoodtext NEXT_PUBLIC_BASE_PATH=/hoodtext pnpm build`
3. **Fit check at 1440 / 1024 / 760 / 390** — zero overflow. `minmax(0,1fr)` never bare `1fr`,
   `min-width:0` on flex/grid children. Use `node infra/scripts/check-fit.mjs <url>`.
4. Serve the built export and **look at it** — screenshot the page at 1440 and 390 and actually
   review it before claiming it is done.
5. `/app`, `/app?demo=1`, `/access?demo=1` still work.
6. No `any`, no `@ts-ignore`, no `console.log`.

Report: sections built, files created/deleted, how the ticker wraps seamlessly, and anything you
deviated on and why.
