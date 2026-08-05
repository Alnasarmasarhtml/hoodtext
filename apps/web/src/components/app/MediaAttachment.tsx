'use client';

/**
 * One encrypted attachment, decrypted in place.
 *
 * The descriptor message carries `{ mime, name, bytes, ref, key }`; the blob
 * itself sits in the relay's store as ciphertext the relay cannot read. This
 * fetches by `ref`, opens with the descriptor key, and renders images inline
 * via a short-lived object URL — revoked on unmount, because a decrypted
 * attachment should not outlive its row. Anything that is not an image gets
 * its name, its true size and a download action.
 */

import { openMedia } from '@telehood/crypto';
import { useEffect, useState, type ReactNode } from 'react';
import { hexToBytes } from 'viem';

import { getBlob } from '@/lib/relay';
import { cx } from '@/lib/cx';
import { formatBytes } from '@/lib/format';
import type { MediaPayload } from '@/hooks';
import s from './MediaAttachment.module.css';

export interface MediaAttachmentProps {
  readonly payload: MediaPayload;
  readonly className?: string;
}

type MediaState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'error'; readonly message: string }
  | { readonly phase: 'ready'; readonly url: string; readonly isImage: boolean };

export function MediaAttachment({ payload, className }: MediaAttachmentProps): ReactNode {
  const [state, setState] = useState<MediaState>({ phase: 'loading' });

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setState({ phase: 'loading' });

    void (async (): Promise<void> => {
      try {
        const blob = await getBlob(payload.ref);
        if (cancelled) return;
        if (blob === null) {
          setState({
            phase: 'error',
            message: 'The relay no longer holds this attachment.',
          });
          return;
        }

        let key: Uint8Array;
        try {
          key = hexToBytes(payload.key);
        } catch {
          setState({ phase: 'error', message: 'The attachment key is malformed.' });
          return;
        }

        const bytes = await openMedia(blob, key);
        if (cancelled) return;
        if (bytes === null) {
          setState({
            phase: 'error',
            message: 'The attachment could not be decrypted — wrong key or tampered bytes.',
          });
          return;
        }

        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        objectUrl = URL.createObjectURL(new Blob([copy], { type: payload.mime }));
        setState({
          phase: 'ready',
          url: objectUrl,
          isImage: payload.mime.startsWith('image/'),
        });
      } catch {
        if (!cancelled) {
          setState({ phase: 'error', message: 'The attachment could not be fetched.' });
        }
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [payload.key, payload.mime, payload.ref]);

  if (state.phase === 'loading') {
    return (
      <div className={cx(s.frame, s.loading, className)} role="status">
        <span className={s.bar} aria-hidden="true" />
        <span className={s.note}>
          Decrypting {payload.name === '' ? 'attachment' : payload.name} ·{' '}
          {formatBytes(payload.bytes)}
        </span>
      </div>
    );
  }

  if (state.phase === 'error') {
    return (
      <div className={cx(s.frame, s.failed, className)} role="note">
        <span className={s.fileName}>{payload.name === '' ? 'Attachment' : payload.name}</span>
        <span className={s.errorText}>{state.message}</span>
      </div>
    );
  }

  if (state.isImage) {
    return (
      <figure className={cx(s.imageFrame, className)}>
        <img
          className={s.image}
          src={state.url}
          alt={payload.name === '' ? 'Encrypted image attachment' : payload.name}
        />
        <figcaption className={s.caption}>
          <span className={s.fileName}>{payload.name}</span>
          <span className={s.fileMeta}>{formatBytes(payload.bytes)} · decrypted locally</span>
        </figcaption>
      </figure>
    );
  }

  return (
    <div className={cx(s.frame, className)}>
      <span className={s.fileGlyph} aria-hidden="true" />
      <span className={s.fileBody}>
        <span className={s.fileName}>{payload.name === '' ? 'Attachment' : payload.name}</span>
        <span className={s.fileMeta}>
          {payload.mime} · {formatBytes(payload.bytes)}
        </span>
      </span>
      <a
        className={s.download}
        href={state.url}
        download={payload.name === '' ? 'attachment' : payload.name}
      >
        Download
      </a>
    </div>
  );
}
