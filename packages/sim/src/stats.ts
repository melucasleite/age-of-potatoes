// Leaderboard accumulators.
//
// ONE-WAY DOOR — PLAN §12. These live *inside* `WorldState` and *inside* `hashState()`,
// and they must stay there. It is not an accident of layering and it is not a candidate
// for a tidy-up: the boards in plan §6 are timed and net-worth-accounted, so the numbers
// they read have to advance inside `step()` alongside everything else, in lockstep with
// the tick that produced them. Retrofitting timed stats into a persistent world is misery
// (plan §8's standing roadmap rule), and moving them outside the hash would mean a
// desynced world could still post a plausible score.
//
// The boards these feed (plan §6):
//   First Ten   — lifetime net earnings at 10 active hours
//   Peak Flow   — best trailing net-worth gain rate
//   Dynasty     — lifetime net worth
//   Hands-Free  — an interval with zero manual touches
//   Boutique    — Peak Flow ÷ machine count
//   Dry County  — cents earned per kilolitre of water drawn
//
// Every field is an integer. Cents, millilitres, ticks, counts.

import { NET_WORTH_SAMPLE_LIMIT } from './data';
import { TICKS_PER_ACTIVE_HOUR, divFloor } from './units';

/**
 * Plan §6's manual-touch taxonomy, in full. Hands-Free is unadjudicable without it, and a
 * category that is not counted from v0.1 can never be counted retroactively.
 *
 * Camera movement, hovering, and opening menus are NOT touches — watching your factory is
 * playing it.
 */
export interface ManualTouchCounts {
  handWater: number;
  handPlant: number;
  handHarvest: number;
  /** Carrying, loading, and unloading by hand — one category per plan §6. */
  handCarry: number;
  handRepair: number;
  jamWhack: number;
  /** Refilling any hopper: seeds, kits, consumables, sprinkler barrels. */
  hopperRefill: number;
}

export interface WorldStats {
  /** Ticks the world has actually advanced. The clock and the money are one substance. */
  ticksElapsed: number;

  /** Gross receipts, in cents. */
  lifetimeEarnedCents: number;
  /** Everything spent, in cents — machines, seeds, kits. */
  lifetimeSpentCents: number;

  /** Water drawn from any source by any means, in millilitres. Feeds Dry County. */
  waterDrawnMl: number;

  itemsSold: number;
  itemsProducedByMachine: number;
  itemsHarvestedByHand: number;

  /** Cash + inventory at list + machines at invoice, recomputed every tick (plan §6). */
  netWorthCents: number;
  peakNetWorthCents: number;
  /**
   * One net-worth sample per active minute, oldest first, capped at ten hours. This is the
   * running input Peak Flow's trailing-window rate is computed from; the window itself is
   * a read-time question, so it is not stored.
   */
  netWorthSamples: number[];
  /** Tick the next sample is due on. */
  nextNetWorthSampleTick: number;

  /** Ticks since the last manual touch of any kind. Feeds the Hands-Free board. */
  ticksSinceManualTouch: number;
  /** Longest run of ticks with no manual touch. */
  longestHandsFreeTicks: number;

  touches: ManualTouchCounts;
}

export function createManualTouchCounts(): ManualTouchCounts {
  return {
    handWater: 0,
    handPlant: 0,
    handHarvest: 0,
    handCarry: 0,
    handRepair: 0,
    jamWhack: 0,
    hopperRefill: 0,
  };
}

export function createStats(): WorldStats {
  return {
    ticksElapsed: 0,
    lifetimeEarnedCents: 0,
    lifetimeSpentCents: 0,
    waterDrawnMl: 0,
    itemsSold: 0,
    itemsProducedByMachine: 0,
    itemsHarvestedByHand: 0,
    netWorthCents: 0,
    peakNetWorthCents: 0,
    netWorthSamples: [],
    nextNetWorthSampleTick: 0,
    ticksSinceManualTouch: 0,
    longestHandsFreeTicks: 0,
    touches: createManualTouchCounts(),
  };
}

/** The name of each touch category, so `step()` can bump one by key without a lookup map. */
export type ManualTouchKind = keyof ManualTouchCounts;

/**
 * Record one manual touch. Also breaks the current hands-free run, which is the whole
 * reason the categories exist.
 */
export function recordManualTouch(stats: WorldStats, kind: ManualTouchKind): void {
  stats.touches[kind] += 1;
  if (stats.ticksSinceManualTouch > stats.longestHandsFreeTicks) {
    stats.longestHandsFreeTicks = stats.ticksSinceManualTouch;
  }
  stats.ticksSinceManualTouch = 0;
}

export function recordEarnings(stats: WorldStats, amountCents: number): void {
  stats.lifetimeEarnedCents += amountCents;
}

export function recordSpend(stats: WorldStats, amountCents: number): void {
  stats.lifetimeSpentCents += amountCents;
}

export function recordWaterDrawn(stats: WorldStats, volumeMl: number): void {
  stats.waterDrawnMl += volumeMl;
}

/**
 * First Ten's stat: lifetime *net* earnings, not cash on hand. Cash on hand rewards
 * stalling; net earnings is un-gameable and neutral to reinvestment (plan §7 ruling 4).
 */
export function lifetimeNetEarningsCents(stats: WorldStats): number {
  return stats.lifetimeEarnedCents - stats.lifetimeSpentCents;
}

export function totalManualTouches(touches: ManualTouchCounts): number {
  return (
    touches.handWater +
    touches.handPlant +
    touches.handHarvest +
    touches.handCarry +
    touches.handRepair +
    touches.jamWhack +
    touches.hopperRefill
  );
}

/** Active hours in hundredths — the leaderboard clock, without a fraction in sight. */
export function centiActiveHoursElapsed(stats: WorldStats): number {
  return divFloor(stats.ticksElapsed * 100, TICKS_PER_ACTIVE_HOUR);
}

/**
 * Dry County's stat: cents of net earnings per kilolitre drawn. Returns 0 before any water
 * has been drawn rather than dividing by zero.
 */
export function centsPerKilolitre(stats: WorldStats): number {
  if (stats.waterDrawnMl <= 0) return 0;
  return divFloor(lifetimeNetEarningsCents(stats) * 1_000_000, stats.waterDrawnMl);
}

/**
 * Peak Flow's input: the best net-worth gain across any window of `windowMinutes`
 * consecutive samples. Read-time only — nothing here mutates state or gets hashed.
 */
export function bestTrailingGainCents(stats: WorldStats, windowMinutes: number): number {
  const samples = stats.netWorthSamples;
  if (samples.length <= windowMinutes || windowMinutes <= 0) return 0;
  let best = 0;
  for (let i = windowMinutes; i < samples.length; i++) {
    const gain = samples[i]! - samples[i - windowMinutes]!;
    if (gain > best) best = gain;
  }
  return best;
}

/** Append a net-worth sample, discarding the oldest once the history is full. */
export function pushNetWorthSample(stats: WorldStats, netWorthCents: number): void {
  stats.netWorthSamples.push(netWorthCents);
  while (stats.netWorthSamples.length > NET_WORTH_SAMPLE_LIMIT) {
    stats.netWorthSamples.shift();
  }
}
