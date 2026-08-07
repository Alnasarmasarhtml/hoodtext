'use client';

/**
 * Rooms (SPEC §4.4) — create, rent, roster.
 *
 * The economics: a room costs $10/month in $GRAM, paid by whoever runs it —
 * members are free. Rent lapsing blocks NEW messages only; history, keys and
 * membership survive, and anyone may pay to reopen.
 *
 * The cryptography: one symmetric group key per epoch, wrapped individually
 * to each member's registered X25519 key and delivered inside ordinary
 * stealth 1:1 `system` drops. Only a Merkle commitment of the member set
 * (`memberRoot`) ever goes on chain — the roster itself lives on members'
 * devices. Adding a member wraps and delivers the CURRENT key; removing one
 * mints a fresh key, bumps the epoch on chain (`rotateEpoch`) and re-wraps to
 * everyone left.
 */

import {
  groupIdFor,
  memberRoot,
  newGroupKey,
  seal,
  signDrop,
  wrapGroupKey,
  type IdentityKeys,
} from '@hoodgram/crypto';
import { useCallback, useMemo, useState } from 'react';
import { bytesToHex, hexToBytes, type Address, type Hex } from 'viem';
import { useConfig, useReadContract, useReadContracts, useWriteContract } from 'wagmi';
import type { Config } from 'wagmi';
import { readContract, waitForTransactionReceipt } from 'wagmi/actions';

import { anchorsAbi, groupRegistryAbi, keyRegistryAbi, hoodGramTokenAbi } from '@/lib/abi';
import { ACTIVE_CHAIN_ID, tryGetContracts } from '@/lib/chain';
import { DEMO_ACCESS, isDemoActive } from '@/lib/demo';
import { RelayError, postBlob, sendDrop } from '@/lib/relay';
import { demoGroupIdFor, demoRoomChain, registerDemoRoom } from './demo-world';
import { describeChainError } from './errors';
import { roomId } from './message-store';
import { useDemoActive } from './useDemoMode';
import {
  addMessage,
  findRoom,
  latestRoomKey,
  putRoomKey,
  replaceRoomMembers,
  upsertRoom,
  useMessengerStore,
} from './messenger-store';
import { STEALTH_CONVO_ID, type RoomRecord } from './types';

const ZERO_KEY: Hex = `0x${'00'.repeat(32)}`;
const REFRESH_MS = 30_000;

/* ═══════════════════════════════════════════════════════ store readers ══ */

/** Every room this device belongs to, newest activity first. */
export function useRooms(): readonly RoomRecord[] {
  const rooms = useMessengerStore((state) => state.rooms);
  return useMemo(
    () => [...rooms].sort((a, b) => b.lastSeenAt - a.lastSeenAt),
    [rooms],
  );
}

/** One room by group id, or `null`. */
export function useRoom(groupId: Hex | null): RoomRecord | null {
  const rooms = useMessengerStore((state) => state.rooms);
  return useMemo(() => {
    if (groupId === null) return null;
    const target = groupId.toLowerCase();
    return rooms.find((room) => room.groupId.toLowerCase() === target) ?? null;
  }, [groupId, rooms]);
}

/* ═══════════════════════════════════════════════════════════ chain view ══ */

export interface RoomChainState {
  readonly exists: boolean;
  readonly admin: Address | null;
  /** On-chain sender-key epoch. Starts at 0, bumps on every rotation. */
  readonly epoch: number;
  readonly memberRoot: Hex | null;
  /** Unix seconds rent is paid up to. */
  readonly paidUntil: number;
  readonly autoRenew: boolean;
  /** `GroupRegistry.isActive` — the send gate `Anchors` enforces. */
  readonly isActive: boolean;
  readonly isLoading: boolean;
  readonly error: string | null;
  refetch: () => void;
}

const noopRefetch = (): void => undefined;

