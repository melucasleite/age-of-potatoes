// The placement ghost's coverage preview (item 011's last code gap).
//
// The story: the barrel sprinkler is a 1×1 machine that waters a 5×5 patch, and for two
// waves the ghost drew only the footprint — a player aimed a one-tile square and found out
// where the water went after spending $150. The preview now derives the patch from the
// spec's `coverageRadiusTiles`, the same number `advanceSprinkler` reads, so the cells on
// screen are exactly the tiles the machine will wet.
//
// Verification is deliberately light and aimed at what fails quietly:
//
//   · THE RADIUS COMES FROM THE SPEC. A hardcoded 5×5 would pass today and silently lie the
//     day the spec moves, so the test compares against `SPRINKLER_RADIUS_TILES` itself.
//   · MACHINES WITHOUT COVERAGE ARE UNTOUCHED. The Chip Kitchen's ghost growing 25 cells
//     would be a plainly wrong overlay that throws nothing.

import { describe, expect, it } from 'vitest';
import {
  Direction,
  REPAIR_KIT_RADIUS_TILES,
  SPRINKLER_RADIUS_TILES,
  createWorldView,
} from '@snack/sim';

import { ghostBand } from './pointer';
import { ToolMode, toolCoverageRadius, toolCoverageVerb } from './tools';

const HOVER = { tileX: 10, tileY: 8 };

describe('toolCoverageRadius', () => {
  it('reads the sprinkler radius off the spec, not a constant typed twice', () => {
    expect(toolCoverageRadius(ToolMode.PlaceSprinkler)).toBe(SPRINKLER_RADIUS_TILES);
  });

  it('is zero for a machine without an area of effect', () => {
    expect(toolCoverageRadius(ToolMode.PlaceChipKitchen)).toBe(0);
    expect(toolCoverageRadius(ToolMode.Water)).toBe(0);
  });
});

describe('ghostBand coverage preview', () => {
  it('draws the full coverage patch around the sprinkler footprint', () => {
    const band = ghostBand(createWorldView(), HOVER, ToolMode.PlaceSprinkler, Direction.East);
    expect(band).not.toBeNull();

    const r = SPRINKLER_RADIUS_TILES;
    const span = r * 2 + 1;
    const cells = band!.cells!;
    expect(cells).toHaveLength(span * span);

    // Every cell is within Chebyshev radius of the anchor — the sim's own geometry.
    for (const cell of cells) {
      const chebyshev = Math.max(Math.abs(cell.x - HOVER.tileX), Math.abs(cell.y - HOVER.tileY));
      expect(chebyshev).toBeLessThanOrEqual(r);
    }

    // The bounding box is the coverage square, so the tag hangs over the whole patch.
    expect(band!.x).toBe(HOVER.tileX - r);
    expect(band!.y).toBe(HOVER.tileY - r);
    expect(band!.w).toBe(span);
    expect(band!.h).toBe(span);

    // The label says what the patch is, in the spec's numbers.
    expect(band!.label).toContain(`${span}×${span}`);
  });

  it('keeps the legality tone on the footprint and mist everywhere else', () => {
    const band = ghostBand(createWorldView(), HOVER, ToolMode.PlaceSprinkler, Direction.East);
    const cells = band!.cells!;

    const anchor = cells.find((c) => c.x === HOVER.tileX && c.y === HOVER.tileY)!;
    // The stub view owns nothing and has no money, so the footprint is refused — and the
    // refusal must land on the footprint tile, in the band's own tone.
    expect(anchor.tone).toBe(band!.tone);
    expect(anchor.tone).toBe('blocked');

    for (const cell of cells) {
      if (cell.x === HOVER.tileX && cell.y === HOVER.tileY) continue;
      expect(cell.tone).toBe('mist');
    }
  });

  it('gives the Maintenance Station the hand kit’s cell, and the right verb ([[039]])', () => {
    // The station IS the kit without the walk, so its preview must be the kit's own radius,
    // read off the spec. And a ghost that said the repair bench "waters 7×7" would be the
    // preview lying about the one fact it exists to state — the verb comes off the role.
    expect(toolCoverageRadius(ToolMode.PlaceMaintenanceStation)).toBe(REPAIR_KIT_RADIUS_TILES);
    expect(toolCoverageVerb(ToolMode.PlaceMaintenanceStation)).toBe('services');
    expect(toolCoverageVerb(ToolMode.PlaceSprinkler)).toBe('waters');

    const band = ghostBand(
      createWorldView(),
      HOVER,
      ToolMode.PlaceMaintenanceStation,
      Direction.East,
    );
    const span = REPAIR_KIT_RADIUS_TILES * 2 + 1;
    expect(band!.label).toContain(`services ${span}×${span}`);
    expect(band!.label).not.toContain('waters');
  });

  it('leaves a coverage-free machine ghost exactly as it was', () => {
    const band = ghostBand(createWorldView(), HOVER, ToolMode.PlaceChipKitchen, Direction.East);
    expect(band).not.toBeNull();
    expect(band!.cells).toBeUndefined();
    expect(band!.x).toBe(HOVER.tileX);
    expect(band!.y).toBe(HOVER.tileY);
    expect(band!.w).toBe(2);
    expect(band!.h).toBe(2);
  });
});
