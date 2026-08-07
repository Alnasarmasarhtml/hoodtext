/**
 * DEMO MODE — a fully navigable, simulated HoodGram.
 *
 * The deployed site targets a chain the contracts are not on yet, and a visitor
 * without a wallet could otherwise see nothing past the connect gate. Demo mode
 * drives the REAL components with the fixture world below, so a visitor can walk
 * every feature — conversations, rooms, badges, handles, media, replies,
 * reactions, rent, the access page's paid states — exactly as they ship.
 *
 * Entering: any page with `?demo=1` (persists in sessionStorage for the tab).
 * Leaving: {@link exitDemo}. Every demo surface shows a SIMULATED banner — the
 * mode never pretends to be live data.
 *
 * This module is the single source of truth for the fixture world. The app and
 * access surfaces both read from here so the story stays coherent.
 */

/* ────────────────────────────────────────────────────────────── the switch ── */

const STORAGE_KEY = 'hoodgram.demo';

/** Query parameter that switches demo mode on: `?demo=1`. */
export const DEMO_PARAM = 'demo';

/** SSR-safe: false during prerender, resolved in the browser. */
export function isDemoActive(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const params = new URLSearchParams(window.location.search);
    const wanted = params.get(DEMO_PARAM);
    if (wanted === '1' || wanted === 'true') {
      window.sessionStorage.setItem(STORAGE_KEY, '1');
      return true;
    }
    if (wanted === '0' || wanted === 'false') {
      window.sessionStorage.removeItem(STORAGE_KEY);
      return false;
    }
    return window.sessionStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Persists demo mode for this tab (used by explicit "view demo" entries). */
export function enterDemo(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, '1');
  } catch {
    /* storage unavailable — the query param still works */
  }
}

/** Clears the flag and returns to the marketing page. */
export function exitDemo(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
  window.location.href = `${base}/`;
}

/* ─────────────────────────────────────────────────────────────── the cast ── */

export interface DemoPerson {
  readonly address: `0x${string}`;
  /** '' for the one contact who never claimed a handle. */
  readonly handle: string;
  /** Perk tier 0..4 (0 none, 1 RESIDENT, 2 BLOCK CAPTAIN, 3 DISTRICT, 4 KINGPIN). */
  readonly tier: 0 | 1 | 2 | 3 | 4;
}

/** The visitor's demo identity: 3-char handle = DISTRICT flex. */
export const DEMO_ME: DemoPerson = {
  address: '0xD157e1C7A9b04c11d3F00d8a9E22b6C41f9A7770',
  handle: 'nik',
  tier: 3,
};

export const DEMO_PEOPLE: readonly DemoPerson[] = [
  DEMO_ME,
  // The 2-char handle only a KINGPIN can carry.
  { address: '0xC2000a41b7D9c33E815F2B6a09Dd41C7e5A8F111', handle: 'cz', tier: 4 },
  { address: '0xB10Cca97a1e44F02C6d18E5b3A7F92D045c3B222', handle: 'plumbob', tier: 2 },
  { address: '0xAe51DeB7F3C29a84b06E17d40A5c88F312D9C333', handle: 'mercury', tier: 1 },
  { address: '0xDe6E2Dd4A07b95C31F84a29B6E01c7D8F45A0444', handle: 'degen_dave', tier: 0 },
  { address: '0xF00D71e8B4a5D690C23B08a7Fd94E15C6b2E0555', handle: 'vault_keeper', tier: 1 },
] as const;

export function demoPerson(address: string): DemoPerson | null {
  const needle = address.toLowerCase();
  return DEMO_PEOPLE.find((p) => p.address.toLowerCase() === needle) ?? null;
}

/* ─────────────────────────────────────────────────────────── the messages ── */

export interface DemoReaction {
  readonly emoji: string;
  /** Addresses that reacted; may include DEMO_ME.address. */
  readonly from: readonly `0x${string}`[];
}

export interface DemoMessage {
  /** Stable id; also serves as the fake blobRef seed. */
  readonly id: string;
  readonly sender: `0x${string}`;
  readonly kind: 'text' | 'system' | 'media';
  readonly body: string;
  /** Milliseconds BEFORE "now" — the world always looks fresh. */
  readonly agoMs: number;
  /** id of the message this replies to. */
  readonly re?: string;
  readonly reactions?: readonly DemoReaction[];
  /** For kind 'media': path under public/, resolved via asset(). */
  readonly mediaSrc?: string;
  readonly mediaName?: string;
  readonly mediaBytes?: number;
}

export interface DemoConversation {
  readonly id: string;
  readonly peer: `0x${string}`;
  readonly messages: readonly DemoMessage[];
}

