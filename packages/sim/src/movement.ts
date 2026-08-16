// Straight-line travel, in integer subtiles. **THE ONLY MOVER IN THIS SIMULATION.**
//
// ────────────────────────────────────────────────────────────────────────────────────────
// THIS FILE EXISTS BECAUSE ITEM 039 REQUIRES ITS DRONES TO REUSE THE AGRI-BOT MOVEMENT CODE
// VERBATIM, AND "VERBATIM" IS ONLY A THING YOU CAN PROMISE ABOUT CODE THAT LIVES IN ONE PLACE.
//
// There were two honest ways to arrive here and the choice is worth recording, because the
// wrong one is the one that looks cheaper:
//
//   (a) Write a bot mover beside the player's errand walk in `tick.ts` and keep them in step by
//       remembering to. That is two implementations of "how far does a thing get this tick",
//       which is the exact shape of the accumulator bug this codebase spends `moveAccum` to
//       avoid — and a drone written against one of them in six months would inherit whichever
//       copy the author happened to read.
//
//   (b) GENERALISE THE WALK THAT ALREADY EXISTED, which is what happened. `advanceErrand` in
//       `tick.ts` had carried the whole thing since v0.1: accrue speed into a hundredths
//       accumulator, spend whole subtiles, aim straight at the target, clamp to the world, face
//       the dominant axis. Nothing about any of that was about the player — it was about a thing
//       with a position that wants to be somewhere else. So it moved here, the errand calls it,
//       the bots call it, and item 039's drones will call it without a line of new movement code.
//
// The arithmetic did not change when it moved, deliberately: the operations happen in the same
// order they did when the player was the only caller, so a replay of a pre-bot world walks the
// farmer over exactly the same subtiles.
// ────────────────────────────────────────────────────────────────────────────────────────
//
// **NO PATHFINDING, AND THAT IS A DECISION RATHER THAN A GAP.** Almost nothing in this world is
// solid enough to walk into — the farmer strolls over belts, pipes and machines alike — and
// item 038's constraint says it plainly: keep it dumb, integer, deterministic; no float
// distances, no `Math.sqrt` heuristics, no dynamic avoidance. Item 080 delivered the first
// blocked footstep (open water), and it landed exactly where this header promised: an optional
// `blockedAt` predicate on `stepToward`, every mover in the game at once. What it grew is a
// STOP, not a path — the walk halts at the obstacle's edge and the caller decides what the
// errand does about it, because the no-pathing doctrine (item 050) still stands.

import { WORLD_TILES_HIGH, WORLD_TILES_WIDE } from './data';
import { Direction } from './state';
import { SUBTILE, clampInt, divFloor } from './units';

/**
 * Anything with a position that walks. The player and every bot satisfy this structurally, so
 * neither had to be reshaped to use it and nothing here can reach a field it has no business in.
 */
export interface Mover {
  /** Position in subtiles. */
  xSub: number;
  ySub: number;
  /** Sub-subtile remainder, in hundredths. Spent whole here, never rounded. */
  moveAccum: number;
  /** Set to the dominant axis of travel each step. Cosmetic to the sim, load-bearing to the art. */
  facing: Direction;
}

/**
 * How one tick's worth of walking ended. `Blocked` exists since item 080, when open water
 * became the first solid thing in this world — see `stepToward`'s note on it.
 */
export const StepOutcome = {
  /** Took a step (or banked one) and is still on the way. */
  Walking: 0,
  /** Standing exactly on the target. */
  Arrived: 1,
  /** The step would have landed on blocked ground; the mover stayed put. */
  Blocked: 2,
} as const;

export type StepOutcome = (typeof StepOutcome)[keyof typeof StepOutcome];