/** Live `GroupRegistry` state for one room. Rent is never cached locally. */
export function useRoomChain(groupId: Hex | null): RoomChainState {
  const demo = useDemoActive();
  const contracts = tryGetContracts(ACTIVE_CHAIN_ID);
  const enabled = contracts !== null && groupId !== null && !demo;

  const base = {
    chainId: ACTIVE_CHAIN_ID,
    abi: groupRegistryAbi,
    ...(contracts === null ? {} : { address: contracts.groupRegistry }),
  } as const;

  const groupRead = useReadContract({
    ...base,
    functionName: 'groups',
    args: groupId === null ? undefined : [groupId],
    query: { enabled, refetchInterval: REFRESH_MS },
  });

  const activeRead = useReadContract({
    ...base,
    functionName: 'isActive',
    args: groupId === null ? undefined : [groupId],
    query: { enabled, refetchInterval: REFRESH_MS },
  });

  const refetch = useCallback((): void => {
    void groupRead.refetch();
    void activeRead.refetch();
  }, [activeRead, groupRead]);

  /* Demo: the fixture world answers instead of the chain. */
  if (demo && groupId !== null) {
    const fixture = demoRoomChain(groupId);
    if (fixture !== null) {
      return { ...fixture, isLoading: false, error: null, refetch: noopRefetch };
    }
    return {
      exists: false,
      admin: null,
      epoch: 0,
      memberRoot: null,
      paidUntil: 0,
      autoRenew: false,
      isActive: false,
      isLoading: false,
      error: null,
      refetch: noopRefetch,
    };
  }

  const data = groupRead.data;
  return {
    exists: data?.[6] ?? false,
    admin: data === undefined || data[6] === false ? null : data[0],
    epoch: data === undefined ? 0 : data[1],
    memberRoot: data === undefined ? null : data[3],
    paidUntil: data === undefined ? 0 : Number(data[4]),
    autoRenew: data?.[5] ?? false,
    isActive: activeRead.data ?? false,
    isLoading: enabled && (groupRead.isPending || activeRead.isPending),
    error:
      groupRead.error === null
        ? null
        : describeChainError(groupRead.error, 'The room could not be read from chain.'),
    refetch,
  };
}

/** Live `quoteRent(months)` — the $10/month priced in $GRAM right now. */
export function useRentQuote(months: number): bigint | null {
  const demo = useDemoActive();
  const contracts = tryGetContracts(ACTIVE_CHAIN_ID);
  const clamped = Math.min(24, Math.max(1, Math.round(months)));
  const quoteRead = useReadContract({
    chainId: ACTIVE_CHAIN_ID,
    abi: groupRegistryAbi,
    ...(contracts === null ? {} : { address: contracts.groupRegistry }),
    functionName: 'quoteRent',
    args: [clamped],
    query: { enabled: contracts !== null && !demo, staleTime: 60_000 },
  });
  if (demo) return DEMO_ACCESS.rentPerMonth * BigInt(clamped);
  return quoteRead.data ?? null;
}

/* ═══════════════════════════════════════════════════════ key delivery ═══ */

interface KeyDropPayload {
  readonly groupId: Hex;
  readonly epoch: number;
  readonly name: string;
  readonly wrapped: Hex;
}

/**
 * Seals a room-key payload to one member and anchors it as an ordinary
 * stealth 1:1 drop — relay first, the sender's own wallet as fallback.
 *
 * @throws {Error} when neither path could anchor the drop.
 */
