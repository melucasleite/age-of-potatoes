// The shore mask table ([[077]]), pinned the way `junction.test.ts` pins the tee.
//
// What fails QUIETLY without this:
//
//   · A TURN TABLE OFF BY ONE ROTATION. Every bank still draws a shore frame — just with
//     the land side facing into the pond, which reads as "the art came back inverted"
//     rather than as a table bug, and gets filed against the wrong lane.
//   · A MASK WITH NO ANSWER. The degenerate ponds (1-wide channels, nubs, landlocked
//     puddles) cannot exist today, which is exactly why the case for them would rot
//     unnoticed until a reservoir shape ships that can.
//   · CLASSIFICATION EATING THE POND'S CENTRE. A variant for every water tile instead of
//     the perimeter would bake shore art across the middle of the pond.

import { describe, expect, it } from 'vitest';
import { worldTileKey } from '@snack/sim';

import {
  SHORE_VARIANTS,
  ShoreCorner,
  ShoreSide,
  classifyShore,
  shoreVariant,
  shoreVariantIndex,
} from './shore';

describe('shoreVariant', () => {
  it('answers the authored base orientations with zero turns', () => {
    // The art lane's convention, verbatim: edge = land SOUTH, outer = land SOUTH+EAST,
    // inner = land ONLY at the SOUTH-EAST diagonal.
    expect(shoreVariant(ShoreSide.South, 0)).toEqual({ frame: 'edge', quarterTurns: 0 });
    expect(shoreVariant(ShoreSide.South | ShoreSide.East, 0)).toEqual({
      frame: 'outer',
      quarterTurns: 0,
    });
    expect(shoreVariant(0, ShoreCorner.SouthEast)).toEqual({ frame: 'inner', quarterTurns: 0 });
  });

  it('turns the edge clockwise: land S, W, N, E', () => {
    expect(shoreVariant(ShoreSide.West, 0)).toEqual({ frame: 'edge', quarterTurns: 1 });
    expect(shoreVariant(ShoreSide.North, 0)).toEqual({ frame: 'edge', quarterTurns: 2 });
    expect(shoreVariant(ShoreSide.East, 0)).toEqual({ frame: 'edge', quarterTurns: 3 });
  });

  it('turns the outer corner clockwise: land SE, SW, NW, NE pairs', () => {
    expect(shoreVariant(ShoreSide.South | ShoreSide.West, 0)).toEqual({
      frame: 'outer',
      quarterTurns: 1,
    });
    expect(shoreVariant(ShoreSide.North | ShoreSide.West, 0)).toEqual({
      frame: 'outer',
      quarterTurns: 2,
    });
    expect(shoreVariant(ShoreSide.North | ShoreSide.East, 0)).toEqual({
      frame: 'outer',
      quarterTurns: 3,
    });
  });

  it('turns the inner corner clockwise: diagonal SE, SW, NW, NE', () => {
    expect(shoreVariant(0, ShoreCorner.SouthWest)).toEqual({ frame: 'inner', quarterTurns: 1 });
    expect(shoreVariant(0, ShoreCorner.NorthWest)).toEqual({ frame: 'inner', quarterTurns: 2 });
    expect(shoreVariant(0, ShoreCorner.NorthEast)).toEqual({ frame: 'inner', quarterTurns: 3 });
  });

  it('keeps the pond centre bare water', () => {
    expect(shoreVariant(0, 0)).toEqual({ frame: 'water', quarterTurns: 0 });
  });

  it('cardinal land outranks any diagonal beside it', () => {
    // A straight bank whose land continues around the corner: the edge frame's own corner
    // pixels carry that; the wedge is only for a diagonal with open water both sides.
    expect(shoreVariant(ShoreSide.South, ShoreCorner.SouthEast | ShoreCorner.SouthWest)).toEqual({
      frame: 'edge',
      quarterTurns: 0,
    });
  });

  it('pins the degenerate ponds no reservoir can make yet', () => {
    // A 1-wide channel (opposite banks): one bank drawn, S-first priority.
    expect(shoreVariant(ShoreSide.North | ShoreSide.South, 0)).toEqual({
      frame: 'edge',
      quarterTurns: 0,
    });
    expect(shoreVariant(ShoreSide.East | ShoreSide.West, 0)).toEqual({
      frame: 'edge',
      quarterTurns: 1,
    });
    // A dead-end nub (three banks): reads as the first fully-land outer corner.
    expect(shoreVariant(ShoreSide.North | ShoreSide.East | ShoreSide.South, 0)).toEqual({
      frame: 'outer',
      quarterTurns: 0,
    });
    // A landlocked one-tile puddle: no direction is more honest than any other.
    expect(
      shoreVariant(ShoreSide.North | ShoreSide.East | ShoreSide.South | ShoreSide.West, 0),
    ).toEqual({ frame: 'water', quarterTurns: 0 });
  });

  it('is total: every mask pair answers a frame and a legal turn', () => {
    for (let cardinal = 0; cardinal < 16; cardinal++) {
      for (let diagonal = 0; diagonal < 16; diagonal++) {
        const variant = shoreVariant(cardinal, diagonal);
        expect(['water', 'edge', 'outer', 'inner']).toContain(variant.frame);
        expect(variant.quarterTurns).toBeGreaterThanOrEqual(0);
        expect(variant.quarterTurns).toBeLessThanOrEqual(3);
        // Every non-water answer indexes a baked texture; water never does.
        const index = shoreVariantIndex(variant);
        if (variant.frame === 'water') expect(index).toBe(-1);
        else expect(SHORE_VARIANTS[index]).toEqual(variant);
      }
    }
  });
});

