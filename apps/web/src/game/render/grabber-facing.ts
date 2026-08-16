// Which frame a grabber's body wears, and which way the whole body turns ([[082]]).
//
// ── THE BODY POINTS AT ITS WORK ─────────────────────────────────────────────────────────
//
// The owner's ruling: "when they rotate, they should be aligned with the direction they're
// gonna pick. Right now they stay in place, just the arm switches." The art lane's reskin
// is authored for exactly that — BASE FACING EAST, claw opening toward the pickup tile,
// centred and mirror-symmetric about the horizontal midline so quarter-turns cannot wobble.
//
// The one fact this module owns that is easy to get backwards: a grabber PICKS FROM the
// `-dir` side. `grabberSourceTile` in the sim is `tile - step(dir) * reach` and
// `grabberDestTile` is `tile + step(dir) * reach` — `dir` is the DROP side, the direction
// goods flow, the direction the ghost's chevron points. So a body whose claw must open
// toward the pickup turns to face `-dir`: a west-pointing grabber (drops west, picks east)
// wears the authored east-facing frame unturned.
//
// Pure — no Pixi, no scene — for the junction/pipe-shape reason: the two tables here are
// exactly the kind of thing that fails silently one quarter-turn off, so they are pinned
// headless in `grabber-facing.test.ts`.

import { GRABBER_SPECS } from '@snack/sim';

import { stepX, stepY } from './directions';

/** Frame ids are the sim's own slugs with dashes swapped for underscores. One vocabulary. */
const GRABBER_FRAME = new Map<number, string>(
  GRABBER_SPECS.map((spec) => [spec.tier as number, spec.slug.split('-').join('_')]),
);

/**
 * The body frame for a grabber tier: `grabber_mk1` / `grabber_mk2` / `grabber_long`,
 * derived from `GRABBER_SPECS`'s own slugs so a new tier in `data.ts` arrives named. A
 * tier this build has never heard of wears the Mk1 body rather than a magenta square.
 */
export function grabberBodyFrame(tier: number): string {
  return GRABBER_FRAME.get(tier) ?? 'grabber_mk1';
}

/**
 * Radians to turn the east-authored body so its claw opens toward the PICKUP tile — the
 * `-dir` side, per the header. A direction this build has never heard of steps (0,0) in
 * `directions.ts` and lands at 0 here: the authored east face, never an exception.
 */
export function grabberBodyRotation(dir: number): number {
  const pickX = -stepX(dir);
  const pickY = -stepY(dir);
  if (pickX === 0 && pickY === 0) return 0;
  return Math.atan2(pickY, pickX);
}
