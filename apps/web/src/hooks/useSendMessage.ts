'use client';

import {
  BUCKETS,
  MAX_MEDIA_BYTES,
  seal,
  sealMedia,
  sealToGroup,
  signDrop,
  type IdentityKeys,
  type SealedDrop,
} from '@telehood/crypto';
import { useCallback, useEffect, useState } from 'react';
import { hexToBytes, parseEventLogs, type Address, type Hex } from 'viem';
import { useConfig, useWriteContract } from 'wagmi';
import { waitForTransactionReceipt } from 'wagmi/actions';

import { anchorsAbi } from '@/lib/abi';
import { ACTIVE_CHAIN_ID, tryGetContracts } from '@/lib/chain';
import { DEMO_ME, isDemoActive } from '@/lib/demo';
import {
  RelaySendError,
  postBlob,
  sendDrop,
  type SendRejectionCode,
} from '@/lib/relay';
import { useSendPrefs } from '@/lib/ui-store';
import { nextDemoBlock, nextDemoSeq } from './demo-world';
import { describeChainError } from './errors';
import { messageId } from './message-store';
import {
  addMessage,
  findMessage,
  findPeer,
  findRoom,
  latestRoomKey,
  patchMessage,
  removeMessage,
  renameMessage,
  useMessengerStore,
} from './messenger-store';
import {
  STEALTH_CONVO_ID,
  type ChatMessage,
  type MessageKind,
} from './types';

/** Largest padded bucket, minus the 4-byte length prefix (SPEC §5). */
export const MAX_BODY_BYTES = 16_384 - 4;

/** Largest attachment: the 4 MB media bucket, minus its length prefix. */
export const MAX_ATTACHMENT_BYTES = MAX_MEDIA_BYTES;

const encoder = new TextEncoder();

export interface EnvelopePreview {
  /** Bytes the padded plaintext will occupy before encryption. */
  readonly bytes: number;
  /** The bucket it pads up to, or `null` when the body is too long. */
  readonly bucket: number | null;
  readonly overflow: boolean;
}

/**
 * What a body will look like on the wire.
 *
 * Padding is the point: every message in a bucket is byte-identical in length,
 * so the composer can honestly show which of four size classes it lands in.
 */
export function previewEnvelope(body: string): EnvelopePreview {
  const payload = JSON.stringify({ v: 1, t: Math.floor(Date.now() / 1000), kind: 'text', body });
  const bytes = encoder.encode(payload).length + 4;
  const bucket = BUCKETS.find((size) => bytes <= size) ?? null;
  return { bytes, bucket, overflow: bucket === null };
}

/**
 * `queued` — the relay verified the drop signature and accepted it; the row
 * (and this stage) flip to `anchored` when the WS stream delivers the drop
 * whose `blobRef` matches. `signing`/`pending` belong to the wallet path.
 */
export type SendStage =
  | 'idle'
  | 'sealing'
  | 'uploading'
  | 'relaying'
  | 'signing'
  | 'queued'
  | 'pending'
  | 'anchored'
  | 'failed';

export interface SendInput {
  readonly convoId: Hex;
  readonly body: string;
  /** blobRef of the message being replied to. */
  readonly re?: Hex;
}

export interface SendMediaInput {
  readonly convoId: Hex;
  /** Raw file bytes, ≤ {@link MAX_ATTACHMENT_BYTES}. */
  readonly data: Uint8Array;
  readonly mime: string;
  readonly name: string;
  readonly re?: Hex;
}

export interface SendReactionInput {
  readonly convoId: Hex;
  /** blobRef of the message being reacted to. */
  readonly target: Hex;
  readonly emoji: string;
}

export interface UseSendMessageParams {
  readonly owner: Address | null;
  /** Full identity keys — the Ed25519 half signs relayed drops. */
  readonly keys: IdentityKeys | null;
}

