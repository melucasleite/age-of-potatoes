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
   * The splitter and the merger, which are one tile ([[056]], closing [[024]]).
   *
   * SIMPLER THAN THE GRABBERS AND THAT IS THE FEATURE. A junction has no facing, so there is no
   * `placeDir` to carry, no chevron on the ghost, and nothing for R to turn: which of the two
   * devices it is gets decided by the belts the player runs into it, on the far side of the seam.
   * The tool is therefore an ordinary 1×1 click placement with nothing bolted on — see
   * `MachineKind.BeltJunction` for why the sim made it that way.
   */
  PlaceBeltJunction: 21,

  // --- the storage, orchard and bot machines ([[023]], [[030]], [[035]], [[038]]) ------
  //
  // EIGHT ROWS THAT ARE PURE DATA. Every one of them is an ordinary `PlaceMachine` on a
  // footprint the sim already publishes, so nothing below this line needed a new gesture, a new
  // command, or a branch anywhere in `pointer.ts` — which is exactly the claim `machineEntry`
  // and `toolFootprint` were written to make, finally being cashed.
  PlaceHandCart: 22,
  PlaceRootCellar: 23,
  PlaceComposter: 24,
  PlaceOrangeTree: 25,
  PlaceLemonTree: 26,
  PlaceKolaTree: 27,
  PlaceHarvesterDock: 28,
  PlacePlanterDock: 29,

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
   * Take anything off the lot ([[054]], widened by [[060]]).
   *
   * ONE CURSOR FOR EVERY REMOVAL IN THE GAME. It began as "Box Up" and worked on machines
   * only — which was not a scoping decision so much as an accident of which sim verb had been
   * wired up: `RemoveBelt`, `RemoveGrabber` and `RemovePipe` all existed, all refunded, and
   * none of them had ever been reachable from the client. Now the tool dispatches on whatever
   * is under it, so "how do I get rid of this?" has exactly one answer.
   *
   * IT COSTS NOTHING AND IT PAYS TWO DIFFERENT WAYS, which is the thing the ghost and the
   * ribbon exist to say out loud: a machine goes into the bag as a box with its dials and no
   * cash, and everything else is refunded on the spot. The money verb for a boxed machine is
   * still `SellBoxedMachine`, from the inventory panel, one deliberate step later.
   *
   * IN THE BUILD PALETTE THOUGH IT BUYS NOTHING, and that is a considered exception to the
   * header above rather than an oversight. The toolbelt is six slots of muscle memory and
   * full; this is the inverse of the rows next to it — you arm it, you drag, the lot changes
   * — so it belongs to the surface that edits the lot rather than to the one you reach for
   * every ten seconds.
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
 *   `line`  — press, drag, release: ONE belt run, which may turn one corner ([[059]]). It
 *             leads with the axis the cursor moved further along and R flips that; the sim
 *             still stores two straight segments, because that is what a corner is, but the
 *             player expresses it in one gesture and it enters the trace as one command.
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
    hint: 'drag a run off the field — it turns a corner; R flips it',
    costCents: beltPricePerTile(BeltTier.Basic),
    gesture: 'line',
  },
  [ToolMode.PlaceBeltFast]: {
    label: 'Fast Belt',
    hint: 'drag a run off the field — it turns a corner; R flips it',
    costCents: beltPricePerTile(BeltTier.Fast),
    gesture: 'line',
  },
  [ToolMode.PlaceBeltExpress]: {
    label: 'Express Belt',
    hint: 'drag a run off the field — it turns a corner; R flips it',
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

  [ToolMode.PlaceBeltJunction]: {
    // "splits or merges" rather than "splitter", because the row cannot know which one the
    // player is about to build — and neither can the tile until the belts arrive.
    label: 'Belt Junction',
    hint: 'click a tile where belts meet: it splits or merges',
    costCents: machinePrice(MachineKind.BeltJunction),
    gesture: 'click',
  },

  [ToolMode.PlaceHandCart]: {
    label: 'Hand Cart',
    hint: 'one product, parked wherever you leave it',
    costCents: machinePrice(MachineKind.HandCart),
    gesture: 'click',
  },
  [ToolMode.PlaceRootCellar]: {
    label: 'Root Cellar',
    hint: 'a hundred slots, and nothing in it ever wilts',
    costCents: machinePrice(MachineKind.RootCellar),
    gesture: 'click',
  },
  [ToolMode.PlaceComposter]: {
    label: 'Composter',
    hint: 'spoiled goods in, fertilizer out',
    costCents: machinePrice(MachineKind.Composter),
    gesture: 'click',
  },
  [ToolMode.PlaceOrangeTree]: {
    label: 'Orange Tree',
    hint: 'plant it once — it fruits on its own forever',
    costCents: machinePrice(MachineKind.OrangeTree),
    gesture: 'click',
  },
  [ToolMode.PlaceLemonTree]: {
    label: 'Lemon Tree',
    hint: 'plant it once — it fruits on its own forever',
    costCents: machinePrice(MachineKind.LemonTree),
    gesture: 'click',
  },
  [ToolMode.PlaceKolaTree]: {
    label: 'Kola Tree',
    hint: 'the nut the Grinder wants, grown instead of bought',
    costCents: machinePrice(MachineKind.KolaTree),
    gesture: 'click',
  },
  [ToolMode.PlaceHarvesterDock]: {
    // Both docks say "point it at a zone", because a dock with no zone bound has no orders and
    // its bot parks — which is the one thing a player who has just spent $600 must be told.
    label: 'Harvester Dock',
    hint: 'clear 2x2 — then point it at a zone',
    costCents: machinePrice(MachineKind.HarvesterDock),
    gesture: 'click',
  },
  [ToolMode.PlacePlanterDock]: {
    label: 'Planter Dock',
    hint: 'clear 2x2 — fill the hopper and point it at a zone',
    costCents: machinePrice(MachineKind.PlanterDock),
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
    label: 'Teardown',
    hint: 'click or drag: machines box up, belts and pipes refund',
    costCents: 0,
    // A RECT, LIKE ZONE PAINTING — and a click still works, because a click is a drag whose
    // anchor and cursor are the same tile and therefore a 1×1 rectangle. That is what lets
    // the single-machine walk-to errand survive the change; see `TeardownPlan.loneMachineTile`.
    gesture: 'rect',
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
    case ToolMode.PlaceBeltJunction:
      return MachineKind.BeltJunction;
    case ToolMode.PlaceHandCart:
      return MachineKind.HandCart;
    case ToolMode.PlaceRootCellar:
      return MachineKind.RootCellar;
    case ToolMode.PlaceComposter:
      return MachineKind.Composter;
    case ToolMode.PlaceOrangeTree:
      return MachineKind.OrangeTree;
    case ToolMode.PlaceLemonTree:
      return MachineKind.LemonTree;
    case ToolMode.PlaceKolaTree:
      return MachineKind.KolaTree;
    case ToolMode.PlaceHarvesterDock:
      return MachineKind.HarvesterDock;
    case ToolMode.PlacePlanterDock:
      return MachineKind.PlanterDock;
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
 * scan is over sixteen entries and runs when a player clicks a row in the inventory panel, not
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
  ToolMode.PlaceBeltJunction,
  ToolMode.PlaceHandCart,
  ToolMode.PlaceRootCellar,
  ToolMode.PlaceComposter,
  ToolMode.PlaceOrangeTree,
  ToolMode.PlaceLemonTree,
  ToolMode.PlaceKolaTree,
  ToolMode.PlaceHarvesterDock,
  ToolMode.PlacePlanterDock,
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
