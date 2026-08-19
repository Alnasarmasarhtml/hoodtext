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
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { truncateAddress } from '@/lib/format';
import { useHandle } from '@/hooks';
import type { CallPeer, CallPhase, UseVoiceCallResult } from '@/hooks/useVoiceCall';
import { Avatar } from './Avatar';
import s from './CallSurface.module.css';

/** Incoming ring: two short pulses, then a rest, looping. */
const RING_PATTERN_MS = [0, 400] as const;
/** Outgoing ringback: the long single tone a phone makes while it rings out. */
const RINGBACK_PATTERN_MS = [0] as const;

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

type ToneMode = 'off' | 'ring' | 'ringback';

/**
 * Call tones, synthesised rather than shipped as audio files.
 *
 * `ringback` is what the CALLER hears while the other phone rings: a long, low
 * double tone on a slow cycle, the sound every telephone has made for a
 * century. `ring` is the brighter, faster pattern the CALLEE hears.
 *
 * WebAudio will not make noise until the page has had a user gesture. The
 * caller always has one (they pressed Call), so ringback is reliable. An
 * incoming call has no gesture by definition, so the first ever inbound ring on
 * a fresh tab may be silent; the flashing title and the notification are the
 * alert that always works.
 */
function useCallTone(mode: ToneMode): void {
  const ctxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    if (mode === 'off') return;
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const ringback = mode === 'ringback';
    const pattern = ringback ? RINGBACK_PATTERN_MS : RING_PATTERN_MS;
    // Ringback: 425 Hz, the European tone. Ring: brighter so it cuts through.
    const frequency = ringback ? 425 : 620;
    const duration = ringback ? 1.0 : 0.3;
    const cycleMs = ringback ? 3_000 : 2_400;

    const pulse = (): void => {
      let ctx = ctxRef.current;
      if (ctx === null) {
        try {
          ctx = new AudioContext();
          ctxRef.current = ctx;
        } catch {
          return;
        }
      }
      const audio = ctx;
      if (audio.state === 'suspended') {
        void audio.resume().catch(() => undefined);
      }
      for (const at of pattern) {
        timers.push(
          setTimeout(() => {
            if (cancelled) return;
            const osc = audio.createOscillator();
            const gain = audio.createGain();
            osc.frequency.value = frequency;
            osc.type = 'sine';
            const now = audio.currentTime;
            gain.gain.setValueAtTime(0.0001, now);
            gain.gain.exponentialRampToValueAtTime(ringback ? 0.05 : 0.08, now + 0.03);
            gain.gain.setValueAtTime(ringback ? 0.05 : 0.08, now + duration - 0.06);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
            osc.connect(gain).connect(audio.destination);
            osc.start(now);
            osc.stop(now + duration + 0.02);
          }, at),
        );
      }
    };

    pulse();
    const loop = setInterval(pulse, cycleMs);
    return () => {
      cancelled = true;
      clearInterval(loop);
      for (const timer of timers) clearTimeout(timer);
    };
  }, [mode]);

  // Release the audio device when no call is up.
  useEffect(() => {
    return () => {
      const ctx = ctxRef.current;
      ctxRef.current = null;
      if (ctx !== null) void ctx.close().catch(() => undefined);
    };
  }, []);
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
  const tone: ToneMode = incoming
    ? 'ring'
    : call.phase === 'dialing' || call.phase === 'ringing-out'
      ? 'ringback'
      : 'off';

  useCallTone(tone);
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
            <button type="button" className={s.answer} onClick={() => void call.accept()}>
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
