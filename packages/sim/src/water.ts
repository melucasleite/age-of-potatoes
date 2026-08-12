// Reservoirs, and the one place water leaves a source.
//
// PLAN §4, AND BOTH BOLD CLAUSES ARE ANTI-SOFTLOCK GUARANTEES RATHER THAN BALANCE:
//
//   "Reservoirs ~10,000 units recharging ~20 u/min; overdraw is telegraphed (shoreline
//    recedes, mud ring), pumps halve below 25% and sip at recharge rate when empty —
//    **reservoirs always recover**. ... **The watering can always fills at any shore at any
//    level** — hand-scale farming can never be water-starved."
//
// A dry pond is a THROTTLE, never a stop, and never a reason the player cannot play. Do not
// tune either guarantee away for tension; plan §1's floor is "no debt, no softlocks, no
// deleted mornings", and a pond that could strand somebody is a deleted morning.
//
// ONE ACCOUNTING PATH. Every draw in the game — the can, a hand refill of a barrel, a pump
// feeding a network, and anything that arrives later — goes through `takeWater()`, which is
// the only function in this package that decrements a reservoir and the only one that
// increments `stats.waterDrawnMl`. If two code paths could take water, plan §6's Dry County
// board ("$ per kilolitre of water drawn") would already be wrong and nobody would notice
// for months.
//
// NOTHING HERE READS A CLOCK. Recharge accrues per tick inside `step()`, so a pond does not
// refill overnight and a player returning after a week finds it exactly as they left it
// (plan §6: "the economy only simulates while ticks accrue"). That falls out of the
// architecture for free — there is no `Date` in this package and the tsconfig would not
// compile one.

import { RESERVOIR_LOW_PERMILLE, RESERVOIR_RECHARGE_ML_PER_MINUTE } from './data';
import type { Reservoir, WorldState } from './state';
import { recordWaterDrawn } from './stats';
import { TICKS_PER_MINUTE, divFloor, permille } from './units';

/**
 * How a draw is metered.
 *
 * `Metered` is everything with a hose on it: a pump, a barrel being topped up. It gets what
 * the pond can actually give and no more.
 *
 * `Shore` is the watering can, and only the watering can. §4 is explicit and this is the
 * anti-softlock floor: it fills at any shore at any level, including an empty one, where the
 * fiction is that you are scooping the last puddle. The pond still floors at zero — a can
 * never makes a reservoir owe water — but the pour happens and the draw is counted in full,
 * because the honest thing for the Dry County board to measure is the water the player
 * actually used.
 */
export const WaterDraw = {
  Metered: 0,
  Shore: 1,
} as const;

export type WaterDraw = (typeof WaterDraw)[keyof typeof WaterDraw];

/**
 * Take water. THE ONLY WAY WATER LEAVES A SOURCE, AND THE ONLY PLACE `waterDrawnMl` MOVES.
 *
 * Returns the millilitres actually granted, which is what the caller may spend. A `null`
 * reservoir is legal and means "there is no pond here" — a can-scale draw still succeeds
 * (the anti-softlock clause does not depend on a pond existing), and a metered draw gets
 * nothing.
 */
export function takeWater(
  state: WorldState,
  reservoir: Reservoir | null,
  requestMl: number,
  mode: WaterDraw,
): number {
  if (requestMl <= 0) return 0;

  const level = reservoir === null ? 0 : reservoir.levelMl;
  const fromReservoir = requestMl < level ? requestMl : level;
  const granted = mode === WaterDraw.Shore ? requestMl : fromReservoir;

  // Floors at zero by construction: `fromReservoir` is never larger than the level.
  if (reservoir !== null) reservoir.levelMl -= fromReservoir;
  if (granted > 0) recordWaterDrawn(state.stats, granted);

  return granted;
}

/**
 * One tick of recharge on one reservoir.
 *
 * 40,000 ml a minute is 33⅓ ml a tick, so this accrues per-minute units and spends whole
 * millilitres — the same integer accumulator `PlayerState.moveAccum` uses, for the same
 * reason. `Math.round` on a rate would be a float in disguise and would make the pond
 * permanently 1% wrong in one direction or the other.
 */
export function rechargeReservoir(reservoir: Reservoir): void {
  if (reservoir.levelMl >= reservoir.capacityMl) {
    // A full pond banks nothing. Otherwise a long idle spell would fill the accumulator and
    // the first draw would be answered instantly out of stored nothing.
    reservoir.rechargeAccum = 0;
    return;
  }

  reservoir.rechargeAccum += RESERVOIR_RECHARGE_ML_PER_MINUTE;
  const whole = divFloor(reservoir.rechargeAccum, TICKS_PER_MINUTE);
  if (whole <= 0) return;

  reservoir.rechargeAccum -= whole * TICKS_PER_MINUTE;
  reservoir.levelMl += whole;
  if (reservoir.levelMl > reservoir.capacityMl) reservoir.levelMl = reservoir.capacityMl;
}

/** How full a reservoir is, 0..1000. What the shoreline and the mud ring are drawn from. */
export function reservoirLevelPermille(reservoir: Reservoir): number {
  return permille(reservoir.levelMl, reservoir.capacityMl);
}

