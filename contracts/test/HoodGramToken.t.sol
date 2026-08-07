// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {Fixture} from "./utils/Fixture.sol";
import {HoodGramToken} from "../src/HoodGramToken.sol";

/**
 * @title HoodGramTokenTest
 * @notice Supply, permit and — critically — historical balance checkpoints.
 *
 * @dev The checkpoints are what let {RevenueVault} pay holders without anyone staking. If
 *      `balanceOfAt` were wrong by a single block the revenue split would silently pay the wrong
 *      people, so the multi-block sequences below are asserted at every historical block, not just
 *      the endpoints.
 */
contract HoodGramTokenTest is Fixture {
    function setUp() public {
        _deployProtocol();
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Supply
    // ─────────────────────────────────────────────────────────────────────────────

    function test_Metadata() public view {
        assertEq(token.name(), "HoodGram");
        assertEq(token.symbol(), "THOOD");
        assertEq(token.decimals(), 18);
    }

    function test_MaxSupplyMintedToTreasury() public view {
        assertEq(token.MAX_SUPPLY(), 1_000_000_000e18);
        assertEq(token.totalSupply(), 1_000_000_000e18);
        assertEq(token.balanceOf(treasury), 1_000_000_000e18);
    }

    function test_Constructor_RevertsOnZeroTreasury() public {
        vm.expectRevert(HoodGramToken.ZeroAddress.selector);
        new HoodGramToken(address(0));
    }

    function test_SupplyIsFixedAcrossActivity() public {
        _fund(alice, 1_000e18);
        vm.prank(alice);
        token.transfer(bob, 400e18);
        assertEq(token.totalSupply(), token.MAX_SUPPLY());
        assertEq(token.balanceOf(alice), 600e18);
        assertEq(token.balanceOf(bob), 400e18);
    }

    function test_TransferFromRespectsAllowance() public {
        _fund(alice, 1_000e18);
        vm.prank(alice);
        token.approve(bob, 250e18);

        vm.prank(bob);
        token.transferFrom(alice, carol, 250e18);
        assertEq(token.balanceOf(carol), 250e18);
        assertEq(token.allowance(alice, bob), 0);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, bob, 0, 1));
        token.transferFrom(alice, carol, 1);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Permit
    // ─────────────────────────────────────────────────────────────────────────────

    function test_Permit_SetsAllowanceAndBumpsNonce() public {
        (address signer, uint256 pk) = makeAddrAndKey("permitSigner");
        uint256 value = 12_345e18;
        uint256 deadline = _timestamp() + 1 hours;

        assertEq(token.nonces(signer), 0);
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(pk, signer, address(activation), value, deadline);

        token.permit(signer, address(activation), value, deadline, v, r, s);

        assertEq(token.allowance(signer, address(activation)), value);
        assertEq(token.nonces(signer), 1);
    }

    function test_Permit_RevertsOnExpiredDeadline() public {
        (address signer, uint256 pk) = makeAddrAndKey("permitSigner");
        uint256 deadline = _timestamp() - 1;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(pk, signer, address(activation), 1e18, deadline);

        vm.expectRevert(abi.encodeWithSelector(ERC20Permit.ERC2612ExpiredSignature.selector, deadline));
        token.permit(signer, address(activation), 1e18, deadline, v, r, s);
    }

    function test_Permit_RevertsOnReplay() public {
        (address signer, uint256 pk) = makeAddrAndKey("permitSigner");
        uint256 deadline = _timestamp() + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(pk, signer, address(activation), 1e18, deadline);

        token.permit(signer, address(activation), 1e18, deadline, v, r, s);
        vm.expectRevert();
        token.permit(signer, address(activation), 1e18, deadline, v, r, s);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Checkpoints
    // ─────────────────────────────────────────────────────────────────────────────

    function test_BalanceOfAt_MultiBlockTransferSequence() public {
        uint48 b0 = uint48(_blockNumber());

        _fund(alice, 1_000e18); // block b0
        _rollForward(1);
        uint48 b1 = uint48(_blockNumber());

        vm.prank(alice);
        token.transfer(bob, 300e18); // block b1
        _rollForward(5);
        uint48 b2 = uint48(_blockNumber());

        vm.prank(bob);
        token.transfer(carol, 100e18); // block b2
        _rollForward(3);
        uint48 b3 = uint48(_blockNumber());

        vm.prank(alice);
        token.transfer(carol, 700e18); // block b3 — alice now empty
        _rollForward(1);

        // alice
        assertEq(token.balanceOfAt(alice, b0), 1_000e18, "alice@b0");
        assertEq(token.balanceOfAt(alice, b1), 700e18, "alice@b1");
        assertEq(token.balanceOfAt(alice, b1 + 1), 700e18, "alice@b1+1 (no checkpoint, carries)");
        assertEq(token.balanceOfAt(alice, b2), 700e18, "alice@b2");
        assertEq(token.balanceOfAt(alice, b3), 0, "alice@b3");

        // bob
        assertEq(token.balanceOfAt(bob, b0), 0, "bob@b0");
        assertEq(token.balanceOfAt(bob, b1), 300e18, "bob@b1");
        assertEq(token.balanceOfAt(bob, b2), 200e18, "bob@b2");
        assertEq(token.balanceOfAt(bob, b3), 200e18, "bob@b3");

        // carol
        assertEq(token.balanceOfAt(carol, b1), 0, "carol@b1");
        assertEq(token.balanceOfAt(carol, b2), 100e18, "carol@b2");
        assertEq(token.balanceOfAt(carol, b3), 800e18, "carol@b3");

        // live balances agree with the last checkpoint
        assertEq(token.balanceOf(alice), token.balanceOfAt(alice, b3));
        assertEq(token.balanceOf(bob), token.balanceOfAt(bob, b3));
        assertEq(token.balanceOf(carol), token.balanceOfAt(carol, b3));
    }

    function test_BalanceOfAt_SameBlockTransfersCollapseToEndOfBlock() public {
        _fund(alice, 1_000e18);
        _rollForward(1);
        uint48 b = uint48(_blockNumber());

        uint256 before = token.balanceCheckpointCount(alice);

        vm.startPrank(alice);
        token.transfer(bob, 100e18);
        token.transfer(bob, 100e18);
        token.transfer(bob, 100e18);
        vm.stopPrank();

        _rollForward(1);

        // Three transfers in one block => exactly one new checkpoint, holding the END-of-block value.
        assertEq(token.balanceCheckpointCount(alice), before + 1, "collapsed to one checkpoint");
        assertEq(token.balanceOfAt(alice, b), 700e18);
        assertEq(token.balanceOfAt(bob, b), 300e18);
    }

    function test_BalanceOfAt_ZeroBeforeAnyActivity() public {
        uint48 b = uint48(_blockNumber());
        _rollForward(1);
        assertEq(token.balanceOfAt(alice, b), 0);
        assertEq(token.balanceOfAt(makeAddr("never"), b), 0);
    }

    function test_BalanceOfAt_SelfTransferIsANoOp() public {
        _fund(alice, 500e18);
        _rollForward(1);
        vm.prank(alice);
        token.transfer(alice, 500e18);
        uint48 b = uint48(_blockNumber());
        _rollForward(1);
        assertEq(token.balanceOfAt(alice, b), 500e18);
    }

    function test_TotalSupplyAt() public {
        uint48 mintBlock = uint48(START_BLOCK);
        assertEq(token.totalSupplyAt(mintBlock), token.MAX_SUPPLY());

        // No mint or burn path exists, so supply is flat forever.
        _fund(alice, 1e18);
        _rollForward(10);
        assertEq(token.totalSupplyAt(uint48(_blockNumber() - 1)), token.MAX_SUPPLY());
        assertEq(token.totalSupplyAt(mintBlock), token.MAX_SUPPLY());
    }

    function test_TotalSupplyAt_ZeroBeforeMintBlock() public view {
        assertEq(token.totalSupplyAt(uint48(START_BLOCK - 1)), 0);
    }

    function test_FutureLookup_BalanceOfAt() public {
        vm.expectRevert(HoodGramToken.FutureLookup.selector);
        token.balanceOfAt(alice, uint48(_blockNumber()));

        vm.expectRevert(HoodGramToken.FutureLookup.selector);
        token.balanceOfAt(alice, uint48(_blockNumber() + 1));

        vm.expectRevert(HoodGramToken.FutureLookup.selector);
        token.balanceOfAt(alice, type(uint48).max);
    }

    function test_FutureLookup_TotalSupplyAt() public {
        vm.expectRevert(HoodGramToken.FutureLookup.selector);
        token.totalSupplyAt(uint48(_blockNumber()));

        vm.expectRevert(HoodGramToken.FutureLookup.selector);
        token.totalSupplyAt(uint48(_blockNumber() + 1));
    }

    function test_CheckpointCounts() public {
        assertEq(token.totalSupplyCheckpointCount(), 1, "one mint checkpoint");
        assertEq(token.balanceCheckpointCount(treasury), 1);
        assertEq(token.balanceCheckpointCount(alice), 0);

        _fund(alice, 1e18);
        _rollForward(1);
        _fund(alice, 1e18);

        assertEq(token.balanceCheckpointCount(alice), 2);
        assertEq(token.balanceCheckpointCount(treasury), 3);
        assertEq(token.totalSupplyCheckpointCount(), 1, "still only the mint");
    }

    function testFuzz_BalanceOfAtMatchesHistory(uint96 first, uint96 second) public {
        uint256 a = bound(uint256(first), 1e18, 1_000_000e18);
        uint256 b = bound(uint256(second), 1e18, 1_000_000e18);

        _fund(alice, a + b);
        uint48 b0 = uint48(_blockNumber());
        _rollForward(1);

        vm.prank(alice);
        token.transfer(bob, b);
        uint48 b1 = uint48(_blockNumber());
        _rollForward(1);

        assertEq(token.balanceOfAt(alice, b0), a + b);
        assertEq(token.balanceOfAt(bob, b0), 0);
        assertEq(token.balanceOfAt(alice, b1), a);
        assertEq(token.balanceOfAt(bob, b1), b);
        assertEq(token.balanceOfAt(alice, b1) + token.balanceOfAt(bob, b1), a + b);
    }
}
