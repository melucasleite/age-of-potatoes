// Screen → world → tile, and back again.
//
// Two hazards live in this file, both invisible on the developer's own monitor:
//
//   1. POINTER EVENTS ARRIVE IN CSS PIXELS. The renderer runs at
//      `resolution: devicePixelRatio` with `autoDensity: true` (§13), so `clientX` does
//      not map 1:1 to renderer pixels. On an external non-Retina monitor this is
//      invisible; on the laptop panel it is a 2× error. `clientToCss()` maps through the
//      canvas bounding rect, which also survives any CSS that scales the canvas.
//
//   2. WORLD PIXELS → TILES USES `Math.floor`, NEVER `| 0` OR `Math.trunc`. Truncation
//      rounds toward zero, so every tile in the negative quadrants is off by one. The
//      starting lot sits at the origin, which is exactly the layout that hides this until
//      somebody pans west.
//
// And the rule that ties it to the camera: the transform inverted here is the one the
// renderer ACTUALLY APPLIED this frame, snapped, read from `camera.transform`. It is
// never recomputed from camera state. Inverting an idealized un-snapped transform puts
// the cursor up to a tile off near the viewport edges, with an error that drifts as you
// walk.
//
// §13 also settles belt-item picking here, before belts exist: `ParticleContainer`
// particles support NO INTERACTIVITY, no children, no filters and no masks, so there is
// no sprite to hit-test. A rendered belt item "is not an object, it's a query result".
// So picking asks the SIM what occupies a tile — `tileAtView()` below — and never asks
// the display. When belts land they need no new mechanism.

import type { BeltView, GrabberView, MachineView, PipeView, WorldView } from '@snack/sim';
import { Direction, HAND_REACH_SUBTILES, SUBTILE } from '@snack/sim';

import type { Camera } from '../render/camera';
import { TILE_PX } from '../render/pixel';

export interface TileQuery {
  tileX: number;
  tileY: number;
  insideWorld: boolean;
  /** The parcel this tile belongs to, or -1 off the map. */
  parcel: number;
  /**
   * True when the player holds the deed to the parcel this tile is on.
   *
   * SEPARATE FROM `insideWorld`, because they are different questions with different answers
   * on screen: outside the world is nowhere, and unowned land is a real place with a price
   * standing on it. Every build affordance reads this, and the sim re-checks all of it (§12).
   */
  owned: boolean;
  /** True when the tile belongs to the 8×8 field. */
  isField: boolean;
  /** Row-major index into the field arrays, or -1. */
  fieldIndex: number;
  crop: number;
  stage: number;
  ready: boolean;
  dry: boolean;
  moisturePermille: number;
  fertility: number;
  /** The machine whose footprint covers this tile, if any. */
  machine: MachineView | null;
  /** Renderer-side hint only. The sim re-checks and harmlessly rejects (§12). */
  withinReach: boolean;
}

/** Client coordinates → CSS pixels inside the canvas, tolerant of a CSS-scaled canvas. */
export function clientToCss(
  canvas: HTMLCanvasElement,
  camera: Camera,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const t = camera.transform;
  const scaleX = rect.width > 0 ? t.viewWidth / rect.width : 1;
  const scaleY = rect.height > 0 ? t.viewHeight / rect.height : 1;
  return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
}

/** Client coordinates → tile coordinates. Floors, so it is correct west and north of 0. */
export function screenToTile(
  canvas: HTMLCanvasElement,
  camera: Camera,
  clientX: number,
  clientY: number,
): { tileX: number; tileY: number } {
  const css = clientToCss(canvas, camera, clientX, clientY);
  const world = camera.screenToWorld(css.x, css.y);
  return { tileX: Math.floor(world.x / TILE_PX), tileY: Math.floor(world.y / TILE_PX) };
}

/** Tile → the CSS-pixel position of its top-left corner. Used by the hover highlight. */
export function tileToScreen(
  camera: Camera,
  tileX: number,
  tileY: number,
): { x: number; y: number } {
  return camera.worldToScreen(tileX * TILE_PX, tileY * TILE_PX);
}

/** Tile → world pixels of its top-left corner. */
export function tileToWorld(tileX: number, tileY: number): { x: number; y: number } {
  return { x: tileX * TILE_PX, y: tileY * TILE_PX };
}

