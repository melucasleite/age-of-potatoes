// The status lamp: ONE sprite, tinted.
//
// Plan §13 and [[012]] both land on the same design, and for the same reason. Six lamp
// sprites is six chances for the art to disagree with itself about what amber means, and —
// the part that actually bites — status lamps on the machine atlas would either break the
// single-page contract or push machines onto a second page, at which point the belt-item
// particle batch silently draws the wrong frames. A 4px white lamp tinted in code gives
// thirty machines' worth of state animation for the cost of one sprite and cannot do that.
//
// THE TRAP THAT COMES WITH IT: tint is a STATIC property on a `ParticleContainer`. Lamps
// here are ordinary sprites, where tint is a batched vertex attribute and changing it is
// free — but if lamps are ever moved into a particle batch, every tint change needs an
// explicit `container.update()` or the colour simply will not appear, with nothing in the
// console to say so.
//
// The grammar itself is plan §5's, and it is the same grammar on every machine in the game:
// green running, amber starved (look upstream), red blocked (look downstream), blue utility
// missing, red-plus-icon jammed, grey halted.
//
// §16's known gaps list colourblind-safe status as SHAPE variation rather than colour alone.
// That is not solved here. What is solved here is that solving it later means adding one
// overlay glyph per state in one place, not re-cutting six sprites.

import { LampState } from '@snack/sim';

/** Lamp colour per state. The only place these six hexes are written. */
export const LAMP_TINT: Record<number, number> = {
  [LampState.Off]: 0x6b6b6b,
  [LampState.Running]: 0x4bd25f,
  [LampState.Starved]: 0xe8b53d,
  [LampState.Blocked]: 0xe8503d,
  [LampState.UtilityMissing]: 0x4bb6e8,
  [LampState.Jammed]: 0xe8503d,
  [LampState.Halted]: 0x6b6b6b,
};

export function lampTint(lamp: number): number {
  return LAMP_TINT[lamp] ?? LAMP_TINT[LampState.Off]!;
}

/**
 * A slow breathing pulse for the lamps that mean "you are needed".
 *
 * Cosmetic, renderer-local, and derived from wall time rather than the tick — a lamp that
 * throbbed only while the sim advanced would go still exactly when the player most needs to
 * notice it. `Math.sin` is fine here and banned in `packages/sim`; see §12.
 */
export function lampAlpha(lamp: number, nowMs: number): number {
  if (lamp === LampState.Blocked || lamp === LampState.Jammed) {
    return 0.72 + 0.28 * Math.sin(nowMs / 180);
  }
  if (lamp === LampState.Starved || lamp === LampState.UtilityMissing) {
    return 0.78 + 0.22 * Math.sin(nowMs / 420);
  }
  return 1;
}
