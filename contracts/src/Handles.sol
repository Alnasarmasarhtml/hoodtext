// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IActivation, IPerks} from "./interfaces/ITeleHood.sol";

/**
 * @title Handles
 * @notice @names. Every activated account may claim one — free, included in the $5 handshake.
 *         Short names are the scarce flex, reserved by holder perk tier:
 *
 *           length 5..15   any activated account
 *           length 4       BLOCK CAPTAIN (perk tier 2) and up
 *           length 3       DISTRICT      (perk tier 3) and up
 *           length 2       KINGPIN       (perk tier 4)
 *
 * @dev Rules: lowercase `a-z`, digits and `_` only; must start with a letter; 2..15 bytes.
 *      One handle per address. Claiming a new one releases the old one back into the pool.
 *      A handle is a pointer, not a key: messages are addressed to X25519 keys from {KeyRegistry},
 *      the handle only tells humans which address to fetch keys for.
 *
 *      The perk gate is checked at CLAIM time only. A KINGPIN who later sells keeps their 2-char
 *      handle — status earned is not clawed back, and re-checking on every message would let a
 *      falling balance break identity mid-conversation.
 */
contract Handles {
    /// @notice Minimum handle length in bytes.
    uint256 public constant MIN_LENGTH = 2;
    /// @notice Maximum handle length in bytes.
    uint256 public constant MAX_LENGTH = 15;

    /// @notice The one-time account gate; only activated accounts claim handles.
    IActivation public immutable ACTIVATION;

    /// @notice Holder perk tiers, gating short-name claims.
    IPerks public immutable PERKS;

    /// @dev Handle string by owner address.
    mapping(address user => string handle) private _handleOf;

    /// @notice Owner address by keccak256 of the handle string. Zero when free.
    mapping(bytes32 nameHash => address owner) public ownerOfHash;

    /// @notice Emitted when a handle is claimed (and, implicitly, the claimer's old one released).
    event HandleClaimed(address indexed user, string handle);
    /// @notice Emitted when a handle is released back into the pool.
    event HandleReleased(address indexed user, string handle);

    /// @notice Thrown when the caller has not activated an account.
    error NotActivated();
    /// @notice Thrown when the name violates the character or length rules.
    error InvalidHandle();
    /// @notice Thrown when the name is already owned.
    error HandleTaken();
    /// @notice Thrown when the caller's perk tier does not cover a name this short.
    error TierTooLow();
    /// @notice Thrown when releasing without owning a handle.
    error NoHandle();
    /// @notice Thrown when an address argument is the zero address.
    error ZeroAddress();

    /**
     * @notice Deploys the handle registry.
     * @param activation_ The {IActivation} account gate.
     * @param perks_ The {IPerks} tier source for short-name gating.
     */
    constructor(address activation_, address perks_) {
        if (activation_ == address(0) || perks_ == address(0)) revert ZeroAddress();
        ACTIVATION = IActivation(activation_);
        PERKS = IPerks(perks_);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * @notice The handle owned by `user`, or the empty string.
     * @param user The address to look up.
     * @return The handle string.
     */
    function handleOf(address user) external view returns (string memory) {
        return _handleOf[user];
    }

    /**
     * @notice The owner of `name`, or the zero address when it is free.
     * @param name The handle string to look up.
     * @return The owning address.
     */
    function addressOf(string calldata name) external view returns (address) {
        return ownerOfHash[keccak256(bytes(name))];
    }

    /**
     * @notice The minimum perk tier required to claim a name of `length` bytes.
     * @param length The name length.
     * @return The required tier (0 means any activated account; reverts on out-of-range lengths).
     */
    function requiredTier(uint256 length) public pure returns (uint8) {
        if (length < MIN_LENGTH || length > MAX_LENGTH) revert InvalidHandle();
        if (length >= 5) return 0;
        if (length == 4) return 2;
        if (length == 3) return 3;
        return 4;
    }

    /**
     * @notice Whether `name` is well-formed: 2..15 bytes, `a-z` `0-9` `_`, starting with a letter.
     * @param name The candidate handle.
     * @return True when the name passes every rule.
     */
    function isValidName(string memory name) public pure returns (bool) {
        bytes memory b = bytes(name);
        uint256 len = b.length;
        if (len < MIN_LENGTH || len > MAX_LENGTH) return false;

        bytes1 first = b[0];
        if (first < 0x61 || first > 0x7A) return false; // a-z

        for (uint256 i = 1; i < len; ++i) {
            bytes1 c = b[i];
            bool ok = (c >= 0x61 && c <= 0x7A) // a-z
                || (c >= 0x30 && c <= 0x39) // 0-9
                || c == 0x5F; // _
            if (!ok) return false;
        }
        return true;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Actions
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * @notice Claims `name` for the caller, releasing any handle they already own.
     * @dev Free — the $5 activation covered it. Short names check the caller's live perk tier.
     * @param name The handle to claim.
     */
    function claim(string calldata name) external {
        if (!ACTIVATION.isActivated(msg.sender)) revert NotActivated();
        if (!isValidName(name)) revert InvalidHandle();

        uint8 required = requiredTier(bytes(name).length);
        if (required != 0 && PERKS.tierOf(msg.sender) < required) revert TierTooLow();

        bytes32 nameHash = keccak256(bytes(name));
        if (ownerOfHash[nameHash] != address(0)) revert HandleTaken();

        string memory old = _handleOf[msg.sender];
        if (bytes(old).length != 0) {
            delete ownerOfHash[keccak256(bytes(old))];
            emit HandleReleased(msg.sender, old);
        }

        ownerOfHash[nameHash] = msg.sender;
        _handleOf[msg.sender] = name;

        emit HandleClaimed(msg.sender, name);
    }

    /// @notice Releases the caller's handle back into the pool.
    function release() external {
        string memory old = _handleOf[msg.sender];
        if (bytes(old).length == 0) revert NoHandle();

        delete ownerOfHash[keccak256(bytes(old))];
        delete _handleOf[msg.sender];

        emit HandleReleased(msg.sender, old);
    }
}