/**
 * What the SIM says is on a tile. The single entry point for "what did the player click
 * on", and the one that answers belt-item picking later without a hit test.
 *
 * Reads only the plain data in `WorldView`. Valid until the next `view()` call on that
 * buffer, which is once per frame — so a click handler running between frames sees the
 * last frame's snapshot, which is exactly the snapshot the player was looking at.
 */
export function tileAtView(v: WorldView, tileX: number, tileY: number): TileQuery {
  const field = v.field;
  const insideWorld =
    tileX >= 0 && tileY >= 0 && tileX < v.worldTilesWide && tileY < v.worldTilesHigh;

  const isField =
    tileX >= field.originX &&
    tileY >= field.originY &&
    tileX < field.originX + field.tilesWide &&
    tileY < field.originY + field.tilesHigh;

  const index = isField ? (tileY - field.originY) * field.tilesWide + (tileX - field.originX) : -1;

  let machine: MachineView | null = null;
  for (let i = 0; i < v.machines.length; i++) {
    const m = v.machines[i]!;
    if (
      tileX >= m.tileX &&
      tileY >= m.tileY &&
      tileX < m.tileX + m.tilesWide &&
      tileY < m.tileY + m.tilesHigh
    ) {
      machine = m;
      break;
    }
  }

  const parcel = parcelAtTile(v, tileX, tileY);

  return {
    tileX,
    tileY,
    insideWorld,
    parcel,
    owned: parcel >= 0 && v.land.owned.includes(parcel),
    isField,
    fieldIndex: index,
    crop: index >= 0 ? (field.crop[index] ?? 0) : 0,
    stage: index >= 0 ? (field.stage[index] ?? 0) : 0,
    ready: index >= 0 && field.ready[index] === 1,
    dry: index >= 0 && field.dry[index] === 1,
    moisturePermille: index >= 0 ? (field.moisturePermille[index] ?? 0) : 0,
    fertility: index >= 0 ? (field.fertility[index] ?? 0) : 0,
    machine,
    withinReach: tileWithinReach(v, tileX, tileY),
  };
}

/**
 * The parcel a tile is on, or -1 off the map.
 *
 * READ OFF THE PROJECTION'S OWN GEOMETRY rather than by importing `parcelIndexAt` from the
 * sim, deliberately. `WorldView` is supposed to be sufficient on its own — plan §12 has it
 * crossing a Worker boundary one day as plain data — and a picker that reached back into
 * balance constants for the map's shape would be reading two sources for one fact.
 */
export function parcelAtTile(v: WorldView, tileX: number, tileY: number): number {
  const land = v.land;
  const width = land.parcelsWide * land.parcelTiles;
  const height = land.parcelsHigh * land.parcelTiles;
  if (tileX < 0 || tileY < 0 || tileX >= width || tileY >= height) return -1;
  return (
    Math.floor(tileY / land.parcelTiles) * land.parcelsWide + Math.floor(tileX / land.parcelTiles)
  );
}

/** The parcel's top-left tile, for a band that outlines the whole thing. */
export function parcelOrigin(v: WorldView, parcel: number): { tileX: number; tileY: number } {
  const land = v.land;
  return {
    tileX: (parcel % land.parcelsWide) * land.parcelTiles,
    tileY: Math.floor(parcel / land.parcelsWide) * land.parcelTiles,
  };
}

/**
 * The arm standing on a tile, if there is one.
 *
 * SEPARATE FROM `TileQuery` RATHER THAN A FIELD ON IT, deliberately. `tileAtView` is called
 * for every tile of a drag's footprint and for the status ribbon on every pointer move; a
 * grabber scan folded into it would run on every one of those calls for the benefit of the
 * two callers that care — R, and the ribbon line that tells the player R exists. An arm
 * occupies exactly one tile and has no footprint, so this is a straight comparison rather
 * than the rectangle test machines need.
 */
export function grabberAtView(v: WorldView, tileX: number, tileY: number): GrabberView | null {
  for (let i = 0; i < v.grabbers.length; i++) {
    const g = v.grabbers[i]!;
    if (g.tileX === tileX && g.tileY === tileY) return g;
  }
  return null;
}

