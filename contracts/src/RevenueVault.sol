// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {IRevenueVault, ICheckpointToken} from "./interfaces/IHoodGram.sol";

/**
 * @title RevenueVault
 * @notice Splits every protocol payment ($5 activations, $10/month room rent) 50/50 between $THOOD holders and the treasury, and pays
 *         the holders' half out pro-rata by holdings.
 *
 * @dev **Holders do not stake, lock, deposit or delegate anything.** Eligibility is read from the
 *      token's historical balance checkpoints at a past block. Holding $THOOD in your own wallet at
 *      the moment an epoch is snapshotted is the entire requirement.
 *
 *      Lifecycle:
 *        1. {Activation} ($5 one-time accounts) and {GroupRegistry} ($10/month room rent) transfer
 *           $THOOD here and call {notifyRevenue}. The split into `pendingHolders` /
 *           `treasuryAccrued` happens immediately, at receipt.
 *        2. Anyone calls {sealEpoch} once {EPOCH_MIN_INTERVAL} has elapsed. That freezes a snapshot
 *           block and the `eligibleSupply` for the epoch, and moves `pendingHolders` into it.
 *        3. Holders {claim} their pro-rata share. Anything unclaimed after {CLAIM_WINDOW} can be
 *           swept to the treasury.
 *
 *      Solvency invariant, true after every state-changing call:
 *        `THOOD.balanceOf(this) >= treasuryAccrued + pendingHolders + sealedUnclaimed`
 *      where `sealedUnclaimed == Σ over unswept epochs of (holderAmount - claimed)`.
 */