/**
 * Take one tick's worth of steps toward a point, and say how it went.
 *
 * `speedPer100Ticks` is in subtiles per hundred ticks, which is how every rate in this game that
 * does not divide evenly is expressed: 4 tiles/s at 20 Hz is 51.2 subtiles a tick, and rounding
 * that to 51 would quietly make the walker 0.4% slow forever. The remainder lives in `moveAccum`.
 *
 * Returns `Arrived` when the mover is standing on the target. Callers that want a reach radius
 * rather than an exact landing should test `distanceSquaredSubtiles` themselves BEFORE calling —
 * the player's errand does exactly that, because arriving is a question about the verb's reach
 * and not about the walk.
 *
 * **`blockedAt` IS THE FOOTSTEP FINALLY BLOCKED** (item 080; the header's promise kept: one
 * function, every mover at once). When the tick's step would LAND on ground the predicate
 * refuses — open water, today and only — the mover stays exactly where it was and the outcome
 * is `Blocked`. The walk stops at the edge; nothing routes around anything, because the
 * no-pathing doctrine (item 050) stands: water is an obstacle, not a routing problem. Two
 * deliberate softenings: a mover already standing on blocked ground (a legacy save on the
 * pond) may step freely so it can walk off rather than being trapped, and a mover given no
 * predicate (the flying repair drone) never blocks at all. The arithmetic below is untouched
 * when the predicate stays quiet, so every recorded walk that never crossed water replays over
 * exactly the same subtiles.
 */
export function stepToward(
  mover: Mover,
  targetXSub: number,
  targetYSub: number,
  speedPer100Ticks: number,
  blockedAt?: (xSub: number, ySub: number) => boolean,
): StepOutcome {
  mover.moveAccum += speedPer100Ticks;
  const budget = divFloor(mover.moveAccum, 100);
  mover.moveAccum -= budget * 100;
  if (budget <= 0) {
    return mover.xSub === targetXSub && mover.ySub === targetYSub
      ? StepOutcome.Arrived
      : StepOutcome.Walking;
  }

  const dx = targetXSub - mover.xSub;
  const dy = targetYSub - mover.ySub;
  const fromXSub = mover.xSub;
  const fromYSub = mover.ySub;

  // `sqrt` is the ONE non-trivial float operation the determinism rules allow, because IEEE-754
  // requires it to be correctly rounded — every engine returns the same bits. The truncations
  // either side keep it out of world state: what gets stored is always an integer number of
  // subtiles, so the walk can be replayed a decade from now.
  const distance = Math.trunc(Math.sqrt(dx * dx + dy * dy));
  let arrived = false;
  if (distance <= budget) {
    mover.xSub = targetXSub;
    mover.ySub = targetYSub;
    arrived = true;
  } else {
    mover.xSub += Math.trunc((dx * budget) / distance);
    mover.ySub += Math.trunc((dy * budget) / distance);
  }

  mover.xSub = clampInt(mover.xSub, 0, WORLD_TILES_WIDE * SUBTILE - 1);
  mover.ySub = clampInt(mover.ySub, 0, WORLD_TILES_HIGH * SUBTILE - 1);

  // Face the way you are going. The sprite has no idea what an errand or a route is; it wants a
  // compass direction, and the dominant axis is the one a person would say they were walking.
  // Set before the blocked check on purpose: a mover pressing against the shore faces the water
  // it cannot enter, exactly as a walker pressed against the world edge faces out.
  if (dx * dx >= dy * dy) {
    mover.facing = dx >= 0 ? Direction.East : Direction.West;
  } else {
    mover.facing = dy >= 0 ? Direction.South : Direction.North;
  }

  if (
    blockedAt !== undefined &&
    blockedAt(mover.xSub, mover.ySub) &&
    !blockedAt(fromXSub, fromYSub)
  ) {
    mover.xSub = fromXSub;
    mover.ySub = fromYSub;
    return StepOutcome.Blocked;
  }

  return arrived ? StepOutcome.Arrived : StepOutcome.Walking;
}

/** Drop a mover's banked remainder. A thing that stopped walking is not mid-stride. */
export function resetMomentum(mover: Mover): void {
  mover.moveAccum = 0;
}
