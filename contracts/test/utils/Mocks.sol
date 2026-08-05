// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {ICheckpointToken, IPriceSource} from "../../src/interfaces/ITeleHood.sol";
import {RevenueVault} from "../../src/RevenueVault.sol";

/// @notice Callback a {HookToken} fires on its configured hook address after every credit.
interface IReentrancyHook {
    function onTokenReceived() external;
}

/**
 * @title HookToken
 * @notice A checkpointed ERC20 that calls back into the recipient on transfer.
 * @dev $THOOD itself has no transfer hooks, so it offers no reentrancy surface. This token exists
 *      purely to *create* one, so that {RevenueVault.claim}'s `nonReentrant` guard can be proven to
 *      actually stop a re-entrant claim of a DIFFERENT epoch — the one case `hasClaimed` alone
 *      would not catch.
 */
contract HookToken is ERC20, ICheckpointToken {
    using Checkpoints for Checkpoints.Trace208;

    error FutureLookup();

    mapping(address account => Checkpoints.Trace208 history) private _balanceCheckpoints;
    Checkpoints.Trace208 private _totalSupplyCheckpoints;

    /// @notice The address that receives the reentrancy callback.
    address public hook;

    constructor() ERC20("HookToken", "HOOK") {}

    /// @notice Mints test supply.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Arms the callback on `h`.
    function setHook(address h) external {
        hook = h;
    }

    /// @inheritdoc ICheckpointToken
    function balanceOfAt(address account, uint48 timepoint) external view returns (uint256) {
        if (timepoint >= block.number) revert FutureLookup();
        return uint256(_balanceCheckpoints[account].upperLookupRecent(timepoint));
    }

    /// @inheritdoc ICheckpointToken
    function totalSupplyAt(uint48 timepoint) external view returns (uint256) {
        if (timepoint >= block.number) revert FutureLookup();
        return uint256(_totalSupplyCheckpoints.upperLookupRecent(timepoint));
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);

        uint48 key = SafeCast.toUint48(block.number);
        if (from == address(0) || to == address(0)) {
            _totalSupplyCheckpoints.push(key, SafeCast.toUint208(totalSupply()));
        }
        if (from != address(0)) {
            _balanceCheckpoints[from].push(key, SafeCast.toUint208(balanceOf(from)));
        }
        if (to != address(0)) {
            _balanceCheckpoints[to].push(key, SafeCast.toUint208(balanceOf(to)));
        }

        address h = hook;
        if (h != address(0) && to == h) {
            IReentrancyHook(h).onTokenReceived();
        }
    }
}

/**
 * @title ReentrantClaimer
 * @notice Holds {HookToken}, claims one epoch, and tries to re-enter {RevenueVault.claim} for a
 *         second epoch from inside the payout transfer.
 */
contract ReentrantClaimer is IReentrancyHook {
    RevenueVault public immutable VAULT;

    uint256 public secondEpoch;
    bool public armed;
    bool public reentryBlocked;
    bool public reentrySucceeded;
    uint256 public reentryAmount;

    constructor(RevenueVault vault_) {
        VAULT = vault_;
    }

    /// @notice Claims `firstEpoch`, attempting to re-enter for `secondEpoch_` mid-transfer.
    function attack(uint256 firstEpoch, uint256 secondEpoch_) external returns (uint256) {
        secondEpoch = secondEpoch_;
        armed = true;
        uint256 got = VAULT.claim(firstEpoch);
        armed = false;
        return got;
    }

    /// @inheritdoc IReentrancyHook
    function onTokenReceived() external {
        if (!armed) return;
        armed = false;
        try VAULT.claim(secondEpoch) returns (uint256 amount) {
            reentrySucceeded = true;
            reentryAmount = amount;
        } catch {
            reentryBlocked = true;
        }
    }
}

/// @notice A price source whose rate can be set freely, used to prove `setPriceSource` swaps cleanly.
contract StubPriceSource is IPriceSource {
    uint256 private _rate;

    constructor(uint256 rate_) {
        _rate = rate_;
    }

    /// @notice Sets the stub rate.
    function set(uint256 rate_) external {
        _rate = rate_;
    }

    /// @inheritdoc IPriceSource
    function thoodPerUsd() external view returns (uint256) {
        return _rate;
    }
}
