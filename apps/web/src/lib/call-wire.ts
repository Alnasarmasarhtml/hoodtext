/**
 * Call signalling: the payloads two browsers exchange to set up a voice call.
 *
 * A signal is an ordinary sealed envelope of `kind: 'system'` whose body is the
 * JSON of one {@link CallSignal}, exactly the way a room-key handoff already
 * travels (see `parseRoomKeyPayload`). It reuses `seal`/`open` and the signed
 * author attribution byte for byte, and adds no new cryptography.
 *
 * WHY THE SDP MUST BE SIGNED, NOT MERELY SEALED
 * WebRTC media is DTLS-SRTP, but the certificates are self-signed, so DTLS on
 * its own authenticates nobody. What binds the media to a person is the
 * `a=fingerprint:sha-256` line INSIDE the SDP: the browser refuses to complete
 * the handshake unless the peer's certificate hashes to that value. Whoever
 * controls the SDP therefore controls who you are talking to. Sealing stops the
 * relay reading or editing it; the in-payload author signature proves the
 * fingerprint was chosen by the holder of the Ed25519 key that KeyRegistry maps
 * to the sender's address. Verify the signature BEFORE `setRemoteDescription`.
 *
 * Signals are EPHEMERAL. They never touch the chain, are never uploaded as a
 * blob, and are never written to IndexedDB.
 */
import { sha256, stringToHex, type Address, type Hex } from 'viem';

/** Payload schema version. Bump only on a breaking shape change. */
export const CALL_PAYLOAD_VERSION = 1;

export const CALL_OPS = ['offer', 'ringing', 'answer', 'ice', 'end'] as const;
export type CallOp = (typeof CALL_OPS)[number];

export const CALL_END_REASONS = [
  'hangup',
  'declined',
  'busy',
  'timeout',
  'failed',
  'cancelled',
] as const;
export type CallEndReason = (typeof CALL_END_REASONS)[number];

/**
 * Hard ceiling on one SDP.
 *
 * An audio-only, relay-only offer measures about 1.2 KB. The 4096-byte bucket
 * holds roughly 3.1 KB of raw SDP once JSON escaping and the envelope overhead
 * are paid for, so rejecting past 3 KB is deliberate: a silent spill into the
 * 16384 bucket would quadruple the frame and make its length content-dependent.
 */
export const MAX_SDP_BYTES = 3_072;

/** Most trickle candidates one `ice` signal may carry. 3 keeps the sealed frame in the 1024 bucket. */
export const MAX_CANDIDATES_PER_SIGNAL = 3;

/** Largest single candidate line. */
export const MAX_CANDIDATE_BYTES = 300;

/** Widest acceptable clock difference, in seconds, before a signal is treated as stale. */
export const CALL_MAX_SKEW_SECONDS = 120;

/** One trickled ICE candidate, in the shape `RTCPeerConnection.addIceCandidate` wants. */
export interface IceLine {
  readonly candidate: string;
  readonly sdpMid: string | null;
  readonly sdpMLineIndex: number | null;
  readonly usernameFragment: string | null;
}

interface CallSignalBase {
  readonly v: typeof CALL_PAYLOAD_VERSION;
  readonly type: 'call';
  readonly op: CallOp;
  /** 16 random bytes as hex, correlating every frame of one call. */
  readonly callId: string;
}

export type CallSignal =
  | (CallSignalBase & { readonly op: 'offer'; readonly sdp: string })
  | (CallSignalBase & { readonly op: 'ringing' })
  | (CallSignalBase & { readonly op: 'answer'; readonly sdp: string })
  | (CallSignalBase & { readonly op: 'ice'; readonly cands: readonly IceLine[] })
  | (CallSignalBase & { readonly op: 'end'; readonly reason: CallEndReason });

const CALL_ID_RE = /^[0-9a-f]{32}$/;

