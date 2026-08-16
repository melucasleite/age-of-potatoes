// The belt auto-tiler, pinned over every mask it can be asked about.
//
// THE ORIENTATION MATHS IS RE-DERIVED HERE, DELIBERATELY, rather than imported from the module
// under test. `belt-shape.ts` builds its tables by applying a flip and a rotation to one
// authored description per frame; a test that imported those same helpers would agree with a
// broken `rotateSide` as happily as with a working one. So this file spells the compass out in
// letters and turns it by hand, and the two only agree if both are right.
//
// The strong assertion is not "the table says corner". It is: TAKE THE FRAME THE MODULE CHOSE,
// APPLY THE FLIP AND THE TURNS IT ASKED FOR, AND CHECK THE ARMS LAND ON THE SIDES THE CALLER
// ACTUALLY HAS — including which one the goods leave by. That is what makes a wrong answer a
// failing test rather than a chevron pointing upstream on one rotation in eight.

import { describe, expect, it } from 'vitest';

import { Direction } from '@snack/sim';
import type { BeltView } from '@snack/sim';

import { beltShape, BeltSide, classifyBeltShapes } from './belt-shape';
import type { BeltShapeKind, BeltShapeVariant } from './belt-shape';

type Compass = 'N' | 'E' | 'S' | 'W';

const BIT: Record<Compass, number> = {
  N: BeltSide.North,
  E: BeltSide.East,
  S: BeltSide.South,
  W: BeltSide.West,
};

const ALL: readonly Compass[] = ['N', 'E', 'S', 'W'];

/** One quarter turn clockwise, written out as the fact it is. */
const CW: Record<Compass, Compass> = { N: 'E', E: 'S', S: 'W', W: 'N' };
/** A flip about the horizontal midline: top and bottom swap, left and right do not move. */
const FLIP: Record<Compass, Compass> = { N: 'S', S: 'N', E: 'E', W: 'W' };

function turn(side: Compass, quarterTurns: number): Compass {
  let out = side;
  for (let i = 0; i < quarterTurns; i++) out = CW[out];
  return out;
}

/** The sprite's local scale applies inside its rotation, so: flip first, then turn. */
function place(side: Compass, at: BeltShapeVariant): Compass {
  return turn(at.mirror ? FLIP[side] : side, at.quarterTurns);
}

function maskOf(sides: readonly Compass[]): number {
  return sides.reduce((mask, side) => mask | BIT[side], 0);
}

function sidesOf(mask: number): Compass[] {
  return ALL.filter((side) => (mask & BIT[side]) !== 0);
}

/**
 * How each frame is authored, in its own base orientation. This is the art contract, and it is
 * the only place in the test that knows it:
 *
 *   straight — runs west to east.
 *   corner   — in from the west, out through the south.
 *   tee      — runs west to east, a branch joining from the south.
 *   teeMerge — in from the west AND the east, out through the south.
 */
const AUTHORED: Record<BeltShapeKind, { out: Compass; ins: readonly Compass[] }> = {
  straight: { out: 'E', ins: ['W'] },
  corner: { out: 'S', ins: ['W'] },
  tee: { out: 'E', ins: ['W', 'S'] },
  teeMerge: { out: 'S', ins: ['W', 'E'] },
};

/** Where a frame's arms actually land once the module's flip and turns are applied. */
function placed(variant: BeltShapeVariant): { out: Compass; ins: Compass[] } {
  const authored = AUTHORED[variant.kind];
  return {
    out: place(authored.out, variant),
    ins: authored.ins.map((side) => place(side, variant)),
  };
}

