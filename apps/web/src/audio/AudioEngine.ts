// The `AudioContext`, the start gesture, the master bus, and the tick → audio-time anchor.
//
// ══════════════════════════════════════════════════════════════════════════════════════
//  THE CLOCK RUNS ONE WAY. THE SIM TELLS AUDIO WHAT TIME IT IS. AUDIO TELLS THE SIM
//  NOTHING, EVER.
//
//  `sync()` reads the tick and moves the anchor. There is no path in the other direction
//  and there must never be one. AGENTS.md and plan §14 both call this out as the rule that
//  is NOT RECOVERABLE BY REFACTORING: an `AudioContext.currentTime` that reaches
//  `WorldState` puts a drifting sample clock inside the deterministic loop, and every
//  seeded world, every golden hash fixture, and every stored input trace becomes
//  unreproducible at once. There is no migration out of that. `packages/sim` has no "DOM"
//  lib in its tsconfig precisely so `AudioContext` is a type error there — do not work
//  around it, and do not import anything from this directory into the sim.
// ══════════════════════════════════════════════════════════════════════════════════════
//
// ── WHY TWO CLOCKS EXIST AT ALL ────────────────────────────────────────────────────
// They genuinely diverge, in both directions, by design:
//   - The sim FALLS BEHIND on purpose. `GameHost` caps catch-up at `MAX_CATCHUP = 5` and
//     clamps a tab-restore burst to 250 ms, choosing visible lag over a death spiral.
//   - `AudioContext.currentTime` advances on the audio hardware's own crystal regardless
//     of what the main thread is doing, and that crystal is not the one `performance.now()`
//     reads.
// So we keep an anchor pair and project from it, rather than pretending either clock is
// authoritative:
//
//     timeOf(T) = anchorAudioTime + (T − anchorTick) × 0.05
//
// and re-anchor when the projection for the CURRENT tick has drifted more than ~50 ms from
// the audio clock. 50 ms is one tick and roughly a twelfth of a beat — comfortably below
// where a listener hears a beat land in the wrong place, and comfortably above the jitter
// of a healthy frame, so it re-anchors on real divergence rather than on noise.

import { TICK_MS } from '@snack/sim';

import { SoundBank } from './synth';
import { VoicePool } from './voice-pool';

const TICK_SECONDS = TICK_MS / 1000;

/** Re-anchor past this much divergence. One tick; see the header. */
const RESYNC_THRESHOLD_S = 0.05;

/** Fade time for the mute toggle. Instant gain changes click. */
const MUTE_FADE_S = 0.04;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private bank: SoundBank | null = null;
  private pool: VoicePool | null = null;

  private anchorTick = 0;
  private anchorTime = 0;
  private anchored = false;

  private muted = false;
  private starting = false;
  private disposed = false;

  /** Set once the context exists and has been resumed by a real gesture. */
  get started(): boolean {
    return this.ctx !== null && this.pool !== null;
  }

  get running(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  get now(): number {
    return this.ctx === null ? 0 : this.ctx.currentTime;
  }

  get voices(): VoicePool | null {
    return this.pool;
  }

  /**
   * Create and resume the context. MUST be called synchronously from a real user gesture.
   *
   * Nothing before this line touches Web Audio at all — the context is not merely left
   * suspended, it does not EXIST until a gesture arrives. That is deliberate: constructing
   * a context outside a gesture is what produces Chrome's "The AudioContext was not allowed
   * to start" console warning, and a warning that appears on every page load is a warning
   * everybody learns to ignore, including the one time it means something.
   *
   * Everything up to `resume()` is synchronous, so it all runs inside the gesture's task —
   * which is what the autoplay policy actually checks.
   */
  async start(): Promise<void> {
    if (this.disposed || this.starting || this.started) return;
    this.starting = true;

    try {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      const master = ctx.createGain();
      master.gain.value = this.muted ? 0 : 1;
      master.connect(ctx.destination);

      // Rendered eagerly, here, rather than lazily on first play. The bank is single-digit
      // milliseconds of arithmetic, and a lazy first pour would stutter — and the first
      // pour is the one that has to feel good (plan §2).
      const bank = new SoundBank(ctx);

      this.ctx = ctx;
      this.master = master;
      this.bank = bank;
      this.pool = new VoicePool(ctx, master, bank);

      await ctx.resume();

      // Disposal can land while `resume()` is in flight — same hazard, same shape, as the
      // StrictMode re-check in `GameHost`.
      if (this.disposed) {
        void ctx.close();
        this.ctx = null;
        this.pool = null;
      }
    } catch (error) {
      console.warn('[snack] audio failed to start; the game runs silent:', error);
      this.ctx = null;
      this.master = null;
      this.bank = null;
      this.pool = null;
    } finally {
      this.starting = false;
    }
  }

  /**
   * Project a sim tick onto the audio clock.
   *
   * Valid for ticks in the past and the future alike — the future is the interesting
   * direction, because that is what lets the scheduler place a beat before it happens.
   */
  timeOf(tick: number): number {
    return this.anchorTime + (tick - this.anchorTick) * TICK_SECONDS;
  }

  /**
   * Tell the audio layer what tick the world is on. Called once per frame, and the ONLY
   * direction information ever flows between the two clocks.
   */
  sync(tick: number): void {
    const ctx = this.ctx;
    if (ctx === null) return;

    if (!this.anchored) {
      this.anchorTick = tick;
      this.anchorTime = ctx.currentTime;
      this.anchored = true;
      return;
    }

    // Re-anchor only on real divergence. Re-anchoring every frame would make `timeOf`
    // follow the main thread's jitter, and a beat grid that follows frame jitter is not a
    // grid — it is the scatter this whole subsystem exists to remove.
    if (Math.abs(this.timeOf(tick) - ctx.currentTime) > RESYNC_THRESHOLD_S) {
      this.anchorTick = tick;
      this.anchorTime = ctx.currentTime;
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    const ctx = this.ctx;
    const master = this.master;
    if (ctx === null || master === null) return;
    master.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, MUTE_FADE_S);
  }

  isMuted(): boolean {
    return this.muted;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.pool?.dispose();
    this.pool = null;
    this.master?.disconnect();
    this.master = null;
    this.bank = null;

    const ctx = this.ctx;
    this.ctx = null;
    if (ctx !== null) void ctx.close().catch(() => undefined);
  }
}
