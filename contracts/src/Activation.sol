// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {IActivation, IPriceSource, IRevenueVault} from "./interfaces/IHoodGram.sol";

/**
 * @title Activation
 * @notice The $5 handshake. One payment, in $THOOD, and the account exists forever.
 *
 * @dev Three properties define this contract:
 *
 *      1. **One-time, permanent.** There is no expiry, no renewal and nothing to maintain.
 *         `isActivated` flips to true exactly once per address and never flips back.
 *
 *      2. **The spam wall IS the price.** Every account on HoodGram cost somebody five dollars,
 *         which is why there are no bot floods. The fee is deliberately small enough to be paid
 *         without thinking and large enough that ten thousand spam accounts are not.
 *
 *      3. **No per-message fee, ever.** {Anchors} only asks `isActivated`. Once activated,
 *         sending costs nothing (relayed) or gas only (self-posted).
 *
 *      Anyone may activate someone else via {activateFor} — sponsoring a friend into the app is a
 *      growth loop, not a threat, because activation grants capability to the recipient only.
 */
contract Activation is IActivation, Ownable {
    using SafeERC20 for IERC20;

    /// @notice The $GRAM token activations are paid in.
    /// @dev Settable by the owner until {lockToken} freezes it. This was `immutable`, which made the
    ///      token the FIRST thing that had to exist rather than the last: pointing the protocol at a
    ///      different token meant redeploying this contract and losing every `activatedAt` entry, so
    ///      every paying user would have had to pay again. See {setToken}.
    IERC20 public THOOD;

    /// @notice True once {lockToken} has frozen {THOOD} permanently.
    bool public tokenLocked;

    /// @notice Destination of 100% of every payment. The 50/50 holder/treasury split happens there.
    IRevenueVault public vault;

    /// @notice Converts the on-chain USD price into $THOOD at purchase time.
    IPriceSource public priceSource;

    /// @notice One-time activation price, denominated in USD with 18 decimals. Default $5.
    uint256 public priceUsd;

    /// @inheritdoc IActivation
    mapping(address user => uint64 at) public activatedAt;

    /// @notice Emitted exactly once per activated account.
    event Activated(address indexed user, address indexed payer, uint256 thoodPaid, uint64 at);
    /// @notice Emitted when the owner grants an activation without payment. Never touches the vault.
    event Granted(address indexed user, uint64 at);
    /// @notice Emitted when the owner changes the one-time USD price.
    event PriceSet(uint256 usd18);
    /// @notice Emitted when the revenue vault address changes.
    event VaultSet(address indexed vault);
    /// @notice Emitted when the price source changes.
    event PriceSourceSet(address indexed priceSource);
    /// @notice Emitted when the payment token changes.
    event TokenSet(address indexed token);
    /// @notice Emitted once, when the payment token is frozen forever.
    event TokenLocked(address indexed token);

    /// @notice Thrown when activating an address that is already activated.
    error AlreadyActivated();
    /// @notice Thrown when a price of zero is supplied.
    error InvalidPrice();
    /// @notice Thrown when an address argument is the zero address.
    error ZeroAddress();
    /// @notice Thrown when a permit call fails and the existing allowance is still insufficient.
    error PermitFailed();
    /// @notice Thrown when the payment token is changed after {lockToken}.
    error TokenIsLocked();

    /**
     * @notice Deploys the activation gate at the default $5 price.
     * @param initialOwner Address allowed to change the price, the price source and the vault.
     * @param thood_ The $THOOD token address.
     * @param priceSource_ The USD to $THOOD price source.
     * @param vault_ The revenue vault that receives 100% of payments.
     */
    constructor(address initialOwner, address thood_, address priceSource_, address vault_) Ownable(initialOwner) {
        if (thood_ == address(0) || priceSource_ == address(0) || vault_ == address(0)) revert ZeroAddress();

        THOOD = IERC20(thood_);
        priceSource = IPriceSource(priceSource_);
        vault = IRevenueVault(vault_);
        priceUsd = 5e18;

        emit PriceSet(5e18);
        emit PriceSourceSet(priceSource_);
        emit VaultSet(vault_);
        emit TokenSet(thood_);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IActivation
    function isActivated(address user) public view returns (bool) {
        return activatedAt[user] != 0;
    }

    /**
     * @notice $THOOD the one-time activation costs right now.
     * @return thoodAmount The $THOOD amount that will be pulled from the payer.
     */
    function quote() public view returns (uint256 thoodAmount) {
        return (priceUsd * priceSource.thoodPerUsd()) / 1e18;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // User actions
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * @notice Activates the caller's account, forever.
     * @dev Requires an allowance of at least {quote}() on $THOOD.
     *      The payment moves directly from the caller to the vault; 100% of it reaches the vault.
     */
    function activate() external {
        _activate(msg.sender, msg.sender);
    }

    /**
     * @notice Activates `user`'s account, paid by the caller. Sponsor a friend in.
     * @dev Activation grants capability to `user` only, so paying for someone else is always safe.
     * @param user The account to activate.
     */
    function activateFor(address user) external {
        if (user == address(0)) revert ZeroAddress();
        _activate(msg.sender, user);
    }

    /**
     * @notice Activates the caller in a single transaction using an EIP-2612 permit signature.
     * @dev If the permit reverts because it was already used or front-run, the call still succeeds
     *      as long as the standing allowance is sufficient — otherwise it reverts with {PermitFailed}.
     * @param value Allowance authorised by the signature.
     * @param deadline Permit deadline.
     * @param v Signature recovery byte.
     * @param r Signature r value.
     * @param s Signature s value.
     */
    function activateWithPermit(uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external {
        try IERC20Permit(address(THOOD)).permit(msg.sender, address(this), value, deadline, v, r, s) {
            // allowance set
        } catch {
            if (THOOD.allowance(msg.sender, address(this)) < value) revert PermitFailed();
        }
        _activate(msg.sender, msg.sender);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Owner
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * @notice Owner may activate an account without payment (team, partners, support).
     * @param user The account to activate.
     */
    function grant(address user) external onlyOwner {
        if (user == address(0)) revert ZeroAddress();
        if (activatedAt[user] != 0) revert AlreadyActivated();

        uint64 at = SafeCast.toUint64(block.timestamp);
        activatedAt[user] = at;

        emit Granted(user, at);
    }

    /**
     * @notice Sets the one-time activation price in USD.
     * @param usd18 Price in USD, 18 decimals. Must be non-zero.
     */
    function setPriceUsd(uint256 usd18) external onlyOwner {
        if (usd18 == 0) revert InvalidPrice();
        priceUsd = usd18;
        emit PriceSet(usd18);
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
     * @notice Sets the revenue vault that receives 100% of activation payments.
     * @param v The new {IRevenueVault}.
     */
    function setVault(address v) external onlyOwner {
        if (v == address(0)) revert ZeroAddress();
        vault = IRevenueVault(v);
        emit VaultSet(v);
    }

    /**
     * @notice Points activations at a different payment token.
     * @dev Existing activations are unaffected: `activatedAt` records that an account was paid for,
     *      not what it was paid in, and activation is permanent. Only the token FUTURE payers are
     *      charged in changes. That is what makes the real token the last piece of a launch instead
     *      of the first.
     *
     *      Call {lockToken} straight after the final swap. An unlocked payment token is an owner
     *      power holders can see, and leaving it unlocked forever is not a neutral choice.
     * @param token The new payment token. Must be non-zero.
     */
    function setToken(address token) external onlyOwner {
        if (tokenLocked) revert TokenIsLocked();
        if (token == address(0)) revert ZeroAddress();
        THOOD = IERC20(token);
        emit TokenSet(token);
    }

    /**
     * @notice Freezes the payment token forever. There is no unlock.
     */
    function lockToken() external onlyOwner {
        tokenLocked = true;
        emit TokenLocked(address(THOOD));
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Internals
    // ─────────────────────────────────────────────────────────────────────────────

    /// @dev Marks `user` activated, then pulls payment from `payer` straight through to the vault.
    function _activate(address payer, address user) internal {
        if (activatedAt[user] != 0) revert AlreadyActivated();

        uint64 at = SafeCast.toUint64(block.timestamp);
        activatedAt[user] = at;

        uint256 thoodAmount = quote();
        IRevenueVault vault_ = vault;
        if (thoodAmount != 0) {
            THOOD.safeTransferFrom(payer, address(vault_), thoodAmount);
        }
        vault_.notifyRevenue(thoodAmount);

        emit Activated(user, payer, thoodAmount, at);
    }
}
