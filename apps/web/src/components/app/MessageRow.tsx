'use client';

import type { ReactNode } from 'react';
import type { Address } from 'viem';

import { cx } from '@/lib/cx';
import { formatTimeShort, truncateAddress } from '@/lib/format';
import {
  parseMediaPayload,
  useHandle,
  usePerkTier,
  type ChatMessage,
  type MessageStatus,
} from '@/hooks';
import { MediaAttachment } from './MediaAttachment';
import { PerkChip } from './PerkChip';
import s from './MessageRow.module.css';

/** The fixed reaction set — content, not iconography. */
export const REACTION_EMOJI: readonly string[] = ['👍', '🔥', '💯', '👀'];

/** One emoji's tally under a message. */
export interface ReactionSummary {
  readonly emoji: string;
  readonly count: number;
  /** True when one of the reactions is our own. */
  readonly mine: boolean;
}

export interface MessageRowProps {
  readonly message: ChatMessage;
  /** The message this one replies to, already resolved locally. */
  readonly quoted?: ChatMessage | null;
  /** Aggregated reactions targeting this message. */
  readonly reactions?: readonly ReactionSummary[];
  /** Room rows attribute senders against the local roster. */
  readonly roomMembers?: readonly Address[] | null;
  readonly onRetry?: (id: string) => void;
  readonly retrying?: boolean;
  /** Arms the reply affordance. */
  readonly onReply?: (message: ChatMessage) => void;
  /** Arms the reaction bar. */
  readonly onReact?: (message: ChatMessage, emoji: string) => void;
}

function statusTone(status: MessageStatus): string {
  switch (status) {
    case 'anchored':
      return 'anchored';
    case 'failed':
      return 'failed';
    case 'received':
      return 'received';
    default:
      return 'working';
  }
}

/** Resolved author line: @handle or address, with the holder rank beside it. */
function AuthorName({ address }: { readonly address: Address }): ReactNode {
  const handle = useHandle(address);
  const tier = usePerkTier(address);
  return (
    <>
      <span className={s.author} title={address}>
        {handle === null ? truncateAddress(address) : `@${handle}`}
      </span>
      <PerkChip tier={tier} />
    </>
  );
}

/**
 * The delivery state, in words, on your own messages only.
 *
 * This was a tick and then two green ticks. It was replaced because that
 * alphabet already means something else: everywhere people have learned it, a
 * second tick means *seen*. HoodGram has no read receipts and never will — it
 * cannot know whether a message was opened — so borrowing the mark would have
 * been claiming a capability the product does not have. A word cannot be
 * misread that way.
 *
 * Four states and no more. "On chain" is the one that carries the product, and
 * saying it in two words is also the plainest way to teach what the product
 * does that nothing else does.
 */
const DELIVERY_LABEL: Readonly<Record<MessageStatus, string | null>> = {
  sealing: 'sending',
  uploading: 'sending',
  signing: 'sending',
  queued: 'sent',
  pending: 'sent',
  anchored: 'on chain',
  failed: 'not sent',
  /* Inbound messages never show one; the map is total so a new status cannot
     silently fall through to a blank. */
  received: null,
};

function DeliveryState({ status }: { readonly status: MessageStatus }): ReactNode {
  const label = DELIVERY_LABEL[status];
  if (label === null) return null;

  return (
    <span
      className={cx(
        s.state,
        status === 'anchored' && s.stateAnchored,
        status === 'failed' && s.stateFailed,
      )}
    >
      {label}
    </span>
  );
}

/** Shown in place of a body when the attachment descriptor will not parse. */
const MEDIA_UNREADABLE = 'Attachment descriptor could not be read.';

function quotedPreview(quoted: ChatMessage): string {
  if (quoted.kind === 'media') {
    const payload = parseMediaPayload(quoted.body);
    return payload === null || payload.name === '' ? 'Attachment' : payload.name;
  }
  const single = quoted.body.replace(/\s+/g, ' ').trim();
  return single.length > 120 ? `${single.slice(0, 119)}…` : single;
}

/**
 * One message.
 *
 * A rounded bubble with the clock tucked into its bottom corner, and on your own
 * messages a delivery tick beside it. That is the entire row.
 *
 * It used to lean 9° like the buttons do. The shear was dropped because a
 * slanted box cuts inward by (H/2)·tan(9°) at the corner where the first line
 * starts and again where the last line ends, so every bubble needed side
 * padding that grew with its own height — and a long paragraph still came out
 * with a visibly ragged edge. The brand survives in the green, the chrome and
 * the send key; it does not need to be in the shape of every sentence.
 *
 * `system` rows collapse to a single quiet ruled line and never take a bubble.
 */