const ME = DEMO_ME.address;
const CZ = DEMO_PEOPLE[1]!.address;
const PLUMBOB = DEMO_PEOPLE[2]!.address;
const MERCURY = DEMO_PEOPLE[3]!.address;
const DAVE = DEMO_PEOPLE[4]!.address;
const KEEPER = DEMO_PEOPLE[5]!.address;

const MIN = 60_000;
const HOUR = 3_600_000;

/** 1:1 threads. Newest conversation first. */
export const DEMO_CONVERSATIONS: readonly DemoConversation[] = [
  {
    id: 'demo-convo-dave',
    peer: DAVE,
    messages: [
      { id: 'dm-d1', sender: DAVE, kind: 'text', body: 'ok i paid the $5. that was the whole onboarding??', agoMs: 42 * MIN },
      { id: 'dm-d2', sender: ME, kind: 'text', body: 'that was it. account exists forever now — nothing renews, nothing expires.', agoMs: 41 * MIN },
      { id: 'dm-d3', sender: DAVE, kind: 'text', body: 'and sending is actually free? no gas popup?', agoMs: 40 * MIN },
      {
        id: 'dm-d4',
        sender: ME,
        kind: 'text',
        body: 'relay posts it on chain for you. you sign with your identity key, not your wallet — your address never even appears on chain.',
        agoMs: 39 * MIN,
        reactions: [{ emoji: '🔥', from: [DAVE] }],
      },
      { id: 'dm-d5', sender: DAVE, kind: 'text', body: 'why is there a tag next to your name', agoMs: 12 * MIN },
      {
        id: 'dm-d6',
        sender: ME,
        kind: 'text',
        body: 'holder ladder. hold 0.25% of supply through a weekly snapshot and you rank DISTRICT — badge, 3-char handle, early features. cz is KINGPIN, that’s why his handle is two letters.',
        agoMs: 11 * MIN,
        re: 'dm-d5',
      },
      { id: 'dm-d7', sender: DAVE, kind: 'text', body: 'so the flex is the username length. that’s evil. i respect it', agoMs: 9 * MIN, reactions: [{ emoji: '💯', from: [ME] }] },
    ],
  },
  {
    id: 'demo-convo-plumbob',
    peer: PLUMBOB,
    messages: [
      { id: 'dm-p1', sender: PLUMBOB, kind: 'text', body: 'boardroom rent is covered til next month btw', agoMs: 26 * HOUR },
      { id: 'dm-p2', sender: ME, kind: 'text', body: 'saw it — $10 and the whole room rides free. best deal in crypto', agoMs: 26 * HOUR + -2 * MIN },
      {
        id: 'dm-p3',
        sender: PLUMBOB,
        kind: 'media',
        body: 'terminal wall mounted. the office is done.',
        agoMs: 3 * HOUR,
        mediaSrc: 'media/crt-poster.jpg',
        mediaName: 'signals-desk.jpg',
        mediaBytes: 148_212,
        reactions: [
          { emoji: '🔥', from: [ME, CZ] },
          { emoji: '👀', from: [MERCURY] },
        ],
      },
      {
        id: 'dm-p4',
        sender: ME,
        kind: 'text',
        body: 'encrypted end to end and it still loads instantly. media keys travel inside the envelope — relay only ever sees noise.',
        agoMs: 3 * HOUR + -4 * MIN,
        re: 'dm-p3',
      },
      { id: 'dm-p5', sender: PLUMBOB, kind: 'text', body: 'anchored on chain too. block receipts on a shitpost. we live in the future', agoMs: 3 * HOUR + -6 * MIN },
    ],
  },
  {
    id: 'demo-convo-cz',
    peer: CZ,
    messages: [
      { id: 'dm-c1', sender: CZ, kind: 'text', body: 'took the 2-char. holding half a percent has its moments', agoMs: 49 * HOUR },
      { id: 'dm-c2', sender: ME, kind: 'text', body: 'shortest handle on the network. the ladder working as intended', agoMs: 49 * HOUR + -3 * MIN },
      { id: 'dm-c3', sender: CZ, kind: 'text', body: 'claim panel says my cut of last epoch is waiting. no staking, it just reads my wallet. clean design', agoMs: 48 * HOUR, reactions: [{ emoji: '💯', from: [ME] }] },
    ],
  },
] as const;

/* ─────────────────────────────────────────────────────────────── the rooms ── */

export interface DemoRoom {
  readonly groupId: `0x${string}`;
  readonly name: string;
  readonly admin: `0x${string}`;
  readonly members: readonly `0x${string}`[];
  /** Milliseconds from now until rent lapses; negative = lapsed that long ago. */
  readonly paidForMs: number;
  readonly autoRenew: boolean;
  readonly messages: readonly DemoMessage[];
}

