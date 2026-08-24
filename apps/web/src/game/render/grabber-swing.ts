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
//
// ── 5. IT STOPS. WHICH, FOR FOUR MONTHS, IT DID NOT ────────────────────────────────────
//
// The owner, looking at the arm again after its sprite was redrawn: "2nd looks nice, it's
// more about the motion than the sprite itself to be honest." The complaint underneath it
// had been "the arms look like floppy dicks", and the redraw had answered only half of it.
//
// So the motion was measured instead of guessed, and it turned out to have one dominant
// tell. **Every joint of this arm was a single smooth wave of a single parameter.** The
// shoulder was `ease(t)`; the elbow was `sin(PI * phase)` — the same `t`, one function
// later; the claw was `ease(t / 0.25)` — the same `t` again. All three therefore peaked on
// the same frame and were changing on every other frame of the swing, and nothing anywhere
// in the cycle was ever equal to itself twice running. That is not a description of a
// machine. It is very nearly the definition of a rope.
//
// Three changes, and the ordering is by how much each one carries:
//
//   DWELL (`SWING_DWELL`).      The sweep now holds a hard 0 and a hard 1 at its two ends.
//                               Real machinery travels, HALTS, acts, travels. The dwells of
//                               consecutive strokes stack at the shared tile, so each pickup
//                               and each drop gets ~150ms of dead stop. This is the big one.
//   CRUISE (`TRAVEL_RAMP`).     Trapezoidal velocity in place of the smoothstep: ramp, a run
//                               of frames at one constant rate, ramp. Smoothstep's speed is
//                               changing at literally every instant, which is the softest
//                               possible thing a sweep can do.
//   PLATEAU (`foldAmount`).     The elbow snaps to its bend, HOLDS it across the carry, and
//                               snaps straight — instead of swelling to a peak and back. Two
//                               locked postures with a fast change between them is a hinge;
//                               a value that is always somewhere in between is a bent rod.
//                               It is also driven off the stroke rather than the phase, so
//                               the joints no longer all peak together.
//
// ── WHAT THIS DELIBERATELY DID NOT TOUCH, BECAUSE HE LIKED IT ──────────────────────────
//
// Item 094 got "Oh my god, I love the arms. Good job." That verdict is not being relitigated,
// and the four decisions above are all still standing exactly as written. Specifically:
//
//   · THE ARC IS THE ARC. Same 180° sweep, same `sweepSign`, same over-the-top apex, same
//     eastward tie-break. Decision 1 is untouched, to the character.
//   · THE ENDPOINTS ARE STRICTER, NOT LOOSER. Decision 2's load-bearing promise is that the
//     hand lands dead on the two tile centres. It still does — and now holds there for a run
//     of frames rather than for one instant.
//   · THE LINKAGE IS THE LINKAGE. Two equal bars, `acos(r / reach)`, trailing elbow.
//     Decision 3 is not edited at all.
//   · THE CLAW STILL SHUTS OVER THE ITEM. Decision 4's stated intent is now literally true
//     rather than approximately true: the grip completes while the hand is stopped on the
//     tile, not a sixth of the way down-range.
//   · THE WHOLE ARM GOT QUICKER. The 180° is compressed into the middle 70% of the same
//     `swingTicks`, so peak sweep rate is up about 27%. The stop is bought with speed, not
//     with lethargy — which matters, because "not enough oomph" was the original complaint.
//
// And EVERY ONE of item 094's tests passes unchanged. Nothing in this item needed a guard
// relaxed, which is the strongest evidence available that it sharpened that arc rather than
// replacing it. `SWING_TUCK` even documents the fence its own test sets, and stops short.
//
// ── 6. THE HEAD IS GIMBALLED: `clawAngle` ──────────────────────────────────────────────
//
// The owner, watching the arm after the motion pass: "I feel like the head of the grabber
// needs to be always pointing at the object like stabilized by a gimbal."
//
// He is describing a real machine — a pick-and-place head or an excavator bucket keeps its
// aim on the work while the boom slews around it — and the arm had a measurable defect that
// matches the words exactly. The claw wore `foreAngle`, so it inherited **the elbow's fold on
// top of the sweep**, and those are two different curves:
//
//   · `handAngle` is the sweep. It is `travelProgress` × 180°: dwell, ramp, cruise, ramp,
//     dwell. Monotonic, and it is the profile the whole motion pass above was built around.
//   · `bend` is the elbow, and it is `foldAmount` — a plateau that rises and FALLS. It is
//     deliberately a different function of a different parameter, so the joints stop peaking
//     together (see `FOLD_RAMP`).
//   · `foreAngle` is their SUM, because the forearm carries both. So the head's aim rose,
//     overshot, and came back.
//
// Measured over one Mk1 stroke, driving this function across the real tick grid:
//
//   THE HEAD TURNED 224.6° TO ACHIEVE 180°, AND REVERSED DIRECTION ONCE.
//
//   · 44.6° of that was PARASITIC — pure elbow leak, cancelling itself out over the stroke.
//   · By tick 2 the hand had travelled 2.07px, still standing on the tile with the item
//     clamped in shut jaws — and the head had already twisted 20.6°. It wrung the payload
//     in place, during the very dwell `SWING_DWELL` exists to make dead still.
//   · By tick 8 the hand was 1.6px from the drop and the head was 15.7° PAST its final aim,
//     then flicked back. That wag at the moment of delivery is the tell he was pointing at.
//
// `clawAngle` cancels exactly that. The head holds the **pivot-to-hand bearing** — the arm's
// own line of reach, the line it grips along — so the elbow's fold no longer reaches it, and
// the head's aim becomes `travelProgress` and nothing else. 180.0° per stroke, zero parasitic
// rotation, zero reversals: the head now moves on the same trapezoid as the shoulder. It
// dwells when the hand dwells and cruises when the hand cruises, which is the whole of what
// "stabilized" means here.
//
// THE HARD CONSTRAINT, WHICH IS WHAT ACTUALLY DECIDES THIS. The claw's tip has to land on the
// tile centre at both ends of the stroke, because that is where it grips and where it lets go.
// The linkage puts the HAND on the tile centre and the wrist `clawW` back along the forearm,
// so the ONLY aim that puts the tip on the tile is `foreAngle` — and at an endpoint the tuck
// is zero, so `foreAngle` and `handAngle` are the same number. **Every admissible law equals
// `handAngle` at both endpoints.** That is arithmetic, not taste, and it kills three readings
// outright. Measured on the real tick grid, worst case over 4 directions and 3 tiers:
//
//   PAYLOAD-LEVEL (a constant screen angle, the literal camera-gimbal reading) — claw tip
//     20.0px off the tile at BOTH endpoints, item released 15.0px off centre, 180° of wrist
//     break. No constant can face both ends of a 180° sweep. And it buys nothing anyway: the
//     cargo sprite's `rotation` is never assigned, so the carried item CANNOT tumble however
//     the head moves. The one reading named after the payload does not affect the payload.
//   TARGET-TRACKING (aim at the tile this stroke ends on) — the closest reading to his actual
//     words, and it fails in the sharpest possible way. It is exact at the tile it is leaving
//     and 20.0px wide of the tile it is GRIPPING: it points away from the item at the precise
//     moment it closes on it. And it snaps a full 180° at the changeover, because the tile it
//     is working swaps at the instant the two dwells meet. Aiming at the tile the stroke
//     STARTS on just mirrors the fault — exact where it grips, 20.0px out where it releases.
//   WORK-AXIS (the static source→destination axis off `dir`) — a constant, so it fails both
//     endpoints the same 20.0px way, and parks the claw pointing back at its own pedestal.
//
// AND THE LINE OF REACH IS THE UNIQUE SURVIVOR, not merely a good one. Write the whole
// admissible family as `handAngle + k · bend` — every member hits both endpoints exactly,
// because `bend` is 0 there. `bend` is `foldAmount`, a plateau that RISES AND FALLS, so any
// `k ≠ 0` puts a rise-and-fall into the head's aim and the head reverses direction mid-stroke.
// Measured: k=0 gives 180.0° per stroke and 0 reversals; k=¼ gives 184.3° and 1; k=½ gives
// 194.6° and 1; k=1 is `foreAngle` itself, 224.6° and 1. **k=0 is the only member that does
// not wag**, and `handAngle + 0·bend` is `handAngle`. The choice is forced.
//
// Blends that ramp into a constant across the carry escape that family by making `k` a
// function of the stroke, and fail differently: endpoints exact, but the head rotates 78.6°
// between two adjacent frames of the real tick grid and breaks the wrist 177.4° — the claw
// ends up pointing backwards down its own forearm. The head is the smallest part on the arm;
// it is the one part that must never be the fastest thing moving.
//
// WHY THIS IS NOT THE S-CURVE BUG COMING BACK, which is the first thing to check, because
// `grabbers.ts` removed `handAngle` from the claw for good reason. That bug was TWO changes
// and only one of them was the rotation: the claw was also POSITIONED along the pivot-hand
// chord, which put its whole body — root included — 6.6px off the forearm's centreline on an
// 8px bar. It had come off the arm. The wrist here stays exactly where the linkage puts it,
// `clawW` back along the FOREARM, so the claw's root sits on the forearm's centreline at
// 3.6e-15px — zero — at every pose the sim can produce. The claw is hinged, not adrift. What
// it costs is the honest cost of a wrist joint: the claw's far end swings up to 6.6px
// (`clawW * sin 41.4°`) off the bar's axis at the deepest tuck, and the 16px-tall claw covers
// the 8px-thick bar end through all of it.
//
// THOSE TWO 6.6s ARE THE SAME `clawW * sin(bend)`, AND THAT IS THE WHOLE POINT. The gimbal
// displaces the claw's FAR END by exactly the distance the S-curve bug displaced its ROOT. A
// magnitude cannot tell the fix from the bug; only the end of the part that moves can. A hand
// that pivots about a wrist that stays put is a joint. A hand whose root has left the wrist
// has fallen off. So the test that matters is not "how far did the claw move" — it is the one
// that pins the ROOT to the forearm, and it reads zero.
//
// AND THE PARKED ARM CANNOT MOVE. At both endpoints `foldAmount` is 0, so `radius` is exactly
// `reach`, `acos(1)` is exactly 0, and `handAngle` and `foreAngle` are not merely close —
// they are bit-identical, `0.000e+0` rad apart across all four directions, all three tiers and
// both strokes. Every resting pose, and all 24 stall poses, draw the same pixels they drew
// before. As with the S-curve fix: costless at the ends, which is why it is safe.

