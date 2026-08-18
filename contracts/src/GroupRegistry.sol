// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {IActivation, IPriceSource, IRevenueVault, IRooms} from "./interfaces/IHoodGram.sol";

/**
 * @title GroupRegistry
 * @notice Rooms. Creating one costs $10/month in $THOOD, paid by whoever runs it — members are free.
 *         Alongside the rent this contract keeps each room's membership commitment and sender-key
 *         epoch for the E2E group encryption.
 *
 * @dev The rent model in four sentences:
 *
 *      1. The creator pays rent up front ({createGroup}) and anyone may top a room up afterwards
 *         ({payRent}) — a member keeping a beloved room alive is a feature, not a bug, because
 *         paying rent grants no control.
 *      2. Rent lapsing blocks NEW MESSAGES only ({Anchors} checks {isActive}). It never deletes
 *         anything: history, keys, membership and administration all survive, and paying rent again
 *         reopens the room exactly as it was.
 *      3. Administration (epoch rotation, admin transfer) is deliberately NOT rent-gated — a lapsed
 *         admin can still remove members or hand the room over.
 *      4. Opt-in auto-renew: the admin approves a $THOOD allowance once and the permissionless
 *         {renewFor} keeps the room alive one month at a time, funded only from the admin's own
 *         allowance. Switching it off is the entire cancellation flow.
 *
 *      Only a `memberRoot` commitment lives on chain; the member list itself never does.
 */
