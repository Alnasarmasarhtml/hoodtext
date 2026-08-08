/**
 * The Record — every entry, with its source.
 *
 * RULES FOR EDITING THIS FILE. They are not stylistic; the page's whole value is
 * that a hostile reader can check it.
 *
 * 1. Every entry cites a PRIMARY source where one is publicly retrievable — the
 *    statute, the regulation, the judgment, the regulator's own page. Where no
 *    primary source exists (an unpublished ministerial order, a network block
 *    imposed with no instrument at all), say so in `caveat` and cite the
 *    measurement or the reporting instead. Never dress reporting up as law.
 * 2. `notThis` is mandatory. It is the thing the entry does NOT do, and it is
 *    the reason this page can be trusted: almost every headline about these
 *    instruments overstates them, and a reader who catches us overstating one
 *    will disbelieve the other twenty.
 * 3. Dates are the operative ones — when a thing came into force or was
 *    measured — not when it was announced or reported.
 *
 * Compiled 8 August 2026 from primary legislative text, court records,
 * regulators' own publications and OONI network measurement.
 */

export type EntryKind =
  /** On the statute book and biting now. */
  | 'in-force'
  /** Tabled, drafted or announced — not law. */
  | 'proposed'
  /** A court or tribunal did this. */
  | 'court'
  /** A network-level block, usually with no published order behind it. */
  | 'blocked'
  /** Identity data that was handed over and then got out. */
  | 'breach';

export interface Entry {
  /** Stable id — used as the anchor, so don't renumber on reordering. */
  readonly id: string;
  readonly jurisdiction: string;
  readonly kind: EntryKind;
  /** Operative date, already formatted. */
  readonly date: string;
  readonly title: string;
  /** What it actually does. Two sentences, plain language. */
  readonly body: string;
  /** What it does NOT do. Mandatory — see the rules above. */
  readonly notThis: string;
  /** Something the record shows that the headline version leaves out. */
  readonly caveat?: string;
  readonly sourceLabel: string;
  readonly sourceUrl: string;
}

export interface Section {
  readonly id: string;
  readonly label: string;
  /** One line on why this group is grouped. */
  readonly note: string;
  readonly entries: readonly Entry[];
}