import { GRABBER_SPECS, grabberSpec } from '@snack/sim';

import { grabberBodyRotation } from './grabber-facing';
import { TILE_PX } from './pixel';

/**
 * How far the reach pulls in while the arm is CARRYING, as a fraction of full extension.
 *
 * A quarter, up from item 094's sixth: 41.4° of elbow break at the apex (`acos(1 - 1/4)`)
 * against the old 33.6°. The extra 8° is not the point and on its own would not have been
 * worth the churn — `foldAmount` is the point, and a deeper angle is simply worth more once
 * the joint HOLDS it instead of sliding through it.
 *
 * A quarter is also very close to the most this may ever be, and the ceiling is item 094's
 * own: its `leaves the straight line` test demands the hand clear the pivot-to-pivot chord by
 * more than 0.7 of a tile, and at the apex the hand sits at `reach * (1 - SWING_TUCK)`. A
 * one-tile Mk1 clears 24px against a 22.4px bar. A THIRD would clear 21.3px and fail it —
 * which is exactly the "looks like it is falling short" failure the original note warned
 * about, caught by a test rather than by an eye. Do not go past a quarter without moving
 * that fence first, and have a reason for moving it.
 */
export const SWING_TUCK = 1 / 4;

/**
 * The fraction of each stroke the arm spends COMPLETELY MOTIONLESS, at each end.
 *
 * ── THE ONE CHANGE THIS ITEM IS REALLY ABOUT ────────────────────────────────────────────
 *
 * Item 094 built a sweep that runs from tile to tile and, the instant it arrives, turns round
 * and runs back. Nothing in the old pose function was ever equal to itself two frames
 * running: `ease` has a flat derivative at both ends, so the arm slowed *toward* each tile,
 * but slowing is not stopping and a smoothstep never actually reaches zero speed for any
 * measurable time. **The arm had literally never stood still.** That is the difference the
 * owner was pointing at — a rope flows and a servo stops — and it is a property of the
 * ANIMATION CURVE, not of the arc, not of the endpoints, and not of the sprite.
 *
 * So: for the first and last `SWING_DWELL` of every stroke, `travelProgress` returns a hard
 * 0 or a hard 1, and the arm is parked. Two consequences worth spelling out.
 *
 * FIRST, THE DWELLS STACK. The sim starts a fresh stroke on the tick it finishes one (see
 * `advanceGrabber`), so the trailing dwell of the outbound stroke and the leading dwell of
 * the return stroke are adjacent in time AND at the same place. Each tile therefore gets
 * `2 * SWING_DWELL` of stillness — 0.3 of a stroke, which at Mk1's 10 ticks is 3 ticks of
 * stroke-time and lands on the sample grid as FOUR CONSECUTIVE IDENTICAL FRAMES (a stroke's
 * last two plus the next stroke's first two), 200ms of dead stop at every pickup and every
 * drop. That is a beat you can see.
 *
 * SECOND, THE ARM GOT FASTER, NOT LAZIER. The 180° still has to happen inside the same
 * `swingTicks`, now compressed into the middle 70% of it, and `travelProgress`'s cruise
 * carries a peak angular rate of about 1.9 sweeps per stroke-time against the old
 * smoothstep's 1.5. It travels 27% quicker than it ever did and then it hits a wall. Nothing
 * here trades away the "oomph" item 094 was asked for; the oomph is what makes the stop read.
 *
 * 0.15 rather than something rounder because the stroke is only 10 ticks: 0.2 would put THREE
 * of the eleven sampled frames on each endpoint and leave six for the sweep, at which point
 * the traverse starts to read as dropped frames instead of speed.
 */
