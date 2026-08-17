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
  SWING_TUCK,
  armPose,
  ease,
  gripAmount,
  reachPxOf,
  reachTilesOf,
  strokeProgress,
  sweepSign,
  swingPhase,
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

  it('changes over the first quarter of the stroke and holds after', () => {
    expect(gripAmount(7, 0)).toBeCloseTo(0);
    expect(gripAmount(7, 1000 * GRIP_FRACTION)).toBeCloseTo(1);
    expect(gripAmount(7, 600)).toBeCloseTo(1);
    expect(gripAmount(0, 0)).toBeCloseTo(1);
    expect(gripAmount(0, 600)).toBeCloseTo(0);
  });

  it('shuts while the hand is still essentially over the item', () => {
    // The whole point of easing the ARC and not the grip: by the time the claw is closed,
    // the hand has covered well under a fifth of the sweep.
    expect(swingPhase(7, 1000 * GRIP_FRACTION)).toBeLessThan(0.2);
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
