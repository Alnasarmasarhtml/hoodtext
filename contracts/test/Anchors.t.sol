// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {Fixture} from "./utils/Fixture.sol";
import {Anchors} from "../src/Anchors.sol";

/**
 * @title AnchorsTest
 * @notice The message log. Self-posting requires the $5 activation; room drops require the room's
 *         rent to be current (enforced for relayed drops too); batches are relayer-only.
 *         Never payable, never a fee.
 */
contract AnchorsTest is Fixture {
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
    event RelayerSet(address indexed relayer, bool approved);

    bytes32 internal constant ROOM = keccak256("room.alpha");

    function setUp() public {
        _deployProtocol();
        _activateUser(alice);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Self-posting
    // ─────────────────────────────────────────────────────────────────────────────

    function test_Post_RequiresActivation() public {
        vm.prank(bob); // never activated
        vm.expectRevert(Anchors.NotActivated.selector);
        anchors.post(_drop(1));

        assertEq(anchors.seq(), 0, "nothing was anchored");
    }

    function test_Post_StealthDropEmitsExactEventAndBumpsSeq() public {
        Anchors.Drop memory d = _drop(7);

        vm.expectEmit(true, true, true, true, address(anchors));
        emit Dropped(d.convoId, 1, alice, d.ephPub, d.blobRef, d.viewTag, d.size, uint64(_timestamp()));
        vm.prank(alice);
        anchors.post(d);

        assertEq(anchors.seq(), 1, "the first drop has sequence 1");

        vm.prank(alice);
        anchors.post(_drop(8));
        assertEq(anchors.seq(), 2, "seq is strictly monotonic");
    }

    function test_Post_ActivationIsForeverSoPostingNeverLapses() public {
        _warpForward(3650 days);
        vm.prank(alice);
        anchors.post(_drop(1));
        assertEq(anchors.seq(), 1, "ten years later the $5 handshake still holds");
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Room drops and rent
    // ─────────────────────────────────────────────────────────────────────────────

    function test_Post_RoomDropRequiresExistingActiveRoom() public {
        vm.prank(alice);
        vm.expectRevert(Anchors.RoomInactive.selector);
        anchors.post(_roomDrop(ROOM, 1)); // room does not exist yet

        _createRoom(alice, ROOM, 1);
        vm.prank(alice);
        anchors.post(_roomDrop(ROOM, 1));
        assertEq(anchors.seq(), 1);
    }

    function test_Post_RoomDropBlockedTheSecondRentLapses() public {
        _createRoom(alice, ROOM, 1);
        uint64 paidUntil = _paidUntil(ROOM);

        vm.warp(uint256(paidUntil) - 1);
        vm.prank(alice);
        anchors.post(_roomDrop(ROOM, 1)); // one second before lapse: fine

        vm.warp(uint256(paidUntil));
        vm.prank(alice);
        vm.expectRevert(Anchors.RoomInactive.selector);
        anchors.post(_roomDrop(ROOM, 2)); // the exact lapse second: blocked

        // Rent is paid again — the room reopens exactly as it was.
        _payRent(alice, ROOM, 1);
        vm.prank(alice);
        anchors.post(_roomDrop(ROOM, 3));
        assertEq(anchors.seq(), 2);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Relayed batches
    // ─────────────────────────────────────────────────────────────────────────────

    function test_PostBatch_OnlyApprovedRelayer() public {
        Anchors.Drop[] memory batch = new Anchors.Drop[](1);
        batch[0] = _drop(1);

        vm.prank(alice); // activated, but not a relayer
        vm.expectRevert(Anchors.NotRelayer.selector);
        anchors.postBatch(batch);

        vm.prank(relay);
        anchors.postBatch(batch);
        assertEq(anchors.seq(), 1);
    }

    function test_PostBatch_SeqIsContinuousAcrossPostAndBatch() public {
        vm.prank(alice);
        anchors.post(_drop(1)); // seq 1

        Anchors.Drop[] memory batch = new Anchors.Drop[](3);
        batch[0] = _drop(2);
        batch[1] = _drop(3);
        batch[2] = _drop(4);

        // Each batched drop gets its own sequence number, in order.
        vm.expectEmit(true, true, true, true, address(anchors));
        emit Dropped(batch[0].convoId, 2, relay, batch[0].ephPub, batch[0].blobRef, batch[0].viewTag, batch[0].size, uint64(_timestamp()));
        vm.expectEmit(true, true, true, true, address(anchors));
        emit Dropped(batch[1].convoId, 3, relay, batch[1].ephPub, batch[1].blobRef, batch[1].viewTag, batch[1].size, uint64(_timestamp()));
        vm.expectEmit(true, true, true, true, address(anchors));
        emit Dropped(batch[2].convoId, 4, relay, batch[2].ephPub, batch[2].blobRef, batch[2].viewTag, batch[2].size, uint64(_timestamp()));

        vm.prank(relay);
        anchors.postBatch(batch);

        assertEq(anchors.seq(), 4);

        vm.prank(alice);
        anchors.post(_drop(5));
        assertEq(anchors.seq(), 5, "self-posts continue where the batch left off");
    }

    function test_PostBatch_SizeBounds() public {
        Anchors.Drop[] memory empty = new Anchors.Drop[](0);
        vm.prank(relay);
        vm.expectRevert(Anchors.EmptyBatch.selector);
        anchors.postBatch(empty);

        Anchors.Drop[] memory tooBig = new Anchors.Drop[](65);
        for (uint256 i = 0; i < 65; ++i) {
            tooBig[i] = _drop(i);
        }
        vm.prank(relay);
        vm.expectRevert(Anchors.BatchTooLarge.selector);
        anchors.postBatch(tooBig);

        Anchors.Drop[] memory maxed = new Anchors.Drop[](64);
        for (uint256 i = 0; i < 64; ++i) {
            maxed[i] = _drop(i);
        }
        vm.prank(relay);
        anchors.postBatch(maxed);
        assertEq(anchors.seq(), 64, "exactly MAX_BATCH fits");
    }

    function test_PostBatch_EnforcesRoomRentPerDrop() public {
        _createRoom(alice, ROOM, 1);
        _warpForward(60 days); // room lapses

        Anchors.Drop[] memory batch = new Anchors.Drop[](2);
        batch[0] = _drop(1); // stealth: fine
        batch[1] = _roomDrop(ROOM, 2); // lapsed room: poison

        vm.prank(relay);
        vm.expectRevert(Anchors.RoomInactive.selector);
        anchors.postBatch(batch);

        assertEq(anchors.seq(), 0, "a lapsed room cannot be posted into, even through the relay");
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Owner
    // ─────────────────────────────────────────────────────────────────────────────

    function test_SetRelayer_ApproveAndRevoke() public {
        vm.expectEmit(true, false, false, true, address(anchors));
        emit RelayerSet(eve, true);
        vm.prank(owner);
        anchors.setRelayer(eve, true);
        assertTrue(anchors.isRelayer(eve));

        vm.prank(owner);
        anchors.setRelayer(eve, false);
        assertFalse(anchors.isRelayer(eve));

        Anchors.Drop[] memory batch = new Anchors.Drop[](1);
        batch[0] = _drop(1);
        vm.prank(eve);
        vm.expectRevert(Anchors.NotRelayer.selector);
        anchors.postBatch(batch);
    }

    function test_AccessControl_OwnerOnlySetters() public {
        bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice);

        vm.startPrank(alice);
        vm.expectRevert(err);
        anchors.setRelayer(alice, true);
        vm.expectRevert(err);
        anchors.setActivation(alice);
        vm.expectRevert(err);
        anchors.setRooms(alice);
        vm.stopPrank();

        vm.startPrank(owner);
        vm.expectRevert(Anchors.ZeroAddress.selector);
        anchors.setRelayer(address(0), true);
        vm.expectRevert(Anchors.ZeroAddress.selector);
        anchors.setActivation(address(0));
        vm.expectRevert(Anchors.ZeroAddress.selector);
        anchors.setRooms(address(0));
        vm.stopPrank();
    }
}
