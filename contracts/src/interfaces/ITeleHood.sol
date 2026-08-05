// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title TeleHood core interfaces
 * @notice Shared types and interfaces for the TeleHood protocol.
 *
 * The economic model:
 *   - **Activation** is a $5 ONE-TIME payment in $THOOD. Pay once, text forever.
 *   - **Rooms** (groups) cost $10 PER MONTH in $THOOD, paid by the room's admin. Members are free.
 *   - Prices are fixed in USD on-chain and converted to $THOOD at purchase time.
 * There are no per-message fees and there is no staking anywhere in this system.
 * Half of every payment is shared with $THOOD holders, pro-rata by holdings, using historical
 * balance checkpoints — no deposit, no lock-up, no delegation.
 *
 * Holder perks are pure STATUS AND CAPACITY, never a claim on other holders' revenue:
 *   tier 1 RESIDENT (0.05% of supply), 2 BLOCK CAPTAIN (0.1%), 3 DISTRICT (0.25%), 4 KINGPIN (0.5%).
 * Perk tier is the *lower* of the live balance and the balance at the last sealed revenue snapshot,
 * so a tier cannot be rented for a day.
 */

/**
 * @notice An ERC20 that records historical raw balances so revenue can be paid to holders
 *         without them ever staking, locking, depositing or delegating.
 */
interface ICheckpointToken {
    /**
     * @notice Raw ERC20 balance of `account` as of the end of block `timepoint`.
     * @param account The address to look up.
     * @param timepoint Block number to read at. Must be strictly in the past.
     * @return The balance held at that block.
     */
    function balanceOfAt(address account, uint48 timepoint) external view returns (uint256);

    /**
     * @notice Total supply as of the end of block `timepoint`.
     * @param timepoint Block number to read at. Must be strictly in the past.
     * @return The total supply at that block.
     */
    function totalSupplyAt(uint48 timepoint) external view returns (uint256);
}

/// @notice Converts US dollars to $THOOD so on-chain USD prices stay stable in dollar terms.
interface IPriceSource {
    /// @return how many $THOOD (18dp) equal one US dollar
    function thoodPerUsd() external view returns (uint256);
}

/// @notice The one-time account gate. A single `isActivated` call gates every product surface.
interface IActivation {
    /**
     * @notice Whether `user` has ever activated (or been granted) a TeleHood account.
     * @param user The account to inspect.
     * @return True once activated. Activation is permanent — there is nothing to renew.
     */
    function isActivated(address user) external view returns (bool);

    /**
     * @notice Unix timestamp at which `user` activated.
     * @param user The account to inspect.
     * @return The activation timestamp (0 if never activated).
     */
    function activatedAt(address user) external view returns (uint64);
}

/// @notice Room state as other contracts need to see it: does it exist, and is its rent current?
interface IRooms {
    /**
     * @notice Whether `groupId` exists and its rent is paid up.
     * @param groupId The room to inspect.
     * @return True when the room exists and `paidUntil` is in the future.
     */
    function isActive(bytes32 groupId) external view returns (bool);
}

/// @notice Holder perk tiers, computed from token balances. Status and capacity only — never money.
interface IPerks {
    /**
     * @notice The perk tier of `user`: 0 none, 1 RESIDENT, 2 BLOCK CAPTAIN, 3 DISTRICT, 4 KINGPIN.
     * @dev Uses the LOWER of the live balance and the balance at the last sealed revenue snapshot,
     *      so a tier cannot be flash-bought or rented for a day.
     * @param user The account to inspect.
     * @return The tier, 0..4.
     */
    function tierOf(address user) external view returns (uint8);
}

/// @notice Receives 100% of protocol revenue and splits it 50/50 between holders and treasury.
interface IRevenueVault {
    /**
     * @notice Account for revenue whose $THOOD has ALREADY been transferred into this vault.
     * @param amount The $THOOD amount that was transferred in.
     */
    function notifyRevenue(uint256 amount) external;

    /**
     * @notice How much $THOOD `user` may still claim from `epochId`.
     * @param user The holder to inspect.
     * @param epochId Index into the sealed epoch list.
     * @return The claimable $THOOD amount (0 if already claimed, excluded, swept or zero balance).
     */
    function claimable(address user, uint256 epochId) external view returns (uint256);

    /**
     * @notice Claim the caller's pro-rata share of one sealed epoch.
     * @param epochId Index into the sealed epoch list.
     * @return The $THOOD amount transferred to the caller.
     */
    function claim(uint256 epochId) external returns (uint256);

    /**
     * @notice Claim several epochs in one transaction, paid out as a single transfer.
     * @param epochIds Epoch indices to claim.
     * @return total The total $THOOD transferred to the caller.
     */
    function claimMany(uint256[] calldata epochIds) external returns (uint256 total);

    /**
     * @notice The snapshot block of the most recently sealed epoch.
     * @dev {Perks} anchors its anti-flash-buy check here.
     * @return The block number, or 0 when no epoch has ever been sealed.
     */
    function latestSnapshot() external view returns (uint48);
}
