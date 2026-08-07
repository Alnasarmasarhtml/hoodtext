// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IActivation, IRooms} from "./interfaces/IHoodGram.sol";

/**
 * @title Anchors
 * @notice The message log. Every HoodGram message is anchored here as a fixed-shape drop.
 *
 * @dev **Not payable. There is no per-message fee, ever.** Gating:
 *
 *      - {post} requires the sender to have an activated account (the $5 one-time handshake), and —
 *        when the drop targets a room — that the room's rent is current. Self-posting costs gas
 *        only and puts the poster's address on chain.
 *      - {postBatch} is restricted to owner-approved relayers. The relay verifies each sender's
 *        identity signature and activation OFF-chain before batching, then posts on their behalf —
 *        which is what makes sending feel instant, free, and keeps the sender's address off chain.
 *        Room rent is still enforced on-chain per drop, so a lapsed room cannot be posted into
 *        through the relay either.
 *
 *      Nothing readable is stored on chain. `blobRef` is the sha256 of a padded, sealed envelope
 *      held off-chain; `ephPub` is a per-message ephemeral X25519 public key; `viewTag` is a
 *      one-byte scan filter derived from the shared secret so recipients can find their own drops
 *      without the plaintext recipient ever appearing on chain; `size` is a padded bucket size, so
 *      message length leaks nothing.
 */
contract Anchors is Ownable {
    /// @notice Maximum number of drops in a single {postBatch} call.
    uint256 public constant MAX_BATCH = 64;

    /// @notice The one-time account gate used for self-posting.
    IActivation public activation;

    /// @notice The room registry consulted for rent status on room drops.
    IRooms public rooms;

    /// @notice Addresses allowed to {postBatch} on behalf of verified senders.
    mapping(address relayer => bool approved) public isRelayer;

    /// @notice Monotonically increasing drop counter. The first drop has sequence 1.
    uint64 public seq;

    /// @notice A single anchored message.
    struct Drop {
        /// @dev 0x0 for stealth 1:1 drops; the group id for room drops.
        bytes32 convoId;
        /// @dev Ephemeral X25519 public key (32 zero bytes for room sender-key drops).
        bytes32 ephPub;
        /// @dev sha256 of the ciphertext envelope stored off-chain.
        bytes32 blobRef;
        /// @dev Shared-secret scan filter, one byte.
        uint8 viewTag;
        /// @dev Padded bucket size in bytes.
        uint32 size;
    }

    /// @notice Emitted for every anchored drop. This is the event the relay indexes.
    event Dropped(
        bytes32 indexed convoId,
        uint64 indexed seq,
        address indexed poster,
        bytes32 ephPub,
        bytes32 blobRef,
        uint8 viewTag,
        uint32 size,
        uint64 timestamp
    );

    /// @notice Emitted when the activation gate address changes.
    event ActivationSet(address indexed activation);
    /// @notice Emitted when the room registry address changes.
    event RoomsSet(address indexed rooms);
    /// @notice Emitted when a relayer is approved or revoked.
    event RelayerSet(address indexed relayer, bool approved);

    /// @notice Thrown when the poster has not activated an account.
    error NotActivated();
    /// @notice Thrown when a room drop targets a room that does not exist or whose rent has lapsed.
    error RoomInactive();
    /// @notice Thrown when {postBatch} is called by anyone but an approved relayer.
    error NotRelayer();
    /// @notice Thrown when {postBatch} is called with an empty array.
    error EmptyBatch();
    /// @notice Thrown when {postBatch} exceeds {MAX_BATCH}.
    error BatchTooLarge();
    /// @notice Thrown when an address argument is the zero address.
    error ZeroAddress();

    /**
     * @notice Deploys the message log.
     * @param initialOwner Address allowed to swap the gates and manage relayers.
     * @param activation_ The {IActivation} account gate.
     * @param rooms_ The {IRooms} registry for rent checks.
     */
    constructor(address initialOwner, address activation_, address rooms_) Ownable(initialOwner) {
        if (activation_ == address(0) || rooms_ == address(0)) revert ZeroAddress();
        activation = IActivation(activation_);
        rooms = IRooms(rooms_);
        emit ActivationSet(activation_);
        emit RoomsSet(rooms_);
    }

    /**
     * @notice Anchors one message, from the sender's own address. Requires an activated account.
     * @dev Costs gas only — this function is not payable and charges no fee. Room drops additionally
     *      require the room's rent to be current.
     * @param d The drop to anchor.
     */
    function post(Drop calldata d) external {
        if (!activation.isActivated(msg.sender)) revert NotActivated();
        if (d.convoId != bytes32(0) && !rooms.isActive(d.convoId)) revert RoomInactive();

        uint64 next = seq + 1;
        seq = next;

        emit Dropped(d.convoId, next, msg.sender, d.ephPub, d.blobRef, d.viewTag, d.size, uint64(block.timestamp));
    }

    /**
     * @notice Anchors up to {MAX_BATCH} messages in one transaction, as an approved relayer.
     * @dev The relay verifies sender identity signatures and activation off-chain before batching;
     *      on-chain, room rent is still enforced per drop. Relayed posting is what keeps senders'
     *      addresses off chain and their messages free to send. Not payable, no fee.
     * @param d The drops to anchor, in order.
     */
    function postBatch(Drop[] calldata d) external {
        if (!isRelayer[msg.sender]) revert NotRelayer();

        uint256 n = d.length;
        if (n == 0) revert EmptyBatch();
        if (n > MAX_BATCH) revert BatchTooLarge();

        IRooms rooms_ = rooms;
        uint64 next = seq;
        uint64 ts = uint64(block.timestamp);

        for (uint256 i = 0; i < n; ++i) {
            Drop calldata drop = d[i];
            if (drop.convoId != bytes32(0) && !rooms_.isActive(drop.convoId)) revert RoomInactive();
            next += 1;
            emit Dropped(drop.convoId, next, msg.sender, drop.ephPub, drop.blobRef, drop.viewTag, drop.size, ts);
        }

        seq = next;
    }

    /**
     * @notice Approves or revokes a batch-posting relayer.
     * @param relayer The relayer address.
     * @param approved True to approve, false to revoke.
     */
    function setRelayer(address relayer, bool approved) external onlyOwner {
        if (relayer == address(0)) revert ZeroAddress();
        isRelayer[relayer] = approved;
        emit RelayerSet(relayer, approved);
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
     * @notice Swaps the room registry.
     * @param r The new {IRooms}.
     */
    function setRooms(address r) external onlyOwner {
        if (r == address(0)) revert ZeroAddress();
        rooms = IRooms(r);
        emit RoomsSet(r);
    }
}
