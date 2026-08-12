'use client';

/**
 * `/access` — where the token model stops being a claim and becomes a number.
 *
 * Seven things, in the order they matter (SPEC §7.4):
 *   1. the $5 activation — once, forever, live-quoted in $GRAM
 *   2. your @handle — free, claimed against the tier rules
 *   3. the holder status ladder — status and capacity, never money
 *   4. the rooms you run and their $10/month rent
 *   5. the 50/50 split and your claim on it
 *   6. every sealed epoch, and the permissionless seal
 *   7. the revenue history that produced all of it
 */

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSwitchChain } from 'wagmi';

import { ACTIVE_CHAIN_ID, activeChain } from '@/lib/chain';
import { DEMO_ME, isDemoActive } from '@/lib/demo';
import { formatToken } from '@/lib/format';
import { PRELAUNCH } from '@/lib/launch';
import { Button, Eyebrow, Stat } from '@/components/ui';
import { ActivationPanel } from './ActivationPanel';
import { DemoBanner } from './Demo';
import { buildDemoAccessWorld, type DemoAccessWorld } from './demo-state';
import { PRELAUNCH_WORLD } from './prelaunch-state';
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
  type RevenueHistoryView,
} from './use-access-data';
import s from './AccessPage.module.css';

export function AccessPage(): ReactNode {
  const env = useAccessEnvironment();
  const queryClient = useQueryClient();
  const { switchChainAsync, isPending: switching } = useSwitchChain();
  const nowSeconds = useNowSeconds();

  /* Demo mode resolves AFTER mount, so the prerendered markup is byte-for-byte
     the live not-connected page and hydration can never mismatch. */
  const [demo, setDemo] = useState(false);
  const [demoClaimedAll, setDemoClaimedAll] = useState(false);
  useEffect(() => {
    setDemo(isDemoActive());
  }, []);

  /* Demo keeps the chain out of the loop; before launch the real page does the
     same. Every read hook is driven with `null`, which each hook's `enabled`
     gate treats as "do not fetch": the hooks still run (rules of hooks) but
     never touch an RPC. Pre-launch this is what keeps test-network activity
     from ever rendering as if it were revenue. */
  const offline = demo || PRELAUNCH;
  const readContracts = offline ? null : env.contracts;
  const readAddress = offline ? null : env.address;

  const livePricing = usePricing(readContracts);
  const liveActivation = useActivationState(readContracts, readAddress);
  const liveHandle = useHandleState(readContracts, readAddress);
  const livePerks = usePerksState(readContracts, readAddress);
  const liveToken = useTokenState(readContracts, readAddress);
  const liveRooms = useMyRooms(readContracts, readAddress);
  const liveVault = useVaultState(readContracts, readAddress);
  const liveEpochs = useEpochs(readContracts, readAddress, liveVault.epochCount);
  const liveHistory = useRevenueHistory(readContracts);

  const world = useMemo<DemoAccessWorld | null>(
    () => (demo ? buildDemoAccessWorld(demoClaimedAll) : PRELAUNCH ? PRELAUNCH_WORLD : null),
    [demo, demoClaimedAll],
  );

  const pricing = world?.pricing ?? livePricing;
  const activation = world?.activation ?? liveActivation;
  const handle = world?.handle ?? liveHandle;
  const perks = world?.perks ?? livePerks;
  const token = world?.token ?? liveToken;
  const rooms = world?.rooms ?? liveRooms;
  const vault = world?.vault ?? liveVault;
  const epochs = world?.epochs ?? liveEpochs;
  const history: RevenueHistoryView = world?.history ?? liveHistory;

  /* What the panels believe about the visitor. In demo they see the fixture
     identity as connected on the right network, and both demo and pre-launch
     hand the panels NO contracts, so no panel-internal read or write can ever
     reach a chain. */
  const contracts = offline ? null : env.contracts;
  const address = demo ? DEMO_ME.address : env.address;
  const isConnected = demo || env.isConnected;
  const wrongNetwork = offline ? false : env.wrongNetwork;

  const refresh = useCallback((): void => {
    void queryClient.invalidateQueries();
  }, [queryClient]);

  const onSwitch = useCallback((): void => {
    void switchChainAsync({ chainId: ACTIVE_CHAIN_ID }).catch(() => {
      /* The sheet and the panels already surface connection problems; a failed
         network switch must not take the page down. */
    });
  }, [switchChainAsync]);

  const onDemoClaimAll = useCallback((): void => {
    setDemoClaimedAll(true);
  }, []);

  return (
    <div className={s.page}>
      {/* ── demo strip — the honest frame around everything below ────────── */}
      {demo && <DemoBanner />}

      {/* ── masthead ─────────────────────────────────────────────────────── */}
      <header className={s.masthead}>
        <div className={s.mastheadInner}>
          <div className={s.mastheadText}>
            <Eyebrow rule>Access &amp; revenue</Eyebrow>
            <h1 className={s.title}>Pay $5 once. Get paid as a holder.</h1>
            <p className={s.lede}>
              HoodGram charges exactly two prices, both paid in{' '}
              <span className={s.wordmark}>$GRAM</span> at the live rate: $5, once, for an
              account that exists forever, and $10 a month for a room, paid by whoever runs
              it. Messages are never charged. Half of every payment goes to whoever holds{' '}
              <span className={s.wordmark}>$GRAM</span>. There is no staking contract to
              enter and nothing to lock up.
            </p>
          </div>

          <div className={s.summary}>
            <Stat
              label="Your account"
              value={
                PRELAUNCH && !demo
                  ? 'At launch'
                  : activation.isActivated
                    ? 'Activated'
                    : isConnected
                      ? 'Not activated'
                      : '—'
              }
              size="sm"
              tone={activation.isActivated ? 'green' : 'muted'}
              hint={
                PRELAUNCH && !demo
                  ? '$5 once, paid in $GRAM'
                  : activation.isActivated
                    ? 'forever, nothing renews'
                    : isConnected
                      ? '$5 in $GRAM, below'
                      : 'connect to read'
              }
            />
            <Stat
              label="Claimable"
              value={formatToken(epochs.totalClaimable, { digits: 2, trim: false })}
              unit="GRAM"
              size="sm"
              hint={
                PRELAUNCH && !demo
                  ? 'no epochs sealed yet'
                  : isConnected
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
              unit="GRAM"
              size="sm"
              hint="50% of all revenue, to date"
            />
          </div>
        </div>
      </header>

      {/* ── environment banners, never shown over a fixture world. Pre-launch
             there is nothing on chain to be wrong about, so they stay out of
             the way there too. ── */}
      {!offline && (env.wrongNetwork || env.contracts === null) && (
        <div className={s.banner}>
          {env.wrongNetwork ? (
            <Notice
              tone="warn"
              title="Wrong network"
              body={`HoodGram is deployed on ${activeChain.name}. Switch to read your activation, quote a payment, or claim revenue.`}
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
              body="Deploy the contracts and set NEXT_PUBLIC_ADDR_TOKEN, NEXT_PUBLIC_ADDR_ACTIVATION, NEXT_PUBLIC_ADDR_GROUP_REGISTRY, NEXT_PUBLIC_ADDR_REVENUE_VAULT, NEXT_PUBLIC_ADDR_PERKS, NEXT_PUBLIC_ADDR_HANDLES and NEXT_PUBLIC_ADDR_PRICE_SOURCE. Everything below stays visible so the model is still legible. The numbers simply cannot be read."
            />
          )}
        </div>
      )}

      {/* ── 1 + 2 + 3 — activation, handle, and the ladder ───────────────── */}
      <div className={s.split}>
        <div className={s.main}>
          <ActivationPanel
            contracts={contracts}
            address={address}
            isConnected={isConnected}
            wrongNetwork={wrongNetwork}
            pricing={pricing}
            activation={activation}
            token={token}
            onRefresh={refresh}
            demo={demo}
          />

          <HandlePanel
            contracts={contracts}
            address={address}
            isConnected={isConnected}
            wrongNetwork={wrongNetwork}
            activation={activation}
            handle={handle}
            perks={perks}
            onRefresh={refresh}
            demo={demo}
          />
        </div>

        <aside className={s.rail} aria-label="Holder status ladder">
          <LadderPanel
            contracts={contracts}
            address={address}
            isConnected={isConnected}
            wrongNetwork={wrongNetwork}
            perks={perks}
            demo={demo}
          />
        </aside>
      </div>

      {/* ── 4 — the rooms you run ────────────────────────────────────────── */}
      <div className={s.block}>
        <RoomsPanel
          contracts={contracts}
          address={address}
          isConnected={isConnected}
          wrongNetwork={wrongNetwork}
          pricing={pricing}
          rooms={rooms}
          token={token}
          nowSeconds={nowSeconds}
          onRefresh={refresh}
          demo={demo}
        />
      </div>

      {/* ── 5 — the headline ─────────────────────────────────────────────── */}
      <div className={s.block}>
        <HolderRevenuePanel
          contracts={contracts}
          address={address}
          isConnected={isConnected}
          wrongNetwork={wrongNetwork}
          vault={vault}
          epochs={epochs}
          token={token}
          history={history}
          onRefresh={refresh}
          demo={demo}
          onDemoClaimAll={onDemoClaimAll}
        />
      </div>

      {/* ── 6 — the ledger ───────────────────────────────────────────────── */}
      <div className={s.block}>
        <EpochTable
          contracts={contracts}
          address={address}
          isConnected={isConnected}
          wrongNetwork={wrongNetwork}
          vault={vault}
          epochs={epochs}
          nowSeconds={nowSeconds}
          onRefresh={refresh}
          demo={demo}
        />
      </div>

      {/* ── 7 — the evidence ─────────────────────────────────────────────── */}
      <div className={s.block}>
        <RevenueHistory history={history} />
      </div>

      <footer className={s.foot}>
        <p className={s.footText}>
          Both prices are fixed in USD on chain and converted to $GRAM at the moment of
          payment. <code className={s.code}>Anchors.post</code> is not payable. Messages
          are relayed for free or self-posted for about a cent of gas, and nothing else
          in this system is ever metered. Revenue is shared by holdings through
          historical balance checkpoints; there is no staking, no lock-up and no deposit
          anywhere in this product.
        </p>
      </footer>
    </div>
  );
}
