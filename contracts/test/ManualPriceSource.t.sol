// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {Fixture} from "./utils/Fixture.sol";
import {ManualPriceSource} from "../src/ManualPriceSource.sol";

/**
 * @title ManualPriceSourceTest
 * @notice The USD to $THOOD conversion behind every quote. A zero rate would make every purchase
 *         free, so it is rejected everywhere.
 */
contract ManualPriceSourceTest is Fixture {
    event RateSet(uint256 oldRate, uint256 newRate);

    function setUp() public {
        _deployProtocol();
    }

    function test_Constructor_SetsRateAndOwner() public view {
        assertEq(priceSource.rate(), INITIAL_RATE);
        assertEq(priceSource.thoodPerUsd(), INITIAL_RATE);
        assertEq(priceSource.owner(), owner);
    }

    function test_Constructor_EmitsRateSet() public {
        vm.expectEmit(false, false, false, true);
        emit RateSet(0, 5e18);
        new ManualPriceSource(owner, 5e18);
    }

    function test_Constructor_RejectsZeroRate() public {
        vm.expectRevert(ManualPriceSource.InvalidRate.selector);
        new ManualPriceSource(owner, 0);
    }

    function test_SetRate_UpdatesAndEmits() public {
        vm.expectEmit(false, false, false, true, address(priceSource));
        emit RateSet(INITIAL_RATE, 42e18);
        vm.prank(owner);
        priceSource.setRate(42e18);

        assertEq(priceSource.rate(), 42e18);
        assertEq(priceSource.thoodPerUsd(), 42e18);
    }

    function test_SetRate_RejectsZero() public {
        vm.prank(owner);
        vm.expectRevert(ManualPriceSource.InvalidRate.selector);
        priceSource.setRate(0);
        assertEq(priceSource.rate(), INITIAL_RATE, "the old rate survives a rejected update");
    }

    function test_SetRate_OnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        priceSource.setRate(1e18);
    }

    function test_RateFeedsQuotesDirectly() public {
        assertEq(activation.quote(), 5e18 * INITIAL_RATE / 1e18);
        assertEq(groupRegistry.quoteRent(1), 10e18 * INITIAL_RATE / 1e18);

        vm.prank(owner);
        priceSource.setRate(2e18); // 2 $THOOD per dollar — the token mooned
        assertEq(activation.quote(), 10e18, "a $5 activation now costs 10 $THOOD");
        assertEq(groupRegistry.quoteRent(1), 20e18, "a $10 month of rent now costs 20 $THOOD");
        assertEq(groupRegistry.quoteRent(12), 240e18);
    }

    function testFuzz_RateRoundTrips(uint256 rate) public {
        rate = bound(rate, 1, type(uint128).max);
        vm.prank(owner);
        priceSource.setRate(rate);
        assertEq(priceSource.thoodPerUsd(), rate);
        assertEq(activation.quote(), 5e18 * rate / 1e18);
    }
}
