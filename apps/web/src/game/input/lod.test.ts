// The cheap structural gate for the flow LOD.
//
// Verification here is deliberately light (AGENTS.md: "if it works, it works"), so this pins
// only the things that fail QUIETLY — where the picture keeps rendering and the far view just
// quietly says something untrue about the factory:
//
//   · AN EMPTY BELT DOES NOT SCROLL. This is the whole value of the zoomed-out view: a
//     stalled line has to be the one that stopped moving. A surface that keeps crawling on a
//     dead belt is not a degraded instrument, it is a lying one, and nothing throws.
//   · A BUSIER BELT SCROLLS FASTER. If the rate stopped tracking load, the far view would
//     still look plausible — every belt moving, none of them saying anything.
//   · The rate never exceeds the belt's real speed. A surface outrunning its own goods is
//     the same lie in the other direction.
//   · The threshold sits between the two zoom rungs it was derived for, and the ladder has
//     no rung in between. An off-by-one here silently switches instruments at the zoom the
//     game is normally played at.
//
// Everything under test is pure arithmetic. No DOM, no camera, no Pixi.

import { describe, expect, it } from 'vitest';
import { BELT_ITEM_SPACING_SUBTILES, SUBTILE, TICKS_PER_SECOND } from '@snack/sim';

import { ZOOM_LEVELS } from '../render/camera';
import {
  BELT_ITEM_LOD_MIN_ZOOM,
  beltFlowScrollPxPerSecond,
  beltItemsVisibleAt,
  beltLoadPermille,
} from './lod';

/** 16px tiles, the only tile size this game has. Kept local so the test states its own units. */
const TILE_PX = 16;

/** Basic / fast / express, from `BELT_SPECS`. Restated so a balance change fails loudly here. */
const BASIC = 320;
const EXPRESS = 1280;

function scroll(speedPer100Ticks: number, itemCount: number, lengthTiles: number): number {
  return beltFlowScrollPxPerSecond(
    speedPer100Ticks,
    itemCount,
    lengthTiles,
    TICKS_PER_SECOND,
    SUBTILE,
    TILE_PX,
    BELT_ITEM_SPACING_SUBTILES,
  );
}

/** Items a belt of this many tiles holds shoulder to shoulder. */
function capacity(lengthTiles: number): number {
  return Math.floor((lengthTiles * SUBTILE) / BELT_ITEM_SPACING_SUBTILES);
}

describe('belt load', () => {
  it('is zero on an empty belt and full when it is packed', () => {
    expect(beltLoadPermille(0, 8, SUBTILE, BELT_ITEM_SPACING_SUBTILES)).toBe(0);
    expect(beltLoadPermille(capacity(8), 8, SUBTILE, BELT_ITEM_SPACING_SUBTILES)).toBe(1000);
  });

  it('never exceeds full, however many items the sim reports', () => {
    const packed = capacity(4);
    expect(beltLoadPermille(packed * 3, 4, SUBTILE, BELT_ITEM_SPACING_SUBTILES)).toBe(1000);
  });

  it('refuses to divide by a belt with no length or no spacing', () => {
    expect(beltLoadPermille(5, 0, SUBTILE, BELT_ITEM_SPACING_SUBTILES)).toBe(0);
    expect(beltLoadPermille(5, 8, SUBTILE, 0)).toBe(0);
  });
});

describe('belt flow scroll', () => {
  it('does not scroll an empty belt', () => {
    expect(scroll(BASIC, 0, 8)).toBe(0);
  });

  it('scrolls faster as the same belt fills', () => {
    const quiet = scroll(BASIC, 4, 16);
    const busy = scroll(BASIC, 32, 16);
    expect(quiet).toBeGreaterThan(0);
    expect(busy).toBeGreaterThan(quiet);
  });

  it('scrolls a full express belt faster than a full basic one', () => {
    const packed = capacity(8);
    expect(scroll(EXPRESS, packed, 8)).toBeGreaterThan(scroll(BASIC, packed, 8));
  });

  it('is throughput rather than velocity: a fast belt carrying almost nothing is slow', () => {
    const packed = capacity(8);
    expect(scroll(EXPRESS, 1, 8)).toBeLessThan(scroll(BASIC, packed, 8));
  });

  it('never outruns the belt itself', () => {
    // A packed belt scrolls at exactly the speed its goods travel — 320 subtiles per 100
    // ticks is 3.2 a tick, which at 20 Hz over a 256-subtile tile is 4 source px a second.
    const packed = capacity(8);
    expect(scroll(BASIC, packed, 8)).toBeCloseTo(4, 6);
    expect(scroll(BASIC, packed, 8)).toBeGreaterThanOrEqual(scroll(BASIC, packed - 1, 8));
  });
});

describe('the item threshold', () => {
  it('draws items at the threshold and above, flow below it', () => {
    expect(beltItemsVisibleAt(BELT_ITEM_LOD_MIN_ZOOM)).toBe(true);
    expect(beltItemsVisibleAt(BELT_ITEM_LOD_MIN_ZOOM - 1)).toBe(false);
  });

  it('splits the ladder with no rung in between', () => {
    // The threshold was derived from item spacing at 2× versus 3× — four source px between
    // items, so eight CSS px at 2× for a sprite wider than that. A ladder that grew a 2.5×
    // rung would put a zoom level on the boundary the arithmetic says nothing about.
    const below = ZOOM_LEVELS.filter((zoom) => !beltItemsVisibleAt(zoom));
    const above = ZOOM_LEVELS.filter((zoom) => beltItemsVisibleAt(zoom));
    expect(below).toEqual([2]);
    expect(above).toEqual([3, 4, 6]);
  });
});
