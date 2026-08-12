// Drag gestures: the rubber band, and the one command it becomes.
//
// ONE DRAG IS ONE COMMAND. This is the ruling §16 makes by name and the reason lives in
// `packages/sim/src/commands.ts`: a sixty-tile paint emitted as sixty commands puts sixty
// entries in an append-only trace for one flick of the wrist, makes replays enormous, makes
// bug reports unreadable, and hands a future undo sixty steps to walk back — which is the
// same as having no undo at all. So the in-progress band is PURELY PRESENTATIONAL, emits
// nothing, and a cancelled drag emits nothing whatsoever.
//
// Everything in this file is pure. It takes a `WorldView` and two tile coordinates and
// returns either a plain rect/run or a plain `Command` — no DOM, no camera, no listeners.
// That is what lets the gestures be tested without a browser, and it is why `pointer.ts`
// underneath is small enough to read in one sitting.
//
// LEGALITY IS NOT DECIDED HERE. A command that can be *formed* is sent even when it looks
// doomed from this side — the sim is the authority and rejects it harmlessly (§12). The
// preview may say "you cannot afford this"; it may never refuse to emit on that basis, or
// the renderer's opinion starts deciding what is in the trace.

import type { Command, WorldView } from '@snack/sim';
import {
  BELT_MAX_LENGTH_TILES,
  Direction,
  PaintMode,
  ZONE_PAINT_MAX_SPAN,
  type BeltTier,
  type CropId,
} from '@snack/sim';

export interface TilePoint {
  tileX: number;
  tileY: number;
}

export interface RectRun {
  kind: 'rect';
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LineRun {
  kind: 'line';
  tileX: number;
  tileY: number;
  dir: Direction;
  lengthTiles: number;
}

export type DragRun = RectRun | LineRun;

/**
 * The rectangle spanned by two tiles, inclusive of both.
 *
 * Clamped to `ZONE_PAINT_MAX_SPAN` by SHRINKING TOWARD THE ANCHOR rather than by refusing.
 * The sim's `clipRectToField` rejects an oversized rect outright, so an unclamped band
 * would grow past the limit looking perfectly healthy and then emit a command that does
 * nothing — a gesture that lies about what it is about to do. Shrinking makes the ceiling
 * visible while you are still holding the button.
 */
export function rectBetween(anchor: TilePoint, cursor: TilePoint): RectRun {
  const spanX = clampSpan(cursor.tileX - anchor.tileX);
  const spanY = clampSpan(cursor.tileY - anchor.tileY);
  const farX = anchor.tileX + spanX;
  const farY = anchor.tileY + spanY;

  return {
    kind: 'rect',
    x: Math.min(anchor.tileX, farX),
    y: Math.min(anchor.tileY, farY),
    w: Math.abs(spanX) + 1,
    h: Math.abs(spanY) + 1,
  };
}

function clampSpan(delta: number): number {
  const limit = ZONE_PAINT_MAX_SPAN - 1;
  if (delta > limit) return limit;
  if (delta < -limit) return -limit;
  return delta;
}

/**
 * The straight run from anchor toward cursor, along whichever axis moved further.
 *
 * A belt segment is straight in the sim and a corner is two segments meeting — so the
 * gesture is straight too. Snapping to the dominant axis rather than routing an L keeps
 * one drag equal to one command, and keeps the thing you are dragging identical to the
 * thing that gets built. Ties go to the horizontal, arbitrarily but consistently: a
 * gesture that flickers between two readings at 45° is worse than one that picks a side.
 */
export function lineBetween(anchor: TilePoint, cursor: TilePoint): LineRun {
  const dx = cursor.tileX - anchor.tileX;
  const dy = cursor.tileY - anchor.tileY;

  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const raw = horizontal ? dx : dy;
  const length = Math.min(BELT_MAX_LENGTH_TILES, Math.abs(raw) + 1);

  let dir: Direction;
  if (horizontal) dir = raw < 0 ? Direction.West : Direction.East;
  else dir = raw < 0 ? Direction.North : Direction.South;

  return { kind: 'line', tileX: anchor.tileX, tileY: anchor.tileY, dir, lengthTiles: length };
}

/** The zone that owns a tile, or 0 for none. Reads the projection's plain arrays only. */
export function zoneIdAt(view: WorldView, tileX: number, tileY: number): number {
  const field = view.field;
  if (
    tileX < field.originX ||
    tileY < field.originY ||
    tileX >= field.originX + field.tilesWide ||
    tileY >= field.originY + field.tilesHigh
  ) {
    return 0;
  }
  const index = (tileY - field.originY) * field.tilesWide + (tileX - field.originX);
  return field.zone[index] ?? 0;
}

/**
 * The one command a completed paint drag becomes.
 *
 * THE ANCHOR DECIDES WHICH ZONE THIS IS. Start the drag on a zoned tile and you are
 * growing that zone; start it on bare soil and you are making a new one. Picking by
 * anchor rather than by "whatever the rectangle happens to overlap" is what makes the
 * gesture predictable — you commit to the answer with the first press, before the shape
 * exists, and the rubber band can therefore label itself correctly the whole way.
 */
export function paintCommandFor(
  view: WorldView,
  anchor: TilePoint,
  rect: RectRun,
  crop: CropId,
): Command {
  const zoneId = zoneIdAt(view, anchor.tileX, anchor.tileY);
  const payload = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
  if (zoneId > 0) {
    return { type: 'PaintZone', zoneId, rect: payload, mode: PaintMode.Add };
  }
  return { type: 'CreateZone', rect: payload, crop };
}

/**
 * The one command a completed erase drag becomes, or `null`.
 *
 * `null` when the anchor sat on unzoned ground: there is no zone to remove tiles from, so
 * there is nothing to say. A cancelled or empty gesture emits nothing — that is the rule,
 * not an edge case.
 */
export function eraseCommandFor(view: WorldView, anchor: TilePoint, rect: RectRun): Command | null {
  const zoneId = zoneIdAt(view, anchor.tileX, anchor.tileY);
  if (zoneId <= 0) return null;
  return {
    type: 'PaintZone',
    zoneId,
    rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
    mode: PaintMode.Remove,
  };
}

/** The one command a completed belt drag becomes. */
export function beltCommandFor(tier: BeltTier, run: LineRun): Command {
  return {
    type: 'PlaceBelt',
    tier,
    tileX: run.tileX,
    tileY: run.tileY,
    dir: run.dir,
    lengthTiles: run.lengthTiles,
  };
}

/** Every tile a run covers, for the ghost. Rect runs return their own corner and size. */
export function runBounds(run: DragRun): { x: number; y: number; w: number; h: number } {
  if (run.kind === 'rect') return { x: run.x, y: run.y, w: run.w, h: run.h };

  const span = run.lengthTiles - 1;
  switch (run.dir) {
    case Direction.North:
      return { x: run.tileX, y: run.tileY - span, w: 1, h: run.lengthTiles };
    case Direction.South:
      return { x: run.tileX, y: run.tileY, w: 1, h: run.lengthTiles };
    case Direction.West:
      return { x: run.tileX - span, y: run.tileY, w: run.lengthTiles, h: 1 };
    default:
      return { x: run.tileX, y: run.tileY, w: run.lengthTiles, h: 1 };
  }
}
