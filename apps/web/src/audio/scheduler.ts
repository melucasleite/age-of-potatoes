// The Music Box: a 25 ms interval loop with a 100 ms lookahead, placing every sound at an
// explicit time on the audio clock.
//
// ── WHY NOT JUST CALL .start() WHEN THE THING HAPPENS ──────────────────────────────
// Because rAF and the tick loop wander by several milliseconds a frame, and on a rhythmic
// grid the ear hears that instantly — it is the difference between a factory that grooves
// and a factory that clatters. Web Audio's answer, and the standard pattern, is to schedule
// AHEAD on the audio clock: wake up often, look a little way into the future, and hand the
// audio thread events with an explicit `when`. The audio thread then starts them
// sample-accurately whatever the main thread is doing.
//
// ── THE APPARENT CONTRADICTION, AND WHY IT DISSOLVES ───────────────────────────────
// You cannot schedule ahead for events that have not happened yet. But quantization hands
// you the lookahead for free: a machine sound emitted at tick T is scheduled for the next
// GRID BOUNDARY at or after T, and boundaries are 600 ms apart (150 ms at sixteenth
// resolution). The scheduled time is therefore comfortably beyond the 100 ms window. The
// one edge case is a boundary that is already nearly here — under ~30 ms — which is pushed
// to the following boundary rather than scheduled into the past.
//
// ── THE GRID PULSE, WHICH IS THE ACTUAL DESIGN PAYOFF ──────────────────────────────
// Discrete events are only half of it. Every beat, the scheduler asks the observer for the
// ENSEMBLE — the set of machines that are Running right now — and places one voice per
// machine exactly on the boundary. That is what makes plan §2's promise literal: a healthy
// factory grooves, and a starving one drops instruments, because a starved machine is
// simply not in the ensemble and its part goes silent. You can hear a dead syrup line from
// two screens away without looking at it. It is a diagnostic instrument disguised as a
// soundtrack, and it works precisely because the grid is derived from the sim's tick
// counter rather than from anything in this file.

import { TICKS_PER_BEAT } from '@snack/sim';

import type { AudioEngine } from './AudioEngine';
import { Quantize, soundSpec } from './sounds';
import type { SoundId } from './sounds';

/**
 * A sixteenth is a quarter of a beat: 3 ticks at 100 BPM and 20 Hz.
 *
 * Derived from the sim's constant rather than written as `3`, so that if the tempo ever
 * moves, it moves here too. `TICKS_PER_BEAT` itself is imported and never redeclared — the
 * sim owns the grid, and a second copy of the number in `apps/web` is exactly how the two
 * would silently disagree.
 */
export const TICKS_PER_SIXTEENTH = TICKS_PER_BEAT / 4;

/** How often the loop wakes. The standard Web Audio figure. */
const INTERVAL_MS = 25;
/** How far ahead each pass schedules. Also standard, and 6× the wake interval. */
const LOOKAHEAD_S = 0.1;
/** Nothing is scheduled closer than this to now; below it, the audio thread may miss it. */
const MIN_LEAD_S = 0.03;
/** An event whose moment passed by more than this is dropped rather than played late. */
const STALE_EVENT_S = 0.25;
/** No frame for this long means the world is not running: paused, or a hidden tab. */
const WORLD_STALE_MS = 200;
/** A pathological frame must not be able to queue unbounded sound. */
const MAX_QUEUE = 64;

const TICK_SECONDS = 0.05;

/** A one-off sound, tied to the tick it happened on. */
export interface QueuedEvent {
  readonly soundId: SoundId;
  /** The sim tick the event was observed at. Quantization is relative to this. */
  readonly tick: number;
  readonly pan: number;
  readonly gain: number;
  readonly rate: number;
}

/** One machine's part in the groove, placed on every beat while it is Running. */
export interface EnsembleVoice {
  readonly soundId: SoundId;
  readonly pan: number;
  readonly gain: number;
  readonly rate: number;
}

export class Scheduler {
  private readonly engine: AudioEngine;
  private readonly queue: QueuedEvent[] = [];
  private ensemble: readonly EnsembleVoice[] = [];

  /** The next beat boundary that has not been placed yet, in ticks. */
  private nextBeatTick = 0;
  private currentTick = 0;
  private lastObserveMs = 0;

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(engine: AudioEngine) {
    this.engine = engine;
  }

  start(): void {
    if (this.timer !== null) return;
    // A plain interval, deliberately. `requestAnimationFrame` is throttled to 0 Hz in a
    // hidden tab and clamped to the display refresh in a visible one — neither is a
    // property you want in the thing that decides when sound happens.
    this.timer = setInterval(() => this.pump(), INTERVAL_MS);
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
    this.queue.length = 0;
    this.ensemble = [];
  }