describe('beltShape', () => {
  it('answers every mask it can be asked about, with a turn a sprite can use', () => {
    for (let out = 0; out < 16; out++) {
      for (let ins = 0; ins < 16; ins++) {
        const shape = beltShape(out, ins);
        expect(['straight', 'corner', 'tee', 'teeMerge']).toContain(shape.kind);
        expect(shape.quarterTurns).toBeGreaterThanOrEqual(0);
        expect(shape.quarterTurns).toBeLessThanOrEqual(3);
        expect(typeof shape.mirror).toBe('boolean');
      }
    }
  });

  it('never draws the goods leaving by a side they do not leave by', () => {
    // The whole reason this is flow-driven rather than geometry-driven: the art has arrows on
    // it. Over every legal call, the chosen frame's exit arm lands on the caller's exit side.
    for (const out of ALL) {
      for (let ins = 0; ins < 16; ins++) {
        const shape = beltShape(BIT[out], ins);
        expect({ out, ins, placed: placed(shape).out }).toEqual({
          out,
          ins,
          placed: out,
        });
      }
    }
  });

  it('puts a frame arm on exactly the sides that feed it, wherever one exists', () => {
    for (const out of ALL) {
      for (let insMask = 0; insMask < 16; insMask++) {
        // A belt pointing back into this tile's exit face is a nose-to-nose deadlock, not an
        // arm — the module drops that bit, so the test compares against the same reduced set.
        const ins = sidesOf(insMask & ~BIT[out]);
        const shape = beltShape(BIT[out], insMask);
        const landed = placed(shape);
        const back = turn(out, 2);

        if (shape.kind === 'straight') {
          // Straight is the answer for a bare stub and for the middle of a run alike; either
          // way the only in-arm it has is the one behind it.
          expect(landed.ins).toEqual([back]);
          expect(ins.length === 0 || (ins.length === 1 && ins[0] === back)).toBe(true);
          continue;
        }

        if (ins.length === 3) {
          // The four-armed concession: no cross frame exists, so one feeder meets the plate.
          expect(shape.kind).toBe('tee');
          expect(new Set(ins)).toEqual(new Set([...landed.ins, ...oddOneOut(landed.ins, ins)]));
          expect(landed.ins.every((side) => ins.includes(side))).toBe(true);
          continue;
        }

        expect(new Set(landed.ins)).toEqual(new Set(ins));
      }
    }
  });

  it('bends a right turn and a left turn out of the one authored corner', () => {
    // Travelling east: leaving south is the authored frame, leaving north is its mirror. Both
    // keep the entering chevrons pointing east, which is the property the mirror buys.
    const right = beltShape(BeltSide.South, BeltSide.West);
    expect(right).toEqual({ kind: 'corner', quarterTurns: 0, mirror: false });

    const left = beltShape(BeltSide.North, BeltSide.West);
    expect(left.kind).toBe('corner');
    expect(left.mirror).toBe(true);
    expect(placed(left)).toEqual({ out: 'N', ins: ['W'] });
  });

  it('draws a side feed and a head-on merge as different tees', () => {
    // A line running east with a branch joining from the south: through-run kept.
    const sideFeed = beltShape(BeltSide.East, BeltSide.West | BeltSide.South);
    expect(sideFeed).toEqual({ kind: 'tee', quarterTurns: 0, mirror: false });

    // Two lines arriving head-on and leaving by the stem: a different frame entirely, because
    // its two feeding arms both point inward and the through-run tee's do not.
    const headOn = beltShape(BeltSide.South, BeltSide.West | BeltSide.East);
    expect(headOn).toEqual({ kind: 'teeMerge', quarterTurns: 0, mirror: false });
  });

  it('reads the owner screenshot: a line joining a vertical run from the east', () => {
    // 2026-08-16: "a vertical express run with a horizontal line arriving from the right".
    // Goods run north to south; a second belt delivers into a mid-tile through its east face.
    const shape = beltShape(BeltSide.South, BeltSide.North | BeltSide.East);
    expect(shape.kind).toBe('tee');
    expect(placed(shape)).toEqual({ out: 'S', ins: ['N', 'E'] });
  });

  it('is stable: the same mask always answers the same way', () => {
    for (let out = 0; out < 16; out++) {
      for (let ins = 0; ins < 16; ins++) {
        expect(beltShape(out, ins)).toEqual(beltShape(out, ins));
      }
    }
  });

  it('falls back to straight for a direction this build has never heard of', () => {
    expect(beltShape(0, BeltSide.West)).toEqual({
      kind: 'straight',
      quarterTurns: 0,
      mirror: false,
    });
    // Two bits set at once is not a compass direction either.
    expect(beltShape(BeltSide.North | BeltSide.East, 0).kind).toBe('straight');
  });
});

/** The feeder the four-armed concession left out — for the set comparison above. */
function oddOneOut(drawn: readonly Compass[], all: readonly Compass[]): Compass[] {
  return all.filter((side) => !drawn.includes(side));
}