async function deliverKeyDrop(
  config: Config,
  params: {
    readonly sender: Address;
    readonly keys: IdentityKeys;
    readonly memberX25519: Hex;
    readonly payload: KeyDropPayload;
    readonly anchorsAddress: Address;
    readonly writeContract: (args: {
      readonly address: Address;
      readonly drop: {
        convoId: Hex;
        ephPub: Hex;
        blobRef: Hex;
        viewTag: number;
        size: number;
      };
    }) => Promise<Hex>;
  },
): Promise<void> {
  const memberKey = hexToBytes(params.memberX25519);
  const body = JSON.stringify({ type: 'roomKey', ...params.payload });
  const sealed = await seal(
    { v: 1, t: Math.floor(Date.now() / 1000), kind: 'system', body },
    memberKey,
  );

  const receipt = await postBlob(sealed.blob);
  if (receipt.blobRef.toLowerCase() !== sealed.blobRef.toLowerCase()) {
    throw new Error('The relay returned a mismatched reference for the key drop.');
  }

  const drop = {
    convoId: STEALTH_CONVO_ID,
    ephPub: sealed.ephPub,
    blobRef: sealed.blobRef,
    viewTag: sealed.viewTag,
    size: sealed.size,
  };

  try {
    const signature = await signDrop(drop, params.keys.ed25519.privateKey);
    await sendDrop({ sender: params.sender, signature, drop });
    return;
  } catch (relayError: unknown) {
    if (!(relayError instanceof RelayError)) throw relayError;
    /* Relay refused or unreachable — anchor it ourselves, gas only. */
  }

  const hash = await params.writeContract({ address: params.anchorsAddress, drop });
  const txReceipt = await waitForTransactionReceipt(config, {
    hash,
    chainId: ACTIVE_CHAIN_ID,
  });
  if (txReceipt.status === 'reverted') {
    throw new Error('The key-drop anchor transaction reverted on chain.');
  }
}

/** Reads a member's registered X25519 key, or `null` when they have none. */
async function registeredKeyOf(config: Config, member: Address): Promise<Hex | null> {
  const contracts = tryGetContracts(ACTIVE_CHAIN_ID);
  if (contracts === null) return null;
  const keys = await readContract(config, {
    address: contracts.keyRegistry,
    abi: keyRegistryAbi,
    functionName: 'keysOf',
    args: [member],
    chainId: ACTIVE_CHAIN_ID,
  });
  const x25519 = keys[0];
  return x25519.toLowerCase() === ZERO_KEY ? null : x25519;
}

