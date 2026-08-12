// The cheap structural gate for drag gestures.
//
// Verification here is deliberately light (AGENTS.md: "if it works, it works"), so this
// pins only the things that fail QUIETLY — the ones where the game keeps running and the
// player is the one who notices:
//
//   · ONE DRAG IS ONE COMMAND, and which command it is. A paint that emits `CreateZone`
//     where it meant `PaintZone` does not throw; it silently scatters a dozen one-tile
//     zones across the field over an afternoon.
//   · A backwards drag. Dragging up-and-left is normal and produces negative spans; a rect
//     with a negative width is rejected by `clipRectToField` and the gesture just does
//     nothing, with no error anywhere.
//   · The belt run's axis and its length clamp. Off-by-one on a belt is a segment that
//     stops one tile short of the machine, which reads as a balance problem for a while.
//
// Everything under test is pure. No DOM, no camera, no Pixi.

import { describe, expect, it } from 'vitest';
import { BELT_MAX_LENGTH_TILES, BeltTier, CropId, Direction, createWorldView } from '@snack/sim';
import type { WorldView } from '@snack/sim';

import {
  beltCommandFor,
  eraseCommandFor,
  lineBetween,
  paintCommandFor,
  rectBetween,
  runBounds,
  zoneIdAt,
} from './gesture';

/** A projection with one tile of the field assigned to zone 7. */
function viewWithZone(tileX: number, tileY: number, zoneId: number): WorldView {
  const view = createWorldView();
  const field = view.field;
  const index = (tileY - field.originY) * field.tilesWide + (tileX - field.originX);
  field.zone[index] = zoneId;
  return view;
}

describe('rectBetween', () => {
  it('normalises a drag that runs up and to the left', () => {
    const rect = rectBetween({ tileX: 8, tileY: 9 }, { tileX: 5, tileY: 6 });
    expect(rect).toEqual({ kind: 'rect', x: 5, y: 6, w: 4, h: 4 });
  });

  it('is inclusive of both ends, so a single-tile drag is 1x1', () => {
    const rect = rectBetween({ tileX: 4, tileY: 4 }, { tileX: 4, tileY: 4 });
    expect(rect).toEqual({ kind: 'rect', x: 4, y: 4, w: 1, h: 1 });
  });
});

describe('lineBetween', () => {
  it('snaps to whichever axis moved further', () => {
    const run = lineBetween({ tileX: 2, tileY: 2 }, { tileX: 6, tileY: 3 });
    expect(run.dir).toBe(Direction.East);
    expect(run.lengthTiles).toBe(5);
  });

  it('runs west when the cursor is to the left', () => {
    const run = lineBetween({ tileX: 9, tileY: 2 }, { tileX: 6, tileY: 2 });
    expect(run.dir).toBe(Direction.West);
    expect(run.lengthTiles).toBe(4);
    // The command's origin stays at the anchor; the bounds extend backwards from it.
    expect(runBounds(run)).toEqual({ x: 6, y: 2, w: 4, h: 1 });
  });

  it('clamps to the sim’s maximum segment length', () => {
    const run = lineBetween({ tileX: 0, tileY: 0 }, { tileX: 500, tileY: 0 });
    expect(run.lengthTiles).toBe(BELT_MAX_LENGTH_TILES);
  });

  it('becomes exactly one PlaceBelt command', () => {
    const run = lineBetween({ tileX: 1, tileY: 1 }, { tileX: 1, tileY: 4 });
    expect(beltCommandFor(BeltTier.Basic, run)).toEqual({
      type: 'PlaceBelt',
      tier: BeltTier.Basic,
      tileX: 1,
      tileY: 1,
      dir: Direction.South,
      lengthTiles: 4,
    });
  });
});

describe('paint gestures', () => {
  it('creates a zone when the drag starts on unzoned soil', () => {
    const view = createWorldView();
    const rect = rectBetween({ tileX: 4, tileY: 4 }, { tileX: 6, tileY: 6 });
    const command = paintCommandFor(view, { tileX: 4, tileY: 4 }, rect, CropId.RussetPotato);

    expect(command).toEqual({
      type: 'CreateZone',
      rect: { x: 4, y: 4, w: 3, h: 3 },
      crop: CropId.RussetPotato,
    });
  });

  it('grows the anchor’s zone when the drag starts inside one', () => {
    const view = viewWithZone(5, 5, 7);
    expect(zoneIdAt(view, 5, 5)).toBe(7);

    const rect = rectBetween({ tileX: 5, tileY: 5 }, { tileX: 8, tileY: 8 });
    const command = paintCommandFor(view, { tileX: 5, tileY: 5 }, rect, CropId.RussetPotato);

    expect(command).toMatchObject({ type: 'PaintZone', zoneId: 7, mode: 'add' });
  });

  it('erases from the anchor’s zone', () => {
    const view = viewWithZone(5, 5, 7);
    const rect = rectBetween({ tileX: 5, tileY: 5 }, { tileX: 6, tileY: 6 });
    expect(eraseCommandFor(view, { tileX: 5, tileY: 5 }, rect)).toMatchObject({
      type: 'PaintZone',
      zoneId: 7,
      mode: 'remove',
    });
  });

  it('emits nothing when an erase starts on unzoned ground', () => {
    const view = createWorldView();
    const rect = rectBetween({ tileX: 4, tileY: 4 }, { tileX: 7, tileY: 7 });
    expect(eraseCommandFor(view, { tileX: 4, tileY: 4 }, rect)).toBeNull();
  });

  it('reports no zone for tiles outside the field', () => {
    const view = viewWithZone(5, 5, 7);
    expect(zoneIdAt(view, 0, 0)).toBe(0);
    expect(zoneIdAt(view, 99, 99)).toBe(0);
  });
});