// ── the world pass ──────────────────────────────────────────────────────────────────────

let nextId = 1;

function belt(
  tileX: number,
  tileY: number,
  dir: Direction,
  lengthTiles: number,
  tier = 1,
): BeltView {
  return {
    id: nextId++,
    tileX,
    tileY,
    dir,
    lengthTiles,
    tier,
    itemCount: 0,
    itemDist: [],
    itemType: [],
    throughputSubtilesPer100Ticks: 0,
  };
}

describe('classifyBeltShapes', () => {
  it('leaves a plain run alone — nothing to draw over it', () => {
    expect(classifyBeltShapes([belt(2, 2, Direction.East, 6)])).toEqual([]);
  });

  it('leaves two belts laid end to end alone: that is a longer run, not a bend', () => {
    const belts = [belt(2, 2, Direction.East, 3), belt(5, 2, Direction.East, 3)];
    expect(classifyBeltShapes(belts)).toEqual([]);
  });

  it('finds the elbow where a run turns, on the second leg', () => {
    // East along y=2 into (5,2), then south. The elbow is the first tile of the second leg —
    // which is exactly where item 082 said the corner frame belonged, and why nothing drew it.
    const belts = [belt(2, 2, Direction.East, 3), belt(5, 2, Direction.South, 4)];
    const found = classifyBeltShapes(belts);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ tileX: 5, tileY: 2, tier: 1 });
    expect(found[0]!.shape).toEqual({ kind: 'corner', quarterTurns: 0, mirror: false });
  });

  it('finds a tee in the MIDDLE of a run, not only at its head', () => {
    // The sim hands off into whatever belt covers the exit tile, at whatever index that is —
    // so a line can join another one halfway along, and the shape has to be found there.
    const trunk = belt(5, 0, Direction.South, 6, 3);
    const spur = belt(8, 3, Direction.West, 3, 3);
    const found = classifyBeltShapes([trunk, spur]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ tileX: 5, tileY: 3, tier: 3, beltId: trunk.id });
    expect(found[0]!.shape.kind).toBe('tee');
  });

  it('finds a head-on merge where two lines arrive at the stem of a third', () => {
    const west = belt(1, 4, Direction.East, 3);
    const east = belt(7, 4, Direction.West, 3);
    const stem = belt(4, 4, Direction.South, 3);
    const found = classifyBeltShapes([west, east, stem]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ tileX: 4, tileY: 4, beltId: stem.id });
    expect(found[0]!.shape).toEqual({ kind: 'teeMerge', quarterTurns: 0, mirror: false });
  });

  it('draws no bend where two belts stare at each other', () => {
    // Nose to nose: the sim hands off nothing, the player sees a jam, and a bend drawn here
    // would suggest the goods have somewhere to go.
    const belts = [belt(1, 1, Direction.East, 3), belt(4, 1, Direction.West, 3)];
    expect(classifyBeltShapes(belts)).toEqual([]);
  });

  it('ignores a belt whose exit tile is its own', () => {
    // A one-tile belt pointing at itself cannot happen, but a ring closing onto its own start
    // can be built; the sim declines that hand-off, so no arm and no frame.
    const ring = belt(3, 3, Direction.East, 1);
    expect(classifyBeltShapes([ring])).toEqual([]);
  });

  it('carries each shape tile’s own tier, not the tier of whatever fed it', () => {
    // A basic spur joining an express trunk must not repaint the trunk's bend in yellow.
    const trunk = belt(5, 0, Direction.South, 6, 3);
    const spur = belt(8, 3, Direction.West, 3, 1);
    const found = classifyBeltShapes([trunk, spur]);
    expect(found).toHaveLength(1);
    expect(found[0]!.tier).toBe(3);
  });

  it('answers a four-way with one tee rather than a hole in the picture', () => {
    const trunk = belt(5, 0, Direction.South, 6);
    const fromWest = belt(2, 3, Direction.East, 3);
    const fromEast = belt(8, 3, Direction.West, 3);
    const found = classifyBeltShapes([trunk, fromWest, fromEast]);
    expect(found).toHaveLength(1);
    expect(found[0]!.shape.kind).toBe('tee');
    expect(found[0]).toMatchObject({ tileX: 5, tileY: 3 });
  });
});