/** A fresh call id. 16 random bytes, so two calls can never collide. */
export function newCallId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCandidate(raw: unknown): IceLine | null {
  if (!isRecord(raw)) return null;
  const { candidate, sdpMid, sdpMLineIndex, usernameFragment } = raw;
  if (typeof candidate !== 'string' || candidate.length === 0) return null;
  if (candidate.length > MAX_CANDIDATE_BYTES) return null;
  return {
    candidate,
    sdpMid: typeof sdpMid === 'string' ? sdpMid : null,
    sdpMLineIndex: typeof sdpMLineIndex === 'number' && Number.isInteger(sdpMLineIndex) ? sdpMLineIndex : null,
    usernameFragment: typeof usernameFragment === 'string' ? usernameFragment : null,
  };
}

/**
 * Parse a call signal out of a decrypted `system` body.
 *
 * Never throws and returns `null` for anything malformed: this body was authored
 * by whoever sealed the envelope, and its SDP is about to be fed to
 * `setRemoteDescription`, so every bound is checked here first.
 */
export function parseCallSignal(body: string): CallSignal | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  if (raw['type'] !== 'call' || raw['v'] !== CALL_PAYLOAD_VERSION) return null;

  const op = raw['op'];
  const callId = raw['callId'];
  if (typeof op !== 'string' || !(CALL_OPS as readonly string[]).includes(op)) return null;
  if (typeof callId !== 'string' || !CALL_ID_RE.test(callId)) return null;

  const base = { v: CALL_PAYLOAD_VERSION, type: 'call', callId } as const;

  switch (op as CallOp) {
    case 'offer':
    case 'answer': {
      const sdp = raw['sdp'];
      if (typeof sdp !== 'string' || sdp.length === 0) return null;
      if (new TextEncoder().encode(sdp).length > MAX_SDP_BYTES) return null;
      return { ...base, op: op as 'offer' | 'answer', sdp };
    }
    case 'ice': {
      const candsRaw = raw['cands'];
      if (!Array.isArray(candsRaw) || candsRaw.length === 0) return null;
      if (candsRaw.length > MAX_CANDIDATES_PER_SIGNAL) return null;
      const cands: IceLine[] = [];
      for (const entry of candsRaw) {
        const parsed = parseCandidate(entry);
        if (parsed === null) return null;
        cands.push(parsed);
      }
      return { ...base, op: 'ice', cands };
    }
    case 'end': {
      const reason = raw['reason'];
      if (typeof reason !== 'string' || !(CALL_END_REASONS as readonly string[]).includes(reason)) {
        return null;
      }
      return { ...base, op: 'end', reason: reason as CallEndReason };
    }
    case 'ringing':
      return { ...base, op: 'ringing' };
  }
}

/** Serialize a signal for the sealed envelope's body. */
export function encodeCallSignal(signal: CallSignal): string {
  if ((signal.op === 'offer' || signal.op === 'answer') &&
      new TextEncoder().encode(signal.sdp).length > MAX_SDP_BYTES) {
    throw new Error('SDP is too large to seal into one signalling frame');
  }
  return JSON.stringify(signal);
}

/** Whether a body could be a call signal, for the receive pipeline's guard. */
export function looksLikeCallSignal(body: string): boolean {
  return body.includes('"type":"call"') && parseCallSignal(body) !== null;
}

/**
 * The relay routing address for a person, derived from their REGISTERED X25519
 * public key. Not a secret: every key is public in KeyRegistry, so the relay can
 * map tags back to people and therefore learns who calls whom. It learns nothing
 * about what is said.
 */
export function callTagFor(x25519Pub: Hex): string {
  return sha256(`${stringToHex('hoodgram.call.tag.v1')}${x25519Pub.slice(2)}` as Hex).slice(2, 18);
}

/** Deterministic glare tie-break: when two offers cross, the lower address yields. */
export function losesGlare(mine: Address, theirs: Address): boolean {
  return mine.toLowerCase() < theirs.toLowerCase();
}
