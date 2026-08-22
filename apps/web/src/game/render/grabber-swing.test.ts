// The arm's kinematics ([[094]]), pinned headless.
//
// What fails QUIETLY without this:
//
//   · THE ENDPOINTS. The sweep replaced a straight-line LERP between two tile centres, and
//     it must still LAND on those two tile centres — dead on, every tier, every direction.
//     An arc that overshoots by a pixel looks fine in motion and drops items next to the
//     machine, which is the sort of thing a player reports as "the belt is broken".
//   · WHICH WAY ROUND. Source and destination are exactly 180° apart, so the sense of
//     rotation is a free choice that nothing else in the codebase constrains. Written the
//     other way, every arm dips BELOW its own pedestal — perfectly plausible frame by frame,
//     and immediately wrong to anyone watching it move.
//   · THE CLOCK. The whole pose is a function of `swingPermille`. A `Date.now()` creeping
//     into the easing would be invisible until someone paused the game, at which point the
//     arms would keep swinging with the world stopped.
//   · THE ELBOW'S ARITHMETIC. Two bars of a fixed length have to actually REACH the hand.
//     A forearm whose drawn length disagrees with the gap it spans leaves a break in the arm
//     that only shows at the deepest part of the tuck.

import { describe, expect, it } from 'vitest';
import { Direction, GrabberTier } from '@snack/sim';

import {
  ARM_SLICE,
  GRIP_FRACTION,
  SWING_DWELL,
  SWING_TUCK,
  armPose,
  ease,
  foldAmount,
  gripAmount,
  reachPxOf,
  reachTilesOf,
  strokeProgress,
  sweepSign,
  swingPhase,
  travelProgress,
} from './grabber-swing';
import { TILE_PX } from './pixel';

const DIRS = [Direction.North, Direction.East, Direction.South, Direction.West];
const TIERS = [GrabberTier.Mk1, GrabberTier.Mk2, GrabberTier.Long];

/** Where the sim says this arm picks from, relative to the pivot, in source pixels. */
function sourceOffset(dir: number, tier: number): { x: number; y: number } {
  const r = reachPxOf(tier);
  const map: Record<number, { x: number; y: number }> = {
    [Direction.North]: { x: 0, y: r },
    [Direction.South]: { x: 0, y: -r },
    [Direction.East]: { x: -r, y: 0 },
    [Direction.West]: { x: r, y: 0 },
  };
  return map[dir]!;
}

describe('ease', () => {
  it('is a smoothstep: pinned at both ends, flat at both ends', () => {
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(0.5)).toBeCloseTo(0.5);
    // Flat derivative near 0 is the property that makes the claw shut before the hand moves.
    expect(ease(0.25)).toBeLessThan(0.25);
    expect(ease(0.75)).toBeGreaterThan(0.75);
  });

  it('clamps rather than extrapolating', () => {
    expect(ease(-4)).toBe(0);
    expect(ease(9)).toBe(1);
  });
});

describe('strokeProgress', () => {
  it('reads permille as a fraction, and a resting arm reads full', () => {
    expect(strokeProgress(0)).toBe(0);
    expect(strokeProgress(500)).toBe(0.5);
    expect(strokeProgress(1000)).toBe(1);
  });

  it('clamps a permille from a build that counts differently', () => {
    expect(strokeProgress(-10)).toBe(0);
    expect(strokeProgress(4000)).toBe(1);
  });
});

describe('swingPhase', () => {
  it('runs source → destination while LOADED', () => {
    expect(swingPhase(7, 0)).toBe(0);
    expect(swingPhase(7, 1000)).toBe(1);
  });

  it('runs destination → source while EMPTY — the return stroke', () => {
    expect(swingPhase(0, 0)).toBe(1);
    expect(swingPhase(0, 1000)).toBe(0);
  });

  it('parks a resting arm over its SOURCE: empty, permille full', () => {
    expect(swingPhase(0, 1000)).toBe(0);
  });
});

