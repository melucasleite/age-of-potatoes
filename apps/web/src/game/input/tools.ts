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
  PIPE_PRICE_CENTS_PER_TILE,
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

  /**
   * **RETIRED** ([[145]]). The Chip Kitchen was the starter machine, and the owner cut it with
   * the rest of the vestigial roster: the researched Wash & Slice → Fryer → Finishing line is
   * the only chip route now, and the early game sells raw produce until research.
   * `MachineKind.ChipKitchen` is gone from the sim, so there is no kind to place and no price
   * to quote.
   *
   * **THE ID STAYS SPENT.** See `ToolMode.PlacePartsBench` for why an enum member outlives its
   * feature: a saved hotbar is validated whole, and one unknown number discards all of it. This
   * one shipped as slot six of the original fixed belt, so it is the single most likely number
   * to be pinned on a veteran's toolbar.
   */
  PlaceChipKitchen: 5,

  /**
   * The till ([[066]], third rung [[127]]): drag grass, get farmland; drag a laden tile, get
   * what was on it back; drag bare farmland, get grass back.
   *
   * A HAND TOOL, NOT A PURCHASE — free, indestructible, mandatory on the hotbar like the
   * other five verbs, which is why it lives up here with them rather than in the build
   * palette. One drag is ONE `TillTile` (zone-paint grammar, §16), and the ANCHOR decides
   * the mode exactly as the anchor decides which zone a paint grows.
   *
   * **THREE MODES NOW, AND THE ANCHOR STILL PICKS EXACTLY ONE** ([[127]]). The tool always
   * takes back one layer of what you did, so the ladder is guessable rather than memorised:
   *
   *   - press on grass → `Till`, and the whole rect breaks ground.
   *   - press on a LADEN farm tile — a crop growing in it → `Unplant`,
   *     and the whole rect hands that back and STAYS FARMLAND.
   *   - press on BARE farmland → `Untill`, and the whole rect goes back to grass.
   *
   * `Unplant` and `Untill` PARTITION the farm tiles — laden and bare, one rung each — so
   * there is no farm tile the till has no answer for and no tile two modes both want. That
   * partition is the sim's (`applyTillTile`), mirrored here and pinned tile-for-tile against
   * the real reducer in `till-mirror.test.ts`; `tillModeFor` and `tillConverts` in
   * `pointer.ts` are the two halves of the mirror.
   *
   * ONE MODE PER DRAG, and a tile that does not match it is skipped rather than converted the
   * other way — the sim's ruling, and the reason a rect over mixed ground is readable at all.
   * The sim skips per tile on its own account too: occupied ground (machines, belts, arms,
   * pipes, water) is passed over in every mode, and the soil TYPE (loam/sand/clay — growth
   * speed and water drain, never yield and never degrading) stays roll-once-per-position-ever
   * (`soilMemory`), so tilling is never a reroll. Not to be confused with the soil QUALITY
   * [[124]] deleted: `fertility` was a yield multiplier that stepped down as you harvested.
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

  /**
   * **RETIRED** ([[145]]). The Root Cellar went with the harvest-bigger-than-the-line era it
   * was built for — `MachineKind.RootCellar` and its tech node are gone from the sim. The Hand
   * Cart is the storage that remains.
   *
   * **THE ID STAYS SPENT**, per `ToolMode.PlacePartsBench`: a saved hotbar is validated whole,
   * and one unknown number discards all of it.
   */
  PlaceRootCellar: 23,

  /**
   * **RETIRED** ([[124]]). The owner deleted the entire waste loop — nothing spoils, so there
   * is nothing to compost and no fertilizer to make — and `MachineKind.Composter` went with it.
   * This tool has no `BUILD_ROWS` entry, no `PLACEMENT_TOOLS` membership and no
   * `toolMachineKind` mapping. Nothing offers it and the sim would refuse the placement anyway.
   *
   * **THE ID STAYS SPENT AND THE MEMBER STAYS IN THE ENUM**, for the reason spelled out at
   * `ToolMode.PlacePartsBench`: `hotbar.ts` validates a saved layout against
   * `Object.values(ToolMode)` and one unknown number rejects the WHOLE layout, so deleting 24
   * would wipe the toolbelt of exactly the player who had pinned a Composter to it. Reusing 24
   * for a future tool would be worse still — it would open something else entirely.
   */
  PlaceComposter: 24,

  /**
   * **RETIRED** ([[145]]), both trees at once: the Orange and Lemon items had no consumer, so
   * the trees that grew them went with the orchard tech. `MachineKind.OrangeTree` and
   * `MachineKind.LemonTree` are gone from the sim; the Kola Tree below is the whole orchard now.
   *
   * **BOTH IDS STAY SPENT**, per `ToolMode.PlacePartsBench`: a saved hotbar is validated whole,
   * and one unknown number discards all of it.
   */
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

  /**
   * **RETIRED** ([[145]]). The Maintenance Station threw kits so the player did not have to
   * walk; the owner cut it, so automated repair is the Drone Bay's job alone and the hand kit
   * is the assisted rung. `MachineKind.MaintenanceStation` and `MachineRole.MaintenanceStation`
   * are gone from the sim, and `toolCoverageVerb` lost its one non-"waters" sentence with them.
   *
   * **THE ID STAYS SPENT**, per `ToolMode.PlacePartsBench`: a saved hotbar is validated whole,
   * and one unknown number discards all of it.
   */
  PlaceMaintenanceStation: 31,
  PlaceDroneBay: 32,

  // --- the five that had no cursor ([[100]]) -------------------------------------------
  //
  // NOT NEW MACHINES. Every one of these was shipped, priced, gated and tested in the sim, and
  // a verifier placed all five through `applyPlaceMachine` in a researched world — they were
  // unreachable purely because this enum stopped at eighteen entries and every road to
  // `PlaceMachine` runs through it (no member → no `toolMachineKind` case → no
  // `PLACEMENT_TOOLS` entry → no catalogue row → no command, and `toolForMachineKind` returns
  // null so even a BOXED one in the bag has no place button). Fifteen machines were behind that
  // wall; these are the five with `ports: []`, which need nothing but a row.
  //
  // WHY THE GRINDER IS HERE AND THE JUICER IS NOT. [[056]] deferred this whole set with a sound
  // argument — "a Pump you cannot plumb is worse than none" — and then the Grinder was swept up
  // with the plumbing it does not have. It is `liquid: None, ports: []`: kola nut in on a belt,
  // kola powder out on a belt, and its node's own copy claiming "this half runs on pipe" is
  // what sent five separate auditors straight past it.
  PlaceGrinder: 35,
  PlaceSixPacker: 36,
  PlaceComboPacker: 37,
  /**
   * The one with no tech gate at all — `requiresTech: null`, unbuildable since the day it
   * landed, on every save, forever. §3's ladder runs manual → assisted → automated for every
   * system in the game, and selling was the column that stopped at the roadside stand because
   * its assisted rung had a spec, a price, a sprite and no cursor.
   */
  PlaceDeliveryCart: 38,
  PlaceTruckDepot: 39,

  /**
   * **LAY A RUN OF PIPE** ([[101]]) — the verb the game shipped without.
   *
   * `RemovePipe` had four issuers in this app and `PlacePipe` had ZERO: a demolition verb for a
   * structure with no construction verb, and behind that hole all six HYDRAULICS nodes, $6,100
   * of research that changed nothing about the game. [[056]] deferred it on a sound argument —
   * "a Pump you cannot plumb is worse than none" — and this is the other half of that deferral
   * finally arriving.
   *
   * A `line` GESTURE, WHICH IS THE BELT'S, UNCHANGED. `water-works.json` lays its water main as
   * a single seventeen-tile L and `soda-line.json` lays four two-tile stubs and two single
   * tiles; every one of those is `elbowBetween` output already, down to the tile ORDER. So the
   * pipe drag inherits the corner, R flipping the corner, the whole-run-refused-together band
   * and the one-drag-one-command rule for free, and `PlacePipeCommand.path` was built to carry
   * exactly that shape ("ONE DRAG IS ONE COMMAND, exactly as it is for zone painting and for
   * belts", `commands.ts`).
   *
   * WHAT IT DOES NOT HAVE IS A LIQUID PICKER, and that is a decision rather than an omission —
   * see `pipeRunLiquid` in `pointer.ts`, which reads the liquid off the machines and pipes the
   * run touches, by the same rule the reducer refuses on.
   *
   * NOT A `MachineKind`, so `toolMachineKind` returns null for it, it is not in
   * `PLACEMENT_TOOLS`, and it will never appear in a machine-versus-tool count. Its catalogue
   * row is hand-built for the same reason a belt's is.
   */
  PlacePipe: 40,

  // --- the plumbing, and the soda line ([[101]]) ---------------------------------------
  //
  // TEN MORE ROWS OF PURE DATA, exactly like the eight storage/orchard/bot rows above: ordinary
  // `PlaceMachine`s on spec-published footprints, no new gesture and no `pointer.ts` branch
  // between them. What they were waiting on was never a placement rule — it was the pipe above,
  // because a Pump, a Tank and a Bottler with nothing to connect them are furniture.
  PlacePump: 41,
  PlaceTank: 42,
  PlacePipedSprinkler: 43,
  PlaceIrrigationHub: 44,

  /**
   * **RETIRED** ([[145]]). The Recirculator caught the Washer's runoff; the owner cut it with
   * the rest of the vestigial roster, so `MachineKind.Recirculator` and
   * `MachineRole.Recirculator` are gone from the sim and the graywater loop with them.
   *
   * **THE ID STAYS SPENT**, per `ToolMode.PlacePartsBench`: a saved hotbar is validated whole,
   * and one unknown number discards all of it.
   */
  PlaceRecirculator: 45,

  PlaceJuicer: 46,
  PlaceKettle: 47,
  PlaceSyrupMixer: 48,
  PlaceCarbonator: 49,
  PlaceBottler: 50,
  /**
   * **RETIRED** ([[124]]). Fertilizer, soil quality and the Composter that made the bags were
   * all deleted together, so there is no `ItemId.Fertilizer` for `itemPlaceTool()` to resolve,
   * no `ApplyFertilizer` command for `intentCommand` to build, and no `IntentAction.Fertilize`.
   *
   * Item [[104]] shipped this cursor to fix the opposite problem — the command had ZERO
   * emitters, so a bag's only use was selling it back — which is worth recording, because the
   * lesson generalises: a verb with no cursor is invisible, and the fix is either to build the
   * cursor or to delete the verb. This wave chose the second.
   *
   * **THE ID STAYS SPENT.** See `ToolMode.PlacePartsBench` for why an enum member outlives its
   * feature: a saved hotbar is validated whole, and one unknown number discards all of it.
   */
  ApplyFertilizer: 51,

  /**
   * **RETIRED** ([[140]]). The well was the machine invented to relieve a scarcity, and the
   * owner deleted the scarcity: a pond is an unlimited source now, so a machine whose entire
   * purpose was "make this pond produce more" has nothing left to sell. `MachineKind.ArtesianWell`
   * and `TechId.ArtesianWell` are both gone from the sim, so there is no kind to place, no node
   * to gate it behind and no price to quote.
   *
   * **THE ID STAYS SPENT.** See `ToolMode.PlacePartsBench` for why an enum member outlives its
   * feature: a saved hotbar is validated whole, and one unknown number discards all of it. This
   * one is the likeliest of the three to have been pinned — it shipped ten days ago as the
   * answer to "how do I boost my pump", which is exactly the row a thirsty player puts on their
   * belt.
   */
  PlaceArtesianWell: 52,

  /**
   * **RETIRED** (item 090). The Parts Bench left the build catalogue when repair drones started
   * fixing machines for free, so this tool has no `BUILD_ROWS` entry, no `PLACE_TOOLS`
   * membership and no `toolMachineKind` mapping — nothing offers it and the sim would refuse
   * the placement regardless.
   *
   * **THE ID STAYS SPENT, AND THE MEMBER STAYS IN THE ENUM, BECAUSE A HOTBAR IS SAVED.**
   * `hotbar.ts` validates a persisted layout against `Object.values(ToolMode)` and rejects the
   * WHOLE layout on one unknown number — so deleting this member would silently wipe the
   * carefully arranged toolbelt of the one kind of player most likely to have pinned it. It
   * degrades to a slot that does nothing instead, which is the smaller unkindness. Reusing 33
   * for a future tool would be the larger one: it would open something else entirely.
   */
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
  // The sixth slot was the Chip Kitchen, retired with the machine ([[145]]).
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
 *   `paint` — a `click` on the press edge, exactly, and then the HELD button repeats the
 *             verb on each new tile the cursor crosses, once per tile per hold ([[072]]).
 *             Farming a row is one gesture instead of eight clicks. Deliberately NOT the
 *             rect grammar: each tile is an ordinary per-tile command in the trace, judged
 *             by the sim like the click it stands in for — no new command, no batching.
 *             Only the three tile verbs carry it; a held drag that placed eight sprinklers
 *             would be a financial incident, not a convenience.
 */
