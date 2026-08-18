// The grabber's swing: where every joint of the arm is, given `swingPermille` and nothing else.
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────
//
// The owner, twice, in the same afternoon:
//
//   "the grabbers need better animation. I want them to actually rotate when they are
//    grabbing something."
//   "the arm doesn't have enough oomph to it. It's just like a little rectangle. It should
//    be like an actual arm."
//
// Both complaints have the same root. The old renderer LERPed a 6px hand sprite along the
// STRAIGHT LINE between the source tile and the destination tile. A straight line between
// two points either side of a pivot is not a swing, it is a drawer being opened; and a hand
// with nothing joining it to its base is not an arm, it is a brick on a string. So this
// module answers a different question: not "how far along the line is the hand" but
// "WHERE IS EVERY BONE" — shoulder, elbow, wrist, and how far shut the claw is.
//
// ── PURE, AND THAT IS THE POINT ─────────────────────────────────────────────────────────
//
// Not one function here reads a clock. The whole pose is a function of
// `(dir, tier, held, swingPermille)`, all four of which come straight off `GrabberView`, so
// a paused world holds its pose exactly, a replayed world draws the identical frame, and an
// arm can never drift out of step with the machine it is feeding. That rule is why the
// maths lives in its own module instead of inline in the layer: a renderer-local `nowMs`
// creeping into an easing curve is invisible until someone pauses the game.
//
// ── THE FOUR DECISIONS, AND THE REASONING BEHIND EACH ───────────────────────────────────
//
// 1. WHICH WAY ROUND. Source and destination sit exactly 180° apart about the pivot, so
//    "sweep from one to the other" leaves the sense of rotation genuinely undetermined —
//    and the two choices look completely different on screen. `sweepSign` picks the half
//    that carries the hand OVER THE TOP, because an arm that dips below its own pedestal
//    reads as broken, and on the vertical axis (where neither half is higher) it breaks the
//    tie by sweeping out to the EAST, so the north-feeding arm and the south-feeding arm on
//    the same belt mirror each other instead of scissoring.
//
// 2. THE TUCK. A hand pinned at exactly full reach for the whole sweep gives the elbow
//    nothing to do — the arm would be a rigid spoke. `SWING_TUCK` pulls the reach in by a
//    sixth at mid-swing and returns it to EXACTLY full extension at both ends, so the arm
//    folds as it passes over its own base and straightens to place the item. The endpoints
//    are the load-bearing half of that sentence: `sin(pi * u)` is 0 at u = 0 and u = 1, so
//    the hand lands dead on the source and destination tile centres, the same two points
//    the old straight-line code hit. The tuck changes the PATH, never the targets.
//
// 3. THE ELBOW. Two bars of equal length, each half the reach, which makes the inverse
//    kinematics collapse to `acos(r / reach)` — no square roots, no degenerate cases, and a
//    perfectly straight arm at full extension by construction rather than by luck.
//
// 4. THE GRIP. `held` already tells us which stroke this is, so the claw needs no state of
//    its own: closing over the first quarter of a LOADED stroke, opening over the first
//    quarter of an EMPTY one. Because the easing is a smoothstep, that first quarter of
//    time is only a sixth of the arc — the claw shuts while the hand is still essentially
//    over the item, which is what makes the grab read as a grab. It also means a stalled
//    arm parks correctly without a special case: blocked-and-holding sits clamped shut over
//    a full destination, starved-and-empty sits open over an empty source.

import { GRABBER_SPECS, grabberSpec } from '@snack/sim';

import { grabberBodyRotation } from './grabber-facing';
import { TILE_PX } from './pixel';

/**
 * How far the reach pulls in at mid-swing, as a fraction of full extension.
 *
 * A sixth: enough that the elbow visibly breaks (about 33° of bend at the apex, from
 * `acos(1 - 1/6)`) and nowhere near enough to make the hand look like it is falling short
 * of the tile it is aiming at.
 */
export const SWING_TUCK = 1 / 6;

/**
 * The fraction of a half-swing the claw spends changing its mind about gripping.
 *
 * Quarter of the STROKE, which the easing turns into roughly a sixth of the ARC — see
 * decision 4 in the header. Shorter and it snaps in a single frame; longer and the arm is
 * halfway to the machine before it has hold of anything.
 */
export const GRIP_FRACTION = 1 / 4;

