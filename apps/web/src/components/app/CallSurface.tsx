'use client';

/**
 * Every call surface: the incoming sheet, the in-call bar, and the closing line.
 *
 * Mounted once at the shell so a call survives moving between threads, and so
 * an incoming call reaches the user wherever they are in the messenger.
 *
 * Green is the reserved accent and is spent here on exactly two things: the
 * Answer action and the connected state. A ringing or failing call gets no
 * green at all.
 */
import { useEffect, useState, type ReactNode } from 'react';

import { startTone, unlockCallAudio, type ToneKind } from '@/lib/call-audio';
import { truncateAddress } from '@/lib/format';
import { useHandle } from '@/hooks';
import type { CallPeer, CallPhase, UseVoiceCallResult } from '@/hooks/useVoiceCall';
import { Avatar } from './Avatar';
import s from './CallSurface.module.css';

function useDisplayName(peer: CallPeer | null): string {
  const handle = useHandle(peer?.address ?? null);
  if (peer === null) return '';
  return handle !== null ? `@${handle}` : truncateAddress(peer.address);
}

/** Elapsed call time, ticking once a second. */
function useElapsed(connectedAt: number | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (connectedAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [connectedAt]);
  if (connectedAt === null) return '0:00';
  const total = Math.max(0, Math.floor((now - connectedAt) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes)}:${String(seconds).padStart(2, '0')}`;
}

/** Flash the tab title so a backgrounded tab still shows a call is waiting. */
function useTitleAlert(active: boolean, name: string): void {
  useEffect(() => {
    if (!active) return;
    const original = document.title;
    let on = false;
    const timer = setInterval(() => {
      on = !on;
      document.title = on ? `Call from ${name}` : original;
    }, 1_000);
    return () => {
      clearInterval(timer);
      document.title = original;
    };
  }, [active, name]);
}

/** A desktop notification, when the tab is hidden and permission was granted. */
function useCallNotification(active: boolean, name: string): void {
  useEffect(() => {
    if (!active) return;
    if (typeof Notification === 'undefined') return;
    if (Notification.permission !== 'granted') return;
    if (!document.hidden) return;
    const notification = new Notification('Incoming HoodGram call', {
      body: `${name} is calling`,
      tag: 'hoodgram-call',
      requireInteraction: true,
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
    return () => notification.close();
  }, [active, name]);
}

const PHASE_LABEL: Record<CallPhase, string> = {
  idle: '',
  dialing: 'Starting',
  'ringing-out': 'Ringing',
  'ringing-in': 'Incoming call',
  connecting: 'Connecting',
  connected: 'Connected',
  ended: 'Call ended',
};

export interface CallSurfaceProps {
  readonly call: UseVoiceCallResult;
}

export function CallSurface({ call }: CallSurfaceProps): ReactNode {
  const name = useDisplayName(call.peer);
  const elapsed = useElapsed(call.connectedAt);
  const incoming = call.phase === 'ringing-in';
  // The caller hears ringback from the moment they press Call until the other
  // side picks up; the callee hears the ring while deciding.
  const tone: ToneKind | null = incoming
    ? 'ring'
    : call.phase === 'dialing' || call.phase === 'ringing-out'
      ? 'ringback'
      : null;

  useEffect(() => {
    if (tone === null) return;
    return startTone(tone);
  }, [tone]);
  useTitleAlert(incoming, name);
  useCallNotification(incoming, name);

  if (call.phase === 'idle') return null;

  /* ── incoming: the one surface that interrupts ─────────────────────────── */
  if (incoming) {
    return (
      <div className={s.scrim} role="dialog" aria-modal="true" aria-label="Incoming call">
        <div className={s.sheet}>
          <span className={s.eyebrow}>Incoming call</span>
          <div className={s.who}>
            <Avatar seed={call.peer?.address ?? ''} size="lg" />
            <span className={s.name}>{name}</span>
          </div>
          <p className={s.note}>
            Voice is encrypted between the two of you. Nobody in the middle can hear it, including
            us. The relay does learn that you two spoke.
          </p>
          <div className={s.actions}>
            <button type="button" className={s.decline} onClick={call.decline}>
              Decline
            </button>
            <button
              type="button"
              className={s.answer}
              onClick={() => {
                unlockCallAudio();
                void call.accept();
              }}
            >
              Answer
            </button>
          </div>
        </div>
      </div>
    );
  }

  /* ── everything else: a quiet bar ──────────────────────────────────────── */
  const connected = call.phase === 'connected';
  return (
    <div className={s.bar} data-phase={call.phase} role="status">
      <span className={s.barDot} data-live={connected ? 'true' : 'false'} aria-hidden="true" />
      <span className={s.barName}>{name}</span>
      <span className={s.barPhase}>
        {connected ? elapsed : PHASE_LABEL[call.phase]}
      </span>
      {call.diagnostic !== null && call.phase === 'connecting' && (
        <span className={s.barPhase}>{call.diagnostic}</span>
      )}
      {call.error !== null && <span className={s.barError}>{call.error}</span>}
      <span className={s.barSpacer} />
      {(connected || call.phase === 'connecting') && (
        <button
          type="button"
          className={s.barKey}
          onClick={call.toggleMute}
          aria-pressed={call.muted}
        >
          {call.muted ? 'Unmute' : 'Mute'}
        </button>
      )}
      {call.phase !== 'ended' && (
        <button type="button" className={s.barEnd} onClick={call.hangUp}>
          Hang up
        </button>
      )}
    </div>
  );
}