contract GroupRegistry is IRooms, Ownable {
    using SafeERC20 for IERC20;

    /// @notice One rent month, in seconds.
    uint64 public constant MONTH = 30 days;

    /// @notice Maximum number of months that may be bought in a single call.
    uint8 public constant MAX_MONTHS = 24;

    /// @notice How early a permissionless {renewFor} may fire ahead of rent lapse.
    uint64 public constant RENEW_WINDOW = 3 days;

    /// @notice The $GRAM token rent is paid in.
    /// @dev Settable by the owner until {lockToken} freezes it. Rooms record `paidUntil`, never the
    ///      token a month was bought with, so swapping the token leaves every existing room, its
    ///      admin, its members and its paid-up date exactly as they were. See {setToken}.
    IERC20 public THOOD;

    /// @notice True once {lockToken} has frozen {THOOD} permanently.
    bool public tokenLocked;

    /// @notice The one-time account gate; only activated accounts may create rooms.
    IActivation public activation;

    /// @notice Destination of 100% of every rent payment. The 50/50 split happens there.
    IRevenueVault public vault;

    /// @notice Converts the on-chain USD rent into $THOOD at payment time.
    IPriceSource public priceSource;

    /// @notice Monthly rent per room, denominated in USD with 18 decimals. Default $10.
    uint256 public rentUsdPerMonth;

    /// @notice A room's on-chain state.
    struct Group {
        /// @dev The only address allowed to rotate epochs, transfer administration and set auto-renew.
        address admin;
        /// @dev Sender-key epoch. Starts at 0 and increments on every rotation.
        uint32 epoch;
        /// @dev Creation timestamp.
        uint64 createdAt;
        /// @dev Commitment to the current member set.
        bytes32 memberRoot;
        /// @dev Rent is paid up to this timestamp. The room is active while it is in the future.
        uint64 paidUntil;
        /// @dev Whether the permissionless {renewFor} may renew this room from the admin's allowance.
        bool autoRenew;
        /// @dev True once the room has been created.
        bool exists;
    }

    /// @notice Room state by group id.
    mapping(bytes32 groupId => Group group) public groups;

    /// @notice Emitted when a room is created, with its first rent payment.
    event GroupCreated(
        bytes32 indexed groupId,
        address indexed admin,
        bytes32 memberRoot,
        uint8 months,
        uint256 thoodPaid,
        uint64 paidUntil
    );
    /// @notice Emitted on every rent payment, including the permissionless auto-renewals.
    event RentPaid(bytes32 indexed groupId, address indexed payer, uint8 months, uint256 thoodPaid, uint64 paidUntil);
    /// @notice Emitted when the owner grants rent without payment. Never touches the vault.
    event RentGranted(bytes32 indexed groupId, uint8 months, uint64 paidUntil);
    /// @notice Emitted when a room's admin switches auto-renew on or off.
    event AutoRenewSet(bytes32 indexed groupId, bool on);
    /// @notice Emitted when the sender-key epoch is rotated (member added or removed).
    event EpochRotated(bytes32 indexed groupId, uint32 epoch, bytes32 memberRoot, uint64 at);
    /// @notice Emitted when administration is handed over.
    event AdminTransferred(bytes32 indexed groupId, address indexed from, address indexed to);
    /// @notice Emitted when the owner changes the monthly USD rent.
    event RentPriceSet(uint256 usd18);
    /// @notice Emitted when the activation gate address changes.
    event ActivationSet(address indexed activation);
    /// @notice Emitted when the revenue vault address changes.
    event VaultSet(address indexed vault);
    /// @notice Emitted when the rent token changes.
    event TokenSet(address indexed token);
    /// @notice Emitted once, when the rent token is frozen forever.
    event TokenLocked(address indexed token);
    /// @notice Emitted when the price source changes.
    event PriceSourceSet(address indexed priceSource);

    /// @notice Thrown when the caller has not activated an account.
    error NotActivated();
    /// @notice Thrown when the caller is not the room's admin.
    error NotAdmin();
    /// @notice Thrown when the group id is zero.
    error InvalidGroup();
    /// @notice Thrown when creating a group id that already exists.
    error GroupExists();
    /// @notice Thrown when addressing a room that does not exist.
    error UnknownGroup();
    /// @notice Thrown when `months` is 0 or greater than {MAX_MONTHS}.
    error InvalidMonths();
    /// @notice Thrown when a monthly rent of zero is supplied.
    error InvalidPrice();
    /// @notice Thrown when an address argument is the zero address.
    error ZeroAddress();
    /// @notice Thrown when the rent token is changed after {lockToken}.
    error TokenIsLocked();
    /// @notice Thrown by {renewFor} when the room's rent is not yet inside {RENEW_WINDOW}.
    error NotDue();
    /// @notice Thrown by {renewFor} when the room has not opted in to auto-renew.
    error AutoRenewOff();

    /**
     * @notice Deploys the room registry at the default $10/month rent.
     * @param initialOwner Address allowed to change the rent, the gates and the vault.
     * @param thood_ The $THOOD token address.
     * @param activation_ The one-time account gate.
     * @param priceSource_ The USD to $THOOD price source.
     * @param vault_ The revenue vault that receives 100% of rent.
     */
    constructor(address initialOwner, address thood_, address activation_, address priceSource_, address vault_)
        Ownable(initialOwner)
    {
        if (thood_ == address(0) || activation_ == address(0) || priceSource_ == address(0) || vault_ == address(0)) {
            revert ZeroAddress();
        }

        THOOD = IERC20(thood_);
        activation = IActivation(activation_);
        priceSource = IPriceSource(priceSource_);
        vault = IRevenueVault(vault_);
        rentUsdPerMonth = 10e18;

        emit RentPriceSet(10e18);
        emit ActivationSet(activation_);
        emit PriceSourceSet(priceSource_);
        emit VaultSet(vault_);
        emit TokenSet(thood_);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IRooms
    function isActive(bytes32 groupId) public view returns (bool) {
        Group storage g = groups[groupId];
        return g.exists && uint256(g.paidUntil) > block.timestamp;
    }

    /**
     * @notice $THOOD that `months` of rent costs right now.
     * @param months Number of months, 1..{MAX_MONTHS}.
     * @return thoodAmount The $THOOD amount that will be pulled from the payer.
     */
    function quoteRent(uint8 months) public view returns (uint256 thoodAmount) {
        if (months == 0 || months > MAX_MONTHS) revert InvalidMonths();
        return (uint256(months) * rentUsdPerMonth * priceSource.thoodPerUsd()) / 1e18;
    }

    /**
     * @notice The `paidUntil` a rent payment of `months` would produce for `groupId` right now.
     * @param groupId The room to inspect. Must exist.
     * @param months Number of months, 1..{MAX_MONTHS}.
     * @return The resulting paid-until timestamp.
     */
    function previewPaidUntil(bytes32 groupId, uint8 months) external view returns (uint64) {
        Group storage g = groups[groupId];
        if (!g.exists) revert UnknownGroup();
        return _extended(g.paidUntil, months);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Rooms
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * @notice Creates a room and pays its first rent. Requires an activated account.
     * @param groupId Deterministic group id (sha256 of name, creator and salt, client-side).
     * @param memberRoot Commitment to the initial member set.
     * @param months Months of rent to pay up front, 1..{MAX_MONTHS}.
     */
    function createGroup(bytes32 groupId, bytes32 memberRoot, uint8 months) external {
        if (groupId == bytes32(0)) revert InvalidGroup();
        if (!activation.isActivated(msg.sender)) revert NotActivated();

        Group storage g = groups[groupId];
        if (g.exists) revert GroupExists();

        uint64 at = SafeCast.toUint64(block.timestamp);
        uint64 paidUntil = _extended(0, months);
        uint256 thoodAmount = quoteRent(months);

        g.admin = msg.sender;
        g.epoch = 0;
        g.createdAt = at;
        g.memberRoot = memberRoot;
        g.paidUntil = paidUntil;
        g.exists = true;

        _collect(msg.sender, thoodAmount);

        emit GroupCreated(groupId, msg.sender, memberRoot, months, thoodAmount, paidUntil);
    }

    /**
     * @notice Pays rent on an existing room. Anyone may pay — paying grants no control.
     * @dev Extends from `max(now, paidUntil)`, so paying early never burns time and reviving a
     *      lapsed room starts its new rent from now, not from the lapse.
     * @param groupId The room to pay rent on.
     * @param months Number of months, 1..{MAX_MONTHS}.
     */
    function payRent(bytes32 groupId, uint8 months) external {
        Group storage g = groups[groupId];
        if (!g.exists) revert UnknownGroup();

        uint64 paidUntil = _extended(g.paidUntil, months);
        uint256 thoodAmount = quoteRent(months);

        g.paidUntil = paidUntil;

        _collect(msg.sender, thoodAmount);

        emit RentPaid(groupId, msg.sender, months, thoodAmount, paidUntil);
    }

    /**
     * @notice Permissionless. Renews `groupId` by one month, funded by its ADMIN's allowance.
     * @dev Anyone may call this. It can never move money the admin did not approve: the funds come
     *      from the admin's own $THOOD allowance to this contract, it only fires once the room is
     *      inside {RENEW_WINDOW} of lapsing, and it only ever buys exactly one month.
     * @param groupId The room to renew.
     */
    function renewFor(bytes32 groupId) external {
        Group storage g = groups[groupId];
        if (!g.exists) revert UnknownGroup();
        if (!g.autoRenew) revert AutoRenewOff();
        if (block.timestamp + RENEW_WINDOW < uint256(g.paidUntil)) revert NotDue();

        uint64 paidUntil = _extended(g.paidUntil, 1);
        uint256 thoodAmount = quoteRent(1);

        g.paidUntil = paidUntil;

        _collect(g.admin, thoodAmount);

        emit RentPaid(groupId, g.admin, 1, thoodAmount, paidUntil);
    }

    /**
     * @notice Switches a room's permissionless auto-renewal on or off. Admin only.
     * @dev Switching it on does nothing by itself: {renewFor} can only ever spend the allowance the
     *      admin has already granted this contract. Switching it off cancels — nothing else happens.
     * @param groupId The room to change.
     * @param on True to allow {renewFor}, false to cancel.
     */
    function setAutoRenew(bytes32 groupId, bool on) external {
        Group storage g = groups[groupId];
        if (!g.exists) revert UnknownGroup();
        if (g.admin != msg.sender) revert NotAdmin();

        g.autoRenew = on;
        emit AutoRenewSet(groupId, on);
    }

    /**
     * @notice Rotates the room's sender-key epoch and commits to a new member set.
     * @dev Admin only, and deliberately NOT rent-gated: a lapsed admin can still administer the
     *      rooms they already created.
     * @param groupId The room to rotate.
     * @param newMemberRoot Commitment to the new member set.
     */
    function rotateEpoch(bytes32 groupId, bytes32 newMemberRoot) external {
        Group storage g = groups[groupId];
        if (!g.exists) revert UnknownGroup();
        if (g.admin != msg.sender) revert NotAdmin();

        uint32 nextEpoch = g.epoch + 1;
        g.epoch = nextEpoch;
        g.memberRoot = newMemberRoot;

        emit EpochRotated(groupId, nextEpoch, newMemberRoot, uint64(block.timestamp));
    }

    /**
     * @notice Hands administration of a room to another address.
     * @dev Admin only, and deliberately NOT rent-gated. Auto-renew is switched off on transfer so
     *      the outgoing admin's allowance can never be spent on a room they no longer run.
     * @param groupId The room to transfer.
     * @param newAdmin The new admin.
     */
    function transferAdmin(bytes32 groupId, address newAdmin) external {
        if (newAdmin == address(0)) revert ZeroAddress();

        Group storage g = groups[groupId];
        if (!g.exists) revert UnknownGroup();
        if (g.admin != msg.sender) revert NotAdmin();

        g.admin = newAdmin;
        if (g.autoRenew) {
            g.autoRenew = false;
            emit AutoRenewSet(groupId, false);
        }

        emit AdminTransferred(groupId, msg.sender, newAdmin);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Owner
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * @notice Owner may grant rent without payment (partner rooms, support). Never touches the vault.
     * @param groupId The room to grant rent to.
     * @param months Number of months, 1..{MAX_MONTHS}.
     */
    function grantRent(bytes32 groupId, uint8 months) external onlyOwner {
        Group storage g = groups[groupId];
        if (!g.exists) revert UnknownGroup();

        uint64 paidUntil = _extended(g.paidUntil, months);
        g.paidUntil = paidUntil;

        emit RentGranted(groupId, months, paidUntil);
    }

    /**
     * @notice Sets the monthly USD rent.
     * @param usd18 Monthly rent in USD, 18 decimals. Must be non-zero.
     */
    function setRentUsdPerMonth(uint256 usd18) external onlyOwner {
        if (usd18 == 0) revert InvalidPrice();
        rentUsdPerMonth = usd18;
        emit RentPriceSet(usd18);
    }

    /**
     * @notice Swaps the activation gate.
     * @param a The new {IActivation}.
     */
    function setActivation(address a) external onlyOwner {
        if (a == address(0)) revert ZeroAddress();
        activation = IActivation(a);
        emit ActivationSet(a);
    }

    /**
     * @notice Swaps the USD to $THOOD price source (e.g. manual rate to a Uniswap TWAP).
     * @param src The new {IPriceSource}.
     */
    function setPriceSource(address src) external onlyOwner {
        if (src == address(0)) revert ZeroAddress();
        priceSource = IPriceSource(src);
        emit PriceSourceSet(src);
    }

    /**
     * @notice Sets the revenue vault that receives 100% of rent payments.
     * @param v The new {IRevenueVault}.
     */
    function setVault(address v) external onlyOwner {
        if (v == address(0)) revert ZeroAddress();
        vault = IRevenueVault(v);
        emit VaultSet(v);
    }

    /**
     * @notice Points rent payments at a different token.
     * @dev Rooms store `paidUntil`, never the token a month was bought with, so existing rooms,
     *      their members and their paid-up dates are untouched. Only future rent changes currency.
     * @param token The new rent token. Must be non-zero.
     */
    function setToken(address token) external onlyOwner {
        if (tokenLocked) revert TokenIsLocked();
        if (token == address(0)) revert ZeroAddress();
        THOOD = IERC20(token);
        emit TokenSet(token);
    }

    /**
     * @notice Freezes the rent token forever. There is no unlock.
     */
    function lockToken() external onlyOwner {
        tokenLocked = true;
        emit TokenLocked(address(THOOD));
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Internals
    // ─────────────────────────────────────────────────────────────────────────────

    /// @dev New `paidUntil` after buying `months` on top of `current`: extends from
    ///      `max(now, current)` so early payments never burn time. Validates `months`.
    function _extended(uint64 current, uint8 months) internal view returns (uint64) {
        if (months == 0 || months > MAX_MONTHS) revert InvalidMonths();
        uint256 base = uint256(current) > block.timestamp ? uint256(current) : block.timestamp;
        return SafeCast.toUint64(base + uint256(months) * uint256(MONTH));
    }

    /**
     * @dev Moves the payment DIRECTLY from the payer to the vault, then tells the vault about it.
     *      100% of the payment reaches the vault; the 50/50 holder/treasury split happens there.
     */
    function _collect(address payer, uint256 thoodAmount) internal {
        IRevenueVault vault_ = vault;
        if (thoodAmount != 0) {
            THOOD.safeTransferFrom(payer, address(vault_), thoodAmount);
        }
        vault_.notifyRevenue(thoodAmount);
    }
}