describe('sweepSign', () => {
  it('carries the hand over the top on the horizontal axis', () => {
    for (const dir of [Direction.East, Direction.West]) {
      const apex = armPose(dir, GrabberTier.Mk1, 1, 500);
      // Up-screen is negative y. Anything else means the arm swings through its own base.
      expect(apex.handY).toBeLessThan(0);
    }
  });

  it('breaks the vertical tie eastward, so a north arm and a south arm mirror', () => {
    for (const dir of [Direction.North, Direction.South]) {
      const apex = armPose(dir, GrabberTier.Mk1, 1, 500);
      expect(apex.handX).toBeGreaterThan(0);
    }
  });

  it('answers ±1 and never throws for a direction this build never heard of', () => {
    expect(Math.abs(sweepSign(999))).toBe(1);
  });
});

describe('gripAmount', () => {
  it('is shut while carrying and open while empty-handed', () => {
    expect(gripAmount(7, 1000)).toBeCloseTo(1);
    expect(gripAmount(0, 1000)).toBeCloseTo(0);
  });

  it('changes over the leading dwell and holds after', () => {
    expect(gripAmount(7, 0)).toBeCloseTo(0);
    expect(gripAmount(7, 1000 * GRIP_FRACTION)).toBeCloseTo(1);
    expect(gripAmount(7, 600)).toBeCloseTo(1);
    expect(gripAmount(0, 0)).toBeCloseTo(1);
    expect(gripAmount(0, 600)).toBeCloseTo(0);
  });

  it('shuts while the hand is STOPPED on the item, not merely near it', () => {
    // Decision 4 always claimed this. Under item 094's numbers it was only roughly true —
    // a quarter of the stroke eased out to about a sixth of the arc, so the claw was still
    // closing with the hand already 19° down-range. `GRIP_FRACTION` is now `SWING_DWELL`,
    // so the whole close happens inside the halt and this is an exact zero.
    expect(swingPhase(7, 1000 * GRIP_FRACTION)).toBe(0);
  });
});

describe('armPose — the endpoints the old straight line hit', () => {
  it('puts the hand dead on the SOURCE tile at phase 0, every tier, every direction', () => {
    for (const dir of DIRS) {
      for (const tier of TIERS) {
        const at = sourceOffset(dir, tier);
        // Empty and rested: parked over the source.
        const parked = armPose(dir, tier, 0, 1000);
        expect(parked.handX).toBeCloseTo(at.x);
        expect(parked.handY).toBeCloseTo(at.y);
        // And the start of a loaded stroke is the same place.
        const lifting = armPose(dir, tier, 5, 0);
        expect(lifting.handX).toBeCloseTo(at.x);
        expect(lifting.handY).toBeCloseTo(at.y);
      }
    }
  });

  it('puts the hand dead on the DESTINATION tile at phase 1', () => {
    for (const dir of DIRS) {
      for (const tier of TIERS) {
        const at = sourceOffset(dir, tier);
        const delivered = armPose(dir, tier, 5, 1000);
        expect(delivered.handX).toBeCloseTo(-at.x);
        expect(delivered.handY).toBeCloseTo(-at.y);
      }
    }
  });

  it('reaches exactly full extension at both ends and tucks in between', () => {
    for (const permille of [0, 1000]) {
      const pose = armPose(Direction.East, GrabberTier.Mk1, 5, permille);
      expect(pose.radius).toBeCloseTo(pose.reach);
    }
    const mid = armPose(Direction.East, GrabberTier.Mk1, 5, 500);
    expect(mid.radius).toBeCloseTo(mid.reach * (1 - SWING_TUCK));
    expect(mid.radius).toBeLessThan(mid.reach);
  });
});

