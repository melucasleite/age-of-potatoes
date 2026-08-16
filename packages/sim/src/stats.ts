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

import { type ItemId, NET_WORTH_SAMPLE_LIMIT } from './data';
import { DAWN_TICK_IN_DAY, TICKS_PER_ACTIVE_HOUR, dawnCount, divFloor } from './units';

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

/**
 * Lifetime sales of one item id, plus a snapshot of both accumulators taken at the most
 * recent dawn.
 *
 * MONOTONE ACCUMULATORS AND SNAPSHOTS OF THEM, NEVER A SECOND COUNT. "Today's sales" is
 * `units - unitsAtDawn`, computed at read time in the projection — a `dayUnits` that was
 * incremented beside `units` would be the independent counting this file's discipline exists
 * to rule out, and the two would drift the first time one code path forgot the other.
 *
 * Rows are SPARSE (an item never sold has no row) and SORTED ascending by `item`, which is
 * what makes the list hashable: same sales, same bytes, regardless of sale order.
 */
export interface ItemSales {
  item: ItemId;
  /** Lifetime units sold. */
  units: number;
  /** Lifetime gross, in cents. A subset of `lifetimeEarnedCents`, never a second ledger. */
  cents: number;
  /** `units` as it stood at the most recent dawn. Today's count telescopes from it. */
  unitsAtDawn: number;
  centsAtDawn: number;
}

/**
 * The open hour's starting line: the tick it opened on and every lifetime accumulator as it
 * stood at that moment. A closed bucket is *now minus the mark* — differences of monotone
 * accumulators, exactly the arithmetic `apps/web/src/reports/shift.ts` documents, moved to
 * the only home where it can be hashed.
 */
export interface HourMark {
  /** The dawn-aligned hour index the world is currently inside. See `hourIndexAt`. */
  hour: number;
  /** The tick the hour opened (or the world began). */
  tick: number;
  earnedCents: number;
  spentCents: number;
  waterMl: number;
  itemsSold: number;
  inputsWasted: number;
  itemsProduced: number;
}

/** One closed hour, stored as the telescoped differences. Oldest first, capped. */
export interface ClosedHour {
  hour: number;
  /** How long the hour really was: `TICKS_PER_ACTIVE_HOUR`, except the short dawn-birth hour 0. */
  ticks: number;
  grossCents: number;
  spendCents: number;
  waterMl: number;
  itemsSold: number;
  inputsWasted: number;
  itemsProduced: number;
}

/**
 * Closed hours retained. The same cap as the Shift Report's strip
 * (`SHIFT_HISTORY_LIMIT` in `apps/web/src/reports/shift.ts`), for the same reason as
 * `NET_WORTH_SAMPLE_LIMIT`: an unbounded array in a persisted payload is how a local-first
 * game grows a 40 MB save one quiet afternoon at a time.
 */
export const HOUR_HISTORY_LIMIT = 24;

/**
 * Which hour bucket a tick falls in — DAWN-ALIGNED, per item 062.
 *
 * Hour boundaries sit at `DAWN_TICK_IN_DAY + k × TICKS_PER_ACTIVE_HOUR`, so every boundary
 * after the first sits where a boundary would if the world had been born at dawn. Hour 0 is
 * therefore SHORT — the 8,400 ticks between 09:00 and the first 06:00 — and every later hour
 * is a full `TICKS_PER_ACTIVE_HOUR`. The Shift Report's adopt branch treats a bucket shorter
 * than a full hour as "in progress", so the short birth hour never appears in its strip; it
 * still exists in the hashed history, because the money it contains has to telescope.
 */
