// Painted Grow Zones.
//
// A ZONE IS A PLAN, NOT A MACHINE (plan §5). Out of the box it plants nothing, waters
// nothing, and harvests nothing — it is structure for manual work, and its card is the
// to-do list that turns "click dirt" into "run a farm". The one thing that can ever make it
// act on its own is the seed hopper, and that is a tech node the player buys, which is the
// Assisted rung of plan §3's ladder arriving on schedule rather than a zone quietly
// skipping it.
//
// A DRAG IS ONE COMMAND. `paintZoneRect` takes a rect, so a sixty-tile drag appends exactly
// one entry to the input trace instead of sixty. That is not an optimisation — it is what
// keeps replays small, bug reports readable, and a future undo one step per player action
// rather than one per tile.
//
// TILES BELONG TO AT MOST ONE ZONE. Membership lives on the tile (`CropTile.zone`), so
// "47 / 60 planted" is never ambiguous and painting over a neighbour reassigns rather than
// overlaps. A zone that loses its last tile is deleted — an empty plan is not a plan.

import {
  AUTO_REPLANT_PERIOD_TICKS,
  CropId,
  WORLD_TILES_HIGH,
  WORLD_TILES_WIDE,
  ZONE_PAINT_MAX_SPAN,
  cropSpec,
} from './data';
import { type WorldState, type Zone, fieldIndex, machineAt, plantCrop, removeItem } from './state';
import { TechId, hasTech } from './tech';

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

// --- auto-replant -----------------------------------------------------------------

/**
 * The seed hopper.
 *
 * Only runs at all once `TechId.AutoReplant` is researched, and only for zones whose
 * auto-replant toggle is on and whose crop is assigned. It plants ONE tile per zone per
 * `AUTO_REPLANT_PERIOD_TICKS` from the player's own seed stock — it is a hopper, not a
 * farmhand, and plan §8 cuts hired workers forever precisely so that automation stays
 * "you → machines you earned".
 *
 * Zone priority is what decides who gets served when seeds are short. That is the only
 * thing priority drives today, and it is why the field is stored rather than decorative.
 *
 * An auto-replant is NOT a manual touch. The Hands-Free board (plan §6) exists to reward
 * exactly this, so counting it would make the automation the player bought score as if they
 * had bent down and done it themselves.
 */
export function advanceZones(state: WorldState): void {
  if (!hasTech(state.unlocked, TechId.AutoReplant)) return;

  let anyArmed = false;
  for (let i = 0; i < state.zones.length; i++) {
    const zone = state.zones[i]!;
    if (zone.autoReplant && zone.crop !== CropId.None) {
      anyArmed = true;
      break;
    }
  }
  if (!anyArmed) return;

  const order = zonesByPriority(state);
  for (let i = 0; i < order.length; i++) {
    const zone = order[i]!;
    if (!zone.autoReplant || zone.crop === CropId.None) {
      zone.replantCooldown = 0;
      continue;
    }
    if (zone.replantCooldown > 0) {
      zone.replantCooldown -= 1;
      continue;
    }
    if (replantOneTile(state, zone)) {
      zone.replantCooldown = AUTO_REPLANT_PERIOD_TICKS;
    }
  }
}

/**
 * Zones ordered by descending priority, then ascending id.
 *
 * A copied array sorted with a total-order comparator: ids are unique, so no two entries
 * ever compare equal and the result cannot depend on the sort's stability. Allocating here
 * is fine because the caller has already established that at least one zone is armed, which
 * is false for most of a world's life.
 */
function zonesByPriority(state: WorldState): Zone[] {
  const order: Zone[] = [];
  for (let i = 0; i < state.zones.length; i++) order.push(state.zones[i]!);
  order.sort((a, b) => (a.priority === b.priority ? a.id - b.id : b.priority - a.priority));
  return order;
}

/** Plant the first empty tile of a zone, in field order. Returns false if it cannot. */
function replantOneTile(state: WorldState, zone: Zone): boolean {
  const spec = cropSpec(zone.crop);
  if (spec === null) return false;

  for (let i = 0; i < state.field.length; i++) {
    const tile = state.field[i]!;
    if (tile.zone !== zone.id) continue;
    if (tile.crop !== CropId.None) continue;
    // A farm tile hosting a field-placed machine (item 067) grows nothing while it stands —
    // the hopper skips it exactly as the planter bot does, and keeps the seed.
    if (machineAt(state, tile.tileX, tile.tileY) !== null) continue;
    if (!removeItem(state, spec.seedItem, 1)) return false;
    plantCrop(state, tile, spec);
    return true;
  }
  return false;
}