/**
 * Where the authored grabber tile divides into housing | shaft | claw.
 *
 * Read off the atlas rather than guessed: every one of `grabber_mk1`, `grabber_mk2` and
 * `grabber_long` puts opaque pixels in columns 0–13 (the housing, 16 rows tall), 14–21 (the
 * shaft, 8 rows tall) and 22–31 (the claw, 16 rows tall). The three tiers agree exactly,
 * which is what makes one slice table serve all of them, and `textures.ts` paints the
 * grey-box bodies to the same grid so a build with no atlas assembles the same arm.
 *
 * THESE ARE SOURCE PIXELS, NOT FRACTIONS, so they doubled with `TILE_PX` 16 → 32 and the
 * widths must still sum to exactly `TILE_PX` — they are a partition of the authored tile, and
 * a table that sums to 16 against a 32px frame cuts the arm out of its left half and leaves
 * the claw as empty air. `grabber-swing.test.ts` pins the sum.
 *
 * Lives in this module rather than beside the sprites it cuts, for the reason everything
 * else here does: it is geometry, and geometry can be pinned by a test that never opens a
 * canvas.
 *
 * The pieces are cut at full tile HEIGHT deliberately: row 16 is then the vertical centre of
 * each slice, which is also the arm's own midline in the authored art, so an anchor at 0.5
 * puts the hinge exactly on the bar rather than a pixel above it.
 *
 * ── IT SURVIVED THE [[135]] REDRAW UNCHANGED, AND THAT WAS CHECKED RATHER THAN ASSUMED ──
 *
 * Item 135 redrew all three tiers at native 32px. This table did NOT move, which is the whole
 * reason item 094's arc is untouched: `armPose` reads `clawW` and nothing else from here, so
 * an unchanged partition is an unchanged swing — same angles, same tuck, same endpoints, same
 * hand point on the same two tile centres. Counted off the new PNGs before trusting it:
 * opaque columns 0–13 span rows 8–23, columns 14–21 span rows 12–19, columns 22–31 span rows
 * 8–23, in every one of the three tiers. Exactly the spans this comment already claimed.
 *
 * The one thing that DID change is invisible from here and deliberately so: the shaft's eight
 * columns are now byte-identical to each other. `grabbers.ts` stretches that slice with
 * `Sprite.width`, and stretching a column-uniform texture is pixel-identical to tiling it —
 * which is why the `TilingSprite` this item was expected to need is a no-op and was not
 * written.
 */
export const ARM_SLICE = {
  mountX: 0,
  mountW: 14,
  linkX: 14,
  linkW: 8,
  clawX: 22,
  clawW: 10,
} as const;

/** Reach in tiles, defaulting to the shortest arm when a tier is unknown to this build. */
export function reachTilesOf(tier: number): number {
  return grabberSpec(tier as never)?.reachTiles ?? GRABBER_SPECS[0]!.reachTiles;
}

/** Full extension in source pixels: the tier's reach, which is what puts the hand on a tile. */
export function reachPxOf(tier: number): number {
  return reachTilesOf(tier) * TILE_PX;
}

/** Smoothstep. Accelerates off the mark and settles onto it; flat derivative at both ends. */
export function ease(x: number): number {
  const c = x < 0 ? 0 : x > 1 ? 1 : x;
  return c * c * (3 - 2 * c);
}

/**
 * Which way round the arm sweeps: `+1` for increasing angle (clockwise on a y-down screen),
 * `-1` for decreasing.
 *
 * Chosen so the apex of the sweep is as far UP-SCREEN as it can be, and — on the vertical
 * axis, where both halves are level — as far EAST as it can be. See decision 1.
 *
 * A `dir` this build has never heard of steps (0, 0) in `directions.ts`, lands at angle 0
 * here, and sweeps like a west-feeding arm. Wrong, harmless, and never a thrown exception
 * in the middle of a frame.
 */
export function sweepSign(dir: number): 1 | -1 {
  const source = grabberBodyRotation(dir);
  const alongX = Math.cos(source);
  // The apex sits at `source + sign * PI/2`, whose y component is `sign * cos(source)`.
  // Up-screen is NEGATIVE y, so the sign that lifts the arm is the opposite of cos's.
  if (Math.abs(alongX) > 1e-6) return alongX > 0 ? -1 : 1;
  // Level: the apex's x component is `-sign * sin(source)`, and east is positive x.
  return Math.sin(source) > 0 ? -1 : 1;
}

