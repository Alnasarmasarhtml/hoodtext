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

import { Button } from '@/components/ui';
import {
  demoRoomChain,
  parseMediaPayload,
  useConversations,
  useDemoActive,
  useDirectorySearch,
  useHandle,
  useStartConversation,
  type ChatMessage,
  type Conversation,
} from '@/hooks';
import { groupRegistryAbi } from '@/lib/abi';
import { ACTIVE_CHAIN_ID, tryGetContracts } from '@/lib/chain';
import { cx } from '@/lib/cx';
import {
  formatTimeShort,
  formatCount,
  formatDateTime,
  truncateAddress,
  truncateRef,
} from '@/lib/format';
import { AppNotice } from './AppNotice';
import { Avatar } from './Avatar';
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

/** What the row is called, and what its avatar is derived from. */
function useRowIdentity(conversation: Conversation): {
  readonly name: string;
  readonly seed: string;
  readonly title: string | undefined;
  readonly quiet: boolean;
} {
  const handle = useHandle(conversation.room === null ? conversation.peerAddress : null);

  if (conversation.room !== null) {
    return {
      name: conversation.room.name,
      seed: conversation.room.groupId,
      title: undefined,
      quiet: false,
    };
  }
  if (conversation.unattributed) {
    return {
      name: 'Unattributed drops',
      seed: conversation.convoId,
      title: undefined,
      quiet: true,
    };
  }
  if (conversation.peerAddress !== null) {
    return {
      name: handle === null ? truncateAddress(conversation.peerAddress) : `@${handle}`,
      seed: conversation.peerAddress,
      title: conversation.peerAddress,
      quiet: false,
    };
  }
  return {
    name: truncateRef(conversation.convoId),
    seed: conversation.convoId,
    title: undefined,
    quiet: false,
  };
}

