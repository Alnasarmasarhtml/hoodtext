/**
 * Call tones, and the one rule that makes them audible.
 *
 * A browser will not let a page make sound until the page has had a real user
 * gesture, and an `AudioContext` created outside one starts SUSPENDED. A
 * suspended context's clock is frozen, so anything scheduled against
 * `currentTime` is scheduled at a moment that has already passed by the time the
 * context resumes: the oscillator runs, and you hear nothing. That is exactly
 * why the first ringback was silent.
 *
 * So the context is created and resumed SYNCHRONOUSLY inside the click that
 * starts or answers a call, kept for the life of the tab, and every tone is
 * scheduled only after the clock is confirmed running.
 */

let ctx: AudioContext | null = null;

/**
 * Create and resume the audio context. Call this from inside a click handler,
 * never from an effect: the gesture is what grants permission to make sound.
 */
export function unlockCallAudio(): void {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
  } catch {
    /* no WebAudio in this browser: the title flash is the fallback alert */
  }
}

export type ToneKind = 'ringback' | 'ring';

interface ToneSpec {
  readonly frequency: number;
  readonly gain: number;
  readonly duration: number;
  /** Offsets within one cycle at which a pulse fires. */
  readonly pattern: readonly number[];
  readonly cycleMs: number;
}

const TONES: Record<ToneKind, ToneSpec> = {
  /** What the caller hears while it rings out: the long, low telephone tone. */
  ringback: { frequency: 425, gain: 0.06, duration: 1.0, pattern: [0], cycleMs: 3_000 },
  /** What the callee hears: brighter and faster, so it reads as urgent. */
  ring: { frequency: 620, gain: 0.09, duration: 0.32, pattern: [0, 0.45], cycleMs: 2_400 },
};

function pulse(spec: ToneSpec): void {
  const audio = ctx;
  if (audio === null || audio.state !== 'running') return;
  const start = audio.currentTime;
  for (const offset of spec.pattern) {
    const at = start + offset;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'sine';
    osc.frequency.value = spec.frequency;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(spec.gain, at + 0.03);
    gain.gain.setValueAtTime(spec.gain, at + spec.duration - 0.06);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + spec.duration);
    osc.connect(gain).connect(audio.destination);
    osc.start(at);
    osc.stop(at + spec.duration + 0.02);
  }
}

/**
 * Start a repeating tone.
 *
 * If the context is still suspended (an INCOMING call on a tab that has never
 * been clicked), this keeps trying to resume for a few seconds rather than
 * failing silently, because the user clicking anywhere will unblock it.
 *
 * @returns a function that stops the tone.
 */
export function startTone(kind: ToneKind): () => void {
  unlockCallAudio();
  const spec = TONES[kind];
  let stopped = false;

  const tick = (): void => {
    if (stopped) return;
    if (ctx !== null && ctx.state === 'suspended') {
      void ctx.resume().catch(() => undefined);
    }
    pulse(spec);
  };

  tick();
  const loop = setInterval(tick, spec.cycleMs);
  return () => {
    stopped = true;
    clearInterval(loop);
  };
}