/**
 * The belt segment running over a tile, if there is one.
 *
 * BESIDE `tileAtView` RATHER THAN INSIDE IT, for the same reason `grabberAtView` is: the tile
 * query runs for every tile of a drag's footprint and on every pointer move for the status
 * ribbon, and only the teardown tool and the ribbon ever ask this. Analytic rather than a walk
 * down the segment — a belt is a straight run from an origin, so membership is a multiply and
 * two compares whatever its length.
 *
 * IT RETURNS THE WHOLE SEGMENT, and that is the fact the teardown ghost is built on:
 * `RemoveBelt` names a belt by id and takes all of it, so a drag clipping one tile of a
 * sixteen-tile express run takes the whole run. The preview shows that rather than letting
 * the player find out afterwards.
 */
export function beltAtView(v: WorldView, tileX: number, tileY: number): BeltView | null {
  for (let i = 0; i < v.belts.length; i++) {
    const belt = v.belts[i]!;
    const dx = belt.dir === Direction.East ? 1 : belt.dir === Direction.West ? -1 : 0;
    const dy = belt.dir === Direction.South ? 1 : belt.dir === Direction.North ? -1 : 0;
    if (dx !== 0) {
      if (tileY !== belt.tileY) continue;
      const along = (tileX - belt.tileX) * dx;
      if (along >= 0 && along < belt.lengthTiles) return belt;
      continue;
    }
    if (dy !== 0) {
      if (tileX !== belt.tileX) continue;
      const along = (tileY - belt.tileY) * dy;
      if (along >= 0 && along < belt.lengthTiles) return belt;
      continue;
    }
    // A facing this build has never heard of — a save from a newer sim. One tile, rather than
    // an exception thrown at the player. The same rule `render/junction.ts` follows.
    if (belt.tileX === tileX && belt.tileY === tileY) return belt;
  }
  return null;
}

/** Every tile one belt segment covers, in the order goods travel over them. */
export function beltTiles(belt: BeltView): { tileX: number; tileY: number }[] {
  const dx = belt.dir === Direction.East ? 1 : belt.dir === Direction.West ? -1 : 0;
  const dy = belt.dir === Direction.South ? 1 : belt.dir === Direction.North ? -1 : 0;
  const tiles: { tileX: number; tileY: number }[] = [];
  for (let i = 0; i < belt.lengthTiles; i++) {
    tiles.push({ tileX: belt.tileX + dx * i, tileY: belt.tileY + dy * i });
  }
  return tiles;
}

/** The pipe on a tile, if there is one. One tile each, so this is a straight comparison. */
export function pipeAtView(v: WorldView, tileX: number, tileY: number): PipeView | null {
  for (let i = 0; i < v.pipes.length; i++) {
    const pipe = v.pipes[i]!;
    if (pipe.tileX === tileX && pipe.tileY === tileY) return pipe;
  }
  return null;
}

/**
 * Renderer-side reach hint, mirroring the sim's check so the cursor can say "too far"
 * before the click is thrown away. Plan §5 sets the rule that anything a machine does
 * automatically the player can do by hand *standing next to it*, and §12 puts the
 * authority for that in the sim — this is a courtesy, never a gate.
 */
export function tileWithinReach(v: WorldView, tileX: number, tileY: number): boolean {
  const centreX = tileX * SUBTILE + SUBTILE / 2;
  const centreY = tileY * SUBTILE + SUBTILE / 2;
  const dx = v.player.xSub - centreX;
  const dy = v.player.ySub - centreY;
  return dx * dx + dy * dy <= HAND_REACH_SUBTILES * HAND_REACH_SUBTILES;
}

export function machineWithinReach(v: WorldView, m: MachineView): boolean {
  const centreX = m.tileX * SUBTILE + SUBTILE / 2 + Math.floor(((m.tilesWide - 1) * SUBTILE) / 2);
  const centreY = m.tileY * SUBTILE + SUBTILE / 2 + Math.floor(((m.tilesHigh - 1) * SUBTILE) / 2);
  const dx = v.player.xSub - centreX;
  const dy = v.player.ySub - centreY;
  return dx * dx + dy * dy <= HAND_REACH_SUBTILES * HAND_REACH_SUBTILES;
}