export const SECTIONS: readonly Section[] = [
  {
    id: 'europe',
    label: 'Europe',
    note: 'Four years of argument about scanning private messages, and the thing that finally passed carved encryption out of itself.',
    entries: [
      {
        id: 'eu-chat-control-1',
        jurisdiction: 'European Union',
        kind: 'in-force',
        date: 'In force 31 July 2026 — expires 3 April 2028',
        title: 'Chat Control 1.0 — Regulation (EU) 2026/1881',
        body: 'Suspends the confidentiality rules in the ePrivacy Directive so that messaging and webmail providers may voluntarily scan for child sexual abuse material and report it. It replaced an identical 2021 regulation that Parliament let expire on 3 April 2026, leaving a four-month gap with no legal basis at all.',
        notThis:
          'It compels nobody to scan anything, and Article 1(3) puts end-to-end encrypted communications outside its scope entirely — in the operative text, not a recital. Article 1(2) excludes audio. Recital 32: "Nothing in this Regulation should be interpreted as prohibiting or weakening end-to-end encryption."',
        caveat:
          'This is the law people mean when they say the EU is reading your messages. It permits scanning; it does not require it, and it cannot reach an encrypted one.',
        sourceLabel: 'EUR-Lex — full adopted text',
        sourceUrl: 'https://eur-lex.europa.eu/eli/reg/2026/1881/oj/eng',
      },
      {
        id: 'eu-csar',
        jurisdiction: 'European Union',
        kind: 'proposed',
        date: 'Proposed 11 May 2022 — still not adopted',
        title: 'Chat Control 2.0 — the permanent CSA Regulation',
        body: 'Would create a standing EU regime of detection, removal and blocking orders aimed at child sexual abuse material, reaching interpersonal communication services. It is the only live European proposal that could ever mandate detection inside a private messenger.',
        notThis:
          'After four years it imposes no obligation on anyone, because it has never been adopted. The fifth trilogue was held on 11 May 2026 and produced no agreement; whether detection is mandatory or voluntary, and how encryption is treated, are exactly the points still unresolved.',
        caveat:
          'Anyone telling you what "Chat Control requires" is describing a contested draft. Three institutions hold three different versions of it.',
        sourceLabel: 'European Parliament — legislative train',
        sourceUrl:
          'https://www.europarl.europa.eu/legislative-train/spotlight-JD22/file-combating-child-sexual-abuse-online',
      },
      {
        id: 'eu-e-evidence',
        jurisdiction: 'European Union',
        kind: 'in-force',
        date: 'Applies from 18 August 2026',
        title: 'e-Evidence — Regulation (EU) 2023/1543',
        body: 'Lets a judge in one member state send a production or preservation order straight to a service provider in another, for electronic evidence including message content. It covers messaging providers, not only telephone companies.',
        notThis:
          'Recital 20 says it "should not lay down any obligation for service providers to decrypt data," and Recital 19 rules out any general retention duty. It works case by case, on a judicial order — the opposite of bulk collection, though the two are constantly conflated.',
        sourceLabel: 'EUR-Lex — Regulation 2023/1543',
        sourceUrl:
          'https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32023R1543',
      },
      {
        id: 'eu-eidas',
        jurisdiction: 'European Union',
        kind: 'in-force',
        date: 'In force 20 May 2024 — wallets due end of 2026',
        title: 'European Digital Identity Wallet — Regulation (EU) 2024/1183',
        body: 'Every member state must offer a free digital identity wallet holding government-verified identity data, and public bodies and large regulated services must accept it. The deadline for the wallets themselves is the end of 2026.',
        notThis:
          'Article 5a(15) makes use voluntary for people and forbids disadvantaging anyone who declines. Article 5b(9) bars a service from refusing a pseudonym where no law requires identification, and Article 5a(14) stops the wallet provider itself building a profile of where you used it.',
        caveat:
          'The mandate runs on governments and on the services that must accept the wallet — never on the individual. That is the opposite of how it is usually reported.',
        sourceLabel: 'EUR-Lex — Regulation 2024/1183',
        sourceUrl:
          'https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=OJ:L_202401183',
      },
    ],
  },
  {
    id: 'uk',
    label: 'United Kingdom',
    note: 'The scanning power everybody argues about has never been used. The one that matters is older, quieter, and secret by statute.',
    entries: [
      {
        id: 'uk-osa-121',
        jurisdiction: 'United Kingdom',
        kind: 'in-force',
        date: 'In force 10 January 2024 — never used',
        title: 'Online Safety Act 2023, section 121 — technology notices',
        body: 'Lets Ofcom order a service to deploy accredited technology to detect child sexual abuse material — and for that purpose it reaches private messages, not just public ones. This is the UK power that could compel client-side scanning inside an encrypted messenger.',
        notThis:
          'No notice has ever been issued and none currently can be. Technology counts as "accredited" only against minimum accuracy standards the Secretary of State has to approve and publish, and none exist. Ofcom\'s own statutory report, February 2026: "this part of the online safety regime is not active."',
        caveat:
          'The assurance that it will not break encryption is a minister\'s statement from a 2023 Lords debate, not a carve-out in the text of the Act.',
        sourceLabel: 'legislation.gov.uk — OSA 2023 s.121',
        sourceUrl: 'https://www.legislation.gov.uk/ukpga/2023/50/section/121',
      },
      {
        id: 'uk-tcn',
        jurisdiction: 'United Kingdom',
        kind: 'in-force',
        date: 'In force since 2016',
        title: 'Investigatory Powers Act 2016, section 253 — technical capability notices',
        body: 'The Home Secretary may order a communications operator to build and keep the capability to help execute warrants, expressly including "the removal by a relevant operator of electronic protection." It applies to companies outside the UK, and section 255(8) makes the existence of a notice secret.',
        notThis:
          'It does not authorise interception on its own — a separate warrant is still needed — and a judicial commissioner must approve the notice. But section 43(6) is the sharp edge: once a notice applies, the steps you are expected to take include every step you could have taken had you built the capability. "We cannot decrypt" becomes "you should have been able to."',
        caveat:
          'The government neither confirms nor denies that any notice has ever been served on anyone. That is the official position, given in a written answer in June 2025.',
        sourceLabel: 'legislation.gov.uk — IPA 2016 s.253',
        sourceUrl: 'https://www.legislation.gov.uk/ukpga/2016/25/section/253',
      },
      {
        id: 'uk-apple',
        jurisdiction: 'United Kingdom',
        kind: 'court',
        date: 'Ongoing — substantive hearing listed December 2026',
        title: 'Apple and the Home Office, at the Investigatory Powers Tribunal',
        body: 'Apple withdrew Advanced Data Protection for new UK users on 21 February 2025, after a reported technical capability notice. It filed a fresh tribunal claim disclosed on 3 August 2026, and a separate challenge to the notices regime itself, brought by Privacy International and Liberty, is listed for hearing in December 2026.',
        notThis:
          'Apple did not remove end-to-end encryption. iMessage and FaceTime stay encrypted end to end worldwide, fifteen iCloud data categories remain encrypted by default, and what was lost is the option of extending that to ten more. The Tribunal has published one judgment, and it says in terms that it should not be taken as confirming the reporting is accurate.',
        caveat:
          'Nobody outside the process knows what was ordered. Everything public about it is reporting the government will not confirm.',
        sourceLabel: 'Investigatory Powers Tribunal — published judgment',
        sourceUrl:
          'https://investigatorypowerstribunal.org.uk/judgement/apple-inc-v-secretary-of-state-for-the-home-department/',
      },
      {
        id: 'uk-age-checks',
        jurisdiction: 'United Kingdom',
        kind: 'in-force',
        date: 'Operative 25 July 2025 — eight fines to date',
        title: 'Online Safety Act age checks, and what enforcement looks like',
        body: 'Services that let children encounter pornography or content about suicide, self-harm or eating disorders must use "highly effective age assurance." Eight companies have been fined for failing to, from £50,000 to £1.35m, and around two dozen investigations are open.',
        notThis:
          'No method is mandated — Ofcom lists seven, several of which never show an ID document to the site. No UK site has been blocked by court order; Ofcom said plainly in July 2026 that it has no power to block a site for not paying a fine. The services that vanished blocked themselves.',
        /* Ofcom's own page sits behind a bot challenge we cannot verify from a
           build machine, so this cites reporting on one of the fines instead —
           a link that provably resolves beats a better link that might 404. */
        sourceLabel: 'The Guardian — the £1m fine, and what triggered it',
        sourceUrl:
          'https://www.theguardian.com/society/2025/dec/04/pornography-site-fined-1m-for-not-having-strong-age-checks-required-in-new-uk-law',
      },
    ],
  },
  {
    id: 'us',
    label: 'United States',
    note: 'No backdoor mandate has ever been enacted. The pressure arrives through the app store, the courtroom and the liability rule instead.',
    entries: [
      {
        id: 'us-paxton',
        jurisdiction: 'United States',
        kind: 'court',
        date: 'Decided 27 June 2025',
        title: 'Free Speech Coalition v. Paxton — the Supreme Court on age checks',
        body: 'The Court upheld a Texas law requiring age verification on sites where at least a third of the content is sexual material harmful to minors, applying intermediate rather than strict scrutiny. Twenty-six states now have adult-content age-verification laws in force, and after this ruling none is enjoined.',
        notThis:
          'It reaches only speech that is obscene as to minors. The Court did not bless age gates on social media, on app stores, or on any speech lawful for adults and children alike — for those, strict scrutiny survives.',
        sourceLabel: 'Supreme Court — full opinion (PDF)',
        sourceUrl: 'https://www.supremecourt.gov/opinions/24pdf/23-1122_3e04.pdf',
      },
      {
        id: 'us-texas-app-store',
        jurisdiction: 'Texas, United States',
        kind: 'in-force',
        date: 'Enforceable since 4 June 2026',
        title: 'Texas S.B. 2420 — the App Store Accountability Act',
        body: 'Every app-store account holder, adult or child, must have their age verified before the account is created, and under-18s must be tied to a verified parent account that approves each individual download. It was enjoined in December 2025, the Fifth Circuit stayed that injunction in June 2026, and on 6 July 2026 the Supreme Court declined to vacate the stay.',
        notThis:
          'The Supreme Court order was an emergency-docket denial, not a ruling that the law is constitutional; the merits were argued in the Fifth Circuit on 4 August 2026 and are undecided. Louisiana has a similar law live since 1 July 2026; Alabama\'s starts 1 January 2027; Utah\'s is deferred to May 2027.',
        caveat:
          'This is the first American law under which installing an encrypted messenger means proving who you are — at the store, before you ever open the app.',
        sourceLabel: 'Supreme Court — docket 25A1390',
        sourceUrl:
          'https://www.supremecourt.gov/search.aspx?filename=/docket/docketfiles/html/public/25a1390.html',
      },
      {
        id: 'us-stop-csam',
        jurisdiction: 'United States',
        kind: 'proposed',
        date: 'Reported out of committee 26 June 2025 — no floor vote since',
        title: 'STOP CSAM Act — where shipping encryption becomes evidence',
        body: 'Creates a civil action against services that host child sexual abuse material "intentionally, knowingly, or recklessly," with $300,000 in liquidated damages, no limitation period, and the Section 230 shield removed for those claims.',
        notThis:
          'It mandates no backdoor, no key escrow and no client-side scanning, and it says outright that using end-to-end encryption cannot be an independent basis for liability. But the next subsection makes that same choice admissible to show "motive, intent, preparation, plan" — so the encryption is not illegal, it is exhibit A.',
        caveat:
          'The two federal bills that would have actually mandated a backdoor are dead. EARN IT was never reintroduced in this Congress; the Lawful Access to Encrypted Data Act has been dead since 2020.',
        sourceLabel: 'govinfo — S.1829 as reported',
        sourceUrl:
          'https://www.govinfo.gov/content/pkg/BILLS-119s1829rs/html/BILLS-119s1829rs.htm',
      },
      {
        id: 'us-salt-typhoon',
        jurisdiction: 'United States',
        kind: 'breach',
        date: 'Disclosed October 2024 — still active February 2026',
        title: 'Salt Typhoon — the wiretap system was the way in',
        body: 'State-sponsored attackers reached the lawful-intercept systems that American carriers are legally required to build and maintain. The FCC recorded that a top security agency confirmed at least eight communications companies were infiltrated; a ninth followed weeks later, and the FBI confirmed in February 2026 that the threat is not over.',
        notThis:
          'The figures you see of 200 companies across 80 countries describe the wider espionage campaign, not the carriers whose intercept systems were compromised. For those, the defensible number is at least nine.',
        caveat:
          'In November 2025 the FCC rescinded its own ruling that carriers must secure those systems, finding it had misread the statute. The duty to build the wiretap remains; the duty to protect it was withdrawn.',
        sourceLabel: 'FCC — fact sheet (PDF)',
        sourceUrl: 'https://docs.fcc.gov/public/attachments/DOC-408015A1.pdf',
      },
      {
        id: 'us-702',
        jurisdiction: 'United States',
        kind: 'in-force',
        date: 'Lapsed 12 June 2026 — collection continues to March 2027',
        title: 'FISA Section 702 expired, and nothing stopped',
        body: 'The House declined to extend Section 702 on 11 June 2026 and the authority lapsed at midnight. It permitted warrantless collection of foreign targets\' communications from US providers, sweeping in Americans\' messages along the way.',
        notThis:
          'Expiry did not end the surveillance. Certifications valid when issued run for up to a year, and the court approved the current set in March 2026 — so collection continues unchanged until roughly 17 March 2027.',
        sourceLabel: 'Brennan Center — Section 702 resource page',
        sourceUrl:
          'https://www.brennancenter.org/our-work/research-reports/section-702-foreign-intelligence-surveillance-act-fisa-2026-resource-page',
      },
    ],
  },
  {
    id: 'world',
    label: 'Elsewhere',
    note: 'Most of the world does not legislate against encrypted messengers. It switches them off, usually with nothing published to challenge.',
    entries: [
      {
        id: 'ru-signal',
        jurisdiction: 'Russia',
        kind: 'blocked',
        date: 'Signal 9 August 2024 · Viber 13 December 2024',
        title: 'Russia blocked the messengers, then built its own',
        body: 'Signal has been blocked since August 2024 and Viber since December 2024, both still unavailable. A state-backed national messenger, MAX, is being pushed into the space they left.',
        notThis:
          'These are network-level blocks, not decryption orders. No Russian instrument obtained the contents of anything — it removed the ability to reach the service at all.',
        sourceLabel: 'OONI — measurement explorer, Russia',
        sourceUrl: 'https://explorer.ooni.org/country/RU',
      },
      {
        id: 'pk-signal',
        jurisdiction: 'Pakistan',
        kind: 'blocked',
        date: 'Continuous since 15 November 2024',
        title: 'Signal made unusable for twenty-one months, with no order at all',
        body: 'Pakistani networks let the name lookup succeed and the connection open, then reset the encrypted handshake to Signal\'s chat, storage, voice and contact-discovery servers. Measurement on 7 August 2026 recorded 315 tests and zero successes.',
        notThis:
          'There is no published order, no gazette entry, no regulator confirmation and no block page — the app simply fails with a connection error. Nothing was decrypted; the block defeats reachability, not encryption.',
        caveat:
          'The country\'s own lawful-interception stack is documented as unable to see inside HTTPS. It gets metadata, and the power to switch you off.',
        sourceLabel: 'OONI — measurement explorer, Pakistan',
        sourceUrl: 'https://explorer.ooni.org/country/PK',
      },
      {
        id: 'tz-telegram',
        jurisdiction: 'Tanzania',
        kind: 'blocked',
        date: 'Telegram since 31 August 2024 · Signal since October 2025',
        title: 'Two encrypted messengers, blocked indefinitely, with nothing to appeal',
        body: 'Telegram has been unreachable on Tanzanian networks since August 2024 and Signal since around the October 2025 election, both across eight autonomous systems and both still blocked.',
        notThis:
          'No order was ever published for either. There is no legal basis to challenge, no appeal route and no announced end date — which is also why neither has been lifted.',
        sourceLabel: 'OONI — measurement explorer, Tanzania',
        sourceUrl: 'https://explorer.ooni.org/country/TZ',
      },
      {
        id: 'np-registration',
        jurisdiction: 'Nepal',
        kind: 'blocked',
        date: '4 September 2025 — reversed after five days',
        title: 'Twenty-six platforms cut off for not appointing a local officer',
        body: 'Nepal ordered internet providers to deactivate twenty-six platforms that had not registered locally and named a resident grievance officer within seven days. WhatsApp and Signal were both on the list. It was reversed on 8 September, after protests in which more than nineteen people died.',
        notThis:
          'The order demanded no scanning and no decryption. It conditioned access on having a legal presence in the country — which a service built to hold no keys and no user records cannot supply without ceasing to be that service.',
        caveat:
          'Telegram had already been blocked separately since July 2025 and was not restored with the rest.',
        sourceLabel: 'Kathmandu Post — the full list of 26',
        sourceUrl:
          'https://kathmandupost.com/national/2025/09/05/only-hamro-patro-x-respond-as-nepal-blocks-26-social-media-platforms-1757082149',
      },
      {
        id: 'in-telegram',
        jurisdiction: 'India',
        kind: 'blocked',
        date: '16–23 June 2026',
        title: 'A nation of 1.4 billion switched off Telegram for a week, for an exam',
        body: 'India blocked Telegram nationwide across more than seventy-five networks to stop question papers leaking before a medical entrance exam on 21 June. The block was lifted two days after the exam.',
        notThis:
          'The order was issued under section 69A of the IT Act, which makes such orders confidential by rule — so there is no public document to read, and nothing to challenge.',
        sourceLabel: 'OONI — finding, India',
        sourceUrl: 'https://explorer.ooni.org/findings/2026-india-blocked-telegram-during-exams',
      },
      {
        id: 'au-minimum-age',
        jurisdiction: 'Australia',
        kind: 'in-force',
        date: 'Took effect 10 December 2025',
        title: 'Under-16s off social media — and a $54.6m case against Telegram',
        body: 'Australia requires platforms to take reasonable steps to stop under-16s holding accounts; about 4.7 million accounts were restricted in the first weeks. In July 2026 the regulator began Federal Court proceedings against Telegram seeking up to $54.6m.',
        notThis:
          'The rules expressly exclude services whose sole or primary purpose is messaging, email or calling — WhatsApp and Messenger are both on the published not-restricted list. And every failure pleaded against Telegram concerns public channels and terms of service, not private encrypted chats. No decryption is sought.',
        sourceLabel: 'legislation.gov.au — the Rules (section 5 lists what is excluded)',
        sourceUrl: 'https://www.legislation.gov.au/F2025L00889/asmade/text',
      },
    ],
  },
  {
    id: 'id',
    label: 'What happens to the ID',
    note: 'Every age check is a promise to hold your identity safely. These are the times that promise was tested.',
    entries: [
      {
        id: 'breach-discord',
        jurisdiction: 'Discord',
        kind: 'breach',
        date: '20 September 2025 — around 58 hours of access',
        title: 'Government-ID photos, taken through a support vendor',
        body: 'An attacker reached a third-party customer-service system and, in Discord\'s own words, around 70,000 users "may have had government-ID photos exposed," along with names, emails, IP addresses and support-ticket contents.',
        notThis:
          'The 2.1 million figure that circulated came from the extortionists, and Discord calls it incorrect. Full card numbers, passwords and on-platform messages were not exposed.',
        caveat:
          'The IDs were not held by the platform you trusted. They were held by a contractor of a contractor.',
        sourceLabel: 'Discord — security incident update',
        sourceUrl:
          'https://discord.com/press-releases/update-on-security-incident-involving-third-party-customer-service',
      },
      {
        id: 'breach-tea',
        jurisdiction: 'Tea Dating Advice',
        kind: 'breach',
        date: '25 July 2025',
        title: 'Verification selfies that were promised to be deleted',
        body: 'A misconfigured legacy storage bucket exposed around 72,000 images, of which roughly 13,000 were selfies and photo IDs submitted for identity verification.',
        notThis:
          'The often-repeated "72,000 IDs" is wrong — most of the images were ordinary in-app content, and only users who joined before February 2024 were affected.',
        caveat:
          'The app\'s own privacy policy had said verification photos were "stored only temporarily and… deleted immediately." They were still there.',
        sourceLabel: 'TechCrunch — reporting on the exposure',
        sourceUrl:
          'https://techcrunch.com/2025/07/26/dating-safety-app-tea-breached-exposing-72000-user-images/',
      },
      {
        id: 'breach-au10tix',
        jurisdiction: 'AU10TIX — identity vendor',
        kind: 'breach',
        date: 'Credentials live from around December 2022 to at least June 2024',
        title: 'The ID checker behind TikTok, Uber and X left the door open for eighteen months',
        body: 'An employee\'s credentials for AU10TIX, the identity-verification company those services use, were taken by malware around December 2022 and posted publicly. When researchers tested them in June 2024 they still worked, opening an administrative console that held images of customers\' identity documents.',
        notThis:
          'No victim count has ever been confirmed, and there is no evidence that any document was actually taken. What is established is the exposure, not the theft.',
        caveat:
          'This is the layer every age-check law depends on and none of them regulates. Not the site you visited — the contractor it sends your passport to.',
        sourceLabel: '404 Media — the investigation',
        sourceUrl:
          'https://www.404media.co/id-verification-service-for-tiktok-uber-x-exposed-driver-licenses-au10tix/',
      },
    ],
  },
];

