'use client';

/**
 * The room roster (SPEC §4.4).
 *
 * The chain holds only a Merkle commitment of this list — the roster itself
 * is device-local knowledge, which the panel says out loud. Adding a member
 * wraps the CURRENT epoch key to their registered X25519 key and delivers it
 * inside a stealth 1:1 drop; nothing on chain moves. Removing one mints a
 * fresh key, bumps the epoch via `rotateEpoch`, and re-wraps to everyone
 * left — the removed member keeps history and loses the future.
 */

import {
  useCallback,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from 'react';
import type { Address } from 'viem';
import { useConfig } from 'wagmi';

import { Button, Field } from '@/components/ui';
import {
  resolveRecipient,
  useDemoActive,
  useHandle,
  usePerkTier,
  useRoomRoster,
  type RoomChainState,
  type RoomRecord,
} from '@/hooks';
import { cx } from '@/lib/cx';
import { formatCount, truncateAddress } from '@/lib/format';
import { useAppSession } from './session';
import { PerkChip } from './PerkChip';
import s from './RoomMembers.module.css';

interface MemberRowProps {
  readonly address: Address;
  readonly isSelf: boolean;
  readonly isAdmin: boolean;
  readonly canKick: boolean;
  readonly kicking: boolean;
  readonly onKick: (address: Address) => void;
}

function MemberRow({
  address,
  isSelf,
  isAdmin,
  canKick,
  kicking,
  onKick,
}: MemberRowProps): ReactNode {
  const handle = useHandle(address);
  const tier = usePerkTier(address);

  return (
    <li className={s.member}>
      <span className={s.memberMark} aria-hidden="true" />
      <span className={s.memberName} title={address}>
        {handle === null ? truncateAddress(address) : `@${handle}`}
      </span>
      <PerkChip tier={tier} />
      {isSelf && <span className={s.memberTag}>you</span>}
      {isAdmin && <span className={s.memberTag}>admin</span>}
      {canKick && (
        <button
          type="button"
          className={s.kick}
          onClick={() => onKick(address)}
          disabled={kicking}
        >
          {kicking ? 'Rotating…' : 'Remove'}
        </button>
      )}
    </li>
  );
}

export interface RoomMembersProps {
  readonly room: RoomRecord;
  readonly chain: RoomChainState;
  readonly className?: string;
}

export function RoomMembers({ room, chain, className }: RoomMembersProps): ReactNode {
  const session = useAppSession();
  const config = useConfig();
  const roster = useRoomRoster({
    owner: session.address,
    keys: session.keys,
    room,
    chainEpoch: chain.epoch,
  });

  const demo = useDemoActive();
  const [input, setInput] = useState('');
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [demoNote, setDemoNote] = useState<string | null>(null);

  const isAdmin =
    session.address !== null &&
    chain.admin !== null &&
    chain.admin.toLowerCase() === session.address.toLowerCase();

  const onInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>): void => {
      setInput(event.target.value);
      setResolveError(null);
      setDemoNote(null);
      if (roster.phase === 'error' || roster.phase === 'done') roster.reset();
    },
    [roster],
  );

  const onAdd = useCallback(
    (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      const raw = input.trim();
      if (raw === '' || roster.isBusy) return;
      setResolveError(null);

      if (demo) {
        /* Simulated: adding wraps + delivers the room key in the live app. */
        setDemoNote(
          'Simulated. In the live app this wraps the room key to their registered key and delivers it inside an encrypted drop.',
        );
        return;
      }

      void (async (): Promise<void> => {
        const resolved = await resolveRecipient(config, raw);
        if (!resolved.ok) {
          setResolveError(resolved.failure.message);
          return;
        }
        const ok = await roster.addMember(resolved.recipient.address);
        if (ok) setInput('');
      })();
    },
    [config, demo, input, roster],
  );

  const onKick = useCallback(
    (address: Address): void => {
      if (demo) {
        /* Simulated: removal rotates the epoch on chain in the live app. */
        setDemoNote(
          'Simulated. In the live app removing a member mints a fresh key and rotates the epoch on chain.',
        );
        return;
      }
      void roster.removeMember(address);
    },
    [demo, roster],
  );

  const error = resolveError ?? roster.error;

  return (
    <section className={cx(s.panel, className)} aria-label="Room members">
      <header className={s.head}>
        <span className={s.headLabel}>Members</span>
        <span className={s.headCount}>{formatCount(room.members.length)}</span>
        <span className={s.headNote}>
          known to this device: the chain holds only a commitment
        </span>
      </header>

      <ul className={s.list}>
        {room.members.map((member) => {
          const isSelf =
            session.address !== null &&
            member.toLowerCase() === session.address.toLowerCase();
          const memberIsAdmin =
            chain.admin !== null && member.toLowerCase() === chain.admin.toLowerCase();
          return (
            <MemberRow
              key={member.toLowerCase()}
              address={member}
              isSelf={isSelf}
              isAdmin={memberIsAdmin}
              canKick={isAdmin && !isSelf}
              kicking={roster.phase === 'removing'}
              onKick={onKick}
            />
          );
        })}
      </ul>

      {isAdmin ? (
        <form className={s.adder} onSubmit={onAdd} noValidate>
          <Field
            label="Add a member"
            labelHint="wraps + delivers the room key"
            mono
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            placeholder="@handle or 0x…"
            value={input}
            onChange={onInputChange}
            disabled={roster.isBusy}
            hint="They receive the current epoch key inside an encrypted 1:1 drop. No transaction."
            className={s.adderField}
          />
          <Button
            type="submit"
            variant="primary"
            size="sm"
            loading={roster.phase === 'adding'}
            loadingLabel="Delivering key"
            disabled={input.trim() === '' || roster.isBusy}
          >
            Add member
          </Button>
        </form>
      ) : (
        <p className={s.note}>
          Only the admin
          {chain.admin === null ? '' : ` (${truncateAddress(chain.admin)})`} can add or remove
          members. Anyone may pay the rent.
        </p>
      )}

      <div className={s.facts}>
        <span className={s.fact}>
          <span className={s.factKey}>epoch</span>
          <span className={s.factValue}>{formatCount(chain.epoch)}</span>
        </span>
        <span className={s.fact}>
          <span className={s.factKey}>held keys up to</span>
          <span className={s.factValue}>{formatCount(room.epoch)}</span>
        </span>
        {chain.epoch > room.epoch && (
          <span className={s.factWarn}>
            a newer key exists: messages after the rotation stay sealed until the admin&apos;s
            key drop arrives
          </span>
        )}
      </div>

      {demoNote !== null && (
        <p className={s.simNote} role="note">
          <span className={s.simMark} aria-hidden="true" />
          <span className={s.simText}>{demoNote}</span>
          <button type="button" className={s.errorAction} onClick={() => setDemoNote(null)}>
            Dismiss
          </button>
        </p>
      )}

      {error !== null && (
        <p className={s.error} role="alert">
          <span className={s.errorMark} aria-hidden="true" />
          <span className={s.errorText}>{error}</span>
          <button type="button" className={s.errorAction} onClick={roster.reset}>
            Dismiss
          </button>
        </p>
      )}
    </section>
  );
}
