// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";

import {HoodGramToken} from "../src/HoodGramToken.sol";
import {ManualPriceSource} from "../src/ManualPriceSource.sol";
import {RevenueVault} from "../src/RevenueVault.sol";
import {Activation} from "../src/Activation.sol";
import {GroupRegistry} from "../src/GroupRegistry.sol";
import {Perks} from "../src/Perks.sol";

/**
 * @title TokenSwapTest
 * @notice Pins the settable-once token binding that makes the launch plan possible: stand the
 *         protocol up against a test token, then point it at the real $GRAM with `setToken` and
 *         freeze it with `lockToken` — no redeploy, no lost activations, no lost rooms.
 */
contract TokenSwapTest is Test {
    address internal constant OWNER = address(0xA11CE);
    address internal constant TREASURY = address(0xBEEF);
    address internal constant USER = address(0xCAFE);

    HoodGramToken internal tokenA;
    HoodGramToken internal tokenB;
    ManualPriceSource internal price;
    RevenueVault internal vault;
    Activation internal activation;
    GroupRegistry internal registry;
    Perks internal perks;

    function setUp() public {
        tokenA = new HoodGramToken(TREASURY);
        tokenB = new HoodGramToken(TREASURY);
        price = new ManualPriceSource(OWNER, 1000e18);
        vault = new RevenueVault(OWNER, address(tokenA), TREASURY);
        activation = new Activation(OWNER, address(tokenA), address(price), address(vault));
        registry = new GroupRegistry(OWNER, address(tokenA), address(activation), address(price), address(vault));
        perks = new Perks(OWNER, address(tokenA), address(vault));

        vm.startPrank(OWNER);
        vault.setNotifier(address(activation), true);
        vault.setNotifier(address(registry), true);
        vault.setExcluded(TREASURY, true);
        vault.setExcluded(address(vault), true);
        vm.stopPrank();
    }

    /* ─────────────────────────────────────────────────────── the swap ───── */

    function test_setToken_swapsEveryBinding() public {
        vm.startPrank(OWNER);
        activation.setToken(address(tokenB));
        registry.setToken(address(tokenB));
        perks.setToken(address(tokenB));
        vault.setToken(address(tokenB));
        vm.stopPrank();

        assertEq(address(activation.THOOD()), address(tokenB));
        assertEq(address(registry.THOOD()), address(tokenB));
        assertEq(address(perks.THOOD()), address(tokenB));
        assertEq(address(perks.CHECKPOINTS()), address(tokenB));
        assertEq(address(vault.THOOD()), address(tokenB));
        assertEq(address(vault.CHECKPOINTS()), address(tokenB));
    }

    /// @dev The launch-day property itself: activations paid in the old token survive the swap,
    ///      rehearsal-era vault money is flushed to the treasury, and the next payer pays in the
    ///      new token. The vault swaps FIRST — it is the contract the others pay into.
    function test_setToken_preservesActivations() public {
        // USER activates while tokenA is the payment token.
        uint256 quote = activation.quote();
        vm.prank(TREASURY);
        tokenA.transfer(USER, quote);
        vm.startPrank(USER);
        tokenA.approve(address(activation), quote);
        activation.activate();
        vm.stopPrank();
        assertTrue(activation.isActivated(USER));
        assertEq(tokenA.balanceOf(address(vault)), quote);

        // Launch day: swap all four, vault first. The old-token accruals leave for the treasury.
        uint256 treasuryBefore = tokenA.balanceOf(TREASURY);
        vm.startPrank(OWNER);
        vault.setToken(address(tokenB));
        activation.setToken(address(tokenB));
        registry.setToken(address(tokenB));
        perks.setToken(address(tokenB));
        vm.stopPrank();

        assertTrue(activation.isActivated(USER));
        assertEq(tokenA.balanceOf(address(vault)), 0);
        assertEq(tokenA.balanceOf(TREASURY), treasuryBefore + quote);
        assertEq(vault.pendingHolders(), 0);
        assertEq(vault.treasuryAccrued(), 0);

        // And the next payer pays in tokenB, splitting cleanly in the new currency.
        address second = address(0xD00D);
        uint256 quote2 = activation.quote();
        vm.prank(TREASURY);
        tokenB.transfer(second, quote2);
        vm.startPrank(second);
        tokenB.approve(address(activation), quote2);
        activation.activate();
        vm.stopPrank();
        assertTrue(activation.isActivated(second));
        assertEq(tokenB.balanceOf(address(vault)), quote2);
        assertTrue(vault.isSolvent());
    }

    /* ─────────────────────────────────────────────────────── the lock ───── */

    function test_lockToken_freezesForever() public {
        vm.startPrank(OWNER);
        activation.lockToken();
        vm.expectRevert(Activation.TokenIsLocked.selector);
        activation.setToken(address(tokenB));

        registry.lockToken();
        vm.expectRevert(GroupRegistry.TokenIsLocked.selector);
        registry.setToken(address(tokenB));

        perks.lockToken();
        vm.expectRevert(Perks.TokenIsLocked.selector);
        perks.setToken(address(tokenB));

        vault.lockToken();
        vm.expectRevert(RevenueVault.TokenIsLocked.selector);
        vault.setToken(address(tokenB));
        vm.stopPrank();
    }

    function test_setToken_onlyOwner() public {
        vm.expectRevert();
        activation.setToken(address(tokenB));
        vm.expectRevert();
        vault.setToken(address(tokenB));
    }

    function test_setToken_rejectsZero() public {
        vm.startPrank(OWNER);
        vm.expectRevert(Activation.ZeroAddress.selector);
        activation.setToken(address(0));
        vm.expectRevert(RevenueVault.ZeroAddress.selector);
        vault.setToken(address(0));
        vm.stopPrank();
    }

    /* ───────────────────────────────────────── the vault's swap gate ────── */

    function test_vaultSetToken_flushesRehearsalMoneyToTreasury() public {
        // A payment accrues in both buckets and is never sealed — the rehearsal-era state.
        uint256 quote = activation.quote();
        vm.prank(TREASURY);
        tokenA.transfer(USER, quote);
        vm.startPrank(USER);
        tokenA.approve(address(activation), quote);
        activation.activate();
        vm.stopPrank();
        assertGt(vault.pendingHolders() + vault.treasuryAccrued(), 0);

        uint256 treasuryBefore = tokenA.balanceOf(TREASURY);
        vm.prank(OWNER);
        vault.setToken(address(tokenB));

        // Every old-token cent left for the treasury; the new token starts from zero obligations.
        assertEq(tokenA.balanceOf(TREASURY), treasuryBefore + quote);
        assertEq(vault.totalObligations(), 0);
        assertTrue(vault.isSolvent());
    }

    function test_vaultSetToken_refusedOnceEpochSealed() public {
        // USER pays AND keeps a balance, so the seal finds eligible supply and creates an epoch.
        uint256 quote = activation.quote();
        vm.prank(TREASURY);
        tokenA.transfer(USER, quote * 2);
        vm.startPrank(USER);
        tokenA.approve(address(activation), quote);
        activation.activate();
        vm.stopPrank();

        vm.warp(block.timestamp + 7 days);
        vm.roll(block.number + 1);
        vault.sealEpoch();
        assertEq(vault.epochCount(), 1);

        // A sealed epoch prices its claims off tokenA history forever: the binding is final.
        vm.prank(OWNER);
        vm.expectRevert(RevenueVault.VaultNotEmpty.selector);
        vault.setToken(address(tokenB));
    }

    /* ──────────────────────────────────────────────── perks after swap ───── */

    function test_perks_judgeByNewTokenAfterSwap() public {
        // USER holds 0.05% of tokenB and nothing of tokenA.
        uint256 tierOne = (tokenB.totalSupply() * 5) / 10_000;
        vm.prank(TREASURY);
        tokenB.transfer(USER, tierOne);

        assertEq(perks.tierOf(USER), 0);
        vm.prank(OWNER);
        perks.setToken(address(tokenB));
        assertEq(perks.tierOf(USER), 1);
    }
}