/** The two entries that cut the other way. A record that only accuses is a pitch. */
export const COUNTERWEIGHT: readonly Entry[] = [
  {
    id: 'us-cisa-signal',
    jurisdiction: 'United States',
    kind: 'in-force',
    date: '18 December 2024',
    title: 'The US cyber-defence agency told Americans to use end-to-end encryption',
    body: 'After the telecom intrusions, CISA published mobile communications guidance whose first best practice reads: "Use only end-to-end encrypted communications. Adopt a free messaging application for secure communications that guarantees end-to-end encryption, such as Signal or similar apps."',
    notThis:
      'It was written for highly targeted people in senior government and political roles, though the guidance says it is applicable to all audiences. It is advice, not law.',
    sourceLabel: 'CISA — mobile communications best practices (PDF)',
    sourceUrl:
      'https://www.cisa.gov/sites/default/files/2024-12/guidance-mobile-communications-best-practices.pdf',
  },
  {
    id: 'uk-digital-id-cancelled',
    jurisdiction: 'United Kingdom',
    kind: 'in-force',
    date: 'Cancelled 21 July 2026',
    title: 'The UK digital ID scheme was cancelled',
    body: 'Announced in September 2025, stripped of its mandatory element in January 2026, and cancelled outright on 21 July 2026 — the £1.8bn was redirected to a cut in electricity VAT.',
    notThis:
      'No bill was ever introduced, and "BritCard" was a think-tank name the government never used. There is now no UK identity credential for an account to be bound to.',
    caveat:
      'A gov.uk explainer page still says digital ID will be a legal requirement for right-to-work checks. It was superseded and never corrected. Old pages outlive the policies they describe.',
    sourceLabel: 'gov.uk — the announcement that cancelled it',
    sourceUrl:
      'https://www.gov.uk/government/news/new-pm-cuts-tax-on-household-electricity-bills-to-give-breathing-space-on-cost-of-living',
  },
];

/**
 * Total entries across every section. Nothing renders it since the hero's stats
 * strip came out — kept because it is derived, so it can never disagree with the
 * page, and the page description still quotes a number that has to match.
 */
export const ENTRY_COUNT: number =
  SECTIONS.reduce((total, section) => total + section.entries.length, 0) + COUNTERWEIGHT.length;