describe('armPose — the linkage actually joins up', () => {
  it('the forearm spans exactly the gap it is drawn across, all the way round', () => {
    for (const dir of DIRS) {
      for (const tier of TIERS) {
        for (let permille = 0; permille <= 1000; permille += 50) {
          const pose = armPose(dir, tier, 5, permille);
          const gap = Math.hypot(pose.handX - pose.elbowX, pose.handY - pose.elbowY);
          expect(gap).toBeCloseTo(pose.foreLength);
          expect(Math.hypot(pose.elbowX, pose.elbowY)).toBeCloseTo(pose.upperLength);
          expect(pose.upperLength + pose.foreLength).toBeCloseTo(pose.reach);
        }
      }
    }
  });

  it('is straight at full extension and bent at the tuck', () => {
    const straight = armPose(Direction.East, GrabberTier.Mk1, 5, 0);
    expect(straight.upperAngle).toBeCloseTo(straight.foreAngle);
    const bent = armPose(Direction.East, GrabberTier.Mk1, 5, 500);
    expect(Math.abs(bent.upperAngle - bent.foreAngle)).toBeGreaterThan(0.5);
  });

  it('folds the elbow the SAME way on both strokes, the way a real hinge does', () => {
    // The apex carries the hand up-screen, so an elbow tucked under it sits lower than the
    // hand. Loaded and empty must agree: a joint that reversed its bend depending on which
    // way the arm happened to be travelling would pop through itself at every changeover.
    const out = armPose(Direction.East, GrabberTier.Mk1, 5, 500);
    const back = armPose(Direction.East, GrabberTier.Mk1, 0, 500);
    expect(out.elbowY).toBeGreaterThan(out.handY);
    expect(back.elbowX).toBeCloseTo(out.elbowX);
    expect(back.elbowY).toBeCloseTo(out.elbowY);
  });
});

describe('armPose — the swing is an ARC, which is the whole item', () => {
  it('leaves the straight line between the two tiles', () => {
    // A West-feeding arm runs along y = 0; a slide would never leave it. Sampled across the
    // stroke, the sweep must be a long way off that line.
    let furthest = 0;
    for (let permille = 0; permille <= 1000; permille += 25) {
      const pose = armPose(Direction.West, GrabberTier.Mk1, 5, permille);
      furthest = Math.max(furthest, Math.abs(pose.handY));
    }
    expect(furthest).toBeGreaterThan(TILE_PX * 0.7);
  });

  it('is monotonic in phase: the arm never stutters backwards mid-stroke', () => {
    let previous = -Infinity;
    for (let permille = 0; permille <= 1000; permille += 25) {
      const phase = swingPhase(5, permille);
      expect(phase).toBeGreaterThanOrEqual(previous);
      previous = phase;
    }
  });

  it('is a pure function of its arguments — same permille, same pose, forever', () => {
    const a = armPose(Direction.South, GrabberTier.Long, 3, 430);
    const b = armPose(Direction.South, GrabberTier.Long, 3, 430);
    expect(b).toEqual(a);
  });
});

describe('reach', () => {
  it('respects each tier: the Long arm sweeps a circle twice the size', () => {
    expect(reachTilesOf(GrabberTier.Mk1)).toBe(1);
    expect(reachTilesOf(GrabberTier.Mk2)).toBe(1);
    expect(reachTilesOf(GrabberTier.Long)).toBe(2);
    expect(reachPxOf(GrabberTier.Long)).toBe(2 * TILE_PX);
    expect(armPose(Direction.East, GrabberTier.Long, 5, 0).reach).toBe(2 * TILE_PX);
  });

  it('gives a tier this build never heard of the shortest arm rather than a NaN', () => {
    expect(reachTilesOf(99)).toBe(1);
    const pose = armPose(Direction.East, 99, 5, 500);
    expect(Number.isFinite(pose.handX)).toBe(true);
    expect(Number.isFinite(pose.handY)).toBe(true);
  });
});

