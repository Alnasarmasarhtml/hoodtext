'use client';

/**
 * 1:1 encrypted voice calls.
 *
 * The audio never touches our relay. Two browsers negotiate a direct WebRTC
 * connection and the media flows between them, encrypted by DTLS-SRTP. All the
 * relay carries is the setup handshake, and even that is sealed: the offer, the
 * answer and every ICE candidate ride inside the same encrypted envelope a
 * message does, signed by the sender's identity key.
 *
 * That signature is the part that matters. WebRTC certificates are self-signed,
 * so DTLS alone proves nothing about WHO is on the other end. What binds the
 * media to a person is the fingerprint inside the SDP, and we only ever hand an
 * SDP to the browser after verifying it was signed by the key KeyRegistry maps
 * to that address. Nobody can sit in the middle of a call, including us.
 *
 * Two deliberate trades, both stated in the UI rather than hidden:
 *   - `iceTransportPolicy: 'relay'` forces every call through TURN, so the two
 *     people never learn each other's IP address. Cloudflare sees both instead.
 *   - The relay routes signalling by a tag derived from a public key, so it can
 *     tell WHO called WHOM and when. It cannot hear a single word.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { hexToBytes, type Address, type Hex } from 'viem';

import {
  encodePlaintextCore,
  open as openEnvelope,
  seal,
  signAuthor,
  verifyAuthor,
  type IdentityKeys,
  type Plaintext,
} from '@hoodgram/crypto';

import {
  callTagFor,
  encodeCallSignal,
  losesGlare,
  newCallId,
  parseCallSignal,
  CALL_MAX_SKEW_SECONDS,
  MAX_CANDIDATES_PER_SIGNAL,
  type CallEndReason,
  type CallSignal,
  type IceLine,
} from '@/lib/call-wire';
import { getTurnCredentials, postCallSignal, type IceServer } from '@/lib/relay';
import { subscribeToRelay } from './relay-stream';

/* ══════════════════════════════════════════════════════════ types ═══════ */

export type CallPhase =
  | 'idle'
  | 'dialing'
  | 'ringing-out'
  | 'ringing-in'
  | 'connecting'
  | 'connected'
  | 'ended';

export interface CallPeer {
  readonly address: Address;
  readonly x25519Pub: Hex;
  readonly ed25519Pub: Hex;
}

export interface CallState {
  readonly phase: CallPhase;
  readonly peer: CallPeer | null;
  /** Unix ms the call connected, for the duration timer. */
  readonly connectedAt: number | null;
  readonly muted: boolean;
  /** Why the last call ended, for the closing line in the UI. */
  readonly endReason: CallEndReason | null;
  /** Human-readable failure, when something the user must understand went wrong. */
  readonly error: string | null;
  /**
   * Live connection detail: ICE state and whether a relay path was found.
   * Shown in the bar so a failure is diagnosable instead of just "it broke".
   */
  readonly diagnostic: string | null;
}

export interface UseVoiceCallResult extends CallState {
  /** True when this build can place calls at all (a relay with TURN configured). */
  readonly canCall: boolean;
  readonly start: (peer: CallPeer) => Promise<void>;
  readonly accept: () => Promise<void>;
  readonly decline: () => void;
  readonly hangUp: () => void;
  readonly toggleMute: () => void;
}

export interface UseVoiceCallParams {
  readonly owner: Address | null;
  readonly keys: IdentityKeys | null;
}

/** How long a ringing call waits before giving up. */
const RING_TIMEOUT_MS = 45_000;
/** How long trickled candidates are coalesced before a frame is sent. */
const ICE_BATCH_MS = 50;

const INITIAL: CallState = {
  phase: 'idle',
  peer: null,
  connectedAt: null,
  muted: false,
  endReason: null,
  error: null,
  diagnostic: null,
};

/* ══════════════════════════════════════════════════════════ hook ════════ */

