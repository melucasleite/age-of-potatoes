// The grabber body's two tables ([[082]]), pinned headless.
//
// What fails QUIETLY without this:
//
//   · THE SIGN. `dir` is the DROP side; the claw opens toward the PICKUP side. Written
//     with the sign flipped, every arm in the factory faces its destination — perfectly
//     plausible on screen, wrong about the one fact the reskin exists to show, and
//     invisible to anyone who has not read `grabberSourceTile`.
//   · A TIER WITHOUT A FRAME. A new tier in `data.ts` must arrive named by its own slug,
//     not fall silently to Mk1's paint.

import { describe, expect, it } from 'vitest';
import { Direction, GRABBER_SPECS, GrabberTier } from '@snack/sim';

import { grabberBodyFrame, grabberBodyRotation } from './grabber-facing';

describe('grabberBodyFrame', () => {
  it('names each tier by its own slug', () => {
    expect(grabberBodyFrame(GrabberTier.Mk1)).toBe('grabber_mk1');
    expect(grabberBodyFrame(GrabberTier.Mk2)).toBe('grabber_mk2');
    expect(grabberBodyFrame(GrabberTier.Long)).toBe('grabber_long');
  });

  it('derives from GRABBER_SPECS, so a new tier cannot arrive unnamed', () => {
    for (const spec of GRABBER_SPECS) {
      expect(grabberBodyFrame(spec.tier as number)).toBe(spec.slug.split('-').join('_'));
    }
  });

  it('dresses an unknown tier as Mk1 rather than magenta', () => {
    expect(grabberBodyFrame(99)).toBe('grabber_mk1');
  });
});

describe('grabberBodyRotation', () => {
  it('faces the pickup tile: the -dir side of the arm', () => {
    // A WEST-pointing grabber drops west and PICKS east — the authored base, unturned.
    // (`toBeCloseTo`: atan2 answers -0 here, and a signed zero is still no turn at all.)
    expect(grabberBodyRotation(Direction.West)).toBeCloseTo(0);
    // Drops east, picks west: half a turn.
    expect(Math.abs(grabberBodyRotation(Direction.East))).toBeCloseTo(Math.PI);
    // Drops north, picks south: the claw turns down-screen — +y, a positive quarter.
    expect(grabberBodyRotation(Direction.North)).toBeCloseTo(Math.PI / 2);
    // Drops south, picks north.
    expect(grabberBodyRotation(Direction.South)).toBeCloseTo(-Math.PI / 2);
  });

  it('a direction this build never heard of keeps the authored east face', () => {
    expect(grabberBodyRotation(999)).toBe(0);
  });
});
