// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {Fixture} from "./utils/Fixture.sol";
import {GroupRegistry} from "../src/GroupRegistry.sol";

/**
 * @title GroupRegistryTest
 * @notice Rooms at $10/month, paid by whoever runs them. Rent lapsing blocks new messages only —
 *         administration, membership and history all survive, and paying again reopens the room.
 */
contract GroupRegistryTest is Fixture {
    event GroupCreated(
        bytes32 indexed groupId,
        address indexed admin,
        bytes32 memberRoot,
        uint8 months,
        uint256 thoodPaid,
        uint64 paidUntil
    );
    event RentPaid(bytes32 indexed groupId, address indexed payer, uint8 months, uint256 thoodPaid, uint64 paidUntil);
    event RentGranted(bytes32 indexed groupId, uint8 months, uint64 paidUntil);
    event AutoRenewSet(bytes32 indexed groupId, bool on);
    event EpochRotated(bytes32 indexed groupId, uint32 epoch, bytes32 memberRoot, uint64 at);
    event AdminTransferred(bytes32 indexed groupId, address indexed from, address indexed to);

    bytes32 internal constant ROOM = keccak256("room.alpha");
    bytes32 internal constant ROOT = keccak256("root.v0");

    /// @dev $10/month at 1,000 $THOOD per dollar.
    uint256 internal constant RENT_1MO = 10_000e18;

    function setUp() public {
        _deployProtocol();
        _activateUser(alice);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Creation
    // ─────────────────────────────────────────────────────────────────────────────

    function test_Constants() public view {
        assertEq(groupRegistry.MONTH(), 30 days);
        assertEq(groupRegistry.MAX_MONTHS(), 24);
        assertEq(groupRegistry.RENEW_WINDOW(), 3 days);
        assertEq(groupRegistry.rentUsdPerMonth(), 10e18, "default rent is ten dollars");
        assertEq(groupRegistry.quoteRent(1), RENT_1MO);
        assertEq(groupRegistry.quoteRent(12), 12 * RENT_1MO);
    }

    function test_CreateGroup_PaysRentAndStoresState() public {
        uint256 vaultBefore = token.balanceOf(address(vault)); // alice's setUp activation
        uint256 pendingBefore = vault.pendingHolders();
        uint256 paid = groupRegistry.quoteRent(3);
        _fund(alice, paid);

        uint64 expectedPaidUntil = uint64(_timestamp() + 3 * 30 days);

        vm.startPrank(alice);
        token.approve(address(groupRegistry), paid);
        vm.expectEmit(true, true, false, true, address(groupRegistry));
        emit GroupCreated(ROOM, alice, ROOT, 3, paid, expectedPaidUntil);
        groupRegistry.createGroup(ROOM, ROOT, 3);
        vm.stopPrank();

        (address admin, uint32 epoch, uint64 createdAt, bytes32 root, uint64 paidUntil, bool autoRenew, bool exists) =
            groupRegistry.groups(ROOM);
        assertEq(admin, alice);
        assertEq(epoch, 0);
        assertEq(createdAt, uint64(_timestamp()));
        assertEq(root, ROOT);
        assertEq(paidUntil, expectedPaidUntil);
        assertFalse(autoRenew);
        assertTrue(exists);
        assertTrue(groupRegistry.isActive(ROOM));

        assertEq(token.balanceOf(address(vault)) - vaultBefore, paid, "100% of the rent reached the vault");
        assertEq(vault.pendingHolders() - pendingBefore, paid / 2, "half of it belongs to holders");
        _assertSolvent();
    }

    function test_CreateGroup_RequiresActivation() public {
        vm.prank(bob); // never activated
        vm.expectRevert(GroupRegistry.NotActivated.selector);
        groupRegistry.createGroup(ROOM, ROOT, 1);
    }

    function test_CreateGroup_RejectsZeroIdDuplicateAndBadMonths() public {
        vm.prank(alice);
        vm.expectRevert(GroupRegistry.InvalidGroup.selector);
        groupRegistry.createGroup(bytes32(0), ROOT, 1);

        _createRoom(alice, ROOM, 1);
        _fund(alice, RENT_1MO);
        vm.startPrank(alice);
        token.approve(address(groupRegistry), RENT_1MO);
        vm.expectRevert(GroupRegistry.GroupExists.selector);
        groupRegistry.createGroup(ROOM, ROOT, 1);

        vm.expectRevert(GroupRegistry.InvalidMonths.selector);
        groupRegistry.createGroup(keccak256("other"), ROOT, 0);
        vm.expectRevert(GroupRegistry.InvalidMonths.selector);
        groupRegistry.createGroup(keccak256("other"), ROOT, 25);
        vm.stopPrank();
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Rent
    // ─────────────────────────────────────────────────────────────────────────────

    function test_PayRent_EarlyPaymentExtendsAndNeverBurns() public {
        _createRoom(alice, ROOM, 1);
        uint64 before = _paidUntil(ROOM);

        // Pay 2 more months on day one: paidUntil moves out by exactly 60 days.
        _payRent(alice, ROOM, 2);
        assertEq(_paidUntil(ROOM), before + 2 * 30 days, "early rent stacks on the end, never on now");
    }

    function test_PayRent_AnyoneMayPayWithoutGainingControl() public {
        _createRoom(alice, ROOM, 1);

        // bob — not the admin, not even activated — keeps the room alive.
        uint256 paid = groupRegistry.quoteRent(1);
        _fund(bob, paid);
        vm.startPrank(bob);
        token.approve(address(groupRegistry), paid);
        vm.expectEmit(true, true, false, true, address(groupRegistry));
        emit RentPaid(ROOM, bob, 1, paid, _paidUntil(ROOM) + 30 days);
        groupRegistry.payRent(ROOM, 1);
        vm.stopPrank();

        assertEq(_adminOf(ROOM), alice, "paying rent grants no control");
        _assertSolvent();
    }

    function test_PayRent_RevivingALapsedRoomStartsFromNow() public {
        _createRoom(alice, ROOM, 1);

        _warpForward(90 days); // lapsed 60 days ago
        assertFalse(groupRegistry.isActive(ROOM), "rent lapsed");

        _payRent(alice, ROOM, 1);
        assertEq(_paidUntil(ROOM), uint64(_timestamp() + 30 days), "revival starts from now, not from the lapse");
        assertTrue(groupRegistry.isActive(ROOM));
    }

    function test_PayRent_UnknownRoomReverts() public {
        vm.prank(alice);
        vm.expectRevert(GroupRegistry.UnknownGroup.selector);
        groupRegistry.payRent(keccak256("ghost"), 1);
    }

    function test_IsActive_FlipsExactlyAtPaidUntil() public {
        _createRoom(alice, ROOM, 1);
        uint64 paidUntil = _paidUntil(ROOM);

        vm.warp(uint256(paidUntil) - 1);
        assertTrue(groupRegistry.isActive(ROOM), "one second before lapse");

        vm.warp(uint256(paidUntil));
        assertFalse(groupRegistry.isActive(ROOM), "inactive the exact second rent runs out");
    }

    function test_PreviewPaidUntil_MatchesReality() public {
        _createRoom(alice, ROOM, 2);
        uint64 preview = groupRegistry.previewPaidUntil(ROOM, 5);
        _payRent(alice, ROOM, 5);
        assertEq(_paidUntil(ROOM), preview);

        vm.expectRevert(GroupRegistry.UnknownGroup.selector);
        groupRegistry.previewPaidUntil(keccak256("ghost"), 1);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Auto-renew
    // ─────────────────────────────────────────────────────────────────────────────

    function test_RenewFor_KeeperRenewsFromAdminAllowance() public {
        _createRoom(alice, ROOM, 1);

        vm.prank(alice);
        groupRegistry.setAutoRenew(ROOM, true);

        // The admin parks an allowance; the keeper fires inside the window.
        _fund(alice, RENT_1MO);
        vm.prank(alice);
        token.approve(address(groupRegistry), RENT_1MO);

        uint64 before = _paidUntil(ROOM);
        vm.warp(uint256(before) - 2 days); // inside RENEW_WINDOW

        vm.prank(keeper);
        groupRegistry.renewFor(ROOM);

        assertEq(_paidUntil(ROOM), before + 30 days, "exactly one month, extended from the old expiry");
        assertEq(token.balanceOf(alice), 0, "funded by the admin, not the keeper");
        _assertSolvent();
    }

    function test_RenewFor_GuardsFireInOrder() public {
        _createRoom(alice, ROOM, 1);

        vm.prank(keeper);
        vm.expectRevert(GroupRegistry.AutoRenewOff.selector);
        groupRegistry.renewFor(ROOM);

        vm.prank(alice);
        groupRegistry.setAutoRenew(ROOM, true);

        vm.prank(keeper);
        vm.expectRevert(GroupRegistry.NotDue.selector);
        groupRegistry.renewFor(ROOM); // 30 days out — far outside the 3-day window

        vm.warp(uint256(_paidUntil(ROOM)) - 3 days);
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientAllowance.selector, address(groupRegistry), 0, RENT_1MO
            )
        );
        groupRegistry.renewFor(ROOM); // due, but the admin never approved — money cannot move

        vm.prank(keeper);
        vm.expectRevert(GroupRegistry.UnknownGroup.selector);
        groupRegistry.renewFor(keccak256("ghost"));
    }

    function test_SetAutoRenew_AdminOnly() public {
        _createRoom(alice, ROOM, 1);

        vm.prank(bob);
        vm.expectRevert(GroupRegistry.NotAdmin.selector);
        groupRegistry.setAutoRenew(ROOM, true);

        vm.expectEmit(true, false, false, true, address(groupRegistry));
        emit AutoRenewSet(ROOM, true);
        vm.prank(alice);
        groupRegistry.setAutoRenew(ROOM, true);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Administration survives lapse
    // ─────────────────────────────────────────────────────────────────────────────

    function test_RotateEpoch_WorksWhileLapsed() public {
        _createRoom(alice, ROOM, 1);
        _warpForward(60 days);
        assertFalse(groupRegistry.isActive(ROOM));

        bytes32 newRoot = keccak256("root.v1");
        vm.expectEmit(true, false, false, true, address(groupRegistry));
        emit EpochRotated(ROOM, 1, newRoot, uint64(_timestamp()));
        vm.prank(alice);
        groupRegistry.rotateEpoch(ROOM, newRoot);

        (, uint32 epoch,, bytes32 root,,,) = groupRegistry.groups(ROOM);
        assertEq(epoch, 1);
        assertEq(root, newRoot);

        vm.prank(bob);
        vm.expectRevert(GroupRegistry.NotAdmin.selector);
        groupRegistry.rotateEpoch(ROOM, newRoot);
    }

    function test_TransferAdmin_WorksWhileLapsedAndKillsAutoRenew() public {
        _createRoom(alice, ROOM, 1);
        vm.prank(alice);
        groupRegistry.setAutoRenew(ROOM, true);

        _warpForward(60 days); // lapsed

        vm.expectEmit(true, true, true, false, address(groupRegistry));
        emit AdminTransferred(ROOM, alice, bob);
        vm.prank(alice);
        groupRegistry.transferAdmin(ROOM, bob);

        assertEq(_adminOf(ROOM), bob);
        (,,,,, bool autoRenew,) = groupRegistry.groups(ROOM);
        assertFalse(autoRenew, "the outgoing admin's allowance can never fund the new admin's room");

        vm.prank(alice);
        vm.expectRevert(GroupRegistry.NotAdmin.selector);
        groupRegistry.transferAdmin(ROOM, alice);

        vm.prank(bob);
        vm.expectRevert(GroupRegistry.ZeroAddress.selector);
        groupRegistry.transferAdmin(ROOM, address(0));
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Owner
    // ─────────────────────────────────────────────────────────────────────────────

    function test_GrantRent_ExtendsWithoutPayment() public {
        _createRoom(alice, ROOM, 1);
        uint64 before = _paidUntil(ROOM);
        uint256 vaultBefore = token.balanceOf(address(vault));

        vm.expectEmit(true, false, false, true, address(groupRegistry));
        emit RentGranted(ROOM, 6, before + 6 * 30 days);
        vm.prank(owner);
        groupRegistry.grantRent(ROOM, 6);

        assertEq(_paidUntil(ROOM), before + 6 * 30 days);
        assertEq(token.balanceOf(address(vault)), vaultBefore, "a grant never touches the vault");

        vm.prank(owner);
        vm.expectRevert(GroupRegistry.UnknownGroup.selector);
        groupRegistry.grantRent(keccak256("ghost"), 1);
    }

    function test_SetRentUsdPerMonth_ChangesQuotes() public {
        vm.prank(owner);
        groupRegistry.setRentUsdPerMonth(25e18);
        assertEq(groupRegistry.quoteRent(1), 25_000e18, "a $25 month at 1,000 $THOOD per dollar");

        vm.prank(owner);
        vm.expectRevert(GroupRegistry.InvalidPrice.selector);
        groupRegistry.setRentUsdPerMonth(0);
    }

    function test_AccessControl_OwnerOnlySetters() public {
        bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice);

        vm.startPrank(alice);
        vm.expectRevert(err);
        groupRegistry.setRentUsdPerMonth(1e18);
        vm.expectRevert(err);
        groupRegistry.setActivation(alice);
        vm.expectRevert(err);
        groupRegistry.setPriceSource(alice);
        vm.expectRevert(err);
        groupRegistry.setVault(alice);
        vm.expectRevert(err);
        groupRegistry.grantRent(ROOM, 1);
        vm.stopPrank();
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Fuzz
    // ─────────────────────────────────────────────────────────────────────────────

    function testFuzz_RentQuoteIsLinearInMonths(uint8 months) public view {
        months = uint8(bound(months, 1, 24));
        assertEq(groupRegistry.quoteRent(months), uint256(months) * RENT_1MO);
    }

    function testFuzz_QuoteRentRejectsBadMonths(uint8 months) public {
        vm.assume(months == 0 || months > 24);
        vm.expectRevert(GroupRegistry.InvalidMonths.selector);
        groupRegistry.quoteRent(months);
    }
}