export function useVoiceCall({ owner, keys }: UseVoiceCallParams): UseVoiceCallResult {
  const [state, setState] = useState<CallState>(INITIAL);
  const [canCall, setCanCall] = useState(false);

  /* Everything WebRTC lives in refs: it is imperative, long-lived, and must
     survive re-renders without tearing down a live call. */
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const peerRef = useRef<CallPeer | null>(null);
  const callIdRef = useRef<string | null>(null);
  const isCallerRef = useRef(false);
  const ringTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const iceQueueRef = useRef<IceLine[]>([]);
  const iceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingOfferRef = useRef<{ sdp: string; peer: CallPeer; callId: string } | null>(null);
  /**
   * Candidates that arrived before we could apply them.
   *
   * The caller starts trickling the moment it has a local description, which is
   * BEFORE the callee has answered (and before the callee even has a peer
   * connection). Applying a candidate needs a remote description, so anything
   * early has to wait here. Dropping them is fatal rather than degrading: with
   * `iceTransportPolicy: 'relay'` a peer gathers only a handful of candidates
   * and never re-sends them, so a lost one is a call that can never connect.
   */
  const pendingIceRef = useRef<IceLine[]>([]);
  const seenCallsRef = useRef<Set<string>>(new Set());

  /* ── sending ─────────────────────────────────────────────────────────── */

  const sendSignal = useCallback(
    async (peer: CallPeer, signal: CallSignal): Promise<void> => {
      if (owner === null || keys === null) return;
      let recipient: Uint8Array;
      try {
        recipient = hexToBytes(peer.x25519Pub);
      } catch {
        return;
      }
      const ptCore: Plaintext = {
        v: 1,
        t: Math.floor(Date.now() / 1000),
        kind: 'system',
        body: encodeCallSignal(signal),
        from: owner.toLowerCase() as Hex,
      };
      const sig = await signAuthor(
        encodePlaintextCore(ptCore),
        recipient,
        keys.ed25519.privateKey,
      );
      const sealed = await seal({ ...ptCore, sig }, recipient);
      await postCallSignal(callTagFor(peer.x25519Pub), sealed.blob);
    },
    [keys, owner],
  );

  /* ── teardown ────────────────────────────────────────────────────────── */

  const releaseMedia = useCallback((): void => {
    // Stopping every track is what turns the microphone light off. A leaked mic
    // would be unforgivable in this product, so it happens on every exit path.
    const stream = localStreamRef.current;
    if (stream !== null) {
      for (const track of stream.getTracks()) track.stop();
      localStreamRef.current = null;
    }
    const pc = pcRef.current;
    if (pc !== null) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      try {
        pc.close();
      } catch {
        /* already closed */
      }
      pcRef.current = null;
    }
    const audio = audioRef.current;
    if (audio !== null) {
      audio.srcObject = null;
      audio.remove();
      audioRef.current = null;
    }
    if (ringTimerRef.current !== null) {
      clearTimeout(ringTimerRef.current);
      ringTimerRef.current = null;
    }
    if (connectTimerRef.current !== null) {
      clearTimeout(connectTimerRef.current);
      connectTimerRef.current = null;
    }
    if (iceTimerRef.current !== null) {
      clearTimeout(iceTimerRef.current);
      iceTimerRef.current = null;
    }
    iceQueueRef.current = [];
    pendingIceRef.current = [];
    pendingOfferRef.current = null;
  }, []);

  const finish = useCallback(
    (reason: CallEndReason, error?: string): void => {
      releaseMedia();
      const peer = peerRef.current;
      peerRef.current = null;
      callIdRef.current = null;
      isCallerRef.current = false;
      setState({
        ...INITIAL,
        phase: 'ended',
        peer,
        endReason: reason,
        error: error ?? null,
      });
      // Fall back to idle so the UI closes itself after showing why it ended.
      setTimeout(() => {
        setState((current) => (current.phase === 'ended' ? INITIAL : current));
      }, 2_500);
    },
    [releaseMedia],
  );

  const endCall = useCallback(
    (reason: CallEndReason, error?: string): void => {
      const peer = peerRef.current;
      const callId = callIdRef.current;
      if (peer !== null && callId !== null) {
        void sendSignal(peer, { v: 1, type: 'call', op: 'end', callId, reason }).catch(() => {
          /* the other side also times out; nothing to recover */
        });
      }
      finish(reason, error);
    },
    [finish, sendSignal],
  );

  /**
   * Give up on a negotiation that never completes.
   *
   * WebRTC can sit in `connecting` indefinitely when no candidate pair ever
   * works, so a call that cannot connect must say so rather than spin forever.
   */
  const armConnectWatchdog = useCallback((): void => {
    if (connectTimerRef.current !== null) clearTimeout(connectTimerRef.current);
    connectTimerRef.current = setTimeout(() => {
      const pc = pcRef.current;
      if (pc !== null && pc.connectionState === 'connected') return;
      finish(
        'failed',
        'The call could not connect within 25 seconds. Both sides need to reach the relay server; a strict firewall or VPN is the usual cause.',
      );
    }, 25_000);
  }, [finish]);

  /* ── the peer connection ─────────────────────────────────────────────── */

  /** Apply one candidate now, or hold it until a remote description exists. */
  const applyIce = useCallback(async (lines: readonly IceLine[]): Promise<void> => {
    const pc = pcRef.current;
    if (pc === null || pc.remoteDescription === null) {
      pendingIceRef.current.push(...lines);
      return;
    }
    for (const line of lines) {
      try {
        await pc.addIceCandidate({
          candidate: line.candidate,
          sdpMid: line.sdpMid ?? undefined,
          sdpMLineIndex: line.sdpMLineIndex ?? undefined,
          usernameFragment: line.usernameFragment ?? undefined,
        });
      } catch {
        /* a rejected candidate is normal during trickling */
      }
    }
  }, []);

  /** Drain everything that was waiting on a remote description. */
  const drainPendingIce = useCallback(async (): Promise<void> => {
    const queued = pendingIceRef.current;
    if (queued.length === 0) return;
    pendingIceRef.current = [];
    await applyIce(queued);
  }, [applyIce]);

  const flushIce = useCallback((): void => {
    const peer = peerRef.current;
    const callId = callIdRef.current;
    const queue = iceQueueRef.current;
    iceTimerRef.current = null;
    if (peer === null || callId === null || queue.length === 0) return;
    const cands = queue.splice(0, MAX_CANDIDATES_PER_SIGNAL);
    void sendSignal(peer, { v: 1, type: 'call', op: 'ice', callId, cands }).catch(() => {
      /* a lost candidate degrades connectivity, it does not break the call */
    });
    if (queue.length > 0) {
      iceTimerRef.current = setTimeout(flushIce, ICE_BATCH_MS);
    }
  }, [sendSignal]);

  const buildConnection = useCallback(
    async (iceServers: readonly IceServer[]): Promise<RTCPeerConnection> => {
      const pc = new RTCPeerConnection({
        iceServers: iceServers as RTCIceServer[],
        // Forced relay: the two people never see each other's IP address.
        iceTransportPolicy: 'relay',
        bundlePolicy: 'max-bundle',
      });

      pc.onicecandidate = (event): void => {
        if (event.candidate === null) return;
        iceQueueRef.current.push({
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
          usernameFragment: event.candidate.usernameFragment,
        });
        if (iceTimerRef.current === null) {
          iceTimerRef.current = setTimeout(flushIce, ICE_BATCH_MS);
        }
      };

      pc.ontrack = (event): void => {
        const [stream] = event.streams;
        if (stream === undefined) return;
        let audio = audioRef.current;
        if (audio === null) {
          audio = document.createElement('audio');
          audio.autoplay = true;
          audio.style.display = 'none';
          document.body.appendChild(audio);
          audioRef.current = audio;
        }
        audio.srcObject = stream;
        void audio.play().catch(() => {
          /* autoplay policy: the accept tap already counts as a gesture */
        });
      };

      pc.oniceconnectionstatechange = (): void => {
        setState((current) => ({ ...current, diagnostic: `ice: ${pc.iceConnectionState}` }));
      };

      pc.onconnectionstatechange = (): void => {
        const status = pc.connectionState;
        if (status === 'connected') {
          for (const timer of [ringTimerRef, connectTimerRef]) {
            if (timer.current !== null) {
              clearTimeout(timer.current);
              timer.current = null;
            }
          }
          setState((current) => ({
            ...current,
            phase: 'connected',
            connectedAt: current.connectedAt ?? Date.now(),
            error: null,
            diagnostic: null,
          }));
          return;
        }
        if (status === 'failed') {
          finish(
            'failed',
            'The two devices could not find a path to each other. This is usually a network that blocks relayed media.',
          );
        }
      };

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      localStreamRef.current = stream;
      for (const track of stream.getTracks()) pc.addTrack(track, stream);

      pcRef.current = pc;
      return pc;
    },
    [finish, flushIce],
  );

  /* ── placing a call ──────────────────────────────────────────────────── */

  const start = useCallback(
    async (peer: CallPeer): Promise<void> => {
      if (owner === null || keys === null) return;
      if (peerRef.current !== null) return; // already on a call

      const callId = newCallId();
      peerRef.current = peer;
      callIdRef.current = callId;
      isCallerRef.current = true;
      seenCallsRef.current.add(callId);
      setState({ ...INITIAL, phase: 'dialing', peer });

      try {
        const { iceServers } = await getTurnCredentials();
        const pc = await buildConnection(iceServers);
        const offer = await pc.createOffer({ offerToReceiveAudio: true });
        await pc.setLocalDescription(offer);
        const sdp = pc.localDescription?.sdp ?? offer.sdp ?? '';
        await sendSignal(peer, { v: 1, type: 'call', op: 'offer', callId, sdp });
        setState((current) => ({ ...current, phase: 'ringing-out' }));
        ringTimerRef.current = setTimeout(() => {
          endCall('timeout');
        }, RING_TIMEOUT_MS);
      } catch (error) {
        const message =
          error instanceof DOMException && error.name === 'NotAllowedError'
            ? 'HoodGram needs microphone access to place a call. Allow it in your browser and try again.'
            : error instanceof DOMException && error.name === 'NotFoundError'
              ? 'No microphone was found on this device.'
              : error instanceof Error && error.message.includes('TURN')
                ? 'Calling is not configured on this relay yet.'
                : 'The call could not be started.';
        finish('failed', message);
      }
    },
    [buildConnection, endCall, finish, keys, owner, sendSignal],
  );

  /* ── answering ───────────────────────────────────────────────────────── */

  const accept = useCallback(async (): Promise<void> => {
    const pending = pendingOfferRef.current;
    if (pending === null || owner === null || keys === null) return;
    pendingOfferRef.current = null;
    setState((current) => ({ ...current, phase: 'connecting' }));

    try {
      const { iceServers } = await getTurnCredentials();
      const pc = await buildConnection(iceServers);
      armConnectWatchdog();
      await pc.setRemoteDescription({ type: 'offer', sdp: pending.sdp });
      // The caller trickled while we were ringing; those are queued.
      await drainPendingIce();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      const sdp = pc.localDescription?.sdp ?? answer.sdp ?? '';
      await sendSignal(pending.peer, {
        v: 1,
        type: 'call',
        op: 'answer',
        callId: pending.callId,
        sdp,
      });
    } catch (error) {
      const message =
        error instanceof DOMException && error.name === 'NotAllowedError'
          ? 'HoodGram needs microphone access to answer. Allow it in your browser and try again.'
          : 'The call could not be answered.';
      endCall('failed', message);
    }
  }, [armConnectWatchdog, buildConnection, drainPendingIce, endCall, keys, owner, sendSignal]);

  const decline = useCallback((): void => {
    pendingOfferRef.current = null;
    endCall('declined');
  }, [endCall]);

  const hangUp = useCallback((): void => {
    endCall('hangup');
  }, [endCall]);

  const toggleMute = useCallback((): void => {
    const stream = localStreamRef.current;
    if (stream === null) return;
    let muted = false;
    for (const track of stream.getAudioTracks()) {
      track.enabled = !track.enabled;
      muted = !track.enabled;
    }
    setState((current) => ({ ...current, muted }));
  }, []);

  /* ── receiving ───────────────────────────────────────────────────────── */

  const handleSignal = useCallback(
    async (pt: Plaintext, signal: CallSignal, from: Address): Promise<void> => {
      const activeId = callIdRef.current;
      // Offers are handled in the subscription, which owns building the peer.
      if (signal.op === 'offer') return;
      if (activeId === null || signal.callId !== activeId) return;
      const pc = pcRef.current;

      if (signal.op === 'ringing') {
        setState((current) =>
          current.phase === 'dialing' || current.phase === 'ringing-out'
            ? { ...current, phase: 'ringing-out' }
            : current,
        );
        return;
      }
      if (signal.op === 'answer') {
        if (pc === null || pc.signalingState === 'stable') return;
        armConnectWatchdog();
        setState((current) => ({ ...current, phase: 'connecting' }));
        await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
        // Everything the caller trickled at us while we were still ringing.
        await drainPendingIce();
        return;
      }
      if (signal.op === 'ice') {
        await applyIce(signal.cands);
        return;
      }
      if (signal.op === 'end') {
        finish(signal.reason === 'hangup' ? 'hangup' : signal.reason);
      }
    },
    [applyIce, armConnectWatchdog, drainPendingIce, finish],
  );

  /* Subscribe to sealed signalling frames for our tag. */
  useEffect(() => {
    if (owner === null || keys === null) return;

    let cancelled = false;
    const myX25519 = keys.x25519.publicKey;

    const unsubscribe = subscribeToRelay({
      onSignal: (blobBase64) => {
        void (async (): Promise<void> => {
          if (cancelled) return;
          let blob: Uint8Array;
          try {
            const binary = atob(blobBase64);
            blob = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i += 1) blob[i] = binary.charCodeAt(i);
          } catch {
            return;
          }

          const pt = await openEnvelope(blob, keys.x25519.privateKey, myX25519);
          if (pt === null || pt.kind !== 'system') return;
          if (pt.from === undefined || pt.sig === undefined) return;

          // Stale frames cannot be replayed into a new call.
          const now = Math.floor(Date.now() / 1000);
          if (Math.abs(now - pt.t) > CALL_MAX_SKEW_SECONDS) return;

          const signal = parseCallSignal(pt.body);
          if (signal === null) return;

          const from = pt.from.toLowerCase() as Address;

          // THE GATE: an SDP is only trusted once its author signature verifies
          // against the Ed25519 key the registry holds for the claimed address.
          const registered = await lookupPeerKeys(from);
          if (registered === null) return;
          const ok = await verifyAuthor(
            encodePlaintextCore(pt),
            myX25519,
            pt.sig,
            hexToBytes(registered.ed25519Pub),
          );
          if (!ok || cancelled) return;

          if (signal.op === 'offer') {
            // A repeat of an offer we already know is a retransmit, not a new call.
            if (seenCallsRef.current.has(signal.callId)) return;
            const peer: CallPeer = {
              address: from,
              x25519Pub: registered.x25519Pub,
              ed25519Pub: registered.ed25519Pub,
            };

            if (peerRef.current !== null) {
              // GLARE: both of us dialled the other at the same moment. The
              // deterministic loser (lower address) abandons its own outbound
              // call and answers this one, so exactly one call survives.
              const busyWithSamePerson =
                peerRef.current.address.toLowerCase() === from.toLowerCase();
              const yields =
                isCallerRef.current && busyWithSamePerson && losesGlare(owner, from);
              if (!yields) {
                void sendSignal(peer, {
                  v: 1,
                  type: 'call',
                  op: 'end',
                  callId: signal.callId,
                  reason: 'busy',
                }).catch(() => undefined);
                return;
              }
              releaseMedia();
            }

            seenCallsRef.current.add(signal.callId);
            peerRef.current = peer;
            callIdRef.current = signal.callId;
            isCallerRef.current = false;
            pendingOfferRef.current = { sdp: signal.sdp, peer, callId: signal.callId };
            setState({ ...INITIAL, phase: 'ringing-in', peer });
            void sendSignal(peer, {
              v: 1,
              type: 'call',
              op: 'ringing',
              callId: signal.callId,
            }).catch(() => undefined);
            ringTimerRef.current = setTimeout(() => {
              endCall('timeout');
            }, RING_TIMEOUT_MS);
            return;
          }

          // Everything else must come from the person we are actually on a call
          // with, never a third party who guessed a call id.
          if (peerRef.current?.address.toLowerCase() !== from) return;
          await handleSignal(pt, signal, from);
        })();
      },
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [endCall, handleSignal, keys, owner, releaseMedia, sendSignal]);

  /* Ask the relay once whether calling is even possible in this build. */
  useEffect(() => {
    let cancelled = false;
    void getTurnCredentials()
      .then(() => {
        if (!cancelled) setCanCall(true);
      })
      .catch(() => {
        if (!cancelled) setCanCall(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /* Release the microphone if the component unmounts mid-call. */
  useEffect(() => releaseMedia, [releaseMedia]);

  return { ...state, canCall, start, accept, decline, hangUp, toggleMute };
}

/* ══════════════════════════════════════════════ registry lookup ═════════ */

let lookupImpl: ((address: Address) => Promise<CallPeer | null>) | null = null;

/**
 * Install the KeyRegistry lookup the engine verifies signatures against.
 *
 * Injected rather than imported so this module stays free of wagmi and can be
 * unit-tested without a chain.
 */
export function setCallKeyLookup(
  lookup: (address: Address) => Promise<CallPeer | null>,
): void {
  lookupImpl = lookup;
}

async function lookupPeerKeys(address: Address): Promise<CallPeer | null> {
  if (lookupImpl === null) return null;
  try {
    return await lookupImpl(address);
  } catch {
    return null;
  }
}
