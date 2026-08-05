// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {TeleHoodToken} from "../src/TeleHoodToken.sol";
import {ManualPriceSource} from "../src/ManualPriceSource.sol";
import {RevenueVault} from "../src/RevenueVault.sol";
import {Activation} from "../src/Activation.sol";
import {GroupRegistry} from "../src/GroupRegistry.sol";
import {KeyRegistry} from "../src/KeyRegistry.sol";
import {Anchors} from "../src/Anchors.sol";
import {Perks} from "../src/Perks.sol";
import {Handles} from "../src/Handles.sol";

/**
 * @title Deploy
 * @notice Deploys and fully wires the TeleHood protocol, then writes every address to
 *         `./deployments/<chainid>.json`.
 *
 * @dev Order: TeleHoodToken -> ManualPriceSource -> RevenueVault -> Activation -> GroupRegistry ->
 *      KeyRegistry -> Anchors -> Perks -> Handles. Then the cross-wiring, the revenue exclusions
 *      and the relayer approval.
 *
 *      Environment (all optional, sensible defaults for local anvil):
 *        DEPLOYER_PRIVATE_KEY   hex private key to broadcast with; falls back to `--private-key`/`--sender`
 *        TREASURY_ADDRESS       receives the full $THOOD supply and the treasury half of revenue
 *        OWNER_ADDRESS          final owner; ownership is transferred after wiring if it differs
 *        RELAYER_ADDRESS        approved for Anchors.postBatch (the gasless-send relay)
 *        INITIAL_THOOD_PER_USD  starting $THOOD-per-dollar rate, 18dp (default 1000e18)
 *
 *      Usage:
 *        forge script script/Deploy.s.sol:Deploy --rpc-url local --broadcast
 */
