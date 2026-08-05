'use client';

/**
 * The composer (SPEC §7.3).
 *
 * The default path is gasless: `seal()` → `POST /v1/blob` → `signDrop()` →
 * `POST /v1/send` → queued → anchored when the WS stream delivers the drop.
 * No transaction, no gas, no wallet popup per message. The self-post toggle
 * switches to `Anchors.post` from the user's own wallet — the honest fallback
 * when the relay is down, and never payable either way.
 *
 * The bucket ladder under the field is the honest version of a character
 * counter: padding rounds every message up to one of four fixed sizes, so what
 * an observer learns is which of four classes it fell into — nothing finer.
 */

import { BUCKETS } from '@telehood/crypto';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { Hex } from 'viem';

import { Button, useToast } from '@/components/ui';
import {
  MAX_ATTACHMENT_BYTES,
  parseMediaPayload,
  previewEnvelope,
  type ChatMessage,
  type SendStage,
  type UseSendMessageResult,
} from '@/hooks';
import { cx } from '@/lib/cx';
import { formatBytes, formatCount } from '@/lib/format';
import { useSendPrefs } from '@/lib/ui-store';
import s from './Composer.module.css';

const STAGE_LABEL: Readonly<Record<SendStage, string>> = {
  idle: 'Ready',
  sealing: 'Sealing',
  uploading: 'Uploading blob',
  relaying: 'Handing to relay',
  signing: 'Awaiting wallet',
  queued: 'Queued · relay',
  pending: 'Anchoring',
  anchored: 'Anchored',
  failed: 'Failed',
};

const MAX_TEXTAREA_PX = 208;

export interface ComposerProps {
  readonly convoId: Hex;
  readonly send: UseSendMessageResult;
  /** Who the message goes to, for the field's accessible name. */
  readonly peerLabel: string;
  /** The message being replied to, or `null`. */
  readonly replyTo?: ChatMessage | null;
  /** Clears the reply context. */
  readonly onCancelReply?: () => void;
  /** Disables the control without hiding it. Pair with a visible explanation. */
  readonly disabled?: boolean;
  readonly className?: string;
}

function replyPreview(message: ChatMessage): string {
  if (message.kind === 'media') {
    const payload = parseMediaPayload(message.body);
    return payload === null || payload.name === '' ? 'Attachment' : payload.name;
  }
  const single = message.body.replace(/\s+/g, ' ').trim();
  return single.length > 90 ? `${single.slice(0, 89)}…` : single;
}