export const SWING_DWELL = 0.15;

/**
 * The fraction of the TRAVERSE spent accelerating, and again decelerating.
 *
 * `travelProgress` is a trapezoidal velocity profile — ramp up, hold a constant rate, ramp
 * down — which is what a stepper under a motion controller actually does, and the reason to
 * prefer it over the smoothstep it replaces is the flat top. Smoothstep's velocity is a
 * parabola: it is at its own peak for exactly one instant and is changing at every other
 * moment of the swing. Continuous change of speed is the single most organic cue a linkage
 * can give off. A quarter-ramp gives four of the eleven frames at an identical 34° step — a
 * genuine constant-velocity cruise — with the acceleration a square wave either side of it.
 */
export const TRAVEL_RAMP = 1 / 4;

/**
 * The fraction of the traverse spent folding the elbow up, and again spent unfolding it.
 *
 * ── WHY THE TUCK STOPPED BEING A SINE ───────────────────────────────────────────────────
 *
 * It used to be `sin(PI * phase)`, driven off the very same eased parameter as the shoulder.
 * Every joint therefore peaked on the same frame: maximum sweep speed, maximum bend and
 * maximum retraction all arrived together at mid-stroke and left together. A limb whose
 * joints are all one wave does not read as several bones — it undulates, as one thing.
 *
 * `foldAmount` breaks that. It is a plateau, not a hump, and it is a function of the STROKE
 * rather than of the phase: the elbow snaps to `SWING_TUCK` over the first quarter of the
 * traverse, HOLDS that exact angle across the middle half, and snaps straight over the last
 * quarter. So the bend now spends most of the cycle being one of two constants — locked
 * straight through both dwells, locked at 41.4° through the carry — with fast transitions
 * between them. Two rigid postures and a quick change of posture is what a hinge looks like.
 * A value that is always somewhere in between is what a bent rod looks like.
 *
 * And the two peaks no longer coincide: the folding happens where the shoulder is
 * ACCELERATING, the plateau covers the cruise. The undulation has nothing left to sync to.
 *
 * The ramps are `ease`d rather than linear on purpose. The shape carries the mechanical
 * read — fast, then held — and a hard corner in `radius` would be a visible pop in the hand
 * position rather than a snap in the elbow, which is a different and worse thing.
 */
