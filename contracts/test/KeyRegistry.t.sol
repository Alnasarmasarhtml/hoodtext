// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Fixture} from "./utils/Fixture.sol";
import {KeyRegistry} from "../src/KeyRegistry.sol";

/**
 * @title KeyRegistryTest
 * @notice Identity keys are free and ungated: you must be able to receive before you have ever paid.
 */
contract KeyRegistryTest is Fixture {
    event KeysRegistered(address indexed user, bytes32 x25519Pub, bytes32 ed25519Pub, uint64 at);

    bytes32 internal constant X_PUB = keccak256("x25519.alice");
    bytes32 internal constant E_PUB = keccak256("ed25519.alice");

    function setUp() public {
        _deployProtocol();
    }

    function test_Register_StoresBothKeys() public {
        vm.prank(alice);
        keyRegistry.register(X_PUB, E_PUB);

        (bytes32 x, bytes32 e, uint64 at) = keyRegistry.keysOf(alice);
        assertEq(x, X_PUB);
        assertEq(e, E_PUB);
        assertEq(at, uint64(_timestamp()));
        assertTrue(keyRegistry.isRegistered(alice));
    }

    function test_Register_EmitsEvent() public {
        vm.expectEmit(true, false, false, true, address(keyRegistry));
        emit KeysRegistered(alice, X_PUB, E_PUB, uint64(_timestamp()));
        vm.prank(alice);
        keyRegistry.register(X_PUB, E_PUB);
    }

    function test_Register_IsFreeWithoutActivation() public {
        assertFalse(activation.isActivated(alice));

        vm.prank(alice);
        keyRegistry.register(X_PUB, E_PUB);

        assertTrue(keyRegistry.isRegistered(alice), "receiving never requires paying");
        assertEq(token.balanceOf(alice), 0, "and it costs no $THOOD");
        assertEq(token.balanceOf(address(vault)), 0);
    }

    function test_Register_AlsoWorksForActivatedAccounts() public {
        _activateUser(alice);
        assertTrue(activation.isActivated(alice));

        vm.prank(alice);
        keyRegistry.register(X_PUB, E_PUB);
        assertTrue(keyRegistry.isRegistered(alice));
    }

    function test_ReRegisterRotatesKeys() public {
        vm.prank(alice);
        keyRegistry.register(X_PUB, E_PUB);

        _warpForward(1 days);
        bytes32 x2 = keccak256("x25519.alice.rotated");
        bytes32 e2 = keccak256("ed25519.alice.rotated");

        vm.prank(alice);
        keyRegistry.register(x2, e2);

        (bytes32 x, bytes32 e, uint64 at) = keyRegistry.keysOf(alice);
        assertEq(x, x2);
        assertEq(e, e2);
        assertEq(at, uint64(_timestamp()));
    }

    function test_Register_RejectsZeroKeys() public {
        vm.startPrank(alice);
        vm.expectRevert(KeyRegistry.InvalidKey.selector);
        keyRegistry.register(bytes32(0), E_PUB);

        vm.expectRevert(KeyRegistry.InvalidKey.selector);
        keyRegistry.register(X_PUB, bytes32(0));

        vm.expectRevert(KeyRegistry.InvalidKey.selector);
        keyRegistry.register(bytes32(0), bytes32(0));
        vm.stopPrank();

        assertFalse(keyRegistry.isRegistered(alice));
    }

    function test_IsRegisteredIsFalseByDefault() public view {
        assertFalse(keyRegistry.isRegistered(eve));
        (bytes32 x, bytes32 e, uint64 at) = keyRegistry.keysOf(eve);
        assertEq(x, bytes32(0));
        assertEq(e, bytes32(0));
        assertEq(at, 0);
    }

    function test_RegistrationsAreIndependentPerAddress() public {
        vm.prank(alice);
        keyRegistry.register(X_PUB, E_PUB);

        bytes32 bx = keccak256("x25519.bob");
        bytes32 be = keccak256("ed25519.bob");
        vm.prank(bob);
        keyRegistry.register(bx, be);

        (bytes32 x,,) = keyRegistry.keysOf(alice);
        (bytes32 x2,,) = keyRegistry.keysOf(bob);
        assertEq(x, X_PUB);
        assertEq(x2, bx);
    }
}