/**
 * How far through the stroke this arm is, before easing: 0 at the START of the current
 * half-swing, 1 at its end.
 *
 * The sim counts `cooldown` DOWN from `swingTicks` and `view.ts` reports the elapsed part,
 * so full permille means "arrived". At rest the arm reads full and empty, which is the pose
 * this returns 1 for — parked at the source, waiting.
 */
export function strokeProgress(swingPermille: number): number {
  const t = swingPermille / 1000;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * Position along the sweep, eased: **0 is over the SOURCE tile, 1 is over the DESTINATION**,
 * whichever way the arm happens to be travelling.
 *
 * The direction is read off `held`, exactly as the layer header has always claimed: a
 * loaded arm is on its way out (source → destination), an empty one is on its way home.
 */
export function swingPhase(held: number, swingPermille: number): number {
  const eased = ease(strokeProgress(swingPermille));
  return held !== 0 ? eased : 1 - eased;
}

/**
 * How shut the claw is: 0 wide open, 1 clamped.
 *
 * Loaded strokes close, empty strokes open, and both do it over the first `GRIP_FRACTION`
 * of the stroke — which is where the hand is still over the tile it is acting on.
 */
export function gripAmount(held: number, swingPermille: number): number {
  const shut = ease(strokeProgress(swingPermille) / GRIP_FRACTION);
  return held !== 0 ? shut : 1 - shut;
}

/**
 * Every joint of one arm, in source pixels **relative to the pivot** (the centre of the
 * grabber's own tile). The caller adds the tile origin and rounds; nothing here knows where
 * on the map this arm is, which is what makes the whole thing testable without a canvas.
 */
export interface ArmPose {
  /** Radians from the pivot to the hand. Both claw halves wear this. */
  handAngle: number;
  handX: number;
  handY: number;
  elbowX: number;
  elbowY: number;
  /** Radians from the pivot to the elbow, and the bar's length: the upper arm's transform. */
  upperAngle: number;
  upperLength: number;
  /** Radians from the elbow to the hand, and the bar's length: the forearm's transform. */
  foreAngle: number;
  foreLength: number;
  /** Distance from pivot to hand — full extension at both ends of the stroke, tucked between. */
  radius: number;
  /** Full extension for this tier, which is also the sum of the two bars. */
  reach: number;
  /** 0 open, 1 clamped. */
  grip: number;
}

/**
 * The whole pose, from the four `GrabberView` fields that describe a swing.
 *
 * The one invariant worth stating out loud, because every test in `grabber-swing.test.ts`
 * leans on it: at `phase = 0` the hand is at the SOURCE tile's centre and at `phase = 1` it
 * is at the DESTINATION tile's centre, dead on, for every tier and every direction. The
 * sweep is a nicer road between the same two towns.
 */
export function armPose(dir: number, tier: number, held: number, swingPermille: number): ArmPose {
  const reach = reachPxOf(tier);
  const source = grabberBodyRotation(dir);
  const sign = sweepSign(dir);
  const phase = swingPhase(held, swingPermille);

  const handAngle = source + sign * Math.PI * phase;
  // Zero at both ends by construction — see decision 2. The hand hits its tile exactly.
  const radius = reach * (1 - SWING_TUCK * Math.sin(Math.PI * phase));

  const handX = Math.cos(handAngle) * radius;
  const handY = Math.sin(handAngle) * radius;

  // Two equal bars, so the pivot-side angle of the triangle is just `acos(radius / reach)`.
  // Clamped because a radius above full extension would otherwise hand `acos` a NaN, and a
  // NaN rotation silently blanks a sprite rather than throwing anything anyone would see.
  const ratio = reach === 0 ? 1 : radius / reach;
  const bend = Math.acos(ratio < -1 ? -1 : ratio > 1 ? 1 : ratio);
  // Trailing, not leading: the elbow breaks BEHIND the direction of travel, the way a real
  // arm folds. Leading reads as the arm shoving its own elbow at the machine.
  const upperAngle = handAngle - sign * bend;
  const upperLength = reach / 2;

  const elbowX = Math.cos(upperAngle) * upperLength;
  const elbowY = Math.sin(upperAngle) * upperLength;

  return {
    handAngle,
    handX,
    handY,
    elbowX,
    elbowY,
    upperAngle,
    upperLength,
    foreAngle: Math.atan2(handY - elbowY, handX - elbowX),
    foreLength: upperLength,
    radius,
    reach,
    grip: gripAmount(held, swingPermille),
  };
}