export const FOLD_RAMP = 1 / 4;

/**
 * The fraction of a stroke the claw spends changing its mind about gripping.
 *
 * **Exactly `SWING_DWELL`, and that equation is the whole point** — the claw finishes
 * clamping on the precise frame the arm begins to move. Clamp, then go; arrive, then release.
 *
 * Decision 4 in the header always CLAIMED this ("the claw shuts while the hand is still
 * essentially over the item") and under the old numbers it was only roughly true: a quarter
 * of the stroke eased out to about a sixth of the arc, so the claw was still closing with the
 * hand already 30° down-range. Now it is exactly true. The hand is not "essentially" over
 * the item, it is stationary on it.
 *
 * The curve is LINEAR where it used to be a smoothstep, which matters more than the window
 * does: a smoothstepped grip decelerates onto its own stop, and a gripper that eases shut is
 * the single most obviously soft thing on the arm. Linear runs at one rate and stops dead
 * when it meets the mechanical stop, which is what a jaw does.
 *
 * The old note's floor is still respected. At Mk1's 10 ticks a 0.15 window is 1.5 ticks, so
 * the sampled frames are open, one intermediate, shut — a two-step close, not the single-
 * frame teleport that note warned against.
 */
export const GRIP_FRACTION = SWING_DWELL;

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
 * ── IT HAS SURVIVED TWO REDRAWS UNCHANGED, AND THAT WAS CHECKED RATHER THAN ASSUMED ─────
 *
 * Item 135 redrew all three tiers at native 32px; the floppy-arm item redrew the shaft again.
 * This table did NOT move either time, which is the whole reason item 094's arc is untouched:
 * `armPose` reads `clawW` and nothing else from here, so an unchanged partition is an
 * unchanged swing — same angles, same tuck, same endpoints, same hand point on the same two
 * tile centres. Counted off the PNGs before trusting it: opaque columns 0–13 span rows 8–23,
 * columns 14–21 span rows 12–19, columns 22–31 span rows 8–23, in every one of the three
 * tiers. Exactly the spans this comment already claimed.
 *
 * ── A CORRECTION, BECAUSE THIS NOTE SENT THE NEXT READER THE WRONG WAY ───────────────────
 *
 * What stood here said the shaft's eight columns had been made byte-identical, and that the
 * `TilingSprite` item 135 was expected to need "is a no-op and was not written" — because
 * stretching a column-uniform texture is pixel-identical to tiling it.
 *
 * Every clause of that was true and the conclusion was still a trap. It reads as "the
 * stretching problem is handled", and it was not: `grabbers.ts` went on stretching the slice
 * with `Sprite.width`, ANISOTROPICALLY, and the texture was only column-uniform because of
 * it. The two facts held each other up, and what fell out of them was a smooth featureless
 * tube that bends in the middle — which the owner, watching it, called a floppy dick.
 *
 * The `TilingSprite` is written now. `grabbers.ts`'s `shaftBar` repeats the module at 1:1,
 * column detail survives, and the art carries a waist, segment rings and rivets again. If you
 * are here because a shaft looks smeared, check that the bar is still tiling before you reach
 * for the pixels.
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

