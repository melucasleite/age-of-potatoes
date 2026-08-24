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
//   · THE GIMBAL. `clawAngle` has now been all three of `handAngle`, `foreAngle` and
//     `handAngle` again over three items, and the third time is for a reason the first two
//     did not have. Every one of those edits is one token wide and none of them changes a
//     parked arm by a pixel, so the only thing that can tell them apart is a test that
//     measures the head's motion across the MIDDLE of the stroke.

import { describe, expect, it } from 'vitest';
import { Direction, GrabberTier, grabberSpec } from '@snack/sim';

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

describe('clawAngle — the head is gimballed, not welded to the forearm', () => {
  /**
   * Every permille the sim can actually report for a tier — the real, discrete frame grid.
   *
   * Taken from `GRABBER_SPECS` rather than a copied-out table, because the tick count is
   * exactly the thing this suite must notice a change in: `grabbers.ts` never interpolates,
   * so `swingTicks` IS the frame rate of the arm. A hardcoded 10 would go on passing while a
   * retuned tier quietly drew its stroke in five frames.
   */
  function ticksOf(tier: number): number[] {
    const n = grabberSpec(tier as never)?.swingTicks ?? 0;
    expect(n).toBeGreaterThan(0);
    const out: number[] = [];
    for (let i = 0; i <= n; i++) out.push(Math.round((i * 1000) / n));
    return out;
  }
  function wrap(radians: number): number {
    let d = radians;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
  }

  it('is EXACTLY the forearm at every endpoint, so no parked arm moves a pixel', () => {
    // `toBe`, not `toBeCloseTo`, and it is not optimism: at an endpoint `foldAmount` is 0, so
    // `radius === reach`, `acos(1)` is a hard 0, the elbow lands on the pivot-hand chord and
    // `atan2` gives that chord's own angle back. The whole safety argument for this item is
    // this assertion — every resting pose and all 24 stall poses draw what they drew before.
    for (const dir of DIRS) {
      for (const tier of TIERS) {
        for (const held of [0, 5]) {
          for (const permille of [0, 1000]) {
            const pose = armPose(dir, tier, held, permille);
            expect(pose.clawAngle).toBe(pose.foreAngle);
          }
        }
      }
    }
  });

  it('holds the line of reach, so the elbow s fold never reaches the head', () => {
    // The one-line statement of the gimbal law. `foreAngle` carries the sweep AND the bend;
    // `clawAngle` carries only the sweep.
    for (const dir of DIRS) {
      for (const tier of TIERS) {
        for (const permille of ticksOf(tier)) {
          const pose = armPose(dir, tier, 5, permille);
          expect(pose.clawAngle).toBe(pose.handAngle);
        }
      }
    }
  });

  it('turns 180° per stroke and NEVER doubles back — today s arm turned 224.6°', () => {
    // The measurement that started this item. Sampled fine rather than on the tick grid,
    // because the reversal is what matters and a coarse grid can step straight over it.
    let head = 0;
    let fore = 0;
    let reversals = 0;
    let previousSign = 0;
    let a = armPose(Direction.East, GrabberTier.Mk1, 5, 0);
    for (let i = 1; i <= 2000; i++) {
      const b = armPose(Direction.East, GrabberTier.Mk1, 5, (i * 1000) / 2000);
      const step = wrap(b.clawAngle - a.clawAngle);
      head += Math.abs(step);
      fore += Math.abs(wrap(b.foreAngle - a.foreAngle));
      const sign = Math.sign(step);
      if (sign !== 0) {
        if (previousSign !== 0 && sign !== previousSign) reversals++;
        previousSign = sign;
      }
      a = b;
    }
    // Exactly the 180° it has to travel to present outward at the far tile, and not one
    // degree more. The forearm, over the same stroke, travels a quarter as much again.
    expect((head * 180) / Math.PI).toBeCloseTo(180, 4);
    expect((fore * 180) / Math.PI).toBeGreaterThan(220);
    // Zero reversals is the whole of "stabilized": a head that overshoots its aim and comes
    // back is a head that wags, which is what the owner was looking at.
    expect(reversals).toBe(0);
  });

  it('is the ONLY blend of the two angles that does not wag — k=0 is forced', () => {
    // The argument that actually settles the design, pinned so nobody "splits the difference"
    // later and reintroduces the fault at half strength.
    //
    // Every admissible law equals the two angles' common value at the endpoints, so the whole
    // family is `handAngle + k·bend` for constant k: k=0 is the head, k=1 is the forearm. But
    // `bend` is `foldAmount`, a plateau that RISES AND FALLS, so any k above zero puts a
    // rise-and-fall into the aim and the head reverses direction mid-stroke. Zero is not the
    // best value here, it is the only one.
    function sweepOf(k: number): { degrees: number; reversals: number } {
      let total = 0;
      let reversals = 0;
      let previousSign = 0;
      const at = (permille: number) => {
        const p = armPose(Direction.East, GrabberTier.Mk1, 5, permille);
        return p.handAngle + k * wrap(p.foreAngle - p.handAngle);
      };
      let a = at(0);
      for (let i = 1; i <= 2000; i++) {
        const b = at((i * 1000) / 2000);
        const step = wrap(b - a);
        total += Math.abs(step);
        const sign = Math.sign(step);
        if (sign !== 0) {
          if (previousSign !== 0 && sign !== previousSign) reversals++;
          previousSign = sign;
        }
        a = b;
      }
      return { degrees: (total * 180) / Math.PI, reversals };
    }

    const head = sweepOf(0);
    expect(head.degrees).toBeCloseTo(180, 4);
    expect(head.reversals).toBe(0);
    // Every other member of the family wags, and the parasitic rotation grows with k.
    let previousDegrees = head.degrees;
    for (const k of [0.25, 0.5, 0.75, 1]) {
      const blend = sweepOf(k);
      expect(blend.reversals).toBeGreaterThan(0);
      expect(blend.degrees).toBeGreaterThan(previousDegrees);
      previousDegrees = blend.degrees;
    }
    // k=1 is `foreAngle` itself — 224.6°, a quarter as much again as the 180° it achieves.
    expect(previousDegrees).toBeCloseTo(224.6, 1);
    // And every member really does hit the endpoints, which is why k had to be argued at all
    // rather than dismissed: the endpoint test alone cannot tell any of them apart.
    for (const k of [0, 0.25, 0.5, 1]) {
      for (const dir of DIRS) {
        for (const tier of TIERS) {
          const p = armPose(dir, tier, 5, 1000);
          expect(p.handAngle + k * wrap(p.foreAngle - p.handAngle)).toBe(p.clawAngle);
        }
      }
    }
  });

  it('does not wring the item in place while the hand is STOPPED on its tile', () => {
    // The sharpest symptom, and the one the owner could actually see: through the leading
    // dwell the hand has not moved and the jaws are shut on the item, so any head rotation is
    // the arm twisting the goods where they stand.
    //
    // Stated as a RATIO of two angles, deliberately. An earlier draft of this guard compared
    // the head's rotation in DEGREES against the hand's travel in PIXELS and asserted the
    // first was smaller — which happens to hold here, and is not a statement about anything.
    // Two angles over the same frames is the comparison that means something.
    const parked = armPose(Direction.East, GrabberTier.Mk1, 5, 0);
    let head = 0;
    let fore = 0;
    for (const permille of [100, 200]) {
      const pose = armPose(Direction.East, GrabberTier.Mk1, 5, permille);
      head = Math.max(head, Math.abs(wrap(pose.clawAngle - parked.clawAngle)));
      fore = Math.max(fore, Math.abs(wrap(pose.foreAngle - parked.foreAngle)));
    }
    // 2.4° against the forearm's 20.6° — the head does under an eighth of the twisting, and
    // all of what remains is the sweep itself, which by tick 2 has genuinely begun.
    expect((head * 180) / Math.PI).toBeLessThan(3);
    expect((fore * 180) / Math.PI).toBeGreaterThan(20);
    expect(head).toBeLessThan(fore / 8);
    // And through the dwell proper the head is not merely quiet but STOPPED, exactly as the
    // hand is: `travelProgress` is flat there and the head is now a function of nothing else.
    const stillOnTile = armPose(Direction.East, GrabberTier.Mk1, 5, 100);
    expect(stillOnTile.clawAngle).toBe(parked.clawAngle);
    expect(stillOnTile.handX).toBe(parked.handX);
  });

  it('settles onto its drop instead of overshooting and flicking back', () => {
    // Mk1's last three ticks. The forearm arrives 15.7° past its final aim and snaps back
    // while the hand covers its last 1.6px; the head must approach monotonically.
    const landed = armPose(Direction.East, GrabberTier.Mk1, 5, 1000);
    let previous = Infinity;
    for (const permille of [700, 800, 900, 1000]) {
      const pose = armPose(Direction.East, GrabberTier.Mk1, 5, permille);
      const off = Math.abs(wrap(pose.clawAngle - landed.clawAngle));
      expect(off).toBeLessThanOrEqual(previous);
      previous = off;
    }
    const late = armPose(Direction.East, GrabberTier.Mk1, 5, 800);
    expect(Math.abs((wrap(late.clawAngle - landed.clawAngle) * 180) / Math.PI)).toBeLessThan(5);
    // The curve it replaced, measured the same way, is on the wrong side of that fence.
    expect(Math.abs((wrap(late.foreAngle - landed.foreAngle) * 180) / Math.PI)).toBeGreaterThan(10);
  });

  it('is continuous across the changeover, unlike aiming at the tile being worked', () => {
    // The last frame of the outbound stroke and the first of the return are the SAME instant
    // on the SAME tile, inside stacked dwells. A head that aims at "the tile this stroke ends
    // on" — the most literal reading of the owner's words — swaps target there and snaps a
    // full 180°. This one cannot: both frames are endpoints, so both are `foreAngle`.
    for (const dir of DIRS) {
      for (const tier of TIERS) {
        const arriving = armPose(dir, tier, 5, 1000);
        const leaving = armPose(dir, tier, 0, 0);
        expect(wrap(arriving.clawAngle - leaving.clawAngle)).toBeCloseTo(0, 12);
        const home = armPose(dir, tier, 0, 1000);
        const lifting = armPose(dir, tier, 5, 0);
        expect(wrap(home.clawAngle - lifting.clawAngle)).toBeCloseTo(0, 12);
      }
    }
  });

  it('breaks the wrist by the elbow s own bend, and no more', () => {
    // The honest cost of the gimbal, fenced. The claw pivots on a pin that sits ON the
    // forearm's centreline — `grabbers.ts` takes the wrist from `foreAngle` and must go on
    // doing so — and swings its far end `clawW * sin(bend)` off the bar's axis. At the
    // deepest tuck that is 41.4° and 6.6px, under the 16px-tall claw covering an 8px bar.
    // The S-curve bug this must not become displaced the claw's ROOT by the same 6.6px —
    // the identical `clawW * sin(bend)`. Magnitude cannot separate the fix from the bug; only
    // which END of the part moves can, which is what the wrist-on-the-forearm test pins.
    let worst = 0;
    for (const dir of DIRS) {
      for (const tier of TIERS) {
        for (const held of [0, 5]) {
          for (const permille of ticksOf(tier)) {
            const pose = armPose(dir, tier, held, permille);
            worst = Math.max(worst, Math.abs(wrap(pose.clawAngle - pose.foreAngle)));
          }
        }
      }
    }
    // `acos(1 - SWING_TUCK)` — the elbow's break, which is exactly what the head declines to
    // inherit. Deepen `SWING_TUCK` and this moves with it, on purpose.
    expect((worst * 180) / Math.PI).toBeCloseTo((Math.acos(1 - SWING_TUCK) * 180) / Math.PI, 6);
    expect(ARM_SLICE.clawW * Math.sin(worst)).toBeLessThan(TILE_PX / 4);
  });

  it('aims through the tile centre at both ends, which is "pointing at the object"', () => {
    // The claw's tip is `clawW` out from the wrist along the head's aim, and the wrist is
    // `clawW` back from the hand along the forearm. When the two angles agree — both
    // endpoints — the tip lands dead on the hand point, which `armPose` puts dead on the
    // tile centre. Payload-level, target-tracking and work-axis all miss it by 20px here.
    for (const dir of DIRS) {
      for (const tier of TIERS) {
        const at = sourceOffset(dir, tier);
        for (const [held, permille, tx, ty] of [
          [0, 1000, at.x, at.y],
          [5, 0, at.x, at.y],
          [5, 1000, -at.x, -at.y],
          [0, 0, -at.x, -at.y],
        ] as [number, number, number, number][]) {
          const pose = armPose(dir, tier, held, permille);
          const wristX = pose.handX - Math.cos(pose.foreAngle) * ARM_SLICE.clawW;
          const wristY = pose.handY - Math.sin(pose.foreAngle) * ARM_SLICE.clawW;
          const tipX = wristX + Math.cos(pose.clawAngle) * ARM_SLICE.clawW;
          const tipY = wristY + Math.sin(pose.clawAngle) * ARM_SLICE.clawW;
          expect(Math.hypot(tipX - tx, tipY - ty)).toBeCloseTo(0, 9);
        }
      }
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