export type GestureKind = 'click' | 'rect' | 'line' | 'paint';

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
    hint: 'click soil to pour the can — hold and drag to water a row',
    costCents: 0,
    gesture: 'paint',
  },
  [ToolMode.Plant]: {
    // "C picks the crop" is on the tool rather than in a hint bar because there is no hint bar
    // any more ([[bbf6782]]) and because this is the one line the player reads while holding
    // the thing it is about. The band under the cursor says which crop is armed ([[103]]).
    label: 'Plant',
    hint: 'click bare soil to sow — C picks the crop, hold and drag to sow a row',
    costCents: 0,
    gesture: 'paint',
  },
  [ToolMode.Harvest]: {
    label: 'Harvest',
    hint: 'click a ripe plant to pull it — hold and drag to clear a row',
    costCents: 0,
    gesture: 'paint',
  },
  [ToolMode.Till]: {
    label: 'Till',
    // ALL THREE RUNGS IN ONE SENTENCE ([[127]]), each keyed on WHERE YOU START, because the
    // anchor is the only thing the player controls about which one a drag means — so the hint
    // is written in that grammar rather than listing what the tool can do in the abstract.
    // A bare tile with nothing growing on it was a dead end for this tool until item 127, and
    // this line is where a player finds out it is not one any more.
    hint: 'start on grass to till, on a crop to lift it, on bare dirt for grass',
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
  /** The retired kitchen's tombstone row — see `ToolMode.PlaceChipKitchen`. Nothing offers it. */
  [ToolMode.PlaceChipKitchen]: {
    label: 'Chip Kitchen',
    hint: 'retired — the researched chip line makes the chips now',
    costCents: 0,
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
    // The flavour tier went with the cut crops ([[145]]), so the decision this hint used to
    // sell ("add a chili or corn") is gone: the Seasoner salts, full stop.
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
  /** The retired cellar's tombstone row — see `ToolMode.PlaceRootCellar`. Nothing offers it. */
  [ToolMode.PlaceRootCellar]: {
    label: 'Root Cellar',
    hint: 'retired — the Hand Cart is the storage that remains',
    costCents: 0,
    gesture: 'click',
  },
  /** The retired composter's tombstone row — see `ToolMode.PlaceComposter`. Nothing offers it. */
  [ToolMode.PlaceComposter]: {
    label: 'Composter',
    hint: 'retired — nothing spoils any more',
    costCents: 0,
    gesture: 'click',
  },
  /** Two tombstone rows — see `ToolMode.PlaceOrangeTree`. Nothing offers either tree. */
  [ToolMode.PlaceOrangeTree]: {
    label: 'Orange Tree',
    hint: 'retired — the Kola Tree is the whole orchard now',
    costCents: 0,
    gesture: 'click',
  },
  [ToolMode.PlaceLemonTree]: {
    label: 'Lemon Tree',
    hint: 'retired — the Kola Tree is the whole orchard now',
    costCents: 0,
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

  /** The retired station's tombstone row — see `ToolMode.PlaceMaintenanceStation`. */
  [ToolMode.PlaceMaintenanceStation]: {
    label: 'Maintenance Station',
    hint: 'retired — drones fix machines for free now',
    costCents: 0,
    gesture: 'click',
  },
  [ToolMode.PlaceDroneBay]: {
    label: 'Drone Bay',
    // The hint used to end "one part per fix", which was the machine's whole supply chain in
    // four words. Item 090 deleted the supply chain, so the hint says the thing that is now
    // true and is also the entire pitch: you buy it once and stop thinking about repairs.
    hint: 'clear 2x2 — its drone serves the whole lot, free forever',
    costCents: machinePrice(MachineKind.DroneBay),
    gesture: 'click',
  },

  // --- the five that had no cursor ([[100]]) -------------------------------------------

  [ToolMode.PlaceGrinder]: {
    label: 'Grinder',
    // Both ends of the recipe, because the whole reason this machine went missing is that
    // everyone assumed it was plumbing. It is a belt machine standing in a pipe half, and the
    // nut is $1.50 at the stand — so it earns from the moment it lands, with no orchard.
    hint: 'kola nuts in, kola powder out — belt-fed, no pipe',
    costCents: machinePrice(MachineKind.Grinder),
    gesture: 'click',
  },
  [ToolMode.PlaceSixPacker]: {
    label: 'Six-Packer',
    hint: 'six bottles into one six-pack, worth more than six',
    costCents: machinePrice(MachineKind.SixPacker),
    gesture: 'click',
  },
  [ToolMode.PlaceComboPacker]: {
    label: 'Combo-Packer',
    // The hint IS the argument for the node: a bag and a bottle sold together beat the two
    // sold apart, which is the only reason to run both districts at once.
    hint: 'a bag of chips and a bottle, sold as one',
    costCents: machinePrice(MachineKind.ComboPacker),
    gesture: 'click',
  },
  [ToolMode.PlaceDeliveryCart]: {
    label: 'Delivery Cart',
    // "It comes back" is the whole difference from the Hand Cart, which is the other cart on
    // this menu and the one you drag around yourself. This one goes somewhere you do not.
    hint: 'load it, send it — it comes back with the money',
    costCents: machinePrice(MachineKind.DeliveryCart),
    gesture: 'click',
  },
  [ToolMode.PlaceTruckDepot]: {
    label: 'Truck Depot',
    hint: 'clear 2x2 — belt-fed, contract-driven, never needs you',
    costCents: machinePrice(MachineKind.TruckDepot),
    gesture: 'click',
  },

  // --- the plumbing, and the soda line ([[101]]) ---------------------------------------

  [ToolMode.PlacePipe]: {
    label: 'Pipe',
    // The same sentence the belts wear, because it is the same gesture — a player who has run
    // one belt already knows this tool. What it adds is the liquid, which the run works out
    // from what it touches and the band says out loud the whole time the button is down.
    //
    // AND `L` IS NAMED HERE BECAUSE THIS IS THE ONLY PLACE IT CAN BE SEEN BEFORE THE DRAG
    // ([[109]]). The pipe has no footprint, so it draws no hover ghost and no tag; without this
    // line the key exists only in the sentence a refused run prints, which is a fine way to
    // meet it and a poor way to be reminded of it.
    hint: 'drag a run — R flips the corner, L sets the liquid',
    costCents: PIPE_PRICE_CENTS_PER_TILE,
    gesture: 'line',
  },

  [ToolMode.PlacePump]: {
    label: 'Pump',
    // The bank rule is the one refusal a player cannot guess and cannot see (`NoWaterSource`),
    // so it is the whole hint. A pump anywhere else is refused by the sim, silently.
    hint: 'on the bank of the reservoir — one per network',
    costCents: machinePrice(MachineKind.Pump),
    gesture: 'click',
  },
  [ToolMode.PlaceTank]: {
    label: 'Tank',
    hint: 'clear 2x2 — a buffer on the line, so a stall is not a drought',
    costCents: machinePrice(MachineKind.Tank),
    gesture: 'click',
  },
  [ToolMode.PlacePipedSprinkler]: {
    label: 'Piped Sprinkler',
    // Deliberately says what it is NOT: the barrel Sprinkler is one row above it in the same
    // group at a sixth of the price, and the only difference that matters is the walk.
    hint: 'plumbed, so it never runs dry and you never refill it',
    costCents: machinePrice(MachineKind.PipedSprinkler),
    gesture: 'click',
  },
  [ToolMode.PlaceIrrigationHub]: {
    label: 'Irrigation Hub',
    hint: 'clear 2x2 — it skips a tile that is already wet',
    costCents: machinePrice(MachineKind.IrrigationHub),
    gesture: 'click',
  },
  /** The retired recirculator's tombstone row — see `ToolMode.PlaceRecirculator`. */
  [ToolMode.PlaceRecirculator]: {
    label: 'Recirculator',
    hint: 'retired — the graywater loop went with it',
    costCents: 0,
    gesture: 'click',
  },
  [ToolMode.PlaceJuicer]: {
    label: 'Juicer',
    hint: 'sugar cane in on a belt, cane juice out on a pipe',
    costCents: machinePrice(MachineKind.Juicer),
    gesture: 'click',
  },
  [ToolMode.PlaceKettle]: {
    label: 'Kettle',
    hint: 'boils cane juice down to simple syrup — pipe both ends',
    costCents: machinePrice(MachineKind.Kettle),
    gesture: 'click',
  },
  [ToolMode.PlaceSyrupMixer]: {
    label: 'Syrup Mixer',
    // §5's centrepiece and the only machine in the game with three inlets of two kinds — which
    // is the fact the hint owes a player about to spend $300 on it.
    hint: 'syrup, water and kola powder in — the belt and pipe layers meet here',
    costCents: machinePrice(MachineKind.SyrupMixer),
    gesture: 'click',
  },
  [ToolMode.PlaceCarbonator]: {
    label: 'Carbonator',
    hint: 'water in, carbonated water out — both on pipe',
    costCents: machinePrice(MachineKind.Carbonator),
    gesture: 'click',
  },
  [ToolMode.PlaceBottler]: {
    label: 'Bottler',
    // The footprint is called out because it is the only 3×2 machine in the game and a player
    // clearing a 2×2 hole for it will be refused with no idea why (§5: "Bottler 3×2 flagship").
    hint: 'clear 3x2 — syrup and fizz on pipe, bottles on a belt',
    costCents: machinePrice(MachineKind.Bottler),
    gesture: 'click',
  },

  /** The retired bench's tombstone row — see `ToolMode.PlacePartsBench`. Nothing offers it. */
  [ToolMode.PlacePartsBench]: {
    label: 'Parts Bench',
    hint: 'retired — drones fix machines for free now',
    costCents: 0,
    gesture: 'click',
  },

  /** The retired bag's tombstone row — see `ToolMode.ApplyFertilizer`. Nothing offers it. */
  [ToolMode.ApplyFertilizer]: {
    label: 'Fertilizer',
    hint: 'retired — soil has no quality to improve',
    costCents: 0,
    gesture: 'click',
  },

  /** The retired well's tombstone row — see `ToolMode.PlaceArtesianWell`. Nothing offers it. */
  [ToolMode.PlaceArtesianWell]: {
    label: 'Artesian Well',
    hint: 'retired — the pond never runs dry now',
    costCents: 0,
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
    // THE HINT NAMES THE MOUSE BUTTON ([[129]]) because the verb is no longer only a tool: the
    // right button does exactly this, with nothing armed, on the same object this tool would
    // take. A gesture nobody is told about is a gesture nobody has, and this one now has the
    // shortcut the tool does not.
    hint: 'click or drag — or right-click with any tool: machines box up, belts and pipes refund',
    costCents: 0,
    // A RECT, LIKE ZONE PAINTING — and a click still works, because a click is a drag whose
    // anchor and cursor are the same tile and therefore a 1×1 rectangle. That is what lets
    // the single-machine walk-to errand survive the change; see `TeardownPlan.loneMachineTile`.
    gesture: 'rect',
  },
};

/**
 * **THE CROP THE PLAYER IS HOLDING BEFORE THEY PICK ONE** — for the hand and for a brand-new
 * zone alike, since [[103]]. Others are chosen with `C` once researched.
 *
 * IT WAS TWO CONSTANTS AND ONE OF THEM WAS A WALL. `DEFAULT_ZONE_CROP` was this, and `V01_CROP`
 * — *"the only crop in v0.1, still the only one the hand-plant verb sows"* — was hardwired into
 * `primaryCommand`'s `PlantTile`, so four researched crops, four purchasable seeds and four tech
 * nodes ($25 for cane, the cheapest in the game) could never reach the ground by hand. One
 * constant now, because there is one armed crop: see `InputSystem.armedCrop`.
 */
export const DEFAULT_CROP = CropId.RussetPotato;

export function gestureFor(tool: ToolMode): GestureKind {
  return TOOL_INFO[tool].gesture;
}

export function toolMachineKind(tool: ToolMode): MachineKind | null {
  switch (tool) {
    case ToolMode.PlaceSprinkler:
      return MachineKind.Sprinkler;
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
    case ToolMode.PlaceKolaTree:
      return MachineKind.KolaTree;
    case ToolMode.PlaceHarvesterDock:
      return MachineKind.HarvesterDock;
    case ToolMode.PlacePlanterDock:
      return MachineKind.PlanterDock;
    case ToolMode.PlaceDroneBay:
      return MachineKind.DroneBay;
    case ToolMode.PlaceGrinder:
      return MachineKind.Grinder;
    case ToolMode.PlaceSixPacker:
      return MachineKind.SixPacker;
    case ToolMode.PlaceComboPacker:
      return MachineKind.ComboPacker;
    case ToolMode.PlaceDeliveryCart:
      return MachineKind.DeliveryCart;
    case ToolMode.PlaceTruckDepot:
      return MachineKind.TruckDepot;
    case ToolMode.PlacePump:
      return MachineKind.Pump;
    case ToolMode.PlaceTank:
      return MachineKind.Tank;
    case ToolMode.PlacePipedSprinkler:
      return MachineKind.PipedSprinkler;
    case ToolMode.PlaceIrrigationHub:
      return MachineKind.IrrigationHub;
    case ToolMode.PlaceJuicer:
      return MachineKind.Juicer;
    case ToolMode.PlaceKettle:
      return MachineKind.Kettle;
    case ToolMode.PlaceSyrupMixer:
      return MachineKind.SyrupMixer;
    case ToolMode.PlaceCarbonator:
      return MachineKind.Carbonator;
    case ToolMode.PlaceBottler:
      return MachineKind.Bottler;
    default:
      // `ToolMode.PlacePipe` reaches this line and MUST: a pipe is not a `MachineKind` and
      // never will be, so it has no spec, no footprint and no place in `PLACEMENT_TOOLS`.
      // Its command is `PlacePipe`, built in `pointer.ts` from the drag.
      // The RETIRED tools reach this line ON PURPOSE and stay here: `PlacePartsBench`,
      // `PlaceComposter`, `ApplyFertilizer`, `PlaceArtesianWell` ([[090]], [[124]], [[140]]),
      // and since [[145]] also `PlaceChipKitchen`, `PlaceRootCellar`, `PlaceOrangeTree`,
      // `PlaceLemonTree`, `PlaceMaintenanceStation` and `PlaceRecirculator`. None has a kind,
      // a row or a membership below — but the enum members survive because a saved hotbar is
      // validated against `Object.values(ToolMode)` and one unknown number rejects the WHOLE
      // layout. See each member's own note.
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
  ToolMode.PlaceWasher,
  ToolMode.PlaceSlicer,
  ToolMode.PlaceFryer,
  ToolMode.PlaceSeasoner,
  ToolMode.PlaceBagger,
  ToolMode.PlaceBeltJunction,
  ToolMode.PlaceHandCart,
  ToolMode.PlaceKolaTree,
  ToolMode.PlaceHarvesterDock,
  ToolMode.PlacePlanterDock,
  ToolMode.PlaceDroneBay,
  ToolMode.PlaceGrinder,
  ToolMode.PlaceSixPacker,
  ToolMode.PlaceComboPacker,
  ToolMode.PlaceDeliveryCart,
  ToolMode.PlaceTruckDepot,
  ToolMode.PlacePump,
  ToolMode.PlaceTank,
  ToolMode.PlacePipedSprinkler,
  ToolMode.PlaceIrrigationHub,
  ToolMode.PlaceJuicer,
  ToolMode.PlaceKettle,
  ToolMode.PlaceSyrupMixer,
  ToolMode.PlaceCarbonator,
  ToolMode.PlaceBottler,
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
 * ONE SENTENCE NOW. The Maintenance Station was the single coverage machine that did not
 * water — it "serviced" its 7×7 — and it went with [[145]], taking
 * `MachineRole.MaintenanceStation` out of the sim entirely. Every machine that declares
 * `coverageRadiusTiles` today is a watering head, so the verb is a constant again; a future
 * non-watering coverage machine reopens the role-based branch this function used to have.
 */
export function toolCoverageVerb(_tool: ToolMode): string {
  return 'waters';
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