/**
 * Smoothstep. Accelerates off the mark and settles onto it; flat derivative at both ends.
 *
 * NO LONGER THE SWING CURVE — `travelProgress` is, and the swap is most of this item. What
 * `ease` still does is shape `foldAmount`'s two short ramps, where a soft landing is wanted
 * because the thing being eased is a RADIUS and a corner in a radius pops the hand.
 */
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
 * How far the arm has got round its sweep, given how far it is through its stroke: **0 at the
 * near end, 1 at the far end**, with a HARD STOP at each.
 *
 * Dwell, then a trapezoidal velocity profile, then dwell. See `SWING_DWELL` for why the
 * stopping is the entire point and `TRAVEL_RAMP` for why the middle is a flat cruise rather
 * than a parabola. Sampled at Mk1's eleven frames the sweep steps
 *
 *   0° · 0° · 2° · 22° · 56° · 90° · 124° · 158° · 178° · 180° · 180°
 *
 * against the smoothstep this replaces, which stepped
 *
 *   0° · 5° · 19° · 39° · 63° · 90° · 117° · 141° · 161° · 175° · 180°
 *
 * — never twice in the same place, and never twice at the same speed. Four identical 34°
 * strides in the middle of the new one is the cruise; the pairs of repeated numbers at either
 * end are the halt.
 *
 * **Returns literal 0 and literal 1 in the dwells, not something that rounds to them.** Item
 * 094's endpoint invariant — hand dead on the tile centre, every tier, every direction — was
 * the load-bearing half of its decision 2 and it is not weakened here, it is STRENGTHENED:
 * what used to be exact for one instant is now exact for a run of frames.
 */
export function travelProgress(strokeT: number): number {
  if (strokeT <= SWING_DWELL) return 0;
  if (strokeT >= 1 - SWING_DWELL) return 1;
  const u = (strokeT - SWING_DWELL) / (1 - 2 * SWING_DWELL);
  // Area under a trapezoid of unit total: peak rate `vMax`, reached after ramping for `a`.
  const a = TRAVEL_RAMP;
  const vMax = 1 / (1 - a);
  if (u < a) return (vMax * u * u) / (2 * a);
  if (u > 1 - a) {
    const remaining = 1 - u;
    return 1 - (vMax * remaining * remaining) / (2 * a);
  }
  return vMax * (u - a / 2);
}

