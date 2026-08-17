// The status lamp: SEVEN shapes, each tinted. Shape carries the state; colour reinforces it.
//
// ── WHAT CHANGED FROM ONE SPRITE TO SEVEN, AND WHY THE OLD ARGUMENT STILL HOLDS ─────────
//
// This file used to say "ONE sprite, tinted", and §13's reasoning for that was right about
// everything except the player. One 4px bead multiplied by a lamp colour genuinely does buy
// thirty machines' worth of state animation for the cost of one frame, and genuinely does keep
// status lamps off the machine atlas page — where they would either break the single-page
// contract or push the machines onto a second page, at which point the belt-item particle
// batch silently draws the wrong frames.
//
// None of that changes here. Seven 7x7 frames is 343 pixels; they share the atlas page every
// other frame shares, the tint is still applied in code, and the draw is still one ordinary
// sprite per machine. What changes is that the sprite now has a SHAPE.
//
// ── WHY IT HAD TO ──────────────────────────────────────────────────────────────────────
//
// §16 lists colourblind-safe machine status as a known gap and specifies the fix: lamp SHAPE
// variation, not colour alone, "on a deliberately warm limited palette". The palette is what
// makes it urgent rather than nice-to-have. `lamp_starved` (#f2a93b) and `red_bright`
// (#d94f36) are NEIGHBOURS by design, because a warm limited palette is the look — and a
// player with deuteranopia sees them as very nearly the same colour. Under greyscale, which is
// the honest worst case, the old lamp gave exactly zero bits: one bead at seven luminances,
// two pairs of which were the same hex.
//
// Now the amber triangle points up and the red bar lies flat, and neither the palette nor the
// grammar had to be reopened to get there.
//
// ── THE GRAMMAR IS §5'S AND IS NOT TOUCHED ─────────────────────────────────────────────
//
// Green running / amber starved (look upstream) / red blocked (look downstream) / blue utility
// missing / red-plus-icon jammed / grey halted. Note what that means for Blocked and Jammed:
// §5 says jammed IS the red blocked lamp with its own icon, so they still share a hue on
// purpose. Splitting them by inventing an eighth colour would be solving a shape problem with
// colour, which is the mistake this file exists to undo — a bar and a saltire are not
// confusable under any simulation, and that is where the distinction belongs.
//
// ── THE TRAP THAT CAME WITH THE OLD DESIGN AND HAS NOT GONE AWAY ───────────────────────
//
// Tint is a STATIC property on a `ParticleContainer`. Lamps here are ordinary sprites, where
// tint is a batched vertex attribute and changing it is free — but if lamps are ever moved into
// a particle batch, every tint change needs an explicit `container.update()` or the colour
// simply will not appear, with nothing in the console to say so.

import { LampState } from '@snack/sim';

import { overPaper } from './tint';

/**
 * Source pixels per side. All seven frames are this, so a lamp never moves as its state does.
 *
 * DOUBLED WITH `TILE_PX` 16 → 32. The lamp is a decal on a machine body, so it is sized
 * relative to the tile, not to the screen: left at 7 it would have gone on being seven real
 * pixels while the machine under it doubled, i.e. half the apparent size it has always had —
 * on the one sprite §16 calls an accessibility floor.
 *
 * TWO CONSUMERS OUTSIDE THIS FILE READ IT AS A CANVAS SIZE. Both are handled, and neither
 * needed its FIGURE redrawn — worth stating, because the obvious reading of "the frame
 * doubled" is that the shape inside it must be redrawn twice as large, and here it must not:
 *   · `textures.ts` `registerLampPlaceholders` derives `LAMP_PAINT_PX = LAMP_PX / BAKE_SCALE`
 *     (= 7) and paints its 5×5 mask unchanged in the painters' 16-space, which the shared
 *     bake scaler then blows up to the full 14. Doubling the mask by hand would have doubled
 *     it twice. Grey-box builds only, but that is the build with no atlas at all.
 *   · `art/tools/make-status-lamp.mjs` bakes the shipped seven at its own `SCALE`, so the
 *     atlas frames arrive already 14 and this constant simply agrees with them.
 */
export const LAMP_PX = 14;

/**
 * Frame name per state — the shape half of the grammar.
 *
 * `Record<LampState, string>` and not `Record<number, string>`: TypeScript then fails the build
 * the day the sim adds an eighth state, which is exactly the day somebody would otherwise ship
 * a lamp that silently falls back to the "off" dot.
 */
export const LAMP_FRAME: Record<LampState, string> = {
  [LampState.Off]: 'lamp_off',
  [LampState.Running]: 'lamp_running',
  [LampState.Starved]: 'lamp_starved',
  [LampState.Blocked]: 'lamp_blocked',
  [LampState.UtilityMissing]: 'lamp_utility',
  [LampState.Jammed]: 'lamp_jammed',
  [LampState.Halted]: 'lamp_halted',
};

export function lampFrame(lamp: number): string {
  return LAMP_FRAME[lamp as LampState] ?? LAMP_FRAME[LampState.Off];
}

/**
 * Lamp colour per state — the colour half, and the only place these seven are written.
 *
 * Each is the master palette's own swatch for that status role, divided by `paper` so that
 * what lands on screen IS the swatch rather than the swatch multiplied by the sprite (see
 * `tint.ts`). The hexes below are quoted from `art/palette/master.json`, where each carries the
 * readability note that justifies it — `red_bright`'s says "chosen to survive as 3-4 pixels on
 * soil_mid or metal_mid", which is a promise only kept if the pixel really is that colour.
 *
 * Off and Halted are both grey, per §5, at two values: Off is the dimmer, because it means "no
 * work cycle" on a decorative object and should recede, while Halted means a machine the player
 * has to go and deal with.
 */
export const LAMP_TINT: Record<number, number> = {
  [LampState.Off]: overPaper(0x6d5c4d), // stone_mid
  [LampState.Running]: overPaper(0x5fd44a), // lamp_running
  [LampState.Starved]: overPaper(0xf2a93b), // lamp_starved
  [LampState.Blocked]: overPaper(0xd94f36), // red_bright
  [LampState.UtilityMissing]: overPaper(0x4fa3d1), // water_bright
  [LampState.Jammed]: overPaper(0xd94f36), // red_bright — §5: jammed IS the blocked red, plus a shape
  [LampState.Halted]: overPaper(0x9a8873), // stone_light
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
 *
 * The pulse bottoms out at 0.44 and never reaches zero, which matters more now than it did:
 * the shape is the information, and a shape that blinks out entirely is one a player has to
 * wait for. Unchanged from the one-sprite era on purpose — the feel of a blocked lamp is not
 * what [[042]] was asked to reopen.
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