function randomSalt(): Hex {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/* ═══════════════════════════════════════════════════════ create a room ══ */

export type CreateRoomPhase = 'idle' | 'approving' | 'creating' | 'done' | 'error';

export interface UseCreateRoomResult {
  readonly phase: CreateRoomPhase;
  readonly error: string | null;
  readonly txHash: Hex | null;
  readonly isBusy: boolean;
  /**
   * Approve + `createGroup`, then store the room and its epoch-0 key locally.
   *
   * @returns the new `groupId`, or `null` with `error` set.
   */
  create: (name: string, months: number) => Promise<Hex | null>;
  reset: () => void;
}

export function useCreateRoom(owner: Address | null): UseCreateRoomResult {
  const config = useConfig();
  const { writeContractAsync } = useWriteContract();
  const contracts = tryGetContracts(ACTIVE_CHAIN_ID);

  const [phase, setPhase] = useState<CreateRoomPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<Hex | null>(null);

  const reset = useCallback((): void => {
    setPhase('idle');
    setError(null);
    setTxHash(null);
  }, []);

  const failWith = useCallback((message: string): null => {
    setPhase('error');
    setError(message);
    return null;
  }, []);

  const create = useCallback(
    async (name: string, months: number): Promise<Hex | null> => {
      setError(null);
      setTxHash(null);

      const trimmed = name.trim();
      if (owner === null) return failWith('Connect and unlock before creating a room.');
      if (trimmed === '' || trimmed.length > 40) {
        return failWith('Give the room a name — 1 to 40 characters.');
      }
      const boundedMonths = Math.min(24, Math.max(1, Math.round(months)));

      /* Demo: the room comes to exist locally — no approval, no transaction.
         The fixture chain map answers rent reads so the thread is coherent. */
      if (isDemoActive()) {
        setPhase('creating');
        const groupId = demoGroupIdFor(trimmed);
        registerDemoRoom({ groupId, name: trimmed, months: boundedMonths });
        const now = Math.floor(Date.now() / 1000);
        await upsertRoom({
          id: roomId(owner, groupId),
          owner,
          groupId,
          name: trimmed,
          admin: owner,
          members: [owner.toLowerCase() as Address],
          epoch: 0,
          createdAt: now,
          lastSeenAt: now,
        });
        await addMessage({
          id: `${roomId(owner, groupId)}:created`,
          owner,
          convoId: groupId,
          direction: 'out',
          body: `Room “${trimmed}” created — simulated. In the live app this is one approve + createGroup, ${String(
            boundedMonths,
          )} ${boundedMonths === 1 ? 'month' : 'months'} of rent up front.`,
          kind: 'system',
          re: null,
          sentAt: now,
          status: 'anchored',
          integrity: 'local',
          blobRef: null,
          ephPub: null,
          viewTag: null,
          size: null,
          seq: null,
          blockNumber: null,
          txHash: null,
          poster: owner,
          error: null,
        });
        setPhase('done');
        return groupId;
      }

      if (contracts === null) {
        return failWith('HoodGram is not configured for this chain.');
      }

      try {
        /* Price the rent and clear the allowance if it falls short. */
        const quote = await readContract(config, {
          address: contracts.groupRegistry,
          abi: groupRegistryAbi,
          functionName: 'quoteRent',
          args: [boundedMonths],
          chainId: ACTIVE_CHAIN_ID,
        });

        const allowance = await readContract(config, {
          address: contracts.token,
          abi: hoodGramTokenAbi,
          functionName: 'allowance',
          args: [owner, contracts.groupRegistry],
          chainId: ACTIVE_CHAIN_ID,
        });

        if (allowance < quote) {
          setPhase('approving');
          const approveHash = await writeContractAsync({
            address: contracts.token,
            abi: hoodGramTokenAbi,
            functionName: 'approve',
            args: [contracts.groupRegistry, quote],
            chainId: ACTIVE_CHAIN_ID,
          });
          const approveReceipt = await waitForTransactionReceipt(config, {
            hash: approveHash,
            chainId: ACTIVE_CHAIN_ID,
          });
          if (approveReceipt.status === 'reverted') {
            return failWith('The $GRAM approval reverted on chain. Nothing was paid.');
          }
        }

        /* Derive the id, mint the epoch-0 key, commit to a solo roster. */
        const salt = randomSalt();
        const groupId = groupIdFor(trimmed, owner, salt);
        const groupKey = newGroupKey();
        const root = memberRoot([owner]);

        setPhase('creating');
        const hash = await writeContractAsync({
          address: contracts.groupRegistry,
          abi: groupRegistryAbi,
          functionName: 'createGroup',
          args: [groupId, root, boundedMonths],
          chainId: ACTIVE_CHAIN_ID,
        });
        setTxHash(hash);
        const receipt = await waitForTransactionReceipt(config, {
          hash,
          chainId: ACTIVE_CHAIN_ID,
        });
        if (receipt.status === 'reverted') {
          return failWith('The room creation reverted on chain. The rent was not pulled.');
        }

        /* The chain has the room; now this device does too. */
        const now = Math.floor(Date.now() / 1000);
        await putRoomKey(groupId, 0, groupKey);
        await upsertRoom({
          id: roomId(owner, groupId),
          owner,
          groupId,
          name: trimmed,
          admin: owner,
          members: [owner.toLowerCase() as Address],
          epoch: 0,
          createdAt: now,
          lastSeenAt: now,
        });
        await addMessage({
          id: `${roomId(owner, groupId)}:created`,
          owner,
          convoId: groupId,
          direction: 'out',
          body: `Room “${trimmed}” created — rent paid ${String(boundedMonths)} ${
            boundedMonths === 1 ? 'month' : 'months'
          } ahead.`,
          kind: 'system',
          re: null,
          sentAt: now,
          status: 'anchored',
          integrity: 'local',
          blobRef: null,
          ephPub: null,
          viewTag: null,
          size: null,
          seq: null,
          blockNumber: Number(receipt.blockNumber),
          txHash: hash,
          poster: owner,
          error: null,
        });

        setPhase('done');
        return groupId;
      } catch (caught: unknown) {
        return failWith(describeChainError(caught, 'The room could not be created.'));
      }
    },
    [config, contracts, failWith, owner, writeContractAsync],
  );

  return {
    phase,
    error,
    txHash,
    isBusy: phase === 'approving' || phase === 'creating',
    create,
    reset,
  };
}

/* ═══════════════════════════════════════════════════════════ pay rent ═══ */

export type PayRentPhase = 'idle' | 'approving' | 'paying' | 'done' | 'error';

export interface UsePayRentResult {
  readonly phase: PayRentPhase;
  readonly error: string | null;
  readonly isBusy: boolean;
  /** Approve + `payRent`. Any member may pay — paying grants no control. */
  pay: (months: number) => Promise<boolean>;
  reset: () => void;
}

export function usePayRent(groupId: Hex | null, payer: Address | null): UsePayRentResult {
  const config = useConfig();
  const { writeContractAsync } = useWriteContract();
  const contracts = tryGetContracts(ACTIVE_CHAIN_ID);

  const [phase, setPhase] = useState<PayRentPhase>('idle');
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback((): void => {
    setPhase('idle');
    setError(null);
  }, []);

  const pay = useCallback(
    async (months: number): Promise<boolean> => {
      setError(null);
      if (groupId === null || payer === null || contracts === null) {
        setPhase('error');
        setError('Connect a wallet on the right network first.');
        return false;
      }
      const boundedMonths = Math.min(24, Math.max(1, Math.round(months)));

      try {
        const quote = await readContract(config, {
          address: contracts.groupRegistry,
          abi: groupRegistryAbi,
          functionName: 'quoteRent',
          args: [boundedMonths],
          chainId: ACTIVE_CHAIN_ID,
        });
        const allowance = await readContract(config, {
          address: contracts.token,
          abi: hoodGramTokenAbi,
          functionName: 'allowance',
          args: [payer, contracts.groupRegistry],
          chainId: ACTIVE_CHAIN_ID,
        });

        if (allowance < quote) {
          setPhase('approving');
          const approveHash = await writeContractAsync({
            address: contracts.token,
            abi: hoodGramTokenAbi,
            functionName: 'approve',
            args: [contracts.groupRegistry, quote],
            chainId: ACTIVE_CHAIN_ID,
          });
          const approveReceipt = await waitForTransactionReceipt(config, {
            hash: approveHash,
            chainId: ACTIVE_CHAIN_ID,
          });
          if (approveReceipt.status === 'reverted') {
            setPhase('error');
            setError('The $GRAM approval reverted on chain. Nothing was paid.');
            return false;
          }
        }

        setPhase('paying');
        const hash = await writeContractAsync({
          address: contracts.groupRegistry,
          abi: groupRegistryAbi,
          functionName: 'payRent',
          args: [groupId, boundedMonths],
          chainId: ACTIVE_CHAIN_ID,
        });
        const receipt = await waitForTransactionReceipt(config, {
          hash,
          chainId: ACTIVE_CHAIN_ID,
        });
        if (receipt.status === 'reverted') {
          setPhase('error');
          setError('The rent payment reverted on chain.');
          return false;
        }

        setPhase('done');
        return true;
      } catch (caught: unknown) {
        setPhase('error');
        setError(describeChainError(caught, 'The rent could not be paid.'));
        return false;
      }
    },
    [config, contracts, groupId, payer, writeContractAsync],
  );

  return { phase, error, isBusy: phase === 'approving' || phase === 'paying', pay, reset };
}

/* ═════════════════════════════════════════════════════════════ roster ═══ */

export type RosterPhase = 'idle' | 'adding' | 'removing' | 'error' | 'done';

export interface UseRoomRosterParams {
  readonly owner: Address | null;
  readonly keys: IdentityKeys | null;
  readonly room: RoomRecord | null;
  /** Current on-chain epoch, from {@link useRoomChain}. */
  readonly chainEpoch: number;
}

export interface UseRoomRosterResult {
  readonly phase: RosterPhase;
  readonly error: string | null;
  readonly isBusy: boolean;
  /**
   * Wraps the CURRENT epoch key to a resolved address and delivers it.
   * No on-chain write — `memberRoot` only moves on removal.
   */
  addMember: (member: Address) => Promise<boolean>;
  /**
   * Kick: fresh key, `rotateEpoch` with the shrunken root, re-wrap and
   * deliver to everyone left.
   */
  removeMember: (member: Address) => Promise<boolean>;
  reset: () => void;
}

export function useRoomRoster({
  owner,
  keys,
  room,
  chainEpoch,
}: UseRoomRosterParams): UseRoomRosterResult {
  const config = useConfig();
  const { writeContractAsync } = useWriteContract();
  const contracts = tryGetContracts(ACTIVE_CHAIN_ID);

  const [phase, setPhase] = useState<RosterPhase>('idle');
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback((): void => {
    setPhase('idle');
    setError(null);
  }, []);

  const failWith = useCallback((message: string): false => {
    setPhase('error');
    setError(message);
    return false;
  }, []);

  const anchorWrite = useCallback(
    (args: {
      readonly address: Address;
      readonly drop: { convoId: Hex; ephPub: Hex; blobRef: Hex; viewTag: number; size: number };
    }): Promise<Hex> =>
      writeContractAsync({
        address: args.address,
        abi: anchorsAbi,
        functionName: 'post',
        chainId: ACTIVE_CHAIN_ID,
        args: [args.drop],
      }),
    [writeContractAsync],
  );

  const addMember = useCallback(
    async (member: Address): Promise<boolean> => {
      setError(null);
      if (owner === null || keys === null || room === null || contracts === null) {
        return failWith('Unlock your identity first.');
      }
      const memberKeyLc = member.toLowerCase();
      if (room.members.some((entry) => entry.toLowerCase() === memberKeyLc)) {
        return failWith('They are already in this room.');
      }

      setPhase('adding');
      try {
        const memberX25519 = await registeredKeyOf(config, member);
        if (memberX25519 === null) {
          return failWith(
            'That account has not registered messaging keys, so the room key cannot be encrypted to them. Registering is free — ask them to open HoodGram once.',
          );
        }

        const current = latestRoomKey(room.groupId);
        if (current === null) {
          return failWith('This device holds no key for the room, so there is nothing to share.');
        }

        const wrapped = await wrapGroupKey(current.key, hexToBytes(memberX25519));
        await deliverKeyDrop(config, {
          sender: owner,
          keys,
          memberX25519,
          payload: {
            groupId: room.groupId,
            epoch: current.epoch,
            name: room.name,
            wrapped: bytesToHex(wrapped),
          },
          anchorsAddress: contracts.anchors,
          writeContract: anchorWrite,
        });

        const now = Math.floor(Date.now() / 1000);
        await upsertRoom({
          ...room,
          members: [...room.members, member.toLowerCase() as Address],
          lastSeenAt: now,
        });
        await addMessage({
          id: `${roomId(owner, room.groupId)}:add:${memberKeyLc}:${String(now)}`,
          owner,
          convoId: room.groupId,
          direction: 'out',
          body: `Room key delivered to ${member} (epoch ${String(current.epoch)}).`,
          kind: 'system',
          re: null,
          sentAt: now,
          status: 'anchored',
          integrity: 'local',
          blobRef: null,
          ephPub: null,
          viewTag: null,
          size: null,
          seq: null,
          blockNumber: null,
          txHash: null,
          poster: owner,
          error: null,
        });

        setPhase('done');
        return true;
      } catch (caught: unknown) {
        return failWith(describeChainError(caught, 'The member could not be added.'));
      }
    },
    [anchorWrite, config, contracts, failWith, keys, owner, room],
  );

  const removeMember = useCallback(
    async (member: Address): Promise<boolean> => {
      setError(null);
      if (owner === null || keys === null || room === null || contracts === null) {
        return failWith('Unlock your identity first.');
      }
      const memberKeyLc = member.toLowerCase();
      if (memberKeyLc === owner.toLowerCase()) {
        return failWith('Admins cannot remove themselves — transfer the room first.');
      }

      const remaining = room.members.filter((entry) => entry.toLowerCase() !== memberKeyLc);
      if (remaining.length === room.members.length) {
        return failWith('They are not in this room’s local roster.');
      }

      setPhase('removing');
      try {
        /* 1 — fresh key for the shrunken set, committed on chain. */
        const nextKey = newGroupKey();
        const nextRoot = memberRoot([...remaining]);
        const hash = await writeContractAsync({
          address: contracts.groupRegistry,
          abi: groupRegistryAbi,
          functionName: 'rotateEpoch',
          args: [room.groupId, nextRoot],
          chainId: ACTIVE_CHAIN_ID,
        });
        const receipt = await waitForTransactionReceipt(config, {
          hash,
          chainId: ACTIVE_CHAIN_ID,
        });
        if (receipt.status === 'reverted') {
          return failWith('The epoch rotation reverted on chain. Nothing changed.');
        }

        /* The chain is the authority on the new epoch number; the cached read
           this panel came in with could be stale. */
        let nextEpoch = chainEpoch + 1;
        try {
          const group = await readContract(config, {
            address: contracts.groupRegistry,
            abi: groupRegistryAbi,
            functionName: 'groups',
            args: [room.groupId],
            chainId: ACTIVE_CHAIN_ID,
          });
          nextEpoch = group[1];
        } catch {
          /* Fall back to the local increment. */
        }

        /* 2 — the admin holds the new key immediately. */
        await putRoomKey(room.groupId, nextEpoch, nextKey);
        await replaceRoomMembers(room.groupId, remaining, nextEpoch);

        /* 3 — re-wrap to everyone left. A failed delivery is reported, not
               fatal: the roster and epoch are already rotated. */
        const undelivered: Address[] = [];
        for (const target of remaining) {
          if (target.toLowerCase() === owner.toLowerCase()) continue;
          try {
            const targetKey = await registeredKeyOf(config, target);
            if (targetKey === null) {
              undelivered.push(target);
              continue;
            }
            const wrapped = await wrapGroupKey(nextKey, hexToBytes(targetKey));
            await deliverKeyDrop(config, {
              sender: owner,
              keys,
              memberX25519: targetKey,
              payload: {
                groupId: room.groupId,
                epoch: nextEpoch,
                name: room.name,
                wrapped: bytesToHex(wrapped),
              },
              anchorsAddress: contracts.anchors,
              writeContract: anchorWrite,
            });
          } catch {
            undelivered.push(target);
          }
        }

        const now = Math.floor(Date.now() / 1000);
        await addMessage({
          id: `${roomId(owner, room.groupId)}:rotate:${String(nextEpoch)}`,
          owner,
          convoId: room.groupId,
          direction: 'out',
          body:
            undelivered.length === 0
              ? `Member removed — key rotated to epoch ${String(nextEpoch)} and delivered to ${String(
                  Math.max(0, remaining.length - 1),
                )} member${remaining.length - 1 === 1 ? '' : 's'}.`
              : `Member removed — key rotated to epoch ${String(nextEpoch)}, but delivery failed for ${String(
                  undelivered.length,
                )} member${undelivered.length === 1 ? '' : 's'}. Re-add them to re-send the key.`,
          kind: 'system',
          re: null,
          sentAt: now,
          status: 'anchored',
          integrity: 'local',
          blobRef: null,
          ephPub: null,
          viewTag: null,
          size: null,
          seq: null,
          blockNumber: Number(receipt.blockNumber),
          txHash: hash,
          poster: owner,
          error: null,
        });

        setPhase('done');
        return true;
      } catch (caught: unknown) {
        return failWith(describeChainError(caught, 'The member could not be removed.'));
      }
    },
    [anchorWrite, chainEpoch, config, contracts, failWith, keys, owner, room, writeContractAsync],
  );

  return {
    phase,
    error,
    isBusy: phase === 'adding' || phase === 'removing',
    addMember,
    removeMember,
    reset,
  };
}

/* ═══════════════════════════════════════════════ admin rent watchdog ════ */

export interface AdminRentAlert {
  readonly room: RoomRecord;
  /** Unix seconds the earliest-lapsing room is paid until. */
  readonly paidUntil: number;
  /** True when that room has already lapsed. */
  readonly lapsed: boolean;
}

/** `GroupRegistry.RENEW_WINDOW` — 3 days, mirrored for the badge. */
const RENT_WARN_SECONDS = 3 * 86_400;

/**
 * Watches every room this wallet administers and surfaces the one whose rent
 * lapses first, once it is inside the 3-day window. Drives the quiet warning
 * in the account badge — never a blocker.
 */
export function useAdminRentAlert(owner: Address | null): AdminRentAlert | null {
  const demo = useDemoActive();
  const rooms = useMessengerStore((state) => state.rooms);
  const contracts = tryGetContracts(ACTIVE_CHAIN_ID);

  const candidates = useMemo(() => {
    if (owner === null) return [];
    const me = owner.toLowerCase();
    return rooms.filter((room) => room.admin !== null && room.admin.toLowerCase() === me);
  }, [owner, rooms]);

  const reads = useReadContracts({
    contracts: candidates.map((room) => ({
      chainId: ACTIVE_CHAIN_ID,
      abi: groupRegistryAbi,
      address: contracts?.groupRegistry ?? `0x${'00'.repeat(20)}`,
      functionName: 'groups' as const,
      args: [room.groupId] as const,
    })),
    query: {
      enabled: contracts !== null && candidates.length > 0 && !demo,
      refetchInterval: 60_000,
    },
  });

  return useMemo(() => {
    if (candidates.length === 0) return null;
    const now = Math.floor(Date.now() / 1000);
    let alert: AdminRentAlert | null = null;

    /* Demo: the fixture chain map stands in for the batched read. */
    if (demo) {
      for (const room of candidates) {
        const fixture = demoRoomChain(room.groupId);
        if (fixture === null || !fixture.exists) continue;
        if (fixture.paidUntil - now > RENT_WARN_SECONDS) continue;
        if (alert === null || fixture.paidUntil < alert.paidUntil) {
          alert = { room, paidUntil: fixture.paidUntil, lapsed: fixture.paidUntil <= now };
        }
      }
      return alert;
    }

    if (contracts === null) return null;
    const rows = reads.data;
    if (rows === undefined) return null;

    for (let i = 0; i < candidates.length; i += 1) {
      const room = candidates[i];
      const row = rows[i];
      if (room === undefined || row === undefined || row.status !== 'success') continue;
      const [, , , , paidUntil, , exists] = row.result;
      if (!exists) continue;
      const until = Number(paidUntil);
      if (until - now > RENT_WARN_SECONDS) continue;
      if (alert === null || until < alert.paidUntil) {
        alert = { room, paidUntil: until, lapsed: until <= now };
      }
    }
    return alert;
  }, [candidates, contracts, demo, reads.data]);
}

/* Re-exported store helpers so components import rooms from one place. */
export { findRoom, latestRoomKey };
