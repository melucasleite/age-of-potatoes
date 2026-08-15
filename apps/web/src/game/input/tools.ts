// The cursor/tool mode, and what gesture each tool expects.
//
// This is UI state. It is NOT a command, is never recorded in the trace, and never enters
// the world — same rule as camera pan, camera zoom, hover, and menu state (§12). The sim
// does not know which tool is selected and must not: legality is decided from world state
// alone, so a replay does not depend on which button was lit.
//
// TWO SEPARATE SURFACES, AND THE SPLIT IS STILL DELIBERATE.
//
//   The HOTBAR (`hotbar.ts`, superseding the fixed six-slot `TOOL_ORDER` belt this header
//   used to argue for — [[061]]) is ten assignable slots along the bottom of the HUD,
//   bound to digits 1–9 and 0. It is the *hand*: the five hand verbs sit on it always and
//   cannot be removed, and the player fills the rest by dragging placeable items out of
//   the bag. What changed from the old argument is only WHO decides what is positional —
//   the layout is the player's now, not this file's. What did not change: a slot is still
//   one digit of muscle memory, and the bar still does not scroll.
//
//   `BUILD_CATALOGUE` (build-menu.ts) is everything you *buy*: zones, belts, arms, and
//   every machine. It lives behind `B`, is navigated with the arrow keys, and grows
//   without bound because nothing about it is positional. The hotbar adds shortcuts INTO
//   this catalogue; it does not replace it.
//
// The hotbar is muscle memory; the build menu is a shopping list. A shortcut the player
// placed themselves is the one kind of belt entry that is both.