export const DEMO_ROOMS: readonly DemoRoom[] = [
  {
    groupId: '0x5169a1b0a2d7000000000000000000000000000000000000000000000000cafe',
    name: 'signal boardroom',
    admin: ME,
    members: [ME, CZ, PLUMBOB, MERCURY, KEEPER, DAVE],
    paidForMs: 23 * 24 * HOUR + 6 * HOUR,
    autoRenew: true,
    messages: [
      { id: 'rm-b0', sender: ME, kind: 'system', body: '@degen_dave was added — room key delivered, epoch 4', agoMs: 5 * HOUR },
      { id: 'rm-b1', sender: CZ, kind: 'text', body: 'volume on the pair tripled since thursday. holders half of the vault is filling faster than the seal cadence', agoMs: 4 * HOUR },
      {
        id: 'rm-b2',
        sender: MERCURY,
        kind: 'text',
        body: 'weekly seal is permissionless — i’ll fire it the second the interval clears',
        agoMs: 4 * HOUR + -6 * MIN,
        re: 'rm-b1',
        reactions: [{ emoji: '👍', from: [ME, CZ, PLUMBOB] }],
      },
      { id: 'rm-b3', sender: PLUMBOB, kind: 'text', body: 'press kit rooms open next week. every KOL gets one — $10 covers their whole audience, members ride free', agoMs: 2 * HOUR },
      { id: 'rm-b4', sender: DAVE, kind: 'text', body: 'first day here and the whale has a two letter name. immaculate vibes', agoMs: 31 * MIN, reactions: [{ emoji: '🔥', from: [CZ] }] },
      { id: 'rm-b5', sender: ME, kind: 'text', body: 'rent’s paid 23 days out and auto-renew is armed — this room isn’t going anywhere', agoMs: 8 * MIN },
    ],
  },
  {
    groupId: '0x0177c001d000000000000000000000000000000000000000000000000000beef',
    name: 'night shift',
    admin: PLUMBOB,
    members: [PLUMBOB, ME, MERCURY],
    paidForMs: -(3 * 24 * HOUR),
    autoRenew: false,
    messages: [
      { id: 'rm-n1', sender: MERCURY, kind: 'text', body: 'gm to everyone who anchors at 4am', agoMs: 4 * 24 * HOUR },
      { id: 'rm-n2', sender: PLUMBOB, kind: 'text', body: 'rent runs out tomorrow, deciding if the night shift lives on', agoMs: 4 * 24 * HOUR + -20 * MIN },
      { id: 'rm-n3', sender: ME, kind: 'system', body: 'Rent lapsed. History and membership survive — new messages pause until anyone pays.', agoMs: 3 * 24 * HOUR },
    ],
  },
] as const;

/* ─────────────────────────────────────────── the access-page fixture state ── */

/** All GRAM amounts are 18dp bigints, coherent with the 1,000 GRAM/$ demo rate. */
export const DEMO_ACCESS = {
  /** 1,000 GRAM per dollar. */
  thoodPerUsd: 1_000n * 10n ** 18n,
  activationQuote: 5_000n * 10n ** 18n,
  rentPerMonth: 10_000n * 10n ** 18n,
  activatedAt: Date.now() - 19 * 24 * HOUR,
  /** DISTRICT: 2.5M of the 2.5M threshold, comfortably held through the last seal. */
  eligibleBalance: 2_612_400n * 10n ** 18n,
  walletBalance: 2_638_050n * 10n ** 18n,
  /** Protocol totals: 1,262 activations + 214 room-months. */
  totalRevenue: 8_450_000n * 10n ** 18n,
  toHolders: 4_225_000n * 10n ** 18n,
  claimable: 9_842n * 10n ** 18n,
  lifetimeClaimed: 21_306n * 10n ** 18n,
  nextSealInMs: 2 * 24 * HOUR + 11 * HOUR,
  epochs: [
    { id: 3, agoMs: 5 * 24 * HOUR, holderAmount: 1_240_500n * 10n ** 18n, myShare: 5_320n * 10n ** 18n, claimed: false },
    { id: 2, agoMs: 12 * 24 * HOUR, holderAmount: 1_054_000n * 10n ** 18n, myShare: 4_522n * 10n ** 18n, claimed: false },
    { id: 1, agoMs: 19 * 24 * HOUR, holderAmount: 986_200n * 10n ** 18n, myShare: 4_231n * 10n ** 18n, claimed: true },
    { id: 0, agoMs: 26 * 24 * HOUR, holderAmount: 944_300n * 10n ** 18n, myShare: 4_051n * 10n ** 18n, claimed: true },
  ],
} as const;

/** One line, shown on every demo surface. Honesty is part of the design. */
export const DEMO_BANNER_COPY =
  'SIMULATED DATA — this is the real interface with a fixture world. The live app works exactly like this: $5 once, then it’s yours.';
