// The six boards of plan §6, scored against the only opponent there is: you, last time.
//
// NO SERVER, NO COHORTS, NO REPLAY VALIDATION. Lucas's ruling is a fun, lightly validated
// leaderboard, and work item 033 is explicit that the online half is a separate, later item.
// So this is entirely local, it says so on the panel, and nothing here makes a network call.
// Validating the SCORING MODEL offline is the actual point: getting a stat wrong now costs
// an afternoon, and getting it wrong after worlds have posted scores costs the boards their
// credibility permanently.
//
// EVERY NUMBER COMES FROM THE SIM'S OWN HELPERS. `lifetimeNetEarningsCents()`,
// `bestTrailingGainCents()`, `centsPerKilolitre()` and `longestHandsFreeTicks` are already
// computed inside `WorldState` and already projected through `StatsView`. Nothing below
// recomputes one of them from raw parts — a second definition of a leaderboard stat is how a
// board and a receipt end up disagreeing about the same hour.
//
// THE TWO RULINGS THAT ARE EASY TO GET WRONG, BOTH FROM PLAN §7:
//
//   · FIRST TEN IS LIFETIME NET EARNINGS, NEVER CASH ON HAND (ruling 4). Cash on hand
//     rewarded stalling — a player who sits on their money outscores one who reinvests it,
//     which inverts the entire game. `StatsView.lifetimeNetEarningsCents` is the field;
//     `moneyCents` is the trap, and it is right next to it in the same object.
//   · BOUTIQUE HAS AN ENTRY FLOOR (§6, "entry floor applies"). Peak Flow divided by machine
//     count is topped by a world with one machine, forever, by arithmetic rather than by
//     skill. The floor below is a COMPLETE CHIP LINE — five machines — because that is the
//     smallest thing the board is trying to be about.

import { TICKS_PER_ACTIVE_HOUR, TICKS_PER_SECOND } from '@snack/sim';
import type { WorldView } from '@snack/sim';

import { centsPerActiveHour } from './rate';
import type { BoardRow } from './types';

/** Plan §6's First Ten mark, in hundredths of an active hour. */
export const FIRST_TEN_CENTI_HOURS = 1000;

/** Peak Flow's window: the best trailing five hours, as `view.ts` already projects it. */
const PEAK_FLOW_WINDOW_TICKS = 5 * TICKS_PER_ACTIVE_HOUR;

/**
 * Boutique's entry floor: a complete chip line.
 *
 * Washer, Slicer, Fryer, Seasoner, Bagger. Not an arbitrary number — it is the smallest
 * factory the board is trying to say something about, and below it "revenue per machine" is
 * measuring a lucky potato rather than a design.
 */
export const BOUTIQUE_MIN_MACHINES = 5;

/** Hands-Free's target: plan §6's "seed-to-sold 30 active min with zero manual touches". */
export const HANDS_FREE_TARGET_TICKS = 30 * 60 * TICKS_PER_SECOND;

/** The sell bin, which every world is given for free. See `readBoardValues`. */
const SELL_BIN_KIND = 1;

/** The player's records, across every world. Persisted; see `persist.ts`. */
export interface PersonalBests {
  firstTenCents: number;
  peakFlowCentsPerHour: number;
  dynastyCents: number;
  handsFreeTicks: number;
  boutiqueCentsPerHour: number;
  dryCountyCents: number;
}

export function emptyBests(): PersonalBests {
  return {
    firstTenCents: 0,
    peakFlowCentsPerHour: 0,
    dynastyCents: 0,
    handsFreeTicks: 0,
    boutiqueCentsPerHour: 0,
    dryCountyCents: 0,
  };
}

/** This world's six live figures. Separated from the rows so `foldBests` has one input. */
export interface BoardValues {
  firstTenCents: number;
  peakFlowCentsPerHour: number;
  dynastyCents: number;
  handsFreeTicks: number;
  boutiqueCentsPerHour: number;
  dryCountyCents: number;
  /** Machines that were paid for. The free sell bin does not count — see below. */
  machineCount: number;
  centiActiveHours: number;
  /** 1 once the world has passed the ten-hour mark and First Ten is final. */
  firstTenFinal: number;
}

/**
 * Read the six figures out of one projection.
 *
 * `firstTenFrozenCents` is the value captured the moment the world crossed ten active
 * hours, or −1 before it did. Freezing matters: First Ten is "lifetime net earnings AT ten
 * active hours", so a world that keeps playing must not keep improving its First Ten score
 * — that would make it the Dynasty board with a longer name.
 */