describe('classifyShore', () => {
  /** A pond from rectangles, the same shape the reservoir sync hands the classifier. */
  function pond(rects: readonly { x: number; y: number; w: number; h: number }[]): {
    tiles: [number, number][];
    waterAt: (x: number, y: number) => boolean;
  } {
    const keys = new Set<number>();
    const tiles: [number, number][] = [];
    for (const r of rects) {
      for (let ty = r.y; ty < r.y + r.h; ty++) {
        for (let tx = r.x; tx < r.x + r.w; tx++) {
          if (keys.has(worldTileKey(tx, ty))) continue;
          keys.add(worldTileKey(tx, ty));
          tiles.push([tx, ty]);
        }
      }
    }
    return { tiles, waterAt: (x, y) => keys.has(worldTileKey(x, y)) };
  }

  function variantAt(map: Map<number, number>, x: number, y: number) {
    const index = map.get(worldTileKey(x, y));
    return index === undefined ? null : SHORE_VARIANTS[index];
  }

  it('banks a rectangular pond: four outers, four runs of edge, bare centre', () => {
    const { tiles, waterAt } = pond([{ x: 4, y: 4, w: 3, h: 3 }]);
    const map = classifyShore(tiles, waterAt);

    // Corners, clockwise from top-left. Land NW / NE / SE / SW of the tile.
    expect(variantAt(map, 4, 4)).toEqual({ frame: 'outer', quarterTurns: 2 });
    expect(variantAt(map, 6, 4)).toEqual({ frame: 'outer', quarterTurns: 3 });
    expect(variantAt(map, 6, 6)).toEqual({ frame: 'outer', quarterTurns: 0 });
    expect(variantAt(map, 4, 6)).toEqual({ frame: 'outer', quarterTurns: 1 });

    // Edge midpoints: the land is off-pond, so the turn faces it.
    expect(variantAt(map, 5, 4)).toEqual({ frame: 'edge', quarterTurns: 2 });
    expect(variantAt(map, 6, 5)).toEqual({ frame: 'edge', quarterTurns: 3 });
    expect(variantAt(map, 5, 6)).toEqual({ frame: 'edge', quarterTurns: 0 });
    expect(variantAt(map, 4, 5)).toEqual({ frame: 'edge', quarterTurns: 1 });

    // The centre is not in the map at all — it stays terrain_water by absence.
    expect(map.has(worldTileKey(5, 5))).toBe(false);
    expect(map.size).toBe(8);
  });

  it('cuts an inner corner where two rectangles meet in an L', () => {
    // A 2-wide L: the concave tile has water N/E and land only at its SE diagonal…
    const { tiles, waterAt } = pond([
      { x: 4, y: 4, w: 4, h: 2 },
      { x: 4, y: 6, w: 2, h: 2 },
    ]);
    const map = classifyShore(tiles, waterAt);
    // …which is (5,5): open water on every side, land at (6,6) alone.
    expect(variantAt(map, 5, 5)).toEqual({ frame: 'inner', quarterTurns: 0 });
  });
});