/** The three bands of §4's throttle curve, as data the HUD and the renderer can badge. */
export const ReservoirThrottle = {
  /** Above 25%. Pumps run at their rated speed. */
  Full: 0,
  /** Below 25%. Pumps run at half. The shoreline has visibly receded by now. */
  Half: 1,
  /** Empty. Pumps sip at the recharge rate — slow, never dead. */
  Sip: 2,
} as const;

export type ReservoirThrottle = (typeof ReservoirThrottle)[keyof typeof ReservoirThrottle];

export function reservoirThrottle(reservoir: Reservoir | null): ReservoirThrottle {
  if (reservoir === null || reservoir.levelMl <= 0) return ReservoirThrottle.Sip;
  if (reservoirLevelPermille(reservoir) < RESERVOIR_LOW_PERMILLE) return ReservoirThrottle.Half;
  return ReservoirThrottle.Full;
}

/**
 * What a pump rated at `baseRateMlPerMinute` may actually draw, given its source's level.
 *
 * §4'S CURVE, EXACTLY: full above 25%, **half below 25%**, and at empty a **sip at the
 * recharge rate**. That last clause is the one that guarantees recovery — a pump at an empty
 * pond is slow, not dead, and it can never take more than the pond makes, so the level can
 * only go up from there the moment demand eases.
 */
export function pumpSupplyMlPerMinute(
  reservoir: Reservoir | null,
  baseRateMlPerMinute: number,
): number {
  if (baseRateMlPerMinute <= 0) return 0;
  switch (reservoirThrottle(reservoir)) {
    case ReservoirThrottle.Sip:
      return reservoir === null ? 0 : RESERVOIR_RECHARGE_ML_PER_MINUTE;
    case ReservoirThrottle.Half:
      return divFloor(baseRateMlPerMinute, 2);
    default:
      return baseRateMlPerMinute;
  }
}

// --- finding a source ---------------------------------------------------------------

export function reservoirById(state: WorldState, id: number): Reservoir | null {
  for (let i = 0; i < state.reservoirs.length; i++) {
    const reservoir = state.reservoirs[i]!;
    if (reservoir.id === id) return reservoir;
  }
  return null;
}

export function reservoirCoversTile(reservoir: Reservoir, tileX: number, tileY: number): boolean {
  return (
    tileX >= reservoir.tileX &&
    tileY >= reservoir.tileY &&
    tileX < reservoir.tileX + reservoir.tilesWide &&
    tileY < reservoir.tileY + reservoir.tilesHigh
  );
}

export function reservoirAt(state: WorldState, tileX: number, tileY: number): Reservoir | null {
  for (let i = 0; i < state.reservoirs.length; i++) {
    const reservoir = state.reservoirs[i]!;
    if (reservoirCoversTile(reservoir, tileX, tileY)) return reservoir;
  }
  return null;
}

/**
 * The reservoir a tile touches, counting its own tile and its four orthogonal neighbours.
 *
 * This is what "standing at the shore" means to the sim: a pump on the bank of the pond is
 * adjacent to water. Lowest id wins if two ponds somehow touch the same tile, which keeps it
 * a total order and therefore deterministic.
 */
export function reservoirAdjacentToTile(
  state: WorldState,
  tileX: number,
  tileY: number,
): Reservoir | null {
  const onTile = reservoirAt(state, tileX, tileY);
  if (onTile !== null) return onTile;

  const north = reservoirAt(state, tileX, tileY - 1);
  const east = reservoirAt(state, tileX + 1, tileY);
  const south = reservoirAt(state, tileX, tileY + 1);
  const west = reservoirAt(state, tileX - 1, tileY);

  let best: Reservoir | null = null;
  const candidates = [north, east, south, west];
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (candidate === null || candidate === undefined) continue;
    if (best === null || candidate.id < best.id) best = candidate;
  }
  return best;
}

/**
 * The reservoir nearest a tile, by squared tile distance to its centre, with the lowest id
 * breaking ties.
 *
 * Used only for the watering can and for hand refills, which do not require the player to be
 * standing on a bank — the fiction is that the Mogul walked to the shore and back, and
 * arguing with them about which pond they used would be the game being pedantic at the one
 * moment plan §2 asks it to be generous.
 */
export function nearestReservoir(
  state: WorldState,
  tileX: number,
  tileY: number,
): Reservoir | null {
  let best: Reservoir | null = null;
  let bestDistance = 0;

  for (let i = 0; i < state.reservoirs.length; i++) {
    const reservoir = state.reservoirs[i]!;
    // Doubled centres, so a footprint with an even span still lands on an integer.
    const centreX2 = reservoir.tileX * 2 + reservoir.tilesWide - 1;
    const centreY2 = reservoir.tileY * 2 + reservoir.tilesHigh - 1;
    const dx = centreX2 - tileX * 2;
    const dy = centreY2 - tileY * 2;
    const distance = dx * dx + dy * dy;
    if (best === null || distance < bestDistance) {
      best = reservoir;
      bestDistance = distance;
    }
  }

  return best;
}
