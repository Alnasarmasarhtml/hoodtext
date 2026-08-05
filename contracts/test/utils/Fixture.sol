// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";

import {TeleHoodToken} from "../../src/TeleHoodToken.sol";
import {ManualPriceSource} from "../../src/ManualPriceSource.sol";
import {RevenueVault} from "../../src/RevenueVault.sol";
import {Activation} from "../../src/Activation.sol";
import {GroupRegistry} from "../../src/GroupRegistry.sol";
import {KeyRegistry} from "../../src/KeyRegistry.sol";
import {Anchors} from "../../src/Anchors.sol";
import {Perks} from "../../src/Perks.sol";
import {Handles} from "../../src/Handles.sol";

/**
 * @title Fixture
 * @notice Shared deployment + assertion helpers for the TeleHood Foundry suite.
 *
 * @dev Deploys and wires the protocol exactly the way `script/Deploy.s.sol` does, so every test
 *      runs against the real production topology: 100% of payments land in the vault, the
 *      treasury / vault addresses are excluded from revenue, the relay address is an approved
 *      batch poster, and the default prices ($5 activation, $10/month rent) are in force.
 *
 *      {_assertSolvent} recomputes the solvency invariant from scratch (it does NOT trust the
 *      contract's own `sealedUnclaimed` accumulator — it also cross-checks it) and is called after
 *      every state-changing vault operation in the suite.
 */