export function readBoardValues(view: WorldView, firstTenFrozenCents: number): BoardValues {
  const stats = view.stats;

  // The sell bin was a gift at world creation (work item 032 calls it exactly that), so it
  // is excluded. Dividing a factory's output by a machine nobody bought is the cheapest way
  // to flatter a small lot, and Boutique is the board where that would matter most.
  let machineCount = 0;
  for (let i = 0; i < view.machines.length; i++) {
    if (view.machines[i]!.kind !== SELL_BIN_KIND) machineCount += 1;
  }

  const peakFlow = centsPerActiveHour(stats.bestTrailingFiveHourGainCents, PEAK_FLOW_WINDOW_TICKS);
  const final = stats.centiActiveHours >= FIRST_TEN_CENTI_HOURS ? 1 : 0;

  return {
    firstTenCents: firstTenFrozenCents >= 0 ? firstTenFrozenCents : stats.lifetimeNetEarningsCents,
    peakFlowCentsPerHour: peakFlow,
    dynastyCents: stats.peakNetWorthCents,
    handsFreeTicks: stats.longestHandsFreeTicks,
    boutiqueCentsPerHour:
      machineCount >= BOUTIQUE_MIN_MACHINES ? Math.floor(peakFlow / machineCount) : 0,
    dryCountyCents: stats.centsPerKilolitre,
    machineCount,
    centiActiveHours: stats.centiActiveHours,
    firstTenFinal: final,
  };
}

/**
 * Fold this world's figures into the player's records. Returns true when a record moved, so
 * the store knows to write to storage — which it otherwise would not do on a timer, because
 * a personal-best board that writes to IndexedDB seven times a second is a personal-best
 * board that eats a frame every so often for no reason.
 *
 * First Ten only counts once it is FINAL. A world four hours in has a large and rising
 * "lifetime net earnings" that is not a First Ten score at all, and letting it set the
 * record would mean the board's best is a number nobody ever scored.
 */
export function foldBests(bests: PersonalBests, values: BoardValues): boolean {
  let moved = false;
  const raise = (key: keyof PersonalBests, candidate: number): void => {
    if (candidate > bests[key]) {
      bests[key] = candidate;
      moved = true;
    }
  };

  if (values.firstTenFinal === 1) raise('firstTenCents', values.firstTenCents);
  raise('peakFlowCentsPerHour', values.peakFlowCentsPerHour);
  raise('dynastyCents', values.dynastyCents);
  raise('handsFreeTicks', values.handsFreeTicks);
  if (values.machineCount >= BOUTIQUE_MIN_MACHINES) {
    raise('boutiqueCentsPerHour', values.boutiqueCentsPerHour);
  }
  raise('dryCountyCents', values.dryCountyCents);
  return moved;
}

/**
 * The six rows, in plan §6's order.
 *
 * Blurbs state what the board MEASURES, not what to do about it. "Fastest half-hour with
 * nobody touching anything" is a description of a record; "automate your line to win
 * Hands-Free" is a quest, and §2 is clear that this game does not issue those.
 */
export function deriveBoards(values: BoardValues, bests: PersonalBests): BoardRow[] {
  const row = (
    id: string,
    label: string,
    blurb: string,
    value: number,
    best: number,
    unit: BoardRow['unit'],
    eligible: boolean,
    gate: string,
  ): BoardRow =>
    Object.freeze({
      id,
      label,
      blurb,
      value,
      best,
      unit,
      eligible: eligible ? 1 : 0,
      gate,
      fresh: eligible && value > 0 && value >= best ? 1 : 0,
    });

  const tenHoursIn = values.firstTenFinal === 1;

  return [
    row(
      'first-ten',
      'First Ten',
      'Everything you earned, less everything you spent, at ten active hours.',
      values.firstTenCents,
      bests.firstTenCents,
      'cents',
      tenHoursIn,
      tenHoursIn ? '' : 'running · scored at 10.00 h',
    ),
    row(
      'peak-flow',
      'Peak Flow',
      'The best five hours you ever had, as a rate.',
      values.peakFlowCentsPerHour,
      bests.peakFlowCentsPerHour,
      'perHour',
      values.peakFlowCentsPerHour > 0,
      values.peakFlowCentsPerHour > 0 ? '' : 'needs five hours of history',
    ),
    row(
      'dynasty',
      'Dynasty',
      'The most the lot was ever worth — cash, stock, and machines together.',
      values.dynastyCents,
      bests.dynastyCents,
      'cents',
      true,
      '',
    ),
    row(
      'hands-free',
      'Hands-Free',
      'Your longest stretch with nobody touching anything.',
      values.handsFreeTicks,
      bests.handsFreeTicks,
      'ticks',
      true,
      values.handsFreeTicks >= HANDS_FREE_TARGET_TICKS ? '' : 'thirty minutes is the mark',
    ),
    row(
      'boutique',
      'Boutique',
      'Peak Flow divided between the machines that earned it.',
      values.boutiqueCentsPerHour,
      bests.boutiqueCentsPerHour,
      'perHour',
      values.machineCount >= BOUTIQUE_MIN_MACHINES,
      values.machineCount >= BOUTIQUE_MIN_MACHINES
        ? ''
        : `entry floor · ${values.machineCount} of ${BOUTIQUE_MIN_MACHINES} machines`,
    ),
    row(
      'dry-county',
      'Dry County',
      'What a kilolitre of water was worth by the time it left the lot.',
      values.dryCountyCents,
      bests.dryCountyCents,
      'cents',
      values.dryCountyCents > 0,
      values.dryCountyCents > 0 ? '' : 'no water drawn yet',
    ),
  ];
}
