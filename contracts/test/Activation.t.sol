// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {Fixture} from "./utils/Fixture.sol";
import {Activation} from "../src/Activation.sol";
import {StubPriceSource} from "./utils/Mocks.sol";

/**
 * @title ActivationTest
 * @notice The $5 handshake: one payment, in $THOOD, and the account exists forever. 100% of every
 *         payment lands in the vault, where it is split 50/50 with holders at receipt.
 */
contract ActivationTest is Fixture {
    event Activated(address indexed user, address indexed payer, uint256 thoodPaid, uint64 at);
    event Granted(address indexed user, uint64 at);
    event PriceSet(uint256 usd18);

    /// @dev $5 at 1,000 $THOOD per dollar.
    uint256 internal constant QUOTE = 5_000e18;

    function setUp() public {
        _deployProtocol();
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Wiring
    // ─────────────────────────────────────────────────────────────────────────────

    function test_Constants() public view {
        assertEq(activation.priceUsd(), 5e18, "default price is five dollars");
        assertEq(address(activation.THOOD()), address(token));
        assertEq(address(activation.priceSource()), address(priceSource));
        assertEq(address(activation.vault()), address(vault));
        assertEq(activation.quote(), QUOTE);
    }

    function test_Constructor_RevertsOnZeroAddresses() public {
        vm.expectRevert(Activation.ZeroAddress.selector);
        new Activation(owner, address(0), address(priceSource), address(vault));
        vm.expectRevert(Activation.ZeroAddress.selector);
        new Activation(owner, address(token), address(0), address(vault));
        vm.expectRevert(Activation.ZeroAddress.selector);
        new Activation(owner, address(token), address(priceSource), address(0));
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Activate
    // ─────────────────────────────────────────────────────────────────────────────

    function test_Activate_MarksForeverAndPaysTheVault() public {
        _fund(alice, QUOTE);
        vm.startPrank(alice);
        token.approve(address(activation), QUOTE);

        vm.expectEmit(true, true, false, true, address(activation));
        emit Activated(alice, alice, QUOTE, uint64(_timestamp()));
        activation.activate();
        vm.stopPrank();

        assertTrue(activation.isActivated(alice));
        assertEq(activation.activatedAt(alice), uint64(_timestamp()));
        assertEq(token.balanceOf(alice), 0, "the exact quote was pulled");
        assertEq(token.balanceOf(address(vault)), QUOTE, "100% of the payment reached the vault");
        assertEq(vault.pendingHolders(), QUOTE / 2, "half to holders");
        assertEq(vault.treasuryAccrued(), QUOTE / 2, "half to treasury");
        _assertSolvent();

        // Forever means forever.
        _warpForward(3650 days);
        assertTrue(activation.isActivated(alice), "activation never expires");
    }

    function test_Activate_TwiceReverts() public {
        _activateUser(alice);

        _fund(alice, QUOTE);
        vm.startPrank(alice);
        token.approve(address(activation), QUOTE);
        vm.expectRevert(Activation.AlreadyActivated.selector);
        activation.activate();
        vm.stopPrank();
    }

    function test_Activate_RevertsWithoutAllowance() public {
        _fund(alice, QUOTE);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(activation), 0, QUOTE)
        );
        activation.activate();
        assertFalse(activation.isActivated(alice), "a failed payment activates nothing");
    }

    function test_Activate_RevertsWithoutBalance() public {
        vm.startPrank(alice);
        token.approve(address(activation), QUOTE);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, alice, 0, QUOTE)
        );
        activation.activate();
        vm.stopPrank();
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Sponsoring
    // ─────────────────────────────────────────────────────────────────────────────

    function test_ActivateFor_SponsorPaysRecipientIsActivated() public {
        _fund(alice, QUOTE);
        vm.startPrank(alice);
        token.approve(address(activation), QUOTE);

        vm.expectEmit(true, true, false, true, address(activation));
        emit Activated(bob, alice, QUOTE, uint64(_timestamp()));
        activation.activateFor(bob);
        vm.stopPrank();

        assertTrue(activation.isActivated(bob), "the recipient is activated");
        assertFalse(activation.isActivated(alice), "the sponsor is NOT");
        assertEq(token.balanceOf(alice), 0, "the sponsor paid");
        _assertSolvent();
    }

    function test_ActivateFor_RejectsZeroAddressAndDoubles() public {
        vm.prank(alice);
        vm.expectRevert(Activation.ZeroAddress.selector);
        activation.activateFor(address(0));

        _activateUser(bob);
        _fund(alice, QUOTE);
        vm.startPrank(alice);
        token.approve(address(activation), QUOTE);
        vm.expectRevert(Activation.AlreadyActivated.selector);
        activation.activateFor(bob);
        vm.stopPrank();
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Permit
    // ─────────────────────────────────────────────────────────────────────────────

    function test_ActivateWithPermit_SingleTransaction() public {
        (address signer, uint256 pk) = makeAddrAndKey("permit-signer");
        _fund(signer, QUOTE);

        uint256 deadline = _timestamp() + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(pk, signer, address(activation), QUOTE, deadline);

        vm.prank(signer);
        activation.activateWithPermit(QUOTE, deadline, v, r, s);

        assertTrue(activation.isActivated(signer));
        assertEq(token.balanceOf(address(vault)), QUOTE);
        _assertSolvent();
    }

    function test_ActivateWithPermit_FrontRunPermitStillSucceedsOnAllowance() public {
        (address signer, uint256 pk) = makeAddrAndKey("permit-signer");
        _fund(signer, QUOTE);

        uint256 deadline = _timestamp() + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(pk, signer, address(activation), QUOTE, deadline);

        // A griefer front-runs the permit itself. The allowance is now set...
        token.permit(signer, address(activation), QUOTE, deadline, v, r, s);

        // ...so the user's own transaction still succeeds even though its permit call reverts inside.
        vm.prank(signer);
        activation.activateWithPermit(QUOTE, deadline, v, r, s);
        assertTrue(activation.isActivated(signer));
    }

    function test_ActivateWithPermit_BadSigAndNoAllowanceReverts() public {
        (address signer,) = makeAddrAndKey("permit-signer");
        (, uint256 wrongPk) = makeAddrAndKey("wrong-signer");
        _fund(signer, QUOTE);

        uint256 deadline = _timestamp() + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(wrongPk, signer, address(activation), QUOTE, deadline);

        vm.prank(signer);
        vm.expectRevert(Activation.PermitFailed.selector);
        activation.activateWithPermit(QUOTE, deadline, v, r, s);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Owner
    // ─────────────────────────────────────────────────────────────────────────────

    function test_Grant_ActivatesWithoutPayment() public {
        vm.expectEmit(true, false, false, true, address(activation));
        emit Granted(carol, uint64(_timestamp()));
        vm.prank(owner);
        activation.grant(carol);

        assertTrue(activation.isActivated(carol));
        assertEq(token.balanceOf(address(vault)), 0, "a grant never touches the vault");

        vm.prank(owner);
        vm.expectRevert(Activation.AlreadyActivated.selector);
        activation.grant(carol);

        vm.prank(owner);
        vm.expectRevert(Activation.ZeroAddress.selector);
        activation.grant(address(0));
    }

    function test_SetPriceUsd_ChangesTheQuote() public {
        vm.expectEmit(false, false, false, true, address(activation));
        emit PriceSet(2e18);
        vm.prank(owner);
        activation.setPriceUsd(2e18);

        assertEq(activation.quote(), 2_000e18, "a $2 activation at 1,000 $THOOD per dollar");

        vm.prank(owner);
        vm.expectRevert(Activation.InvalidPrice.selector);
        activation.setPriceUsd(0);
    }

    function test_SetPriceSource_SwapsCleanly() public {
        StubPriceSource stub = new StubPriceSource(10e18);
        vm.prank(owner);
        activation.setPriceSource(address(stub));
        assertEq(activation.quote(), 50e18, "$5 at 10 $THOOD per dollar");

        vm.prank(owner);
        vm.expectRevert(Activation.ZeroAddress.selector);
        activation.setPriceSource(address(0));
    }

    function test_AccessControl_OwnerOnlySetters() public {
        bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice);

        vm.startPrank(alice);
        vm.expectRevert(err);
        activation.setPriceUsd(1e18);
        vm.expectRevert(err);
        activation.setPriceSource(alice);
        vm.expectRevert(err);
        activation.setVault(alice);
        vm.expectRevert(err);
        activation.grant(alice);
        vm.stopPrank();
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Fuzz
    // ─────────────────────────────────────────────────────────────────────────────

    function testFuzz_QuoteTracksPriceAndRate(uint256 usd, uint256 rate) public {
        usd = bound(usd, 1, 1_000_000e18);
        rate = bound(rate, 1, type(uint96).max);

        vm.startPrank(owner);
        activation.setPriceUsd(usd);
        priceSource.setRate(rate);
        vm.stopPrank();

        assertEq(activation.quote(), usd * rate / 1e18);
    }
}