describe('ARM_SLICE', () => {
  it('tiles the authored 32px frame with no gap and no overlap', () => {
    expect(ARM_SLICE.mountX).toBe(0);
    expect(ARM_SLICE.mountX + ARM_SLICE.mountW).toBe(ARM_SLICE.linkX);
    expect(ARM_SLICE.linkX + ARM_SLICE.linkW).toBe(ARM_SLICE.clawX);
    expect(ARM_SLICE.clawX + ARM_SLICE.clawW).toBe(TILE_PX);
  });

  it('leaves the claw an even split about the midline, so its jaws can meet', () => {
    expect(TILE_PX % 2).toBe(0);
    // Both jaws are cut at half the tile, and the art's own centreline is that same row.
    expect(TILE_PX / 2).toBe(16);
  });
});

describe('travelProgress — the arm STOPS, which is the whole of the floppy fix', () => {
  it('is exactly parked, not merely slow, for the first and last SWING_DWELL', () => {
    // `ease` had a flat derivative at both ends, which slows toward a tile without ever
    // arriving at zero speed for any measurable time. `toBe`, not `toBeCloseTo`: the dwell
    // has to be a literal 0 and a literal 1 or item 094's endpoint invariant loosens.
    expect(travelProgress(0)).toBe(0);
    expect(travelProgress(SWING_DWELL / 2)).toBe(0);
    expect(travelProgress(SWING_DWELL)).toBe(0);
    expect(travelProgress(1 - SWING_DWELL)).toBe(1);
    expect(travelProgress(1)).toBe(1);
  });

  it('holds FOUR consecutive Mk1 ticks dead still at a tile, across the changeover', () => {
    // Mk1 swings in 10 ticks, so `view.ts` reports permille in steps of 100. The dwells of
    // consecutive strokes stack at the shared tile — the sim starts the next stroke on the
    // very tick it finishes this one — so the last two frames of the outbound stroke and the
    // first two of the return are all the same pose, on the same tile. 200ms of dead stop.
    const arriving = [900, 1000].map((p) => armPose(Direction.East, GrabberTier.Mk1, 5, p));
    const leaving = [0, 100].map((p) => armPose(Direction.East, GrabberTier.Mk1, 0, p));
    const first = arriving[0]!;
    for (const pose of [...arriving, ...leaving]) {
      expect(pose.handX).toBeCloseTo(first.handX);
      expect(pose.handY).toBeCloseTo(first.handY);
      expect(pose.elbowX).toBeCloseTo(first.elbowX);
      expect(pose.elbowY).toBeCloseTo(first.elbowY);
      // Parked means parked at FULL extension, straight, on the tile centre.
      expect(pose.radius).toBeCloseTo(pose.reach);
    }
  });

  it('cruises at one constant rate through the middle, which a smoothstep never does', () => {
    const at = [0.35, 0.45, 0.55, 0.65].map(travelProgress);
    const steps = [at[1]! - at[0]!, at[2]! - at[1]!, at[3]! - at[2]!];
    expect(steps[1]!).toBeCloseTo(steps[0]!, 10);
    expect(steps[2]!).toBeCloseTo(steps[0]!, 10);
    // The curve this replaced, sampled identically: no two strides the same length. That is
    // the softest thing a sweep can do, and it is what a trapezoid exists to not do.
    const old = [0.35, 0.45, 0.55, 0.65].map(ease);
    expect(old[1]! - old[0]!).not.toBeCloseTo(old[2]! - old[1]!, 3);
  });

  it('travels FASTER than the curve it replaced — the stop is bought with speed', () => {
    // Smoothstep's peak rate is exactly 1.5 sweeps per stroke-time. Squeezing the same 180°
    // into the middle 70% at a constant cruise beats that, which matters: the complaint that
    // started item 094 was "not enough oomph", and a stop paid for with lethargy undoes it.
    let peak = 0;
    for (let t = 0; t < 1; t += 0.001) {
      peak = Math.max(peak, (travelProgress(t + 0.001) - travelProgress(t)) / 0.001);
    }
    expect(peak).toBeGreaterThan(1.8);
  });

  it('never stutters backwards', () => {
    let previous = -Infinity;
    for (let t = 0; t <= 1; t += 0.005) {
      const at = travelProgress(t);
      expect(at).toBeGreaterThanOrEqual(previous);
      previous = at;
    }
  });

  it('is antisymmetric about mid-stroke, so out and back mirror exactly', () => {
    for (const t of [0.05, 0.2, 0.37, 0.5, 0.62]) {
      expect(travelProgress(1 - t)).toBeCloseTo(1 - travelProgress(t));
    }
  });
});

