// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IPriceSource} from "./interfaces/ITeleHood.sol";

/**
 * @title ManualPriceSource
 * @notice Owner-maintained $THOOD/USD rate used to convert the on-chain USD USD prices into
 *         a $THOOD amount at purchase time.
 * @dev A Uniswap TWAP source can replace this later; {IPriceSource} exists precisely so it can be
 *      swapped in with `setPriceSource` on the paying contracts without touching any other contract.
 */
contract ManualPriceSource is IPriceSource, Ownable {
    /// @notice How many $THOOD (18dp) equal one US dollar.
    uint256 public rate;

    /// @notice Emitted whenever the rate changes, including at deployment.
    /// @param oldRate The previous rate (0 at deployment).
    /// @param newRate The rate now in force.
    event RateSet(uint256 oldRate, uint256 newRate);

    /// @notice Thrown when a rate of zero is supplied. A zero rate would make every purchase free.
    error InvalidRate();

    /**
     * @notice Deploys the price source with an initial rate.
     * @param initialOwner Address allowed to update the rate.
     * @param initialRate How many $THOOD (18dp) equal one US dollar. Must be non-zero.
     */
    constructor(address initialOwner, uint256 initialRate) Ownable(initialOwner) {
        if (initialRate == 0) revert InvalidRate();
        rate = initialRate;
        emit RateSet(0, initialRate);
    }

    /**
     * @notice Updates the $THOOD per US dollar rate.
     * @param newRate The new rate, 18dp. Must be non-zero.
     */
    function setRate(uint256 newRate) external onlyOwner {
        if (newRate == 0) revert InvalidRate();
        uint256 oldRate = rate;
        rate = newRate;
        emit RateSet(oldRate, newRate);
    }

    /// @inheritdoc IPriceSource
    function thoodPerUsd() external view returns (uint256) {
        return rate;
    }
}
