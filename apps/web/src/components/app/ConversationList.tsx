'use client';

/**
 * The conversation rail (SPEC §7.3) — DMs and rooms in one ledger.
 *
 * Strictly single-column and immune to long hex: every address and every
 * conversation id is truncated deterministically before it is rendered, and
 * every cell is `min-width: 0`, so nothing here can widen the rail (SPEC §7.5).
 *
 * A DM is a purely local threading key — `convoIdFor(myPub, peerPub)` — never
 * a chain value; opening one is a free `KeyRegistry` read. A room's id IS its
 * on-chain group id, and its rent state is read live so the dot beside the
 * name tells the truth.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  useCallback,
  useMemo,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from 'react';
import type { Hex } from 'viem';
import { useReadContracts } from 'wagmi';

import { Button, Field } from '@/components/ui';
import {
  parseMediaPayload,
  useConversations,
  useHandle,
  useStartConversation,
  type ChatMessage,
  type Conversation,
} from '@/hooks';
import { groupRegistryAbi } from '@/lib/abi';
import { ACTIVE_CHAIN_ID, tryGetContracts } from '@/lib/chain';
import { cx } from '@/lib/cx';
import {
  formatClock,
  formatCount,
  formatDateTime,
  truncateAddress,
  truncateRef,
} from '@/lib/format';
import { AppNotice } from './AppNotice';
import { useAppSession } from './session';
import s from './ConversationList.module.css';

const SKELETON_ROWS = [0, 1, 2, 3];

function previewOf(message: ChatMessage | null): string {
  if (message === null) return 'No messages yet';
  if (message.kind === 'media') {
    const payload = parseMediaPayload(message.body);
    const name = payload === null || payload.name === '' ? 'attachment' : payload.name;
    return message.direction === 'out' ? `You: ${name}` : name;
  }
  const single = message.body.replace(/\s+/g, ' ').trim();
  if (single === '') return 'Empty message';
  return message.direction === 'out' ? `You: ${single}` : single;
}

/* ═══════════════════════════════════════════════════════════════ rows ═══ */

interface RowProps {
  readonly conversation: Conversation;
  readonly active: boolean;
  /** `null` = unknown (still reading), otherwise the live rent state. */
  readonly roomActive: boolean | null;
}

function RowTitle({ conversation }: { readonly conversation: Conversation }): ReactNode {
  const handle = useHandle(conversation.room === null ? conversation.peerAddress : null);

  if (conversation.room !== null) {
    return <span className={s.name}>{conversation.room.name}</span>;
  }
  if (conversation.unattributed) {
    return <span className={cx(s.name, s.nameQuiet)}>Unattributed drops</span>;
  }
  if (conversation.peerAddress !== null) {
    return (
      <span className={s.name} title={conversation.peerAddress}>
        {handle === null ? truncateAddress(conversation.peerAddress) : `@${handle}`}
      </span>
    );
  }
  return <span className={s.name}>{truncateRef(conversation.convoId)}</span>;
}

function ConversationRow({ conversation, active, roomActive }: RowProps): ReactNode {
  const last = conversation.lastMessage;
  const room = conversation.room;

  return (
    <li className={s.item}>
      <Link
        href={`/app/thread?c=${conversation.convoId}`}
        className={cx(s.row, active && s.rowActive)}
        aria-current={active ? 'page' : undefined}
      >
        <span className={s.rowHead}>
          {room !== null && (
            <span
              className={cx(
                s.roomDot,
                roomActive === true && s.roomDotLive,
                roomActive === false && s.roomDotLapsed,
              )}
              title={
                roomActive === null
                  ? 'Room — reading rent state'
                  : roomActive
                    ? 'Room — rent current'
                    : 'Room — rent lapsed; new messages blocked until anyone pays'
              }
              aria-hidden="true"
            />
          )}
          <RowTitle conversation={conversation} />
          <time
            className={s.time}
            dateTime={new Date(conversation.lastActivity * 1000).toISOString()}
            title={
              conversation.lastActivity > 0 ? formatDateTime(conversation.lastActivity) : undefined
            }
          >
            {conversation.lastActivity > 0 ? formatClock(conversation.lastActivity) : '--:--:--'}
          </time>
        </span>

        <span className={s.preview}>{previewOf(last)}</span>

        <span className={s.tags}>
          {room !== null && (
            <span className={s.tag}>
              <span className={s.tagKey}>members</span>
              {formatCount(room.members.length)}
            </span>
          )}
          {room !== null && roomActive === false && (
            <span className={cx(s.tag, s.tagFailed)}>
              <span className={s.tagDot} aria-hidden="true" />
              rent lapsed
            </span>
          )}
          <span className={s.tag}>
            <span className={s.tagKey}>msg</span>
            {formatCount(conversation.messageCount)}
          </span>
          {conversation.anchoredCount > 0 && (
            <span className={cx(s.tag, s.tagAnchored)}>
              <span className={s.tagDot} aria-hidden="true" />
              {formatCount(conversation.anchoredCount)} on chain
            </span>
          )}
          {conversation.pendingCount > 0 && (
            <span className={cx(s.tag, s.tagPending)}>
              <span className={s.tagDot} aria-hidden="true" />
              {formatCount(conversation.pendingCount)} in flight
            </span>
          )}
          {conversation.failedCount > 0 && (
            <span className={cx(s.tag, s.tagFailed)}>
              <span className={s.tagDot} aria-hidden="true" />
              {formatCount(conversation.failedCount)} failed
            </span>
          )}
          {!conversation.canReply && !conversation.unattributed && room === null && (
            <span className={cx(s.tag, s.tagQuiet)}>read only</span>
          )}
        </span>
      </Link>
    </li>
  );
}