export function Composer({
  convoId,
  send,
  peerLabel,
  replyTo = null,
  onCancelReply,
  disabled = false,
  className,
}: ComposerProps): ReactNode {
  const toast = useToast();
  const [body, setBody] = useState('');
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const selfPost = useSendPrefs((state) => state.selfPost);
  const toggleSelfPost = useSendPrefs((state) => state.toggleSelfPost);
  const setSelfPost = useSendPrefs((state) => state.setSelfPost);

  const preview = useMemo(() => previewEnvelope(body), [body]);
  const trimmed = body.trim();
  const canSend = !disabled && !send.isSending && trimmed !== '' && !preview.overflow;

  /* Grow with the content, then scroll — never a field that pushes the thread
     off screen. */
  useEffect(() => {
    const area = areaRef.current;
    if (area === null) return;
    area.style.height = 'auto';
    area.style.height = `${String(Math.min(area.scrollHeight, MAX_TEXTAREA_PX))}px`;
  }, [body]);

  const submit = useCallback((): void => {
    if (!canSend) return;
    const outgoing = trimmed;
    const re = replyTo?.blobRef ?? undefined;
    void (async (): Promise<void> => {
      const ok = await send.send(re === undefined ? { convoId, body: outgoing } : { convoId, body: outgoing, re });
      if (!ok) return;
      setBody('');
      onCancelReply?.();
      toast.push(
        selfPost
          ? {
              kind: 'success',
              title: 'Anchored',
              body: 'The ciphertext is stored and the drop is in the on-chain log.',
            }
          : {
              kind: 'success',
              title: 'Queued',
              body: 'The relay accepted the drop. It flips to anchored the moment the anchor lands.',
            },
      );
    })();
  }, [canSend, convoId, onCancelReply, replyTo, selfPost, send, toast, trimmed]);

  const onSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      submit();
    },
    [submit],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): void => {
      if (event.key !== 'Enter' || event.shiftKey || event.altKey) return;
      event.preventDefault();
      submit();
    },
    [submit],
  );

  const onChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>): void => {
      setBody(event.target.value);
      if (send.stage === 'failed' || send.stage === 'anchored' || send.stage === 'queued') {
        send.reset();
      }
    },
    [send],
  );

  const onPickFile = useCallback((): void => {
    fileRef.current?.click();
  }, []);

  const onFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>): void => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (file === undefined || disabled || send.isSending) return;

      if (file.size > MAX_ATTACHMENT_BYTES) {
        toast.push({
          kind: 'error',
          title: 'Too large',
          body: `Attachments are capped at ${formatBytes(MAX_ATTACHMENT_BYTES)}. That file is ${formatBytes(file.size)}.`,
        });
        return;
      }

      const re = replyTo?.blobRef ?? undefined;
      void (async (): Promise<void> => {
        const buffer = await file.arrayBuffer();
        const ok = await send.sendMedia({
          convoId,
          data: new Uint8Array(buffer),
          mime: file.type === '' ? 'application/octet-stream' : file.type,
          name: file.name,
          ...(re === undefined ? {} : { re }),
        });
        if (!ok) return;
        onCancelReply?.();
        toast.push({
          kind: 'success',
          title: selfPost ? 'Anchored' : 'Queued',
          body: 'The file was encrypted under its own key; the relay holds only ciphertext.',
        });
      })();
    },
    [convoId, disabled, onCancelReply, replyTo, selfPost, send, toast],
  );

  const stageTone =
    send.stage === 'failed'
      ? s.stageFailed
      : send.stage === 'anchored'
        ? s.stageAnchored
        : send.stage === 'queued'
          ? s.stageQueued
          : send.isSending
            ? s.stageWorking
            : undefined;

  return (
    <form className={cx(s.composer, disabled && s.disabled, className)} onSubmit={onSubmit}>
      {replyTo !== null && (
        <div className={s.replyStrip} role="note">
          <span className={s.replyRule} aria-hidden="true" />
          <span className={s.replyKey}>Replying to</span>
          <span className={s.replyText}>{replyPreview(replyTo)}</span>
          {onCancelReply !== undefined && (
            <button
              type="button"
              className={s.replyCancel}
              onClick={onCancelReply}
              aria-label="Cancel reply"
            >
              Cancel
            </button>
          )}
        </div>
      )}

      <div className={s.fieldRow}>
        <span className={s.gutter} aria-hidden="true" />

        <textarea
          ref={areaRef}
          className={s.area}
          value={body}
          onChange={onChange}
          onKeyDown={onKeyDown}
          disabled={disabled || send.isSending}
          rows={1}
          spellCheck
          aria-label={`Message ${peerLabel}`}
          placeholder={
            disabled ? 'Sending is paused' : 'Write a message · Enter sends, Shift+Enter breaks'
          }
        />

        <div className={s.send}>
          <button
            type="button"
            className={s.attach}
            onClick={onPickFile}
            disabled={disabled || send.isSending}
            aria-label="Attach an image (encrypted, 4 MB max)"
            title="Attach an image — encrypted under its own key, 4 MB max"
          >
            <svg className={s.attachGlyph} viewBox="0 0 12 12" aria-hidden="true">
              <path d="M2.5 6.5 6 3a2.1 2.1 0 0 1 3 3L5.5 9.5a1.4 1.4 0 0 1-2-2L7 4" />
            </svg>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className={s.fileInput}
            onChange={onFileChange}
            tabIndex={-1}
            aria-hidden="true"
          />
          <Button
            type="submit"
            variant="primary"
            size="md"
            loading={send.isSending}
            loadingLabel={STAGE_LABEL[send.stage]}
            disabled={!canSend}
          >
            Send
          </Button>
        </div>
      </div>

      <div className={s.meter}>
        <span className={cx(s.stage, stageTone)}>
          <span className={s.stageDot} aria-hidden="true" />
          {STAGE_LABEL[send.stage]}
        </span>

        <span className={s.buckets} aria-hidden="true">
          {BUCKETS.map((bucket) => (
            <span
              key={bucket}
              className={cx(
                s.bucket,
                preview.bucket !== null && bucket <= preview.bucket && s.bucketFilled,
                preview.bucket === bucket && s.bucketHead,
              )}
            />
          ))}
        </span>

        <span className={s.readout}>
          <span className={s.readoutKey}>pad</span>
          <span className={s.readoutValue}>
            {preview.bucket === null ? 'over' : formatBytes(preview.bucket)}
          </span>
          <span className={s.readoutSep} aria-hidden="true">
            ·
          </span>
          <span className={s.readoutKey}>body</span>
          <span className={s.readoutValue}>{formatCount(preview.bytes)} B</span>
        </span>

        <button
          type="button"
          className={cx(s.pathToggle, selfPost && s.pathToggleSelf)}
          onClick={toggleSelfPost}
          aria-pressed={selfPost}
          title={
            selfPost
              ? 'Self-post: your wallet anchors each message (gas only). Click for the free relay path.'
              : 'Relay path: the relay anchors for you — free, no wallet popup. Click to self-post instead.'
          }
        >
          <span className={s.pathDot} aria-hidden="true" />
          {selfPost ? 'self-post · wallet + gas' : 'via relay · free'}
        </button>
      </div>

      {preview.overflow && (
        <p className={s.warn} role="alert">
          That is larger than the biggest padded envelope (16 KB). Shorten it or split it in two —
          nothing has been sent.
        </p>
      )}

      {send.error !== null && (
        <p className={s.error} role="alert">
          <span className={s.errorMark} aria-hidden="true" />
          <span className={s.errorText}>{send.error}</span>
          {send.canFallbackToWallet && !selfPost && (
            <button
              type="button"
              className={s.errorAction}
              onClick={() => {
                setSelfPost(true);
                send.reset();
              }}
            >
              Switch to self-post
            </button>
          )}
          <button type="button" className={s.errorAction} onClick={send.reset}>
            Dismiss
          </button>
        </p>
      )}
    </form>
  );
}
