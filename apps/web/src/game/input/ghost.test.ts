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
  CropId,
  Direction,
  MachineKind,
  REPAIR_KIT_RADIUS_TILES,
  SPRINKLER_RADIUS_TILES,
  createWorldView,
  machineSpec,
} from '@snack/sim';
import type { WorldView } from '@snack/sim';

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

// Item 067: the sim's `footprintFree` accepts a `fieldPlaceable` machine on EMPTY farm
// tiles, so the ghost must go green there — and must say WHY when a crop refuses it. What
// fails quietly without these: a red ghost over the legal mid-field spot the whole item
// exists to allow (the player never tries the click), or a green fryer ghost over the crops
// (the click dies in the reducer and reads as a dead click).
describe('ghostBand on farmland ([[067]])', () => {
  /** Owned world, money in the pouch, and farmland at exactly `tiles`. */
  function farmView(tiles: readonly (readonly [number, number])[]): WorldView {
    const view = createWorldView();
    view.land.owned.push(0);
    view.moneyCents = 1_000_000;
    const sorted = [...tiles].sort(
      (a, b) => a[1] * view.worldTilesWide + a[0] - (b[1] * view.worldTilesWide + b[0]),
    );
    view.field.count = sorted.length;
    sorted.forEach(([x, y], i) => {
      view.field.tileX[i] = x;
      view.field.tileY[i] = y;
    });
    return view;
  }

  it('the flag this reads is the spec’s own, not a kind list', () => {
    expect(machineSpec(MachineKind.Sprinkler)!.fieldPlaceable).toBe(true);
    expect(machineSpec(MachineKind.Fryer)!.fieldPlaceable).toBe(false);
  });

  it('a sprinkler ghost is LEGAL on an empty farm tile', () => {
    const view = farmView([[HOVER.tileX, HOVER.tileY]]);
    const band = ghostBand(view, HOVER, ToolMode.PlaceSprinkler, Direction.East)!;
    expect(band.tone).toBe('zone');
  });

  // ────────────────────────────────────────────────────────────────────────────────────
  //  THESE TWO USED TO ASSERT A REFUSAL, AND ITEM 121 IS THE OWNER RULING THAT REMOVED IT.
  //  They are kept here, flipped, rather than deleted — beside the refusals that SURVIVED
  //  (the unflagged machine below) — because the pair is the actual rule and reads as one
  //  thing: farmland refuses a machine that is not `fieldPlaceable`, and refuses a flagged
  //  one for nothing at all.
  //
  //  Item 067's house rule that nothing is silently destroyed is NOT weakened by this; it is
  //  paid instead. The crop is lifted and handed back, so what the assertions below check is
  //  that the ghost is green AND that it names the goods — a green band that said nothing
  //  would satisfy the sim and still lose the player a crop they were saving.
  // ────────────────────────────────────────────────────────────────────────────────────

  it('a crop-bearing farm tile is LEGAL now, and the label names the seed coming back', () => {
    const view = farmView([[HOVER.tileX, HOVER.tileY]]);
    view.field.crop[0] = CropId.RussetPotato;
    const band = ghostBand(view, HOVER, ToolMode.PlaceSprinkler, Direction.East)!;
    expect(band.tone).toBe('zone');
    expect(band.label).toContain('returns 1 potato seed');
    expect(band.label).not.toContain('a crop is in the way');
  });

  it('compost is LEGAL too, and comes back counted — the number is exact', () => {
    const view = farmView([[HOVER.tileX, HOVER.tileY]]);
    view.field.compost[0] = 2;
    const band = ghostBand(view, HOVER, ToolMode.PlaceSprinkler, Direction.East)!;
    expect(band.tone).toBe('zone');
    expect(band.label).toContain('returns 2 compost');
    expect(band.label).not.toContain('compost in the way');
  });

  it('a non-flagged machine stays banned from farmland, and the ghost says so', () => {
    // The fryer's 2×2 clips one farm tile; the whole footprint refuses, per the sim's rule.
    const view = farmView([[HOVER.tileX + 1, HOVER.tileY + 1]]);
    const band = ghostBand(view, HOVER, ToolMode.PlaceFryer, Direction.East)!;
    expect(band.tone).toBe('blocked');
    expect(band.label).toContain('not on farmland');
  });

  it('off the farm nothing changed: clear owned ground is still legal', () => {
    const view = farmView([]);
    const band = ghostBand(view, HOVER, ToolMode.PlaceFryer, Direction.East)!;
    expect(band.tone).toBe('zone');
  });
});
