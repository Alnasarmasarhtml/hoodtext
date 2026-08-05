'use client';

/**
 * `/access` — where the token model stops being a claim and becomes a number.
 *
 * Seven things, in the order they matter (SPEC §7.4):
 *   1. the $5 activation — once, forever, live-quoted in $THOOD
 *   2. your @handle — free, claimed against the tier rules
 *   3. the holder status ladder — status and capacity, never money
 *   4. the rooms you run and their $10/month rent
 *   5. the 50/50 split and your claim on it
 *   6. every sealed epoch, and the permissionless seal
 *   7. the revenue history that produced all of it
 */

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, type ReactNode } from 'react';
import { useSwitchChain } from 'wagmi';

import { ACTIVE_CHAIN_ID, activeChain } from '@/lib/chain';
import { formatToken } from '@/lib/format';
import { Button, Eyebrow, Stat } from '@/components/ui';
import { ActivationPanel } from './ActivationPanel';
import { EpochTable } from './EpochTable';
import { HandlePanel } from './HandlePanel';
import { HolderRevenuePanel } from './HolderRevenuePanel';
import { LadderPanel } from './LadderPanel';
import { Notice } from './Notice';
import { RevenueHistory } from './RevenueHistory';
import { RoomsPanel } from './RoomsPanel';
import {
  useAccessEnvironment,
  useActivationState,
  useEpochs,
  useHandleState,
  useMyRooms,
  useNowSeconds,
  usePerksState,
  usePricing,
  useRevenueHistory,
  useTokenState,
  useVaultState,
} from './use-access-data';
import s from './AccessPage.module.css';

