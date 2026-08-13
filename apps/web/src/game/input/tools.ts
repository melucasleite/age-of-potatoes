// The cursor/tool mode, and what gesture each tool expects.
//
// This is UI state. It is NOT a command, is never recorded in the trace, and never enters
// the world — same rule as camera pan, camera zoom, hover, and menu state (§12). The sim
// does not know which tool is selected and must not: legality is decided from world state
// alone, so a replay does not depend on which button was lit.
//
// TWO SEPARATE SURFACES, AND THE SPLIT IS DELIBERATE.
//
//   `TOOL_ORDER` is the six-slot toolbelt along the bottom of the HUD, bound to digits
//   1–6. It is the *hand* — the verbs you use constantly. It has exactly six entries and
//   should keep having exactly six: the HUD derives one button per entry and one digit
//   per button, so a seventh entry silently costs a keyboard shortcut and a fifteenth
//   would need a scrollbar.
//
//   `BUILD_CATALOGUE` (build-menu.ts) is everything you *buy*: zones, belts, arms, and
//   the five chip-line machines. It lives behind `B`, is navigated with the arrow keys,
//   and grows without bound because nothing about it is positional.
//
// Adding the fifteen buildables to the toolbelt instead would have been fewer files and
// the wrong shape. The toolbelt is muscle memory; the build menu is a shopping list.

import {
  BeltTier,
  CropId,
  GrabberTier,
  MachineKind,
  beltSpec,
  grabberSpec,
  machineSpec,
} from '@snack/sim';

export const ToolMode = {
  /** Interact: load, unload, refill, sell, whack. Reads the machine under the cursor. */
  Hand: 0,
  Water: 1,
  Plant: 2,
  Harvest: 3,
  PlaceSprinkler: 4,
  PlaceChipKitchen: 5,

  // --- the build menu ---------------------------------------------------------------
  // Everything below is armed from the `B` palette, never from a digit key.
  PaintZone: 6,
  EraseZone: 7,

  PlaceBeltBasic: 8,
  PlaceBeltFast: 9,
  PlaceBeltExpress: 10,

  PlaceGrabberMk1: 11,
  PlaceGrabberMk2: 12,
  PlaceGrabberLong: 13,

  PlaceWasher: 14,
  PlaceSlicer: 15,
  PlaceFryer: 16,
  PlaceSeasoner: 17,
  PlaceBagger: 18,

  /**
   * Buy the deed to the parcel under the cursor (plan §5, [[053]]).
   *
   * IN THE BUILD PALETTE, WHERE THE THINGS YOU BUY LIVE, and it is the largest thing in it by
   * some distance. It behaves like every other row: arm it, click, the lot changes. What makes
   * it different is that the price is not on the tool — a deed costs what the ladder says the
   * NEXT one costs, so `TOOL_INFO.costCents` is zero here and `buildRows()` reads the live
   * number off the projection. A price baked into a constant would go stale the moment the
   * first deed was bought.
   */
  BuyDeed: 20,

  /**
   * Box a machine up and put it in the pouch ([[054]]).
   *
   * IN THE BUILD PALETTE THOUGH IT BUYS NOTHING, and that is a considered exception to the
   * header above rather than an oversight. The toolbelt is six slots of muscle memory and
   * full; this is the inverse of the fifteen rows next to it — you arm it, you click a
   * machine, the lot changes — so it belongs to the surface that edits the lot rather than
   * to the one you reach for every ten seconds. It costs nothing and pays nothing: the
   * money verb is `SellBoxedMachine`, from the inventory panel, one deliberate step later.
   */
  Deconstruct: 19,
} as const;

export type ToolMode = (typeof ToolMode)[keyof typeof ToolMode];

/**
 * The toolbelt. SIX ENTRIES, bound to digits 1–6 — see the header before adding a
 * seventh. Buildables go in `BUILD_CATALOGUE`.
 */
export const TOOL_ORDER: readonly ToolMode[] = [
  ToolMode.Hand,
  ToolMode.Water,
  ToolMode.Plant,
  ToolMode.Harvest,
  ToolMode.PlaceSprinkler,
  ToolMode.PlaceChipKitchen,
];

/**
 * What a press-and-drag means for this tool.
 *
 *   `click` — one press is one command, on the press edge. No drag verb.
 *   `rect`  — press, drag a rectangle, release: ONE rect command (§16, and the reason is
 *             in `commands.ts` — a sixty-tile paint is one trace entry, not sixty).
 *   `line`  — press, drag, release: one straight run along the dominant axis. Belts are
 *             straight segments in the sim and corners are two segments meeting, so the
 *             gesture matches the data rather than papering over it.
 */