export function hourIndexAt(tick: number): number {
  if (tick < DAWN_TICK_IN_DAY) return 0;
  return divFloor(tick - DAWN_TICK_IN_DAY, TICKS_PER_ACTIVE_HOUR) + 1;
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

  /**
   * Gross that left the lot on a cart or a truck rather than in the player's hands, in cents.
   *
   * A SUBSET OF `lifetimeEarnedCents`, NEVER A SECOND LEDGER. Every delivery adds to both, in
   * one function (`payForDelivery` in `commerce.ts`), for the same reason `repairKitSpendCents`
   * sits beside `lifetimeSpentCents` rather than replacing part of it: the total has to stay the
   * total, and the question this answers — how much of my income do I no longer carry by hand —
   * is not one you can ask a single number. The Dispatch panel's header is read off it.
   */
  automatedGrossCents: number;

  /**
   * Inputs a worn machine swallowed and produced nothing from. The Shift Report's waste row
   * (plan §6) reads this, and it is the number that makes neglect cost margin rather than
   * progress — the potato is gone, the line is not.
   */
  inputsWastedByMachine: number;
  /** Repair kits actually used. One per `UseRepairKit`, however many machines it serviced. */
  repairKitsUsed: number;
  /**
   * Cents spent on repair kits, counted at the till rather than at the machine.
   *
   * Separate from `lifetimeSpentCents` rather than derived from it: plan §4 wants kit spend
   * held near 5% of value added, and that is not a question you can answer from one total
   * that also contains every machine, seed, and belt the player has ever bought.
   */
  repairKitSpendCents: number;

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

  /**
   * The best `Machine.untouchedTicks` any machine on this lot has ever reached — the demonstrated
   * half of the Corporate Charter's gate (plan §3: *"one line untouched for 10 in-game days"*).
   *
   * A HIGH-WATER MARK, LIKE `longestHandsFreeTicks` BESIDE IT, and for the reason set out on
   * `MilestoneKind.UntouchedLine`: demonstrated is demonstrated. A live maximum would let the
   * gate close again between the achievement and the money — refill one hopper on the walk to the
   * tech panel and the ten days you just proved would be gone — which reads as a bug rather than
   * as a rule.
   *
   * NOT THE SAME QUESTION AS HANDS-FREE, which is why it is a second number rather than a reading
   * of the first. Hands-Free counts ticks since the player touched *anything*, and nothing in
   * this game harvests a crop for you, so a farmer who is still farming can never post ten days
   * of it. This one asks a narrower question the factory can actually answer: did one machine
   * keep working, fed and emptied, while you were somewhere else.
   */
  longestUntouchedMachineTicks: number;

  touches: ManualTouchCounts;

  /**
   * Lifetime sales per item id, sparse and sorted ascending by `item` (item 062). Fed only by
   * `recordSale`, which is the one door every sale in the game already walks through — a row
   * here is always a subset of `lifetimeEarnedCents` and `itemsSold`, never a second ledger.
   */
  salesByItem: ItemSales[];

  /**
   * Lifetime count of cheat commands that took effect (item 075). HASHED, like every other
   * accumulator here, and for the same one-way-door reason: the boards are "fun, lightly
   * validated" (locked decisions), and the honest way to keep them fun is for a world that
   * typed `klapaucius` to carry the fact in its hash — so a personal best or a future
   * leaderboard can annotate rather than adjudicate. Refused (unknown) codes count nothing,
   * because they changed nothing and never entered the trace.
   */
  cheatsUsed: number;

  /** Closed dawn-aligned hours, oldest first, capped at `HOUR_HISTORY_LIMIT`. */
  hours: ClosedHour[];

  /** The open hour's starting line. See `HourMark`. */
  hourMark: HourMark;

  /**
   * How many dawns this world had seen at the last daily reset of `salesByItem`'s snapshots.
   * A monotone counter compared against `dawnCount(tick)` rather than an equality test on the
   * dawn tick, for the same reason the Dawn Report fires on the change of that number: a
   * counter cannot be missed.
   */
  dawnsSeen: number;
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
    automatedGrossCents: 0,
    inputsWastedByMachine: 0,
    repairKitsUsed: 0,
    repairKitSpendCents: 0,
    netWorthCents: 0,
    peakNetWorthCents: 0,
    netWorthSamples: [],
    nextNetWorthSampleTick: 0,
    ticksSinceManualTouch: 0,
    longestHandsFreeTicks: 0,
    longestUntouchedMachineTicks: 0,
    touches: createManualTouchCounts(),
    salesByItem: [],
    cheatsUsed: 0,
    hours: [],
    hourMark: createHourMark(0, 0),
    dawnsSeen: 0,
  };
}

