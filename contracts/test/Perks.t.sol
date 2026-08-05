// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {Fixture} from "./utils/Fixture.sol";
import {Perks} from "../src/Perks.sol";

/**
 * @title PerksTest
 * @notice The holder status ladder: RESIDENT 0.05%, BLOCK CAPTAIN 0.1%, DISTRICT 0.25%,
 *         KINGPIN 0.5% — judged on the LOWER of the live balance and the balance at the last
 *         sealed revenue snapshot, so a tier cannot be flash-bought.
 */
contract PerksTest is Fixture {
    /// @dev 1B supply: the default thresholds in absolute $THOOD.
    uint256 internal constant T_RESIDENT = 500_000e18;
    uint256 internal constant T_CAPTAIN = 1_000_000e18;
    uint256 internal constant T_DISTRICT = 2_500_000e18;
    uint256 internal constant T_KINGPIN = 5_000_000e18;

    function setUp() public {
        _deployProtocol();
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // The ladder
    // ─────────────────────────────────────────────────────────────────────────────

    function test_DefaultThresholds() public {
        assertEq(perks.thresholdsBps(0), 5);
        assertEq(perks.thresholdsBps(1), 10);
        assertEq(perks.thresholdsBps(2), 25);
        assertEq(perks.thresholdsBps(3), 50);
        assertEq(perks.thresholdAmount(1), T_RESIDENT);
        assertEq(perks.thresholdAmount(2), T_CAPTAIN);
        assertEq(perks.thresholdAmount(3), T_DISTRICT);
        assertEq(perks.thresholdAmount(4), T_KINGPIN);

        vm.expectRevert(Perks.InvalidTier.selector);
        perks.thresholdAmount(0);
        vm.expectRevert(Perks.InvalidTier.selector);
        perks.thresholdAmount(5);
    }

    function test_TierBoundaries_BeforeAnyEpoch() public {
        assertEq(perks.tierOf(alice), 0, "no balance, no tier");

        _fund(alice, T_RESIDENT - 1);
        assertEq(perks.tierOf(alice), 0, "one wei below the line is below the line");

        _fund(alice, 1);
        assertEq(perks.tierOf(alice), 1, "RESIDENT at exactly 0.05%");

        _fund(alice, T_CAPTAIN - T_RESIDENT);
        assertEq(perks.tierOf(alice), 2, "BLOCK CAPTAIN at 0.1%");

        _fund(alice, T_DISTRICT - T_CAPTAIN);
        assertEq(perks.tierOf(alice), 3, "DISTRICT at 0.25%");

        _fund(alice, T_KINGPIN - T_DISTRICT);
        assertEq(perks.tierOf(alice), 4, "KINGPIN at 0.5%");
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // The anti-flash-buy anchor
    // ─────────────────────────────────────────────────────────────────────────────

    function test_BuyingAfterTheSnapshotDoesNotGrantTheTierYet() public {
        _fund(alice, T_RESIDENT); // alice holds through the seal; bob holds nothing yet
        _rollForward(1);
        _revenue(1_000e18);
        _warpAndSeal();

        // bob buys a KINGPIN bag AFTER the snapshot.
        _fund(bob, T_KINGPIN);
        _rollForward(1);

        assertEq(perks.tierOf(bob), 0, "held now but not at the snapshot: no tier yet");
        assertEq(perks.tierOf(alice), 1, "held both now and at the snapshot: tier stands");
        assertEq(perks.eligibleBalance(bob), 0);
        assertEq(perks.eligibleBalance(alice), T_RESIDENT);

        // The next weekly seal picks bob's balance up.
        _revenue(1_000e18);
        _warpAndSeal();
        assertEq(perks.tierOf(bob), 4, "one seal later the tier is real");
    }

    function test_SellingDropsTheTierImmediately() public {
        _fund(alice, T_KINGPIN);
        _rollForward(1);
        _revenue(1_000e18);
        _warpAndSeal();
        assertEq(perks.tierOf(alice), 4);

        // alice sells down to CAPTAIN size: the LIVE side of min() bites at once.
        vm.prank(alice);
        token.transfer(bob, T_KINGPIN - T_CAPTAIN);
        assertEq(perks.tierOf(alice), 2, "selling is punished immediately, not at the next seal");
    }

    function test_BeforeFirstEpochLiveBalanceDecides() public {
        assertEq(vault.latestSnapshot(), 0, "no epoch yet");
        _fund(alice, T_DISTRICT);
        assertEq(perks.tierOf(alice), 3, "bootstrap: nothing to anchor to, live balance decides");
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Owner
    // ─────────────────────────────────────────────────────────────────────────────

    function test_SetThresholds_Validated() public {
        uint16[4] memory good = [uint16(10), 20, 50, 100];
        vm.prank(owner);
        perks.setThresholdsBps(good);
        assertEq(perks.thresholdAmount(1), 1_000_000e18, "10 bps of 1B");

        _fund(alice, T_RESIDENT); // 5 bps no longer clears the new 10 bps bar
        assertEq(perks.tierOf(alice), 0);

        vm.startPrank(owner);
        uint16[4] memory zero = [uint16(0), 10, 25, 50];
        vm.expectRevert(Perks.InvalidThresholds.selector);
        perks.setThresholdsBps(zero);

        uint16[4] memory unsorted = [uint16(10), 5, 25, 50];
        vm.expectRevert(Perks.InvalidThresholds.selector);
        perks.setThresholdsBps(unsorted);

        uint16[4] memory flat = [uint16(10), 10, 25, 50];
        vm.expectRevert(Perks.InvalidThresholds.selector);
        perks.setThresholdsBps(flat);

        uint16[4] memory over = [uint16(10), 25, 50, 10_001];
        vm.expectRevert(Perks.InvalidThresholds.selector);
        perks.setThresholdsBps(over);
        vm.stopPrank();
    }

    function test_AccessControl_OwnerOnlySetters() public {
        bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice);
        uint16[4] memory bps = [uint16(1), 2, 3, 4];

        vm.startPrank(alice);
        vm.expectRevert(err);
        perks.setThresholdsBps(bps);
        vm.expectRevert(err);
        perks.setVault(alice);
        vm.stopPrank();

        vm.prank(owner);
        vm.expectRevert(Perks.ZeroAddress.selector);
        perks.setVault(address(0));
    }
}