export type GestureKind = 'click' | 'rect' | 'line';

export interface ToolInfo {
  readonly label: string;
  readonly hint: string;
  /**
   * Cents this tool spends per use, for the affordability hint. Zero for hand verbs. For
   * belts this is the price of ONE TILE — the run is priced by the drag, live, in the
   * preview label.
   */
  readonly costCents: number;
  readonly gesture: GestureKind;
}

/** Prices come from the sim's balance data, never from a number typed twice. */
function machinePrice(kind: MachineKind): number {
  return machineSpec(kind)?.priceCents ?? 0;
}

function beltPricePerTile(tier: BeltTier): number {
  return beltSpec(tier)?.priceCentsPerTile ?? 0;
}

function grabberPrice(tier: GrabberTier): number {
  return grabberSpec(tier)?.priceCents ?? 0;
}

export const TOOL_INFO: Readonly<Record<ToolMode, ToolInfo>> = {
  [ToolMode.Hand]: {
    label: 'Hand',
    hint: 'click a machine: load / take / refill / sell',
    costCents: 0,
    gesture: 'click',
  },
  [ToolMode.Water]: {
    label: 'Water',
    hint: 'click soil to pour the can',
    costCents: 0,
    gesture: 'click',
  },
  [ToolMode.Plant]: {
    label: 'Plant',
    hint: 'click bare soil to sow a potato',
    costCents: 0,
    gesture: 'click',
  },
  [ToolMode.Harvest]: {
    label: 'Harvest',
    hint: 'click a ripe plant to pull it',
    costCents: 0,
    gesture: 'click',
  },
  [ToolMode.PlaceSprinkler]: {
    label: 'Buy Sprinkler',
    hint: 'click ground beside the field ($150)',
    costCents: machinePrice(MachineKind.Sprinkler),
    gesture: 'click',
  },
  [ToolMode.PlaceChipKitchen]: {
    label: 'Buy Chip Kitchen',
    hint: 'click 2x2 of clear ground ($100)',
    costCents: machinePrice(MachineKind.ChipKitchen),
    gesture: 'click',
  },

  [ToolMode.PaintZone]: {
    label: 'Grow Zone',
    hint: 'drag a rectangle across the field',
    costCents: 0,
    gesture: 'rect',
  },
  [ToolMode.EraseZone]: {
    label: 'Erase Zone',
    hint: 'drag over zoned tiles to release them',
    costCents: 0,
    gesture: 'rect',
  },

  [ToolMode.PlaceBeltBasic]: {
    label: 'Belt',
    hint: 'drag a straight run off the field',
    costCents: beltPricePerTile(BeltTier.Basic),
    gesture: 'line',
  },
  [ToolMode.PlaceBeltFast]: {
    label: 'Fast Belt',
    hint: 'drag a straight run off the field',
    costCents: beltPricePerTile(BeltTier.Fast),
    gesture: 'line',
  },
  [ToolMode.PlaceBeltExpress]: {
    label: 'Express Belt',
    hint: 'drag a straight run off the field',
    costCents: beltPricePerTile(BeltTier.Express),
    gesture: 'line',
  },

  [ToolMode.PlaceGrabberMk1]: {
    label: 'Grabber Mk1',
    hint: 'R rotates; it moves goods the way it points',
    costCents: grabberPrice(GrabberTier.Mk1),
    gesture: 'click',
  },
  [ToolMode.PlaceGrabberMk2]: {
    label: 'Grabber Mk2',
    hint: 'filtered arm — R rotates',
    costCents: grabberPrice(GrabberTier.Mk2),
    gesture: 'click',
  },
  [ToolMode.PlaceGrabberLong]: {
    label: 'Long Grabber',
    hint: 'reaches two tiles — R rotates',
    costCents: grabberPrice(GrabberTier.Long),
    gesture: 'click',
  },

  [ToolMode.PlaceWasher]: {
    label: 'Washer',
    hint: 'click 2x2 of clear ground',
    costCents: machinePrice(MachineKind.Washer),
    gesture: 'click',
  },
  [ToolMode.PlaceSlicer]: {
    label: 'Slicer',
    hint: 'click 2x2 of clear ground',
    costCents: machinePrice(MachineKind.Slicer),
    gesture: 'click',
  },
  [ToolMode.PlaceFryer]: {
    label: 'Fryer',
    hint: 'the bottleneck — you will want two',
    costCents: machinePrice(MachineKind.Fryer),
    gesture: 'click',
  },
  [ToolMode.PlaceSeasoner]: {
    label: 'Seasoner',
    hint: 'click 2x2 of clear ground',
    costCents: machinePrice(MachineKind.Seasoner),
    gesture: 'click',
  },
  [ToolMode.PlaceBagger]: {
    label: 'Bagger',
    hint: 'click 2x2 of clear ground',
    costCents: machinePrice(MachineKind.Bagger),
    gesture: 'click',
  },

  [ToolMode.BuyDeed]: {
    label: 'Land Deed',
    hint: 'click a parcel next to yours to buy it',
    // The live price comes from `WorldView.land.nextPriceCents`; see `ToolMode.BuyDeed`.
    costCents: 0,
    gesture: 'click',
  },

  [ToolMode.Deconstruct]: {
    label: 'Box Up',
    hint: 'click a machine to box it — dials and wear come with it',
    costCents: 0,
    gesture: 'click',
  },
};