abstract contract Fixture is Test {
    /// @dev Realistic starting timestamp so `warp` arithmetic never underflows.
    uint256 internal constant START_TIME = 1_800_000_000;
    /// @dev Starting block, high enough that the vault's `block.number - 1` snapshot is always valid.
    uint256 internal constant START_BLOCK = 1_000;
    /// @dev 1,000 $THOOD per US dollar.
    uint256 internal constant INITIAL_RATE = 1000e18;

    /// @dev $5 one-time activation, in USD 18dp.
    uint256 internal constant PRICE_ACTIVATION = 5e18;
    /// @dev $10/month room rent, in USD 18dp.
    uint256 internal constant RENT_PER_MONTH = 10e18;

    uint64 internal constant MONTH = 30 days;

    TeleHoodToken internal token;
    ManualPriceSource internal priceSource;
    RevenueVault internal vault;
    Activation internal activation;
    GroupRegistry internal groupRegistry;
    KeyRegistry internal keyRegistry;
    Anchors internal anchors;
    Perks internal perks;
    Handles internal handles;

    address internal owner;
    address internal treasury;
    address internal relay;
    address internal alice;
    address internal bob;
    address internal carol;
    address internal dave;
    address internal eve;
    address internal keeper;

    // ─────────────────────────────────────────────────────────────────────────────
    // Deployment
    // ─────────────────────────────────────────────────────────────────────────────

    /// @dev Deploys and wires the whole protocol, mirroring `script/Deploy.s.sol`.
    function _deployProtocol() internal {
        owner = makeAddr("owner");
        treasury = makeAddr("treasury");
        relay = makeAddr("relay");
        alice = makeAddr("alice");
        bob = makeAddr("bob");
        carol = makeAddr("carol");
        dave = makeAddr("dave");
        eve = makeAddr("eve");
        keeper = makeAddr("keeper");

        vm.warp(START_TIME);
        vm.roll(START_BLOCK);

        token = new TeleHoodToken(treasury);
        priceSource = new ManualPriceSource(owner, INITIAL_RATE);
        vault = new RevenueVault(owner, address(token), treasury);
        activation = new Activation(owner, address(token), address(priceSource), address(vault));
        groupRegistry =
            new GroupRegistry(owner, address(token), address(activation), address(priceSource), address(vault));
        keyRegistry = new KeyRegistry();
        anchors = new Anchors(owner, address(activation), address(groupRegistry));
        perks = new Perks(owner, address(token), address(vault));
        handles = new Handles(address(activation), address(perks));

        vm.startPrank(owner);
        vault.setNotifier(address(activation), true);
        vault.setNotifier(address(groupRegistry), true);
        anchors.setRelayer(relay, true);
        vault.setExcluded(treasury, true);
        vault.setExcluded(address(vault), true);
        vm.stopPrank();

        vm.label(address(token), "THOOD");
        vm.label(address(vault), "RevenueVault");
        vm.label(address(activation), "Activation");
        vm.label(address(groupRegistry), "GroupRegistry");
        vm.label(address(anchors), "Anchors");
        vm.label(address(perks), "Perks");
        vm.label(address(handles), "Handles");

        // Move one block on so every checkpoint written during deployment is queryable.
        _rollForward(1);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Pipeline-safe clock reads
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * @dev Current block number, read through the cheatcode boundary.
     *
     *      NEVER capture plain `block.number` into a local that is compared after a `vm.roll`.
     *      Solidity is entitled to assume `NUMBER` is constant for the whole transaction, so the
     *      via-IR pipeline coalesces repeated reads and rematerialises the opcode at the point of
     *      *use* — a cheatcode that moves the block mid-execution then silently rewrites the value
     *      the local appears to hold. The legacy pipeline happens to emit a fresh `NUMBER` per read,
     *      which is why the same test can pass with `via_ir = false` and fail with `via_ir = true`
     *      (and under `forge coverage`, which compiles via IR).
     *
     *      A cheatcode call returns a real runtime value that cannot be moved or coalesced, so this
     *      is correct under every pipeline.
     */
    function _blockNumber() internal view returns (uint256) {
        return vm.getBlockNumber();
    }

    /// @dev Current timestamp, read through the cheatcode boundary. See {_blockNumber} for why.
    function _timestamp() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    /// @dev Mines `blocks` blocks. Reading `block.number` to build the argument is unsafe for the
    ///      reason in {_blockNumber}: coalesced reads make repeated `vm.roll(block.number + 1)`
    ///      calls all target the same height, so the chain silently stops advancing.
    function _rollForward(uint256 blocks) internal {
        vm.roll(vm.getBlockNumber() + blocks);
    }

    /// @dev Advances the clock by `secs` seconds. See {_rollForward}.
    function _warpForward(uint256 secs) internal {
        vm.warp(vm.getBlockTimestamp() + secs);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Money helpers
    // ─────────────────────────────────────────────────────────────────────────────

    /// @dev Sends `amount` $THOOD from the treasury to `to`.
    function _fund(address to, uint256 amount) internal {
        vm.prank(treasury);
        token.transfer(to, amount);
    }

    /// @dev Funds `user` with exactly the activation quote, then activates. Net balance change zero.
    function _activateUser(address user) internal returns (uint256 paid) {
        paid = activation.quote();
        _fund(user, paid);
        vm.startPrank(user);
        token.approve(address(activation), paid);
        activation.activate();
        vm.stopPrank();
    }

    /// @dev Funds `user` with exactly the rent quote and creates room `groupId`.
    function _createRoom(address user, bytes32 groupId, uint8 months) internal returns (uint256 paid) {
        paid = groupRegistry.quoteRent(months);
        _fund(user, paid);
        vm.startPrank(user);
        token.approve(address(groupRegistry), paid);
        groupRegistry.createGroup(groupId, keccak256(abi.encodePacked("root", groupId)), months);
        vm.stopPrank();
    }

    /// @dev Funds `payer` with exactly the rent quote and pays rent on `groupId`.
    function _payRent(address payer, bytes32 groupId, uint8 months) internal returns (uint256 paid) {
        paid = groupRegistry.quoteRent(months);
        _fund(payer, paid);
        vm.startPrank(payer);
        token.approve(address(groupRegistry), paid);
        groupRegistry.payRent(groupId, months);
        vm.stopPrank();
    }

    /// @dev Simulates a payment arriving at the vault, exactly as {Activation}/{GroupRegistry} do it.
    function _revenue(uint256 amount) internal {
        if (amount != 0) {
            vm.prank(treasury);
            token.transfer(address(vault), amount);
        }
        vm.prank(address(activation));
        vault.notifyRevenue(amount);
        _assertSolvent();
    }

    /// @dev Warps past `EPOCH_MIN_INTERVAL`, rolls a block, and seals.
    function _warpAndSeal() internal returns (uint256 epochId) {
        _warpForward(7 days);
        _rollForward(1);
        epochId = vault.sealEpoch();
        _assertSolvent();
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Invariants
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * @dev THE SOLVENCY INVARIANT:
     *      `THOOD.balanceOf(vault) >= treasuryAccrued + pendingHolders + Σ (holderAmount - claimed)`
     *      over every unswept epoch. Recomputed independently from epoch storage on every call.
     */
    function _assertSolvent() internal view {
        uint256 unswept = _unsweptUnclaimed();
        uint256 obligations = vault.treasuryAccrued() + vault.pendingHolders() + unswept;
        assertGe(token.balanceOf(address(vault)), obligations, "SOLVENCY INVARIANT VIOLATED");
        assertEq(vault.sealedUnclaimed(), unswept, "sealedUnclaimed accumulator drifted");
        assertTrue(vault.isSolvent(), "vault reports itself insolvent");
    }

    /// @dev Sum over unswept epochs of `holderAmount - claimed`, read straight from storage.
    function _unsweptUnclaimed() internal view returns (uint256 total) {
        uint256 n = vault.epochCount();
        for (uint256 i = 0; i < n; ++i) {
            (,, uint256 holderAmount,, uint256 claimed, bool swept) = vault.epochs(i);
            if (!swept) {
                total += holderAmount - claimed;
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Reads
    // ─────────────────────────────────────────────────────────────────────────────

    /// @dev The `paidUntil` timestamp stored for `groupId`.
    function _paidUntil(bytes32 groupId) internal view returns (uint64 paidUntil) {
        (,,,, paidUntil,,) = groupRegistry.groups(groupId);
    }

    /// @dev The admin stored for `groupId`.
    function _adminOf(bytes32 groupId) internal view returns (address admin) {
        (admin,,,,,,) = groupRegistry.groups(groupId);
    }

    /// @dev EIP-2612 permit type hash.
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    /// @dev Signs an EIP-2612 permit for $THOOD.
    function _permitSig(uint256 pk, address signer, address spender, uint256 value, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, signer, spender, value, token.nonces(signer), deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (v, r, s) = vm.sign(pk, digest);
    }

    /// @dev Builds a deterministic stealth (1:1) drop for anchor tests.
    function _drop(uint256 n) internal pure returns (Anchors.Drop memory d) {
        d = Anchors.Drop({
            convoId: bytes32(0),
            ephPub: keccak256(abi.encodePacked("eph", n)),
            blobRef: keccak256(abi.encodePacked("blob", n)),
            viewTag: uint8(n % 256),
            size: uint32(256 + (n % 4) * 1024)
        });
    }

    /// @dev Builds a deterministic room drop for anchor tests.
    function _roomDrop(bytes32 groupId, uint256 n) internal pure returns (Anchors.Drop memory d) {
        d = _drop(n);
        d.convoId = groupId;
        d.ephPub = bytes32(0);
    }
}
