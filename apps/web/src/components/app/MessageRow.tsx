'use client';

import type { ReactNode } from 'react';
import type { Address } from 'viem';

import { Hex as HexValue } from '@/components/ui';
import { explorerBlockUrl, explorerTxUrl } from '@/lib/chain';
import { cx } from '@/lib/cx';
import {
  formatBlock,
  formatBytes,
  formatClock,
  formatDateTime,
  truncateAddress,
} from '@/lib/format';
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

const STATUS_LABEL: Readonly<Record<MessageStatus, string>> = {
  sealing: 'Sealing',
  uploading: 'Uploading',
  signing: 'Signing',
  queued: 'Queued · relay',
  pending: 'Pending',
  anchored: 'Anchored',
  failed: 'Failed',
  received: 'Received',
};

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

function viewTagLabel(viewTag: number | null): string {
  if (viewTag === null) return '··';
  return viewTag.toString(16).toUpperCase().padStart(2, '0');
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

/** Shown in place of a body when the attachment descriptor will not parse. */
const MEDIA_UNREADABLE = 'Attachment descriptor could not be read.';

/* A box sheared by 9° has edges that cut inward by (H/2)·tan(9°) at the corner
   where the first line starts and the corner where the last line ends, so a
   taller body needs proportionally more inline padding before text meets the
   slope. The step is derived from the text rather than measured: measuring
   would cost a layout read per row on every scroll, and the padding only has
   to be right to within a step. */
/* Characters per line at the narrowest width the bubble is ever laid out at.
   The body is set in Orbitron, a wide geometric face averaging ~0.62em of
   advance — about 8px at 13px type. A 390px viewport leaves the bubble roughly
   300px of measure once the row gutter, the direction mark and the lean
   reserve are taken out, so ~34 characters fit, not the 40 a normal-width face
   would give. Guessing high rounds the step DOWN and under-reserves exactly the
   padding the step exists to provide, so this is deliberately conservative:
   over-reserving costs a few pixels, under-reserving clips the text. */
const LEAN_WRAP_CHARS = 34;

function leanStep(text: string, hasQuote: boolean): 1 | 2 | 3 | 4 {
  let lines = hasQuote ? 1 : 0;
  for (const line of text.split('\n')) {
    lines += Math.max(1, Math.ceil(line.length / LEAN_WRAP_CHARS));
  }
  if (lines >= 12) return 4;
  if (lines >= 6) return 3;
  if (lines >= 3) return 2;
  return 1;
}

function quotedPreview(quoted: ChatMessage): string {
  if (quoted.kind === 'media') {
    const payload = parseMediaPayload(quoted.body);
    return payload === null || payload.name === '' ? 'Attachment' : payload.name;
  }
  const single = quoted.body.replace(/\s+/g, ' ').trim();
  return single.length > 120 ? `${single.slice(0, 119)}…` : single;
}

/**
 * One anchored message.
 *
 * The body sits in the house parallelogram — the same skewX(-9deg) the buttons
 * carry, contents counter-sheared so nothing reads on a slant. Only the body
 * leans. The author line, the timestamp, the perk chip and the whole on-chain
 * metadata column stay square outside it, so the thing you are reading and the
 * thing that was anchored are still visibly the same object. `system` rows
 * collapse to a single quiet ruled line and never take a bubble.
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
  const blockUrl =
    message.blockNumber === null ? null : explorerBlockUrl(message.blockNumber);
  const txUrl = message.txHash === null ? null : explorerTxUrl(message.txHash);

  /* ── system rows: one quiet line, no metadata column ─────────────────── */
  if (message.kind === 'system') {
    return (
      <article className={s.systemRow} data-status={message.status}>
        <span className={s.systemRule} aria-hidden="true" />
        <span className={s.systemText}>{message.body}</span>
        <time className={s.systemTime} dateTime={new Date(message.sentAt * 1000).toISOString()}>
          {formatClock(message.sentAt)}
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
      <span className={s.mark} aria-hidden="true" />

      <div className={s.main}>
        <header className={s.who}>
          {outbound ? (
            <span className={s.author}>You</span>
          ) : message.poster === null ? (
            <span className={s.author}>Unattributed</span>
          ) : roomMembers !== null && !inRoomRoster ? (
            <span className={s.author} title={message.poster}>
              Member
            </span>
          ) : (
            <AuthorName address={message.poster} />
          )}
          <time className={s.time} dateTime={new Date(message.sentAt * 1000).toISOString()}>
            {formatClock(message.sentAt)}
          </time>
          {message.integrity === 'unverified' && (
            <span className={s.unverified} title="This browser could not recompute the blob hash.">
              Unverified
            </span>
          )}
        </header>

        {mediaPayload === null ? (
          <div
            className={s.bubble}
            data-lean={leanStep(
              message.kind === 'media' ? MEDIA_UNREADABLE : message.body,
              quoted !== null,
            )}
          >
            <div className={s.bubbleInner}>
              {quoteStrip}
              <p className={s.body}>
                {message.kind === 'media' ? (
                  <span className={s.bodyDim}>{MEDIA_UNREADABLE}</span>
                ) : (
                  message.body
                )}
              </p>
            </div>
          </div>
        ) : (
          <>
            {quoteStrip}
            <MediaAttachment payload={mediaPayload} className={s.media} />
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

      <div className={s.meta}>
        <span className={cx(s.status, s[`status-${tone}`])}>
          <span className={s.statusDot} aria-hidden="true" />
          {STATUS_LABEL[message.status]}
        </span>

        <span className={s.metaLine} title={formatDateTime(message.sentAt)}>
          {message.blockNumber === null ? (
            <span className={s.metaDim}>
              {message.status === 'queued' ? 'awaiting anchor' : 'no block yet'}
            </span>
          ) : blockUrl === null ? (
            <span>{formatBlock(message.blockNumber)}</span>
          ) : (
            <a className={s.metaLink} href={blockUrl} target="_blank" rel="noreferrer noopener">
              {formatBlock(message.blockNumber)}
            </a>
          )}
        </span>

        <span className={s.metaLine}>
          <span className={s.metaKey}>tag</span>
          <span>{viewTagLabel(message.viewTag)}</span>
          <span className={s.metaSep} aria-hidden="true">
            ·
          </span>
          <span className={s.metaKey}>pad</span>
          <span>{message.size === null ? '—' : formatBytes(message.size)}</span>
        </span>

        {message.blobRef !== null && (
          <HexValue
            value={message.blobRef}
            label="Blob reference"
            lead={6}
            tail={4}
            tone="dim"
            size="sm"
            href={null}
            className={s.metaHex}
          />
        )}

        {message.seq !== null && (
          <span className={s.metaLine}>
            <span className={s.metaKey}>seq</span>
            <span>{message.seq}</span>
          </span>
        )}

        {txUrl !== null && (
          <a className={s.metaTx} href={txUrl} target="_blank" rel="noreferrer noopener">
            View transaction
          </a>
        )}
      </div>
    </article>
  );
}
