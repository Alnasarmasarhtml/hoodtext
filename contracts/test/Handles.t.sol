// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Fixture} from "./utils/Fixture.sol";
import {Handles} from "../src/Handles.sol";

/**
 * @title HandlesTest
 * @notice @names: free with the $5 activation, one per address, short names reserved by perk tier
 *         (4 chars = BLOCK CAPTAIN, 3 = DISTRICT, 2 = KINGPIN).
 */
contract HandlesTest is Fixture {
    event HandleClaimed(address indexed user, string handle);
    event HandleReleased(address indexed user, string handle);

    /// @dev 1B supply: the perk thresholds in absolute $THOOD.
    uint256 internal constant T_RESIDENT = 500_000e18; // 0.05%
    uint256 internal constant T_CAPTAIN = 1_000_000e18; // 0.10%
    uint256 internal constant T_DISTRICT = 2_500_000e18; // 0.25%
    uint256 internal constant T_KINGPIN = 5_000_000e18; // 0.50%

    function setUp() public {
        _deployProtocol();
        _activateUser(alice);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Claiming
    // ─────────────────────────────────────────────────────────────────────────────

    function test_Claim_StoresBothDirections() public {
        vm.expectEmit(true, false, false, true, address(handles));
        emit HandleClaimed(alice, "alice_in_the_h");
        vm.prank(alice);
        handles.claim("alice_in_the_h");

        assertEq(handles.handleOf(alice), "alice_in_the_h");
        assertEq(handles.addressOf("alice_in_the_h"), alice);
    }

    function test_Claim_RequiresActivation() public {
        vm.prank(bob); // never activated
        vm.expectRevert(Handles.NotActivated.selector);
        handles.claim("bobby");
    }

    function test_Claim_UniqueNames() public {
        vm.prank(alice);
        handles.claim("plumbob");

        _activateUser(bob);
        vm.prank(bob);
        vm.expectRevert(Handles.HandleTaken.selector);
        handles.claim("plumbob");
    }

    function test_Claim_NewHandleReleasesTheOld() public {
        vm.startPrank(alice);
        handles.claim("first");

        vm.expectEmit(true, false, false, true, address(handles));
        emit HandleReleased(alice, "first");
        vm.expectEmit(true, false, false, true, address(handles));
        emit HandleClaimed(alice, "second");
        handles.claim("second");
        vm.stopPrank();

        assertEq(handles.handleOf(alice), "second");
        assertEq(handles.addressOf("first"), address(0), "the old name went back into the pool");

        _activateUser(bob);
        vm.prank(bob);
        handles.claim("first"); // and is claimable again
        assertEq(handles.addressOf("first"), bob);
    }

    function test_Release_ClearsAndFrees() public {
        vm.startPrank(alice);
        handles.claim("gone_soon");
        handles.release();
        vm.stopPrank();

        assertEq(handles.handleOf(alice), "");
        assertEq(handles.addressOf("gone_soon"), address(0));

        vm.prank(alice);
        vm.expectRevert(Handles.NoHandle.selector);
        handles.release();
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Validation
    // ─────────────────────────────────────────────────────────────────────────────

    function test_Validation_Rules() public view {
        assertTrue(handles.isValidName("ab"));
        assertTrue(handles.isValidName("a1"));
        assertTrue(handles.isValidName("valid_name_123"));
        assertTrue(handles.isValidName("abcdefghijklmno"), "15 chars is the maximum");

        assertFalse(handles.isValidName("a"), "too short");
        assertFalse(handles.isValidName("abcdefghijklmnop"), "16 chars is too long");
        assertFalse(handles.isValidName("Alice"), "uppercase is rejected");
        assertFalse(handles.isValidName("1abc"), "must start with a letter");
        assertFalse(handles.isValidName("_abc"), "must start with a letter");
        assertFalse(handles.isValidName("ab-c"), "hyphens are rejected");
        assertFalse(handles.isValidName("ab.c"), "dots are rejected");
        assertFalse(handles.isValidName(unicode"ab¢"), "non-ascii is rejected");
        assertFalse(handles.isValidName(""), "empty is rejected");
    }

    function test_Claim_RejectsInvalidNames() public {
        vm.startPrank(alice);
        vm.expectRevert(Handles.InvalidHandle.selector);
        handles.claim("Alice");
        vm.expectRevert(Handles.InvalidHandle.selector);
        handles.claim("a");
        vm.expectRevert(Handles.InvalidHandle.selector);
        handles.claim("this_name_is_far_too_long");
        vm.stopPrank();
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Short names are the flex
    // ─────────────────────────────────────────────────────────────────────────────

    function test_RequiredTier_Ladder() public view {
        assertEq(handles.requiredTier(15), 0);
        assertEq(handles.requiredTier(5), 0, "5+ chars: any activated account");
        assertEq(handles.requiredTier(4), 2, "4 chars: BLOCK CAPTAIN");
        assertEq(handles.requiredTier(3), 3, "3 chars: DISTRICT");
        assertEq(handles.requiredTier(2), 4, "2 chars: KINGPIN");
    }

    function test_FourCharsNeedsBlockCaptain() public {
        vm.prank(alice); // activated, holds nothing
        vm.expectRevert(Handles.TierTooLow.selector);
        handles.claim("nick");

        _fund(alice, T_CAPTAIN); // 0.1% of supply -> tier 2
        vm.prank(alice);
        handles.claim("nick");
        assertEq(handles.addressOf("nick"), alice);
    }

    function test_ThreeCharsNeedsDistrict() public {
        _fund(alice, T_CAPTAIN); // tier 2 is not enough
        vm.prank(alice);
        vm.expectRevert(Handles.TierTooLow.selector);
        handles.claim("nik");

        _fund(alice, T_DISTRICT - T_CAPTAIN); // top up to 0.25% -> tier 3
        vm.prank(alice);
        handles.claim("nik");
    }

    function test_TwoCharsNeedsKingpin() public {
        _fund(alice, T_DISTRICT); // tier 3 is not enough
        vm.prank(alice);
        vm.expectRevert(Handles.TierTooLow.selector);
        handles.claim("nk");

        _fund(alice, T_KINGPIN - T_DISTRICT); // 0.5% -> tier 4
        vm.prank(alice);
        handles.claim("nk");
        assertEq(handles.handleOf(alice), "nk");
    }

    function test_ShortNameSurvivesSellingLater() public {
        _fund(alice, T_KINGPIN);
        vm.prank(alice);
        handles.claim("nk");

        // alice dumps everything. Status earned is not clawed back.
        vm.prank(alice);
        token.transfer(bob, T_KINGPIN);

        assertEq(handles.handleOf(alice), "nk", "the perk gate is checked at claim time only");
    }
}