export interface UseSendMessageResult {
  readonly stage: SendStage;
  readonly error: string | null;
  readonly isSending: boolean;
  /** Set when the failure came from the relay and self-posting would work. */
  readonly canFallbackToWallet: boolean;
  /** The row currently in flight, so the composer can point at it. */
  readonly pendingId: string | null;
  /** @returns true when the message was queued (relay) or anchored (wallet). */
  send: (input: SendInput) => Promise<boolean>;
  /** Encrypts and sends a file, then the descriptor message that carries it. */
  sendMedia: (input: SendMediaInput) => Promise<boolean>;
  /** Sends a `react` drop targeting an anchored message. */
  sendReaction: (input: SendReactionInput) => Promise<boolean>;
  /** Re-seals and re-posts a failed row under a fresh key. */
  retry: (id: string) => Promise<boolean>;
  reset: () => void;
}

function localId(owner: Address): string {
  const random =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${owner.toLowerCase()}:draft:${random}`;
}

/** Random 32-byte hex — the fake content address of a simulated demo drop. */
function randomHex32(): Hex {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return `0x${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** How long a simulated demo drop sits `queued` before "anchoring". */
const DEMO_ANCHOR_MS = 700;

/** Human copy for every relay rejection slug, each one an action. */
const REJECTION_COPY: Readonly<Record<SendRejectionCode, string>> = {
  send_disabled:
    'The relay is not posting right now. Flip on self-post (wallet + gas) to anchor it yourself — nothing was lost.',
  blob_missing:
    'The relay no longer holds the ciphertext it was just given. Send again — the message will be re-uploaded.',
  unknown_key:
    'The relay does not recognise your signing key. Publish your keys again from the identity gate, then resend.',
  bad_signature:
    'The relay rejected the drop signature. Re-derive your identity (sign again) and resend.',
  not_activated:
    'This wallet is not activated. Activation is $5 in $THOOD, once, forever — open Access to activate, then resend.',
  room_inactive:
    'This room’s rent has lapsed, so new messages are blocked. Any member can pay rent to reopen it.',
  queue_full:
    'The relay’s queue is full. Wait a moment and resend, or flip on self-post to anchor it yourself.',
  rate_limited: 'The relay is rate-limiting this device. Wait a moment and resend.',
  invalid_body: 'The relay rejected the request shape. Reload and try again.',
  invalid_json: 'The relay rejected the request shape. Reload and try again.',
  unknown: 'The relay refused the drop. Try again, or flip on self-post to anchor it yourself.',
};

/** Rejections where the wallet path is a real way out right now. */
const WALLET_FALLBACK_CODES: readonly SendRejectionCode[] = [
  'send_disabled',
  'queue_full',
  'unknown',
];

interface DispatchInput {
  readonly convoId: Hex;
  readonly kind: MessageKind;
  readonly body: string;
  readonly re: Hex | null;
}

/**
 * The send path (SPEC §7.3), gasless by default:
 *
 *   `seal()` → `POST /v1/blob` → `signDrop()` with the Ed25519 identity key →
 *   `POST /v1/send` → optimistic row at `queued` → `anchored` when the relay's
 *   WS stream delivers the drop with the same `blobRef`.
 *
 * The relayed anchor's on-chain poster is the relay, never the sender — own
 * rows are recognised by content address, which the receive engine already
 * does. `Anchors.post` from the user's wallet (gas only, never payable)
 * remains as the self-post fallback, reachable via the composer toggle or
 * offered on relay failure.
 *
 * DMs seal to the peer's registered X25519 key and anchor `convoId = 0x0`
 * (stealth). Rooms seal to the group's current epoch key and anchor
 * `convoId = groupId` — announced by design, since rent gates it on chain.
 */
export function useSendMessage({ owner, keys }: UseSendMessageParams): UseSendMessageResult {
  const config = useConfig();
  const { writeContractAsync } = useWriteContract();
  const contracts = tryGetContracts(ACTIVE_CHAIN_ID);
  const selfPost = useSendPrefs((state) => state.selfPost);

  const [stage, setStage] = useState<SendStage>('idle');
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [canFallbackToWallet, setCanFallbackToWallet] = useState(false);

  /* Flip the composer's readout to `anchored` when the WS drop lands. */
  const pendingStatus = useMessengerStore(
    useCallback(
      (state) =>
        pendingId === null
          ? null
          : state.messages.find((message) => message.id === pendingId)?.status ?? null,
      [pendingId],
    ),
  );
  useEffect(() => {
    if (stage === 'queued' && pendingStatus === 'anchored') {
      setStage('anchored');
      setPendingId(null);
    }
  }, [pendingStatus, stage]);

  const reset = useCallback((): void => {
    setStage('idle');
    setError(null);
    setPendingId(null);
    setCanFallbackToWallet(false);
  }, []);

  const fail = useCallback(
    async (id: string | null, message: string, walletWouldWork = false): Promise<false> => {
      setStage('failed');
      setError(message);
      setCanFallbackToWallet(walletWouldWork);
      if (id !== null) await patchMessage(id, { status: 'failed', error: message });
      return false;
    },
    [],
  );

  const dispatch = useCallback(
    async ({ convoId, kind, body, re }: DispatchInput): Promise<boolean> => {
      setError(null);
      setCanFallbackToWallet(false);

      /* Demo: the gasless feel, simulated — a local row queues, then
         "anchors" after a beat. Nothing touches the relay or the chain. */
      if (isDemoActive()) {
        const me = owner ?? DEMO_ME.address;
        const now = Math.floor(Date.now() / 1000);
        const blobRef = randomHex32();
        const rowId = messageId(me, blobRef);
        setPendingId(rowId);
        setStage('queued');
        await addMessage({
          id: rowId,
          owner: me,
          convoId,
          direction: 'out',
          body,
          kind,
          re,
          sentAt: now,
          status: 'queued',
          integrity: 'local',
          blobRef,
          ephPub: randomHex32(),
          viewTag: Math.floor(Math.random() * 256),
          size: encoder.encode(body).length + 4 <= 256 ? 256 : 1024,
          seq: null,
          blockNumber: null,
          txHash: null,
          poster: me,
          error: null,
        });
        setTimeout(() => {
          void patchMessage(rowId, {
            status: 'anchored',
            seq: nextDemoSeq(),
            blockNumber: nextDemoBlock(),
            error: null,
          });
        }, DEMO_ANCHOR_MS);
        return true;
      }

      if (owner === null || keys === null) {
        return fail(null, 'Unlock your identity before sending.');
      }
      if (contracts === null) {
        return fail(null, 'TeleHood is not configured for this chain, so there is nowhere to anchor.');
      }
      if (encoder.encode(body).length > MAX_BODY_BYTES) {
        return fail(null, 'That message is larger than the biggest padded envelope (16 KB).');
      }

      /* Resolve the sealing target: a room's group key, or the peer's key. */
      const room = findRoom(convoId);
      let sealTask: () => Promise<SealedDrop>;
      let anchoredConvoId: Hex;

      if (room !== null) {
        const groupKey = latestRoomKey(room.groupId);
        if (groupKey === null) {
          return fail(
            null,
            'This device holds no key for the room’s current epoch, so nothing can be encrypted. Ask the admin to re-send the room key.',
          );
        }
        const pt = {
          v: 1,
          t: Math.floor(Date.now() / 1000),
          kind,
          body,
          ...(re === null ? {} : { re }),
        } as const;
        sealTask = () => sealToGroup(pt, groupKey.key);
        anchoredConvoId = room.groupId;
      } else {
        const peer = findPeer(convoId);
        const peerKey = peer?.x25519Pub ?? null;
        if (peer === null || peerKey === null) {
          return fail(
            null,
            'This conversation has no recipient key on this device, so nothing can be encrypted. Start it again from the address or handle.',
          );
        }
        let recipient: Uint8Array;
        try {
          recipient = hexToBytes(peerKey);
          if (recipient.length !== 32) throw new Error('bad length');
        } catch {
          return fail(null, 'The stored recipient key is not a valid X25519 public key.');
        }
        const pt = {
          v: 1,
          t: Math.floor(Date.now() / 1000),
          kind,
          body,
          ...(re === null ? {} : { re }),
        } as const;
        sealTask = () => seal(pt, recipient);
        anchoredConvoId = STEALTH_CONVO_ID;
      }

      const now = Math.floor(Date.now() / 1000);
      let rowId = localId(owner);
      setPendingId(rowId);

      const optimistic: ChatMessage = {
        id: rowId,
        owner,
        convoId,
        direction: 'out',
        body,
        kind,
        re,
        sentAt: now,
        status: 'sealing',
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
      };
      setStage('sealing');
      await addMessage(optimistic);

      /* 1 — encrypt and pad to a fixed bucket. */
      let sealed: SealedDrop;
      try {
        sealed = await sealTask();
      } catch (sealError: unknown) {
        return fail(rowId, describeChainError(sealError, 'The message could not be encrypted.'));
      }

      const anchoredId = messageId(owner, sealed.blobRef);
      await renameMessage(rowId, anchoredId);
      rowId = anchoredId;
      setPendingId(rowId);
      await patchMessage(rowId, {
        status: 'uploading',
        blobRef: sealed.blobRef,
        ephPub: sealed.ephPub,
        viewTag: sealed.viewTag,
        size: sealed.size,
      });
      setStage('uploading');

      /* 2 — hand the ciphertext to the relay. Content-addressed, so the ref
             it returns must equal the one we computed. */
      try {
        const receipt = await postBlob(sealed.blob);
        if (receipt.blobRef.toLowerCase() !== sealed.blobRef.toLowerCase()) {
          return fail(
            rowId,
            'The relay returned a different blob reference than the ciphertext hashes to. Nothing was anchored.',
          );
        }
      } catch (uploadError: unknown) {
        return fail(rowId, describeChainError(uploadError, 'The ciphertext could not be stored.'));
      }

      const dropFields = {
        convoId: anchoredConvoId,
        ephPub: sealed.ephPub,
        blobRef: sealed.blobRef,
        viewTag: sealed.viewTag,
        size: sealed.size,
      };

      /* 3a — the default: sign the drop and let the relay anchor it. */
      if (!selfPost) {
        setStage('relaying');
        await patchMessage(rowId, { status: 'signing' });

        let signature: Hex;
        try {
          signature = await signDrop(dropFields, keys.ed25519.privateKey);
        } catch (signError: unknown) {
          return fail(rowId, describeChainError(signError, 'The drop could not be signed.'));
        }

        try {
          await sendDrop({ sender: owner, signature, drop: dropFields });
        } catch (relayError: unknown) {
          if (relayError instanceof RelaySendError) {
            return fail(
              rowId,
              REJECTION_COPY[relayError.code],
              WALLET_FALLBACK_CODES.includes(relayError.code),
            );
          }
          return fail(
            rowId,
            'The relay could not be reached, so the drop was not posted. Flip on self-post (wallet + gas) to anchor it yourself.',
            true,
          );
        }

        await patchMessage(rowId, { status: 'queued', error: null });
        setStage('queued');
        return true;
      }

      /* 3b — self-post: anchor it from the user's own wallet. Gas only. */
      setStage('signing');
      await patchMessage(rowId, { status: 'signing' });

      let hash: Hex;
      try {
        hash = await writeContractAsync({
          address: contracts.anchors,
          abi: anchorsAbi,
          functionName: 'post',
          chainId: ACTIVE_CHAIN_ID,
          args: [dropFields],
        });
      } catch (writeError: unknown) {
        return fail(rowId, describeChainError(writeError, 'The anchor transaction was not sent.'));
      }

      setStage('pending');
      await patchMessage(rowId, { status: 'pending', txHash: hash, error: null });

      /* 4 — wait for the receipt and pull the sequence number out of the log. */
      try {
        const receipt = await waitForTransactionReceipt(config, {
          hash,
          chainId: ACTIVE_CHAIN_ID,
        });
        if (receipt.status === 'reverted') {
          return fail(rowId, 'The anchor transaction reverted on chain. Nothing was posted.');
        }

        let seq: number | null = null;
        try {
          const events = parseEventLogs({
            abi: anchorsAbi,
            eventName: 'Dropped',
            logs: receipt.logs,
          });
          for (const event of events) {
            if (event.args.blobRef.toLowerCase() === sealed.blobRef.toLowerCase()) {
              seq = Number(event.args.seq);
              break;
            }
          }
        } catch {
          // The indexer will supply `seq` from the relay stream instead.
        }

        await patchMessage(rowId, {
          status: 'anchored',
          blockNumber: Number(receipt.blockNumber),
          txHash: hash,
          seq,
          error: null,
        });
        setStage('anchored');
        setPendingId(null);
        return true;
      } catch (waitError: unknown) {
        return fail(
          rowId,
          describeChainError(waitError, 'The transaction was sent but its receipt never arrived.'),
        );
      }
    },
    [config, contracts, fail, keys, owner, selfPost, writeContractAsync],
  );

  const send = useCallback(
    async ({ convoId, body, re }: SendInput): Promise<boolean> => {
      const text = body.trim();
      if (text === '') return fail(null, 'Nothing to send.');
      return dispatch({ convoId, kind: 'text', body: text, re: re ?? null });
    },
    [dispatch, fail],
  );

  const sendMedia = useCallback(
    async ({ convoId, data, mime, name, re }: SendMediaInput): Promise<boolean> => {
      if (data.byteLength === 0) return fail(null, 'That file is empty.');
      if (data.byteLength > MAX_ATTACHMENT_BYTES) {
        return fail(null, 'Attachments are capped at 4 MB. Compress it or send a smaller file.');
      }

      /* Demo: no sealing round-trip — the bytes become an object URL the
         descriptor points at directly, and the send is simulated locally. */
      if (isDemoActive()) {
        const copy = new Uint8Array(data.byteLength);
        copy.set(data);
        const url = URL.createObjectURL(new Blob([copy], { type: mime }));
        const descriptor = JSON.stringify({
          mime,
          name,
          bytes: data.byteLength,
          ref: randomHex32(),
          key: randomHex32(),
          src: url,
        });
        return dispatch({ convoId, kind: 'media', body: descriptor, re: re ?? null });
      }

      /* Encrypt the file under its own random key and upload it first, so the
         descriptor never references bytes the relay does not hold. */
      setError(null);
      setStage('sealing');
      let descriptor: string;
      try {
        const media = await sealMedia(data);
        setStage('uploading');
        const receipt = await postBlob(media.blob);
        if (receipt.blobRef.toLowerCase() !== media.blobRef.toLowerCase()) {
          return fail(null, 'The relay returned a different reference for the encrypted file.');
        }
        const keyHex = `0x${[...media.key].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
        descriptor = JSON.stringify({
          mime,
          name,
          bytes: data.byteLength,
          ref: media.blobRef,
          key: keyHex,
        });
      } catch (mediaError: unknown) {
        return fail(null, describeChainError(mediaError, 'The file could not be encrypted and stored.'));
      }

      return dispatch({ convoId, kind: 'media', body: descriptor, re: re ?? null });
    },
    [dispatch, fail],
  );

  const sendReaction = useCallback(
    async ({ convoId, target, emoji }: SendReactionInput): Promise<boolean> => {
      return dispatch({
        convoId,
        kind: 'react',
        body: JSON.stringify({ target, emoji }),
        re: null,
      });
    },
    [dispatch],
  );

  const retry = useCallback(
    async (id: string): Promise<boolean> => {
      const row = findMessage(id);
      if (row === null) return false;
      await removeMessage(id);
      return dispatch({ convoId: row.convoId, kind: row.kind, body: row.body, re: row.re });
    },
    [dispatch],
  );

  return {
    stage,
    error,
    isSending:
      stage === 'sealing' ||
      stage === 'uploading' ||
      stage === 'relaying' ||
      stage === 'signing' ||
      stage === 'pending',
    canFallbackToWallet,
    pendingId,
    send,
    sendMedia,
    sendReaction,
    retry,
    reset,
  };
}