  /** Called once per frame from the observer, with the tick the world is actually on. */
  setTick(tick: number, nowMs: number): void {
    this.currentTick = tick;
    this.lastObserveMs = nowMs;
  }

  /** Replace the set of machines currently holding a part in the groove. */
  setEnsemble(voices: readonly EnsembleVoice[]): void {
    this.ensemble = voices;
  }

  push(event: QueuedEvent): void {
    // Drop the OLDEST on overflow. The newest events describe what is on screen now, and
    // a backlog is by definition already stale.
    if (this.queue.length >= MAX_QUEUE) this.queue.shift();
    this.queue.push(event);
  }

  // --- the pass -------------------------------------------------------------------------

  private pump(): void {
    const engine = this.engine;
    if (!engine.started) return;

    const pool = engine.voices;
    if (pool === null) return;

    const now = engine.now;
    const horizon = now + LOOKAHEAD_S;

    // A paused game, or a backgrounded tab whose rAF stopped, must not keep drumming. The
    // sim is not advancing, so projected tick times are fiction from here on.
    if (performance.now() - this.lastObserveMs > WORLD_STALE_MS) {
      this.queue.length = 0;
      this.rebaseGrid(now);
      return;
    }

    this.pumpQueue(pool, now, horizon);
    this.pumpGrid(pool, now, horizon);
  }

  private pumpQueue(pool: NonNullable<AudioEngine['voices']>, now: number, horizon: number): void {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const event = this.queue[i];
      if (event === undefined) continue;

      const when = this.timeFor(event, now);
      if (when > horizon) continue; // Not yet. It will still be here next pass.

      if (when >= now - STALE_EVENT_S) {
        pool.play(soundSpec(event.soundId), Math.max(when, now), {
          pan: event.pan,
          gain: event.gain,
          rate: event.rate,
        });
      }
      this.queue.splice(i, 1);
    }
  }

  private pumpGrid(pool: NonNullable<AudioEngine['voices']>, now: number, horizon: number): void {
    this.rebaseGrid(now);

    // At most one iteration in practice: a beat is 600 ms and the window is 100 ms.
    while (this.engine.timeOf(this.nextBeatTick) <= horizon) {
      const when = this.engine.timeOf(this.nextBeatTick);
      if (when >= now + MIN_LEAD_S) {
        for (const voice of this.ensemble) {
          pool.play(soundSpec(voice.soundId), when, {
            pan: voice.pan,
            gain: voice.gain,
            rate: voice.rate,
          });
        }
      }
      this.nextBeatTick += TICKS_PER_BEAT;
    }
  }

  /**
   * Move the beat cursor forward to the first boundary that is still schedulable.
   *
   * Done arithmetically rather than by looping, because after a tab restore or a re-anchor
   * the cursor can be minutes behind and a `while (++)` there would be a visible stall.
   */
  private rebaseGrid(now: number): void {
    if (this.nextBeatTick < this.currentTick) {
      this.nextBeatTick = ceilTo(this.currentTick, TICKS_PER_BEAT);
    }
    const deficit = now + MIN_LEAD_S - this.engine.timeOf(this.nextBeatTick);
    if (deficit > 0) {
      const beatSeconds = TICKS_PER_BEAT * TICK_SECONDS;
      this.nextBeatTick += Math.ceil(deficit / beatSeconds) * TICKS_PER_BEAT;
    }
  }

  /**
   * When a queued event should sound.
   *
   * Player verbs answer `now` — plan §2's tactile spec is a hard rule and quantizing a
   * watering-can pour would add up to 600 ms of latency to the verbs the entire first era
   * is built on. Machine sounds answer with a grid boundary.
   */
  private timeFor(event: QueuedEvent, now: number): number {
    const spec = soundSpec(event.soundId);
    if (spec.quantize === Quantize.Immediate) return now;

    const quantum = spec.quantize === Quantize.Beat ? TICKS_PER_BEAT : TICKS_PER_SIXTEENTH;
    let boundary = ceilTo(event.tick, quantum);

    // The edge case from the header: a boundary too close to now is pushed to the next one.
    // Scheduling into the past is how a quantized sound ends up early AND jittered, which
    // is worse than either alone.
    const deficit = now + MIN_LEAD_S - this.engine.timeOf(boundary);
    if (deficit > 0) {
      const quantumSeconds = quantum * TICK_SECONDS;
      boundary += Math.ceil(deficit / quantumSeconds) * quantum;
    }
    return this.engine.timeOf(boundary);
  }
}

function ceilTo(value: number, multiple: number): number {
  return Math.ceil(value / multiple) * multiple;
}