contract Deploy is Script {
    /// @dev Default starting rate: 1,000 $THOOD per US dollar.
    uint256 internal constant DEFAULT_THOOD_PER_USD = 1000e18;

    /// @notice Every deployed address, returned for use by other scripts and tests.
    struct Deployment {
        address token;
        address priceSource;
        address revenueVault;
        address activation;
        address groupRegistry;
        address keyRegistry;
        address anchors;
        address perks;
        address handles;
    }

    /// @dev Environment-derived configuration, kept in memory to stay off the stack.
    struct Config {
        address deployer;
        address treasury;
        address finalOwner;
        address relayer;
        uint256 rate;
    }

    /**
     * @notice Deploys the whole protocol and writes `./deployments/<chainid>.json`.
     * @return d The deployed addresses.
     */
    function run() external returns (Deployment memory d) {
        uint256 pk = _envUintOrZero("DEPLOYER_PRIVATE_KEY");

        Config memory c;
        if (pk != 0) {
            c.deployer = vm.addr(pk);
            vm.startBroadcast(pk);
        } else {
            c.deployer = msg.sender;
            vm.startBroadcast();
        }

        c.treasury = _envAddressOr("TREASURY_ADDRESS", c.deployer);
        c.finalOwner = _envAddressOr("OWNER_ADDRESS", c.deployer);
        c.relayer = _envAddressOr("RELAYER_ADDRESS", address(0));
        c.rate = _envUintOr("INITIAL_THOOD_PER_USD", DEFAULT_THOOD_PER_USD);

        d = _deployAndWire(c);

        vm.stopBroadcast();

        _write(d, c);
        _log(d, c);
    }

    /// @dev Deploys every contract and wires the protocol together.
    function _deployAndWire(Config memory c) internal returns (Deployment memory d) {
        // 1. Token — mints the whole supply to the treasury. No owner, no mint path afterwards.
        d.token = address(new TeleHoodToken(c.treasury));

        // 2. Price source — USD to $THOOD conversion for activation and rent.
        d.priceSource = address(new ManualPriceSource(c.deployer, c.rate));

        // 3. Revenue vault — receives 100% of payments and splits them 50/50 at receipt.
        RevenueVault vault = new RevenueVault(c.deployer, d.token, c.treasury);
        d.revenueVault = address(vault);

        // 4. Activation — the $5 one-time account handshake.
        d.activation = address(new Activation(c.deployer, d.token, d.priceSource, d.revenueVault));

        // 5. Group registry — rooms at $10/month, paid by their admins.
        d.groupRegistry = address(new GroupRegistry(c.deployer, d.token, d.activation, d.priceSource, d.revenueVault));

        // 6. Key registry — free, ungated identity keys.
        d.keyRegistry = address(new KeyRegistry());

        // 7. Anchors — the message log. Gated on activation + room rent, never payable.
        Anchors anchors = new Anchors(c.deployer, d.activation, d.groupRegistry);
        d.anchors = address(anchors);

        // 8. Perks — the holder status ladder, read-only over token checkpoints.
        d.perks = address(new Perks(c.deployer, d.token, d.revenueVault));

        // 9. Handles — @names, free with activation, short names gated by perk tier.
        d.handles = address(new Handles(d.activation, d.perks));

        // ── wiring ───────────────────────────────────────────────────────────────
        vault.setNotifier(d.activation, true);
        vault.setNotifier(d.groupRegistry, true);
        if (c.relayer != address(0)) {
            anchors.setRelayer(c.relayer, true);
        }

        // Addresses that hold $THOOD but can never meaningfully claim are removed from the
        // eligible supply, so they cannot silently absorb the holders' half.
        vault.setExcluded(c.treasury, true);
        vault.setExcluded(d.revenueVault, true);

        // ── ownership handover ───────────────────────────────────────────────────
        if (c.finalOwner != c.deployer) {
            ManualPriceSource(d.priceSource).transferOwnership(c.finalOwner);
            vault.transferOwnership(c.finalOwner);
            Activation(d.activation).transferOwnership(c.finalOwner);
            GroupRegistry(d.groupRegistry).transferOwnership(c.finalOwner);
            anchors.transferOwnership(c.finalOwner);
            Perks(d.perks).transferOwnership(c.finalOwner);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Output
    // ─────────────────────────────────────────────────────────────────────────────

    /// @dev Serialises the deployment to `./deployments/<chainid>.json`.
    function _write(Deployment memory d, Config memory c) internal {
        string memory dir = "./deployments";
        if (!vm.exists(dir)) {
            vm.createDir(dir, true);
        }

        string memory key = "telehood-deployment";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeAddress(key, "token", d.token);
        vm.serializeAddress(key, "priceSource", d.priceSource);
        vm.serializeAddress(key, "revenueVault", d.revenueVault);
        vm.serializeAddress(key, "activation", d.activation);
        vm.serializeAddress(key, "groupRegistry", d.groupRegistry);
        vm.serializeAddress(key, "keyRegistry", d.keyRegistry);
        vm.serializeAddress(key, "anchors", d.anchors);
        vm.serializeAddress(key, "perks", d.perks);
        vm.serializeAddress(key, "handles", d.handles);
        vm.serializeAddress(key, "treasury", c.treasury);
        vm.serializeAddress(key, "owner", c.finalOwner);
        vm.serializeAddress(key, "relayer", c.relayer);
        vm.serializeUint(key, "thoodPerUsd", c.rate);
        string memory json = vm.serializeUint(key, "deployedAtBlock", block.number);

        vm.writeJson(json, string.concat(dir, "/", vm.toString(block.chainid), ".json"));
    }

    /// @dev Human-readable summary in the script output.
    function _log(Deployment memory d, Config memory c) internal pure {
        console2.log("TeleHood deployed");
        console2.log("  token          ", d.token);
        console2.log("  priceSource    ", d.priceSource);
        console2.log("  revenueVault   ", d.revenueVault);
        console2.log("  activation     ", d.activation);
        console2.log("  groupRegistry  ", d.groupRegistry);
        console2.log("  keyRegistry    ", d.keyRegistry);
        console2.log("  anchors        ", d.anchors);
        console2.log("  perks          ", d.perks);
        console2.log("  handles        ", d.handles);
        console2.log("  treasury       ", c.treasury);
        console2.log("  owner          ", c.finalOwner);
        console2.log("  relayer        ", c.relayer);
        console2.log("  thoodPerUsd    ", c.rate);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Env helpers — tolerate unset AND empty values (`.env.example` ships empty keys)
    // ─────────────────────────────────────────────────────────────────────────────

    /// @dev Returns the uint at `name`, or 0 when unset or empty.
    function _envUintOrZero(string memory name) internal view returns (uint256) {
        if (bytes(vm.envOr(name, string(""))).length == 0) return 0;
        return vm.envUint(name);
    }

    /// @dev Returns the uint at `name`, or `fallbackValue` when unset or empty.
    function _envUintOr(string memory name, uint256 fallbackValue) internal view returns (uint256) {
        if (bytes(vm.envOr(name, string(""))).length == 0) return fallbackValue;
        return vm.envUint(name);
    }

    /// @dev Returns the address at `name`, or `fallbackValue` when unset or empty.
    function _envAddressOr(string memory name, address fallbackValue) internal view returns (address) {
        if (bytes(vm.envOr(name, string(""))).length == 0) return fallbackValue;
        return vm.envAddress(name);
    }
}
