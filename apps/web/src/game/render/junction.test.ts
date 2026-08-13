// The structural gate for belt junctions, and it pins the one property that matters.
//
// A junction's whole job on screen is to say which faces the run passes through. Get the turn
// wrong and the tee closes a face a belt actually uses — the tile renders perfectly, the sim
// keeps splitting goods correctly, and the picture quietly contradicts the factory. That is the
// same failure `pipes.test.ts` exists for, so it is pinned the same way.
//
// Pixi-free by construction: `junction.ts` imports nothing but the sim's types and two pure
// helpers, which is why it is a separate module from the layer that draws it.

import { describe, expect, it } from 'vitest';

import { Direction } from '@snack/sim';
import type { BeltView } from '@snack/sim';

import { junctionMask, junctionQuarterTurns, JunctionSide } from './junction';

/** The faces the tee opens at rest: the run west-to-east, plus the branch leaving south. */
const OPEN_AT_REST = JunctionSide.West | JunctionSide.East | JunctionSide.South;

/** Rotate a mask `quarterTurns` clockwise — the inverse of what the renderer does to a sprite. */
function rotate(mask: number, quarterTurns: number): number {
  let out = mask;
  for (let i = 0; i < quarterTurns; i++) out = ((out << 1) | (out >> 3)) & 0b1111;
  return out;
}

function belt(tileX: number, tileY: number, dir: number, lengthTiles: number): BeltView {
  return {
    id: 1,
    tileX,
    tileY,
    dir,
    lengthTiles,
    tier: 1,
    itemCount: 0,
    itemDist: [],
    itemType: [],
  };
}

describe('junction auto-tiling', () => {
  it('answers every mask with a legal quarter turn', () => {
    for (let mask = 0; mask < 16; mask++) {
      const turns = junctionQuarterTurns(mask);
      expect(turns).toBeGreaterThanOrEqual(0);
      expect(turns).toBeLessThan(4);
    }
  });

  // THE ACTUAL CONTRACT. Every face carrying belt must end up on an open side of the tee.
  it('never closes a face that has a belt on it', () => {
    for (let mask = 0; mask < 0b1111; mask++) {
      const open = rotate(OPEN_AT_REST, junctionQuarterTurns(mask));
      expect(mask & ~open).toBe(0);
    }
  });

  // The one mask that cannot be satisfied, stated rather than left to be discovered. A tee has
  // three arms and a four-way junction has four; the seam is the honest cost of not inventing
  // a frame the atlas does not contain.
  it('falls back to the canonical turn when all four faces are in use', () => {
    expect(junctionQuarterTurns(0b1111)).toBe(0);
  });

  it('is stable: the same mask always answers the same turn', () => {
    for (let mask = 0; mask < 16; mask++) {
      expect(junctionQuarterTurns(mask)).toBe(junctionQuarterTurns(mask));
    }
  });
});

describe('junction neighbours', () => {
  it('finds a belt whose far end lies against the junction', () => {
    // A five-tile belt running east from x=0, so it covers x=0..4 on row 3. The junction at
    // (5,3) is fed through its WEST face by the belt tile at (4,3).
    const belts = [belt(0, 3, Direction.East, 5)];
    expect(junctionMask(belts, 5, 3)).toBe(JunctionSide.West);
  });

  it('finds a belt that leaves the junction, not only one that arrives', () => {
    // Direction is not consulted for the silhouette — see the note in `junction.ts`. A belt
    // starting AT the neighbour tile and running away still puts iron on that face.
    const belts = [belt(6, 3, Direction.East, 4)];
    expect(junctionMask(belts, 5, 3)).toBe(JunctionSide.East);
  });

  it('ignores a belt that merely passes nearby', () => {
    const belts = [belt(0, 9, Direction.East, 20)];
    expect(junctionMask(belts, 5, 3)).toBe(0);
  });

  it('ignores the tile just past a belt’s end', () => {
    // Covers x=0..2 only. (4,3) is the neighbour, and the belt stops one tile short of it.
    const belts = [belt(0, 3, Direction.East, 3)];
    expect(junctionMask(belts, 5, 3)).toBe(0);
  });

  it('reads a three-way merge as three faces, and turns the tee to fit', () => {
    const belts = [
      belt(0, 3, Direction.East, 5), // west face
      belt(5, 0, Direction.South, 3), // north face
      belt(5, 4, Direction.South, 3), // south face
    ];
    const mask = junctionMask(belts, 5, 3);
    expect(mask).toBe(JunctionSide.West | JunctionSide.North | JunctionSide.South);

    const open = rotate(OPEN_AT_REST, junctionQuarterTurns(mask));
    expect(mask & ~open).toBe(0);
  });

  it('does not double-count two belts against the same face', () => {
    const belts = [belt(0, 3, Direction.East, 5), belt(4, 3, Direction.East, 1)];
    expect(junctionMask(belts, 5, 3)).toBe(JunctionSide.West);
  });

  it('counts vertical runs on the column, not the row', () => {
    const belts = [belt(5, 0, Direction.South, 3)];
    expect(junctionMask(belts, 5, 3)).toBe(JunctionSide.North);
    expect(junctionMask(belts, 6, 3)).toBe(0);
  });
});
