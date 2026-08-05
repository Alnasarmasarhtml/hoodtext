// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {Fixture} from "./utils/Fixture.sol";
import {HookToken, ReentrantClaimer} from "./utils/Mocks.sol";
import {RevenueVault} from "../src/RevenueVault.sol";

/**
 * @title RevenueVaultTest
 * @notice THE CRITICAL MATH. Half of every protocol payment belongs to $THOOD holders, pro-rata
 *         by holdings, with no staking, lock-up or deposit anywhere.
 *
 * @dev Every state-changing operation in this suite is followed by {Fixture-_assertSolvent}, which
 *      recomputes
 *          `THOOD.balanceOf(vault) >= treasuryAccrued + pendingHolders + Σ (holderAmount - claimed)`
 *      from epoch storage rather than trusting the contract's own accumulator.
 */
contract RevenueVaultTest is Fixture {
    event RevenueReceived(address indexed from, uint256 amount, uint256 toHolders, uint256 toTreasury);
    event EpochSealed(uint256 indexed epochId, uint48 snapshot, uint256 holderAmount, uint256 eligibleSupply);
    event Claimed(address indexed user, uint256 indexed epochId, uint256 amount);
    event ExpiredSwept(uint256 indexed epochId, uint256 amount);
    event TreasuryWithdrawn(address indexed to, uint256 amount);
    event ExcludedSet(address indexed addr, bool isExcluded);
    event PendingRoutedToTreasury(uint48 snapshot, uint256 amount);

    /// @dev Holder balances chosen so the pro-rata split is exact, then deliberately made ugly in
    ///      the dust test.
    uint256 internal constant H_ALICE = 100_000_000e18;
    uint256 internal constant H_BOB = 250_000_000e18;
    uint256 internal constant H_CAROL = 37_000_000e18;
    uint256 internal constant H_DAVE = 13_000_000e18;
    uint256 internal constant ELIGIBLE = 400_000_000e18;

    uint256 internal constant REVENUE = 1_000_000e18;
    uint256 internal constant HOLDER_HALF = 500_000e18;

    function setUp() public {
        _deployProtocol();
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Wiring
    // ─────────────────────────────────────────────────────────────────────────────

    function test_Constants() public view {
        assertEq(vault.HOLDER_BPS(), 5000);
        assertEq(vault.EPOCH_MIN_INTERVAL(), 7 days);
        assertEq(vault.CLAIM_WINDOW(), 180 days);
        assertEq(vault.MAX_EXCLUDED(), 16);
        assertEq(address(vault.THOOD()), address(token));
        assertEq(address(vault.CHECKPOINTS()), address(token));
        assertEq(vault.treasury(), treasury);
        assertTrue(vault.isNotifier(address(activation)), "Activation may notify revenue");
        assertTrue(vault.isNotifier(address(groupRegistry)), "GroupRegistry may notify revenue");
        assertFalse(vault.isNotifier(alice));
        assertEq(vault.latestSnapshot(), 0, "no epoch sealed yet");
    }

    function test_Constructor_RevertsOnZeroAddresses() public {
        vm.expectRevert(RevenueVault.ZeroAddress.selector);
        new RevenueVault(owner, address(0), treasury);

        vm.expectRevert(RevenueVault.ZeroAddress.selector);
        new RevenueVault(owner, address(token), address(0));
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Revenue in
    // ─────────────────────────────────────────────────────────────────────────────

    function test_NotifyRevenue_OnlyNotifierMayCall() public {
        _fund(address(vault), 100e18);

        vm.prank(alice);
        vm.expectRevert(RevenueVault.NotNotifier.selector);
        vault.notifyRevenue(100e18);

        vm.prank(owner);
        vm.expectRevert(RevenueVault.NotNotifier.selector);
        vault.notifyRevenue(100e18);
    }

    function test_NotifyRevenue_SplitsFiftyFiftyAtReceipt() public {
        _fund(address(vault), REVENUE);

        vm.expectEmit(true, false, false, true, address(vault));
        emit RevenueReceived(address(activation), REVENUE, HOLDER_HALF, HOLDER_HALF);
        vm.prank(address(activation));
        vault.notifyRevenue(REVENUE);

        assertEq(vault.pendingHolders(), HOLDER_HALF);
        assertEq(vault.treasuryAccrued(), HOLDER_HALF);
        assertEq(vault.totalObligations(), REVENUE);
        _assertSolvent();
    }

    function test_NotifyRevenue_RevertsWhenTokensNeverArrived() public {
        vm.prank(address(activation));
        vm.expectRevert(RevenueVault.NotFunded.selector);
        vault.notifyRevenue(1_000e18);
    }

    function test_NotifyRevenue_AccumulatesAcrossPayments() public {
        _revenue(100e18);
        _revenue(300e18);
        _revenue(1);
        assertEq(vault.pendingHolders(), 50e18 + 150e18 + 0);
        assertEq(vault.treasuryAccrued(), 50e18 + 150e18 + 1);
        assertEq(vault.pendingHolders() + vault.treasuryAccrued(), 400e18 + 1);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Sealing
    // ─────────────────────────────────────────────────────────────────────────────

    function test_SealEpoch_RevertsNothingToSeal() public {
        _warpForward(30 days);
        vm.expectRevert(RevenueVault.NothingToSeal.selector);
        vault.sealEpoch();
    }

    function test_SealEpoch_RevertsTooSoonBeforeSevenDays() public {
        _seedHolders();
        _revenue(REVENUE);

        vm.expectRevert(RevenueVault.TooSoon.selector);
        vault.sealEpoch();

        _warpForward(7 days - 1);
        vm.expectRevert(RevenueVault.TooSoon.selector);
        vault.sealEpoch();

        _warpForward(1);
        _rollForward(1);
        vault.sealEpoch();
        assertEq(vault.epochCount(), 1);
        _assertSolvent();
    }

    function test_SealEpoch_FreezesSnapshotAndEligibleSupply() public {
        _seedHolders();
        _revenue(REVENUE);

        _warpForward(7 days);
        _rollForward(1);
        uint48 expectedSnapshot = uint48(_blockNumber() - 1);

        vm.expectEmit(true, false, false, true, address(vault));
        emit EpochSealed(0, expectedSnapshot, HOLDER_HALF, ELIGIBLE);
        uint256 id = vault.sealEpoch();
        _assertSolvent();

        assertEq(id, 0);
        (uint48 snap, uint64 sealedAt, uint256 holderAmount, uint256 eligible, uint256 claimed, bool swept) =
            vault.epochs(0);
        assertEq(snap, expectedSnapshot);
        assertEq(sealedAt, uint64(_timestamp()));
        assertEq(holderAmount, HOLDER_HALF);
        assertEq(eligible, ELIGIBLE);
        assertEq(claimed, 0);
        assertFalse(swept);
        assertEq(vault.pendingHolders(), 0, "pending moved into the epoch");
        assertEq(vault.sealedUnclaimed(), HOLDER_HALF);
        assertEq(vault.lastSealAt(), uint64(_timestamp()));
        assertEq(vault.nextSealAt(), uint64(_timestamp() + 7 days));
        assertEq(vault.latestSnapshot(), expectedSnapshot, "latestSnapshot tracks the newest epoch");

        // Moving tokens after the seal cannot change the frozen eligible supply.
        _rollForward(1);
        vm.prank(alice);
        token.transfer(treasury, H_ALICE);
        _rollForward(1);
        (,,, uint256 eligibleAfter,,) = vault.epochs(0);
        assertEq(eligibleAfter, ELIGIBLE, "eligibleSupply is computed once, at seal time");
    }

    function test_SealEpoch_IsPermissionless() public {
        _seedHolders();
        _revenue(REVENUE);
        _warpForward(7 days);
        _rollForward(1);

        vm.prank(eve); // a random address with no role and no balance
        uint256 id = vault.sealEpoch();
        assertEq(id, 0);
        _assertSolvent();
    }

    function test_SealEpoch_SecondSealNeedsAnotherSevenDays() public {
        _seedHolders();
        _revenue(REVENUE);
        _warpAndSeal();

        _revenue(REVENUE);
        vm.expectRevert(RevenueVault.TooSoon.selector);
        vault.sealEpoch();

        uint256 id = _warpAndSeal();
        assertEq(id, 1);
        assertEq(vault.epochCount(), 2);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // The claim math
    // ─────────────────────────────────────────────────────────────────────────────

    function test_ProRataClaimsAreExactToTheWei() public {
        _seedHolders();
        _revenue(REVENUE);
        uint256 id = _warpAndSeal();

        uint256 expectedAlice = HOLDER_HALF * H_ALICE / ELIGIBLE; // 125,000e18
        uint256 expectedBob = HOLDER_HALF * H_BOB / ELIGIBLE; // 312,500e18
        uint256 expectedCarol = HOLDER_HALF * H_CAROL / ELIGIBLE; // 46,250e18
        uint256 expectedDave = HOLDER_HALF * H_DAVE / ELIGIBLE; // 16,250e18

        assertEq(expectedAlice, 125_000e18);
        assertEq(expectedBob, 312_500e18);
        assertEq(expectedCarol, 46_250e18);
        assertEq(expectedDave, 16_250e18);

        assertEq(vault.claimable(alice, id), expectedAlice);
        assertEq(vault.claimable(bob, id), expectedBob);
        assertEq(vault.claimable(carol, id), expectedCarol);
        assertEq(vault.claimable(dave, id), expectedDave);

        uint256 total;
        total += _claim(alice, id, expectedAlice);
        total += _claim(bob, id, expectedBob);
        total += _claim(carol, id, expectedCarol);
        total += _claim(dave, id, expectedDave);

        assertEq(total, HOLDER_HALF, "these balances divide exactly: no dust at all");
        (,,,, uint256 claimed,) = vault.epochs(id);
        assertEq(claimed, HOLDER_HALF);
        assertEq(vault.sealedUnclaimed(), 0);
        assertEq(token.balanceOf(address(vault)), vault.treasuryAccrued(), "only the treasury half is left");
        _assertSolvent();
    }

    function test_ClaimEmitsEvent() public {
        _seedHolders();
        _revenue(REVENUE);
        uint256 id = _warpAndSeal();

        vm.expectEmit(true, true, false, true, address(vault));
        emit Claimed(alice, id, HOLDER_HALF * H_ALICE / ELIGIBLE);
        vm.prank(alice);
        vault.claim(id);
        _assertSolvent();
    }

    function test_ClaimSumEqualsHolderAmountMinusBoundedDust() public {
        // Deliberately ugly balances and an odd revenue amount so integer division bites.
        _fund(alice, 1e18);
        _fund(bob, 3e18);
        _fund(carol, 7e18);
        _rollForward(1);

        uint256 odd = REVENUE + 7;
        _revenue(odd);
        uint256 id = _warpAndSeal();

        (,, uint256 holderAmount, uint256 eligible,,) = vault.epochs(id);
        assertEq(eligible, 11e18);
        assertEq(holderAmount, odd / 2);

        uint256 sum;
        sum += _claim(alice, id, holderAmount * 1e18 / eligible);
        sum += _claim(bob, id, holderAmount * 3e18 / eligible);
        sum += _claim(carol, id, holderAmount * 7e18 / eligible);

        assertLe(sum, holderAmount, "claims can never exceed the epoch allocation");
        uint256 dust = holderAmount - sum;
        assertLe(dust, 2, "dust is bounded by one wei per holder");
        assertEq(vault.sealedUnclaimed(), dust, "dust stays in the contract");
        _assertSolvent();
    }

    function test_BuyingAfterTheSnapshotClaimsZero() public {
        _seedHolders();
        _revenue(REVENUE);
        uint256 id = _warpAndSeal();

        // eve buys a big bag one block AFTER the snapshot.
        _rollForward(1);
        _fund(eve, 300_000_000e18);
        _rollForward(1);

        assertEq(vault.claimable(eve, id), 0);
        assertEq(_claim(eve, id, 0), 0, "late buyers earn nothing from a sealed epoch");
        _assertSolvent();
    }

    function test_SellingBeforeTheSnapshotClaimsZero() public {
        _seedHolders();

        // dave exits entirely, one block BEFORE the snapshot.
        vm.prank(dave);
        token.transfer(eve, H_DAVE);
        _rollForward(1);

        _revenue(REVENUE);
        uint256 id = _warpAndSeal();

        assertEq(vault.claimable(dave, id), 0, "sold before the snapshot: nothing owed");
        assertEq(vault.claimable(eve, id), HOLDER_HALF * H_DAVE / ELIGIBLE, "the buyer earns it instead");

        _claim(dave, id, 0);
        _claim(eve, id, HOLDER_HALF * H_DAVE / ELIGIBLE);
        _assertSolvent();
    }

    function test_SellingAfterTheSnapshotStillClaimsTheFullShare() public {
        _seedHolders();
        _revenue(REVENUE);
        uint256 id = _warpAndSeal();

        uint256 expected = HOLDER_HALF * H_ALICE / ELIGIBLE;

        // alice dumps everything after the snapshot but before claiming.
        _rollForward(1);
        vm.prank(alice);
        token.transfer(eve, H_ALICE);
        _rollForward(1);
        assertEq(token.balanceOf(alice), 0);

        assertEq(vault.claimable(alice, id), expected);
        assertEq(_claim(alice, id, expected), expected, "the snapshot is what counts, not the balance now");
        assertEq(vault.claimable(eve, id), 0, "and the buyer gets nothing for that epoch");
        _assertSolvent();
    }

    function test_ZeroBalanceHolderClaimsZeroWithoutReverting() public {
        _seedHolders();
        _revenue(REVENUE);
        uint256 id = _warpAndSeal();

        assertEq(vault.claimable(eve, id), 0);
        vm.prank(eve);
        assertEq(vault.claim(id), 0);
        assertTrue(vault.hasClaimed(id, eve));
        _assertSolvent();
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Exclusions
    // ─────────────────────────────────────────────────────────────────────────────

    function test_ExcludedAddressClaimsZeroAndShrinksEligibleSupply() public {
        _seedHolders();

        // Epoch 0: bob is a normal holder.
        _revenue(REVENUE);
        uint256 id0 = _warpAndSeal();
        (,,, uint256 eligible0,,) = vault.epochs(id0);
        assertEq(eligible0, ELIGIBLE);

        uint256 aliceWithoutExclusion = vault.claimable(alice, id0);
        assertEq(aliceWithoutExclusion, HOLDER_HALF * H_ALICE / ELIGIBLE);
        assertEq(vault.claimable(bob, id0), HOLDER_HALF * H_BOB / ELIGIBLE);

        // Epoch 1: bob's address is excluded (as an LP pair would be).
        vm.expectEmit(true, false, false, true, address(vault));
        emit ExcludedSet(bob, true);
        vm.prank(owner);
        vault.setExcluded(bob, true);

        _revenue(REVENUE);
        uint256 id1 = _warpAndSeal();
        (,,, uint256 eligible1,,) = vault.epochs(id1);

        assertEq(eligible1, ELIGIBLE - H_BOB, "excluded balance is subtracted from eligibleSupply");

        uint256 aliceWithExclusion = vault.claimable(alice, id1);
        assertEq(aliceWithExclusion, HOLDER_HALF * H_ALICE / (ELIGIBLE - H_BOB));
        assertGt(aliceWithExclusion, aliceWithoutExclusion, "excluding a whale raises everyone else's share");
        assertEq(vault.claimable(bob, id1), 0, "an excluded address claims nothing");

        _claim(alice, id1, aliceWithExclusion);
        _claim(bob, id1, 0);
        _assertSolvent();
    }

    function test_ExclusionRemovalRestoresEligibility() public {
        _seedHolders();
        vm.prank(owner);
        vault.setExcluded(bob, true);
        assertTrue(vault.isExcluded(bob));

        vm.prank(owner);
        vault.setExcluded(bob, false);
        assertFalse(vault.isExcluded(bob));

        _revenue(REVENUE);
        uint256 id = _warpAndSeal();
        (,,, uint256 eligible,,) = vault.epochs(id);
        assertEq(eligible, ELIGIBLE);
        _claim(bob, id, HOLDER_HALF * H_BOB / ELIGIBLE);
        _assertSolvent();
    }

    function test_SetExcluded_CapsAtSixteen() public {
        assertEq(vault.excludedCount(), 2, "treasury and vault are excluded at deploy");

        vm.startPrank(owner);
        for (uint256 i = 0; i < 14; ++i) {
            vault.setExcluded(address(uint160(0x1000 + i)), true);
        }
        assertEq(vault.excludedCount(), 16);

        vm.expectRevert(RevenueVault.TooManyExcluded.selector);
        vault.setExcluded(address(uint160(0x2000)), true);
        vm.stopPrank();

        assertEq(vault.excludedList().length, 16);
    }

    function test_SetExcluded_IsIdempotentAndRemovable() public {
        uint256 before = vault.excludedCount();

        vm.prank(owner);
        vault.setExcluded(treasury, true); // already excluded — no-op
        assertEq(vault.excludedCount(), before);

        vm.prank(owner);
        vault.setExcluded(treasury, false);
        assertEq(vault.excludedCount(), before - 1);
        assertFalse(vault.isExcluded(treasury));

        vm.prank(owner);
        vault.setExcluded(treasury, false); // already included — no-op
        assertEq(vault.excludedCount(), before - 1);

        vm.prank(owner);
        vm.expectRevert(RevenueVault.ZeroAddress.selector);
        vault.setExcluded(address(0), true);
    }

    function test_EligibleSupplyZeroRoutesToTreasuryWithNoDeadEpoch() public {
        // Nobody holds $THOOD except the excluded treasury and the excluded vault.
        _revenue(1_000e18);

        _warpForward(7 days);
        _rollForward(1);

        vm.expectEmit(false, false, false, true, address(vault));
        emit PendingRoutedToTreasury(uint48(_blockNumber() - 1), 500e18);
        uint256 id = vault.sealEpoch();

        assertEq(id, type(uint256).max, "sentinel: no epoch was created");
        assertEq(vault.epochCount(), 0, "no dead epoch");
        assertEq(vault.pendingHolders(), 0);
        assertEq(vault.treasuryAccrued(), 1_000e18, "the whole payment went to the treasury");
        _assertSolvent();
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Claim guards
    // ─────────────────────────────────────────────────────────────────────────────

    function test_DoubleClaimReverts() public {
        _seedHolders();
        _revenue(REVENUE);
        uint256 id = _warpAndSeal();

        vm.prank(alice);
        vault.claim(id);
        assertTrue(vault.hasClaimed(id, alice));

        vm.prank(alice);
        vm.expectRevert(RevenueVault.AlreadyClaimed.selector);
        vault.claim(id);

        assertEq(vault.claimable(alice, id), 0, "claimable reports zero once claimed");
        _assertSolvent();
    }

    function test_ClaimMany_PaysEveryEpochInOneTransfer() public {
        _seedHolders();
        _revenue(REVENUE);
        uint256 id0 = _warpAndSeal();
        _revenue(REVENUE * 2);
        uint256 id1 = _warpAndSeal();

        uint256 expected0 = HOLDER_HALF * H_ALICE / ELIGIBLE;
        uint256 expected1 = (REVENUE * 2 / 2) * H_ALICE / ELIGIBLE;
        assertEq(vault.totalClaimable(alice), expected0 + expected1);

        uint256[] memory ids = new uint256[](2);
        ids[0] = id0;
        ids[1] = id1;

        uint256 before = token.balanceOf(alice);
        vm.prank(alice);
        uint256 total = vault.claimMany(ids);

        assertEq(total, expected0 + expected1);
        assertEq(token.balanceOf(alice) - before, total);
        assertEq(vault.totalClaimable(alice), 0);
        _assertSolvent();
    }

    function test_ClaimMany_RevertsOnDuplicateEpoch() public {
        _seedHolders();
        _revenue(REVENUE);
        uint256 id = _warpAndSeal();

        uint256[] memory ids = new uint256[](2);
        ids[0] = id;
        ids[1] = id;

        vm.prank(alice);
        vm.expectRevert(RevenueVault.AlreadyClaimed.selector);
        vault.claimMany(ids);
    }

    function test_UnknownEpochReverts() public {
        vm.expectRevert(RevenueVault.UnknownEpoch.selector);
        vault.claimable(alice, 0);

        vm.prank(alice);
        vm.expectRevert(RevenueVault.UnknownEpoch.selector);
        vault.claim(0);

        vm.expectRevert(RevenueVault.UnknownEpoch.selector);
        vault.sweepExpired(0);
    }

    function test_ClaimIsProtectedAgainstReentrancy() public {
        // $THOOD has no transfer hooks, so a hooked token is used to manufacture the attack surface.
        HookToken hooked = new HookToken();
        RevenueVault hookVault = new RevenueVault(address(this), address(hooked), treasury);
        hookVault.setNotifier(address(this), true);

        ReentrantClaimer attacker = new ReentrantClaimer(hookVault);
        hooked.mint(address(attacker), 1_000e18);
        _rollForward(1);

        uint256 e0 = _seedHookEpoch(hooked, hookVault, 400e18);
        uint256 e1 = _seedHookEpoch(hooked, hookVault, 400e18);

        hooked.setHook(address(attacker));
        uint256 got = attacker.attack(e0, e1);

        assertGt(got, 0, "the honest outer claim still succeeds");
        assertTrue(attacker.reentryBlocked(), "the re-entrant claim of a DIFFERENT epoch was blocked");
        assertFalse(attacker.reentrySucceeded());
        assertFalse(hookVault.hasClaimed(e1, address(attacker)), "no state was written by the blocked call");

        // The guard is not sticky: a later, honest claim of the second epoch works.
        hooked.setHook(address(0));
        vm.prank(address(attacker));
        assertGt(hookVault.claim(e1), 0);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Sweeping
    // ─────────────────────────────────────────────────────────────────────────────

    function test_SweepExpired_RevertsBeforeClaimWindow() public {
        _seedHolders();
        _revenue(REVENUE);
        uint256 id = _warpAndSeal();

        vm.expectRevert(RevenueVault.ClaimWindowOpen.selector);
        vault.sweepExpired(id);

        _warpForward(180 days - 1);
        vm.expectRevert(RevenueVault.ClaimWindowOpen.selector);
        vault.sweepExpired(id);
    }

    function test_SweepExpired_MovesExactlyTheRemainder() public {
        _seedHolders();
        _revenue(REVENUE);
        uint256 id = _warpAndSeal();

        uint256 aliceShare = _claim(alice, id, HOLDER_HALF * H_ALICE / ELIGIBLE);
        uint256 remainder = HOLDER_HALF - aliceShare;
        uint256 treasuryBefore = vault.treasuryAccrued();

        _warpForward(180 days);
        vm.expectEmit(true, false, false, true, address(vault));
        emit ExpiredSwept(id, remainder);
        vault.sweepExpired(id);
        _assertSolvent();

        assertEq(vault.treasuryAccrued(), treasuryBefore + remainder, "exactly the remainder moved");
        assertEq(vault.sealedUnclaimed(), 0);
        (,,,,, bool swept) = vault.epochs(id);
        assertTrue(swept);

        vm.expectRevert(RevenueVault.AlreadySwept.selector);
        vault.sweepExpired(id);
    }

    function test_SweptEpochPaysNothingFurther() public {
        _seedHolders();
        _revenue(REVENUE);
        uint256 id = _warpAndSeal();

        _warpForward(180 days);
        vault.sweepExpired(id);
        _assertSolvent();

        assertEq(vault.claimable(bob, id), 0);
        assertEq(_claim(bob, id, 0), 0);
        assertEq(vault.treasuryAccrued(), REVENUE, "the whole payment ends up with the treasury");
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Treasury
    // ─────────────────────────────────────────────────────────────────────────────

    function test_WithdrawTreasury_TransfersAndEmits() public {
        _revenue(REVENUE);
        uint256 before = token.balanceOf(eve);

        vm.expectEmit(true, false, false, true, address(vault));
        emit TreasuryWithdrawn(eve, 200_000e18);
        vm.prank(owner);
        vault.withdrawTreasury(eve, 200_000e18);
        _assertSolvent();

        assertEq(token.balanceOf(eve) - before, 200_000e18);
        assertEq(vault.treasuryAccrued(), HOLDER_HALF - 200_000e18);
    }

    function test_WithdrawTreasury_CanNeverTouchHolderMoney() public {
        _revenue(REVENUE);

        vm.prank(owner);
        vm.expectRevert(RevenueVault.InsufficientTreasury.selector);
        vault.withdrawTreasury(eve, HOLDER_HALF + 1);

        vm.prank(owner);
        vault.withdrawTreasury(eve, HOLDER_HALF);
        assertEq(vault.treasuryAccrued(), 0);
        assertEq(token.balanceOf(address(vault)), HOLDER_HALF, "the holders' half is untouched");
        _assertSolvent();

        vm.prank(owner);
        vm.expectRevert(RevenueVault.InsufficientTreasury.selector);
        vault.withdrawTreasury(eve, 1);
    }

    function test_WithdrawTreasury_RejectsZeroAddress() public {
        _revenue(REVENUE);
        vm.prank(owner);
        vm.expectRevert(RevenueVault.ZeroAddress.selector);
        vault.withdrawTreasury(address(0), 1);
    }

    function test_SetTreasuryAndNotifier() public {
        vm.startPrank(owner);
        vault.setTreasury(eve);
        assertEq(vault.treasury(), eve);
        vault.setNotifier(eve, true);
        assertTrue(vault.isNotifier(eve));
        vault.setNotifier(eve, false);
        assertFalse(vault.isNotifier(eve));

        vm.expectRevert(RevenueVault.ZeroAddress.selector);
        vault.setTreasury(address(0));
        vm.expectRevert(RevenueVault.ZeroAddress.selector);
        vault.setNotifier(address(0), true);
        vm.stopPrank();
    }

    function test_AccessControl_OwnerOnlySetters() public {
        bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice);

        vm.startPrank(alice);
        vm.expectRevert(err);
        vault.withdrawTreasury(alice, 0);
        vm.expectRevert(err);
        vault.setExcluded(alice, true);
        vm.expectRevert(err);
        vault.setTreasury(alice);
        vm.expectRevert(err);
        vault.setNotifier(alice, true);
        vm.stopPrank();
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Solvency across a long sequence
    // ─────────────────────────────────────────────────────────────────────────────

    function test_SolvencyHoldsAcrossAFullSequence() public {
        _seedHolders();
        _assertSolvent();

        _revenue(REVENUE);
        uint256 id0 = _warpAndSeal();

        _claim(alice, id0, HOLDER_HALF * H_ALICE / ELIGIBLE);
        _claim(bob, id0, HOLDER_HALF * H_BOB / ELIGIBLE);

        _revenue(REVENUE / 4);
        _assertSolvent();

        vm.prank(owner);
        vault.withdrawTreasury(eve, 100_000e18);
        _assertSolvent();

        // The second epoch's eligible supply is larger: the claims and the treasury withdrawal moved
        // $THOOD out of excluded addresses and into ordinary wallets. Recompute the documented
        // formula from the frozen epoch data rather than assuming the earlier constant still holds.
        uint256 id1 = _warpAndSeal();
        (uint48 snap1,, uint256 holderAmount1, uint256 eligible1,,) = vault.epochs(id1);
        assertGt(eligible1, ELIGIBLE, "claimed and withdrawn $THOOD re-enters the eligible supply");
        _claim(carol, id1, holderAmount1 * token.balanceOfAt(carol, snap1) / eligible1);

        _warpForward(180 days);
        vault.sweepExpired(id0);
        _assertSolvent();
        vault.sweepExpired(id1);
        _assertSolvent();

        uint256 finalTreasury = vault.treasuryAccrued();
        vm.prank(owner);
        vault.withdrawTreasury(eve, finalTreasury);
        _assertSolvent();

        assertEq(vault.totalObligations(), 0, "everything has been distributed or withdrawn");
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Fuzz
    // ─────────────────────────────────────────────────────────────────────────────

    function testFuzz_SplitIsAlwaysExactlyFiftyFifty(uint256 amount) public {
        amount = bound(amount, 0, 500_000_000e18);
        _revenue(amount);

        assertEq(vault.pendingHolders(), amount / 2, "holders get floor(amount/2)");
        assertEq(vault.treasuryAccrued(), amount - amount / 2, "treasury gets the remainder");
        assertEq(vault.pendingHolders() + vault.treasuryAccrued(), amount, "not a wei is lost");
        _assertSolvent();
    }

    function testFuzz_ProRataShareIsExact(uint96 balA, uint96 balB, uint96 revenue) public {
        uint256 a = bound(uint256(balA), 1e12, 100_000_000e18);
        uint256 b = bound(uint256(balB), 1e12, 100_000_000e18);
        uint256 amount = bound(uint256(revenue), 2, 50_000_000e18);

        _fund(alice, a);
        _fund(bob, b);
        _rollForward(1);

        _revenue(amount);
        uint256 id = _warpAndSeal();

        (,, uint256 holderAmount, uint256 eligible,,) = vault.epochs(id);
        assertEq(eligible, a + b, "only the two holders are eligible");
        assertEq(holderAmount, amount / 2);

        uint256 expectedA = holderAmount * a / eligible;
        uint256 expectedB = holderAmount * b / eligible;

        assertEq(vault.claimable(alice, id), expectedA);
        assertEq(vault.claimable(bob, id), expectedB);

        uint256 got = _claim(alice, id, expectedA) + _claim(bob, id, expectedB);
        assertLe(got, holderAmount, "the pot can never be overdrawn");
        assertLe(holderAmount - got, 2, "dust is bounded by one wei per holder");
        _assertSolvent();
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Internals
    // ─────────────────────────────────────────────────────────────────────────────

    /// @dev Distributes the reference holder balances and moves to the next block.
    function _seedHolders() internal {
        _fund(alice, H_ALICE);
        _fund(bob, H_BOB);
        _fund(carol, H_CAROL);
        _fund(dave, H_DAVE);
        _rollForward(1);
    }

    /// @dev Claims, asserts the exact amount received, and re-checks solvency.
    function _claim(address user, uint256 epochId, uint256 expected) internal returns (uint256 amount) {
        uint256 before = token.balanceOf(user);
        vm.prank(user);
        amount = vault.claim(epochId);
        assertEq(amount, expected, "claim returned an unexpected amount");
        assertEq(token.balanceOf(user) - before, expected, "transfer did not match the claim");
        _assertSolvent();
    }

    /// @dev Funds and seals one epoch on the hooked-token vault used for the reentrancy test.
    function _seedHookEpoch(HookToken hooked, RevenueVault hookVault, uint256 amount)
        internal
        returns (uint256 epochId)
    {
        hooked.mint(address(hookVault), amount);
        hookVault.notifyRevenue(amount);
        _warpForward(7 days);
        _rollForward(1);
        epochId = hookVault.sealEpoch();
    }
}
