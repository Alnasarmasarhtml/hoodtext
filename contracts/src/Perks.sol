// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ICheckpointToken, IPerks, IRevenueVault} from "./interfaces/IHoodGram.sol";

/**
 * @title Perks
 * @notice The holder status ladder. Pure status and capacity — never a claim on anyone's revenue.
 *
 *           tier 1  RESIDENT        0.05% of supply   holder badge in every chat
 *           tier 2  BLOCK CAPTAIN   0.10%             + 4-char handles, bigger uploads, bigger rooms
 *           tier 3  DISTRICT        0.25%             + 3-char handles, early features
 *           tier 4  KINGPIN         0.50%             + 2-char handles, broadcast rooms
 *
 * @dev A tier must be HELD, not visited: {tierOf} uses the LOWER of the live balance and the balance
 *      at the last sealed revenue epoch's snapshot block. Buying into a tier therefore takes effect
 *      no later than the next weekly seal, and renting tokens for a day earns nothing. Before the
 *      first epoch is ever sealed, the live balance alone decides (there is nothing to anchor to).
 *
 *      Everything here is read-only over the token's existing checkpoints — holding in your own
 *      wallet is the entire requirement, exactly like the revenue share.
 *
 *      The revenue share itself stays pure pro-rata for every holder at every size. The ladder
 *      gates identity and capacity only; it can never dilute or redirect anyone's claim.
 */
contract Perks is IPerks, Ownable {
    /// @notice Number of tiers above zero.
    uint8 public constant TIER_COUNT = 4;

    /// @dev Basis-point denominator.
    uint256 private constant BPS_DENOMINATOR = 10_000;

    /// @notice The $THOOD token, for live balances and total supply.
    IERC20 public immutable THOOD;

    /// @notice The same token address, viewed through its historical-balance interface.
    ICheckpointToken public immutable CHECKPOINTS;

    /// @notice The revenue vault whose latest epoch snapshot anchors the anti-flash-buy check.
    IRevenueVault public vault;

    /// @notice Threshold for each tier, in basis points of total supply. Index 0 is tier 1.
    /// @dev Defaults: 5 bps (0.05%), 10 bps (0.1%), 25 bps (0.25%), 50 bps (0.5%).
    uint16[TIER_COUNT] public thresholdsBps;

    /// @notice Emitted when the owner changes the tier thresholds.
    event ThresholdsSet(uint16[TIER_COUNT] bps);
    /// @notice Emitted when the vault address changes.
    event VaultSet(address indexed vault);

    /// @notice Thrown when thresholds are zero, non-increasing or above 100%.
    error InvalidThresholds();
    /// @notice Thrown when a tier argument is 0 or above {TIER_COUNT}.
    error InvalidTier();
    /// @notice Thrown when an address argument is the zero address.
    error ZeroAddress();

    /**
     * @notice Deploys the perk ladder at the default thresholds.
     * @param initialOwner Address allowed to tune thresholds and swap the vault.
     * @param thood_ The $THOOD token, which must implement {ICheckpointToken}.
     * @param vault_ The revenue vault, for {IRevenueVault.latestSnapshot}.
     */
    constructor(address initialOwner, address thood_, address vault_) Ownable(initialOwner) {
        if (thood_ == address(0) || vault_ == address(0)) revert ZeroAddress();

        THOOD = IERC20(thood_);
        CHECKPOINTS = ICheckpointToken(thood_);
        vault = IRevenueVault(vault_);

        thresholdsBps = [uint16(5), 10, 25, 50];
        emit ThresholdsSet(thresholdsBps);
        emit VaultSet(vault_);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IPerks
    function tierOf(address user) external view returns (uint8) {
        uint256 balance = eligibleBalance(user);
        if (balance == 0) return 0;

        uint256 supply = THOOD.totalSupply();
        for (uint8 t = TIER_COUNT; t >= 1; --t) {
            if (balance >= (supply * thresholdsBps[t - 1]) / BPS_DENOMINATOR) {
                return t;
            }
        }
        return 0;
    }

    /**
     * @notice The balance {tierOf} judges `user` by: the LOWER of their live balance and their
     *         balance at the last sealed epoch's snapshot.
     * @param user The account to inspect.
     * @return The eligible balance.
     */
    function eligibleBalance(address user) public view returns (uint256) {
        uint256 live = THOOD.balanceOf(user);

        uint48 snapshot = vault.latestSnapshot();
        if (snapshot == 0) {
            return live;
        }

        uint256 at = CHECKPOINTS.balanceOfAt(user, snapshot);
        return at < live ? at : live;
    }

    /**
     * @notice The $THOOD amount required for `tier` right now.
     * @param tier The tier, 1..{TIER_COUNT}.
     * @return The threshold amount in $THOOD (18dp).
     */
    function thresholdAmount(uint8 tier) external view returns (uint256) {
        if (tier == 0 || tier > TIER_COUNT) revert InvalidTier();
        return (THOOD.totalSupply() * thresholdsBps[tier - 1]) / BPS_DENOMINATOR;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Owner
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * @notice Tunes the tier thresholds.
     * @param bps Thresholds in basis points of total supply, strictly increasing, all non-zero,
     *        none above 100%.
     */
    function setThresholdsBps(uint16[TIER_COUNT] calldata bps) external onlyOwner {
        uint16 prev = 0;
        for (uint256 i = 0; i < TIER_COUNT; ++i) {
            uint16 b = bps[i];
            if (b == 0 || b <= prev || b > BPS_DENOMINATOR) revert InvalidThresholds();
            prev = b;
        }
        thresholdsBps = bps;
        emit ThresholdsSet(bps);
    }

    /**
     * @notice Swaps the revenue vault the snapshot anchor is read from.
     * @param v The new {IRevenueVault}.
     */
    function setVault(address v) external onlyOwner {
        if (v == address(0)) revert ZeroAddress();
        vault = IRevenueVault(v);
        emit VaultSet(v);
    }
}
