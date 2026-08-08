'use client';

/**
 * One thread (SPEC §7.3) — a DM or a room.
 *
 * Rounded bubbles, a clock in the corner and a delivery tick — the on-chain
 * metadata that used to sit beside every row is gone (client call, 9 Aug 2026).
 * Reading is unconditional: an unactivated account loses the composer and
 * nothing else, and a room whose rent lapsed keeps its history while new
 * messages wait for anyone to pay.
 */

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { isHex, type Hex } from 'viem';

import { Button, Countdown, Eyebrow } from '@/components/ui';
import {
  parseReactionPayload,
  useConversation,
  useConversationMessages,
  useDemoActive,
  useHandle,
  usePayRent,
  useRentQuote,
  useRoomChain,
  useSendMessage,
  type ChatMessage,
  type Conversation,
  type RoomChainState,
  type RoomRecord,
} from '@/hooks';
import { cx } from '@/lib/cx';
import { SECONDS_PER_DAY, formatCount, formatToken, truncateAddress, truncateRef } from '@/lib/format';
import { usePrefersReducedMotion } from '@/lib/use-prefers-reduced-motion';
import { AppNotice } from './AppNotice';
import { Avatar } from './Avatar';
import { Composer } from './Composer';
import { LockedNotice } from './LockedNotice';
import { MessageRow, type ReactionSummary } from './MessageRow';
import { RoomMembers } from './RoomMembers';
import { useAppSession } from './session';
import s from './Thread.module.css';

/** A conversation id is a sha256 digest: `0x` + 64 hex characters. */
function asConvoId(raw: string): Hex | null {
  const decoded = ((): string => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  })();
  const candidate = decoded.trim().toLowerCase();
  if (!isHex(candidate) || candidate.length !== 66) return null;
  return candidate;
}

function peerLabelOf(conversation: Conversation): string {
  if (conversation.room !== null) return conversation.room.name;
  if (conversation.unattributed) return 'unattributed drops';
  if (conversation.peerAddress !== null) return truncateAddress(conversation.peerAddress);
  return truncateRef(conversation.convoId);
}

/* ═══════════════════════════════════════════════ room rent, inline ══════ */

interface RentLapsedNoticeProps {
  readonly room: RoomRecord;
  readonly chain: RoomChainState;
}

function RentLapsedNotice({ room, chain }: RentLapsedNoticeProps): ReactNode {
  const session = useAppSession();
  const demo = useDemoActive();
  const rent = usePayRent(room.groupId, session.address);
  const quote = useRentQuote(1);
  const [demoNote, setDemoNote] = useState<string | null>(null);

  const onPay = useCallback((): void => {
    if (demo) {
      /* Simulated: the payment path is real in the live app, not here. */
      setDemoNote('Simulated — rent is paid on chain in the live app.');
      return;
    }
    void (async (): Promise<void> => {
      const ok = await rent.pay(1);
      if (ok) chain.refetch();
    })();
  }, [chain, demo, rent]);

  return (
    <AppNotice
      className={s.footNotice}
      tone="warn"
      title="Rent lapsed — anyone can pay"
      body="New messages are blocked until the rent is current. History, keys and membership are untouched, and paying grants no control — a member keeping a room alive is a feature."
      meta={demoNote ?? rent.error ?? undefined}
      action={
        <Button
          size="sm"
          variant="primary"
          loading={rent.isBusy}
          loadingLabel={rent.phase === 'approving' ? 'Approving $GRAM' : 'Paying rent'}
          onClick={onPay}
        >
          {quote === null
            ? 'Pay 1 month'
            : `Pay 1 month · ${formatToken(quote, { digits: 0, compact: true })} GRAM`}
        </Button>
      }
    />
  );
}

/* ══════════════════════════════════════════════════ thread headers ══════ */

/**
 * Who you are talking to, and nothing else.
 *
 * The bar used to carry an eyebrow ("Thread" / "Room"), a message count, an
 * anchor count and an in-flight count. A messenger's header answers one
 * question, and the avatar's shape already says whether this is a person or a
 * room, so the label was saying what the picture had said.
 */
