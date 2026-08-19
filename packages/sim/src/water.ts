// Reservoirs, and the one place water leaves a source.
//
// ────────────────────────────────────────────────────────────────────────────────────────
// **THE POND NEVER RUNS DRY** (item 140; owner ruling 2026-08-17, verbatim: *"I want the ponds
// to have infinite water. Get rid of the artisan well and just have the pond have an unlimited
// supply of water."*).
//
// A reservoir is now geometry and an id. It has no level, no capacity and no recharge, so there
// is no state in it that a draw could move and none that could ever be low. Plan §4's throttle
// curve — halve below 25%, sip at the recharge rate when empty, "reservoirs always recover" — is
// gone entire, because every clause of it was a way of managing a scarcity that no longer exists.
// So is the Artesian Well, which was the machine invented to relieve it.
//
// **INFINITE SOURCE, FINITE THROUGHPUT.** The pump still has a rate. That is the ruling and it is
// deliberate: it keeps networks, sizing and tanks meaningful and deletes only the scarcity. A
// pump is still a straw; there is simply no longer a bottom to the glass.
// ────────────────────────────────────────────────────────────────────────────────────────
//
// **THE ONE LEDGER, IN ITS NEW FORM. `takeWater()` IS STILL THE ONLY DOOR WATER COMES THROUGH,
// AND STILL THE ONLY PLACE `stats.waterDrawnMl` MOVES.** What it stopped being is a withdrawal.
// The old invariant had two halves — a pond's level fell by exactly what was granted, and the
// meter rose by exactly what was granted — and the first half described a stock that is gone. The
// second half is untouched and is now the whole of it:
//
//     every millilitre that enters the world passes through `takeWater` and is counted once.
//
// Everything downstream is unchanged, which is the point of leaving the door where it was: a
// network still books `drawn = delivered + buffered`, `spentMl + heldMl` still equals
// `waterDrawnMl` across a whole world, and plan §6's Dry County board ("$ per kilolitre of water
// drawn") still measures a real quantity. What can no longer happen is a draw being SHORT because
// the source was empty — only because there was no source (see `WaterDraw`).
//
// NOTHING HERE READS A CLOCK, and now nothing here accrues one either. The recharge accumulator
// was the last per-tick arithmetic in this file; a pond does not refill overnight because a pond
// does not refill at all.

import type { Reservoir, WorldState } from './state';
import { recordWaterDrawn } from './stats';
import { SUBTILE, clampInt, divFloor } from './units';

/**
 * How a draw is metered.
 *
 * **THE DISTINCTION SURVIVED THE INFINITE POND, BUT ITS MEANING MOVED** (item 140). It used to be
 * "what the pond can actually give" against "the can fills at any shore at any level, including
 * an empty one". There are no empty ponds now, so what is left is the deeper half of §4's
 * anti-softlock clause: a hose needs a source and a hand does not.
 *
 * `Metered` is everything with a hose on it: a pump, a barrel being topped up. It draws from a
 * reservoir, and from nowhere else — a pump that is not standing on a bank (which placement
 * refuses, and a hand-edited save can still present) gets nothing rather than free water.
 *
 * `Shore` is the watering can, and only the watering can. It always fills, including in a world
 * that has no water in it at all, where the fiction is that the Mogul found a puddle. The draw is
 * counted in full either way, because the honest thing for the Dry County board to measure is the
 * water the player actually used.
 */
export const WaterDraw = {
  Metered: 0,
  Shore: 1,
} as const;

export type WaterDraw = (typeof WaterDraw)[keyof typeof WaterDraw];

/**
 * Take water. THE ONLY WAY WATER ENTERS THE WORLD, AND THE ONLY PLACE `waterDrawnMl` MOVES.
 *
 * Returns the millilitres granted, which is what the caller may spend. Since item 140 a pond is
 * an unlimited source, so a metered draw against a real reservoir is granted IN FULL and the only
 * short answer left is zero — a metered draw with no reservoir at all. A `null` reservoir is
 * legal and means "there is no pond here".
 *
 * **IT STILL EXISTS, AND IT MUST.** A one-line `granted = requestMl` at each call site would be
 * the same arithmetic and would quietly delete the meter, and with it the one property this file
 * is arranged around: if two code paths could take water, plan §6's Dry County board would be
 * wrong and nobody would notice for months.
 */
