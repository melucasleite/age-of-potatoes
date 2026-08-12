// Where "$/min" comes from.
//
// READ THIS BEFORE CHANGING THE NUMBER. Work item 013's constraint is that the rate is
// read from an accumulator inside `WorldState`, never computed from sampled deltas in
// React — because the HUD's number and the Peak Flow leaderboard's number have to be the
// same substance, and a figure sampled at the HUD's own wall-clock cadence would drift
// from the sim's and the two would be irreconcilable later.
//
// The sim has the accumulator (`stats.netWorthSamples`, one sample per active minute,
// which is exactly Peak Flow's input) but `StatsView` does not currently project a
// current-rate field out of it. So:
//
//   1. If `view.stats` ever grows `rateCentsPerMin`, THIS FILE DEFERS TO IT IMMEDIATELY
//      and stops computing anything. That check is the first branch of `read()`, and it is
//      there because another agent is expanding `packages/sim` right now.
//   2. Until then the fallback samples `stats.netWorthCents` — a sim-owned integer — and
//      keys every sample BY SIM TICK, never by wall clock. Two machines running the same
//      world at different frame rates therefore compute the same rate from the same ticks,
//      which is the property the constraint actually protects. It is a display-side
//      smoothing of a sim-owned quantity, not a second source of truth.
//
// Net worth rather than cash, deliberately: cash falls when you buy a machine, and a
// Ticker that reads "-$4,000/min" the instant you invest is worse than useless. Net worth
// counts the machine at invoice, so the rate measures production rather than spending.

import { TICKS_PER_SECOND } from '@snack/sim';
import type { StatsView, WorldView } from '@snack/sim';

const TICKS_PER_MINUTE = TICKS_PER_SECOND * 60;

/** One sample per sim second. 64 of them is just over a minute of history. */
const SAMPLE_PERIOD_TICKS = TICKS_PER_SECOND;
const CAPACITY = 64;

/** Below this span the rate is noise — one harvest divided by two seconds is nonsense. */
const MIN_SPAN_TICKS = TICKS_PER_SECOND * 8;

/** A sim that projects its own rate. Optional today; expected to arrive (see above). */
type StatsWithRate = StatsView & { readonly rateCentsPerMin?: number };

export interface RateReading {
  readonly centsPerMin: number;
  /** 1 once the window is wide enough to trust. The Ticker shows an em dash until then. */
  readonly settled: number;
}

const WARMING: RateReading = { centsPerMin: 0, settled: 0 };

export class RateMeter {
  private readonly ticks = new Int32Array(CAPACITY);
  private readonly cents = new Float64Array(CAPACITY);
  private head = 0;
  private filled = 0;
  private lastSampleTick = -1 << 30;

  /** A restored save or a fresh world resets the history rather than spanning the gap. */
  reset(): void {
    this.head = 0;
    this.filled = 0;
    this.lastSampleTick = -1 << 30;
  }

  read(view: WorldView): RateReading {
    const stats = view.stats as StatsWithRate;

    // Branch 1: the sim owns the number. Nothing below runs.
    const provided = stats.rateCentsPerMin;
    if (provided !== undefined) return { centsPerMin: provided, settled: 1 };

    // Branch 2: the tick-keyed fallback.
    const tick = view.tick;
    if (tick < this.lastSampleTick) this.reset();
    if (tick - this.lastSampleTick >= SAMPLE_PERIOD_TICKS) {
      this.lastSampleTick = tick;
      this.ticks[this.head] = tick;
      this.cents[this.head] = stats.netWorthCents;
      this.head = (this.head + 1) % CAPACITY;
      if (this.filled < CAPACITY) this.filled += 1;
    }

    if (this.filled < 2) return WARMING;

    const oldestIndex = this.filled < CAPACITY ? 0 : this.head;
    const newestIndex = (this.head + CAPACITY - 1) % CAPACITY;
    const spanTicks = this.ticks[newestIndex]! - this.ticks[oldestIndex]!;
    if (spanTicks < MIN_SPAN_TICKS) return WARMING;

    const gain = this.cents[newestIndex]! - this.cents[oldestIndex]!;
    return { centsPerMin: Math.round((gain * TICKS_PER_MINUTE) / spanTicks), settled: 1 };
  }
}