function DmHeaderName({ conversation }: { readonly conversation: Conversation }): ReactNode {
  const handle = useHandle(conversation.peerAddress);

  const name =
    conversation.peerAddress === null
      ? conversation.unattributed
        ? 'Drops with no known sender'
        : truncateRef(conversation.convoId)
      : handle !== null
        ? `@${handle}`
        : truncateAddress(conversation.peerAddress);

  return (
    <span className={s.headName} title={conversation.peerAddress ?? undefined}>
      {name}
    </span>
  );
}

/* ══════════════════════════════════════════════════════════ the thread ══ */

interface ThreadProps {
  readonly convoId: Hex;
}

function Thread({ convoId }: ThreadProps): ReactNode {
  const session = useAppSession();
  const conversation = useConversation(convoId);
  const messages = useConversationMessages(convoId);
  const send = useSendMessage({ owner: session.address, keys: session.keys });
  const reducedMotion = usePrefersReducedMotion();

  const room = conversation?.room ?? null;
  const roomChain = useRoomChain(room === null ? null : room.groupId);

  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [showMembers, setShowMembers] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const shownConvoRef = useRef<Hex | null>(null);
  const { reset: resetSend } = send;

  /* Content rows on screen; reactions decorate them from the side. */
  const { rows, reactionsByRef, byBlobRef } = useMemo(() => {
    const contentRows: ChatMessage[] = [];
    const reactionMap = new Map<string, Map<string, { count: number; mine: boolean }>>();
    const refMap = new Map<string, ChatMessage>();

    for (const message of messages) {
      if (message.blobRef !== null) refMap.set(message.blobRef.toLowerCase(), message);

      if (message.kind === 'react') {
        const payload = parseReactionPayload(message.body);
        if (payload === null) continue;
        const target = payload.target.toLowerCase();
        let perEmoji = reactionMap.get(target);
        if (perEmoji === undefined) {
          perEmoji = new Map();
          reactionMap.set(target, perEmoji);
        }
        const entry = perEmoji.get(payload.emoji) ?? { count: 0, mine: false };
        perEmoji.set(payload.emoji, {
          count: entry.count + 1,
          mine: entry.mine || message.direction === 'out',
        });
        continue;
      }
      contentRows.push(message);
    }

    const summaries = new Map<string, readonly ReactionSummary[]>();
    for (const [target, perEmoji] of reactionMap) {
      summaries.set(
        target,
        [...perEmoji.entries()].map(([emoji, entry]) => ({
          emoji,
          count: entry.count,
          mine: entry.mine,
        })),
      );
    }
    return { rows: contentRows, reactionsByRef: summaries, byBlobRef: refMap };
  }, [messages]);

  /* Follow the tail: jump when the thread changes, glide when a row lands. */
  useEffect(() => {
    const node = scrollRef.current;
    if (node === null) return;
    const switched = shownConvoRef.current !== convoId;
    shownConvoRef.current = convoId;
    node.scrollTo({
      top: node.scrollHeight,
      behavior: switched || reducedMotion ? 'auto' : 'smooth',
    });
  }, [convoId, rows.length, reducedMotion]);

  /* A failure in one thread is not a failure in the next one. */
  useEffect(() => {
    resetSend();
    setReplyTo(null);
    setShowMembers(false);
  }, [convoId, resetSend]);

  const onReply = useCallback((message: ChatMessage): void => {
    setReplyTo(message);
  }, []);

  const onReact = useCallback(
    (message: ChatMessage, emoji: string): void => {
      if (message.blobRef === null) return;
      void send.sendReaction({ convoId, target: message.blobRef, emoji });
    },
    [convoId, send],
  );

  /* The device cache has not been read yet — claiming the thread is missing
     before we have looked would be a lie that lasts a frame. */
  if (conversation === null && !session.drops.isHydrated) {
    return (
      <div className={s.missing}>
        <div className={s.missingBody}>
          <Eyebrow rule>Opening</Eyebrow>
          <h1 className={s.missingTitle}>Reading this device&apos;s history.</h1>
          <p className={s.missingText}>
            Messages you sent cannot be recovered from the chain — the ephemeral key that sealed
            them is destroyed at send time — so your side of every thread is held here, and it is
            being loaded now.
          </p>
          <span className={s.missingBar} aria-hidden="true" />
        </div>
      </div>
    );
  }

  if (conversation === null) {
    return (
      <div className={s.missing}>
        <div className={s.missingBody}>
          <Eyebrow rule>Unknown thread</Eyebrow>
          <h1 className={s.missingTitle}>This conversation is not on this device.</h1>
          <p className={s.missingText}>
            1:1 conversation ids are derived locally from the two participants&apos; X25519 public
            keys and never posted on chain, so they cannot be recovered from a link alone. Open it
            again from the other side&apos;s address or handle and the same id comes back. Rooms
            appear the moment their key drop arrives.
          </p>
          <p className={s.missingMeta}>{truncateRef(convoId)}</p>
          <Link href="/app" className={s.missingLink}>
            Back to conversations
          </Link>
        </div>
      </div>
    );
  }

  const label = peerLabelOf(conversation);
  const locked = !session.activation.isActivated;
  const isRoom = room !== null;
  const rentLapsed = isRoom && roomChain.exists && !roomChain.isActive;
  const composerDisabled = locked || !conversation.canReply || rentLapsed;

  return (
    <section className={s.thread} aria-label={`Conversation with ${label}`}>
      <header className={s.head}>
        <Link href="/app" className={s.back}>
          <svg className={s.backIcon} viewBox="0 0 12 12" aria-hidden="true">
            <path d="M7.5 1.5 3 6l4.5 4.5" />
          </svg>
          <span>All</span>
        </Link>

        <Avatar
          seed={isRoom ? room.groupId : (conversation.peerAddress ?? conversation.convoId)}
          label={isRoom ? room.name : peerLabelOf(conversation)}
          size="md"
          square={isRoom}
        />

        <div className={s.headMain}>
          {isRoom ? (
            <span className={s.headName} title={room.groupId}>
              {room.name}
            </span>
          ) : (
            <DmHeaderName conversation={conversation} />
          )}
        </div>

        <div className={s.headStats}>
          {/* Rooms keep two things and only two: the roster, because it is a
              control rather than a statistic, and the rent, because a lapsed
              room silently refuses new messages and that has to be visible. */}
          {isRoom ? (
            <>
              <button
                type="button"
                className={cx(s.membersToggle, showMembers && s.membersToggleOn)}
                onClick={() => setShowMembers((value) => !value)}
                aria-expanded={showMembers}
              >
                {formatCount(room.members.length)} members
              </button>
              {rentLapsed && (
                <span className={cx(s.stat, s.statFailed)}>rent lapsed</span>
              )}
              {!rentLapsed && roomChain.exists && roomChain.paidUntil > 0 && (
                <Countdown
                  to={roomChain.paidUntil}
                  size="sm"
                  warnSeconds={3 * SECONDS_PER_DAY}
                  expiredLabel="lapsed"
                  className={s.rentClock}
                />
              )}
            </>
          ) : null}
          {conversation.failedCount > 0 && (
            <span className={cx(s.stat, s.statFailed)}>
              {formatCount(conversation.failedCount)} failed
            </span>
          )}
        </div>
      </header>

      {isRoom && showMembers && <RoomMembers room={room} chain={roomChain} />}

      <div className={s.scroll} ref={scrollRef}>
        {rows.length === 0 ? (
          <div className={s.empty}>
            <span className={s.emptyRule} aria-hidden="true" />
            <Eyebrow>Nothing anchored yet</Eyebrow>
            <p className={s.emptyText}>
              {isRoom
                ? 'Room messages seal to the group key for the current epoch and anchor under the room id. Every member holding the key opens them; the relay holds only ciphertext.'
                : conversation.unattributed
                  ? 'These drops decrypted with your key, but the address that posted them has no registered public key — so there is no one to reply to. Self-posted relays land here by design.'
                  : 'Your first message seals to a fresh ephemeral key, pads to a fixed bucket, and is anchored with the recipient nowhere on chain. They find it by view tag.'}
            </p>
            <dl className={s.emptyFacts}>
              <div className={s.emptyFact}>
                <dt className={s.emptyFactKey}>{isRoom ? 'Room id' : 'Local id'}</dt>
                <dd className={s.emptyFactValue}>{truncateRef(conversation.convoId)}</dd>
              </div>
              <div className={s.emptyFact}>
                <dt className={s.emptyFactKey}>On chain</dt>
                <dd className={s.emptyFactValue}>
                  {isRoom ? 'room id · announced' : '0x00…00 · stealth'}
                </dd>
              </div>
              <div className={s.emptyFact}>
                <dt className={s.emptyFactKey}>{isRoom ? 'Key epoch' : 'Recipient key'}</dt>
                <dd className={s.emptyFactValue}>
                  {isRoom
                    ? formatCount(room.epoch)
                    : conversation.peerX25519 === null
                      ? 'unknown'
                      : truncateRef(conversation.peerX25519)}
                </dd>
              </div>
            </dl>
          </div>
        ) : (
          <ol className={s.rows}>
            {rows.map((message) => (
              <li key={message.id} className={s.rowItem}>
                <MessageRow
                  message={message}
                  quoted={
                    message.re === null
                      ? null
                      : byBlobRef.get(message.re.toLowerCase()) ?? null
                  }
                  reactions={
                    message.blobRef === null
                      ? []
                      : reactionsByRef.get(message.blobRef.toLowerCase()) ?? []
                  }
                  roomMembers={isRoom ? room.members : null}
                  onRetry={(id) => {
                    void send.retry(id);
                  }}
                  retrying={send.isSending}
                  {...(composerDisabled ? {} : { onReply, onReact })}
                />
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className={s.foot}>
        {locked && <LockedNotice activation={session.activation} variant="inline" />}

        {!locked && rentLapsed && room !== null && (
          <RentLapsedNotice room={room} chain={roomChain} />
        )}

        {!locked && !rentLapsed && !conversation.canReply && (
          <AppNotice
            className={s.footNotice}
            tone="warn"
            title={conversation.unattributed ? 'No one to reply to' : 'No recipient key'}
            body={
              conversation.unattributed
                ? 'These drops were opened with your key, but nothing on chain says who wrote them. Ask the sender for their address or handle and open a thread from it.'
                : 'This device holds no X25519 public key for the other side, so nothing can be encrypted to them. Open the conversation again from their address or handle to fetch it.'
            }
            action={
              <Button
                size="sm"
                onClick={() => {
                  session.drops.resync();
                }}
              >
                Resync
              </Button>
            }
          />
        )}

        {/* Keyed on the thread: a half-written draft must never follow you into
            someone else's conversation. */}
        <Composer
          key={convoId}
          convoId={convoId}
          send={send}
          peerLabel={label}
          replyTo={replyTo}
          onCancelReply={() => setReplyTo(null)}
          disabled={composerDisabled}
        />
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════ the route shim ══ */

export interface ThreadRouteProps {
  /** Raw `[convoId]` segment, straight from the URL. */
  readonly convoId: string;
}

/**
 * Validates the URL segment before the thread ever sees it.
 *
 * A malformed id is a designed state with a way out, never a crash and never a
 * blank pane.
 */
export function ThreadRoute({ convoId }: ThreadRouteProps): ReactNode {
  const parsed = asConvoId(convoId);

  if (parsed === null) {
    return (
      <div className={s.missing}>
        <div className={s.missingBody}>
          <Eyebrow rule>Malformed id</Eyebrow>
          <h1 className={s.missingTitle}>That is not a conversation id.</h1>
          <p className={s.missingText}>
            A conversation id is a sha256 digest — <code className={s.code}>0x</code> followed by
            64 hex characters. Pick a thread from the rail, or open one from an address or
            handle.
          </p>
          <Link href="/app" className={s.missingLink}>
            Back to conversations
          </Link>
        </div>
      </div>
    );
  }

  return <Thread convoId={parsed} />;
}