export function MessageRow({
  message,
  quoted = null,
  reactions = [],
  roomMembers = null,
  onRetry,
  retrying = false,
  onReply,
  onReact,
}: MessageRowProps): ReactNode {
  const outbound = message.direction === 'out';
  const tone = statusTone(message.status);

  /* ── system rows: one quiet line, no metadata column ─────────────────── */
  if (message.kind === 'system') {
    return (
      <article className={s.systemRow} data-status={message.status}>
        <span className={s.systemRule} aria-hidden="true" />
        <span className={s.systemText}>{message.body}</span>
        <time className={s.systemTime} dateTime={new Date(message.sentAt * 1000).toISOString()}>
          {formatTimeShort(message.sentAt)}
        </time>
      </article>
    );
  }

  /* Room senders are attributed only when the poster is a known member —
     relayed room drops carry the relay's address, and claiming otherwise
     would be a lie. */
  const inRoomRoster =
    roomMembers !== null &&
    message.poster !== null &&
    roomMembers.some((member) => member.toLowerCase() === message.poster?.toLowerCase());

  const mediaPayload = message.kind === 'media' ? parseMediaPayload(message.body) : null;

  /* A name over every bubble is only information in a room, and only on
     somebody else's message. */
  const showAuthor = !outbound && roomMembers !== null;

  const canReply = onReply !== undefined && message.blobRef !== null;
  const canReact = onReact !== undefined && message.blobRef !== null;

  /* One strip, two homes: inside the bubble when the body is text, bare above
     the frame when it is media — a reply strip nested in a leaning box on top
     of an already-notched attachment frame is three shapes deep. */
  const quoteStrip =
    quoted === null ? null : (
      <div className={s.quote}>
        <span className={s.quoteRule} aria-hidden="true" />
        <span className={s.quoteWho}>{quoted.direction === 'out' ? 'You' : 'Reply to'}</span>
        <span className={s.quoteText}>{quotedPreview(quoted)}</span>
      </div>
    );

  return (
    <article
      className={cx(s.row, outbound ? s.out : s.in, s[tone])}
      data-status={message.status}
    >
      <div className={s.main}>
        {/* The author line only appears where it carries information: in a room,
            on somebody else's message. A one-to-one thread already has the name
            in the bar above it, and repeating it over every bubble is the noise
            this redesign exists to remove. */}
        {showAuthor && (
          <header className={s.who}>
            {message.poster === null ? (
              <span className={s.author}>Unattributed</span>
            ) : roomMembers !== null && !inRoomRoster ? (
              <span className={s.author} title={message.poster}>
                Member
              </span>
            ) : (
              <AuthorName address={message.poster} />
            )}
            {message.integrity === 'unverified' && (
              <span
                className={s.unverified}
                title="This browser could not recompute the blob hash."
              >
                Unverified
              </span>
            )}
          </header>
        )}

        {mediaPayload === null ? (
          <div className={s.bubble}>
            {quoteStrip}
            <p className={s.body}>
              {message.kind === 'media' ? (
                <span className={s.bodyDim}>{MEDIA_UNREADABLE}</span>
              ) : (
                message.body
              )}
            </p>
            <span className={s.stamp}>
              <time className={s.time} dateTime={new Date(message.sentAt * 1000).toISOString()}>
                {formatTimeShort(message.sentAt)}
              </time>
              {outbound && <DeliveryState status={message.status} />}
            </span>
          </div>
        ) : (
          <>
            {quoteStrip}
            <MediaAttachment payload={mediaPayload} className={s.media} />
            <span className={cx(s.stamp, s.stampBare)}>
              <time className={s.time} dateTime={new Date(message.sentAt * 1000).toISOString()}>
                {formatTimeShort(message.sentAt)}
              </time>
              {outbound && <DeliveryState status={message.status} />}
            </span>
          </>
        )}

        {reactions.length > 0 && (
          <div className={s.reactions} aria-label="Reactions">
            {reactions.map((reaction) => (
              <span
                key={reaction.emoji}
                className={cx(s.reaction, reaction.mine && s.reactionMine)}
              >
                <span className={s.reactionEmoji}>{reaction.emoji}</span>
                <span className={s.reactionCount}>{reaction.count}</span>
              </span>
            ))}
          </div>
        )}

        {(canReply || canReact) && (
          <div className={s.actions}>
            {canReply && (
              <button
                type="button"
                className={s.actionKey}
                onClick={() => onReply(message)}
              >
                Reply
              </button>
            )}
            {canReact &&
              REACTION_EMOJI.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  className={s.reactKey}
                  onClick={() => onReact(message, emoji)}
                  aria-label={`React with ${emoji}`}
                >
                  {emoji}
                </button>
              ))}
          </div>
        )}

        {message.error !== null && (
          <p className={s.error} role="alert">
            <span className={s.errorMark} aria-hidden="true" />
            <span className={s.errorText}>{message.error}</span>
            {onRetry !== undefined && message.status === 'failed' && (
              <button
                type="button"
                className={s.retry}
                onClick={() => onRetry(message.id)}
                disabled={retrying}
              >
                {retrying ? 'Retrying…' : 'Retry'}
              </button>
            )}
          </p>
        )}
      </div>

    </article>
  );
}
