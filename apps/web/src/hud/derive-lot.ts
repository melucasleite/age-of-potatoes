// The state of the lot: what is planted where, and what the machines are doing.
//
// WHY ONE SLICE AND NOT TWO. This file feeds two panels that ask the same question from
// opposite ends of a session. The zone card ([[021]]) asks "what is happening in my field
// right now"; the Welcome Back card ([[040]]) asks "what happened to my field while I was
// gone". Both are answered by one sweep of the projection, and splitting them would mean
// walking the field twice per publish to produce two views of the same sixty numbers.
//
// ⚠️ THIS FILE USED TO WALK THE FIELD AND IT NO LONGER DOES ([[124]]). Every per-tile read
// here existed to price decay: `RiskWatch`, `atRiskCents`, `imminentCents`, the sixty-second
// arming, the two-tense wilt alert and `riskForTile` were ~240 lines computing how much money
// a drooping crop was about to cost. Nothing droops now — a ripe crop is the same crop
// forever — so there is no bleed to time, no discount to price, and no alert to earn the
// right to speak. What is left reads `view.zones` and `view.machines`, both of which the sim
// publishes already counted, and the projection allocates and iterates nothing per tile.
//
// THE SEAM THAT REMAINS is still worth stating, because it is why the file did not simply
// collapse into `derive.ts`: the sim owns what a zone CONTAINS (tiles, planted, mature, dry)
// and the HUD owns what that is CALLED. `cropName`, `regrows` and the picker's rows are
// phrasing and gating decisions, and phrasing decisions live on this side of the line.

import { CROP_SPECS, CropId, LampState, MachineKind, cropSpec, techSatisfied } from '@snack/sim';
import type { WorldView } from '@snack/sim';

import { itemName } from './item-copy';
import type { ZoneCropOption, ZoneRow } from './types';

export interface LotFields {
  zones: ZoneRow[];
  machines: number;
  running: number;
  halted: number;
  jammed: number;
  starved: number;
  blocked: number;
  sprinklers: number;
  cropOptions: ZoneCropOption[];
}

export function createLotFields(): LotFields {
  return {
    zones: [],
    machines: 0,
    running: 0,
    halted: 0,
    jammed: 0,
    starved: 0,
    blocked: 0,
    sprinklers: 0,
    cropOptions: [],
  };
}

/**
 * One pass over the zones and one over the machines.
 *
 * Both lists arrive pre-counted from `view()`. The sim owns what a zone contains; this adds
 * the names and the seed counts, which are the two facts a rectangle cannot report about
 * itself.
 */
export function deriveLot(view: WorldView, out: LotFields): LotFields {
  // The picker's rows, read straight off the world's own unlocked list ([[102]]). Built before
  // the zones because each zone's seed count comes out of it.
  deriveCropOptions(view, out);

  out.zones.length = 0;
  for (const zone of view.zones) {
    // ⚠️ `crop` and `priority` USED TO BE DROPPED HERE and that was the whole data half of
    // [[102]]: the sim published them, this loop copied the counts, and working reducers ended
    // up with no caller in the app because the HUD could not see the state they wrote.
    // Anything `ZoneView` carries belongs on the row. (`autoReplant` was the third dropped
    // field; the hopper retired with its node — item 146 — and the view no longer carries it.)
    const spec = cropSpec(zone.crop as CropId);
    out.zones.push({
      id: zone.id,
      name: zone.name,
      crop: zone.crop,
      cropName: spec === null ? '' : itemName(spec.yieldItem),
      // READ, NEVER LISTED — `derive-dock.ts`'s rule, restated because it is the same fact and
      // a second table of "which crops regrow" would be wrong the first time a crop was added.
      regrows: spec !== null && spec.regrowTicks > 0 ? 1 : 0,
      priority: zone.priority,
      seeds: spec === null ? 0 : countOf(view, spec.seedItem),
      tiles: zone.tiles,
      planted: zone.planted,
      mature: zone.mature,
      dry: zone.dry,
    });
  }

  censusMachines(view, out);
  return out;
}

/** How many of one item the player is carrying. 0 for a stack they have never held. */
function countOf(view: WorldView, item: number): number {
  for (const slot of view.inventory) {
    if (slot.item === item) return slot.count;
  }
  return 0;
}

/**
 * The crop picker's rows — every crop `applySetZoneCrop` would accept, and no others.
 *
 * THE GATE IS ASKED, NOT GUESSED. The reducer's `cropAssignable` is `techSatisfied(state,
 * spec.requiresTech)`; this calls the same exported function on the same published list, so a
 * crop appears in the picker on exactly the tick it becomes plantable. A hand-kept list here
 * would offer Sugar Cane to a player who cannot plant it, and the refusal would arrive as
 * nothing happening at all — the failure mode this whole item exists to end.
 *
 * FALLOW IS A ROW, not an omission. `CropId.None` is assignable by the reducer's first line, and
 * "stop this rectangle sowing anything" is a thing a player wants to say — particularly once a
 * planter bot works the zone, where it is the difference between a plan and a runaway.
 */
function deriveCropOptions(view: WorldView, out: LotFields): void {
  out.cropOptions.length = 0;
  out.cropOptions.push({
    id: CropId.None,
    item: 0,
    name: 'Fallow',
    regrows: 0,
    seedItem: 0,
    seeds: 0,
  });
  for (const spec of CROP_SPECS) {
    if (!techSatisfied(view.unlocked, spec.requiresTech)) continue;
    out.cropOptions.push({
      id: spec.id,
      item: spec.yieldItem,
      name: itemName(spec.yieldItem),
      regrows: spec.regrowTicks > 0 ? 1 : 0,
      seedItem: spec.seedItem,
      seeds: countOf(view, spec.seedItem),
    });
  }
}

function censusMachines(view: WorldView, out: LotFields): void {
  out.machines = 0;
  out.running = 0;
  out.halted = 0;
  out.jammed = 0;
  out.starved = 0;
  out.blocked = 0;
  out.sprinklers = 0;

  for (const machine of view.machines) {
    // The sell bin is scenery with a lamp, not a machine the player runs. Counting it would
    // make "3 machines" mean something different from what the player can see standing there.
    if (machine.kind === MachineKind.SellBin) continue;
    out.machines += 1;
    if (machine.kind === MachineKind.Sprinkler) out.sprinklers += 1;
    switch (machine.lamp) {
      case LampState.Running:
        out.running += 1;
        break;
      case LampState.Halted:
        out.halted += 1;
        break;
      case LampState.Jammed:
        out.jammed += 1;
        break;
      case LampState.Starved:
        out.starved += 1;
        break;
      case LampState.Blocked:
        out.blocked += 1;
        break;
      default:
        break;
    }
  }
}
