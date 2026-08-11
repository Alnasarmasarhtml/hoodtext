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

import { useToast } from '@/components/ui';
import {
  MAX_ATTACHMENT_BYTES,
  parseMediaPayload,
  previewEnvelope,
  type ChatMessage,
  type SendStage,
  type UseSendMessageResult,
} from '@/hooks';
import { cx } from '@/lib/cx';
import { formatBytes } from '@/lib/format';
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
        <button
          type="button"
          className={s.attach}
          onClick={onPickFile}
          disabled={disabled || send.isSending}
          aria-label="Attach an image (encrypted, 4 MB max)"
          title="Attach an image. Encrypted under its own key, 4 MB max"
        >
          <svg className={s.attachGlyph} viewBox="0 0 20 20" aria-hidden="true">
            <path d="M13.5 6.5 7 13a2.5 2.5 0 0 0 3.5 3.5l6.5-6.5a4.5 4.5 0 0 0-6.4-6.3L4 10.4" />
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
          placeholder={disabled ? 'Sending is paused' : 'Message'}
        />

        <button
          type="submit"
          className={s.sendKey}
          disabled={!canSend}
          aria-label={send.isSending ? STAGE_LABEL[send.stage] : 'Send'}
          title={send.isSending ? STAGE_LABEL[send.stage] : 'Send · Enter'}
        >
          {send.isSending ? (
            <svg className={s.sendGlyph} viewBox="0 0 16 16" aria-hidden="true">
              <circle className={s.spinner} cx="8" cy="8" r="5.5" />
            </svg>
          ) : (
            <svg className={s.sendGlyph} viewBox="0 0 16 16" aria-hidden="true">
              <path d="M1 8 15 1.5 12 14.5 8.2 10.4 13 4 6.4 8.6z" />
            </svg>
          )}
        </button>
      </div>

      {/* What used to live here: a stage chip, four padding-bucket pips and a
          "pad 256 B · body 41 B" readout. The tick on the message reports the
          stage now, and nobody composing a sentence needs to watch it being
          padded. The delivery path survives because it is a choice with a real
          consequence — free and relayed, or your own wallet and gas. */}
      <div className={s.meter}>
        <button
          type="button"
          className={cx(s.pathToggle, selfPost && s.pathToggleSelf)}
          onClick={toggleSelfPost}
          aria-pressed={selfPost}
          title={
            selfPost
              ? 'Self-post: your wallet anchors each message (gas only). Click for the free relay path.'
              : 'Relay path: the relay anchors for you. Free, no wallet popup. Click to self-post instead.'
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