/* ═══════════════════════════════════════════════════════════════ rail ═══ */

export interface ConversationListProps {
  /** Lower-cased id of the thread currently open, if any. */
  readonly activeConvoId: string | null;
  readonly className?: string;
}

export function ConversationList({
  activeConvoId,
  className,
}: ConversationListProps): ReactNode {
  const router = useRouter();
  const session = useAppSession();
  const { conversations, isHydrated, totalMessages } = useConversations();
  const start = useStartConversation({
    owner: session.address,
    myX25519Pub: session.x25519Pub,
  });

  const [peer, setPeer] = useState('');

  /* One batched rent read for every room in the rail, refreshed slowly. */
  const contracts = tryGetContracts(ACTIVE_CHAIN_ID);
  const roomIds = useMemo<readonly Hex[]>(
    () =>
      conversations
        .filter((conversation) => conversation.room !== null)
        .map((conversation) => conversation.convoId),
    [conversations],
  );
  const rentReads = useReadContracts({
    contracts: roomIds.map((groupId) => ({
      chainId: ACTIVE_CHAIN_ID,
      abi: groupRegistryAbi,
      address: contracts?.groupRegistry ?? (`0x${'00'.repeat(20)}` as const),
      functionName: 'isActive' as const,
      args: [groupId] as const,
    })),
    query: { enabled: contracts !== null && roomIds.length > 0, refetchInterval: 60_000 },
  });
  const rentByRoom = useMemo(() => {
    const out = new Map<string, boolean>();
    const rows = rentReads.data;
    if (rows === undefined) return out;
    for (let i = 0; i < roomIds.length; i += 1) {
      const id = roomIds[i];
      const row = rows[i];
      if (id === undefined || row === undefined || row.status !== 'success') continue;
      out.set(id.toLowerCase(), row.result);
    }
    return out;
  }, [rentReads.data, roomIds]);

  const onSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      void (async (): Promise<void> => {
        const convoId = await start.start(peer);
        if (convoId === null) return;
        setPeer('');
        start.reset();
        router.push(`/app/thread?c=${convoId}`);
      })();
    },
    [peer, router, start],
  );

  const onChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>): void => {
      setPeer(event.target.value);
      if (start.status === 'error') start.reset();
    },
    [start],
  );

  const drops = session.drops;

  return (
    <div className={cx(s.rail, className)}>
      <div className={s.head}>
        <span className={s.headLabel}>Conversations</span>
        <span className={s.headCount}>{formatCount(conversations.length)}</span>
      </div>

      <form className={s.opener} onSubmit={onSubmit} noValidate>
        <Field
          label="Open a conversation"
          labelHint="free read"
          mono
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          inputMode="text"
          placeholder="@handle or 0x…"
          value={peer}
          onChange={onChange}
          error={start.error ?? undefined}
          hint="A handle or wallet address. They must have registered keys — that is free and takes one visit."
          disabled={start.isBusy}
          className={s.openerField}
        />
        <div className={s.openerActions}>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            loading={start.isBusy}
            loadingLabel="Resolving"
            disabled={peer.trim() === ''}
            className={s.openerSubmit}
          >
            Look up key
          </Button>
          <Link href="/app/rooms/new" className={s.newRoom}>
            New room
          </Link>
        </div>
      </form>

      <nav className={s.list} aria-label="Conversations">
        {!isHydrated ? (
          <ul className={s.skeleton} aria-hidden="true">
            {SKELETON_ROWS.map((index) => (
              <li key={index} className={s.skeletonRow}>
                <span className={s.skeletonName} />
                <span className={s.skeletonLine} />
              </li>
            ))}
          </ul>
        ) : conversations.length === 0 ? (
          <div className={s.empty}>
            <svg className={s.emptyMark} viewBox="0 0 44 24" aria-hidden="true">
              <path d="M.5 17.5h10l3.5-11 4.5 17 4-13 3 7h18" />
            </svg>
            <span className={s.emptyTitle}>No conversations on this device</span>
            <p className={s.emptyText}>
              Paste a handle or address above, or open a room. Anything sent to you arrives here
              on its own — the scanner is already running.
            </p>
          </div>
        ) : (
          <ul className={s.items}>
            {conversations.map((conversation) => (
              <ConversationRow
                key={conversation.convoId}
                conversation={conversation}
                active={
                  activeConvoId !== null &&
                  conversation.convoId.toLowerCase() === activeConvoId.toLowerCase()
                }
                roomActive={
                  conversation.room === null
                    ? null
                    : rentByRoom.get(conversation.convoId.toLowerCase()) ?? null
                }
              />
            ))}
          </ul>
        )}
      </nav>

      {drops.error !== null && (
        <AppNotice
          className={s.railNotice}
          tone="warn"
          title="Relay sweep interrupted"
          body={drops.error}
          action={
            <Button size="sm" onClick={drops.resync}>
              Retry
            </Button>
          }
        />
      )}

      <footer className={s.foot}>
        <div className={s.counters}>
          <span className={s.counter}>
            <span className={s.counterKey}>scanned</span>
            {formatCount(drops.scanned)}
          </span>
          <span className={s.counter}>
            <span className={s.counterKey}>matched</span>
            {formatCount(drops.matched)}
          </span>
          <span className={cx(s.counter, s.counterOptional)}>
            <span className={s.counterKey}>msgs</span>
            {formatCount(totalMessages)}
          </span>
        </div>
        <button
          type="button"
          className={s.rescan}
          onClick={drops.rescan}
          disabled={drops.isBackfilling}
          title="Re-scan every anchor from the start of the log. Use this after clearing site data."
        >
          {drops.isBackfilling ? 'Scanning…' : 'Rescan log'}
        </button>
      </footer>
    </div>
  );
}