export function AccessPage(): ReactNode {
  const env = useAccessEnvironment();
  const queryClient = useQueryClient();
  const { switchChainAsync, isPending: switching } = useSwitchChain();
  const nowSeconds = useNowSeconds();

  const pricing = usePricing(env.contracts);
  const activation = useActivationState(env.contracts, env.address);
  const handle = useHandleState(env.contracts, env.address);
  const perks = usePerksState(env.contracts, env.address);
  const token = useTokenState(env.contracts, env.address);
  const rooms = useMyRooms(env.contracts, env.address);
  const vault = useVaultState(env.contracts, env.address);
  const epochs = useEpochs(env.contracts, env.address, vault.epochCount);
  const history = useRevenueHistory(env.contracts);

  const refresh = useCallback((): void => {
    void queryClient.invalidateQueries();
  }, [queryClient]);

  const onSwitch = useCallback((): void => {
    void switchChainAsync({ chainId: ACTIVE_CHAIN_ID }).catch(() => {
      /* The sheet and the panels already surface connection problems; a failed
         network switch must not take the page down. */
    });
  }, [switchChainAsync]);

  return (
    <div className={s.page}>
      {/* ── masthead ─────────────────────────────────────────────────────── */}
      <header className={s.masthead}>
        <div className={s.mastheadInner}>
          <div className={s.mastheadText}>
            <Eyebrow rule>Access &amp; revenue</Eyebrow>
            <h1 className={s.title}>Pay $5 once. Get paid as a holder.</h1>
            <p className={s.lede}>
              TeleHood charges exactly two prices: $5, once, for an account that exists
              forever, and $10 a month for a room, paid by whoever runs it. Messages are
              never charged. Half of every payment goes to whoever holds{' '}
              <span className={s.wordmark}>$THOOD</span> — no staking contract to enter,
              nothing to lock up.
            </p>
          </div>

          <div className={s.summary}>
            <Stat
              label="Your account"
              value={
                activation.isActivated ? 'Activated' : env.isConnected ? 'Not activated' : '—'
              }
              size="sm"
              tone={activation.isActivated ? 'green' : 'muted'}
              hint={
                activation.isActivated
                  ? 'forever — nothing renews'
                  : env.isConnected
                    ? '$5, once, below'
                    : 'connect to read'
              }
            />
            <Stat
              label="Claimable"
              value={formatToken(epochs.totalClaimable, { digits: 2, trim: false })}
              unit="THOOD"
              size="sm"
              hint={
                env.isConnected
                  ? `${epochs.claimableIds.length} epoch${epochs.claimableIds.length === 1 ? '' : 's'} waiting`
                  : 'connect to compute'
              }
            />
            <Stat
              label="Paid to holders"
              value={
                history.data === undefined
                  ? '—'
                  : formatToken(history.data.toHolders, { digits: 2, trim: false })
              }
              unit="THOOD"
              size="sm"
              hint="50% of all revenue, to date"
            />
          </div>
        </div>
      </header>

      {/* ── environment banners ──────────────────────────────────────────── */}
      {(env.wrongNetwork || env.contracts === null) && (
        <div className={s.banner}>
          {env.wrongNetwork ? (
            <Notice
              tone="warn"
              title="Wrong network"
              body={`TeleHood is deployed on ${activeChain.name}. Switch to read your activation, quote a payment, or claim revenue.`}
              action={
                <Button variant="primary" loading={switching} onClick={onSwitch}>
                  {`Switch to ${activeChain.name}`}
                </Button>
              }
            />
          ) : (
            <Notice
              tone="warn"
              title="No contracts configured for this build"
              body="Deploy the contracts and set NEXT_PUBLIC_ADDR_TOKEN, NEXT_PUBLIC_ADDR_ACTIVATION, NEXT_PUBLIC_ADDR_GROUP_REGISTRY, NEXT_PUBLIC_ADDR_REVENUE_VAULT, NEXT_PUBLIC_ADDR_PERKS, NEXT_PUBLIC_ADDR_HANDLES and NEXT_PUBLIC_ADDR_PRICE_SOURCE. Everything below stays visible so the model is still legible — the numbers simply cannot be read."
            />
          )}
        </div>
      )}

      {/* ── 1 + 2 + 3 — activation, handle, and the ladder ───────────────── */}
      <div className={s.split}>
        <div className={s.main}>
          <ActivationPanel
            contracts={env.contracts}
            address={env.address}
            isConnected={env.isConnected}
            wrongNetwork={env.wrongNetwork}
            pricing={pricing}
            activation={activation}
            token={token}
            onRefresh={refresh}
          />

          <HandlePanel
            contracts={env.contracts}
            address={env.address}
            isConnected={env.isConnected}
            wrongNetwork={env.wrongNetwork}
            activation={activation}
            handle={handle}
            perks={perks}
            onRefresh={refresh}
          />
        </div>

        <aside className={s.rail} aria-label="Holder status ladder">
          <LadderPanel
            contracts={env.contracts}
            address={env.address}
            isConnected={env.isConnected}
            wrongNetwork={env.wrongNetwork}
            perks={perks}
          />
        </aside>
      </div>

      {/* ── 4 — the rooms you run ────────────────────────────────────────── */}
      <div className={s.block}>
        <RoomsPanel
          contracts={env.contracts}
          address={env.address}
          isConnected={env.isConnected}
          wrongNetwork={env.wrongNetwork}
          pricing={pricing}
          rooms={rooms}
          token={token}
          nowSeconds={nowSeconds}
          onRefresh={refresh}
        />
      </div>

      {/* ── 5 — the headline ─────────────────────────────────────────────── */}
      <div className={s.block}>
        <HolderRevenuePanel
          contracts={env.contracts}
          address={env.address}
          isConnected={env.isConnected}
          wrongNetwork={env.wrongNetwork}
          vault={vault}
          epochs={epochs}
          token={token}
          history={history}
          onRefresh={refresh}
        />
      </div>

      {/* ── 6 — the ledger ───────────────────────────────────────────────── */}
      <div className={s.block}>
        <EpochTable
          contracts={env.contracts}
          address={env.address}
          isConnected={env.isConnected}
          wrongNetwork={env.wrongNetwork}
          vault={vault}
          epochs={epochs}
          nowSeconds={nowSeconds}
          onRefresh={refresh}
        />
      </div>

      {/* ── 7 — the evidence ─────────────────────────────────────────────── */}
      <div className={s.block}>
        <RevenueHistory history={history} />
      </div>

      <footer className={s.foot}>
        <p className={s.footText}>
          Both prices are fixed in USD on chain and converted to $THOOD at the moment of
          payment. <code className={s.code}>Anchors.post</code> is not payable — messages
          are relayed for free or self-posted for about a cent of gas, and nothing else
          in this system is ever metered. Revenue is shared by holdings through
          historical balance checkpoints; there is no staking, no lock-up and no deposit
          anywhere in this product.
        </p>
      </footer>
    </div>
  );
}
