// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Fixture} from "./utils/Fixture.sol";
import {Anchors} from "../src/Anchors.sol";
import {GroupRegistry} from "../src/GroupRegistry.sol";

/**
 * @title IntegrationTest
 * @notice The full TeleHood lifecycle against the production topology:
 *
 *         activate ($5, once) -> claim a handle -> create a room ($10/month) -> post 1:1 and room
 *         drops, self and relayed -> the room lapses and posting is blocked while administration
 *         still works -> auto-renew revives it permissionlessly -> revenue seals into an epoch ->
 *         holders claim exactly pro-rata -> the treasury withdraws -> perk tiers require holding
 *         through a snapshot -> the solvency invariant holds at every step.
 */
contract IntegrationTest is Fixture {
    bytes32 internal constant ROOM = keccak256("room.boardroom");

    /// @dev At 1,000 $THOOD per dollar.
    uint256 internal constant ACT = 5_000e18; // $5 activation
    uint256 internal constant RENT = 10_000e18; // $10 month of rent

    /// @dev carol's whale bag: 0.5% of supply.
    uint256 internal constant WHALE_BAG = 5_000_000e18;

    function setUp() public {
        _deployProtocol();
    }

    function test_FullLifecycle() public {
        // ── 1. Two users pay the $5 handshake; a third is sponsored in ───────────
        _activateUser(alice);
        _activateUser(bob);

        _fund(bob, ACT);
        vm.startPrank(bob);
        token.approve(address(activation), ACT);
        activation.activateFor(dave); // bob sponsors dave
        vm.stopPrank();

        assertTrue(activation.isActivated(alice) && activation.isActivated(bob) && activation.isActivated(dave));
        assertEq(token.balanceOf(address(vault)), 3 * ACT, "three activations in the vault");
        _assertSolvent();

        // ── 2. Handles ───────────────────────────────────────────────────────────
        vm.prank(alice);
        handles.claim("alice");
        vm.prank(bob);
        handles.claim("bobby");
        assertEq(handles.addressOf("alice"), alice);

        // ── 3. alice opens a room, one month of rent ─────────────────────────────
        _createRoom(alice, ROOM, 1);
        assertTrue(groupRegistry.isActive(ROOM));

        // ── 4. Messages flow: self-posted 1:1, self-posted room, relayed batch ───
        vm.prank(alice);
        anchors.post(_drop(1)); // stealth 1:1

        vm.prank(bob);
        anchors.post(_roomDrop(ROOM, 2)); // any activated account may post into a live room

        Anchors.Drop[] memory batch = new Anchors.Drop[](2);
        batch[0] = _drop(3);
        batch[1] = _roomDrop(ROOM, 4);
        vm.prank(relay);
        anchors.postBatch(batch); // the gasless path

        assertEq(anchors.seq(), 4);

        // ── 5. The room lapses: posting stops, administration does not ───────────
        _warpForward(31 days);
        assertFalse(groupRegistry.isActive(ROOM));

        vm.prank(bob);
        vm.expectRevert(Anchors.RoomInactive.selector);
        anchors.post(_roomDrop(ROOM, 5));

        vm.prank(alice);
        anchors.post(_drop(6)); // 1:1 is untouched by room rent
        assertEq(anchors.seq(), 5);

        vm.prank(alice);
        groupRegistry.rotateEpoch(ROOM, keccak256("root.v1")); // lapsed admin still administers

        // ── 6. Auto-renew revives the room from the admin's own allowance ────────
        vm.prank(alice);
        groupRegistry.setAutoRenew(ROOM, true);
        _fund(alice, RENT);
        vm.prank(alice);
        token.approve(address(groupRegistry), RENT);

        vm.prank(keeper); // anyone may fire it once due
        groupRegistry.renewFor(ROOM);
        assertTrue(groupRegistry.isActive(ROOM), "the room reopened exactly as it was");

        vm.prank(bob);
        anchors.post(_roomDrop(ROOM, 7));
        assertEq(anchors.seq(), 6);

        // ── 7. Holders emerge: carol activates and buys a whale bag, eve buys too
        _activateUser(carol); // she wants the short handle later, so she pays the $5 like everyone
        _fund(carol, WHALE_BAG);
        _fund(eve, WHALE_BAG); // same size so the pro-rata math is transparent
        _rollForward(1);

        // ── 8. The weekly seal: everything paid so far becomes a claimable epoch ─
        uint256 revenueSoFar = 4 * ACT + 2 * RENT; // four activations + create rent + renewal
        assertEq(token.balanceOf(address(vault)), revenueSoFar);

        uint256 epochId = _warpAndSeal();
        (,, uint256 holderAmount, uint256 eligibleSupply,,) = vault.epochs(epochId);
        assertEq(holderAmount, revenueSoFar / 2, "half of every payment belongs to holders");

        // ── 9. Claims are exactly pro-rata by holdings at the snapshot ───────────
        uint256 expectedCarol = holderAmount * WHALE_BAG / eligibleSupply;
        assertEq(vault.claimable(carol, epochId), expectedCarol);

        uint256 before = token.balanceOf(carol);
        vm.prank(carol);
        vault.claim(epochId);
        assertEq(token.balanceOf(carol) - before, expectedCarol, "carol got exactly her share");
        _assertSolvent();

        vm.prank(eve);
        vault.claim(epochId);
        _assertSolvent();

        // ── 10. The treasury withdraws its half; holder money is untouchable ─────
        uint256 accrued = vault.treasuryAccrued();
        assertEq(accrued, revenueSoFar - revenueSoFar / 2);
        vm.prank(owner);
        vault.withdrawTreasury(treasury, accrued);
        _assertSolvent();

        // ── 11. Perk tiers require holding THROUGH the snapshot ──────────────────
        assertEq(perks.tierOf(carol), 4, "carol held 0.5% at the snapshot and still does: KINGPIN");

        vm.prank(carol);
        handles.claim("cz"); // the 2-char flex only a KINGPIN can take

        _fund(dave, WHALE_BAG); // dave buys in AFTER the snapshot
        _rollForward(1);
        assertEq(perks.tierOf(dave), 0, "bought after the snapshot: no tier until the next seal");

        vm.prank(dave);
        vm.expectRevert(); // TierTooLow
        handles.claim("dv");

        // A week later the next seal picks dave's balance up.
        _revenue(1_000e18);
        _warpAndSeal();
        assertEq(perks.tierOf(dave), 4);
        vm.prank(dave);
        handles.claim("dv");
        assertEq(handles.addressOf("dv"), dave);

        // ── 12. Ten years on, the $5 handshake still holds ───────────────────────
        _warpForward(3650 days);
        vm.prank(alice);
        anchors.post(_drop(99));
        assertTrue(activation.isActivated(alice), "activation is forever");
        _assertSolvent();
    }

    function test_RevenueFlowsFromBothSourcesIntoOneVault() public {
        _activateUser(alice); // Activation notifies the vault
        _createRoom(alice, ROOM, 12); // GroupRegistry notifies the vault

        assertEq(token.balanceOf(address(vault)), ACT + 12 * RENT);
        assertEq(vault.pendingHolders(), (ACT + 12 * RENT) / 2);
        assertEq(vault.treasuryAccrued(), (ACT + 12 * RENT) / 2);
        _assertSolvent();
    }

    function test_SponsoredUserCanDoEverythingAPayingUserCan() public {
        vm.prank(owner);
        activation.grant(carol); // comped by the team

        vm.prank(carol);
        handles.claim("carol");

        _createRoom(carol, ROOM, 1);
        vm.prank(carol);
        anchors.post(_roomDrop(ROOM, 1));

        assertEq(anchors.seq(), 1, "a granted account is a first-class account");
    }
}