/**
 * How folded the elbow is, 0 straight and 1 at `SWING_TUCK`: a PLATEAU across the carry, and
 * flat zero through both dwells.
 *
 * A function of the STROKE, deliberately not of the phase — see `FOLD_RAMP` for the argument.
 * Two things follow that are worth stating because tests lean on both.
 *
 * It is zero at both ends, so the radius is full extension exactly when the hand is on a tile,
 * which is the same guarantee `sin(PI * phase)` used to give and the reason the endpoints did
 * not move.
 *
 * It is SYMMETRIC about mid-stroke, and `travelProgress` is antisymmetric about it
 * (`travelProgress(1 - t) === 1 - travelProgress(t)`), so the outbound stroke and the return
 * stroke show the identical bend at the identical phase. That is what keeps the elbow from
 * popping through itself at the changeover — the property item 094's `folds the elbow the
 * SAME way on both strokes` test exists to catch, still holding for a new reason.
 */
export function foldAmount(strokeT: number): number {
  if (strokeT <= SWING_DWELL || strokeT >= 1 - SWING_DWELL) return 0;
  const u = (strokeT - SWING_DWELL) / (1 - 2 * SWING_DWELL);
  if (u < FOLD_RAMP) return ease(u / FOLD_RAMP);
  if (u > 1 - FOLD_RAMP) return ease((1 - u) / FOLD_RAMP);
  return 1;
}

/**
 * Position along the sweep: **0 is over the SOURCE tile, 1 is over the DESTINATION**,
 * whichever way the arm happens to be travelling.
 *
 * The direction is read off `held`, exactly as the layer header has always claimed: a
 * loaded arm is on its way out (source → destination), an empty one is on its way home.
 */
export function swingPhase(held: number, swingPermille: number): number {
  const travelled = travelProgress(strokeProgress(swingPermille));
  return held !== 0 ? travelled : 1 - travelled;
}

/**
 * How shut the claw is: 0 wide open, 1 clamped.
 *
 * Loaded strokes close, empty strokes open, and both do it over the first `GRIP_FRACTION` of
 * the stroke — which, that constant being `SWING_DWELL`, is exactly the window in which the
 * hand is not merely near its tile but STOPPED ON IT.
 *
 * Linear, not eased: a jaw runs at one rate and hits its stop. See `GRIP_FRACTION`.
 */
export function gripAmount(held: number, swingPermille: number): number {
  const t = strokeProgress(swingPermille);
  const shut = t >= GRIP_FRACTION ? 1 : t / GRIP_FRACTION;
  return held !== 0 ? shut : 1 - shut;
}

/**
 * Every joint of one arm, in source pixels **relative to the pivot** (the centre of the
 * grabber's own tile). The caller adds the tile origin and rounds; nothing here knows where
 * on the map this arm is, which is what makes the whole thing testable without a canvas.
 */
export interface ArmPose {
  /** Radians from the pivot to the hand: the arm's line of reach, and the sweep itself. */
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
  /**
   * Where the HEAD aims — the claw's own rotation, and the jaws' line of travel with it.
   *
   * A THIRD angle on purpose, and section 6 of the header is the argument for it. The claw
   * is not rigid with the forearm (that inherits the elbow's fold and wags the payload) and
   * it is not free of the arm either (a constant world angle cannot face both ends of a 180°
   * sweep). It holds the **pivot-to-hand bearing**: the line the arm reaches along, which is
   * the line the jaws grip along, which at each end of the stroke runs through the centre of
   * the tile the claw is working. Pointed at the object at both ends by construction, and
   * driven by `travelProgress` alone in between.
   *
   * It is the same number as `handAngle`, and that is a FACT ABOUT THE GIMBAL LAW rather than
   * a coincidence worth collapsing: this is where a different law would be written, and the
   * separate name is what stops the next reader from concluding the claw is welded to the
   * chord the way the old bug welded it. `grabbers.ts` still takes the claw's POSITION from
   * `foreAngle` — the wrist is a point on the forearm and stays one. Rotation here, position
   * there; that split is the whole invariant.
   */
  clawAngle: number;
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
  const stroke = strokeProgress(swingPermille);
  const phase = swingPhase(held, swingPermille);

  const handAngle = source + sign * Math.PI * phase;
  // Zero through both dwells by construction — see decision 2, and `foldAmount` for why this
  // is a plateau off the STROKE rather than the sine of the PHASE it used to be. The hand
  // hits its tile exactly, and now goes on hitting it for several frames.
  const radius = reach * (1 - SWING_TUCK * foldAmount(stroke));

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
    // The gimbal: the head holds the line of reach, so the elbow's fold never reaches it.
    // Equal to `foreAngle` exactly wherever `bend` is 0 — which is both endpoints, every
    // dwell and all 24 stall poses — and short of it by `bend` across the carry.
    clawAngle: handAngle,
    radius,
    reach,
    grip: gripAmount(held, swingPermille),
  };
}
