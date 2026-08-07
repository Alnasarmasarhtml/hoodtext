// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {ICheckpointToken} from "./interfaces/IHoodGram.sol";

/**
 * @title HoodGramToken
 * @notice $THOOD — the HoodGram token. Fixed supply, no tax, no blacklist, no owner, no pause.
 *
 * @dev Every transfer writes a checkpoint of the sender's and receiver's RAW BALANCE, keyed by block
 *      number. This is what lets {RevenueVault} pay holders pro-rata by holdings without anyone
 *      staking, locking, depositing or delegating: holding $THOOD in your own wallet at the moment an
 *      epoch is snapshotted is the entire requirement.
 *
 *      Deliberately NOT `ERC20Votes`. Votes checkpoints track *delegated* voting units, which are
 *      zero for every holder who never called `delegate()`. Paying revenue off votes checkpoints
 *      would silently pay nothing to the overwhelming majority of holders. Balance checkpoints,
 *      always.
 */
contract HoodGramToken is ERC20, ERC20Permit, ICheckpointToken {
    using Checkpoints for Checkpoints.Trace208;

    /// @notice The entire supply, minted once at deployment. There is no mint path afterwards.
    uint256 public constant MAX_SUPPLY = 1_000_000_000e18;

    /// @notice Thrown when the treasury address given to the constructor is the zero address.
    error ZeroAddress();

    /// @notice Thrown when a historical lookup targets the current block or any future block.
    error FutureLookup();

    /// @dev Per-account history of raw balances, keyed by `uint48(block.number)`.
    mapping(address account => Checkpoints.Trace208 history) private _balanceCheckpoints;

    /// @dev History of `totalSupply()`, keyed by `uint48(block.number)`.
    Checkpoints.Trace208 private _totalSupplyCheckpoints;

    /**
     * @notice Deploys $THOOD and mints the whole supply to `treasury`.
     * @param treasury Recipient of the full {MAX_SUPPLY}.
     */
    constructor(address treasury) ERC20("HoodGram", "THOOD") ERC20Permit("HoodGram") {
        if (treasury == address(0)) revert ZeroAddress();
        _mint(treasury, MAX_SUPPLY);
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

    /**
     * @notice Number of balance checkpoints recorded for `account`.
     * @param account The address to inspect.
     * @return The checkpoint count (useful for indexers and tests).
     */
    function balanceCheckpointCount(address account) external view returns (uint256) {
        return _balanceCheckpoints[account].length();
    }

    /**
     * @notice Number of total-supply checkpoints recorded.
     * @return The checkpoint count.
     */
    function totalSupplyCheckpointCount() external view returns (uint256) {
        return _totalSupplyCheckpoints.length();
    }

    /**
     * @dev Writes balance checkpoints after every mint, burn and transfer.
     *
     *      Checkpoints are pushed AFTER `super._update` so the recorded values are the post-transfer
     *      balances. Several updates inside one block collapse into a single checkpoint for that
     *      block number, so `balanceOfAt(a, n)` always reports the balance at the END of block `n`.
     */
    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);

        uint48 key = SafeCast.toUint48(block.number);

        // totalSupply only moves on mint (from == 0) or burn (to == 0).
        if (from == address(0) || to == address(0)) {
            _totalSupplyCheckpoints.push(key, SafeCast.toUint208(totalSupply()));
        }
        if (from != address(0)) {
            _balanceCheckpoints[from].push(key, SafeCast.toUint208(balanceOf(from)));
        }
        if (to != address(0)) {
            _balanceCheckpoints[to].push(key, SafeCast.toUint208(balanceOf(to)));
        }
    }
}
