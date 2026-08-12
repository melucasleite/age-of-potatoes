// The renderer's narrowing seam onto the sim's branded enums.
//
// `WorldView` deliberately hands out `dir` and `tier` as plain `number`, because the
// projection is "plain serializable data" (§12) and a structured clone across a Worker
// boundary would flatten a union to a number anyway. The sim's own helpers, meanwhile, take
// the branded unions.
//
// So the narrowing happens ONCE, here, rather than as a cast at every call site — which is
// the version where somebody eventually casts a tile index to a `Direction` and the compiler
// says nothing. Every function below tolerates a value the sim has never heard of, because a
// save from a newer build is a real thing and a renderer that throws on one is worse than a
// renderer that draws it facing east.

import { BELT_SPECS, Direction, beltSpec, directionStepX, directionStepY } from '@snack/sim';

export function stepX(dir: number): number {
  return directionStepX(dir as Direction);
}

export function stepY(dir: number): number {
  return directionStepY(dir as Direction);
}

/** Belt travel in subtiles per tick, as a plain number. Zero for a tier this build lacks. */
export function beltSubtilesPerTick(tier: number): number {
  const spec = beltSpec(tier as (typeof BELT_SPECS)[number]['tier']);
  return spec === null ? 0 : spec.speedSubtilesPer100Ticks / 100;
}