function ConversationRow({ conversation, active, roomActive }: RowProps): ReactNode {
  const last = conversation.lastMessage;
  const room = conversation.room;
  const identity = useRowIdentity(conversation);

  /* Counts of messages, anchors and in-flight drops used to hang under every
     row. A conversation list answers four questions — who, what last, when, is
     there anything new — and nothing else earns the space. The two states that
     survive are the two that need acting on: a failed send, and a room whose
     rent has lapsed and is therefore refusing new messages. */
  const alert =
    conversation.failedCount > 0
      ? 'failed'
      : room !== null && roomActive === false
        ? 'lapsed'
        : null;

  return (
    <li className={s.item}>
      <Link
        href={`/app/thread?c=${conversation.convoId}`}
        className={cx(s.row, active && s.rowActive)}
        aria-current={active ? 'page' : undefined}
      >
        <Avatar seed={identity.seed} size="lg" square={room !== null} />

        <span className={s.rowBody}>
          <span className={s.rowTop}>
            <span
              className={cx(s.name, identity.quiet && s.nameQuiet)}
              title={identity.title}
            >
              {identity.name}
            </span>
            <time
              className={s.time}
              dateTime={new Date(conversation.lastActivity * 1000).toISOString()}
              title={
                conversation.lastActivity > 0
                  ? formatDateTime(conversation.lastActivity)
                  : undefined
              }
            >
              {conversation.lastActivity > 0 ? formatTimeShort(conversation.lastActivity) : '—'}
            </time>
          </span>

          <span className={s.rowBottom}>
            <span className={s.preview}>{previewOf(last)}</span>
            {alert === 'failed' && (
              <span className={cx(s.badge, s.badgeFailed)}>
                {formatCount(conversation.failedCount)} failed
              </span>
            )}
            {alert === 'lapsed' && (
              <span className={cx(s.badge, s.badgeFailed)}>rent lapsed</span>
            )}
          </span>
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
  const { conversations, isHydrated } = useConversations();
  const start = useStartConversation({
    owner: session.address,
    myX25519Pub: session.x25519Pub,
  });

  const [peer, setPeer] = useState('');
  const search = useDirectorySearch(peer, conversations);

  /* One batched rent read for every room in the rail, refreshed slowly.
     In demo the fixture chain map answers instead and the read never fires. */
  const demo = useDemoActive();
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
    query: {
      enabled: contracts !== null && roomIds.length > 0 && !demo,
      refetchInterval: 60_000,
    },
  });
  const rentByRoom = useMemo(() => {
    const out = new Map<string, boolean>();
    if (demo) {
      for (const id of roomIds) {
        const fixture = demoRoomChain(id);
        if (fixture !== null) out.set(id.toLowerCase(), fixture.isActive);
      }
      return out;
    }
    const rows = rentReads.data;
    if (rows === undefined) return out;
    for (let i = 0; i < roomIds.length; i += 1) {
      const id = roomIds[i];
      const row = rows[i];
      if (id === undefined || row === undefined || row.status !== 'success') continue;
      out.set(id.toLowerCase(), row.result);
    }
    return out;
  }, [demo, rentReads.data, roomIds]);

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
      {/* One line: type a handle or an address, or start a room. It used to be a
          labelled field with a hint paragraph and two buttons under it, which
          took a quarter of the rail before a single conversation was visible.
          The explanation moved into the placeholder, and the error still shows
          under the field when a lookup fails. */}
      <form className={s.opener} onSubmit={onSubmit} noValidate>
        <div className={s.openerRow}>
          <input
            type="text"
            className={s.openerInput}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            inputMode="text"
            aria-label="Search by address or handle"
            placeholder="Search by address or handle"
            value={peer}
            onChange={onChange}
            disabled={start.isBusy}
          />
        </div>
        {start.error !== null && <p className={s.openerError}>{start.error}</p>}
        <Link href="/app/rooms/new" className={s.createGroup}>
          <svg viewBox="0 0 16 16" aria-hidden="true" className={s.newRoomGlyph}>
            <path d="M8 2.6v10.8M2.6 8h10.8" />
          </svg>
          Create a group
        </Link>
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
        ) : peer.trim() !== '' ? (
          <SearchResults
            search={search}
            activeConvoId={activeConvoId}
            rentByRoom={rentByRoom}
            onPick={(convoId) => {
              setPeer('');
              start.reset();
              router.push(`/app/thread?c=${convoId}`);
            }}
            onStart={(value) => {
              void (async (): Promise<void> => {
                const convoId = await start.start(value);
                if (convoId === null) return;
                setPeer('');
                start.reset();
                router.push(`/app/thread?c=${convoId}`);
              })();
            }}
          />
        ) : conversations.length === 0 ? (
          <div className={s.empty}>
            <svg className={s.emptyMark} viewBox="0 0 44 24" aria-hidden="true">
              <path d="M.5 17.5h10l3.5-11 4.5 17 4-13 3 7h18" />
            </svg>
            <span className={s.emptyTitle}>No conversations on this device</span>
            <p className={s.emptyText}>
              Paste a handle or address above, or open a room. Anything sent to you arrives here
              on its own: the scanner is already running.
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

      {/* Scanned / matched / message counters used to sit along this edge. They
          were a live readout of the scanner, and nobody scrolling their chats
          is auditing it. Rescan stays: it is the one repair a user can perform
          themselves, and it is the answer when a thread does not come back
          after clearing site data. */}
      <footer className={s.foot}>
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


/* ═══════════════════════════════════════════════════════ live search ═══ */

interface SearchResultsProps {
  readonly search: ReturnType<typeof useDirectorySearch>;
  readonly activeConvoId: string | null;
  readonly rentByRoom: ReadonlyMap<string, boolean>;
  readonly onPick: (convoId: string) => void;
  readonly onStart: (value: string) => void;
}

/**
 * In-flow results (never a floating overlay — the rail is a single min-width:0
 * column and an absolute dropdown would clip at 390px). Local matches reuse
 * the ordinary row; the one global row states exactly what the chain said.
 */
function SearchResults({
  search,
  activeConvoId,
  rentByRoom,
  onPick,
  onStart,
}: SearchResultsProps): ReactNode {
  const { localMatches, global } = search;
  const globalAddress = global.identity?.address.toLowerCase() ?? null;
  const globalIsLocal =
    globalAddress !== null &&
    localMatches.some((entry) => entry.peerAddress?.toLowerCase() === globalAddress);

  return (
    <div className={s.searchResults}>
      {localMatches.length > 0 && (
        <ul className={s.items}>
          {localMatches.map((conversation) => (
            <li key={conversation.convoId} className={s.item}>
              <button
                type="button"
                className={cx(
                  s.row,
                  s.rowButton,
                  activeConvoId !== null &&
                    conversation.convoId.toLowerCase() === activeConvoId.toLowerCase() &&
                    s.rowActive,
                )}
                onClick={() => onPick(conversation.convoId)}
              >
                <Avatar
                  seed={conversation.peerAddress ?? conversation.convoId}
                  size="lg"
                  square={conversation.room !== null}
                />
                <span className={s.rowBody}>
                  <span className={s.rowTop}>
                    <SearchRowName conversation={conversation} />
                  </span>
                  <span className={s.rowBottom}>
                    <span className={s.preview}>
                      {conversation.room !== null
                        ? rentByRoom.get(conversation.convoId.toLowerCase()) === false
                          ? 'Room · rent lapsed'
                          : 'Room'
                        : 'Conversation on this device'}
                    </span>
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {global.phase === 'resolving' && (
        <p className={s.searchState}>LOOKING UP…</p>
      )}
      {global.phase === 'found' && global.identity !== null && !globalIsLocal && (
        <ul className={s.items}>
          <li className={s.item}>
            <button
              type="button"
              className={cx(s.row, s.rowButton)}
              onClick={() => onStart(global.identity?.address ?? '')}
            >
              <Avatar seed={global.identity.address} size="lg" />
              <span className={s.rowBody}>
                <span className={s.rowTop}>
                  <span className={s.name}>
                    {global.identity.handle !== null
                      ? `@${global.identity.handle}`
                      : truncateAddress(global.identity.address)}
                  </span>
                </span>
                <span className={s.rowBottom}>
                  <span className={s.preview}>Start new chat</span>
                </span>
              </span>
            </button>
          </li>
        </ul>
      )}
      {(global.phase === 'unclaimed' || global.phase === 'no-keys' || global.phase === 'error') &&
        global.message !== null && <p className={s.searchState}>{global.message}</p>}

      {localMatches.length === 0 && global.phase === 'idle' && (
        <p className={s.searchState}>Nothing on this device matches. A full @handle or 0x address searches the chain.</p>
      )}
    </div>
  );
}

function SearchRowName({ conversation }: { readonly conversation: Conversation }): ReactNode {
  const handle = useHandle(conversation.peerAddress);
  if (conversation.room !== null) {
    return <span className={s.name}>{conversation.room.name}</span>;
  }
  if (conversation.unattributed) {
    return <span className={cx(s.name, s.nameQuiet)}>Unattributed drops</span>;
  }
  const address = conversation.peerAddress;
  return (
    <span className={s.name} title={address ?? undefined}>
      {handle !== null ? `@${handle}` : address !== null ? truncateAddress(address) : '—'}
    </span>
  );
}
