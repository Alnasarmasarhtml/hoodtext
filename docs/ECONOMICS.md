# TeleHood — Economics (measured, not guessed)

Model: **$5 one-time account activation + $10/month per room, paid by the room's admin. Messages are
never charged. Half of every payment goes to $THOOD holders, pro-rata by holdings, no staking.**

All chain figures are from **live Robinhood Chain data on 2026-07-29**. Re-measure before launch.

## Measured inputs

| Input | Value | Source |
|---|---|---|
| Chain gas price | **0.0275 gwei** | `eth_gasPrice` on `rpc.mainnet.chain.robinhood.com` |
| ETH spot | **$1,922.96** | Coinbase spot |
| Block time | ~100 ms | Robinhood Chain docs |

## The two prices

| Price | What it buys | Contract |
|---|---|---|
| **$5, once** | An account, forever. Includes an @handle. | `Activation.activate()` |
| **$10 / month** | One room, paid by whoever runs it. Members free. | `GroupRegistry.createGroup` / `payRent` |

Paid in $THOOD. Prices are stored **in USD on-chain** and converted at purchase through
`IPriceSource`, so the dollar price is stable while the token moves. Rooms buy 1–24 months at a
time; paying early extends from the current expiry (`max(now, paidUntil)`), never burns time.

**Why $5 works as a price:** it is small enough to be paid without thinking and large enough that
ten thousand spam accounts cost $50,000. The fee *is* the spam wall — "every account on TeleHood
cost somebody five dollars" is both the pitch and the abuse model.

**Why rooms carry the recurring revenue:** the people who run rooms — communities, alpha groups,
projects — are the users with budgets and retention. One room admin at $10/month brings dozens to
hundreds of members at $5 once each. Members never pay rent, so joining is frictionless; anyone may
pay a room's rent (`payRent` is open — paying grants no control), so a beloved room never dies with
its admin's card.

**Auto-renew** is opt-in per room. The admin approves an allowance and switches it on; anyone may
then call the permissionless `renewFor(groupId)` within 3 days of lapse, which buys exactly one
month from the admin's own allowance. Switching it off is the entire cancellation flow. Rent lapse
blocks *new messages only* — history, keys, membership and administration all survive.

## Cost to send a message

Relayed (the default): **$0 to the user.** The relay batches up to 64 drops per `postBatch`
transaction from its own funded key. At ~75k gas + L1 share per drop unbatched (~1¢), batching cuts
the relay's per-message cost roughly an order of magnitude — call it **~0.1–0.3¢ per message**,
paid from the treasury's half of revenue as an operating cost. A $5 activation therefore funds
roughly **1,000–2,500 relayed messages** at the margin; typical texting behaviour makes the account
profitable for years.

Self-posted: ~1¢ gas paid by the sender to the network, never to us. Always available; it is also
the censorship escape hatch.

## Where the money goes

`Activation` and `GroupRegistry` transfer the payer's $THOOD **directly to the vault**, which splits
it on receipt:

```
                          ┌─ 50% → pendingHolders ─→ sealed weekly into an epoch ─→ claimed pro-rata
$5 activations ──────────►┤
$10/mo room rents ───────►┤
                          └─ 50% → treasuryAccrued ─→ operations, relayer gas, liquidity
```

Holder distribution uses **historical balance checkpoints on the token itself**. Every 7 days anyone
can call the permissionless `sealEpoch()`:

```
your share = epoch.holderAmount × yourBalanceAt(snapshot) ÷ eligibleSupplyAt(snapshot)
```

- **No staking, no deposit, no delegation.** Holding $THOOD in your own wallet at the snapshot block
  is the entire requirement.
- `eligibleSupply` excludes the treasury, the vault and any LP pairs — frozen at seal time.
- Buying after a snapshot earns nothing from that epoch; selling before it earns nothing; selling
  *after* the snapshot but before claiming still pays in full. The test suite pins all three.
- Unclaimed funds sweep to the treasury after 180 days.

## Revenue model

Two streams with different shapes:

**Activations — growth-shaped.** Every new user is $5, once. This tracks user acquisition:

| New accounts | One-time revenue | To holders |
|---|---|---|
| 1,000 | $5,000 | $2,500 |
| 10,000 | $50,000 | $25,000 |
| 100,000 | $500,000 | $250,000 |

**Rooms — retention-shaped MRR.** Every active room is $10/month for as long as it lives:

| Active rooms | MRR | Monthly to holders | Annual to holders |
|---|---|---|---|
| 100 | $1,000 | $500 | $6,000 |
| 1,000 | $10,000 | $5,000 | $60,000 |
| 10,000 | $100,000 | $50,000 | $600,000 |

Rule of thumb: healthy group-chat products run ~1 active group per 10–20 users, so 100,000 users
suggests 5,000–10,000 rooms. At that scale holders split roughly **$250k one-time + $300–600k/year
recurring**.

**Second-order effect:** both streams must be paid in $THOOD, which payers acquire on the market —
every activation and every month of rent is market buy pressure, half of which is redistributed to
existing holders.

## The perks ladder is deliberately not a revenue lever

RESIDENT (0.05%), BLOCK CAPTAIN (0.1%), DISTRICT (0.25%), KINGPIN (0.5%) unlock status and capacity
(badges, short handles, bigger rooms/uploads, broadcast) — never fee discounts and never a larger
share of revenue. Two reasons:

1. **The revenue share stays clean.** Every holder is paid pure pro-rata from the first token. No
   tier ever dilutes or redirects anyone's claim, so there is nothing to game.
2. **Everyone pays.** Even a KINGPIN pays $5 and $10/month rent, so revenue never leaks to whales —
   the people most able to pay.

Tiers are judged on the **lower** of the live balance and the balance at the last weekly revenue
snapshot: a tier must be *held*, not visited. Renting 5M $THOOD for an afternoon earns nothing;
selling drops the tier immediately. Supply-percentage thresholds mean early buyers reach rungs
cheaply and late buyers pay the market for the same flex — the ladder itself is a hold incentive.

## The honest risks

1. **The dollar prices are enforced by an owner-set rate** (`ManualPriceSource`). If the rate is not
   maintained as the token moves, activation becomes either unaffordable or nearly free. This is
   operational work until a TWAP source replaces it — the interface exists so that swap needs no
   other change.
2. **The relay is a trusted operator for convenience, not for content.** It holds only ciphertext,
   cannot read anything, and cannot forge a sender's signature — but it can refuse to post. The
   mitigation is structural: self-posting via `Anchors.post` is permissionless forever, and
   additional relayers can be approved with one owner call.
3. **One-time activations track growth, not retention.** If user growth stalls, the activation
   stream stalls with it; rooms are the hedge. Watch the room churn number the way a SaaS watches
   logo churn — it is the business.

## Supply

1,000,000,000 $THOOD, fixed, minted once to the treasury at deploy. No mint function afterwards, no
transfer tax, no blacklist, no pause, no owner on the token contract. Transfers cost roughly 20–40k
more gas than a plain ERC-20 (~$0.002) because every transfer writes the balance checkpoints that
make no-staking revenue share and flash-proof perk tiers possible. That is the price of the design,
and it is worth it.
