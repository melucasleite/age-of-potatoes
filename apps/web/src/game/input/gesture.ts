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

/**
 * A belt run: one straight leg, or two meeting at a right angle.
 *
 * The second leg's ORIGIN is deliberately absent. It is always the first leg's exit tile —
 * one step past its last — and the sim derives it the same way (`applyPlaceBelt`). A field
 * for it here would be a second place the elbow could be decided, and the two could disagree
 * about which segment owns the corner tile; that disagreement is invisible until an item
 * reaches the bend and stops dead on ground with no belt on it.
 */
export interface LineRun {
  kind: 'line';
  tileX: number;
  tileY: number;
  dir: Direction;
  lengthTiles: number;
  /** `Direction.None` when the run is straight. */
  turnDir: Direction;
  /** 0 when the run is straight. */
  turnLengthTiles: number;
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
 * The L from anchor to cursor: along one axis, then the other.
 *
 * ────────────────────────────────────────────────────────────────────────────────────
 *  THIS USED TO THROW AN AXIS AWAY, AND THAT WAS THE BUG. `lineBetween` picked whichever
 *  axis had moved further and discarded the other, so a diagonal drag silently became a
 *  straight line and there was no gesture in the game that could express a bend — reported
 *  as, in full, "the belts there is no way to make an angle".
 *
 *  THE SIM NEEDED NOTHING FOR THIS. `belts.ts` hands a head item onto whatever belt starts
 *  where its own ends, so an east belt feeding a south belt has always carried goods round
 *  the corner; `test/belt-run.test.ts` pins that as a fact about the shipped sim rather than
 *  as a thing this change added.
 * ────────────────────────────────────────────────────────────────────────────────────
 *
 * WHICH AXIS LEADS: the one the cursor moved further along, and **R flips it**. The
 * alternative on the table was Factorio's — the bend follows the direction the cursor moved
 * in last — and it was rejected for being stateful in a way this camera makes hostile: the
 * camera is the player's body and rides along while he walks, so "the direction the cursor
 * moved last" picks up motion the player did not make with his hand, and a one-pixel wobble
 * at the end of a drag can flip the whole run at the moment of release. R is stable — the
 * ghost shows one L until the player asks for the other one — it is already the rotate key
 * in every placement context, and the band says so while the drag is in progress, which is
 * the criterion that the rule be discoverable from the ghost rather than from this comment.
 *
 * TIES STILL GO TO THE HORIZONTAL, arbitrarily but consistently: a gesture that flickers
 * between two readings at 45° is worse than one that picks a side.
 *
 * THE ELBOW TILE BELONGS TO THE SECOND LEG. The first leg stops one short of the corner so
 * that its exit tile IS the second leg's first tile, which is the arrangement the hand-off
 * looks for. Both legs are capped independently at `BELT_MAX_LENGTH_TILES`, because the cap
 * is a property of one segment and a corner is two of them — and clamping the first leg
 * moves the elbow, which is exactly why nothing downstream is told where the elbow is.
 */
export function elbowBetween(anchor: TilePoint, cursor: TilePoint, flipped: boolean): LineRun {
  const dx = cursor.tileX - anchor.tileX;
  const dy = cursor.tileY - anchor.tileY;

  const dominantIsHorizontal = Math.abs(dx) >= Math.abs(dy);
  const leadHorizontal = flipped ? !dominantIsHorizontal : dominantIsHorizontal;

  const lead = leadHorizontal ? dx : dy;
  const cross = leadHorizontal ? dy : dx;

  // Nothing moved along the leading axis, so there is no corner to turn — this is the
  // straight run the player drew, along the other axis. Flipping the lead onto an axis with
  // no travel on it must not invent a one-tile stub pointing the wrong way.
  if (lead === 0) {
    return straightRun(anchor, cross, !leadHorizontal);
  }
  // Nothing moved across, so the run is straight along the leading axis: the old behaviour,
  // unchanged, for the drag that is still by far the most common one.
  if (cross === 0) {
    return straightRun(anchor, lead, leadHorizontal);
  }

  return {
    kind: 'line',
    tileX: anchor.tileX,
    tileY: anchor.tileY,
    dir: axisDirection(lead, leadHorizontal),
    // One SHORT of the corner: the elbow is the second leg's, so this leg's exit tile is
    // where the second leg begins.
    lengthTiles: Math.min(BELT_MAX_LENGTH_TILES, Math.abs(lead)),
    turnDir: axisDirection(cross, !leadHorizontal),
    // …and one LONGER, because it owns the elbow as well as everything up to the cursor.
    turnLengthTiles: Math.min(BELT_MAX_LENGTH_TILES, Math.abs(cross) + 1),
  };
}

function straightRun(anchor: TilePoint, delta: number, horizontal: boolean): LineRun {
  return {
    kind: 'line',
    tileX: anchor.tileX,
    tileY: anchor.tileY,
    dir: axisDirection(delta, horizontal),
    lengthTiles: Math.min(BELT_MAX_LENGTH_TILES, Math.abs(delta) + 1),
    turnDir: Direction.None,
    turnLengthTiles: 0,
  };
}

function axisDirection(delta: number, horizontal: boolean): Direction {
  if (horizontal) return delta < 0 ? Direction.West : Direction.East;
  return delta < 0 ? Direction.North : Direction.South;
}

/** Where the second leg starts: one step past the first leg's last tile. */
export function elbowTile(run: LineRun): TilePoint | null {
  if (run.turnDir === Direction.None || run.turnLengthTiles < 1) return null;
  return {
    tileX: run.tileX + stepX(run.dir) * run.lengthTiles,
    tileY: run.tileY + stepY(run.dir) * run.lengthTiles,
  };
}

function stepX(dir: Direction): number {
  if (dir === Direction.East) return 1;
  return dir === Direction.West ? -1 : 0;
}

function stepY(dir: Direction): number {
  if (dir === Direction.South) return 1;
  return dir === Direction.North ? -1 : 0;
}

/**
 * Every tile a run covers, in the order goods travel over them.
 *
 * The ghost needs the SHAPE rather than a bounding box once a run can bend — an L's box is
 * mostly tiles the belt does not touch, and painting those is a preview that lies about what
 * the click will build.
 */
export function runTiles(run: DragRun): TilePoint[] {
  const tiles: TilePoint[] = [];
  if (run.kind === 'rect') {
    for (let y = run.y; y < run.y + run.h; y++) {
      for (let x = run.x; x < run.x + run.w; x++) tiles.push({ tileX: x, tileY: y });
    }
    return tiles;
  }

  for (let i = 0; i < run.lengthTiles; i++) {
    tiles.push({
      tileX: run.tileX + stepX(run.dir) * i,
      tileY: run.tileY + stepY(run.dir) * i,
    });
  }

  const elbow = elbowTile(run);
  if (elbow === null) return tiles;

  for (let i = 0; i < run.turnLengthTiles; i++) {
    tiles.push({
      tileX: elbow.tileX + stepX(run.turnDir) * i,
      tileY: elbow.tileY + stepY(run.turnDir) * i,
    });
  }
  return tiles;
}

/** Tiles in a run, both legs. What the run costs is this times the tier's per-tile price. */
export function runLength(run: LineRun): number {
  return run.lengthTiles + run.turnLengthTiles;
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

/**
 * The one command a completed belt drag becomes — ONE, whether or not it turns a corner.
 *
 * The bend rides on the same command rather than becoming a second `PlaceBelt`, because two
 * commands cannot be refused together: a drag whose far leg crosses a machine would lay the
 * near leg and leave a stub. See `PlaceBeltCommand` for the argument in full.
 */
export function beltCommandFor(tier: BeltTier, run: LineRun): Command {
  if (run.turnDir === Direction.None || run.turnLengthTiles < 1) {
    return {
      type: 'PlaceBelt',
      tier,
      tileX: run.tileX,
      tileY: run.tileY,
      dir: run.dir,
      lengthTiles: run.lengthTiles,
    };
  }
  return {
    type: 'PlaceBelt',
    tier,
    tileX: run.tileX,
    tileY: run.tileY,
    dir: run.dir,
    lengthTiles: run.lengthTiles,
    turnDir: run.turnDir,
    turnLengthTiles: run.turnLengthTiles,
  };
}

/**
 * The box a run sits inside, for anything that wants one number per edge.
 *
 * A BENT RUN'S BOX IS NOT ITS SHAPE — most of an L's bounding rectangle is ground the belt
 * never touches. This is the tag's anchor and the cull, and nothing else: the ghost paints
 * `runTiles()` instead, so the preview shows the L rather than the square around it.
 */
export function runBounds(run: DragRun): { x: number; y: number; w: number; h: number } {
  if (run.kind === 'rect') return { x: run.x, y: run.y, w: run.w, h: run.h };

  const tiles = runTiles(run);
  let minX = run.tileX;
  let minY = run.tileY;
  let maxX = run.tileX;
  let maxY = run.tileY;
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i]!;
    if (tile.tileX < minX) minX = tile.tileX;
    if (tile.tileY < minY) minY = tile.tileY;
    if (tile.tileX > maxX) maxX = tile.tileX;
    if (tile.tileY > maxY) maxY = tile.tileY;
  }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
