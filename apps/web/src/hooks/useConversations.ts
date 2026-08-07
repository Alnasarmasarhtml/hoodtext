'use client';

import { convoIdFor } from '@hoodgram/crypto';
import { useCallback, useMemo, useState } from 'react';
import { hexToBytes, type Address, type Hex } from 'viem';
import { useConfig } from 'wagmi';
import { readContract } from 'wagmi/actions';

import { keyRegistryAbi } from '@/lib/abi';
import { ACTIVE_CHAIN_ID, tryGetContracts } from '@/lib/chain';
import { isDemoActive } from '@/lib/demo';
import { demoConvoIdFor } from './demo-world';
import { describeChainError } from './errors';
import { peerId } from './message-store';
import { upsertPeer, useMessengerStore } from './messenger-store';
import { resolveRecipient } from './useHandles';
import {
  UNATTRIBUTED_CONVO_ID,
  type ChatMessage,
  type Conversation,
  type PeerRecord,
  type RoomRecord,
} from './types';

const ZERO_KEY: Hex = `0x${'00'.repeat(32)}`;

function toKeyBytes(value: Hex): Uint8Array | null {
  try {
    const bytes = hexToBytes(value);
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

function buildConversation(
  convoId: Hex,
  messages: readonly ChatMessage[],
  peer: PeerRecord | undefined,
  room: RoomRecord | undefined,
): Conversation {
  let anchored = 0;
  let pending = 0;
  let failed = 0;
  let lastActivity = Math.max(peer?.lastSeenAt ?? 0, room?.lastSeenAt ?? 0);
  let last: ChatMessage | null = null;

  for (const message of messages) {
    if (message.status === 'anchored' || message.status === 'received') anchored += 1;
    else if (message.status === 'failed') failed += 1;
    else pending += 1;
    if (message.sentAt > lastActivity) lastActivity = message.sentAt;
    /* Reactions decorate other rows; they never headline a conversation. */
    if (message.kind !== 'react') last = message;
  }

  const unattributed = convoId.toLowerCase() === UNATTRIBUTED_CONVO_ID;
  const peerKey = peer?.x25519Pub ?? null;

  return {
    convoId,
    room: room ?? null,
    peerAddress: peer?.address ?? null,
    peerX25519: peerKey,
    lastMessage: last,
    lastActivity,
    messageCount: messages.length,
    anchoredCount: anchored,
    pendingCount: pending,
    failedCount: failed,
    unattributed,
    canReply:
      room !== undefined ||
      (!unattributed && peerKey !== null && peerKey.toLowerCase() !== ZERO_KEY),
  };
}

export interface UseConversationsResult {
  /** Most recently active first; the unattributed bucket always sorts last. */
  readonly conversations: readonly Conversation[];
  readonly isHydrated: boolean;
  readonly totalMessages: number;
  readonly hasAny: boolean;
}

/** The sidebar's data (SPEC §7.3). Derived entirely from the drop engine. */
export function useConversations(): UseConversationsResult {
  const messages = useMessengerStore((state) => state.messages);
  const peers = useMessengerStore((state) => state.peers);
  const rooms = useMessengerStore((state) => state.rooms);
  const isHydrated = useMessengerStore((state) => state.hydrated);

  const conversations = useMemo<readonly Conversation[]>(() => {
    const grouped = new Map<string, ChatMessage[]>();
    for (const message of messages) {
      const key = message.convoId.toLowerCase();
      const bucket = grouped.get(key);
      if (bucket === undefined) grouped.set(key, [message]);
      else bucket.push(message);
    }

    const peerByConvo = new Map<string, PeerRecord>();
    for (const peer of peers) peerByConvo.set(peer.convoId.toLowerCase(), peer);

    const roomByConvo = new Map<string, RoomRecord>();
    for (const room of rooms) roomByConvo.set(room.groupId.toLowerCase(), room);

    /* A peer or room with no messages yet is still a conversation — that is
       exactly the state right after starting one, and it must not vanish. */
    const ids = new Set<string>([
      ...grouped.keys(),
      ...peerByConvo.keys(),
      ...roomByConvo.keys(),
    ]);

    const out: Conversation[] = [];
    for (const key of ids) {
      const bucket = grouped.get(key) ?? [];
      const peer = peerByConvo.get(key);
      const room = roomByConvo.get(key);
      const convoId = (room?.groupId ?? peer?.convoId ?? bucket[0]?.convoId ?? key) as Hex;
      out.push(buildConversation(convoId, bucket, peer, room));
    }

    return out.sort((a, b) => {
      if (a.unattributed !== b.unattributed) return a.unattributed ? 1 : -1;
      return b.lastActivity - a.lastActivity;
    });
  }, [messages, peers, rooms]);

  return {
    conversations,
    isHydrated,
    totalMessages: messages.length,
    hasAny: conversations.length > 0,
  };
}

/** One conversation by id, or `null` when it is not on this device. */
export function useConversation(convoId: Hex | null): Conversation | null {
  const { conversations } = useConversations();
  return useMemo(() => {
    if (convoId === null) return null;
    const target = convoId.toLowerCase();
    return conversations.find((entry) => entry.convoId.toLowerCase() === target) ?? null;
  }, [conversations, convoId]);
}

/** Every row in one thread, oldest first. */
export function useConversationMessages(convoId: Hex | null): readonly ChatMessage[] {
  const messages = useMessengerStore((state) => state.messages);
  return useMemo(() => {
    if (convoId === null) return [];
    const target = convoId.toLowerCase();
    return messages.filter((message) => message.convoId.toLowerCase() === target);
  }, [convoId, messages]);
}

/* ═════════════════════════════════════════════ starting a conversation ══ */

export type StartStatus = 'idle' | 'resolving' | 'done' | 'error';

export interface UseStartConversationParams {
  readonly owner: Address | null;
  /** Our own registered X25519 public key — one half of the conversation id. */
  readonly myX25519Pub: Hex | null;
}

export interface UseStartConversationResult {
  readonly status: StartStatus;
  readonly error: string | null;
  readonly isBusy: boolean;
  /**
   * Resolves `0x…` or `@handle` input, looks the address up in `KeyRegistry`,
   * and opens the thread.
   *
   * @returns the local conversation id, or `null` with `error` set.
   */
  start: (peer: string) => Promise<Hex | null>;
  reset: () => void;
}

/**
 * Resolves an address or handle into a conversation.
 *
 * The peer must have registered keys — that is what makes them reachable, and
 * it is free (SPEC §4.5), so the failure message says exactly that rather than
 * "not found".
 */
export function useStartConversation({
  owner,
  myX25519Pub,
}: UseStartConversationParams): UseStartConversationResult {
  const config = useConfig();
  const contracts = tryGetContracts(ACTIVE_CHAIN_ID);
  const [status, setStatus] = useState<StartStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback((): void => {
    setStatus('idle');
    setError(null);
  }, []);

  const start = useCallback(
    async (peer: string): Promise<Hex | null> => {
      setError(null);

      if (owner === null || myX25519Pub === null) {
        setStatus('error');
        setError('Unlock your identity first — the conversation id is derived from your key.');
        return null;
      }
      if (contracts === null && !isDemoActive()) {
        setStatus('error');
        setError('HoodGram is not configured for this chain, so the key registry cannot be read.');
        return null;
      }

      setStatus('resolving');

      const resolved = await resolveRecipient(config, peer);
      if (!resolved.ok) {
        setStatus('error');
        setError(resolved.failure.message);
        return null;
      }
      const target = resolved.recipient.address;

      if (target.toLowerCase() === owner.toLowerCase()) {
        setStatus('error');
        setError('That is your own address.');
        return null;
      }

      /* Demo: the fixture world is the registry — reuse the seeded thread for
         a cast member, or open a fresh local one. No chain read. */
      if (isDemoActive()) {
        const convoId = demoConvoIdFor(target);
        const now = Math.floor(Date.now() / 1000);
        await upsertPeer({
          id: peerId(owner, convoId),
          owner,
          convoId,
          address: target,
          x25519Pub: `0x${'11'.repeat(32)}`,
          createdAt: now,
          lastSeenAt: now,
        });
        setStatus('done');
        return convoId;
      }
      if (contracts === null) {
        setStatus('error');
        setError('HoodGram is not configured for this chain, so the key registry cannot be read.');
        return null;
      }

      try {
        const registered = await readContract(config, {
          address: contracts.keyRegistry,
          abi: keyRegistryAbi,
          functionName: 'keysOf',
          args: [target],
          chainId: ACTIVE_CHAIN_ID,
        });

        const peerPubHex = registered[0];
        if (peerPubHex.toLowerCase() === ZERO_KEY) {
          setStatus('error');
          setError(
            'That account has not registered messaging keys yet, so nothing can be encrypted to it. Registering is free — ask them to open HoodGram once.',
          );
          return null;
        }

        const peerBytes = toKeyBytes(peerPubHex);
        const myBytes = toKeyBytes(myX25519Pub);
        if (peerBytes === null || myBytes === null) {
          setStatus('error');
          setError('The registry returned a key that is not a valid X25519 public key.');
          return null;
        }

        const convoId = convoIdFor(myBytes, peerBytes);
        const now = Math.floor(Date.now() / 1000);
        await upsertPeer({
          id: peerId(owner, convoId),
          owner,
          convoId,
          address: target,
          x25519Pub: peerPubHex,
          createdAt: now,
          lastSeenAt: now,
        });

        setStatus('done');
        return convoId;
      } catch (readError: unknown) {
        setStatus('error');
        setError(describeChainError(readError, 'The key registry could not be read.'));
        return null;
      }
    },
    [config, contracts, myX25519Pub, owner],
  );

  return { status, error, isBusy: status === 'resolving', start, reset };
}