describe('foldAmount — the elbow is a hinge, not a bow', () => {
  it('is straight through both dwells, so the hand is at full reach on its tile', () => {
    expect(foldAmount(0)).toBe(0);
    expect(foldAmount(SWING_DWELL)).toBe(0);
    expect(foldAmount(1 - SWING_DWELL)).toBe(0);
    expect(foldAmount(1)).toBe(0);
  });

  it('HOLDS one angle across the carry instead of swelling to a peak', () => {
    // The tuck used to be `sin(PI * phase)`: equal to its own maximum for exactly one instant
    // and changing on every other frame of the swing. A joint that is always somewhere in
    // between two postures reads as a bend in a flexible rod. This one is locked at 41.4°
    // for the whole traverse and locked straight either side of it.
    for (const t of [0.35, 0.45, 0.5, 0.55, 0.65]) expect(foldAmount(t)).toBe(1);
    const carrying = [400, 500, 600].map((p) => armPose(Direction.East, GrabberTier.Mk1, 5, p));
    const bend0 = Math.abs(carrying[0]!.upperAngle - carrying[0]!.foreAngle);
    for (const pose of carrying) {
      expect(pose.radius).toBeCloseTo(pose.reach * (1 - SWING_TUCK));
      expect(Math.abs(pose.upperAngle - pose.foreAngle)).toBeCloseTo(bend0);
    }
  });

  it('snaps rather than drifts: near-straight to near-folded in one Mk1 tick', () => {
    expect(foldAmount(0.2)).toBeLessThan(0.35);
    expect(foldAmount(0.3)).toBeGreaterThan(0.9);
  });

  it('is symmetric about mid-stroke, so the elbow never pops at the changeover', () => {
    // Paired with `travelProgress`'s antisymmetry, this is what makes the outbound and return
    // strokes show the identical bend at the identical phase.
    for (const t of [0.05, 0.2, 0.37, 0.5]) {
      expect(foldAmount(1 - t)).toBeCloseTo(foldAmount(t));
    }
  });
});

describe('gripAmount — the claw clamps while the arm is parked', () => {
  it('is finished closing before the hand has moved at all, anywhere in the stroke', () => {
    for (let permille = 0; permille <= 1000; permille += 10) {
      const phase = swingPhase(5, permille);
      if (phase > 0 && phase < 1) expect(gripAmount(5, permille)).toBe(1);
    }
  });

  it('is fully clamped by the second Mk1 tick, with the arm still on its tile', () => {
    expect(swingPhase(5, 200)).toBeLessThan(0.02);
    expect(gripAmount(5, 200)).toBe(1);
  });

  it('is linear, so the jaw runs at one rate and stops dead on its stop', () => {
    const at = [0.2, 0.4, 0.6].map((f) => gripAmount(5, 1000 * GRIP_FRACTION * f));
    expect(at[1]! - at[0]!).toBeCloseTo(at[2]! - at[1]!, 10);
    // A smoothstep over the same window decelerates onto its own stop, which is the single
    // most obviously soft thing an end effector can do.
    expect(ease(0.4) - ease(0.2)).not.toBeCloseTo(ease(0.6) - ease(0.4), 3);
  });
});