import {
  BeltTier,
  CropId,
  GrabberTier,
  MachineKind,
  MachineRole,
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

  /**
   * The till ([[066]]): drag grass, get farmland; drag empty farmland, get grass back.
   *
   * A HAND TOOL, NOT A PURCHASE — free, indestructible, mandatory on the hotbar like the
   * other five verbs, which is why it lives up here with them rather than in the build
   * palette. One drag is ONE `TillTile` (zone-paint grammar, §16), and the ANCHOR decides
   * the mode exactly as the anchor decides which zone a paint grows: press on grass and the
   * drag tills, press on farmland and it un-tills. The sim skips per tile — occupied ground,
   * planted or compost-bearing tiles — and soil quality stays roll-once-per-position-ever
   * (`soilMemory`), so tilling is never a reroll.
   */
  Till: 34,

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
   * Spend one repair kit on a spot, servicing every machine around it (`UseRepairKit`).
   *
   * A CURSOR FOR A CONSUMABLE, AND THE DECISION IS WORTH RECORDING. The kit is bought at the
   * roadside stand (it is a good, not a machine), so it has no build-menu row; and it is not a
   * mandatory hand tool, because a permanent digit for an item the player may own zero of would
   * be a dead key on the bar. It reaches the hand the same way a boxed machine does ([[061]]):
   * `itemPlaceTool()` resolves `ItemId.RepairKit` to this cursor, so dragging the kit out of
   * the bag onto the hotbar gives it a digit, and pressing that digit arms this. The sim
   * refuses a click that would waste the kit — no machine in range wants anything — so a
   * misclick never eats the $8 (`applyUseRepairKit`'s own rule).
   *
   * OUT OF REACH DOES NOT WALK, unlike the hand verbs: the sim has no `IntentAction` for the
   * kit, and inventing one is a sim-lane change (trace format, save allowlist). Until it
   * exists, an out-of-reach click is refused by the reducer like any other — the same
   * "refusing with the existing affordance is fine" ruling item 052 made for rotation.
   */
  UseRepairKit: 30,

  // --- the maintenance chain ([[039]]) -------------------------------------------------
  //
  // Three more rows of pure data, exactly like the eight above: ordinary `PlaceMachine`s on
  // spec-published footprints, so nothing here needed a gesture, a command, or a `pointer.ts`
  // branch. The one wrinkle is the station's coverage preview — it shows the same 7×7 cell a
  // hand kit services, and `toolCoverageVerb` below keeps the ghost from claiming it "waters".
  PlaceMaintenanceStation: 31,
  PlaceDroneBay: 32,
  PlacePartsBench: 33,

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
   * IN THE BUILD PALETTE IT ALSO SITS, though it buys nothing — you arm it, you drag, the
   * lot changes, so it belongs with the rows that edit the lot. Since [[061]] it is ALSO a
   * mandatory hotbar tool (`HOTBAR_TOOLS`): "how do I get rid of this?" now has one answer
   * and one digit, and a player cannot rearrange themselves out of owning it.
   */
  Deconstruct: 19,
} as const;

export type ToolMode = (typeof ToolMode)[keyof typeof ToolMode];

/**
 * The OLD fixed belt order, kept for exactly one reader: the hidden in-canvas fallback HUD
 * (`render/hud.ts`), which never grew a hotbar because it draws nothing. The live surface
 * is `hotbar.ts` — new tools go in `HOTBAR_TOOLS` there, not here.
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
  [ToolMode.Till]: {
    label: 'Till',
    // Both halves of the verb in one sentence, because the anchor decides which one a drag
    // means and the player should learn that here rather than by surprise.
    hint: 'drag grass into farmland — start on dirt to turn it back',
    costCents: 0,
    // A rect, like zone painting: a click is a 1×1 drag, so single tiles still work.
    gesture: 'rect',
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

  [ToolMode.PlaceMaintenanceStation]: {
    label: 'Maintenance Station',
    // The cell sentence again, because the station IS the kit: same radius, same service,
    // minus the walk. What the hint must say is what keeps it alive — the belt of kits.
    hint: 'clear 2x2 — it throws kits at whatever nearby needs one',
    costCents: machinePrice(MachineKind.MaintenanceStation),
    gesture: 'click',
  },
  [ToolMode.PlaceDroneBay]: {
    label: 'Drone Bay',
    hint: 'clear 2x2 — its drone serves the whole lot, one part per fix',
    costCents: machinePrice(MachineKind.DroneBay),
    gesture: 'click',
  },
  [ToolMode.PlacePartsBench]: {
    label: 'Parts Bench',
    hint: 'bottle + kola powder in, drone part out',
    costCents: machinePrice(MachineKind.PartsBench),
    gesture: 'click',
  },

  [ToolMode.UseRepairKit]: {
    label: 'Repair Kit',
    // The radius sentence, because the kit's whole price argument is the cell, not the machine:
    // hand repair is free forever, and what $8 buys is every machine around one spot at once.
    hint: 'click among your machines — one kit services everything around the spot',
    costCents: 0,
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
    case ToolMode.PlaceMaintenanceStation:
      return MachineKind.MaintenanceStation;
    case ToolMode.PlaceDroneBay:
      return MachineKind.DroneBay;
    case ToolMode.PlacePartsBench:
      return MachineKind.PartsBench;
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
  ToolMode.PlaceMaintenanceStation,
  ToolMode.PlaceDroneBay,
  ToolMode.PlacePartsBench,
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

/**
 * The Chebyshev radius the placed machine will water, for the ghost's coverage preview.
 * Zero for anything without an area of effect.
 *
 * READ FROM THE SPEC, NEVER TYPED HERE — the sim anchors coverage on the machine's anchor
 * tile (`advanceSprinkler`, and the Hub's own comment: "what the placement overlay draws is
 * exactly what gets watered"), so the one honest preview is the one derived from the same
 * number the watering loop reads. The barrel sprinkler is the only placeable head today;
 * any future tool whose machine declares `coverageRadiusTiles` gets the preview for free.
 */
export function toolCoverageRadius(tool: ToolMode): number {
  const kind = toolMachineKind(tool);
  if (kind === null) return 0;
  return machineSpec(kind)?.coverageRadiusTiles ?? 0;
}

/**
 * What the coverage preview's label says the machine DOES to its square.
 *
 * The sprinklers water theirs; the Maintenance Station ([[039]]) reuses the same
 * `coverageRadiusTiles` plumbing to declare its service cell, and a ghost that said the
 * repair bench "waters 7×7" would be the preview lying about the one fact it exists to
 * state. Decided by the spec's role rather than by tool id, so the next coverage machine
 * gets the right sentence for free — or is at worst damp instead of wrong.
 */
export function toolCoverageVerb(tool: ToolMode): string {
  const kind = toolMachineKind(tool);
  const role = kind === null ? null : machineSpec(kind)?.role;
  return role === MachineRole.MaintenanceStation ? 'services' : 'waters';
}

/**
 * ONE icon sprite per hand tool, Minecraft-style ([[065]]): the SAME atlas frame draws big
 * in the tool's hotbar slot and small in the avatar's hands when armed, so what you see on
 * the bar is what your character is holding — by construction, not by coincidence.
 *
 * The names are the art pipeline's own ids (`art/manifest.json`, `tool_*`, 16×16, on the
 * items page). Resolution to atlas rectangles happens at each consumer — the HUD through
 * `hud/item-art.ts`'s `resolveFrameIcon`, the renderer through its loaded atlas — and a
 * frame the atlas has not packed yet degrades to the letter chip / nothing rather than
 * magenta ([[037]]). This table is deliberately ONLY the mandatory hotbar verbs: item
 * shortcuts already draw as their item, and placement cursors draw as their machine.
 */
const TOOL_ICON_FRAMES: Readonly<Partial<Record<ToolMode, string>>> = {
  [ToolMode.Hand]: 'tool_hand',
  [ToolMode.Water]: 'tool_water',
  [ToolMode.Plant]: 'tool_plant',
  [ToolMode.Harvest]: 'tool_harvest',
  [ToolMode.Till]: 'tool_till',
  [ToolMode.Deconstruct]: 'tool_deconstruct',
};

/** The slot art for a hand tool, or `''` for a tool that draws as something else. */
export function toolIconFrame(tool: ToolMode): string {
  return TOOL_ICON_FRAMES[tool] ?? '';
}

/**
 * The frame the avatar HOLDS while this tool is armed, or `''` for empty hands.
 *
 * Identical to `toolIconFrame` for every tool except the Hand: the glove is the SLOT's
 * picture of the default verb, but the default verb IS empty hands, and an avatar visibly
 * clutching a second glove would be the overlay inventing an object the player never armed.
 * The equality (minus that one exception) is pinned by the mapping test in `hotbar.test.ts`.
 */
export function toolHeldFrame(tool: ToolMode): string {
  return tool === ToolMode.Hand ? '' : toolIconFrame(tool);
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
