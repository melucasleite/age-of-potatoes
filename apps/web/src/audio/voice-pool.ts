// A fixed pool of voices, and the three limiters that keep a factory from becoming a wall.
//
// ── DROP, NEVER STEAL ──────────────────────────────────────────────────────────────
// When the pool is full the new voice is DROPPED. The tempting alternative — stop the
// oldest voice and reuse its slot — is worse in exactly the case it is meant to help:
// cutting a `BufferSourceNode` mid-sample ends it on a non-zero value and produces a
// click, and clicks are the one artefact the ear picks out of a dense mix instantly. A
// dropped sound in a dense mix is, by construction, inaudible. So the failure mode of
// running out of voices is "slightly thinner", never "broken".
//
// ── THREE LIMITERS, ONE PURPOSE ────────────────────────────────────────────────────
//   1. POOL SIZE bounds total simultaneous voices — the CPU and the mix headroom.
//   2. PER-ID CONCURRENCY stops one sound from eating the whole pool.
//   3. PER-ID MINIMUM INTERVAL stops one sound from machine-gunning. This is the one that
//      matters at scale: with a field of crops you cannot play a sound per event, and one
//      fryer chug per beat conveys exactly as much information as forty of them.
// Viewport culling is a fourth, and it happens upstream in `observer.ts` — an event that
// is off-screen never reaches this file at all.

import type { SoundBank } from './synth';
import type { SoundId, SoundSpec } from './sounds';

/** Voices. 24 is generous for v0.1 and cheap; the limiters below bite long before it does. */
const DEFAULT_POOL_SIZE = 24;

/** How far a fully off-centre sound is pushed into one ear. Full ±1 is fatiguing. */
const MAX_PAN = 0.75;

interface Slot {
  readonly gain: GainNode;
  readonly panner: StereoPannerNode;
  source: AudioBufferSourceNode | null;
}

export interface PlayOptions {
  /** −1 (hard left) to 1 (hard right), before `MAX_PAN` is applied. */
  readonly pan: number;
  /** Distance attenuation and any per-event emphasis, multiplied onto the spec's gain. */
  readonly gain: number;
  /** Pitch multiplier. 1 is the buffer as rendered. Used by the harvest streak ladder. */
  readonly rate: number;
}

export class VoicePool {
  private readonly ctx: AudioContext;
  private readonly bank: SoundBank;
  private readonly slots: Slot[] = [];

  /** Voices of each id currently sounding. Decremented on `ended`. */
  private readonly activeById = new Map<SoundId, number>();
  /** The audio time each id was last STARTED at — scheduled time, not wall time. */
  private readonly lastStartById = new Map<SoundId, number>();

  constructor(
    ctx: AudioContext,
    destination: AudioNode,
    bank: SoundBank,
    size: number = DEFAULT_POOL_SIZE,
  ) {
    this.ctx = ctx;
    this.bank = bank;

    // The gain and panner nodes are built once and reused forever. Only the
    // `AudioBufferSourceNode` is per-voice, because a source node is single-use by spec —
    // it cannot be restarted after it has played.
    for (let i = 0; i < size; i++) {
      const gain = ctx.createGain();
      const panner = ctx.createStereoPanner();
      gain.connect(panner);
      panner.connect(destination);
      this.slots.push({ gain, panner, source: null });
    }
  }

  /**
   * Start `spec`'s sound at the explicit audio time `when`, if the limiters allow it.
   *
   * `when` is always explicit and always in the future — that is the entire reason the
   * scheduler exists. Nothing in this codebase calls `.start()` with no argument, and
   * nothing calls it from a tick callback.
   *
   * Returns whether a voice was actually allocated, so callers can account for drops.
   */
  play(spec: SoundSpec, when: number, options: PlayOptions): boolean {
    const buffer = this.bank.get(spec.id);
    if (buffer === null) return false;

    // Limiter 3: minimum interval, measured between SCHEDULED times. Comparing against
    // `currentTime` instead would let two events quantized onto the same beat boundary
    // both pass, and then land on top of each other — which is precisely the pile-up the
    // interval exists to prevent.
    const lastStart = this.lastStartById.get(spec.id);
    if (lastStart !== undefined && when - lastStart < spec.minIntervalMs / 1000) return false;

    // Limiter 2: per-id concurrency.
    const active = this.activeById.get(spec.id) ?? 0;
    if (active >= spec.maxConcurrent) return false;

    // Limiter 1: the pool itself.
    const slot = this.claimSlot();
    if (slot === null) return false;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = options.rate > 0 ? options.rate : 1;

    slot.source = source;
    slot.gain.gain.value = Math.max(0, spec.gain * options.gain);
    slot.panner.pan.value = clamp(options.pan, -1, 1) * MAX_PAN;
    source.connect(slot.gain);

    this.activeById.set(spec.id, active + 1);
    this.lastStartById.set(spec.id, when);

    source.onended = () => {
      source.disconnect();
      if (slot.source === source) slot.source = null;
      this.activeById.set(spec.id, Math.max(0, (this.activeById.get(spec.id) ?? 1) - 1));
    };

    source.start(when);
    return true;
  }

  private claimSlot(): Slot | null {
    for (const slot of this.slots) {
      if (slot.source === null) return slot;
    }
    return null;
  }

  /** Stop everything and release the graph. Safe to call twice. */
  dispose(): void {
    for (const slot of this.slots) {
      const source = slot.source;
      slot.source = null;
      if (source !== null) {
        source.onended = null;
        try {
          source.stop();
        } catch {
          // Already stopped, or never started. Neither is a problem during teardown.
        }
        source.disconnect();
      }
      slot.gain.disconnect();
      slot.panner.disconnect();
    }
    this.slots.length = 0;
    this.activeById.clear();
    this.lastStartById.clear();
  }
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}
