// Painted Grow Zones.
//
// A ZONE IS A PLAN, NOT A MACHINE (plan §5). It plants nothing, waters nothing, and harvests
// nothing on its own — it is structure for manual work, the to-do list that turns "click
// dirt" into "run a farm", and the instruction set an Agri-Bot dock is bound to
// (`Machine.boundZone`). It used to have one self-acting feature — the researched seed
// hopper's auto-replant — and item 146 retired it: planter bots are the only automatic
// planting now, so this module is pure geometry and bookkeeping.
//
// A DRAG IS ONE COMMAND. `paintZoneRect` takes a rect, so a sixty-tile drag appends exactly
// one entry to the input trace instead of sixty. That is not an optimisation — it is what
// keeps replays small, bug reports readable, and a future undo one step per player action
// rather than one per tile.
//
// TILES BELONG TO AT MOST ONE ZONE. Membership lives on the tile (`CropTile.zone`), so
// "47 / 60 planted" is never ambiguous and painting over a neighbour reassigns rather than
// overlaps. A zone that loses its last tile is deleted — an empty plan is not a plan.

import { WORLD_TILES_HIGH, WORLD_TILES_WIDE, ZONE_PAINT_MAX_SPAN } from './data';
import { type WorldState, fieldIndex } from './state';

/** An integer tile rectangle. Width and height are counts, never coordinates. */
export interface TileRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const PaintMode = {
  Add: 'add',
  Remove: 'remove',
} as const;

export type PaintMode = (typeof PaintMode)[keyof typeof PaintMode];

/**
 * Clip a rect to the world, or return null when nothing survives.
 *
 * Clipping rather than rejecting: a drag that starts on dirt and ends off the edge of the
 * map is an ordinary gesture, and eating the whole command because the player overshot
 * would be the game arguing with a mouse.
 *
 * TO THE WORLD, NOT TO A FIELD RECT — since format 13 farmland is wherever the player tilled
 * it, so there is no rectangle to clip against. Which tiles inside the rect actually take
 * paint is decided per tile by `paintZoneRect` (farm tiles do, grass does not), exactly as
 * the old field-rect clip decided it for tiles outside the 8×8. The span cap is the same
 * cost bound it has always been.
 */
export function clipRectToField(rect: TileRect): TileRect | null {
  if (rect.w <= 0 || rect.h <= 0) return null;
  if (rect.w > ZONE_PAINT_MAX_SPAN || rect.h > ZONE_PAINT_MAX_SPAN) return null;

  const left = rect.x < 0 ? 0 : rect.x;
  const top = rect.y < 0 ? 0 : rect.y;
  const rightExclusive = Math.min(rect.x + rect.w, WORLD_TILES_WIDE);
  const bottomExclusive = Math.min(rect.y + rect.h, WORLD_TILES_HIGH);

  if (rightExclusive <= left || bottomExclusive <= top) return null;
  return { x: left, y: top, w: rightExclusive - left, h: bottomExclusive - top };
}

/**
 * Paint one rect into or out of a zone. Returns how many tiles actually changed hands.
 *
 * Reassignment is the rule, not a conflict: a tile painted into zone B leaves zone A on the
 * spot, and if that was A's last tile then A is deleted here rather than lingering as an
 * empty card.
 */
export function paintZoneRect(
  state: WorldState,
  zoneId: number,
  rect: TileRect,
  mode: PaintMode,
): number {
  const clipped = clipRectToField(rect);
  if (clipped === null) return 0;

  let changed = 0;
  for (let y = clipped.y; y < clipped.y + clipped.h; y++) {
    for (let x = clipped.x; x < clipped.x + clipped.w; x++) {
      const index = fieldIndex(state, x, y);
      if (index < 0) continue;
      const tile = state.field[index]!;

      if (mode === PaintMode.Add) {
        if (tile.zone === zoneId) continue;
        tile.zone = zoneId;
        changed += 1;
      } else {
        if (tile.zone !== zoneId) continue;
        tile.zone = 0;
        changed += 1;
      }
    }
  }

  if (changed > 0) pruneEmptyZones(state);
  return changed;
}

/** Delete every zone that no longer owns a tile. Called after any paint. */
export function pruneEmptyZones(state: WorldState): void {
  const owned = new Set<number>();
  for (let i = 0; i < state.field.length; i++) {
    const zone = state.field[i]!.zone;
    if (zone !== 0) owned.add(zone);
  }

  for (let i = state.zones.length - 1; i >= 0; i--) {
    const zone = state.zones[i]!;
    if (!owned.has(zone.id)) state.zones.splice(i, 1);
  }
}

/** The live readout behind a zone card. Recomputed on demand; nothing is cached. */
export interface ZoneCounts {
  tiles: number;
  planted: number;
  /** Ready to pull. It stays ready forever — nothing wilts (item 124). */
  mature: number;
  dry: number;
}

export function createZoneCounts(): ZoneCounts {
  return { tiles: 0, planted: 0, mature: 0, dry: 0 };
}

// --- auto-replant: RETIRED (item 146) ---------------------------------------------
//
// `advanceZones` and its two helpers lived here: the researched seed hopper planted one tile
// per armed zone per `AUTO_REPLANT_PERIOD_TICKS` from the player's own seed stock, served in
// priority order. Planter bots are the only automatic planting now — cheaper and earlier to
// make up for it — and the tick no longer has a zones phase at all: zones act on nothing,
// and the bots read them through `Machine.boundZone` on their own clock.