export function takeWater(
  state: WorldState,
  reservoir: Reservoir | null,
  requestMl: number,
  mode: WaterDraw,
): number {
  if (requestMl <= 0) return 0;

  const granted = mode === WaterDraw.Shore || reservoir !== null ? requestMl : 0;
  if (granted > 0) recordWaterDrawn(state.stats, granted);

  return granted;
}

/**
 * What a pump rated at `baseRateMlPerMinute` may actually draw from `reservoir`.
 *
 * **THE THROUGHPUT HALF OF ITEM 140'S RULING, AND THE ONLY NUMBER LEFT BETWEEN THE MAP AND THE
 * PIPES.** The source is unlimited; the straw is not. So a pump on a bank draws exactly what it
 * is rated for, every tick, forever — no 25% band, no half rate, no sip — and a pump standing on
 * dry land draws nothing, which is the same refusal `WaterDraw.Metered` states one level down.
 *
 * Two answers rather than one, which is why this is still a function: "how much water can this
 * pump have" now has exactly one interesting input, and that input is whether it is at the water.
 */
export function pumpSupplyMlPerMinute(
  reservoir: Reservoir | null,
  baseRateMlPerMinute: number,
): number {
  if (reservoir === null || baseRateMlPerMinute <= 0) return 0;
  return baseRateMlPerMinute;
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
 * Whether a subtile position stands on open water — the movement layer's one question.
 *
 * THE PREDICATE ITEM 080 FEEDS TO `stepToward` AND TO THE WASD CLAMP: nobody walks on water.
 * A position's legality is a fact about the TILE under it, so the shoreline sits exactly at
 * the tile boundary — the last dry subtile is standable and the first wet one is not, which
 * is what keeps `reservoirWithinReach` (a reach-radius question) able to put the refill
 * within arm's length of a farmer standing on the bank.
 */
export function waterAtSubtile(state: WorldState, xSub: number, ySub: number): boolean {
  return reservoirAt(state, divFloor(xSub, SUBTILE), divFloor(ySub, SUBTILE)) !== null;
}

/** The point of a reservoir's footprint nearest to a position, in subtiles. */
export function nearestPointOfReservoir(
  reservoir: Reservoir,
  xSub: number,
  ySub: number,
): { xSub: number; ySub: number } {
  const minX = reservoir.tileX * SUBTILE;
  const maxX = (reservoir.tileX + reservoir.tilesWide) * SUBTILE - 1;
  const minY = reservoir.tileY * SUBTILE;
  const maxY = (reservoir.tileY + reservoir.tilesHigh) * SUBTILE - 1;
  return { xSub: clampInt(xSub, minX, maxX), ySub: clampInt(ySub, minY, maxY) };
}

/**
 * The reservoir whose water is within `reachSub` subtiles of a position, or null.
 *
 * REACH-BASED, LIKE EVERY OTHER HAND VERB, and this is what "standing at the shore" means to
 * `RefillCan`: the same arm that can water a tile can dip a can. A tile-adjacency test here
 * would make the refill stricter than the pour, and the walk-to errand — which arrives
 * "within reach" like every errand does — would stop a step short of a shore it could
 * already touch. Lowest id breaks ties, keeping it a total order and therefore deterministic.
 */
export function reservoirWithinReach(
  state: WorldState,
  xSub: number,
  ySub: number,
  reachSub: number,
): Reservoir | null {
  let best: Reservoir | null = null;
  let bestDistance = 0;
  for (let i = 0; i < state.reservoirs.length; i++) {
    const reservoir = state.reservoirs[i]!;
    const point = nearestPointOfReservoir(reservoir, xSub, ySub);
    const dx = point.xSub - xSub;
    const dy = point.ySub - ySub;
    const distance = dx * dx + dy * dy;
    if (distance > reachSub * reachSub) continue;
    if (best === null || distance < bestDistance) {
      best = reservoir;
      bestDistance = distance;
    }
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