/** The crop a brand-new zone is assigned. Others are picked with `C` once researched. */
export const DEFAULT_ZONE_CROP = CropId.RussetPotato;

/** The only crop in v0.1, still the only one the hand-plant verb sows. */
export const V01_CROP = CropId.RussetPotato;

export function gestureFor(tool: ToolMode): GestureKind {
  return TOOL_INFO[tool].gesture;
}

export function toolMachineKind(tool: ToolMode): MachineKind | null {
  switch (tool) {
    case ToolMode.PlaceSprinkler:
      return MachineKind.Sprinkler;
    case ToolMode.PlaceChipKitchen:
      return MachineKind.ChipKitchen;
    case ToolMode.PlaceWasher:
      return MachineKind.Washer;
    case ToolMode.PlaceSlicer:
      return MachineKind.Slicer;
    case ToolMode.PlaceFryer:
      return MachineKind.Fryer;
    case ToolMode.PlaceSeasoner:
      return MachineKind.Seasoner;
    case ToolMode.PlaceBagger:
      return MachineKind.Bagger;
    default:
      return null;
  }
}

/**
 * The inverse: which tool puts THIS machine kind down. `null` for a kind nothing places.
 *
 * DERIVED FROM `toolMachineKind` RATHER THAN WRITTEN OUT AGAIN, because a second switch is a
 * second switch that can disagree — and the way it would disagree is a boxed Fryer whose
 * "place" button arms the Seasoner, which is a silent, expensive, entirely plausible bug. The
 * scan is over seven entries and runs when a player clicks a row in the inventory panel, not
 * per frame.
 *
 * Exists for [[054]]'s inventory panel: a boxed row's place affordance arms the build tool for
 * `InventoryView.boxedMachineKind`, and `PlaceMachine` then opens the box instead of buying.
 */
export function toolForMachineKind(kind: MachineKind): ToolMode | null {
  for (let i = 0; i < PLACEMENT_TOOLS.length; i++) {
    const tool = PLACEMENT_TOOLS[i]!;
    if (toolMachineKind(tool) === kind) return tool;
  }
  return null;
}

const PLACEMENT_TOOLS: readonly ToolMode[] = [
  ToolMode.PlaceSprinkler,
  ToolMode.PlaceChipKitchen,
  ToolMode.PlaceWasher,
  ToolMode.PlaceSlicer,
  ToolMode.PlaceFryer,
  ToolMode.PlaceSeasoner,
  ToolMode.PlaceBagger,
];

export function toolBeltTier(tool: ToolMode): BeltTier | null {
  switch (tool) {
    case ToolMode.PlaceBeltBasic:
      return BeltTier.Basic;
    case ToolMode.PlaceBeltFast:
      return BeltTier.Fast;
    case ToolMode.PlaceBeltExpress:
      return BeltTier.Express;
    default:
      return null;
  }
}

export function toolGrabberTier(tool: ToolMode): GrabberTier | null {
  switch (tool) {
    case ToolMode.PlaceGrabberMk1:
      return GrabberTier.Mk1;
    case ToolMode.PlaceGrabberMk2:
      return GrabberTier.Mk2;
    case ToolMode.PlaceGrabberLong:
      return GrabberTier.Long;
    default:
      return null;
  }
}

/** The footprint a placement tool will occupy, for the ghost. `null` when it has none. */
export function toolFootprint(tool: ToolMode): { tilesWide: number; tilesHigh: number } | null {
  const kind = toolMachineKind(tool);
  if (kind !== null) {
    const spec = machineSpec(kind);
    return spec === null ? null : { tilesWide: spec.tilesWide, tilesHigh: spec.tilesHigh };
  }
  if (toolGrabberTier(tool) !== null) return { tilesWide: 1, tilesHigh: 1 };
  return null;
}