/** A fresh starting line for the hour that opens at `tick`, copied from `stats` if given. */
export function createHourMark(hour: number, tick: number, stats?: WorldStats): HourMark {
  return {
    hour,
    tick,
    earnedCents: stats === undefined ? 0 : stats.lifetimeEarnedCents,
    spentCents: stats === undefined ? 0 : stats.lifetimeSpentCents,
    waterMl: stats === undefined ? 0 : stats.waterDrawnMl,
    itemsSold: stats === undefined ? 0 : stats.itemsSold,
    inputsWasted: stats === undefined ? 0 : stats.inputsWastedByMachine,
    itemsProduced: stats === undefined ? 0 : stats.itemsProducedByMachine,
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

/**
 * Credit one sale: money already moved, this is the ledger. THE ONLY WRITER OF `salesByItem`,
 * and it also owns `recordEarnings` and `itemsSold` for its callers — `applySellItem` and
 * `payForDelivery` both route here, so the per-item rows, the gross, and the unit count can
 * never move separately (item 062: incremented at the single point sales credit money).
 */
export function recordSale(
  stats: WorldStats,
  item: ItemId,
  count: number,
  grossCents: number,
): void {
  recordEarnings(stats, grossCents);
  stats.itemsSold += count;

  const rows = stats.salesByItem;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.item === item) {
      row.units += count;
      row.cents += grossCents;
      return;
    }
    if (row.item > item) {
      // Insert in ascending item order, so the hashed list is a function of what was sold and
      // never of the order it sold in.
      rows.splice(i, 0, { item, units: count, cents: grossCents, unitsAtDawn: 0, centsAtDawn: 0 });
      return;
    }
  }
  rows.push({ item, units: count, cents: grossCents, unitsAtDawn: 0, centsAtDawn: 0 });
}

/**
 * The hour ledger's and the daily snapshot's one writer, run once per tick from
 * `advanceStats` (before the world clock increments, so a boundary tick's activity lands in
 * the hour that owned the tick).
 *
 * Closing an hour is *now minus the mark* — differences of the monotone lifetime
 * accumulators, so the buckets telescope exactly however the cadence lands. Crossing a dawn
 * snapshots `salesByItem`, which is what makes "sold today" a subtraction at read time.
 */
export function advanceStatsClock(stats: WorldStats, tick: number): void {
  const hour = hourIndexAt(tick);
  if (hour > stats.hourMark.hour) {
    const mark = stats.hourMark;
    stats.hours.push({
      hour: mark.hour,
      ticks: tick - mark.tick,
      grossCents: stats.lifetimeEarnedCents - mark.earnedCents,
      spendCents: stats.lifetimeSpentCents - mark.spentCents,
      waterMl: stats.waterDrawnMl - mark.waterMl,
      itemsSold: stats.itemsSold - mark.itemsSold,
      inputsWasted: stats.inputsWastedByMachine - mark.inputsWasted,
      itemsProduced: stats.itemsProducedByMachine - mark.itemsProduced,
    });
    while (stats.hours.length > HOUR_HISTORY_LIMIT) stats.hours.shift();
    stats.hourMark = createHourMark(hour, tick, stats);
  }

  const dawns = dawnCount(tick);
  if (dawns > stats.dawnsSeen) {
    stats.dawnsSeen = dawns;
    for (let i = 0; i < stats.salesByItem.length; i++) {
      const row = stats.salesByItem[i]!;
      row.unitsAtDawn = row.units;
      row.centsAtDawn = row.cents;
    }
  }
}

export function recordSpend(stats: WorldStats, amountCents: number): void {
  stats.lifetimeSpentCents += amountCents;
}

/**
 * Undo a spend — picking a belt back up, scrapping a machine.
 *
 * Deliberately NOT `recordEarnings`. Lifetime net earnings is First Ten's stat, and a
 * player who buys and re-sells the same belt a thousand times must land exactly where they
 * started rather than farming the board with a mouse.
 */
export function recordRefund(stats: WorldStats, amountCents: number): void {
  stats.lifetimeSpentCents -= amountCents;
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