contract RevenueVault is IRevenueVault, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Holders' share of every payment, in basis points. The remainder goes to the treasury.
    uint256 public constant HOLDER_BPS = 5000;

    /// @notice Minimum time between two sealed epochs.
    uint256 public constant EPOCH_MIN_INTERVAL = 7 days;

    /// @notice How long a sealed epoch stays claimable before it can be swept to the treasury.
    uint256 public constant CLAIM_WINDOW = 180 days;

    /// @notice Maximum number of excluded addresses, bounding the {sealEpoch} loop.
    uint256 public constant MAX_EXCLUDED = 16;

    /// @dev Basis-point denominator.
    uint256 private constant BPS_DENOMINATOR = 10_000;

    /// @notice The $THOOD token revenue is denominated in.
    IERC20 public immutable THOOD;

    /// @notice The same token address, viewed through its historical-balance interface.
    ICheckpointToken public immutable CHECKPOINTS;

    /// @notice Recipient of the treasury half and of anything swept after the claim window.
    address public treasury;

    /// @notice Addresses allowed to call {notifyRevenue}: {Activation} and {GroupRegistry}.
    mapping(address notifier => bool allowed) public isNotifier;

    /// @notice A sealed revenue epoch.
    struct Epoch {
        /// @dev Block number balances are read at. Always strictly in the past.
        uint48 snapshot;
        /// @dev Timestamp the epoch was sealed at; the claim window runs from here.
        uint64 sealedAt;
        /// @dev $THOOD allocated to holders for this epoch.
        uint256 holderAmount;
        /// @dev `totalSupplyAt(snapshot)` minus excluded balances at snapshot. Frozen at seal time.
        uint256 eligibleSupply;
        /// @dev Total $THOOD claimed from this epoch so far.
        uint256 claimed;
        /// @dev True once the remainder has been swept to the treasury.
        bool swept;
    }

    /// @notice Every epoch ever sealed, oldest first.
    Epoch[] public epochs;

    /// @notice Whether a user has already claimed a given epoch.
    mapping(uint256 epochId => mapping(address user => bool claimed)) public hasClaimed;

    /// @notice Holders' $THOOD accrued since the last seal, waiting to be assigned to an epoch.
    uint256 public pendingHolders;

    /// @notice Treasury's $THOOD accrued and not yet withdrawn.
    uint256 public treasuryAccrued;

    /// @notice Sum over unswept epochs of `(holderAmount - claimed)`.
    /// @dev Tracked incrementally so the solvency invariant is checkable in O(1).
    uint256 public sealedUnclaimed;

    /// @notice Addresses subtracted from `eligibleSupply` and blocked from claiming.
    /// @dev LP pairs, the treasury and this vault. Capped at {MAX_EXCLUDED}.
    address[] public excluded;

    /// @notice Whether an address is currently excluded from revenue.
    mapping(address addr => bool excludedFlag) public isExcluded;

    /// @notice Timestamp of the last {sealEpoch} call. Initialised to the deployment time.
    uint64 public lastSealAt;

    /// @notice Emitted when protocol revenue is received and split.
    event RevenueReceived(address indexed from, uint256 amount, uint256 toHolders, uint256 toTreasury);
    /// @notice Emitted when an epoch is sealed and becomes claimable.
    event EpochSealed(uint256 indexed epochId, uint48 snapshot, uint256 holderAmount, uint256 eligibleSupply);
    /// @notice Emitted on every processed claim, including zero-value ones.
    event Claimed(address indexed user, uint256 indexed epochId, uint256 amount);
    /// @notice Emitted when an expired epoch's remainder is swept to the treasury.
    event ExpiredSwept(uint256 indexed epochId, uint256 amount);
    /// @notice Emitted when the owner withdraws from the treasury balance.
    event TreasuryWithdrawn(address indexed to, uint256 amount);
    /// @notice Emitted when an address is added to or removed from the exclusion set.
    event ExcludedSet(address indexed addr, bool isExcluded);
    /// @notice Emitted when the treasury address changes.
    event TreasurySet(address indexed treasury);
    /// @notice Emitted when a revenue notifier is allowed or disallowed.
    event NotifierSet(address indexed notifier, bool allowed);
    /// @notice Emitted when a seal finds no eligible supply and routes the holders' half to the treasury.
    event PendingRoutedToTreasury(uint48 snapshot, uint256 amount);

    /// @notice Thrown when a non-allowed caller calls {notifyRevenue}.
    error NotNotifier();
    /// @notice Thrown when an address argument is the zero address.
    error ZeroAddress();
    /// @notice Thrown by {sealEpoch} when {EPOCH_MIN_INTERVAL} has not elapsed yet.
    error TooSoon();
    /// @notice Thrown by {sealEpoch} when there is nothing to distribute.
    error NothingToSeal();
    /// @notice Thrown when an epoch id does not exist.
    error UnknownEpoch();
    /// @notice Thrown when a user claims an epoch they have already claimed.
    error AlreadyClaimed();
    /// @notice Thrown when sweeping an epoch that was already swept.
    error AlreadySwept();
    /// @notice Thrown when sweeping before {CLAIM_WINDOW} has elapsed.
    error ClaimWindowOpen();
    /// @notice Thrown when a treasury withdrawal exceeds `treasuryAccrued`.
    error InsufficientTreasury();
    /// @notice Thrown when more than {MAX_EXCLUDED} addresses would be excluded.
    error TooManyExcluded();
    /// @notice Thrown when revenue is notified that was never actually transferred in.
    error NotFunded();

    /**
     * @notice Deploys the vault.
     * @param initialOwner Address allowed to manage exclusions, the treasury and withdrawals.
     * @param thood_ The $THOOD token, which must implement {ICheckpointToken}.
     * @param treasury_ Recipient of the treasury half.
     */
    constructor(address initialOwner, address thood_, address treasury_) Ownable(initialOwner) {
        if (thood_ == address(0) || treasury_ == address(0)) revert ZeroAddress();

        THOOD = IERC20(thood_);
        CHECKPOINTS = ICheckpointToken(thood_);
        treasury = treasury_;
        lastSealAt = SafeCast.toUint64(block.timestamp);

        emit TreasurySet(treasury_);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Revenue in
    // ─────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IRevenueVault
    /// @dev The $THOOD has already been transferred in by the notifier ({Activation} or
    ///      {GroupRegistry}), so 100% of the payment is here before the split is recorded. The
    ///      balance check makes that impossible to get wrong.
    function notifyRevenue(uint256 amount) external {
        if (!isNotifier[msg.sender]) revert NotNotifier();

        uint256 toHolders = (amount * HOLDER_BPS) / BPS_DENOMINATOR;
        uint256 toTreasury = amount - toHolders;

        pendingHolders += toHolders;
        treasuryAccrued += toTreasury;

        if (THOOD.balanceOf(address(this)) < totalObligations()) revert NotFunded();

        emit RevenueReceived(msg.sender, amount, toHolders, toTreasury);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Epochs
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * @notice Seals everything accrued since the last epoch into a new claimable epoch.
     * @dev PERMISSIONLESS by design — no holder should ever depend on the team to get paid. Rate
     *      limited to one call per {EPOCH_MIN_INTERVAL}.
     *
     *      `eligibleSupply` is computed exactly once, here, as `totalSupplyAt(snapshot)` minus the
     *      `balanceOfAt(snapshot)` of every excluded address, and frozen on the epoch. It is never
     *      recomputed at claim time. Excluding LP pairs and the treasury matters: tokens that can
     *      never call {claim} would otherwise silently absorb the holders' half.
     *
     * @return epochId The new epoch's index, or `type(uint256).max` when no epoch was created
     *         because `eligibleSupply` was zero and the holders' half was routed to the treasury.
     */
    function sealEpoch() external returns (uint256 epochId) {
        uint256 amount = pendingHolders;
        if (amount == 0) revert NothingToSeal();
        if (block.timestamp < uint256(lastSealAt) + EPOCH_MIN_INTERVAL) revert TooSoon();

        // A strictly past block, so the checkpoint lookups below are always valid.
        uint48 snapshot = SafeCast.toUint48(block.number - 1);

        uint256 supply = CHECKPOINTS.totalSupplyAt(snapshot);
        uint256 excludedTotal;
        uint256 len = excluded.length;
        for (uint256 i = 0; i < len; ++i) {
            excludedTotal += CHECKPOINTS.balanceOfAt(excluded[i], snapshot);
        }
        uint256 eligibleSupply = supply > excludedTotal ? supply - excludedTotal : 0;

        pendingHolders = 0;
        lastSealAt = SafeCast.toUint64(block.timestamp);

        if (eligibleSupply == 0) {
            // Nobody could ever claim this. Route it to the treasury rather than create a dead epoch.
            treasuryAccrued += amount;
            emit PendingRoutedToTreasury(snapshot, amount);
            return type(uint256).max;
        }

        epochId = epochs.length;
        epochs.push(
            Epoch({
                snapshot: snapshot,
                sealedAt: SafeCast.toUint64(block.timestamp),
                holderAmount: amount,
                eligibleSupply: eligibleSupply,
                claimed: 0,
                swept: false
            })
        );
        sealedUnclaimed += amount;

        emit EpochSealed(epochId, snapshot, amount, eligibleSupply);
    }

    /**
     * @notice Number of epochs sealed so far.
     * @return The epoch count.
     */
    function epochCount() external view returns (uint256) {
        return epochs.length;
    }

    /**
     * @notice Earliest timestamp at which {sealEpoch} may next be called.
     * @return The unix timestamp.
     */
    function nextSealAt() external view returns (uint64) {
        return SafeCast.toUint64(uint256(lastSealAt) + EPOCH_MIN_INTERVAL);
    }

    /// @inheritdoc IRevenueVault
    /// @dev {Perks} anchors its anti-flash-buy balance check to this block.
    function latestSnapshot() external view returns (uint48) {
        uint256 n = epochs.length;
        return n == 0 ? 0 : epochs[n - 1].snapshot;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Claims
    // ─────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IRevenueVault
    function claimable(address user, uint256 epochId) external view returns (uint256) {
        if (epochId >= epochs.length) revert UnknownEpoch();
        if (hasClaimed[epochId][user]) return 0;
        return _shareOf(epochId, user);
    }

    /**
     * @notice Total claimable across every sealed epoch for `user`.
     * @dev Convenience view for the UI. O(epochCount) — call it off-chain.
     * @param user The holder to inspect.
     * @return total The sum of all unclaimed shares.
     */
    function totalClaimable(address user) external view returns (uint256 total) {
        uint256 len = epochs.length;
        for (uint256 i = 0; i < len; ++i) {
            if (!hasClaimed[i][user]) {
                total += _shareOf(i, user);
            }
        }
    }

    /// @inheritdoc IRevenueVault
    function claim(uint256 epochId) external nonReentrant returns (uint256) {
        uint256 amount = _claimOne(epochId, msg.sender);
        if (amount != 0) {
            THOOD.safeTransfer(msg.sender, amount);
        }
        return amount;
    }

    /// @inheritdoc IRevenueVault
    function claimMany(uint256[] calldata epochIds) external nonReentrant returns (uint256 total) {
        uint256 len = epochIds.length;
        for (uint256 i = 0; i < len; ++i) {
            total += _claimOne(epochIds[i], msg.sender);
        }
        if (total != 0) {
            THOOD.safeTransfer(msg.sender, total);
        }
    }

    /**
     * @notice After {CLAIM_WINDOW}, moves an epoch's unclaimed remainder to the treasury.
     * @dev Permissionless: it only moves value between internal buckets, never out of the contract.
     * @param epochId Index of the epoch to sweep.
     */
    function sweepExpired(uint256 epochId) external {
        if (epochId >= epochs.length) revert UnknownEpoch();
        Epoch storage e = epochs[epochId];
        if (e.swept) revert AlreadySwept();
        if (block.timestamp < uint256(e.sealedAt) + CLAIM_WINDOW) revert ClaimWindowOpen();

        uint256 remainder = e.holderAmount - e.claimed;
        e.swept = true;

        if (remainder != 0) {
            sealedUnclaimed -= remainder;
            treasuryAccrued += remainder;
        }

        emit ExpiredSwept(epochId, remainder);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Owner
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * @notice Withdraws from the treasury's accrued half.
     * @dev Can never touch `pendingHolders` or any sealed epoch's holder allocation.
     * @param to Recipient of the $THOOD.
     * @param amount Amount to withdraw. Must not exceed `treasuryAccrued`.
     */
    function withdrawTreasury(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (amount > treasuryAccrued) revert InsufficientTreasury();

        treasuryAccrued -= amount;
        THOOD.safeTransfer(to, amount);

        emit TreasuryWithdrawn(to, amount);
    }

    /**
     * @notice Adds or removes an address from the revenue exclusion set.
     * @dev Excluded balances are subtracted from `eligibleSupply` at seal time and excluded
     *      addresses always claim zero. Use it for LP pairs, the treasury and this vault —
     *      addresses that hold $THOOD but can never meaningfully claim.
     * @param addr Address to change.
     * @param excluded_ True to exclude, false to re-include.
     */
    function setExcluded(address addr, bool excluded_) external onlyOwner {
        if (addr == address(0)) revert ZeroAddress();
        if (isExcluded[addr] == excluded_) return;

        if (excluded_) {
            if (excluded.length >= MAX_EXCLUDED) revert TooManyExcluded();
            isExcluded[addr] = true;
            excluded.push(addr);
        } else {
            isExcluded[addr] = false;
            uint256 len = excluded.length;
            for (uint256 i = 0; i < len; ++i) {
                if (excluded[i] == addr) {
                    excluded[i] = excluded[len - 1];
                    excluded.pop();
                    break;
                }
            }
        }

        emit ExcludedSet(addr, excluded_);
    }

    /**
     * @notice Sets the treasury address.
     * @param t The new treasury.
     */
    function setTreasury(address t) external onlyOwner {
        if (t == address(0)) revert ZeroAddress();
        treasury = t;
        emit TreasurySet(t);
    }

    /**
     * @notice Allows or disallows an address to call {notifyRevenue}.
     * @param notifier The revenue source ({Activation} or {GroupRegistry}).
     * @param allowed True to allow, false to disallow.
     */
    function setNotifier(address notifier, bool allowed) external onlyOwner {
        if (notifier == address(0)) revert ZeroAddress();
        isNotifier[notifier] = allowed;
        emit NotifierSet(notifier, allowed);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Views / internals
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * @notice Number of excluded addresses.
     * @return The length of the exclusion set.
     */
    function excludedCount() external view returns (uint256) {
        return excluded.length;
    }

    /**
     * @notice The full exclusion set.
     * @return The excluded addresses.
     */
    function excludedList() external view returns (address[] memory) {
        return excluded;
    }

    /**
     * @notice Everything this vault currently owes: treasury, unsealed holder accruals and every
     *         unswept epoch's unclaimed remainder.
     * @return The total $THOOD obligation.
     */
    function totalObligations() public view returns (uint256) {
        return treasuryAccrued + pendingHolders + sealedUnclaimed;
    }

    /**
     * @notice Whether the solvency invariant holds right now.
     * @return True when `THOOD.balanceOf(this) >= totalObligations()`.
     */
    function isSolvent() external view returns (bool) {
        return THOOD.balanceOf(address(this)) >= totalObligations();
    }

    /**
     * @dev The claim math:
     *        `share = holderAmount * balanceOfAt(user, snapshot) / eligibleSupply`
     *
     *      Zero balance, an excluded address and a swept epoch all yield zero without reverting.
     *      The result is capped at the epoch's unclaimed remainder. That cap never binds in normal
     *      operation (the shares of all eligible holders sum to at most `holderAmount`); it exists
     *      so that re-including a previously excluded address can never let claims exceed the
     *      epoch's allocation and break solvency.
     */
    function _shareOf(uint256 epochId, address user) internal view returns (uint256) {
        Epoch storage e = epochs[epochId];
        if (e.swept) return 0;
        if (isExcluded[user]) return 0;

        uint256 balance = CHECKPOINTS.balanceOfAt(user, e.snapshot);
        if (balance == 0) return 0;

        uint256 share = (e.holderAmount * balance) / e.eligibleSupply;
        uint256 remaining = e.holderAmount - e.claimed;
        return share > remaining ? remaining : share;
    }

    /// @dev Books one epoch's claim for `user`. Payment is made by the caller, in one transfer.
    function _claimOne(uint256 epochId, address user) internal returns (uint256 amount) {
        if (epochId >= epochs.length) revert UnknownEpoch();
        if (hasClaimed[epochId][user]) revert AlreadyClaimed();

        amount = _shareOf(epochId, user);
        hasClaimed[epochId][user] = true;

        if (amount != 0) {
            epochs[epochId].claimed += amount;
            sealedUnclaimed -= amount;
        }

        emit Claimed(user, epochId, amount);
    }
}
