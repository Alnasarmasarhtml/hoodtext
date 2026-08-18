'use client';

/**
 * `/app/rooms/new` — the create-room pane.
 *
 * A room is $10/month in $GRAM, paid by whoever runs it; members are free.
 * Creation is two wallet steps at most — approve (skipped when the allowance
 * already covers the rent) and `createGroup` — then this device mints the
 * epoch-0 group key, stores it, and the room opens. Members are added
 * afterwards from the room header; each addition delivers the key inside an
 * encrypted 1:1 drop, no transaction.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  useCallback,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from 'react';

import { Button, Eyebrow, Field, MonthStepper, useToast } from '@/components/ui';
import { useCreateRoom, useRentQuote } from '@/hooks';
import { PRICES } from '@/lib/abi';
import { cx } from '@/lib/cx';
import { formatDate, formatToken, formatUsd } from '@/lib/format';
import { useAppSession } from './session';
import { LockedNotice } from './LockedNotice';
import s from './RoomCreate.module.css';

export function RoomCreate(): ReactNode {
  const session = useAppSession();
  const router = useRouter();
  const create = useCreateRoom(session.address);
  const toast = useToast();

  const [name, setName] = useState('');
  const [months, setMonths] = useState(1);
  const quote = useRentQuote(months);

  const onNameChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>): void => {
      setName(event.target.value);
      if (create.phase === 'error') create.reset();
    },
    [create],
  );

  const onSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      if (create.isBusy) return;
      void (async (): Promise<void> => {
        const created = await create.create(name, months);
        if (created === null) return;
        const { groupId, paid } = created;
        toast.push({
          kind: 'success',
          title: 'Room created and paid',
          body:
            paid === null
              ? 'The room exists on chain and this month\u2019s rent is paid.'
              : `Paid ${formatToken(paid.thoodPaid, { digits: 0, symbol: 'GRAM' })} \u00b7 rent covered until ${formatDate(Number(paid.paidUntil))}.`,
        });
        router.push(`/app/thread?c=${groupId}`);
      })();
    },
    [create, months, name, router],
  );

  if (!session.activation.isActivated) {
    return (
      <div className={s.pane}>
        <LockedNotice activation={session.activation} />
        <p className={s.lockedNote}>
          Rooms need an activated account. The $5, paid in $GRAM, covers you forever, and only the room itself
          costs rent.
        </p>
      </div>
    );
  }

  const stepLabel =
    create.phase === 'approving'
      ? 'Approving $GRAM'
      : create.phase === 'creating'
        ? 'Creating on chain'
        : 'Working';

  return (
    <div className={s.pane}>
      <form className={s.panel} onSubmit={onSubmit} noValidate>
        <header className={s.head}>
          <Link href="/app" className={s.back}>
            <svg className={s.backIcon} viewBox="0 0 12 12" aria-hidden="true">
              <path d="M7.5 1.5 3 6l4.5 4.5" />
            </svg>
            <span>All</span>
          </Link>
          <Eyebrow rule>New room</Eyebrow>
          <h1 className={s.title}>Open a room.</h1>
          <p className={s.lede}>
            {formatUsd(PRICES.roomUsdPerMonth, 0)} a month, paid by you as its admin. Members
            are free. The name never touches the chain: it travels only inside encrypted key
            drops, and the chain sees a random-salted id plus a commitment to the member set.
          </p>
        </header>

        <Field
          label="Room name"
          labelHint="never on chain"
          placeholder="e.g. night desk"
          value={name}
          onChange={onNameChange}
          maxLength={40}
          disabled={create.isBusy}
          hint="1–40 characters, for members' eyes only."
          className={s.nameField}
        />

        <div className={s.monthsBlock}>
          <span className={s.monthsLabel}>Rent up front</span>
          <MonthStepper
            value={months}
            onChange={setMonths}
            min={1}
            max={24}
            disabled={create.isBusy}
            label="Months of rent"
          />
        </div>

        <dl className={s.facts}>
          <div className={s.fact}>
            <dt className={s.factKey}>Rent</dt>
            <dd className={s.factValue}>
              {formatUsd(PRICES.roomUsdPerMonth * months, 0)}
              <span className={s.factUnit}>
                {months === 1 ? 'for 1 month' : `for ${months} months`}
              </span>
            </dd>
          </div>
          <div className={s.fact}>
            <dt className={s.factKey}>In $GRAM today</dt>
            <dd className={s.factValue}>
              {quote === null ? (
                <span className={s.factPending}>Reading price source…</span>
              ) : (
                <>
                  {formatToken(quote, { digits: 2 })}
                  <span className={s.factUnit}>pulled on create</span>
                </>
              )}
            </dd>
          </div>
          <div className={s.fact}>
            <dt className={s.factKey}>Lapse policy</dt>
            <dd className={s.factValue}>
              <span className={s.factSmall}>
                blocks new messages only: history and membership survive, anyone may pay
              </span>
            </dd>
          </div>
        </dl>

        <div className={s.actions}>
          <Button
            type="submit"
            variant="primary"
            size="lg"
            loading={create.isBusy}
            loadingLabel={stepLabel}
            disabled={name.trim() === '' || create.isBusy}
          >
            {quote === null
              ? 'Approve + create'
              : `Approve + create · ${formatToken(quote, { digits: 0, compact: true })} GRAM (≈ ${formatUsd(PRICES.roomUsdPerMonth * months, 0)})`}
          </Button>
          <span className={s.actionNote}>
            Two wallet steps at most. The approval is skipped when your allowance already
            covers the rent. The group key is minted on this device afterwards; add members from
            the room header.
          </span>
        </div>

        <ol className={s.steps} aria-label="What happens">
          <li className={cx(s.step, create.phase === 'approving' && s.stepActive)}>
            <span className={s.stepIndex}>01</span>
            <span className={s.stepText}>Approve $GRAM for the rent, if needed.</span>
          </li>
          <li className={cx(s.step, create.phase === 'creating' && s.stepActive)}>
            <span className={s.stepIndex}>02</span>
            <span className={s.stepText}>
              <code className={s.code}>createGroup</code> anchors the room id, your admin seat
              and the rent.
            </span>
          </li>
          <li className={s.step}>
            <span className={s.stepIndex}>03</span>
            <span className={s.stepText}>
              This device mints the epoch-0 group key. It never leaves your devices unencrypted.
            </span>
          </li>
        </ol>

        {create.error !== null && (
          <p className={s.error} role="alert">
            <span className={s.errorMark} aria-hidden="true" />
            <span className={s.errorText}>{create.error}</span>
            <button type="button" className={s.errorAction} onClick={create.reset}>
              Dismiss
            </button>
          </p>
        )}
      </form>
    </div>
  );
}
