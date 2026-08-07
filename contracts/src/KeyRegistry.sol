// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title KeyRegistry
 * @notice Publishes the public halves of a user's HoodGram identity: an X25519 key for encryption
 *         and an Ed25519 key for signing.
 *
 * @dev Deliberately free and ungated. You must be able to *receive* messages before you have ever
 *      paid for anything, and a lapsed subscriber must never lose the ability to be written to.
 *      Re-registering simply rotates the keys.
 *
 *      Only public keys live here. Private keys are derived client-side from a wallet signature and
 *      never leave the device.
 */
contract KeyRegistry {
    /// @notice A user's published public keys.
    struct Keys {
        /// @dev X25519 public key used for `crypto_box` encryption.
        bytes32 x25519;
        /// @dev Ed25519 public key used for signatures.
        bytes32 ed25519;
        /// @dev Timestamp of the last registration. Non-zero means registered.
        uint64 updatedAt;
    }

    /// @notice Published keys per address.
    mapping(address user => Keys keys) public keysOf;

    /// @notice Emitted on first registration and on every rotation.
    event KeysRegistered(address indexed user, bytes32 x25519Pub, bytes32 ed25519Pub, uint64 at);

    /// @notice Thrown when either public key is the zero value.
    error InvalidKey();

    /**
     * @notice Publishes or rotates the caller's public keys.
     * @param x25519Pub X25519 public key (32 bytes) used to encrypt to this user.
     * @param ed25519Pub Ed25519 public key (32 bytes) used to verify this user's signatures.
     */
    function register(bytes32 x25519Pub, bytes32 ed25519Pub) external {
        if (x25519Pub == bytes32(0) || ed25519Pub == bytes32(0)) revert InvalidKey();

        uint64 at = uint64(block.timestamp);
        keysOf[msg.sender] = Keys({x25519: x25519Pub, ed25519: ed25519Pub, updatedAt: at});

        emit KeysRegistered(msg.sender, x25519Pub, ed25519Pub, at);
    }

    /**
     * @notice Whether `user` has ever published keys.
     * @param user The address to check.
     * @return True once {register} has been called by that address.
     */
    function isRegistered(address user) external view returns (bool) {
        return keysOf[user].updatedAt != 0;
    }
}
