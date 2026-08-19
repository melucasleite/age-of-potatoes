// Balance data — crops, items, machines, belts, grabbers, prices, rates.
//
// This lives inside `packages/sim` on purpose (plan §12): balance data is
// save-compatibility surface exactly as much as code is, so it is versioned with the sim
// and folded into `BALANCE_HASH` below. A world saved under one balance table and loaded
// under another is a migration, not a coincidence.
//
// Everything here is an integer. Prices are cents. Volumes are millilitres. Progress is
// work-points. Durations are ticks.
//
// Numbers are a first draft against plan §4's ten-hour reference curve; they are a two-way
// door and expected to move in playtest. The *shape* is what matters here.

import { fnv1aInit, fnv1aString, fnv1aToHex } from './hash';
import { TECH_NODES, TechId } from './tech';
import { TICKS_PER_SECOND, divFloor } from './units';

// --- identifiers ------------------------------------------------------------------
// `as const` objects, never `enum`: Node's native type stripping cannot execute enums,
// and these ids are written into saves, so their numeric values are permanent.

/**
 * The tilled-ground crops. **THE ROSTER IS EIGHT AND FIVE OF THEM ARE HERE.**
 *
 * Plan §5 caps the roster at eight and names them: Russet Potato, Gold Potato, Chili Pepper,
 * Corn, Sugar Cane, and the three 2×2 trees — Orange, Lemon, Kola Nut. §7 ruling 8 restates the
 * cap as a decision that survived the critique. Five of the eight are `CropId`s; **the three
 * trees are `MachineKind`s**, and that split is a ruling rather than an implementation detail.
 *
 * **WHY A TREE IS NOT A `CropId`.** A `CropTile` is one tile with one crop on it, and the field
 * is a flat row-major array — so a 2×2 tree expressed as a crop would be four tiles each
 * claiming to hold a quarter of a plant, with nothing in the shape to say they are the same
 * plant. Every question the feature asks is then a new one: which quarter do you harvest, what
 * happens when you plant over one corner, where does the fruiting cooldown live. A `Machine`
 * already answers all of them — it has `tileX/tileY`, a `MachineSpec.tilesWide/tilesHigh`
 * footprint, `machineCoversTile()`, a cooldown, an output buffer a belt can drain, ownership
 * gating, an invoice on the net-worth books, and boxing — so a permanent multi-tile plant that
 * survives harvest and fruits on a cycle is *already* a machine in everything but name. Item 030
 * recommends exactly this and it is worth more than taxonomic purity.
 *
 * The count still comes to eight, and it is the eight §5 lists: five sown, three planted.
 *
 * Numeric values are written into saves and permanent. Never renumber 0 or 1.
 */
export const CropId = {
  None: 0,
  RussetPotato: 1,
  SugarCane: 2,
  Corn: 3,
  ChiliPepper: 4,
  /** §5: "Gold Potato (premium, thirsty)". Drinks three times what a Russet does. */
  GoldPotato: 5,
} as const;

export type CropId = (typeof CropId)[keyof typeof CropId];

/**
 * What a field tile is made of. §5 used to read *"Soil types (loam/sand/clay) and 1–3★ fertility
 * make placement a decision."* **THE FERTILITY HALF OF THAT SENTENCE IS GONE** (item 124, owner
 * ruling 2026-08-17) and the plan document is struck to match: there is no soil quality, no ★
 * rating and no decay-with-harvests. Every tile yields the old best case.
 *
 * SOIL TYPE ITSELF SURVIVES and is still rolled once per tile at world creation from
 * `SystemId.SoilInit`. It is flavour, not a multiplier — nothing reads it as a yield term, and
 * nothing may. Permanent save surface, like every other id in this file.
 */
export const SoilType = {
  /** The middle of every axis, and the value a migrated tile gets: nothing changes. */
  Loam: 1,
  /** Grows fast and dries fast. A sprinkler's favourite ground and the can's worst. */
  Sand: 2,
  /** Slow and thirsty-proof. Holds water through a dry spell and takes its time. */
  Clay: 3,
} as const;

export type SoilType = (typeof SoilType)[keyof typeof SoilType];

export interface SoilSpec {
  readonly id: SoilType;
  readonly slug: string;
  /**
   * Growth rate as permille of loam. Applied to the tile's `growthTarget` when the crop is
   * SOWN, never to the per-tick increment — `GROWTH_PER_WATERED_TICK` is 1, and there is no
   * integer between 0 and 1 for a modifier to land on. A target divided once at planting is
   * exact, is visible in the save, and cannot drift.
   */
  readonly growthPermille: number;
  /** Moisture drain as permille of the crop's own rate, spent through `CropTile.moistureAccum`. */
  readonly moistureDrainPermille: number;
}

export const SOIL_SPECS: readonly SoilSpec[] = [
  { id: SoilType.Loam, slug: 'loam', growthPermille: 1000, moistureDrainPermille: 1000 },
  { id: SoilType.Sand, slug: 'sand', growthPermille: 1150, moistureDrainPermille: 1500 },
  { id: SoilType.Clay, slug: 'clay', growthPermille: 850, moistureDrainPermille: 700 },
];

export function soilSpec(id: SoilType): SoilSpec | null {
  for (let i = 0; i < SOIL_SPECS.length; i++) {
    const spec = SOIL_SPECS[i]!;
    if (spec.id === id) return spec;
  }
  return null;
}

/** Every soil a roll may produce, in a fixed order. The roll is an index into this. */
export const SOIL_ROLL_TABLE: readonly SoilType[] = [SoilType.Loam, SoilType.Sand, SoilType.Clay];

/**
 * Plan §5 caps the recipe graph at ~50 items. We are at **38 items plus 5 liquids = 43 nodes**,
 * and `recycling.test.ts` asserts exactly that — a comment here that disagrees with that test is
 * the comment that is wrong. **IT READ 49, THEN 50, AND ITEM 124 HANDED SEVEN BACK**: the five
 * Day-Old grades, `Compost` and `Fertilizer` all left when the waste loop was deleted, which was
 * a side effect of that item and not its point. The census is the original 26 (the soda line
 * spent 6 item slots and 4 liquid slots), what is left of the crop roster's 8
 * (gold potato trio, two tree fruits, scythe, crate), item 039's drone part —
 * which [[090]] left with no producer and no consumer, but which still occupies its node because
 * a returning player's stock has to have a price to sell at — and item 111's flavour tier of 9.
 *
 * **THAT LEAVES ONE NODE, AND THE CAP IS NOW A REAL CONSTRAINT RATHER THAN A HEADROOM NOTE.**
 * Item 111 spent its nine deliberately and was shaped by this number: a premium BASE costs five
 * nodes and a SEASONING costs two, so the budget bought one base (the gold potato) and two
 * seasonings (chili, corn) instead of the two bases the item first proposed. The next feature
 * that wants a product tier does not have room for one — it either buys a raise from the owner
 * or spends the last node. See the flavour-tier block in `ItemId` for the whole argument.
 *
 * Boxed machines are not graph nodes — nothing eats one, nothing makes one, no belt carries
 * one. Numeric values are permanent — they are in every save and on every belt.
 */
export const ItemId = {
  PotatoSeed: 1,
  RussetPotato: 2,
  /** The end of the chip chain. Kept at 3 because v0.1 worlds have it in their inventories. */
  BaggedChips: 3,

  // The chip line's intermediates, in chain order (plan §5's belt cathedral).
  WashedPotato: 4,
  PotatoSlices: 5,
  PlainChips: 6,
  SeasonedChips: 7,

  // 8, 9, 12, 15 and 18 are SPENT AND UNSPELLED (item 124). They were `DayOldPotato`,
  // `Compost`, `DayOldCane`, `DayOldCorn` and `DayOldChili` — the Day-Old grades and the
  // thing an unpicked crop collapsed into. Nothing rots, so nothing has a lesser grade and
  // there is no compost for it to become. The numbers stay burned because they are in old
  // saves, and the 21 → 22 migration is the only code that may name them.

  CaneSeed: 10,
  SugarCane: 11,

  CornSeed: 13,
  Corn: 14,

  ChiliSeed: 16,
  ChiliPepper: 17,

  /**
   * Chips that sat in a blocked Fryer until they caught colour. Plan §2: "overcooked chips
   * sell as 'Rustic Style' at 70%." It is a joke rather than a punishment — the batch is
   * still sellable, still a chip, and priced off seasoned chips in one place below.
   */
  RusticStyleChips: 19,

  /** One trip's worth of maintenance. Plan §3's middle rung between hands and drones. */
  RepairKit: 20,

  // The soda line. Plan §4: "cane→juice→simple syrup; kola→powder; syrup + carbonated water
  // + bottle → soda (~$16); six-packs and the Snack Combo as gentle bundle premiums."
  //
  // JUICE, SYRUP, AND CARBONATED WATER ARE NOT HERE. They are LIQUIDS — they ride pipes, not
  // belts, and giving them item ids as well would be the one thing plan §5 rules out flat:
  // "solids ride belts, liquids ride pipes, and they meet only inside machines with typed
  // ports." An id in both spaces is a bucket of syrup on a conveyor.
  /** Bought at the stand. There is no kola crop and there will not be one (§5, §7 ruling 8). */
  KolaNut: 21,
  /** §5: "flavors are powders" — the Syrup Mixer's belt inlet, and the only solid it eats. */
  KolaPowder: 22,
  /** §4's store-bought consumable. Vertical Integration's crafted route is a stub, not a lie. */
  Bottle: 23,
  Soda: 24,
  SixPack: 25,
  /** Chips + soda. The item that makes running both lines beat running either one twice. */
  SnackCombo: 26,

  // --- boxed machines ---------------------------------------------------------------
  //
  // A machine taken off the lot, in a box, in the player's bag. One row per buildable machine
  // kind, in `MachineKind` order, and the mapping is `BOXED_MACHINE_ROWS` below.
  //
  // THESE ARE NOT RECIPE-GRAPH NODES. Plan §5 caps the graph at ~50 items and the count above
  // is 26 items plus 5 liquids; these twenty do not move that number, because nothing eats one,
  // nothing makes one, and no belt will ever carry one. They exist so that a boxed Fryer is a
  // thing the inventory, the hash, and the save already know how to hold, rather than a
  // parallel list of machines-that-are-not-on-the-lot with its own sorting and its own bugs.
  //
  // THE SELL BIN HAS NO BOX, deliberately, and it is the only kind that does not. It is a gift
  // the world starts with, it costs nothing, and it is the only way to sell or buy anything —
  // boxing it would be a single click that ends a save's economy, which is precisely the class
  // of thing plan §1's anti-softlock floor exists to refuse.
  BoxedChipKitchen: 27,
  BoxedSprinkler: 28,
  BoxedWasher: 29,
  BoxedSlicer: 30,
  BoxedFryer: 31,
  BoxedSeasoner: 32,
  BoxedBagger: 33,
  BoxedPump: 34,
  BoxedTank: 35,
  BoxedPipedSprinkler: 36,
  BoxedIrrigationHub: 37,
  BoxedRecirculator: 38,
  BoxedJuicer: 39,
  BoxedKettle: 40,
  BoxedGrinder: 41,
  BoxedSyrupMixer: 42,
  BoxedCarbonator: 43,
  BoxedBottler: 44,
  BoxedSixPacker: 45,
  BoxedComboPacker: 46,
  BoxedDeliveryCart: 47,
  BoxedTruckDepot: 48,
  BoxedBeltJunction: 49,

  // --- the roster's last crop, and the orchard ----------------------------------------
  //
  // §5's "Gold Potato (premium, thirsty)" and the fruit the three 2×2 trees drop. The trees
  // themselves are machines (see `CropId`); these are what comes out of them.
  GoldPotatoSeed: 50,
  GoldPotato: 51,
  // 52 was `DayOldGoldPotato` and is spent (item 124). See the note above `CaneSeed`.
  /** Orange Tree fruit. Sellable produce, and nothing eats it — §8 defers fruit sodas past 1.0. */
  Orange: 53,
  Lemon: 54,

  // 55 was `Fertilizer` and is spent (item 124). Fertility is not a feature, so nothing
  // restores it and nothing is made of compost. The 21 → 22 migration pays out any a
  // player was holding at list and is the only code that may name the number.

  /**
   * The push-scythe: plan §3's assisted rung of the harvesting ladder, three tiles a swing.
   *
   * **AN ITEM RATHER THAN A MACHINE, BECAUSE IT IS A TOOL YOU HOLD.** It is never placed, never
   * consumed, never wears (§8 forbids two risky systems in one release, and hand tools never rot
   * — §1), and it does nothing whatsoever while it sits in the bag. Owning one is what makes
   * `SwingScythe` legal, exactly as owning a repair kit is what makes `UseRepairKit` legal.
   */
  PushScythe: 56,

  /**
   * A packing crate. §4's *"45 crated"*, and **AN ITEM RATHER THAN A MACHINE FOR A REASON THAT
   * ONLY SHOWS UP WHEN YOU TRY IT THE OTHER WAY.**
   *
   * Goods age in the player's hands and nowhere else — nothing inside any machine has a clock,
   * which is how §4's hopper freeze is implemented (see `InventorySlot.stacks`). So a Crate built
   * as a placeable container would freeze its contents exactly as a Root Cellar does, and the two
   * would be one object with two prices: the same "two names for one rule" the belt junction
   * ruling refuses. The distinction §4 actually draws is between goods **loose** and goods
   * **crated** — and both of those are in your arms.
   *
   * So it is a consumable you pack a stack into, and what it buys is thirty more minutes of
   * carrying. `PackCrate` is refused rather than consumed when it would not help, the same rule
   * `UseRepairKit` follows: misplacement is never a fine (§4).
   */
  Crate: 57,

  // --- boxes for everything above ------------------------------------------------------
  BoxedRootCellar: 58,
  // 59 was `BoxedComposter` and is spent (item 124): the machine is gone, so its box is
  // too. A boxed one in a returning player's bag is refunded by the 21 → 22 migration.
  BoxedHandCart: 60,
  BoxedOrangeTree: 61,
  BoxedLemonTree: 62,
  BoxedKolaTree: 63,
  BoxedHarvesterDock: 64,
  BoxedPlanterDock: 65,

  /**
   * **AN ITEM THAT OUTLIVED ITS PURPOSE, KEPT SO IT CAN BE SOLD** (item 090).
   *
   * It was the capstone consumable: one part burned per drone service, manufactured at the
   * Parts Bench from a Bottle and Kola Powder and belted to the bay. Repair drones now fix
   * machines for free, so nothing consumes a drone part and nothing produces one — the bench is
   * retired (`RETIRED_MACHINE_KINDS`) and the bay's hopper doors are gone in both spellings.
   *
   * **IT STAYS `sellable` AT $4, AND THAT IS THE WHOLE REASON THE ID IS STILL HERE.** A player
   * who ran the parts line well may be holding a warehouse of these, and plan §4's floor says
   * nothing a player owns is deleted — so the stock keeps a price and an exit at the bin, and
   * the 16 → 17 migration hands back every part that was sitting in a bay's hopper to be sold
   * with the rest. `purchasable: false` now means what it says rather than describing a
   * logistics puzzle: there is no source at all.
   */
  DronePart: 66,

  BoxedMaintenanceStation: 67,
  BoxedDroneBay: 68,
  BoxedPartsBench: 69,

  // --- the flavour tier (item 111) -----------------------------------------------------
  //
  // Nine nodes that end the roster's museum problem: before this block, `Corn`, `ChiliPepper`
  // and `GoldPotato` appeared nowhere in `src/` outside their own rows. Nothing ate them. Corn
  // took 210 s to grow and sold for twenty cents more than a potato that took 90 s AND fed a
  // line that multiplied it; the gold potato was the sharpest joke of the three — **a potato
  // the potato line refused**, because the Washer's recipe named `RussetPotato` specifically.
  //
  // WHY THE GOLD POTATO IS A BASE AND THE OTHER TWO ARE SEASONINGS — the ruling, in one place.
  // A seasoning is something you add to a finished chip; a base is what the chip is made of.
  // Chili and corn can flavour a chip. A gold potato cannot flavour anything: it is a potato,
  // and the only honest thing to do with it is fry it. Forcing all three through one door
  // would mean lying about at least one of them — sprinkling a potato on a crisp, or frying a
  // pepper into a base nobody would eat.
  //
  // AND THE ~50-NODE CAP DECIDED THE SHAPE, not taste. Plan §5 caps the recipe graph and the
  // header comment above counts it. An alternate BASE costs FIVE nodes, because identity has
  // to survive every rung from the Washer to the Bagger; a SEASONING costs two, because it
  // joins at the Seasoner and only the last two rungs differ. Two base chains would have cost
  // ten and put the graph at 52. One base plus two seasonings costs nine and lands at 49. The
  // budget permits exactly one premium base, and the gold potato is the only crop that has to
  // be one.
  //
  // The gold rungs are the plain rungs shifted up by one constant (`GOLD_POTATO_PREMIUM_CENTS`)
  // — every machine adds exactly the value it adds to a russet, and the premium rides through
  // untouched. See `FLAVOUR_PREMIUM_NUMERATOR` for where that constant and the two seasoned
  // prices come from, and for the margin arithmetic in full.
  WashedGoldPotato: 70,
  GoldPotatoSlices: 71,
  GoldChips: 72,
  SeasonedGoldChips: 73,
  BaggedGoldChips: 74,

  /** Plain chips seasoned with a pepper instead of salt. One pepper per chip — see the recipe. */
  ChiliChips: 75,
  BaggedChiliChips: 76,
  /**
   * Corn as a FLAVOUR rather than a base, which is the one place this design bends toward the
   * node budget — and it bends honestly: sweetcorn is an ordinary crisp flavour, sold in every
   * corner shop. A corn-chip BASE would have been the other five nodes the graph does not have.
   */
  SweetcornChips: 77,
  BaggedSweetcornChips: 78,

  // 79 was `BoxedArtesianWell` and is SPENT AND UNSPELLED (item 140). The pond it existed to
  // enlarge is now unlimited, so the machine is retired and its box has nothing to unpack into.
  // The 22 → 23 migration pays every box out off its own invoice before the id stops existing.

  /**
   * **AN EMPTY THAT CAME BACK FROM A DELIVERY** (item 131). It was **the fiftieth and last node
   * of the recipe graph** when it landed, and that is why it was shaped the way it was — see the
   * ruling below.
   *
   * **THE CEILING MOVED UNDER IT.** Item 124 deleted the waste loop the day after, and the five
   * Day-Old grades, `Compost` and `Fertilizer` went with it: the graph now stands at 43 of ~50,
   * so there are seven free nodes where there were none. **That headroom was not earned and is
   * not a budget** — it is the change in the count that fell out of deleting a feature. Anyone
   * spending it should know it came from there, and `recycling.test.ts` is where the number is
   * pinned.
   *
   * **IT COST ONE NODE BECAUSE THE OWNER RULED FOR THE WASHER** (2026-08-17, verbatim: *"Okey
   * washer it is."*). The ask was a Recycling Centre, which is two nodes — this item plus a
   * machine — and would have landed the graph at 51. A Washer that already washes dirty things
   * clean needs no second machine to explain the verb, so the recipe goes on the Washer
   * (`MACHINE_RECIPES`) and the used bottle is the whole of the cost.
   *
   * **THE REJECTED ALTERNATIVE, RECORDED SO NOBODY RE-PROPOSES IT:** having a delivery return
   * `ItemId.Bottle` directly. Zero nodes and strictly worse — a return leg with no processing
   * is a discount on bottles wearing a logistics costume, and there is nothing to build.
   *
   * **SELLABLE, AND THAT IS THE ANTI-RUBBISH CLAUSE.** A player who never builds the loop
   * still accumulates these the moment they deliver a soda, and plan §4's floor says nothing a
   * player owns is stranded — so an empty has a price and an exit at the bin, exactly as a
   * retired drone part does. `USED_BOTTLE_SCRAP_CENTS` is a TENTH of a clean bottle, which is
   * the whole of the argument for washing rather than scrapping: the same empty is worth ten
   * times more through a Washer than through a bin, and no player has to do arithmetic to see
   * it. Not purchasable: there is no shop for other people's empties.
   *
   * Nothing in this game spoils since item 124, so the heap it sits in is safe indefinitely —
   * which was already true of glass and is now true of the potatoes beside it.
   */
  UsedBottle: 80,
} as const;

export type ItemId = (typeof ItemId)[keyof typeof ItemId];

export const MachineKind = {
  SellBin: 1,
  /** The v0.1 monolith. Still buildable, still the cheapest way to a bag (see below). */
  ChipKitchen: 2,
  Sprinkler: 3,

  // The production line. Plan §5: "Washer→Slicer→Fryer→Seasoner→Bagger, canonical ratio
  // 1:1:2:1:1".
  Washer: 4,
  Slicer: 5,
  Fryer: 6,
  Seasoner: 7,
  Bagger: 8,

  // The liquid layer. Plan §5's grammar is `RESERVOIR → (Pump) → pipes → [Tank] → machines`,
  // and every piece of it is an ordinary machine on purpose: placement, pick-up-and-move,
  // the reach checks, and the three upgrade dials all already work, so a pump inherits them
  // rather than growing a parallel set of rules that drift.
  Pump: 9,
  Tank: 10,
  PipedSprinkler: 11,
  IrrigationHub: 12,
  Recirculator: 13,

  // The soda line — plan §5's PIPE ORGAN, where the chip line is a belt cathedral. Every one
  // of these is an ordinary `Converter`: the roles, the buffers, the dials, the wear, and the
  // demand-pull stop are the same code the Washer runs. What is new is that a recipe may name
  // several inputs and either side of it may be a liquid.
  Juicer: 14,
  Kettle: 15,
  Grinder: 16,
  /** §5's centrepiece: two pipe inlets and one belt inlet, the one place the layers meet. */
  SyrupMixer: 17,
  Carbonator: 18,
  /** §5: "machines mostly 2×2 (Bottler 3×2 flagship)". */
  Bottler: 19,
  SixPacker: 20,
  ComboPacker: 21,

  // Selling, above the roadside stand. Plan §3's ladder runs manual → assisted → automated for
  // every system in the game, and selling was the one column that stopped at the first rung.
  /** The assisted rung: you fill it, you send it, it comes back with the money. */
  DeliveryCart: 22,
  /** The automated rung: belt-fed, contract-driven, and it never needs you again. */
  TruckDepot: 23,

  /**
   * **THE SPLITTER AND THE MERGER ARE ONE OBJECT, AND THAT IS A RULING, NOT A SHORTCUT.**
   *
   * Plan §5 names *"splitters, mergers"* and item 024 asks for both. Built honestly, they turn
   * out to be the same tile: a device that takes an item off a belt that ends on it and puts that
   * item onto a belt that leads away from it, choosing round-robin whenever there is more than
   * one candidate. Run two belts in and one out and it merges; run one in and two out and it
   * splits. Shipping two machine kinds with identical code would be two names for one rule, two
   * prices for one object, and a build menu that asks the player to decide something the belts
   * around the tile have already decided.
   *
   * It has NO FACING, which is what makes that unification possible and what keeps the README's
   * "nothing but a grabber rotates" true: the input face is wherever the item came from and the
   * output faces are the others, so there is no orientation to get wrong and no `RotateJunction`
   * to add. A player who wants it to behave differently moves a belt, which is the thing they can
   * already see.
   */
  BeltJunction: 24,

  // --- keeping things -------------------------------------------------------------------
  //
  // `MachineRole.Storage`: placed, moved, boxed, invoiced, ownership-gated and reach-checked by
  // exactly the code that does all of that for a Fryer, and loaded and emptied by
  // `LoadMachine`/`UnloadMachine`, which already exist, already count a `handCarry` touch, and
  // already have a walk-to errand wired. Not one line of any of that was written for these.
  /**
   * **BULK STORAGE, AND THAT IS NOW ITS WHOLE JOB** (item 124, and flagged for the owner).
   *
   * It used to be the fridge: §4's *"frozen in a Root Cellar"*, the only 0 in the storage
   * ageing table. Nothing spoils any more, so the freeze it sold is a freeze everything gets
   * for free, and a $250 machine whose entire pitch has evaporated is a machine a player was
   * robbed of. Deleting it was the other option and it is the worse one — somebody built this.
   *
   * So it keeps its price, its four tiles and its Agronomy node, and what it sells instead is
   * the half of its old pitch that survives intact: **capacity**. `inputCapacity` goes from a
   * hundred to `ROOT_CELLAR_CAPACITY`, which is what makes it the one place to put a harvest
   * you cannot process yet against a hand cart's twenty-four.
   */
  RootCellar: 25,
  // 26 was `Composter` and is SPENT AND UNSPELLED (item 124). It converted Compost to
  // Fertilizer; both ends of that recipe are gone, so it is not tombstoned the way the Parts
  // Bench is — a headstone exists to price a box a player still holds, and the 21 → 22
  // migration refunds every Composter and every box of one instead of leaving either behind.
  /**
   * Plan §3's assisted rung of the TRANSPORT ladder: "Wheelbarrow/hand cart".
   *
   * Storage on wheels. Hitch it and it follows you at a cost in speed; park it and it is a box.
   * It is deliberately NOT `MachineKind.DeliveryCart`, which is the assisted rung of *selling* —
   * that one you load and send away, this one you load and drag. Same ladder rung, different
   * ladder, and they are not the same object: the delivery cart goes somewhere you do not.
   */
  HandCart: 27,

  // --- the orchard (plan §5's three 2×2 trees) -------------------------------------------
  //
  // See `CropId` for why a permanent multi-tile plant is a machine rather than a crop. Each one
  // is `MachineRole.Orchard`: no inputs, no plumbing, a footprint, and an output buffer that
  // fills on a cycle and that a belt or a grabber can drain.
  OrangeTree: 28,
  LemonTree: 29,
  /**
   * **PLANTING THE FIRST ONE IS AN EVENT** (§5, by name), because it is the gate on the cola
   * line: the Grinder eats kola nuts, and until now the only kola in the world was bought at the
   * stand. This is the crafted rung of §4's consumable ladder finally arriving under the bought
   * one — and it is why the README's Vertical Integration note no longer lists "kola as a crop"
   * as a thing that will never exist. §5 always listed the kola tree; what it ruled out was a
   * ninth *sown* crop, which this is not.
   */
  KolaTree: 30,

  // --- Agri-Bots (plan §3's automated rung of harvesting) ---------------------------------
  //
  // A dock is a machine; the bot that lives in it is an entity in `WorldState.bots`. One dock,
  // one bot, one zone — the zone is the instruction set (`Machine.boundZone`), because item 018
  // already built a surface that says what should be growing where and a second one would be a
  // second answer to the same question.
  /** "Spudnik" patrols the zone and pulls ripe crops into this shed's output buffer. */
  HarvesterDock: 31,
  /** And this one puts them back, from a seed hopper you keep filled — by hand, or by belt. */
  PlanterDock: 32,

  // --- automated maintenance (item 039, plan §3's ladder topping out) ---------------------
  //
  // The Maintenance Station is an arm that does what your hand did: it spends REAL repair kits
  // from a belt-fed hopper on the same 7×7 cell a hand-thrown kit services, at the same cadence
  // a player would (when the wrench lamp is due), and it starves honestly — no kits on the belt,
  // no service, ever. That rung is now the ladder's whole argument about cost, because the rung
  // above it stopped having one: the Drone Bay's drone flies to whichever machine on the lot
  // wants a wrench and fixes it for FREE (item 090), so the bay is a `BotDock` with no cargo at
  // all — nothing goes in, nothing comes out, and the only bill is the hangar and the node.
  /** Belt-fed kits in, serviced cell out. §3's first automated maintenance rung. */
  MaintenanceStation: 33,
  /** One bay, one drone, no hopper. The tech tree's capstone (§3). */
  DroneBay: 34,
  /**
   * **RETIRED** (item 090). Bottle + kola powder → drone part, back when a drone burned one per
   * fix. Its customer stopped buying, so the game stopped selling it; the spec below survives as
   * a headstone so a box of one in somebody's bag still has a name and an invoice. See
   * `RETIRED_MACHINE_KINDS` for why the id and the spec both stay spent forever.
   */
  PartsBench: 35,

  // 36 was `ArtesianWell` and is SPENT AND UNSPELLED (item 140).
  //
  // It was the one thing in the game that made a pond bigger, and it was right for exactly one
  // day. Item 130 measured a real shortage — 64 field tiles cost 64,000 ml/min to hold above dry
  // even for a waterer that wastes nothing, against a pond making 40,000 — and answered it with
  // a machine. The owner answered it by deleting the scarcity instead: *"I want the ponds to have
  // infinite water. Get rid of the artisan well and just have the pond have an unlimited supply
  // of water."* The measurement still stands; there is simply nothing left for a well to fix.
} as const;

export type MachineKind = (typeof MachineKind)[keyof typeof MachineKind];

/**
 * What a pipe carries. Plan §5: **one liquid per network, enforced**.
 *
 * FOUR LIQUIDS MEANS FOUR NETWORKS, AND THAT CONSTRAINT IS THE PUZZLE. The soda line does not
 * relax the one-liquid rule by an inch; it is the first thing in the game that makes the rule
 * *cost* something, which is what turns pipe routing into the mid-game layout problem §5 wants.
 *
 * The ids are save surface and permanent. **5 is deliberately left empty**: it is kola syrup,
 * which the renderer already has a colour for and Vertical Integration will need, and skipping
 * a number now is cheaper than renumbering a shipped save later.
 */
export const LiquidId = {
  None: 0,
  Water: 1,
  CaneJuice: 2,
  SimpleSyrup: 3,
  CarbonatedWater: 4,
  // 5 — reserved for kola syrup.
  SodaSyrup: 6,
} as const;

export type LiquidId = (typeof LiquidId)[keyof typeof LiquidId];

export interface LiquidSpec {
  readonly id: LiquidId;
  readonly slug: string;
  /**
   * The colour a full pipe tints to, as 0xRRGGBB. An EMPTY pipe is not tinted with this — it
   * renders grey, which is plan §5's diagnostic instrument and the pipe equivalent of a gap
   * in a belt. The renderer owns the grey; the sim only says which liquid and how full.
   */
  readonly tintRgb: number;
}

/**
 * The tints are lifted from the renderer's `render/liquids.ts` vocabulary, which was authored
 * against `art/palette/master.json` and checked by a test that fails when two steps of the soda
 * chain converge in RGB. The sim owns the table and its `tintRgb` wins, so adopting the colours
 * that were already measured is strictly better than picking new ones nobody has looked at.
 *
 * Water keeps the blue it shipped with rather than moving to the renderer's near-identical
 * fallback: it is on screen in every existing world, and a colour that shifts under a save is a
 * change with no upside.
 */
export const LIQUID_SPECS: readonly LiquidSpec[] = [
  { id: LiquidId.Water, slug: 'water', tintRgb: 0x4f9ed8 },
  { id: LiquidId.CaneJuice, slug: 'cane-juice', tintRgb: 0x74a340 },
  { id: LiquidId.SimpleSyrup, slug: 'simple-syrup', tintRgb: 0xd9ab6e },
  { id: LiquidId.CarbonatedWater, slug: 'carbonated-water', tintRgb: 0x9fdcef },
  { id: LiquidId.SodaSyrup, slug: 'soda-syrup', tintRgb: 0x9e2f27 },
];

export function liquidSpec(id: LiquidId): LiquidSpec | null {
  for (let i = 0; i < LIQUID_SPECS.length; i++) {
    const spec = LIQUID_SPECS[i]!;
    if (spec.id === id) return spec;
  }
  return null;
}

// --- items ------------------------------------------------------------------------

export interface ItemSpec {
  readonly id: ItemId;
  /** Stable slug for the renderer's atlas lookup and for save debugging. */
  readonly slug: string;
  /** List price in cents. */
  readonly listPriceCents: number;
  /** True for items the roadside stand will sell *to* the player. Seeds and consumables. */
  readonly purchasable: boolean;
  /**
   * True for items the sell bin will take. **False for seeds**, and that is the whole reason
   * this field exists.
   *
   * A SELLABLE SEED IS A SOFTLOCK WITH A PRICE TAG. Seeds are the one thing in the game the
   * player can run out of permanently — plan §4's anti-softlock floor is that a harvested
   * potato always hands one back — and a bin that buys them at list turns "I clicked the wrong
   * stack" into a world that can no longer plant anything. The stand sells them *to* you at
   * the same price it would pay, so it is not even a trade; it is a way to lose.
   *
   * IT IS DATA RATHER THAN A CHECK ON `purchasable`, though today the two are exact opposites.
   * They are different facts — "the stand stocks it" and "the bin takes it" — and the moment
   * one item is both (a bottle the player over-bought and wants to dump) or neither, a rule
   * that inferred one from the other would be silently wrong. `test/sim.test.ts` pins that
   * every seed is unsellable rather than pinning the two flags to be inverses.
   */
  readonly sellable: boolean;
}

/**
 * The seasoned rung of the chip ladder, hoisted out of the table because two prices are
 * derived from it rather than typed beside it.
 */
export const SEASONED_CHIPS_PRICE_CENTS = 1400;

/**
 * Rustic Style is **exactly 70% of seasoned chips, floored to the cent** (plan §2), and the
 * ratio is written here once. The table below multiplies this out rather than carrying a
 * second literal, because a hardcoded 980 is a number that drifts the first time seasoning
 * is repriced and nothing catches it — the two would simply disagree, quietly, forever.
 */
export const RUSTIC_STYLE_NUMERATOR = 70;
export const RUSTIC_STYLE_DENOMINATOR = 100;

/**
 * Seventy percent of seasoned, floored. The one function anything pricing a burnt batch may
 * call — a ratio written once, so nothing can drift away from it.
 *
 * It reads the hoisted constant rather than `listPriceCents(ItemId.SeasonedChips)` because
 * `ITEM_SPECS` below is initialised with this arithmetic, and a table that called back into
 * itself while being built would read an undefined array.
 */
export function rusticStylePriceCents(): number {
  return divFloor(SEASONED_CHIPS_PRICE_CENTS * RUSTIC_STYLE_NUMERATOR, RUSTIC_STYLE_DENOMINATOR);
}

/**
 * $8 at the roadside stand (plan §3). It lives up here rather than with the rest of the
 * maintenance numbers below because `ITEM_SPECS` is initialised a few lines down and a
 * constant declared after it would still be in its temporal dead zone when the table runs.
 *
 * The $3 crafted rung of plan §3's ladder is deliberately absent: there is no crafting
 * system in the sim yet, and a price for a recipe nobody can cook is balance data that lies.
 */
export const REPAIR_KIT_PRICE_CENTS = 800;

/**
 * What a drone part is worth at list. **A sale price now, and nothing else** (item 090).
 *
 * It used to be two facts wearing one number: what a part sold for, and what one drone service
 * was accounted at in `repairKitSpendCents`. Drone service is free, so the second fact is gone
 * and this is left doing the ordinary job every other list price does — pricing the stock a
 * returning player still has in the bag. It lives up here for the same temporal-dead-zone
 * reason the kit price does: `ITEM_SPECS` reads it while initialising.
 */
export const DRONE_PART_PRICE_CENTS = 400;

/**
 * The end of the chip chain, hoisted for the same reason seasoned chips are: the Snack Combo's
 * price is arithmetic on it rather than a second literal that drifts.
 */
export const BAGGED_CHIPS_PRICE_CENTS = 2000;

/**
 * The rest of plan §4's chip ladder, hoisted (item 111).
 *
 * Seasoned and bagged were already up here because other prices were computed from them. These
 * four join them for the same reason and no other: **the gold line is the plain line plus one
 * constant**, and writing `900` beside `WASHED_POTATO_PRICE_CENTS + GOLD_POTATO_PREMIUM_CENTS`
 * would be the same number typed twice, which is the drift the two constants above exist to
 * prevent. The ladder is now hoisted in full rather than two-thirds of the way.
 */
export const RUSSET_POTATO_PRICE_CENTS = 200;
export const WASHED_POTATO_PRICE_CENTS = 300;
export const POTATO_SLICES_PRICE_CENTS = 450;
export const PLAIN_CHIPS_PRICE_CENTS = 900;

/** The three crops item 111 gave a job to, hoisted so the premiums below are computed, not typed. */
export const GOLD_POTATO_PRICE_CENTS = 600;
export const CHILI_PEPPER_PRICE_CENTS = 300;
export const CORN_PRICE_CENTS = 220;

/**
 * **WHAT A FLAVOUR IS WORTH, AND THE ONLY NUMBER IN ITEM 111 THAT WAS CHOSEN RATHER THAN
 * DERIVED.** Everything else in the tier is arithmetic on this and on the ladder above.
 *
 * The rule: a flavoured or premium product is worth its plain counterpart **plus 150% of the
 * extra input that went into it**. Priced off the INPUT cost, which is what item 111 demanded,
 * and 150% is not a vibe — it is the next rung of a ladder this file already climbs. The
 * six-pack pays **110%** for bundling a product with itself (throughput). The Snack Combo pays
 * **125%** for bundling two districts (breadth). A flavour asks for strictly more than either:
 * a second crop, on a second tile, with its own growth clock and its own belt into the line.
 * So it pays more than both, and 150 is the next step in 110 → 125 → 150.
 *
 * **WHY THIS CANNOT ACCELERATE AN ECONOMY ALREADY RUNNING ~5× TOO FAST** (item 046 inherits the
 * sweep; this tier must not make its job worse):
 *
 * - A russet becomes a bag: 200 → 2000, a **10× multiplier** across five operations.
 * - A pepper becomes flavour: 300 → 450 of added bag value, a **1.5× multiplier**. It rides the
 *   two rungs it joins at and is multiplied by nothing, because it enters at the Seasoner
 *   rather than at the head of the line.
 * - The gold potato costs $4.00 more than a russet and returns $6.00 more per bag: **+$2.00 of
 *   margin on a plain bag's $18.00**, or +11%, for a crop that takes 180 s against a russet's
 *   90 s. Per *tile*-second the gold line is therefore WORSE than the plain one; per *machine*
 *   operation it is 30% better ($5.20 vs $4.00 an op). That is the trade on purpose — gold is
 *   what you plant when your line outruns your field, and a straight upgrade would have been
 *   both a balance bug and a boring decision.
 *
 * No number below beats the plain line on the axis the plain line wins on. If item 046's sweep
 * finds the economy still hot, this tier is not why.
 */
export const FLAVOUR_PREMIUM_NUMERATOR = 150;
export const FLAVOUR_PREMIUM_DENOMINATOR = 100;

/** 150% of what the extra ingredient cost, floored to the cent. */
export function flavourPremiumCents(extraInputCents: number): number {
  return divFloor(extraInputCents * FLAVOUR_PREMIUM_NUMERATOR, FLAVOUR_PREMIUM_DENOMINATOR);
}

/**
 * **$6.00, and it is added to every rung of the gold line identically.**
 *
 * `flavourPremiumCents(600 − 200)` — 150% of what a gold potato costs over the russet it
 * replaces. A flat shift rather than a per-rung markup is the whole design: it means each
 * machine adds *exactly* the value it adds to a russet (+100 washed, +150 sliced, +450 fried,
 * +500 seasoned, +600 bagged), and the premium the player paid for at the seed shop rides
 * through the line untouched. A proportional markup would have quietly multiplied the premium
 * five times over and handed item 046 a second runaway.
 */
export const GOLD_POTATO_PREMIUM_CENTS = flavourPremiumCents(
  GOLD_POTATO_PRICE_CENTS - RUSSET_POTATO_PRICE_CENTS,
);

/** $4.50 — 150% of one pepper. One pepper seasons one chip; see the Seasoner's recipes. */
export const CHILI_PREMIUM_CENTS = flavourPremiumCents(CHILI_PEPPER_PRICE_CENTS);

/** $3.30 — 150% of one corn. */
export const SWEETCORN_PREMIUM_CENTS = flavourPremiumCents(CORN_PRICE_CENTS);

/** Plan §4: "syrup + carbonated water + bottle → soda (~$16)". This is the ~$16. */
export const SODA_PRICE_CENTS = 1600;

/**
 * What the bin pays for an empty (item 131). **A TENTH OF A CLEAN BOTTLE, AND THE RATIO IS THE
 * WHOLE POINT.**
 *
 * A clean `ItemId.Bottle` is 120¢, so an empty run through a Washer is worth 120¢ and an empty
 * dropped in the bin is worth 12¢. That gap is what makes the loop worth building without a
 * single number needing to be balanced against a clock: washing beats scrapping tenfold, always,
 * and a player who works it out once never has to work it out again.
 *
 * IT IS NOT ZERO, and that is the anti-rubbish clause. Item 131 asked whether a player who never
 * builds the centre should be left holding empties they cannot get rid of, and plan §4's floor
 * answers it — nothing a player owns is stranded. Twelve cents is deposit money: enough that the
 * bin is a real exit, nowhere near enough to be a strategy.
 */
export const USED_BOTTLE_SCRAP_CENTS = 12;

/**
 * The two bundles, and the reason they exist.
 *
 * Plan §4 calls them "gentle bundle premiums", and plan §8's release gate for the soda wing is
 * *"do players run both lines, or does one dominate into decoration?"* — the **Snack Combo is
 * the answer to that gate**, not a shop feature. One bagged chip plus one soda pays 125% of the
 * two sold separately, so a mature chip line and a growing soda line beat either line doubled,
 * and neither district becomes scenery.
 *
 * The six-pack is the smaller premium (110%) on purpose: it bundles one product with itself, so
 * it rewards throughput rather than breadth, and pricing it as generously as the Combo would
 * make the Combo pointless.
 *
 * Both are computed from the real prices below rather than typed as literals — the same rule
 * `rusticStylePriceCents` follows, and for the same reason: a hardcoded 4500 is a number that
 * silently stops being 125% the first time a bag of chips is repriced.
 */
export const SIX_PACK_COUNT = 6;
export const SIX_PACK_PREMIUM_NUMERATOR = 110;
export const SIX_PACK_PREMIUM_DENOMINATOR = 100;
export const SNACK_COMBO_PREMIUM_NUMERATOR = 125;
export const SNACK_COMBO_PREMIUM_DENOMINATOR = 100;

export function sixPackPriceCents(): number {
  return divFloor(
    SODA_PRICE_CENTS * SIX_PACK_COUNT * SIX_PACK_PREMIUM_NUMERATOR,
    SIX_PACK_PREMIUM_DENOMINATOR,
  );
}

export function snackComboPriceCents(): number {
  return divFloor(
    (BAGGED_CHIPS_PRICE_CENTS + SODA_PRICE_CENTS) * SNACK_COMBO_PREMIUM_NUMERATOR,
    SNACK_COMBO_PREMIUM_DENOMINATOR,
  );
}

/**
 * Plan §4's chip ladder, in cents: potato 200 → washed 300 → slices 450 → plain 900 →
 * seasoned 1400 → bagged 2000. Each step adds more absolute value than the last, which is
 * what makes finishing the line worth the belts it takes to feed it.
 *
 */
/**
 * The three columns every boxed-machine row shares, written once.
 *
 * Twenty rows that must agree on all three flags are twenty chances for one of them to be
 * typed `sellable: true` in a hurry — and that one row would put a machine in the sell bin at
 * a list price of nothing, which is a bug that pays out. Sharing the literal makes the rule a
 * rule; the ids and slugs, which genuinely differ per row, are still written out per row.
 */
const BOXED = { listPriceCents: 0, purchasable: false, sellable: false } as const;

export const ITEM_SPECS: readonly ItemSpec[] = [
  // Seeds: bought at the stand, never sold back. See `ItemSpec.sellable`.
  {
    id: ItemId.PotatoSeed,
    slug: 'potato-seed',
    listPriceCents: 50,
    purchasable: true,
    sellable: false,
  },
  {
    id: ItemId.RussetPotato,
    slug: 'russet-potato',
    listPriceCents: RUSSET_POTATO_PRICE_CENTS,
    purchasable: false,
    sellable: true,
  },
  {
    id: ItemId.BaggedChips,
    slug: 'bagged-chips',
    listPriceCents: BAGGED_CHIPS_PRICE_CENTS,
    purchasable: false,
    sellable: true,
  },
  {
    id: ItemId.WashedPotato,
    slug: 'washed-potato',
    listPriceCents: WASHED_POTATO_PRICE_CENTS,
    purchasable: false,
    sellable: true,
  },
  {
    id: ItemId.PotatoSlices,
    slug: 'potato-slices',
    listPriceCents: POTATO_SLICES_PRICE_CENTS,
    purchasable: false,
    sellable: true,
  },
  {
    id: ItemId.PlainChips,
    slug: 'plain-chips',
    listPriceCents: PLAIN_CHIPS_PRICE_CENTS,
    purchasable: false,
    sellable: true,
  },
  {
    id: ItemId.SeasonedChips,
    slug: 'seasoned-chips',
    listPriceCents: SEASONED_CHIPS_PRICE_CENTS,
    purchasable: false,
    sellable: true,
  },
  {
    id: ItemId.RusticStyleChips,
    slug: 'rustic-style-chips',
    listPriceCents: divFloor(
      SEASONED_CHIPS_PRICE_CENTS * RUSTIC_STYLE_NUMERATOR,
      RUSTIC_STYLE_DENOMINATOR,
    ),
    purchasable: false,
    sellable: true,
  },

  // --- item 111's flavour tier ----------------------------------------------------------
  //
  // NOT ONE LITERAL IN THE WHOLE BLOCK. Every price is `plain rung + premium`, so the tier
  // cannot drift away from the ladder it is priced against: reprice seasoned chips and the
  // chili bag follows on the same line. See `FLAVOUR_PREMIUM_NUMERATOR` for where the premiums
  // come from and why they do not accelerate the economy.

  // The gold line — the plain line shifted up by a flat $6.00 at every rung. 600 → 900 →
  // 1050 → 1500 → 2000 → 2600, which adds +100/+150/+450/+500/+600 exactly as the russet
  // line does. The machines do not know the potato was expensive; only the ledger does.
  {
    id: ItemId.WashedGoldPotato,
    slug: 'washed-gold-potato',
    listPriceCents: WASHED_POTATO_PRICE_CENTS + GOLD_POTATO_PREMIUM_CENTS,
    purchasable: false,
    sellable: true,
  },
  {
    id: ItemId.GoldPotatoSlices,
    slug: 'gold-potato-slices',
    listPriceCents: POTATO_SLICES_PRICE_CENTS + GOLD_POTATO_PREMIUM_CENTS,
    purchasable: false,
    sellable: true,
  },
  {
    id: ItemId.GoldChips,
    slug: 'gold-chips',
    listPriceCents: PLAIN_CHIPS_PRICE_CENTS + GOLD_POTATO_PREMIUM_CENTS,
    purchasable: false,
    sellable: true,
  },
  {
    id: ItemId.SeasonedGoldChips,
    slug: 'seasoned-gold-chips',
    listPriceCents: SEASONED_CHIPS_PRICE_CENTS + GOLD_POTATO_PREMIUM_CENTS,
    purchasable: false,
    sellable: true,
  },
  {
    id: ItemId.BaggedGoldChips,
    slug: 'bagged-gold-chips',
    listPriceCents: BAGGED_CHIPS_PRICE_CENTS + GOLD_POTATO_PREMIUM_CENTS,
    purchasable: false,
    sellable: true,
  },

  // The two seasonings. They join at the Seasoner, so only the last two rungs differ from
  // plain: 1400 + 450 = 1850 seasoned and 2000 + 450 = 2450 bagged for chili, and the same
  // arithmetic with corn's smaller premium.
  {
    id: ItemId.ChiliChips,
    slug: 'chili-chips',
    listPriceCents: SEASONED_CHIPS_PRICE_CENTS + CHILI_PREMIUM_CENTS,
    purchasable: false,
    sellable: true,
  },
  {
    id: ItemId.BaggedChiliChips,
    slug: 'bagged-chili-chips',
    listPriceCents: BAGGED_CHIPS_PRICE_CENTS + CHILI_PREMIUM_CENTS,
    purchasable: false,
    sellable: true,
  },
  {
    id: ItemId.SweetcornChips,
    slug: 'sweetcorn-chips',
    listPriceCents: SEASONED_CHIPS_PRICE_CENTS + SWEETCORN_PREMIUM_CENTS,
    purchasable: false,
    sellable: true,
  },
  {
    id: ItemId.BaggedSweetcornChips,
    slug: 'bagged-sweetcorn-chips',
    listPriceCents: BAGGED_CHIPS_PRICE_CENTS + SWEETCORN_PREMIUM_CENTS,
    purchasable: false,
    sellable: true,
  },
  {
    id: ItemId.CaneSeed,
    slug: 'cane-seed',
    listPriceCents: 80,
    purchasable: true,
    sellable: false,
  },
  {
    id: ItemId.SugarCane,
    slug: 'sugar-cane',
    listPriceCents: 250,
    purchasable: false,
    sellable: true,
  },
  {
    id: ItemId.CornSeed,
    slug: 'corn-seed',
    listPriceCents: 70,
    purchasable: true,
    sellable: false,
  },
  {
    id: ItemId.Corn,
    slug: 'corn',
    listPriceCents: CORN_PRICE_CENTS,
    purchasable: false,
    sellable: true,
  },
  {
    id: ItemId.ChiliSeed,
    slug: 'chili-seed',
    listPriceCents: 90,
    purchasable: true,
    sellable: false,
  },
  {
    id: ItemId.ChiliPepper,
    slug: 'chili-pepper',
    listPriceCents: CHILI_PEPPER_PRICE_CENTS,
    purchasable: false,
    sellable: true,
  },
  {
    id: ItemId.RepairKit,
    slug: 'repair-kit',
    listPriceCents: REPAIR_KIT_PRICE_CENTS,
    purchasable: true,
    sellable: true,
  },

  // --- the soda line (plan §4's chain, §5's pipe organ) ---
  //
  // Kola arrives as a bought nut rather than a grown one: plan §5 caps the crop roster at
  // eight and §7 ruling 8 closes it, so "kola → powder" is a CONSUMABLE LADDER (§4: "oil,
  // seasoning, bags, bottles start store-bought") rather than a ninth crop. The grinder is
  // the crafted rung; the nut is the bought one.
  { id: ItemId.KolaNut, slug: 'kola-nut', listPriceCents: 150, purchasable: true, sellable: true },
  {
    id: ItemId.KolaPowder,
    slug: 'kola-powder',
    listPriceCents: 220,
    purchasable: false,
    sellable: true,
  },
  // §4: bottles start store-bought at a posted, stable price. The Evaporator and the oil press
  // are stubs — see `README.md`'s Vertical Integration note.
  { id: ItemId.Bottle, slug: 'bottle', listPriceCents: 120, purchasable: true, sellable: true },
  {
    id: ItemId.Soda,
    slug: 'soda',
    listPriceCents: SODA_PRICE_CENTS,
    purchasable: false,
    sellable: true,
  },
  {
    id: ItemId.SixPack,
    slug: 'six-pack',
    listPriceCents: sixPackPriceCents(),
    purchasable: false,
    sellable: true,
  },
  {
    id: ItemId.SnackCombo,
    slug: 'snack-combo',
    listPriceCents: snackComboPriceCents(),
    purchasable: false,
    sellable: true,
  },

  // --- boxed machines ---------------------------------------------------------------
  //
  // Every one of these is `listPriceCents: 0`, and that is a rule rather than a placeholder.
  // A boxed machine is worth what was actually invested in THAT machine — a maxed Fryer and a
  // bare one are the same row and wildly different money — so its value is arithmetic on its
  // own `InventorySlot.boxes` entry, done once in `computeNetWorthCents` and once in
  // `boxedMachineScrapCents`. A number in this column would be a second, wrong opinion that
  // net worth would silently add on top. `test/factory.test.ts` pins the zero.
  //
  // `purchasable: false` — you cannot buy a used machine at the roadside stand; you buy a new
  // one with `PlaceMachine`. `sellable: false` — item 051's grammar, unchanged: the sell bin
  // takes goods, and a boxed machine is scrapped from the inventory panel with
  // `SellBoxedMachine` at 40% of its invoice. The bin refusing them is the same one line of
  // data doing the same job it already did for seeds.
  { id: ItemId.BoxedChipKitchen, slug: 'boxed-chip-kitchen', ...BOXED },
  { id: ItemId.BoxedSprinkler, slug: 'boxed-sprinkler', ...BOXED },
  { id: ItemId.BoxedWasher, slug: 'boxed-washer', ...BOXED },
  { id: ItemId.BoxedSlicer, slug: 'boxed-slicer', ...BOXED },
  { id: ItemId.BoxedFryer, slug: 'boxed-fryer', ...BOXED },
  { id: ItemId.BoxedSeasoner, slug: 'boxed-seasoner', ...BOXED },
  { id: ItemId.BoxedBagger, slug: 'boxed-bagger', ...BOXED },
  { id: ItemId.BoxedPump, slug: 'boxed-pump', ...BOXED },
  { id: ItemId.BoxedTank, slug: 'boxed-tank', ...BOXED },
  { id: ItemId.BoxedPipedSprinkler, slug: 'boxed-piped-sprinkler', ...BOXED },
  { id: ItemId.BoxedIrrigationHub, slug: 'boxed-irrigation-hub', ...BOXED },
  { id: ItemId.BoxedRecirculator, slug: 'boxed-recirculator', ...BOXED },
  { id: ItemId.BoxedJuicer, slug: 'boxed-juicer', ...BOXED },
  { id: ItemId.BoxedKettle, slug: 'boxed-kettle', ...BOXED },
  { id: ItemId.BoxedGrinder, slug: 'boxed-grinder', ...BOXED },
  { id: ItemId.BoxedSyrupMixer, slug: 'boxed-syrup-mixer', ...BOXED },
  { id: ItemId.BoxedCarbonator, slug: 'boxed-carbonator', ...BOXED },
  { id: ItemId.BoxedBottler, slug: 'boxed-bottler', ...BOXED },
  { id: ItemId.BoxedSixPacker, slug: 'boxed-six-packer', ...BOXED },
  { id: ItemId.BoxedComboPacker, slug: 'boxed-combo-packer', ...BOXED },
  { id: ItemId.BoxedDeliveryCart, slug: 'boxed-delivery-cart', ...BOXED },
  { id: ItemId.BoxedTruckDepot, slug: 'boxed-truck-depot', ...BOXED },
  { id: ItemId.BoxedBeltJunction, slug: 'boxed-belt-junction', ...BOXED },

  // --- the roster's last crop and the orchard's fruit ---------------------------------
  //
  // ART MANIFEST, DECLARED HERE AND NOWHERE ELSE. The slugs below are the ids the art pipeline
  // reads: `gold-potato-seed`, `gold-potato`, `orange`, `lemon`, `push-scythe` as item sprites,
  // plus the growth strip `crop_gold_potato_strip` (one horizontal strip per crop, one generation
  // call — §15, and never four separate calls) and three tree sprites for `orange-tree`,
  // `lemon-tree`, `kola-tree` in `MACHINE_SPECS`.
  // Nothing here generates art; this table is the declaration the art pass reads off.
  //
  // **`day-old-gold-potato` AND `fertilizer` WERE ON THIS LIST AND ARE GONE** (item 124). Both
  // items were deleted, and `item_day_old_gold_potato`, `item_fertilizer` and `machine_composter`
  // were pulled out of `art/manifest.json` with them — the atlas went 170 → 167 frames. The
  // committed originals and their prompt sidecars stay on disk in `art/originals/`, so the art is
  // re-bakeable if the ruling is ever reversed; nothing in the atlas claims the game draws them.
  //
  // ⚠️ `crop_gold_potato_strip` IS FIVE CELLS AND THE GAME DRAWS FOUR. Cell 5 is the withered
  // plant, generated for the wilt state that no longer exists. It stays because it is inside one
  // image with the four cells that ARE drawn: separating it means cropping a committed original
  // or re-rolling the whole plant. `growthStage` caps at `stageCount - 1`, so nothing can ask for
  // it. Cost: 32×32 px on a page that is 44% full.
  {
    id: ItemId.GoldPotatoSeed,
    slug: 'gold-potato-seed',
    listPriceCents: 200,
    purchasable: true,
    sellable: false,
  },
  {
    // §5's "premium". Three times a Russet at the till, and three times the water in the ground.
    id: ItemId.GoldPotato,
    slug: 'gold-potato',
    listPriceCents: GOLD_POTATO_PRICE_CENTS,
    purchasable: false,
    sellable: true,
  },
  { id: ItemId.Orange, slug: 'orange', listPriceCents: 260, purchasable: false, sellable: true },
  { id: ItemId.Lemon, slug: 'lemon', listPriceCents: 240, purchasable: false, sellable: true },
  {
    // §3's 15-Minute Rule against the $150 barrel sprinkler's anchor: era-1 income is about $10 a
    // minute, so an assisted tool wants to sit near $60–$100. The scythe is the cheapest of the
    // three because it is the one that removes the least — you still walk the row and swing.
    id: ItemId.PushScythe,
    slug: 'push-scythe',
    listPriceCents: 6_000,
    purchasable: true,
    sellable: true,
  },
  {
    // $8 — the same money a repair kit costs, and the parallel is deliberate: both are a
    // consumable you buy at the stand to spend on one spot of trouble, and both are refused
    // rather than eaten when they would not help. One crate keeps twenty potatoes ($40 of
    // produce) alive for another half hour, so it pays for itself five times over the first time
    // it saves a stack — cheap relative to the loss it prevents, which is item 035's instruction.
    id: ItemId.Crate,
    slug: 'crate',
    listPriceCents: 800,
    purchasable: true,
    sellable: true,
  },

  { id: ItemId.BoxedRootCellar, slug: 'boxed-root-cellar', ...BOXED },
  { id: ItemId.BoxedHandCart, slug: 'boxed-hand-cart', ...BOXED },
  { id: ItemId.BoxedOrangeTree, slug: 'boxed-orange-tree', ...BOXED },
  { id: ItemId.BoxedLemonTree, slug: 'boxed-lemon-tree', ...BOXED },
  { id: ItemId.BoxedKolaTree, slug: 'boxed-kola-tree', ...BOXED },
  { id: ItemId.BoxedHarvesterDock, slug: 'boxed-harvester-dock', ...BOXED },
  { id: ItemId.BoxedPlanterDock, slug: 'boxed-planter-dock', ...BOXED },

  {
    // Manufactured by nothing, now that the bench is retired — `purchasable: false` and no
    // producer at all, so the stock in a returning player's bag is finite (see `ItemId.DronePart`).
    id: ItemId.DronePart,
    slug: 'drone-part',
    listPriceCents: DRONE_PART_PRICE_CENTS,
    purchasable: false,
    sellable: true,
  },
  { id: ItemId.BoxedMaintenanceStation, slug: 'boxed-maintenance-station', ...BOXED },
  { id: ItemId.BoxedDroneBay, slug: 'boxed-drone-bay', ...BOXED },
  { id: ItemId.BoxedPartsBench, slug: 'boxed-parts-bench', ...BOXED },

  // The return leg's good (item 131). Filed after the boxes rather than beside the bottle it
  // came from, because these rows are in id order and 80 is the end of the list.
  {
    id: ItemId.UsedBottle,
    slug: 'used-bottle',
    listPriceCents: USED_BOTTLE_SCRAP_CENTS,
    purchasable: false,
    sellable: true,
  },
];

/**
 * Which machine kind is in which box, in `MachineKind` order.
 *
 * A TABLE RATHER THAN AN OFFSET. `item = kind + 25` happens to be true today and would keep
 * being true right up until one machine kind is retired or one item id is spent elsewhere, at
 * which point every box in every save would open onto the wrong machine. Both id spaces are
 * permanent save surface; the arithmetic between them is not, so it is written down instead of
 * inferred. `MachineKind.SellBin` is deliberately absent — see `ItemId`.
 */
export const BOXED_MACHINE_ROWS: readonly { readonly kind: MachineKind; readonly item: ItemId }[] =
  [
    { kind: MachineKind.ChipKitchen, item: ItemId.BoxedChipKitchen },
    { kind: MachineKind.Sprinkler, item: ItemId.BoxedSprinkler },
    { kind: MachineKind.Washer, item: ItemId.BoxedWasher },
    { kind: MachineKind.Slicer, item: ItemId.BoxedSlicer },
    { kind: MachineKind.Fryer, item: ItemId.BoxedFryer },
    { kind: MachineKind.Seasoner, item: ItemId.BoxedSeasoner },
    { kind: MachineKind.Bagger, item: ItemId.BoxedBagger },
    { kind: MachineKind.Pump, item: ItemId.BoxedPump },
    { kind: MachineKind.Tank, item: ItemId.BoxedTank },
    { kind: MachineKind.PipedSprinkler, item: ItemId.BoxedPipedSprinkler },
    { kind: MachineKind.IrrigationHub, item: ItemId.BoxedIrrigationHub },
    { kind: MachineKind.Recirculator, item: ItemId.BoxedRecirculator },
    { kind: MachineKind.Juicer, item: ItemId.BoxedJuicer },
    { kind: MachineKind.Kettle, item: ItemId.BoxedKettle },
    { kind: MachineKind.Grinder, item: ItemId.BoxedGrinder },
    { kind: MachineKind.SyrupMixer, item: ItemId.BoxedSyrupMixer },
    { kind: MachineKind.Carbonator, item: ItemId.BoxedCarbonator },
    { kind: MachineKind.Bottler, item: ItemId.BoxedBottler },
    { kind: MachineKind.SixPacker, item: ItemId.BoxedSixPacker },
    { kind: MachineKind.ComboPacker, item: ItemId.BoxedComboPacker },
    { kind: MachineKind.DeliveryCart, item: ItemId.BoxedDeliveryCart },
    { kind: MachineKind.TruckDepot, item: ItemId.BoxedTruckDepot },
    { kind: MachineKind.BeltJunction, item: ItemId.BoxedBeltJunction },
    { kind: MachineKind.RootCellar, item: ItemId.BoxedRootCellar },
    { kind: MachineKind.HandCart, item: ItemId.BoxedHandCart },
    // A boxed tree. It is a sapling in a sack, and it keeps nothing but its invoice — the fruit
    // in its buffer comes back to the player's hands with everything else `DeconstructMachine`
    // empties, exactly as a Fryer's basket does.
    { kind: MachineKind.OrangeTree, item: ItemId.BoxedOrangeTree },
    { kind: MachineKind.LemonTree, item: ItemId.BoxedLemonTree },
    { kind: MachineKind.KolaTree, item: ItemId.BoxedKolaTree },
    { kind: MachineKind.HarvesterDock, item: ItemId.BoxedHarvesterDock },
    { kind: MachineKind.PlanterDock, item: ItemId.BoxedPlanterDock },
    { kind: MachineKind.MaintenanceStation, item: ItemId.BoxedMaintenanceStation },
    { kind: MachineKind.DroneBay, item: ItemId.BoxedDroneBay },
    { kind: MachineKind.PartsBench, item: ItemId.BoxedPartsBench },
  ];

/**
 * **THE TOMBSTONE LIST: machine kinds this game no longer sells** (item 090).
 *
 * A retired kind keeps everything except the right to be built. Its `MachineSpec` stays in
 * `MACHINE_SPECS`, its row stays in `BOXED_MACHINE_ROWS`, its id stays spent forever — and all
 * three have to, because a player may still be holding a BOX of one. A box with no spec behind
 * it has no slug to name itself by, no price for `boxedMachineScrapCents` to work from, and no
 * label on the row a player is about to scrap for 40%; deleting the spec would therefore turn
 * a machine somebody bought into unsellable junk, which is the one thing plan §4 rules out
 * flat. So the spec becomes a headstone rather than a hole, and `applyPlaceMachine` is where
 * the retirement is actually enforced.
 *
 * A LIST RATHER THAN A `retired` FIELD ON EVERY SPEC, for the same reason `BOXED_MACHINE_ROWS`
 * is a table rather than an offset: retiring a machine is a rare, deliberate, argued act, and
 * it should read as one entry with one citation beside it rather than as thirty-four `false`s.
 * It is folded into `BALANCE_HASH` below, because "you can no longer buy this" is exactly the
 * kind of fact a save's replay determinism depends on.
 *
 * **The Parts Bench** — the only entry, and it is here because its only customer stopped
 * buying. The bench existed to manufacture drone parts; item 090's ruling is that repair drones
 * fix machines for free, so the bench's output has no consumer, its recipe cooks a souvenir,
 * and a build menu offering it at $800 would be selling the player a machine whose product does
 * nothing. `ItemId.DronePart` stays `sellable` so a warehouse of them converts to money at the
 * bin, and a placed bench comes home in a box through the 16 → 17 migration.
 */
export const RETIRED_MACHINE_KINDS: readonly MachineKind[] = [MachineKind.PartsBench];

/** True for a kind the game has stopped selling. The one gate `applyPlaceMachine` reads. */
export function isMachineRetired(kind: MachineKind): boolean {
  for (let i = 0; i < RETIRED_MACHINE_KINDS.length; i++) {
    if (RETIRED_MACHINE_KINDS[i] === kind) return true;
  }
  return false;
}

/** The boxed item a machine kind goes into, or `null` for a kind that has no box. */
export function boxedItemForMachine(kind: MachineKind): ItemId | null {
  for (let i = 0; i < BOXED_MACHINE_ROWS.length; i++) {
    const row = BOXED_MACHINE_ROWS[i]!;
    if (row.kind === kind) return row.item;
  }
  return null;
}

/** The machine kind inside a boxed item, or `null` for anything that is not one. */
export function machineKindForBoxedItem(item: ItemId): MachineKind | null {
  for (let i = 0; i < BOXED_MACHINE_ROWS.length; i++) {
    const row = BOXED_MACHINE_ROWS[i]!;
    if (row.item === item) return row.kind;
  }
  return null;
}

/** True for the twenty boxed-machine rows and nothing else. */
export function isBoxedMachineItem(item: ItemId): boolean {
  return machineKindForBoxedItem(item) !== null;
}

/**
 * What scrapping a boxed machine pays: **40% of what was invested in it, floored to the cent**.
 *
 * PLAN §3'S 40% AND ITEM 037'S DANGLING CRITERION, finally somewhere it can be checked. The
 * arithmetic is on the machine's own invoice — purchase price plus every dial bought since —
 * rather than on a table, so an upgraded machine scraps for more than a bare one without a
 * second number anywhere that could disagree. Condition is deliberately NOT in it: scrap value
 * is what the parts fetch, and hand repair is free, so a worn machine you were going to scrap
 * anyway is not also a worse trade.
 */
export const SCRAP_PAYOUT_NUMERATOR = 40;
export const SCRAP_PAYOUT_DENOMINATOR = 100;

export function boxedMachineScrapCents(investedCents: number): number {
  return divFloor(investedCents * SCRAP_PAYOUT_NUMERATOR, SCRAP_PAYOUT_DENOMINATOR);
}

export function itemSpec(id: ItemId): ItemSpec | null {
  for (let i = 0; i < ITEM_SPECS.length; i++) {
    const spec = ITEM_SPECS[i]!;
    if (spec.id === id) return spec;
  }
  return null;
}

export function listPriceCents(id: ItemId): number {
  const spec = itemSpec(id);
  return spec === null ? 0 : spec.listPriceCents;
}

export function isPurchasable(id: ItemId): boolean {
  const spec = itemSpec(id);
  return spec !== null && spec.purchasable;
}

/**
 * Whether the sell bin will take this at all.
 *
 * The reducer refuses a `SellItem` for anything this says no to, and the HUD reads the same
 * function to grey the affordance out — one rule, both sides, the way `pipePathRefusal` is
 * shared by the placement ghost and the reducer. An item nobody defined is not sellable:
 * defaulting the other way would make an id typo pay out.
 */
export function isSellable(id: ItemId): boolean {
  const spec = itemSpec(id);
  return spec !== null && spec.sellable;
}

// --- nothing rots ------------------------------------------------------------------
//
// **THIS SECTION IS DELIBERATELY EMPTY OF MECHANIC** (item 124, owner ruling 2026-08-17:
// *"I want fertility to not be a feature at all, and I want wasting to not be a feature at
// all, like these old day potatoes and the compost. I want all of that gone."*).
//
// It held plan §4's whole waste loop, in two halves. The IN-GROUND half (item 021) was
// `WILT_GRACE_TICKS`, `WILT_WINDOW_TICKS`, `COMPOST_AFTER_TICKS`, `COMPOST_PER_CROP`,
// `WiltStage` and `wiltStageForAge`: a matured crop drooped, turned, and finally collapsed
// into compost on the tile. The HARVESTED half (items 035 and 110–119) was
// `FRESHNESS_TICKS_BY_ITEM`, `freshnessTicks`, `isPerishable`, `FRESHNESS_BUCKET_TICKS`,
// `FRESHNESS_MAX_STACKS`, `CRATE_FRESHNESS_TICKS`, `CRATE_PACK_CAPACITY`,
// `STORAGE_AGING_BY_KIND`, `storageAgingPerTick`, `COMPOST_PER_SPOILED_ITEM` and
// `COMPOST_PER_FERTILIZER`: a clock on every good in every container, a Day-Old grade at
// `DAY_OLD_NUMERATOR / DAY_OLD_DENOMINATOR`, and a Composter that turned the wreckage back
// into Fertilizer. All of it is gone, and so are the item ids at both ends.
//
// **A CROP LEFT IN THE GROUND IS THE SAME CROP FOREVER, AND SO IS A POTATO IN A CART.** The
// only thing that reads a tick and a good in the same sentence now is growth.
//
// The one rule that reads like this and IS NOT THIS is plan §4's *"nothing vanishes"* — the
// invariant that a good never silently disappears between belt, claw, hopper, bag and bin.
// That is a census over quantities (`test/goods.ts`) and it never had anything to do with
// decay. It survives untouched and it is what proves this deletion lost nobody a potato.

/**
 * The armful cap is GONE, on the record (item 068, owner ruling 2026-08-14, from play:
 * "that's not something I wanted. Remove it."). `ARMFUL_CAP_ITEMS = 12` and its helpers
 * `armfulRoom` / `hasArmfulRoom` gated harvest, buy, unload, and take-from-storage; all of it
 * was deleted rather than softened — no higher cap, no slowdown, no replacement friction.
 * This deliberately strikes plan §3's manual transport rung ("Armful (12 items, teeter +
 * slow)") and shrinks the hand cart's pitch to "walk less"; the owner chose that trade with
 * eyes open. `carriedCount` survives (stats and HUD read it), and `BOT_CARRY_CAPACITY` below
 * is a different mechanic on different arms — bots keep their capacity.
 */

// --- crops ------------------------------------------------------------------------

export interface CropSpec {
  readonly id: CropId;
  readonly slug: string;
  /** Work-points of growth needed at 1★ before the tile is ready. */
  readonly growthTicks: number;
  /** Per-tile variance, in tenths of a percent, so fields ripen in waves (plan §2). */
  readonly growthVariancePermille: number;
  /** Seed consumed to plant. */
  readonly seedItem: ItemId;
  /** What a harvest yields. The count is `HARVEST_BASE_COUNT` + the coin — no fertility term
   * since item 124; see `takeHarvest`. */
  readonly yieldItem: ItemId;
  /** Renderer growth stages, including the bare-soil stage. */
  readonly stageCount: number;
  /**
   * Ticks of regrowth after a harvest, or 0 for a one-shot crop. Regrowing crops keep the
   * plant and return no seed — plan §5: "regrowing crops automate first".
   */
  readonly regrowTicks: number;
  /** Moisture spent per tick while this crop is in the ground. Thirsty crops drink more. */
  readonly moistureDrainPerTick: number;
  /** The node that makes this crop plantable, or null for the starter. */
  readonly requiresTech: string | null;
}

export const CROP_SPECS: readonly CropSpec[] = [
  {
    id: CropId.RussetPotato,
    slug: 'russet-potato',
    growthTicks: 90 * TICKS_PER_SECOND,
    growthVariancePermille: 150,
    seedItem: ItemId.PotatoSeed,
    yieldItem: ItemId.RussetPotato,
    stageCount: 5,
    regrowTicks: 0,
    moistureDrainPerTick: 1,
    requiresTech: null,
  },
  {
    // Plan §5: "Sugar Cane (regrows, thirsty — first crop worth automating)".
    id: CropId.SugarCane,
    slug: 'sugar-cane',
    growthTicks: 150 * TICKS_PER_SECOND,
    growthVariancePermille: 120,
    seedItem: ItemId.CaneSeed,
    yieldItem: ItemId.SugarCane,
    stageCount: 5,
    regrowTicks: 60 * TICKS_PER_SECOND,
    moistureDrainPerTick: 2,
    requiresTech: TechId.Cane,
  },
  {
    // Dual use: oil at the press now, corn syrup later.
    id: CropId.Corn,
    slug: 'corn',
    growthTicks: 210 * TICKS_PER_SECOND,
    growthVariancePermille: 100,
    seedItem: ItemId.CornSeed,
    yieldItem: ItemId.Corn,
    stageCount: 5,
    regrowTicks: 0,
    moistureDrainPerTick: 1,
    requiresTech: TechId.Corn,
  },
  {
    id: CropId.ChiliPepper,
    slug: 'chili-pepper',
    growthTicks: 120 * TICKS_PER_SECOND,
    growthVariancePermille: 150,
    seedItem: ItemId.ChiliSeed,
    yieldItem: ItemId.ChiliPepper,
    stageCount: 5,
    regrowTicks: 45 * TICKS_PER_SECOND,
    moistureDrainPerTick: 1,
    requiresTech: TechId.Chili,
  },
  {
    // §5: "Gold Potato (premium, thirsty)". The roster's fifth sown crop and its last.
    //
    // **THIRST IS A DRAIN RATE, NOT A SPRINKLER SPECIAL CASE** (item 030's constraint). Three
    // moisture a tick against a Russet's one, so on the same watering schedule a gold row runs
    // dry three times as fast and stops growing while it waits — visible in the ground as cracked
    // earth at `MOISTURE_DRY_THRESHOLD`, which is the same threshold the renderer already draws
    // and the Irrigation Hub already senses. Nothing anywhere knows this crop is special; it just
    // drinks, and the sprinkler you already own is suddenly not enough, which is the decision §5
    // wants placement to be.
    //
    // A one-shot, like the Russet: §5 gives regrowth to cane and chili only, and the crop list is
    // the pacing mechanism for the Agri-Bots — a premium one-shot is precisely the crop that
    // waits for the planter bot.
    id: CropId.GoldPotato,
    slug: 'gold-potato',
    growthTicks: 180 * TICKS_PER_SECOND,
    growthVariancePermille: 150,
    seedItem: ItemId.GoldPotatoSeed,
    yieldItem: ItemId.GoldPotato,
    stageCount: 5,
    regrowTicks: 0,
    moistureDrainPerTick: 3,
    requiresTech: TechId.GoldPotato,
  },
];

export function cropSpec(id: CropId): CropSpec | null {
  for (let i = 0; i < CROP_SPECS.length; i++) {
    const spec = CROP_SPECS[i]!;
    if (spec.id === id) return spec;
  }
  return null;
}

// --- soil and water ---------------------------------------------------------------

/** A fully watered tile, in moisture units. Bare soil loses one per tick. */
export const MOISTURE_MAX = 3600;
export const MOISTURE_DRAIN_PER_TICK = 1;
/** Below this a tile reads as dry to the player and to moisture-sensing heads later. */
export const MOISTURE_DRY_THRESHOLD = 1800;
/** Growth accrues only while the tile holds water. No overwatering is possible (plan §2). */
export const GROWTH_PER_WATERED_TICK = 1;

/**
 * **WHAT ONE HARVEST PAYS, BEFORE THE COIN** (item 124).
 *
 * It was `tile.fertility + bonus`, with fertility a 1–3 star roll that fell a star every five
 * harvests and was put back by Fertilizer. Fertility is not a feature any more, so the term it
 * contributed had to become a constant, and the constant is **the old `FERTILITY_MAX`**: every
 * tile now pays what only the best ground used to.
 *
 * THE DIRECTION IS THE WHOLE ARGUMENT. Taking the mean, or the floor, would have made some
 * existing save strictly worse the moment it loaded — a player sitting on 3★ ground would open
 * the game to find their field pays less than it did yesterday, which is a patch note reaching
 * into somebody's lot. Taking the max cannot make any save worse, and a player who had ground
 * down to 1★ opens the game to triple yields. It is also the reading the owner's 2026-08-17
 * ruling on a fast, big-number economy points at.
 */
export const HARVEST_BASE_COUNT = 3;

/** One pour from the can. */
export const HAND_POUR_ML = 2000;
/**
 * The can holds twenty pours (owner ruling, 2026-08-15, item 073 — overriding plan §3's
 * "8 pours" figure and the 2026-08-13 restoration of it).
 *
 * §4's bold clause — "the watering can always fills at any shore at any level" — governs
 * REFILL AVAILABILITY, not capacity: `RefillCan` never fails at a shore, at any water level,
 * including a bone-dry pond. The capacity is what makes "refill the can" a beat of §2's
 * Gardener circuit rather than a rule nobody meets. Watering on an empty can REFUSES as a
 * gentle no-op — nothing is spent, nothing is punished, and the HUD reads
 * `player.canCharges === 0` as its cue to point at the shore.
 *
 * SAVE COMPAT: widening the range needs no format bump — a can saved at 8 under the old cap
 * simply loads as partly full, and refills at any level are legal. Deliberately NOT topped up
 * on migrate; leaving it is simpler and honest.
 */
export const CAN_CHARGES_MAX = 20;
/** One sprinkler head servicing one tile. Wetting an already-wet tile still costs water. */
export const SPRINKLER_POUR_ML = 1500;

// --- reservoirs -------------------------------------------------------------------
//
// **A POND IS A FACT ABOUT THE MAP, NOT A STOCK** (item 140; owner ruling 2026-08-17: *"I want
// the ponds to have infinite water. Get rid of the artisan well and just have the pond have an
// unlimited supply of water."*). It has a footprint, an id, and nothing else. There is no
// capacity, no level, no recharge rate and no throttle band, because there is nothing left for
// any of them to describe.
//
// **WHAT PLAN §4 SAID, AND WHAT SURVIVES OF IT.** §4 read: "Reservoirs ~10,000 units recharging
// ~20 u/min; overdraw is telegraphed (shoreline recedes, mud ring), pumps halve below 25% and
// sip at recharge rate when empty — reservoirs always recover. ... The watering can always fills
// at any shore at any level." Every clause of that was a way of promising the player would never
// be stopped by water while still making them feel it. The promise is now kept by construction
// and the machinery for feeling it is gone: nothing recedes, nothing halves, nothing sips, and
// "always recovers" is true of a thing that never falls. The can's clause survives as the only
// one with content left — see `WaterDraw.Shore` — and it now means "even where there is no pond
// at all" rather than "even at an empty one".
//
// **INFINITE SOURCE, FINITE THROUGHPUT, AND THAT DISTINCTION IS THE WHOLE RULING.** The pond
// never runs dry; the pump still has a rate. So networks still have to be built, sized and
// buffered, and `PUMP_RATE_ML_PER_MINUTE` below is now the ONLY number between the map and the
// pipes. Making throughput unlimited too would have turned the pump into a formality and the
// Tank into decoration, which is a far larger design change than the words asked for.
//
// The measurement that used to live here was right and is kept in the log rather than the code:
// a tile drains from `MOISTURE_MAX` to `MOISTURE_DRY_THRESHOLD` in 1,800 ticks, so holding all
// 64 field tiles above dry costs 64,000 ml/min for a waterer that wastes nothing, against a pond
// that made 40,000. That 1.6× structural deficit is what this deletes.

/**
 * The starting pond, in world tiles: the lot's south-east corner, clear of the field.
 *
 * THE CORNER IS CHOSEN, NOT DEFAULTED. The player spawns just south of the field, so the
 * shore is a short walk from the first second — which matters, because "bucket/can at the
 * shore" is the bottom rung of plan §3's Liquids ladder and the rung everything above it is
 * measured against. The north-west corner would have been the obvious pick and is the wrong
 * one: it is where every test and every scratch build drops a machine when it just needs
 * empty ground, and permanent scenery there would break that convention for everything
 * written afterwards. The north strip is likewise where existing saves put their factories.
 */
export const POND_ORIGIN_X = 12;
export const POND_ORIGIN_Y = 13;
export const POND_TILES_WIDE = 3;
export const POND_TILES_HIGH = 3;

// --- pipes, pumps, and tanks --------------------------------------------------------
//
// FLOW, NOT PRESSURE (plan §5). There is no pressure field, no per-segment fill level, and
// no flow solver anywhere in this package. A network is a set of pipe tiles; its supply is
// one number; its demands are a list; the tick divides one by the other. If a future change
// starts wanting a solver, the model has been misread.

/** Cents per tile of pipe. Cheap: routing should be a puzzle, not a purchase decision. */
export const PIPE_PRICE_CENTS_PER_TILE = 200;
/** Longest run one drag may lay. A drag is one command, so this bounds its cost. */
export const PIPE_MAX_PATH_TILES = 64;

/**
 * A pump's throughput at full pond, in millilitres per minute. 600 L/min — comfortably one
 * dumb sprinkler head (450 L/min), and nowhere near two, which is the whole tension: the
 * answer to "my second head is amber" is a second pump on its own network, or the Irrigation
 * Hub, which needs a twentieth of the water.
 */
export const PUMP_RATE_ML_PER_MINUTE = 600_000;

/**
 * The round-robin rotation's modulus.
 *
 * 720,720 is divisible by every integer from 1 to 16, so `rrOffset % consumerCount` cycles
 * evenly no matter how many consumers a network has and the rotation never quietly favours
 * whoever sits at index 0. A power of two would bias every odd-sized network forever.
 */
export const PIPE_RR_MODULUS = 720_720;

/** How much the Recirculator reclaims while an adjacent Washer is actually washing. */
export const RECIRCULATOR_ML_PER_MINUTE = 90_000;

/** Chebyshev radius of the Irrigation Hub's coverage, in tiles. A 9×9 patch. */
export const IRRIGATION_HUB_RADIUS_TILES = 4;
/**
 * Coverage tiles the Hub examines per tick, from a cursor stored on the machine.
 *
 * BOUNDED ON PURPOSE (plan §13): the Hub's per-tick cost must not scale with the field. Eight
 * tiles a tick sweeps a 9×9 patch in eleven ticks, which is half a second — far finer than
 * the ~30 active minutes a tile takes to dry out, so the Hub never misses a tile going dry.
 */
export const IRRIGATION_HUB_SCAN_PER_TICK = 8;

// --- zones ------------------------------------------------------------------------
//
// A zone is a PLAN, NOT A MACHINE (plan §5). It plants nothing on its own; the seed hopper
// tech is what turns the auto-replant toggle from a locked promise into a verb.

/** Longest zone name the sim will store. Longer names are clipped, never rejected. */
export const ZONE_NAME_MAX_LENGTH = 24;
export const ZONE_PRIORITY_MIN = 0;
export const ZONE_PRIORITY_MAX = 9;
export const ZONE_PRIORITY_DEFAULT = 5;
/** Widest rect one paint drag may cover. A drag is one command, so this bounds its cost. */
export const ZONE_PAINT_MAX_SPAN = 64;

/**
 * How often a zone with auto-replant on plants one tile, once the seed hopper is
 * researched. Deliberately unhurried: this is the Assisted rung of plan §3's ladder, not a
 * replacement for the player.
 */
export const AUTO_REPLANT_PERIOD_TICKS = 40;

// --- machines ---------------------------------------------------------------------

/**
 * What `advanceMachines` should do with a machine, as data rather than a switch on kind.
 * Adding a machine that converts one item into another should not require editing the tick.
 */
export const MachineRole = {
  /** No work cycle. The sell bin. */
  Inert: 0,
  /** Consumes one input item, produces one output item. The whole chip line. */
  Converter: 1,
  /** Pours from its own barrel on a period. The v0.1 head and the Barrel Sprinkler. */
  Sprinkler: 2,

  // The liquid layer's four roles. `advanceMachines` dispatches on these exactly as it does
  // on Converter, so the pipe ledger never has to know what kind of thing it is feeding.
  /** Draws from an adjacent reservoir into its network. One per network, enforced. */
  Pump: 3,
  /** Buffers a network: takes the surplus, covers the shortfall, shows time-to-empty. */
  Tank: 4,
  /**
   * A head on a network. Same pour, same period, same radius as the v0.1 sprinkler — it
   * simply never needs filling. The Hub is the same role with a dry-tile predicate.
   */
  PipedSprinkler: 5,
  /** Reclaims Washer graywater into a TANK, never into a network (plan §5, and see below). */
  Recirculator: 6,

  // Selling. Both roles hold goods and run a round-trip timer, and NEITHER has a work cycle:
  // `workPerOperation` is 0, so nothing here wears, jams, overcooks, or takes a dial. A vehicle
  // is a container with a clock, and every rule about machines that turn is silent on it.
  /** Loaded by hand, dispatched by hand, pays on return. Assisted, never automatic. */
  DeliveryCart: 7,
  /** Takes goods off a belt and ships them under a standing contract. No hands at all. */
  TruckDepot: 8,

  /**
   * Moves one item from a belt that ends on it to a belt that leads off it, round-robin.
   *
   * It is dispatched out of `belts.ts` rather than out of `advanceMachines`, and the tick order
   * is why: a junction hands off between belts, so it has to run in the same phase belts do —
   * after they have advanced and before the grabbers reach into them. It is a machine for
   * placement, ownership, invoicing and boxing, and a belt fitting for everything else.
   */
  Junction: 9,

  /**
   * A box with a lid: holds one product, and how much of it is `inputCapacity`.
   *
   * NO WORK CYCLE — it never wears, never jams, never takes a dial, exactly like the two
   * vehicles and the junction. Since item 124 there is nothing else to know about one: the
   * freshness window a box used to stamp on its contents is gone, so a Root Cellar and a hand
   * cart differ in how much they hold and whether they follow you, and in nothing else.
   */
  Storage: 10,
  /**
   * A tree. Fills its own output buffer on a cycle and eats nothing at all.
   *
   * **NOT `Converter` WITH AN EMPTY RECIPE, THOUGH THAT WOULD HAVE COMPILED AND RUN.**
   * `recipeSatisfied` is vacuously true on an empty input list, so a tree dropped into the
   * converter path would fruit correctly — and it would also advance `untouchedTicks` every tick
   * it fruited, which would hand the Corporate Charter to a player who planted a tree and ran one
   * belt off it. That milestone's entire claim is *"a machine cannot advance work for 96,000
   * straight ticks unless something is feeding it and something is emptying it, so what the
   * counter certifies **is** a line"* — and a tree needs nothing feeding it. One extra role is
   * cheaper than a Charter that means something different than it says.
   */
  Orchard: 11,
  /**
   * An Agri-Bot dock. Holds a bot's harvest for a belt to take away, and — on the planter — the
   * seed hopper the bot replants from. Runs no work cycle of its own: the bot does the work, and
   * the bot is an entity rather than a number on this machine.
   */
  BotDock: 12,
  /**
   * The Maintenance Station: an automated hand with a kit hopper.
   *
   * ITS OWN ROLE RATHER THAN A CONVERTER WITH A STRANGE RECIPE, because it consumes on a
   * different clock: a converter eats when its recipe is full and its output has room; this
   * eats a kit only when something in its cell is wrench-due, and it produces nothing a belt
   * could take. Its "operation" is `applyUseRepairKit`'s cell service with the hand taken out —
   * no touch, no `handsOn`, and therefore no reset of any machine's untouched clock, which is
   * what lets an automated factory hold the Corporate Charter's milestone while being serviced.
   */
  MaintenanceStation: 13,

  // 14 was `Well` and is spent (item 140): the Artesian Well is retired with the scarcity it
  // existed to relieve, and no other machine ever wanted the role.
} as const;

export type MachineRole = (typeof MachineRole)[keyof typeof MachineRole];

/**
 * True for the three dock kinds — a dock is where a bot sleeps and what it fills. The two
 * farm docks are bound to a zone; the Drone Bay is bound to nothing and holds parts instead
 * of seeds, but it spawns its one bot on placement exactly as they do.
 */
export function isBotDockKind(kind: MachineKind): boolean {
  return (
    kind === MachineKind.HarvesterDock ||
    kind === MachineKind.PlanterDock ||
    kind === MachineKind.DroneBay
  );
}

/** True for the roles that register as consumers on a pipe network and draw a ledger share. */
export function isNetworkConsumer(role: MachineRole): boolean {
  return role === MachineRole.PipedSprinkler || role === MachineRole.Tank;
}

/**
 * One line of a recipe: an item and how many of it one operation eats.
 *
 * CONSUMPTION IS ATOMIC. A machine takes every line of its recipe or it takes none, so a
 * half-consumed operation cannot exist — there is no state in which a Bottler has swallowed the
 * bottle and is waiting for the syrup. That is checked once in `advanceConverter` before
 * anything is decremented, and it is why the Snack Combo cannot eat a bag of chips and stall.
 */
export interface RecipeInput {
  readonly item: ItemId;
  readonly count: number;
}

/**
 * One thing a machine knows how to make: what an operation eats, and what it hands back.
 *
 * **A MACHINE MAY KNOW SEVERAL, AND NOTHING CHOOSES BETWEEN THEM BUT THE BELTS** (item 111).
 * The Seasoner does not grow a dropdown, a mode, or a saved setting — it runs the first recipe
 * its hoppers can satisfy, so what comes out is decided by what the player routed in. That is
 * the same ruling the belt junction is built on: *"a player who wants it to behave differently
 * moves a belt, which is the thing they can already see."* A mode switch would have been a
 * second place the line's shape is written down, and the two would disagree.
 *
 * THE CHOICE IS MADE WHEN THE OPERATION FINISHES, not when it starts, and that is what keeps
 * this out of the save file. `advanceConverter` consumes and produces in the same tick — the
 * recipe is read off the hoppers at the instant the work completes — so there is no
 * half-finished operation carrying a decision that would have to be serialized, hashed and
 * migrated. The only new state in the whole feature is `Machine.outputItem`, and that is a
 * fact about the buffer rather than about the operation.
 *
 * `output` is nullable for exactly the reason `MachineSpec.outputItem` is: a machine whose
 * product is a liquid hands it out through an outlet port instead.
 */
export interface MachineRecipe {
  readonly consumes: readonly RecipeInput[];
  readonly output: ItemId | null;
}

/** Which way a typed port moves liquid. */
export const PortFlow = {
  /** Draws from its network into the machine's own buffer. */
  Intake: 1,
  /** Fills from the machine's operations, and gives to its network's consumers. */
  Outlet: 2,
} as const;

export type PortFlow = (typeof PortFlow)[keyof typeof PortFlow];

/**
 * ONE TYPED PORT — plan §5's "solids ride belts, liquids ride pipes, and they meet only inside
 * machines with typed ports", written as data.
 *
 * The port declares WHICH liquid it accepts, and that declaration is the enforcement: a port
 * only ever attaches to a network carrying its own liquid, and `pipePathRefusal` refuses a run
 * that would present any other liquid to a machine that has ports at all. The Syrup Mixer's
 * "two pipe inlets and one belt inlet" is three lines of data, not a new machine class.
 *
 * AN OUTLET IS A TANK THAT FILLS ITSELF. It joins its network exactly as a `Tank` does — it
 * covers the shortfall of whatever is drawing on the other end, it never accepts surplus, and
 * it is not a pump. That is what lets the whole soda line run on the existing one-ledger model
 * with no second source anywhere: a juice network has **no pump at all**, and plan §5's "one
 * pump per network" is not bent, it is unused. The Recirculator established this exact grammar
 * a release early — a producer pours into a tank, never into the pipes.
 */
export interface LiquidPortSpec {
  readonly liquid: LiquidId;
  readonly flow: PortFlow;
  /** This port's own buffer, in millilitres. Scaled by the Capacity dial like any tank. */
  readonly capacityMl: number;
  /** The most an INTAKE port pulls off its network per tick. Zero on an outlet. */
  readonly intakeMlPerTick: number;
  /** Millilitres one operation consumes (intake) or produces (outlet). */
  readonly mlPerOperation: number;
}

export interface MachineSpec {
  readonly kind: MachineKind;
  readonly slug: string;
  readonly role: MachineRole;
  /** Footprint in tiles. */
  readonly tilesWide: number;
  readonly tilesHigh: number;
  /** Purchase price, and the invoice value net worth accounts it at (plan §6). */
  readonly priceCents: number;
  /** Work-points one operation costs, or 0 for machines that do not run a work cycle. */
  readonly workPerOperation: number;
  /** Work-points produced per tick at full condition and no upgrades. */
  readonly workRatePerTick: number;
  /** Items the input buffer holds, before the Capacity dial. */
  readonly inputCapacity: number;
  readonly outputCapacity: number;
  /** Water tank, for machines that hold one. */
  readonly tankCapacityMl: number;
  /** Condition lost per completed operation. Wear is per-operation, never per second. */
  readonly wearPerOperation: number;
  /**
   * Every solid one operation eats, in a fixed order. Empty for a machine that eats no solids.
   *
   * A LIST RATHER THAN THE SINGLE `inputItem` IT REPLACED, and every machine in the game went
   * through it — there is one recipe executor, not a general one beside a legacy one. The chip
   * line's rows are one-line recipes; the Snack Combo's is two lines; the six-pack's is one
   * line with a count of six.
   *
   * **THIS IS THE MACHINE'S PLAIN RECIPE, NOT ITS HOPPER LIST**, and since item 111 those are
   * two different things: five machines know several recipes, so a Seasoner eats one chip here
   * and can *hold* peppers, corn and gold chips besides. `machine.inputCounts` is sized from
   * and indexed by `machineHoppers()`, never by this. Walk this list when you mean "what one
   * ordinary operation costs" — pricing, value-added, the Dawn Report's idle flag — and walk
   * the hoppers when you mean "what is inside the machine". The header above `machineHoppers`
   * has the story of what happens when the two are confused.
   */
  readonly inputs: readonly RecipeInput[];
  /**
   * The one solid an operation makes, or null when the output is a liquid and leaves through an
   * outlet port instead. Exactly one of the two, never both: a machine that produced a bottle
   * *and* a litre of something would need two demand-pull answers to "is there room", and the
   * player would have no way to see which one stopped it.
   */
  readonly outputItem: ItemId | null;
  /**
   * What this machine's output turns into when it is left sitting in a full buffer, or null
   * for the machines whose output does not spoil — which is all of them but the Fryer.
   *
   * A SPEC FIELD RATHER THAN A CHECK ON KIND, for the same reason `moistureSensing` is one:
   * the rule stays one line in one place, and the day a Roaster or a second fryer tier wants
   * the same behaviour it is a data change rather than an edit to `tick.ts`.
   */
  readonly overcookOutputItem: ItemId | null;
  /** The node that makes this machine buildable, or null for the v0.1 three. */
  readonly requiresTech: string | null;

  // --- the liquid layer's typed ports (plan §5) ---
  //
  // "Solids ride belts, liquids ride pipes, and they meet only inside machines with typed
  // ports." These four fields ARE the typed port: a machine with `liquid === LiquidId.None`
  // has no pipe connection at all and the ledger skips it, so a belt machine can never be
  // accidentally plumbed and a pipe can never carry a potato.

  /**
   * The liquid this machine's pipe port accepts, or `LiquidId.None` for no port.
   *
   * For the plumbing machines — Pump, Tank, heads, Recirculator — this IS their port, driven by
   * `role` in the ledger, exactly as it has been since the liquid layer shipped. For a machine
   * with a `ports` list this field is the FIRST port's liquid, restated: the renderer reads it
   * as "does this machine have a typed port at all", and `test/factory.test.ts` pins the two to
   * agree so the restatement cannot drift into a second opinion.
   */
  readonly liquid: LiquidId;
  /**
   * Every typed port a *converter* has, in a fixed order — an empty list for the plumbing
   * machines, whose single port is the `liquid` / `intakeMlPerTick` / `tankCapacityMl` trio
   * above and always has been.
   *
   * THE SPLIT IS DELIBERATE AND IT IS NOT TWO CODE PATHS TO THE SAME PLACE. A head, a tank and
   * a pump are *made of* their plumbing — the ledger dispatches them on `role` and they have no
   * recipe at all. A converter's ports are ingredients: they fill buffers that an operation then
   * consumes atomically alongside its solids. Collapsing the two would mean giving the Pump a
   * recipe, and `machine.tankMl` — the barrel a player refills BY HAND — would become port state
   * that hand-refilling has to reach through. The ledger reads both lists in one loop; it is the
   * MEANING that differs, not the mechanism.
   */
  readonly ports: readonly LiquidPortSpec[];
  /** A pump's throughput at a full source, in ml per minute. Zero for everything else. */
  readonly pumpRateMlPerMinute: number;
  /**
   * The most this machine will pull off its network in one tick, in millilitres. Its actual
   * demand is this capped by the room left in its own tank, so a full head asks for nothing
   * and a network with one thirsty consumer and three full ones is not throttled at all.
   */
  readonly intakeMlPerTick: number;
  /** Chebyshev radius a watering machine covers, in tiles. Zero for everything else. */
  readonly coverageRadiusTiles: number;
  /**
   * §4's "moisture-sensing heads water only dry tiles". True for the Irrigation Hub alone.
   *
   * It is a spec flag rather than a check on kind so the dry-tile predicate stays one line in
   * one place, and so a second sensing machine is a data change rather than a tick edit. The
   * predicate itself is `MOISTURE_DRY_THRESHOLD` — THE SAME ONE the renderer draws cracked
   * earth with. There is exactly one definition of dry in this game, and a machine that
   * disagreed with the ground about it would be unexplainable.
   */
  readonly moistureSensing: boolean;
  /**
   * Item 067: may this machine stand ON a farm tile? True for the watering family alone —
   * the barrel Sprinkler, the PipedSprinkler head, and the Irrigation Hub — whose whole
   * purpose is to stand among the crops they water; a 5×5 head at the fence waters a slice,
   * and dead-centre it waters all 24 neighbours.
   *
   * A SPEC FLAG RATHER THAN A CHECK ON KIND, exactly like `moistureSensing` above: the
   * footprint rule (`machineFootprintFree` in tick.ts) consults the flag AND NOTHING ELSE, so
   * the Fryer stays behind the fence without a kind-switch at the rule site, and the day a
   * moisture probe wants in it is a data change. The ground underneath is never touched: soil and
   * moisture ride through placement and deconstruction untouched. (There was a third — fertility —
   * until item 124 deleted it.)
   *
   * **A PLANTED TILE NO LONGER REFUSES** (item 121, owner ask 2026-08-17). Item 067 hosted an
   * EMPTY farm tile only, on the house rule that nothing is silently destroyed. The placement
   * now HANDS THE CROP BACK instead — the seed always, and the produce as well if it was ripe —
   * which keeps the house rule by paying it rather than by refusing. (It used to hand back any
   * waiting compost too; since item 124 nothing is ever left lying on a tile.)
   * `clearFieldTileForMachine` in tick.ts is the one place that happens.
   *
   * THE IRRIGATION HUB IS DELIBERATELY IN: it is the same watering family (`role` says so),
   * its coverage is anchored exactly like the heads', and standing mid-field is its entire
   * pitch. Its 2×2 footprint eats four farm tiles, which is the player's own trade to make —
   * and as of item 121 it hands back whatever was growing on all four. The plumbing is no
   * longer the catch it was, either: since item 120 a pipe runs OVER farmland, so a piped head
   * or a Hub deep mid-field can be reached by a main laid straight across the rows.
   */
  readonly fieldPlaceable: boolean;
}

/** Condition runs 0..1000 so a "percent" readout has a decimal without needing a float. */
export const CONDITION_MAX = 1000;
/** Degradation effects start here — plan §4 puts them at 40 of 100. */
export const CONDITION_EFFECT_THRESHOLD = 400;
/** One hold-to-repair pulse. Hand repair is free and indestructible, forever (plan §3). */
export const REPAIR_PER_TOUCH = 100;
/**
 * A worn machine jams every Nth operation. Deterministic, not random: plan §4 rules out
 * random and time-based failures outright, because they break offline fairness. A jam is
 * a consequence of work done, and the counter is visible in the machine's op count.
 */
export const JAM_EVERY_N_OPERATIONS_WHEN_WORN = 10;

/**
 * A worn machine also spoils its input every Nth operation, and N shortens as it falls apart.
 *
 * "WASTE CHANCE" IS NOT A CHANCE. Plan §4 says a machine below 40 condition brings a "waste
 * chance", and plan §7 ruling 5 bans random and time-based failures outright; the only
 * reading that satisfies both is a **cadence**, exactly like the jam above. The period is a
 * straight-line function of condition, evaluated in `effectiveWastePeriod`:
 *
 *   period = AT_ZERO + floor((AT_THRESHOLD - AT_ZERO) × condition ÷ CONDITION_EFFECT_THRESHOLD)
 *
 * so a machine that has just crossed the threshold spoils one input in eight, and one held
 * at death's door spoils one in two. Integer arithmetic, no stream, no roll: the same seed
 * and the same commands waste the same potatoes on the same ticks forever.
 *
 * A machine at or above the threshold wastes nothing at all — this is a consequence of
 * neglect, never a tax on running a factory.
 */
export const WASTE_PERIOD_AT_THRESHOLD = 8;
export const WASTE_PERIOD_AT_ZERO = 2;

/**
 * How far a repair kit reaches, as a Chebyshev radius in tiles. Plan §4: "repair kits apply
 * in a small radius (one trip services a cell)." Three tiles is a 7×7 cell — big enough that
 * a hand-built chip line falls inside one, small enough that a factory needs more than one
 * trip, which is the entire point of the number.
 */
export const REPAIR_KIT_RADIUS_TILES = 3;

/**
 * One Maintenance Station service cycle: ten active seconds per kit application.
 *
 * The station consumes kits AT THE RATE A PLAYER WOULD (item 039 instruction 2): it fires only
 * when something in its cell is actually wrench-due — condition below
 * `CONDITION_EFFECT_THRESHOLD`, or jammed — never on a timer and never to top up a machine
 * that merely did some work. The cooldown is the arm resetting between applications, roughly
 * the walk-and-hold a hand service costs, so a cell that falls apart faster than a person
 * could kit it does not get super-human service either.
 */
export const STATION_SERVICE_PERIOD_TICKS = 200;

/**
 * The diagnostics window: 60 active seconds, plan §5's own number ("alerts only when money
 * bleeds >60s, phrased in cash"). `MachineView.bleedCentsLast60s` sums each machine's wasted
 * inputs over this many trailing ticks. Presentation cadence, not balance — it prices nothing
 * and is deliberately NOT folded into `BALANCE_HASH`.
 */
export const BLEED_WINDOW_TICKS = 60 * TICKS_PER_SECOND;

/**
 * How long a full output buffer stands still before one more unit of it overcooks.
 *
 * OVERCOOKING IS A LAYOUT CONDITION, NEVER A DIE ROLL (plan §7 ruling 5). A Fryer stops dead
 * when its output buffer fills — that is demand-pull, and it is the same stop that leaves a
 * Slicer visibly idle — but the basket it has already fried is still sitting in the oil. Chips
 * go rustic because the player built no belt off the Fryer, aimed the grabber somewhere else,
 * or wandered off with a full basket: causes you can see, standing in front of the machine.
 *
 * The arithmetic: the Fryer takes 60 ticks an operation (`workPerOperation ÷ workRatePerTick`),
 * so 600 ticks is ten cycles, or thirty active seconds of a machine that has not moved a chip.
 * One unit turns per interval rather than the whole basket, so a 20-chip Fryer takes ten
 * active minutes of total neglect to fully brown — the same "wants attention every ten
 * minutes" scale plan §4 tunes maintenance to. Any pull from the buffer resets the clock,
 * because a basket that moved is a basket out of the oil.
 */
export const OVERCOOK_BLOCKED_TICKS = 600;

export const SPRINKLER_PERIOD_TICKS = 5 * TICKS_PER_SECOND;
/** Chebyshev radius in tiles. A 5×5 patch, which is most of one 8×8 field's corner. */
export const SPRINKLER_RADIUS_TILES = 2;

/**
 * The barrel holds ten charges (owner ruling, 2026-08-15, item 086 — "the sprinklers should
 * have charges, ten charges, and they only should go watering if the tile needs it").
 *
 * A CHARGE IS A PROJECTION, NOT A SECOND COUNTER. The barrel's real state stays `tankMl`
 * under item 028's one-ledger law — millilitres counted where they leave the source — and the
 * view derives charges by division. Nothing stores a number that could drift from the ledger,
 * and `WorldState` still does not know the word "charge".
 *
 * SAVE COMPAT, same shape as the can's widening (item 073) in reverse: no format bump. A
 * barrel saved fuller than the new capacity simply loads over-full and refuses refills
 * (`room <= 0`) until honest watering drains it under the line — nothing is deleted, and the
 * charge readout reports the over-full truth rather than clamping to ten.
 */
export const SPRINKLER_CHARGES_MAX = 10;

/**
 * Waterable tiles under a barrel's patch: the whole 5×5 **minus its own occupied tile**, which
 * item 067 put permanently outside the watering surface. 24, and derived rather than typed, so
 * a change to the radius cannot leave this behind.
 */
export const SPRINKLER_PATCH_TILES =
  (SPRINKLER_RADIUS_TILES * 2 + 1) * (SPRINKLER_RADIUS_TILES * 2 + 1) - 1;

/**
 * WHAT ONE CHARGE COSTS THE BARREL, IN MILLILITRES — AND THE UNIT ITEM 097 REDEFINED.
 *
 * **Owner ruling, 2026-08-16 (item 097), verbatim:** *"when they spend a charge, they should
 * water everything in a 5x5, not just the single tiles like it's doing right now."* A charge is
 * an ACTIVATION, not a tile. Ten charges are ten full patches, and the barrel's fill is a
 * number a player can plan a walk around: "six more waterings", never "six more tiles".
 *
 * THE ARITHMETIC, OUT LOUD, BECAUSE THE HONESTY OF THE LEDGER RESTS ON IT. One activation
 * wets up to `SPRINKLER_PATCH_TILES` tiles at `SPRINKLER_POUR_ML` each, so the most a single
 * cycle can put into the ground is `24 × 1,500 = 36,000 ml`. That full-patch pour IS the
 * charge — the barrel is sized for the job it does, not for the best case of that job — and a
 * cycle pays it FLAT: an activation that found three thirsty tiles spends the same charge as
 * one that found twenty-four, and the runoff is the barrel-sprinkler's sloppiness, which is
 * exactly what the piped rungs above it are sold against. Capacity is then `10 × 36,000 =
 * 360,000 ml`, a 360-litre barrel against a 20,000-litre pond.
 *
 * ITEM 086'S 1,500 (one tile's pour) IS NOT A CHARGE ANY MORE. It survives as
 * `SPRINKLER_POUR_ML`, which is still what a *tile* takes — from the hand, from the piped
 * head, from the Hub. Only the barrel's unit moved.
 *
 * **AND THE LEDGER IS UNTOUCHED**: the barrel is still `machine.tankMl`, still filled by
 * `takeWater` at the shore, still the only place `stats.waterDrawnMl` moves. A charge remains
 * a projection *of* millilitres — `divFloor(tankMl, SPRINKLER_CHARGE_ML)` — rather than a
 * second stored integer, so there is nothing here that can drift out of step with item 028's
 * one ledger, and no save-format bump. See `advanceSprinkler` for the spend and the log on
 * work item 097 for why this beat storing charges outright.
 */
export const SPRINKLER_CHARGE_ML = SPRINKLER_PATCH_TILES * SPRINKLER_POUR_ML;

/**
 * Work rates are all 100/tick and durations are expressed in `workPerOperation`, so an
 * operation costs `workPerOperation / 100` ticks. The scale exists for the Speed dial: at a
 * base rate of 2, "+30%" floors straight back to 2 and the upgrade the player just paid for
 * does nothing. Two significant digits of headroom is the whole reason for the factor.
 */
export const WORK_RATE_SCALE = 100;

/**
 * THE RATIO IS THE LESSON (plan §5). Washer, Slicer, Seasoner, and Bagger each take 30
 * ticks per item; the Fryer takes 60. That is the canonical 1:1:2:1:1, and it means one
 * Fryer starves the two machines behind it while an idle Slicer sits there telling you why.
 * "Build a second Fryer" is meant to be every player's first ratio lesson — taught by a
 * visibly bored machine, never by a compost pile.
 */

/*
 * WEAR RATES ARE DERIVED, NOT GUESSED (item 034, plan §4). The tuning target is §4's
 * post-critique figure: *"a busy mid-game factory wants attention every ~10 minutes, not
 * every 60 seconds"*, where "wants attention" means the wrench lamp — condition crossing
 * `CONDITION_EFFECT_THRESHOLD` (400), i.e. 600 condition spent from full.
 *
 * The arithmetic. Ten minutes at 20 Hz is 12,000 ticks, so a machine running flat out
 * should spend its 600 condition over 12,000 ticks of work:
 *
 *   wearPerOperation = 600 × ticksPerOperation ÷ 12,000 = ticksPerOperation ÷ 20
 *
 * - 60-tick machines (the Fryer): 60 ÷ 20 = **3** → 200 ops × 60 ticks = 12,000
 *   ticks = 10.0 busy minutes from full to wrench-due. Exact.
 * - 30-tick machines: 30 ÷ 20 = 1.5, and condition is an integer, so the half rounds by
 *   duty: machines that heat, cut, grind, or pressurize (Slicer, Seasoner, Juicer, Kettle,
 *   Grinder, Syrup Mixer, Carbonator, Bottler) round UP to **2** — 300 ops = 9,000 ticks =
 *   7.5 busy minutes; machines that wash, fold, or pack (Washer, Bagger, Six-Packer, Combo
 *   Packer) round DOWN to **1** — 15 busy minutes. A mid-game line is therefore paced by
 *   its hot stages at 7.5–10 minutes, which is "roughly every ten" and nowhere near sixty
 *   seconds, and a repair kit re-syncs the whole cell so the cadence holds.
 * - The Chip Kitchen is the ONE deliberate departure: the time rule says 3, it carries
 *   **5**. The monolith condenses the whole line's wear (1+2+3+2+1 = 9 per bag) into one
 *   chassis and is §3's pre-belt training machine — it is *meant* to nag harder (≈6 busy
 *   minutes flat out; in practice longer, because a hand-fed kitchen is idle while its
 *   owner farms) than the line that replaces it.
 * - The Sprinkler wears **1 per pour** (one op = one `SPRINKLER_PERIOD_TICKS` watering):
 *   600 pours ≈ 50 active minutes to wrench-due. Farm infrastructure paces at a fifth of
 *   factory gear on purpose — walking the farm is already a chore loop, and §4's example
 *   of per-op fairness is Agri-Bot upkeep, not a second ten-minute clock over the crops.
 * - Trees, plumbing, storage, docks, carts, junctions: **0**. No work cycle, or ruled
 *   non-machinery where their spec says so.
 *
 * Wear is per OPERATION, never per second — plan §4 states that rule as absolute, and
 * `advanceConverter` applies it only on a completed operation.
 */
// --- the return leg (item 131) ---------------------------------------------------------
//
// **BOTTLES COME BACK.** A delivery leaves the lot with soda and the vehicle comes home with the
// empties, which a Washer turns back into bottles the Bottler can use again. The owner's ask in
// full: *"at a recycling center that takes used bottles, used bottles out of the depot once they
// come back from a delivery and turns them into clean bottles to be used by the bottler."*
//
// **ALL OF THEM COME BACK — THE WASHING IS THE COST, NOT ATTRITION.** Item 131 leaned this way
// and the 2026-08-17 sandbox ruling settles it: reward attention rather than punish absence. A
// fraction would have been arithmetic nobody asked for, and a percentage that quietly eats
// bottles is a tax the player cannot watch being levied.
//
// **THEY LAND IN THE VEHICLE'S OWN OUTPUT BASKET, WHICH IS "THE DEPOT'S FLOOR" IN THIS FILE'S OWN
// VOCABULARY.** The basket is a door a grabber already opens, a hand already unloads, net worth
// already invoices, and `applyDeconstructMachine` already hands back — so the return leg needed
// no new field on `Machine`, no new save field, and no migration at all. A dedicated
// `returnedCount` pair would have been a second output buffer with its own doors to keep in step
// with the first, which is the shape this file refuses everywhere else.
//
// What it costs instead is one honest widening at two gates. `grabberSource` and
// `applyUnloadMachine` both bailed on `spec.outputItem === null`, a check that reads "this
// machine makes nothing" and MEANT "this machine's basket has no name". A basket has named
// itself since item 111 (`machine.outputItem`), so both now ask `nextOutputItem` — which returns
// null for exactly the machines the old check excluded and a name for the one case it wrongly
// excluded too. The same sentence, spelled so it is true of a vehicle.
//
// It also keeps the loop PHYSICAL, which is the half the ask is really about: the empties come
// home to the far side of the lot next to the road, and getting them to a Washer is a belt, an
// arm, or a walk. A refund straight into the player's bag would have been the same money with
// the game taken out of it.

/**
 * How many empties one delivered unit comes home as, by product.
 *
 * **A TABLE RATHER THAN A FIELD ON `ITEM_SPECS`**, on `MACHINE_RECIPES`' precedent and for its
 * reason: three goods in a roster of forty-five contain a bottle, and a `bottlesPerUnit: 0` on
 * the other forty-two would ask every future good a question it does not have.
 *
 * The counts are the bottles that actually went out, read straight off the recipes that built
 * each product: a Soda is one `ItemId.Bottle` (see the Bottler), a Six-Pack is `SIX_PACK_COUNT`
 * sodas, and a Snack Combo is a bag of chips and one soda. Nothing here is invented — every
 * number is a bottle the player bought and shipped. `test/factory.test.ts` holds it to that.
 *
 * `returnsItem` is spelled out rather than hard-coded in the reader so the mint lands on the
 * goods census: a data path that names a good has to say what it does to goods
 * (`DATA_IDENTITY_VERDICTS`), and this one MINTS while `item` is a LOOKUP key. Hidden inside a
 * function, the mint would have been invisible to `dataItemFields()`.
 */
export interface EmptiesRow {
  /** The delivered good. A row key — nothing here re-labels it. */
  readonly item: ItemId;
  /** What comes back in its place. */
  readonly returnsItem: ItemId;
  /** How many, per delivered unit. */
  readonly count: number;
}

export const EMPTIES_PER_DELIVERY: readonly EmptiesRow[] = [
  { item: ItemId.Soda, returnsItem: ItemId.UsedBottle, count: 1 },
  { item: ItemId.SixPack, returnsItem: ItemId.UsedBottle, count: SIX_PACK_COUNT },
  { item: ItemId.SnackCombo, returnsItem: ItemId.UsedBottle, count: 1 },
];

/**
 * What comes home when `count` of `item` are delivered, or null for the forty-two goods that
 * return nothing. **The one reader of `EMPTIES_PER_DELIVERY`.**
 */
export function emptiesForDelivery(
  item: ItemId,
  count: number,
): { item: ItemId; count: number } | null {
  if (count <= 0) return null;
  for (let i = 0; i < EMPTIES_PER_DELIVERY.length; i++) {
    const row = EMPTIES_PER_DELIVERY[i]!;
    if (row.item === item) return { item: row.returnsItem, count: row.count * count };
  }
  return null;
}

/**
 * How many empties a vehicle holds before somebody has to come and get them.
 *
 * **ONE CART-LOAD OF SIX-PACKS**, which is the largest single return the assisted rung can
 * generate: `CART_CAPACITY × SIX_PACK_COUNT`, 20 × 6. It is a literal rather than that product
 * because `CART_CAPACITY` is declared *below* `MACHINE_SPECS` and a spec cannot read a constant
 * that has not been evaluated yet — so `test/factory.test.ts` pins the identity instead, and the
 * two cannot drift without a red test saying so.
 *
 * **AN OVERFULL BASKET MINTS FEWER EMPTIES. IT NEVER STALLS THE VEHICLE, AND IT NEVER DESTROYS
 * ANYTHING.** Both halves are load-bearing.
 *
 * The first half is what protects every save already on disk. The obvious alternative — refuse to
 * dispatch while the basket is full — puts a brand-new stall in the middle of the one ladder
 * whose entire selling point is that you stop touching it, and it would freeze a standing route
 * on a lot whose owner has never heard of recycling. A depot running 100 six-packs a trip would
 * need room for 600 empties before it was allowed to leave. That is a feature holding a feature
 * hostage.
 *
 * The second half is why a cap is not a plan §4 violation, and the distinction is exact:
 * **nothing that exists is deleted, because the empties do not exist yet.** Those bottles left the
 * lot inside the soda and were paid for at the till. This is a SOURCE, and a source that mints
 * less has minted less — `advanceCart` and `advanceContract` are its only two callers and both
 * put every unit they mint into the basket, so there is no path on which a unit is created and
 * then dropped. Contrast a cart's *cargo*, which is goods the player owns, and which
 * `applyDeconstructMachine` therefore hands back to the last bottle.
 *
 * So the rule a player learns is "keep it drained and you get all of them" — the sandbox ruling's
 * shape exactly: attention rewarded, absence not punished.
 */
export const VEHICLE_EMPTIES_CAPACITY = 120;

/**
 * **WHAT THE ROOT CELLAR SELLS NOW THAT NOTHING SPOILS** (item 124 — flagged for the owner as a
 * decision, not presented as settled).
 *
 * The cellar's entire pitch was §4's *"frozen in a Root Cellar"*: it was the only container in
 * the game whose clock ran at zero. Item 124 deleted every clock, which left a $250 four-tile
 * machine, gated behind an Agronomy node, selling a property that dirt now has. Deleting it was
 * the alternative and it is worse — a player who saved up for one would open the game and find
 * it gone — so it keeps its price and takes a new job.
 *
 * Five hundred, against the hundred it used to hold and the hand cart's twenty-four. The
 * multiple is chosen so the sentence *"the one place to put a harvest you cannot process yet"*
 * stays true of it and only it: twenty carts' worth in four tiles, which no amount of barrows
 * reproduces. It is not derived from anything, and it is a number the owner should feel free to
 * move — that is what makes it a constant here rather than a literal in the spec row.
 */
export const ROOT_CELLAR_CAPACITY = 500;

export const MACHINE_SPECS: readonly MachineSpec[] = [
  {
    kind: MachineKind.SellBin,
    slug: 'sell-bin',
    role: MachineRole.Inert,
    tilesWide: 1,
    tilesHigh: 1,
    priceCents: 0,
    workPerOperation: 0,
    workRatePerTick: 0,
    inputCapacity: 0,
    outputCapacity: 0,
    tankCapacityMl: 0,
    wearPerOperation: 0,
    inputs: [],
    outputItem: null,
    overcookOutputItem: null,
    requiresTech: null,
    liquid: LiquidId.None,
    ports: [],
    pumpRateMlPerMinute: 0,
    intakeMlPerTick: 0,
    coverageRadiusTiles: 0,
    moistureSensing: false,
    fieldPlaceable: false,
  },
  {
    // The v0.1 monolith, kept buildable forever. It is strictly worse than the line — one
    // bag per 60 ticks against the line's one per 30 — but it needs no belts, no grabbers,
    // and no research, so it stays the honest early-game answer and every v0.1 save that
    // has one keeps working.
    kind: MachineKind.ChipKitchen,
    slug: 'chip-kitchen',
    role: MachineRole.Converter,
    tilesWide: 2,
    tilesHigh: 2,
    priceCents: 10_000,
    workPerOperation: 60 * WORK_RATE_SCALE,
    workRatePerTick: WORK_RATE_SCALE,
    inputCapacity: 20,
    outputCapacity: 20,
    tankCapacityMl: 0,
    /** Deliberately above the time rule's 3 — the monolith nags; see the wear derivation. */
    wearPerOperation: 5,
    inputs: [{ item: ItemId.RussetPotato, count: 1 }],
    outputItem: ItemId.BaggedChips,
    overcookOutputItem: null,
    requiresTech: null,
    liquid: LiquidId.None,
    ports: [],
    pumpRateMlPerMinute: 0,
    intakeMlPerTick: 0,
    coverageRadiusTiles: 0,
    moistureSensing: false,
    fieldPlaceable: false,
  },
  {
    // The $150 sprinkler of plan §7 — the whole v0.1 design gate. You fill its barrel by
    // can; piped sprinklers arrive at v0.4.
    kind: MachineKind.Sprinkler,
    slug: 'sprinkler',
    role: MachineRole.Sprinkler,
    tilesWide: 1,
    tilesHigh: 1,
    priceCents: 15_000,
    workPerOperation: 0,
    workRatePerTick: 0,
    inputCapacity: 0,
    outputCapacity: 0,
    /**
     * Ten charges' worth, and not one drop of head-room (item 086's owner ruling; see
     * `SPRINKLER_CHARGES_MAX`), where a charge is one whole-patch ACTIVATION (item 097; see
     * `SPRINKLER_CHARGE_ML`). 360,000 ml.
     *
     * THE 36,000 ML THIS USED TO BE IS NOW THE SIZE OF ONE CHARGE, and that is not a
     * coincidence — it is the same number arrived at the same way. It was one full mid-field
     * cycle, 24 croppable neighbours at `SPRINKLER_POUR_ML` each, sized so a barrel could
     * never run dry partway across a top-left scan and starve its back row. Item 086 shrank
     * the barrel to ten single-tile pours and the starvation arrived within the hour — the
     * owner saw it in play as *"only watering in front of them"* — and was answered with a
     * resuming scan cursor. Item 097 answers it at the root instead: a cycle it can afford is
     * a cycle it can FINISH, so a barrel can no longer stop mid-patch and there is no back
     * row to starve. The cursor is gone from this head with the problem it solved.
     *
     * Read `advanceSprinkler` before changing this number.
     */
    tankCapacityMl: SPRINKLER_CHARGES_MAX * SPRINKLER_CHARGE_ML,
    wearPerOperation: 1,
    inputs: [],
    outputItem: null,
    overcookOutputItem: null,
    requiresTech: null,
    liquid: LiquidId.None,
    ports: [],
    pumpRateMlPerMinute: 0,
    intakeMlPerTick: 0,
    coverageRadiusTiles: SPRINKLER_RADIUS_TILES,
    /**
     * On since item 086 — the owner's "only water if the tile needs it" ends the barrel's
     * sloppiness tax the way item 081 ended the hand's. The PIPED dumb head below keeps
     * `false`: its water is ledger-fed and its inefficiency is what the Hub is sold on.
     */
    moistureSensing: true,
    fieldPlaceable: true,
  },
  {
    kind: MachineKind.Washer,
    slug: 'washer',
    role: MachineRole.Converter,
    tilesWide: 2,
    tilesHigh: 2,
    priceCents: 6_000,
    workPerOperation: 30 * WORK_RATE_SCALE,
    workRatePerTick: WORK_RATE_SCALE,
    inputCapacity: 20,
    outputCapacity: 20,
    tankCapacityMl: 0,
    wearPerOperation: 1,
    inputs: [{ item: ItemId.RussetPotato, count: 1 }],
    outputItem: ItemId.WashedPotato,
    overcookOutputItem: null,
    requiresTech: TechId.WashAndSlice,
    liquid: LiquidId.None,
    ports: [],
    pumpRateMlPerMinute: 0,
    intakeMlPerTick: 0,
    coverageRadiusTiles: 0,
    moistureSensing: false,
    fieldPlaceable: false,
  },
  {
    kind: MachineKind.Slicer,
    slug: 'slicer',
    role: MachineRole.Converter,
    tilesWide: 2,
    tilesHigh: 2,
    priceCents: 8_000,
    workPerOperation: 30 * WORK_RATE_SCALE,
    workRatePerTick: WORK_RATE_SCALE,
    inputCapacity: 20,
    outputCapacity: 20,
    tankCapacityMl: 0,
    wearPerOperation: 2,
    inputs: [{ item: ItemId.WashedPotato, count: 1 }],
    outputItem: ItemId.PotatoSlices,
    overcookOutputItem: null,
    requiresTech: TechId.WashAndSlice,
    liquid: LiquidId.None,
    ports: [],
    pumpRateMlPerMinute: 0,
    intakeMlPerTick: 0,
    coverageRadiusTiles: 0,
    moistureSensing: false,
    fieldPlaceable: false,
  },
  {
    // Half the throughput of everything around it. On purpose. Do not "fix" this.
    kind: MachineKind.Fryer,
    slug: 'fryer',
    role: MachineRole.Converter,
    tilesWide: 2,
    tilesHigh: 2,
    priceCents: 15_000,
    workPerOperation: 60 * WORK_RATE_SCALE,
    workRatePerTick: WORK_RATE_SCALE,
    inputCapacity: 20,
    outputCapacity: 20,
    tankCapacityMl: 0,
    wearPerOperation: 3,
    inputs: [{ item: ItemId.PotatoSlices, count: 1 }],
    outputItem: ItemId.PlainChips,
    // The only machine in the game whose output spoils, and only when the player's layout
    // leaves it nowhere to go. See `OVERCOOK_BLOCKED_TICKS`.
    overcookOutputItem: ItemId.RusticStyleChips,
    requiresTech: TechId.Fryer,
    liquid: LiquidId.None,
    ports: [],
    pumpRateMlPerMinute: 0,
    intakeMlPerTick: 0,
    coverageRadiusTiles: 0,
    moistureSensing: false,
    fieldPlaceable: false,
  },
  {
    kind: MachineKind.Seasoner,
    slug: 'seasoner',
    role: MachineRole.Converter,
    tilesWide: 2,
    tilesHigh: 2,
    priceCents: 9_000,
    workPerOperation: 30 * WORK_RATE_SCALE,
    workRatePerTick: WORK_RATE_SCALE,
    inputCapacity: 20,
    outputCapacity: 20,
    tankCapacityMl: 0,
    wearPerOperation: 2,
    inputs: [{ item: ItemId.PlainChips, count: 1 }],
    outputItem: ItemId.SeasonedChips,
    overcookOutputItem: null,
    requiresTech: TechId.Finishing,
    liquid: LiquidId.None,
    ports: [],
    pumpRateMlPerMinute: 0,
    intakeMlPerTick: 0,
    coverageRadiusTiles: 0,
    moistureSensing: false,
    fieldPlaceable: false,
  },
  {
    kind: MachineKind.Bagger,
    slug: 'bagger',
    role: MachineRole.Converter,
    tilesWide: 2,
    tilesHigh: 2,
    priceCents: 12_000,
    workPerOperation: 30 * WORK_RATE_SCALE,
    workRatePerTick: WORK_RATE_SCALE,
    inputCapacity: 20,
    outputCapacity: 20,
    tankCapacityMl: 0,
    wearPerOperation: 1,
    inputs: [{ item: ItemId.SeasonedChips, count: 1 }],
    outputItem: ItemId.BaggedChips,
    overcookOutputItem: null,
    requiresTech: TechId.Finishing,
    liquid: LiquidId.None,
    ports: [],
    pumpRateMlPerMinute: 0,
    intakeMlPerTick: 0,
    coverageRadiusTiles: 0,
    moistureSensing: false,
    fieldPlaceable: false,
  },
  {
    // The one thing on a network that MAKES water. Plan §5 allows exactly one per network,
    // and that single rule is what keeps the ledger a division instead of a solver.
    kind: MachineKind.Pump,
    slug: 'pump',
    role: MachineRole.Pump,
    tilesWide: 1,
    tilesHigh: 1,
    priceCents: 20_000,
    workPerOperation: 0,
    workRatePerTick: 0,
    inputCapacity: 0,
    outputCapacity: 0,
    tankCapacityMl: 0,
    wearPerOperation: 0,
    inputs: [],
    outputItem: null,
    overcookOutputItem: null,
    requiresTech: TechId.Pumps,
    liquid: LiquidId.Water,
    ports: [],
    pumpRateMlPerMinute: PUMP_RATE_ML_PER_MINUTE,
    intakeMlPerTick: 0,
    coverageRadiusTiles: 0,
    moistureSensing: false,
    fieldPlaceable: false,
  },
  {
    // A buffer, and the only object in the game that shows a NET RATE and a TIME-TO-EMPTY
    // (plan §5). That label is the whole reason tanks exist: it turns "am I short of water"
    // from a feeling into arithmetic the player can do at a glance.
    kind: MachineKind.Tank,
    slug: 'tank',
    role: MachineRole.Tank,
    tilesWide: 2,
    tilesHigh: 2,
    priceCents: 25_000,
    workPerOperation: 0,
    workRatePerTick: 0,
    inputCapacity: 0,
    outputCapacity: 0,
    /** 1,000 L — about a hundred seconds of a pump at full tilt. */
    tankCapacityMl: 1_000_000,
    wearPerOperation: 0,
    inputs: [],
    outputItem: null,
    overcookOutputItem: null,
    requiresTech: TechId.Pumps,
    liquid: LiquidId.Water,
    ports: [],
    pumpRateMlPerMinute: 0,
    /** A tank fills fast enough to soak up a whole pump's surplus and no faster. */
    intakeMlPerTick: 600,
    coverageRadiusTiles: 0,
    moistureSensing: false,
    fieldPlaceable: false,
  },
  {
    // THE TOP RUNG OF PLAN §3'S WATERING LADDER, and deliberately no better at watering than
    // the barrel it replaces: same pour, same period, same radius, AND SINCE ITEM 128 THE SAME
    // UNIT — one activation buys the whole patch, up front. The only thing it buys is that you
    // never fill it again. An automated tier that also waters *better* would make the lower
    // rungs rot, and plan §1 says manual never rots; item 097 moved the barrel to a whole-patch
    // charge and left this head paying per tile, which made the AUTOMATED rung the sloppier of
    // the two — a head on a network that could not keep its buffer full watered a handful of
    // tiles and abandoned the rest mid-sweep. Charged is parity, not superiority.
    kind: MachineKind.PipedSprinkler,
    slug: 'piped-sprinkler',
    role: MachineRole.PipedSprinkler,
    tilesWide: 1,
    tilesHigh: 1,
    priceCents: 25_000,
    workPerOperation: 0,
    workRatePerTick: 0,
    inputCapacity: 0,
    outputCapacity: 0,
    /**
     * TWO WHOLE-PATCH CHARGES: one to spend now and one in hand, so a brief throttle does not
     * stop the cycle dead. 72,000 ml.
     *
     * **THE OLD NUMBER WAS 15,000 AND THE OLD COMMENT SAID "ten pours of head-room"** — both
     * true of a head that paid `SPRINKLER_POUR_ML` per tile, and both dead the moment item 128
     * made the unit a whole patch. Left alone, 15,000 would have been less than HALF of one
     * charge, and the head would have sat at a full buffer it could never afford to spend: a
     * machine silently retired by a comment nobody re-read. Derived from `SPRINKLER_CHARGE_ML`
     * rather than typed, so the next change to the unit cannot leave it behind again.
     */
    tankCapacityMl: 2 * SPRINKLER_CHARGE_ML,
    wearPerOperation: 0,
    inputs: [],
    outputItem: null,
    overcookOutputItem: null,
    requiresTech: TechId.PipedSprinklers,
    liquid: LiquidId.Water,
    ports: [],
    pumpRateMlPerMinute: 0,
    /**
     * 400 ml/tick — a touch over the ~356 it averages (`SPRINKLER_CHARGE_ML` every 101 ticks,
     * which is the cycle: a head sets its own cooldown on the tick it fires), so it stays topped
     * up when it can. UNCHANGED BY ITEM 128, and that is arithmetic rather than luck: the head's
     * long-run draw over a full patch is the same 24 pours it always was, moved from twenty-four
     * small payments to one large one. What the rate has to cover now is a charge between two
     * cycles — 400 × 101 = 40,400 against 36,000 — which it does with room to spare.
     */
    intakeMlPerTick: 400,
    coverageRadiusTiles: SPRINKLER_RADIUS_TILES,
    moistureSensing: false,
    fieldPlaceable: true,
  },
  {
    // "Moisture-sensing heads water only dry tiles" (plan §4). It covers nine times the area
    // of a head and, on a field that is mostly wet, draws a small fraction of the water —
    // which is the entire promotion, and it shows up on the Dry County board rather than in
    // a tooltip.
    kind: MachineKind.IrrigationHub,
    slug: 'irrigation-hub',
    role: MachineRole.PipedSprinkler,
    tilesWide: 2,
    tilesHigh: 2,
    priceCents: 90_000,
    workPerOperation: 0,
    workRatePerTick: 0,
    inputCapacity: 0,
    outputCapacity: 0,
    tankCapacityMl: 60_000,
    wearPerOperation: 0,
    inputs: [],
    outputItem: null,
    overcookOutputItem: null,
    requiresTech: TechId.IrrigationHub,
    liquid: LiquidId.Water,
    ports: [],
    pumpRateMlPerMinute: 0,
    intakeMlPerTick: 800,
    coverageRadiusTiles: IRRIGATION_HUB_RADIUS_TILES,
    moistureSensing: true,
    fieldPlaceable: true,
  },
  {
    // Reclaims Washer graywater — plan §4. IT FEEDS A TANK, NOT A NETWORK, and that is not a
    // bug: plan §5 allows exactly ONE PUMP PER NETWORK, so a second source injecting straight
    // into the pipes would break the rule that makes the ledger comprehensible. Pouring into
    // a tank is the sanctioned way to add a source, and it is the cleanest possible teaching
    // example of why the rule exists. Put a Recirculator beside a Washer and a Tank.
    kind: MachineKind.Recirculator,
    slug: 'recirculator',
    role: MachineRole.Recirculator,
    tilesWide: 1,
    tilesHigh: 1,
    priceCents: 30_000,
    workPerOperation: 0,
    workRatePerTick: 0,
    inputCapacity: 0,
    outputCapacity: 0,
    tankCapacityMl: 0,
    wearPerOperation: 0,
    inputs: [],
    outputItem: null,
    overcookOutputItem: null,
    requiresTech: TechId.Recirculator,
    liquid: LiquidId.Water,
    ports: [],
    pumpRateMlPerMinute: 0,
    intakeMlPerTick: 0,
    coverageRadiusTiles: 0,
    moistureSensing: false,
    fieldPlaceable: false,
  },

  // --- the soda line (plan §5's pipe organ) ---------------------------------------------
  //
  // THE RATIO IS AGAIN THE LESSON, AND IT IS A DIFFERENT LESSON. The chip line teaches 1:1:2:1:1
  // with a visibly bored Slicer; the soda line teaches that a ratio can be a *volume* — the
  // Bottler eats exactly what one Mixer and one Carbonator make, so the three run 1:1:1 in
  // lockstep, and a player who builds a second Bottler sees the pipes go amber rather than a
  // machine go idle. Upstream the numbers are 1:1:2 (juicer : kettle : mixer), which falls out
  // of one cane making two bottles' worth of syrup rather than being tuned in afterwards.
  //
  // The whole chain, in one place:
  //
  //   1 Sugar Cane        → Juicer     → 1000 ml cane juice
  //   1000 ml cane juice  → Kettle     →  250 ml simple syrup   (a reduction — hence the boil)
  //   1 Kola Nut          → Grinder    → 1 Kola Powder
  //   125 ml simple syrup + 125 ml water + 1 Kola Powder
  //                       → SyrupMixer →  250 ml soda syrup
  //   750 ml water        → Carbonator →  750 ml carbonated water
  //   250 ml soda syrup + 750 ml carbonated water + 1 Bottle
  //                       → Bottler    → 1 Soda ($16)
  //
  // so one cane is two bottles, and a bottle costs 125¢ of cane plus 220¢ of powder plus 120¢
  // of bottle against a $16 list. Chips still clear more per machine-second, which is plan §3's
  // "chips lead soda by half an era" holding on its own; the Snack Combo is what stops that
  // from making the chip line the only line worth running.
  {
    kind: MachineKind.Juicer,
    slug: 'juicer',
    role: MachineRole.Converter,
    tilesWide: 2,
    tilesHigh: 2,
    priceCents: 20_000,
    workPerOperation: 30 * WORK_RATE_SCALE,
    workRatePerTick: WORK_RATE_SCALE,
    inputCapacity: 20,
    outputCapacity: 0,
    tankCapacityMl: 0,
    wearPerOperation: 2,
    inputs: [{ item: ItemId.SugarCane, count: 1 }],
    outputItem: null,
    overcookOutputItem: null,
    requiresTech: TechId.SodaPress,
    liquid: LiquidId.CaneJuice,
    // Four operations of head-room in the outlet, so a briefly starved Kettle downstream does
    // not stop the press dead — and once the outlet IS full, demand-pull stops the press
    // exactly the way a full output buffer stops a Fryer. There is one stop rule, not a
    // second one for liquids.
    ports: [
      {
        liquid: LiquidId.CaneJuice,
        flow: PortFlow.Outlet,
        capacityMl: 4_000,
        intakeMlPerTick: 0,
        mlPerOperation: 1_000,
      },
    ],
    pumpRateMlPerMinute: 0,
    intakeMlPerTick: 0,
    coverageRadiusTiles: 0,
    moistureSensing: false,
    fieldPlaceable: false,
  },
  {
    kind: MachineKind.Kettle,
    slug: 'kettle',
    role: MachineRole.Converter,
    tilesWide: 2,
    tilesHigh: 2,
    priceCents: 22_000,
    workPerOperation: 30 * WORK_RATE_SCALE,
    workRatePerTick: WORK_RATE_SCALE,
    inputCapacity: 0,
    outputCapacity: 0,
    tankCapacityMl: 0,
    /** The hottest thing on the soda side, so its 1.5 rounds UP (see the wear derivation). */
    wearPerOperation: 2,
    inputs: [],
    outputItem: null,
    overcookOutputItem: null,
    requiresTech: TechId.SodaPress,
    liquid: LiquidId.CaneJuice,
    ports: [
      {
        liquid: LiquidId.CaneJuice,
        flow: PortFlow.Intake,
        capacityMl: 4_000,
        intakeMlPerTick: 200,
        mlPerOperation: 1_000,
      },
      {
        liquid: LiquidId.SimpleSyrup,
        flow: PortFlow.Outlet,
        capacityMl: 2_000,
        intakeMlPerTick: 0,
        mlPerOperation: 250,
      },
    ],
    pumpRateMlPerMinute: 0,
    intakeMlPerTick: 0,
    coverageRadiusTiles: 0,
    moistureSensing: false,
    fieldPlaceable: false,
  },
  {
    // §5: "flavors are powders". The grinder is the crafted rung of §4's consumable ladder —
    // the bought rung is the nut itself, because the crop roster is shut at eight.
    kind: MachineKind.Grinder,
    slug: 'grinder',
    role: MachineRole.Converter,
    tilesWide: 2,
    tilesHigh: 2,
    priceCents: 12_000,
    workPerOperation: 30 * WORK_RATE_SCALE,
    workRatePerTick: WORK_RATE_SCALE,
    inputCapacity: 20,
    outputCapacity: 20,
    tankCapacityMl: 0,
    wearPerOperation: 2,
    inputs: [{ item: ItemId.KolaNut, count: 1 }],
    outputItem: ItemId.KolaPowder,
    overcookOutputItem: null,
    requiresTech: TechId.SodaPress,
    liquid: LiquidId.None,
    ports: [],
    pumpRateMlPerMinute: 0,
    intakeMlPerTick: 0,
    coverageRadiusTiles: 0,
    moistureSensing: false,
    fieldPlaceable: false,
  },
  {
    // PLAN §5'S CENTREPIECE: "the Syrup Mixer (2 pipe inlets + 1 belt inlet) is the one machine
    // where the two layers visibly cooperate, and the soda mid-game's puzzle centerpiece."
    //
    // It is not an exception to the separation between belts and pipes — it is that separation
    // stated at its strongest. Three typed ports, two liquid and one solid, and a pipe carrying
    // anything but simple syrup or water is refused AT THE PORT rather than quietly mixed in.
    kind: MachineKind.SyrupMixer,
    slug: 'syrup-mixer',
    role: MachineRole.Converter,
    tilesWide: 2,
    tilesHigh: 2,
    priceCents: 30_000,
    workPerOperation: 30 * WORK_RATE_SCALE,
    workRatePerTick: WORK_RATE_SCALE,
    inputCapacity: 20,
    outputCapacity: 0,
    tankCapacityMl: 0,
    wearPerOperation: 2,
    inputs: [{ item: ItemId.KolaPowder, count: 1 }],
    outputItem: null,
    overcookOutputItem: null,
    requiresTech: TechId.SodaMixing,
    liquid: LiquidId.SimpleSyrup,
    ports: [
      {
        liquid: LiquidId.SimpleSyrup,
        flow: PortFlow.Intake,
        capacityMl: 2_000,
        intakeMlPerTick: 100,
        mlPerOperation: 125,
      },
      {
        liquid: LiquidId.Water,
        flow: PortFlow.Intake,
        capacityMl: 2_000,
        intakeMlPerTick: 100,
        mlPerOperation: 125,
      },
      {
        liquid: LiquidId.SodaSyrup,
        flow: PortFlow.Outlet,
        capacityMl: 2_000,
        intakeMlPerTick: 0,
        mlPerOperation: 250,
      },
    ],
    pumpRateMlPerMinute: 0,
    intakeMlPerTick: 0,
    coverageRadiusTiles: 0,
    moistureSensing: false,
    fieldPlaceable: false,
  },
  {
    // Plan §4 rules out a power system outright, so carbonation costs consumables and wear and
    // never energy. What it does cost is WATER, from the same pond the sprinklers drink — which
    // is why a soda wing shows up on plan §6's Dry County board rather than on a meter.
    kind: MachineKind.Carbonator,
    slug: 'carbonator',
    role: MachineRole.Converter,
    tilesWide: 2,
    tilesHigh: 2,
    priceCents: 25_000,
    workPerOperation: 30 * WORK_RATE_SCALE,
    workRatePerTick: WORK_RATE_SCALE,
    inputCapacity: 0,
    outputCapacity: 0,
    tankCapacityMl: 0,
    wearPerOperation: 2,
    inputs: [],
    outputItem: null,
    overcookOutputItem: null,
    requiresTech: TechId.SodaMixing,
    liquid: LiquidId.Water,
    ports: [
      {
        liquid: LiquidId.Water,
        flow: PortFlow.Intake,
        capacityMl: 3_000,
        intakeMlPerTick: 300,
        mlPerOperation: 750,
      },
      {
        liquid: LiquidId.CarbonatedWater,
        flow: PortFlow.Outlet,
        capacityMl: 3_000,
        intakeMlPerTick: 0,
        mlPerOperation: 750,
      },
    ],
    pumpRateMlPerMinute: 0,
    intakeMlPerTick: 0,
    coverageRadiusTiles: 0,
    moistureSensing: false,
    fieldPlaceable: false,
  },
  {
    // §5: "machines mostly 2×2 (Bottler 3×2 flagship)". The only machine wider than it is tall,
    // and the only one that takes two liquids and a solid and hands back something sellable.
    kind: MachineKind.Bottler,
    slug: 'bottler',
    role: MachineRole.Converter,
    tilesWide: 3,
    tilesHigh: 2,
    priceCents: 40_000,
    workPerOperation: 30 * WORK_RATE_SCALE,
    workRatePerTick: WORK_RATE_SCALE,
    inputCapacity: 20,
    outputCapacity: 20,
    tankCapacityMl: 0,
    wearPerOperation: 2,
    inputs: [{ item: ItemId.Bottle, count: 1 }],
    outputItem: ItemId.Soda,
    overcookOutputItem: null,
    requiresTech: TechId.SodaMixing,
    liquid: LiquidId.SodaSyrup,
    ports: [
      {
        liquid: LiquidId.SodaSyrup,
        flow: PortFlow.Intake,
        capacityMl: 2_000,
        intakeMlPerTick: 100,
        mlPerOperation: 250,
      },
      {
        liquid: LiquidId.CarbonatedWater,
        flow: PortFlow.Intake,
        capacityMl: 3_000,
        intakeMlPerTick: 300,
        mlPerOperation: 750,
      },
    ],
    pumpRateMlPerMinute: 0,
    intakeMlPerTick: 0,
    coverageRadiusTiles: 0,
    moistureSensing: false,
    fieldPlaceable: false,
  },
  {
    // The two bundle machines exist to answer plan §8's release gate with arithmetic instead of
    // an opinion. Both are ordinary converters; the only thing that makes them worth building is
    // the price of what comes out, and both of those prices are derived from their parts.
    kind: MachineKind.SixPacker,
    slug: 'six-packer',
    role: MachineRole.Converter,
    tilesWide: 2,
    tilesHigh: 2,
    priceCents: 15_000,
    workPerOperation: 30 * WORK_RATE_SCALE,
    workRatePerTick: WORK_RATE_SCALE,
    /** Six sodas an operation, so twenty-four slots is four operations, not twenty. */
    inputCapacity: 24,
    outputCapacity: 20,
    tankCapacityMl: 0,
    wearPerOperation: 1,
    inputs: [{ item: ItemId.Soda, count: SIX_PACK_COUNT }],
    outputItem: ItemId.SixPack,
    overcookOutputItem: null,
    requiresTech: TechId.Bundles,
    liquid: LiquidId.None,
    ports: [],
    pumpRateMlPerMinute: 0,
    intakeMlPerTick: 0,
    coverageRadiusTiles: 0,
    moistureSensing: false,
    fieldPlaceable: false,
  },
  {
    // THE ONE TRUE TWO-INGREDIENT RECIPE IN THE GAME, and the reason a recipe is a list rather
    // than a field: one bag of chips from one district, one bottle from the other.
    kind: MachineKind.ComboPacker,
    slug: 'combo-packer',
    role: MachineRole.Converter,
    tilesWide: 2,
    tilesHigh: 2,
    priceCents: 18_000,
    workPerOperation: 30 * WORK_RATE_SCALE,
    workRatePerTick: WORK_RATE_SCALE,
    inputCapacity: 20,
    outputCapacity: 20,
    tankCapacityMl: 0,
    wearPerOperation: 1,
    inputs: [
      { item: ItemId.BaggedChips, count: 1 },
      { item: ItemId.Soda, count: 1 },
    ],
    outputItem: ItemId.SnackCombo,
    overcookOutputItem: null,
    requiresTech: TechId.Bundles,
    liquid: LiquidId.None,
    ports: [],
    pumpRateMlPerMinute: 0,
    intakeMlPerTick: 0,
    coverageRadiusTiles: 0,
    moistureSensing: false,
    fieldPlaceable: false,
  },
  {
    // The assisted rung of plan §3's selling ladder, and priced exactly where the barrel
    // sprinkler sits on the watering one: **$100, and no research at all**. That parallel is the
    // argument. The can is free forever and the $150 sprinkler is the first thing that does a
    // chore for you without a tech tree in the way; the bin is free forever and this is the same
    // step for selling. A cart behind a research gate would leave the middle rung of the ladder
    // empty for the whole of era 1, which is precisely the stretch it exists to soften.
    //
    // It has no work cycle, so it never wears and never takes a dial: `wearPerOperation` is 0
    // rather than 1 because a cart completes no operations — `advanceCommerce` counts ticks, not
    // work-points — and a 1 there would be a number nothing could ever read.
    kind: MachineKind.DeliveryCart,
    slug: 'delivery-cart',
    role: MachineRole.DeliveryCart,
    tilesWide: 1,
    tilesHigh: 1,
    priceCents: 10_000,
    workPerOperation: 0,
    workRatePerTick: 0,
    // Its cargo hold is `CART_CAPACITY`, not `inputCapacity`: a cart holds ONE product per run
    // in `machine.cargoItem`/`cargoCount`, which is a different shape from a recipe's parallel
    // per-line buffers. Leaving this at zero keeps `effectiveInputCapacity` from ever being
    // asked a question about a vehicle.
    inputCapacity: 0,
    // **THE BASKET IS THE RETURN SHELF** (item 131) — where the empties from a completed run are
    // put down. It was 0, which said "a cart makes nothing" and was read everywhere as "a cart's
    // basket cannot be looked into". The cart still makes nothing (`outputItem` below is null and
    // stays null); what it now has is somewhere to set down what the lorry brought back.
    outputCapacity: VEHICLE_EMPTIES_CAPACITY,
    tankCapacityMl: 0,
    wearPerOperation: 0,
    inputs: [],
    outputItem: null,
    overcookOutputItem: null,
    requiresTech: null,
    liquid: LiquidId.None,
    ports: [],
    pumpRateMlPerMinute: 0,
    intakeMlPerTick: 0,
    coverageRadiusTiles: 0,
    moistureSensing: false,
    fieldPlaceable: false,
  },
  {
    // The automated rung. $400 and the Trucking node — dearer than any single machine on the
    // chip line, because what it buys is not throughput but the end of a chore, and plan §3
    // prices the automated rung of every ladder above the assisted one it replaces.
    //
    // 2×2 rather than 1×1: it is the only thing on the lot that a truck reverses into, and it
    // has to be worth walking around. The footprint is also what makes belt-feeding legible —
    // a grabber needs a tile of it to aim at.
    kind: MachineKind.TruckDepot,
    slug: 'truck-depot',
    role: MachineRole.TruckDepot,
    tilesWide: 2,
    tilesHigh: 2,
    priceCents: 40_000,
    workPerOperation: 0,
    workRatePerTick: 0,
    // The floor a depot's routes stand on is `contract.stocked`, per route; this is the OTHER
    // floor (item 131), where the empties land when a truck comes home. Same size as the cart's
    // for the same reason a bin has one price: two vehicles doing one thing should not need two
    // numbers to describe it.
    inputCapacity: 0,
    outputCapacity: VEHICLE_EMPTIES_CAPACITY,
    tankCapacityMl: 0,
    wearPerOperation: 0,
    inputs: [],
    outputItem: null,
    overcookOutputItem: null,
    requiresTech: TechId.Trucking,
    liquid: LiquidId.None,
    ports: [],
    pumpRateMlPerMinute: 0,
    intakeMlPerTick: 0,
    coverageRadiusTiles: 0,
    moistureSensing: false,
    fieldPlaceable: false,
  },
  {
    // The belt junction: plan §5's splitter and merger, in one tile with no facing.
    //
    // $8 — hardware money, deliberately. What a junction costs the player is the $400 node, not
    // the object; the same shape as a $5 grabber arm behind a $250 belt node, and for the same
    // reason. A device you want four of on one line must not be a purchasing decision each time.
    //
    // NO WORK CYCLE, so it never wears, never jams, never overcooks and takes no dial —
    // `workPerOperation` is 0, exactly as it is on the two vehicles, and every rule about
    // machines that turn is silent on it. A junction that could wear out would put a maintenance
    // chore in the middle of the belt run whose entire purpose is that you stop walking over.
    // Its round-robin cursors live on the machine (`junctionInCursor` / `junctionOutCursor`) so
    // the alternation is world state, in the hash and in the save, rather than a roll.
    kind: MachineKind.BeltJunction,
    slug: 'belt-junction',
    role: MachineRole.Junction,
    tilesWide: 1,
    tilesHigh: 1,
    priceCents: 800,
    workPerOperation: 0,
    workRatePerTick: 0,
    // It has no buffer at all: an item crosses it inside one tick or does not leave the belt it
    // is on. See `advanceJunction` — a junction that held one item would be a place goods can
    // sit invisibly, and the backed-up belt in front of it is the diagnostic the player wants.
    inputCapacity: 0,
    outputCapacity: 0,
    tankCapacityMl: 0,
    wearPerOperation: 0,
    inputs: [],
    outputItem: null,
    overcookOutputItem: null,
    requiresTech: TechId.Splitters,
    liquid: LiquidId.None,
    ports: [],
    pumpRateMlPerMinute: 0,
    intakeMlPerTick: 0,
    coverageRadiusTiles: 0,
    moistureSensing: false,
    fieldPlaceable: false,
  },

  // --- keeping things -------------------------------------------------------------------
  //
  // Two boxes with lids, and the only difference between them is whether it is a shed or a
  // barrow. Everything else — placed, moved, boxed, invoiced, ownership-gated, reach-checked,
  // loaded with `LoadMachine`, emptied with `UnloadMachine` — is code that already existed and
  // that neither of these needed a line of.
  //
  // They hold ONE PRODUCT AT A TIME, in `cargoItem`/`cargoCount`, which is the delivery cart's
  // pair doing a second job. That is a container, not a warehouse: "what is in this" stays one
  // word and one number, and a player who wants two products puts down a second box.
  {
    // **BULK STORAGE** (item 124). The clock it used to stop no longer exists, so what it sells
    // is `ROOT_CELLAR_CAPACITY` — see `MachineKind.RootCellar` for why it was re-purposed rather
    // than deleted, and note that the price, footprint and tech node are all exactly what they
    // were: this is a machine finding a new job, not a machine being re-costed.
    kind: MachineKind.RootCellar,
    slug: 'root-cellar',
    role: MachineRole.Storage,
    tilesWide: 2,
    tilesHigh: 2,
    priceCents: 25_000,
    workPerOperation: 0,
    workRatePerTick: 0,
    inputCapacity: ROOT_CELLAR_CAPACITY,
    outputCapacity: 0,
    tankCapacityMl: 0,
    wearPerOperation: 0,
    inputs: [],
    outputItem: null,
    overcookOutputItem: null,
    requiresTech: TechId.RootCellar,
    liquid: LiquidId.None,
    ports: [],
    pumpRateMlPerMinute: 0,
    intakeMlPerTick: 0,
    coverageRadiusTiles: 0,
    moistureSensing: false,
    fieldPlaceable: false,
  },
  {
    // Plan §3's assisted rung of the TRANSPORT ladder. Storage that follows you.
    //
    // What it buys is the TRIP: twenty-four goods at the cost of walking slower, which is
    // precisely §1's rule that an assisted tool compresses trips and never replaces the verb.
    // It used to buy nothing else on purpose — a cart that also refrigerated would have made the
    // $250 Root Cellar the second-best fridge in the game — and since item 124 there are no
    // fridges to rank, so the cart and the cellar differ only in how much they hold and whether
    // they follow you.
    kind: MachineKind.HandCart,
    slug: 'hand-cart',
    role: MachineRole.Storage,
    tilesWide: 1,
    tilesHigh: 1,
    priceCents: 8_000,
    workPerOperation: 0,
    workRatePerTick: 0,
    inputCapacity: 24,
    outputCapacity: 0,
    tankCapacityMl: 0,
    wearPerOperation: 0,
    inputs: [],
    outputItem: null,
    overcookOutputItem: null,
    requiresTech: null,
    liquid: LiquidId.None,
    ports: [],
    pumpRateMlPerMinute: 0,
    intakeMlPerTick: 0,
    coverageRadiusTiles: 0,
    moistureSensing: false,
    fieldPlaceable: false,
  },

  // --- the orchard ----------------------------------------------------------------------
  //
  // Three 2×2 permanent plants that survive harvest and fruit on a cycle (§5). The cycle is
  // `workPerOperation ÷ workRatePerTick`, exactly as a Fryer's is — a tree is a machine that
  // takes four active minutes to make one fruit out of nothing — so the Speed dial works on it,
  // the progress bar means what it means everywhere else, and `MachineSpec` needed no new field.
  //
  // NO WEAR AND NO JAM: `wearPerOperation` is 0, because a tree is not machinery and §8 forbids
  // hanging a maintenance chore off a feature in the release that is not about maintenance. They
  // are dear to plant and free to keep, which is what makes planting one a decision.
  {
    kind: MachineKind.OrangeTree,
    slug: 'orange-tree',
    role: MachineRole.Orchard,
    tilesWide: 2,
    tilesHigh: 2,
    priceCents: 20_000,
    workPerOperation: 240 * WORK_RATE_SCALE,
    workRatePerTick: WORK_RATE_SCALE,
    inputCapacity: 0,
    outputCapacity: 12,
    tankCapacityMl: 0,
    wearPerOperation: 0,
    inputs: [],
    outputItem: ItemId.Orange,
    overcookOutputItem: null,
    requiresTech: TechId.Orchard,
    liquid: LiquidId.None,
    ports: [],
    pumpRateMlPerMinute: 0,
    intakeMlPerTick: 0,
    coverageRadiusTiles: 0,
    moistureSensing: false,
    fieldPlaceable: false,
  },
  {
    kind: MachineKind.LemonTree,
    slug: 'lemon-tree',
    role: MachineRole.Orchard,
    tilesWide: 2,
    tilesHigh: 2,
    priceCents: 20_000,
    workPerOperation: 240 * WORK_RATE_SCALE,
    workRatePerTick: WORK_RATE_SCALE,
    inputCapacity: 0,
    outputCapacity: 12,
    tankCapacityMl: 0,
    wearPerOperation: 0,
    inputs: [],
    outputItem: ItemId.Lemon,
    overcookOutputItem: null,
    requiresTech: TechId.Orchard,
    liquid: LiquidId.None,
    ports: [],
    pumpRateMlPerMinute: 0,
    intakeMlPerTick: 0,
    coverageRadiusTiles: 0,
    moistureSensing: false,
    fieldPlaceable: false,
  },
  {
    // **THE GATE ON THE COLA LINE, AND THE ONLY TREE WHOSE FRUIT ANYTHING EATS.** A kola nut off
    // this tree and a kola nut off the roadside stand are the same `ItemId`, deliberately: the
    // Grinder does not care where its nut came from, and §4's consumable ladder is exactly a
    // bought rung with a crafted rung under it. What the tree buys is that the nut stops costing
    // 150¢ — which is a third of a bottle of soda's ingredients — so a soda line that plants an
    // orchard is a soda line with a margin.
    //
    // Slower and dearer than the other two, because it is the one worth waiting for.
    kind: MachineKind.KolaTree,
    slug: 'kola-tree',
    role: MachineRole.Orchard,
    tilesWide: 2,
    tilesHigh: 2,
    priceCents: 45_000,
    workPerOperation: 360 * WORK_RATE_SCALE,
    workRatePerTick: WORK_RATE_SCALE,
    inputCapacity: 0,
    outputCapacity: 12,
    tankCapacityMl: 0,
    wearPerOperation: 0,
    inputs: [],
    outputItem: ItemId.KolaNut,
    overcookOutputItem: null,
    requiresTech: TechId.KolaTree,
    liquid: LiquidId.None,
    ports: [],
    pumpRateMlPerMinute: 0,
    intakeMlPerTick: 0,
    coverageRadiusTiles: 0,
    moistureSensing: false,
    fieldPlaceable: false,
  },

  // --- the Agri-Bot docks ------------------------------------------------------------------
  //
  // A dock is a shed with a zone written on it. The bot is an entity in `WorldState.bots`; this
  // machine is where it sleeps, what it fills, and — on the planter — where its seeds come from.
  // `outputCapacity` is the floor a belt or a grabber drains; `inputCapacity` is the seed hopper.
  {
    kind: MachineKind.HarvesterDock,
    slug: 'harvester-dock',
    role: MachineRole.BotDock,
    tilesWide: 2,
    tilesHigh: 2,
    // The automated rung, priced above every assisted tool on the same ladder and above the
    // Truck Depot beside it: what it buys is the one chore nothing in this game has ever done for
    // the player. Plan §3 prices the automated rung above the assisted one it replaces, and the
    // assisted one here is a $60 scythe you still have to swing.
    priceCents: 60_000,
    workPerOperation: 0,
    workRatePerTick: 0,
    inputCapacity: 0,
    outputCapacity: 40,
    tankCapacityMl: 0,
    wearPerOperation: 0,
    inputs: [],
    outputItem: null,
    overcookOutputItem: null,
    requiresTech: TechId.AgriBots,
    liquid: LiquidId.None,
    ports: [],
    pumpRateMlPerMinute: 0,
    intakeMlPerTick: 0,
    coverageRadiusTiles: 0,
    moistureSensing: false,
    fieldPlaceable: false,
  },
  {
    // The seed hopper on legs. §5: "regrowing crops automate first; one-shots wait for the
    // seed-hopper bot — the crop list itself paces the arc", so this is the machine that makes
    // potatoes, corn and gold potatoes automatable, and chili and cane never needed it.
    kind: MachineKind.PlanterDock,
    slug: 'planter-dock',
    role: MachineRole.BotDock,
    tilesWide: 2,
    tilesHigh: 2,
    priceCents: 50_000,
    workPerOperation: 0,
    workRatePerTick: 0,
    /** Seeds the hopper holds. Hand-filled counts a touch; belt-filled does not. */
    inputCapacity: 60,
    outputCapacity: 0,
    tankCapacityMl: 0,
    wearPerOperation: 0,
    inputs: [],
    outputItem: null,
    overcookOutputItem: null,
    requiresTech: TechId.PlanterBot,
    liquid: LiquidId.None,
    ports: [],
    pumpRateMlPerMinute: 0,
    intakeMlPerTick: 0,
    coverageRadiusTiles: 0,
    moistureSensing: false,
    fieldPlaceable: false,
  },

  // --- automated maintenance (item 039) --------------------------------------------------
  {
    // An arm that throws repair kits. `coverageRadiusTiles` is EXACTLY the hand kit's radius,
    // deliberately: the station is not a better kit, it is the same kit without the walk, so
    // one station services precisely the cell one trip would have. `inputs` names the kit so
    // the ordinary grabber recipe-line door belt-feeds the hopper with no new plumbing; the
    // consumption clock is `advanceMaintenanceStation`'s, not the converter's.
    kind: MachineKind.MaintenanceStation,
    slug: 'maintenance-station',
    role: MachineRole.MaintenanceStation,
    tilesWide: 2,
    tilesHigh: 2,
    // Above the dearest assisted tool on the ladder (the $80 kit is per-trip; this is the
    // trip removed), below the drone bay that outranks it. Era-3 money by the 15-Minute Rule.
    priceCents: 120_000,
    workPerOperation: 0,
    workRatePerTick: 0,
    /** The kit hopper. Hand-filled counts a touch; belt-filled does not. */
    inputCapacity: 6,
    outputCapacity: 0,
    tankCapacityMl: 0,
    /** Per service, like every wear rate in this file. It can service itself — for a kit. */
    wearPerOperation: 2,
    inputs: [{ item: ItemId.RepairKit, count: 1 }],
    outputItem: null,
    overcookOutputItem: null,
    requiresTech: TechId.Diagnostics,
    liquid: LiquidId.None,
    ports: [],
    pumpRateMlPerMinute: 0,
    intakeMlPerTick: 0,
    coverageRadiusTiles: REPAIR_KIT_RADIUS_TILES,
    moistureSensing: false,
    fieldPlaceable: false,
  },
  {
    // One bay, one drone, AND AN EMPTY SHELF ([[090]]). Its `cargoItem`/`cargoCount` pair used
    // to be a parts hopper sitting exactly where the planter keeps its seeds; drone service is
    // free now, so nothing goes in and the pair stays zero for the life of the world. The
    // `inputCapacity` below is what the retired hopper held and is no longer reachable — it is
    // frozen balance data like every other number in this table, not a live capacity.
    //
    // The bay itself never wears and never works — the DRONE wears, per service, and is
    // repaired at the bay by hand or kit like any dock's bot. It is also, since [[090]], repaired
    // by ANY drone on the lot, its own included: a dock's wrench-due state is its bots'.
    kind: MachineKind.DroneBay,
    slug: 'drone-bay',
    role: MachineRole.BotDock,
    tilesWide: 2,
    tilesHigh: 2,
    // The capstone's hangar: priced above every dock on the lot. What it buys is a machine
    // that services the whole lot with no radius at all.
    priceCents: 200_000,
    workPerOperation: 0,
    workRatePerTick: 0,
    /** Parts the hopper holds. Hand-filled counts a touch; belt-filled does not. */
    inputCapacity: 12,
    outputCapacity: 0,
    tankCapacityMl: 0,
    wearPerOperation: 0,
    inputs: [],
    outputItem: null,
    overcookOutputItem: null,
    requiresTech: TechId.Drones,
    liquid: LiquidId.None,
    ports: [],
    pumpRateMlPerMinute: 0,
    intakeMlPerTick: 0,
    coverageRadiusTiles: 0,
    moistureSensing: false,
    fieldPlaceable: false,
  },
  {
    // **A HEADSTONE, NOT A CATALOGUE ROW** (item 090). Every number below is exactly what it was
    // the day the bench shipped, and none of it is reachable: `applyPlaceMachine` refuses a
    // retired kind before it reads any of this. It is kept, unedited, because a box of a Parts
    // Bench in somebody's bag reads its slug, its label and its list price through this entry —
    // scrap the box and `boxedMachineScrapCents` works off the invoice this spec priced. Editing
    // it would silently re-price a machine nobody can buy; deleting it would strand one somebody
    // owns. See `RETIRED_MACHINE_KINDS` for the argument in full.
    kind: MachineKind.PartsBench,
    slug: 'parts-bench',
    role: MachineRole.Converter,
    tilesWide: 2,
    tilesHigh: 2,
    priceCents: 80_000,
    workPerOperation: 30 * WORK_RATE_SCALE,
    workRatePerTick: WORK_RATE_SCALE,
    inputCapacity: 20,
    outputCapacity: 20,
    tankCapacityMl: 0,
    /** A 30-tick machine that machines metal — rounds UP, per the wear derivation above. */
    wearPerOperation: 2,
    inputs: [
      { item: ItemId.Bottle, count: 1 },
      { item: ItemId.KolaPowder, count: 1 },
    ],
    outputItem: ItemId.DronePart,
    overcookOutputItem: null,
    requiresTech: TechId.Drones,
    liquid: LiquidId.None,
    ports: [],
    pumpRateMlPerMinute: 0,
    intakeMlPerTick: 0,
    coverageRadiusTiles: 0,
    moistureSensing: false,
    fieldPlaceable: false,
  },
];

export function machineSpec(kind: MachineKind): MachineSpec | null {
  for (let i = 0; i < MACHINE_SPECS.length; i++) {
    const spec = MACHINE_SPECS[i]!;
    if (spec.kind === kind) return spec;
  }
  return null;
}

// --- what a machine knows how to make (item 111) -------------------------------------
//
// **A SIDE TABLE RATHER THAN A FIELD ON EVERY SPEC, AND THAT IS A DELIBERATE TRADE.** Five
// machines in a roster of forty know more than one recipe; a `recipes` field on `MachineSpec`
// would have put an empty list on the other thirty-five and asked every future machine to
// answer a question it does not have. `BOXED_MACHINE_ROWS` and `RETIRED_MACHINE_KINDS` are
// already keyed-by-kind side tables for the same reason, so this is the file's own idiom.
//
// The cost is that a machine's recipes are no longer all in one place, and it is paid down by
// `machineRecipes()` below being the ONLY way anything reads them — `tick.ts` never touches
// this array — and by `test/sim.test.ts` pinning that every line here names an item that
// machine actually has a hopper for.
//
// ORDER IS THE PRIORITY, AND IT IS THE ONLY TIE-BREAK IN THE FEATURE. The first recipe whose
// hoppers are full enough runs, so **the flavoured lines are declared before the plain one** —
// a Seasoner holding chips and peppers makes chili chips, and falls back to plain the moment
// the peppers run out rather than stopping. A line never stalls for want of a seasoning; it
// just quietly goes back to salt, which is a supply problem the player can see in the hopper.
//
// FLAVOURS DO NOT COMBINE, and that is why the chili and corn lines name `PlainChips`
// specifically rather than "any chip". Letting a seasoning meet the premium base would have
// turned nine items into a matrix — spicy gold, sweetcorn gold, and a bag for each — and the
// recipe graph has ONE node left (see the `ItemId` header). One flavour per bag.

export interface MachineRecipeRow {
  readonly kind: MachineKind;
  readonly recipes: readonly MachineRecipe[];
}

export const MACHINE_RECIPES: readonly MachineRecipeRow[] = [
  {
    // **THE MACHINE THE OWNER RULED FOR** (item 131, 2026-08-17: *"Okey washer it is."*). It
    // washes dirty things clean, and an empty that came back from a delivery is a dirty thing,
    // so the second job needs no second machine and no sentence explaining the verb.
    //
    // **THE BOTTLE LINE SITS BETWEEN THE GOLD ONE AND THE PLAIN ONE, AND THAT POSITION IS A
    // SAVE-COMPATIBILITY RULE BEFORE IT IS A PRIORITY.** `MACHINE_HOPPERS` is built as
    // `spec.inputs` plus every unseen item in RECIPE ORDER, and `machine.inputCounts` is stored
    // parallel to it in every save on disk — so declaring the bottles FIRST would have inserted a
    // hopper at index 1 and slid the gold-potato line to index 2, which silently relabels every
    // saved Washer's gold potatoes as used bottles. Second keeps the existing indices exactly
    // where they are and lands the new hopper on the end, which is the case `readInputCounts` was
    // already written to absorb. See the `MACHINE_HOPPERS` header for the rule in full.
    //
    // It is also the right priority on its merits, and it is this file's own idiom: order is
    // production priority, and the scarce input goes above the staple exactly as the flavoured
    // chip lines go above plain salt. Empties arrive in BURSTS — one lorry, one armful — while
    // russets arrive continuously, so a burst clears promptly and the line falls straight back to
    // potatoes rather than a heap of glass sitting in a hopper for the rest of the session.
    //
    // **WHAT A SHARED WASHER COSTS, SAID OUT LOUD:** a basket holds one product at a time
    // (`heldOutputItem`), so a Washer mid-bottle will not start a potato until the bottles are
    // taken away, and an arm pointed at a Slicer refuses a clean bottle and lights RED. That is
    // `basketBlocksRecipe`'s ordinary "look downstream" stall, in the vocabulary the whole
    // factory is taught in, and the two builds that answer it are a filtered arm or a second
    // Washer. It is a visible stall rather than a silent one, which is the trade this file makes
    // everywhere else.
    kind: MachineKind.Washer,
    recipes: [
      { consumes: [{ item: ItemId.GoldPotato, count: 1 }], output: ItemId.WashedGoldPotato },
      { consumes: [{ item: ItemId.UsedBottle, count: 1 }], output: ItemId.Bottle },
      { consumes: [{ item: ItemId.RussetPotato, count: 1 }], output: ItemId.WashedPotato },
    ],
  },
  {
    kind: MachineKind.Slicer,
    recipes: [
      {
        consumes: [{ item: ItemId.WashedGoldPotato, count: 1 }],
        output: ItemId.GoldPotatoSlices,
      },
      { consumes: [{ item: ItemId.WashedPotato, count: 1 }], output: ItemId.PotatoSlices },
    ],
  },
  {
    kind: MachineKind.Fryer,
    recipes: [
      { consumes: [{ item: ItemId.GoldPotatoSlices, count: 1 }], output: ItemId.GoldChips },
      { consumes: [{ item: ItemId.PotatoSlices, count: 1 }], output: ItemId.PlainChips },
    ],
  },
  {
    // The machine item 111 was written to make interesting. It had one input, one output and no
    // decision in it; it now has the only ingredient choice on the lot.
    //
    // ONE PEPPER PER CHIP, and it is a limit of the model rather than a claim about cooking: an
    // operation makes exactly one unit, and there is no fractional consumption anywhere in this
    // sim, so a pepper cannot season four chips without inventing a second kind of recipe. The
    // premium is priced against that full pepper — see `CHILI_PREMIUM_CENTS`.
    kind: MachineKind.Seasoner,
    recipes: [
      {
        consumes: [
          { item: ItemId.PlainChips, count: 1 },
          { item: ItemId.ChiliPepper, count: 1 },
        ],
        output: ItemId.ChiliChips,
      },
      {
        consumes: [
          { item: ItemId.PlainChips, count: 1 },
          { item: ItemId.Corn, count: 1 },
        ],
        output: ItemId.SweetcornChips,
      },
      { consumes: [{ item: ItemId.GoldChips, count: 1 }], output: ItemId.SeasonedGoldChips },
      // Last, and unchanged since v0.1. Plain chips keep working exactly as they always have:
      // a Seasoner fed nothing but chips reaches this line every time.
      { consumes: [{ item: ItemId.PlainChips, count: 1 }], output: ItemId.SeasonedChips },
    ],
  },
  {
    kind: MachineKind.Bagger,
    recipes: [
      { consumes: [{ item: ItemId.ChiliChips, count: 1 }], output: ItemId.BaggedChiliChips },
      {
        consumes: [{ item: ItemId.SweetcornChips, count: 1 }],
        output: ItemId.BaggedSweetcornChips,
      },
      {
        consumes: [{ item: ItemId.SeasonedGoldChips, count: 1 }],
        output: ItemId.BaggedGoldChips,
      },
      { consumes: [{ item: ItemId.SeasonedChips, count: 1 }], output: ItemId.BaggedChips },
    ],
  },
];

/**
 * Every recipe a machine knows, in priority order. **The one reader of `MACHINE_RECIPES`.**
 *
 * A machine with no row gets the single recipe its spec has always implied — every solid line
 * of `inputs`, producing `outputItem` — so the thirty-five machines item 111 did not touch run
 * through exactly the same executor on exactly the same data as before. There is one recipe
 * path in this sim, not a flavoured one beside a legacy one.
 */
export function machineRecipes(spec: MachineSpec): readonly MachineRecipe[] {
  for (let i = 0; i < MACHINE_RECIPES.length; i++) {
    const row = MACHINE_RECIPES[i]!;
    if (row.kind === spec.kind) return row.recipes;
  }
  return [{ consumes: spec.inputs, output: spec.outputItem }];
}

// --- hoppers, which are NOT the recipe (item 111) --------------------------------------
//
// **`spec.inputs` IS ONE OPERATION'S INGREDIENTS. THE HOPPERS ARE EVERY INGREDIENT THE MACHINE
// CAN HOLD.** Those were the same list for the whole life of this file, and the first draft of
// item 111 merged them — it widened `spec.inputs` to the union and moved on. That was wrong,
// and the way it announced itself is worth keeping: the Dawn Report prices an idle machine at
// `outputItem` less every line of `spec.inputs`, so a Fryer that had grown a second hopper
// started costing 450 + 1050 to make a 900 chip, went value-negative, and silently stopped
// flagging idle machines at all. One widened field, one wrong number, on a surface nobody
// would have thought to re-read.
//
// So `inputs` keeps its meaning — what a plain operation eats — and every reader that means
// "the recipe" stays right without being touched. The hoppers are derived here instead.
//
// **PRIMARY FIRST, THEN RECIPE ORDER, AND THAT ORDERING IS A SAVE-COMPATIBILITY RULE RATHER
// THAN A STYLE.** `machine.inputCounts` is parallel to this list and is stored that way in
// every save on disk, so hopper 0 has to keep being what it has always been. Starting from
// `spec.inputs` and appending only unseen items guarantees existing indices never move and new
// hoppers only ever land on the end — which is exactly the case `readInputCounts` was already
// written to absorb ("a spec that gained a line").
//
// Built once at module load rather than per call: `hopperIndexFor` runs inside the belt loop
// and the converter tick, and a function that allocated an array there would be a garbage
// generator in the hottest code in the sim.

interface HopperRow {
  readonly kind: MachineKind;
  readonly hoppers: readonly RecipeInput[];
}

const MACHINE_HOPPERS: readonly HopperRow[] = MACHINE_SPECS.map((spec) => {
  const hoppers: RecipeInput[] = spec.inputs.slice();
  const recipes = machineRecipes(spec);
  for (let r = 0; r < recipes.length; r++) {
    const consumes = recipes[r]!.consumes;
    for (let i = 0; i < consumes.length; i++) {
      const line = consumes[i]!;
      let seen = false;
      for (let h = 0; h < hoppers.length; h++) {
        if (hoppers[h]!.item === line.item) {
          seen = true;
          break;
        }
      }
      if (!seen) hoppers.push(line);
    }
  }
  return { kind: spec.kind, hoppers };
});

/**
 * Every ingredient this machine can hold, in the order `machine.inputCounts` stores them.
 *
 * The list to walk when the question is about STORAGE — sizing the buffers, matching a belt's
 * item to a slot, refunding a torn-down machine, invoicing what is sitting inside one. When the
 * question is about an OPERATION, the answer is a recipe from `machineRecipes()`, not this.
 */
export function machineHoppers(spec: MachineSpec): readonly RecipeInput[] {
  for (let i = 0; i < MACHINE_HOPPERS.length; i++) {
    const row = MACHINE_HOPPERS[i]!;
    if (row.kind === spec.kind) return row.hoppers;
  }
  return spec.inputs;
}

/**
 * Which hopper holds an item for this machine, or -1. `machine.inputCounts` is parallel to
 * `machineHoppers()`, so a recipe naming an item has to be resolved to an index to be executed.
 */
export function hopperIndexFor(spec: MachineSpec, item: ItemId): number {
  const hoppers = machineHoppers(spec);
  for (let i = 0; i < hoppers.length; i++) {
    if (hoppers[i]!.item === item) return i;
  }
  return -1;
}

// --- per-machine upgrades ---------------------------------------------------------
//
// Plan §3: three dials × three levels, bought at the machine. THE TECH TREE HAS NO STAT
// NODES AND THE DIALS UNLOCK NO VERBS — the anti-double-dip rule is structural, and the
// shape of `TechNode` in tech.ts is the other half of enforcing it.

export const UpgradeDial = {
  /** +30% work rate per level, and +25% wear — faster machines break more. */
  Speed: 1,
  /** −20% wear and a longer waste cadence per level. The expensive track. */
  Efficiency: 2,
  /** +100% buffer per level, no catch. The jam-smoother. */
  Capacity: 3,
} as const;

export type UpgradeDial = (typeof UpgradeDial)[keyof typeof UpgradeDial];

export const UPGRADE_MAX_LEVEL = 3;

export const SPEED_RATE_BONUS_PERCENT_PER_LEVEL = 30;
export const SPEED_WEAR_PENALTY_PERCENT_PER_LEVEL = 25;
export const EFFICIENCY_WEAR_CUT_PERCENT_PER_LEVEL = 20;
export const CAPACITY_BONUS_PER_LEVEL = 100;

/**
 * THE OTHER HALF OF THE EFFICIENCY DIAL. Plan §3 specifies Efficiency as reducing "both
 * input waste and wear"; the wear half has always been `EFFICIENCY_WEAR_CUT_PERCENT_PER_LEVEL`
 * above, and this is the waste half.
 *
 * Waste is a **cadence**, not a chance (see `WASTE_PERIOD_AT_THRESHOLD`), so the dial's only
 * honest lever on it is to LENGTHEN THE PERIOD — a machine just under the threshold spoils one
 * input in seven, and one in twelve with the dial maxed. It is a
 * percentage stretch rather than a flat `+N` because the period itself already varies with
 * condition: a flat bonus would erase waste entirely on a machine at death's door (period 2)
 * while barely touching one that just crossed the line, which is backwards.
 *
 * It never reaches "no waste", for the same reason `effectiveWear` never reaches zero: the
 * dial is a discount on neglect, not an exemption from it.
 */
export const EFFICIENCY_WASTE_STRETCH_PERCENT_PER_LEVEL = 25;

/**
 * Cost of each level as a percentage of the machine's invoice price: 1× / 2.5× / 6×
 * escalation (plan §3), so maxing one Fryer competes with buying a second one.
 */
export const UPGRADE_COST_PERCENT_BY_LEVEL: readonly number[] = [40, 100, 240];

/**
 * And what each DIAL costs relative to that ladder, as a percentage.
 *
 * EFFICIENCY IS THE EXPENSIVE TRACK, AND UNTIL NOW ONLY THE COMMENT SAID SO. Plan §3 names it
 * that way, `UpgradeDial` above has always described it that way, and every dial charged the
 * same 40/100/240% — which made the claim decoration. Now that Efficiency cuts wear *and*
 * stretches the waste cadence it is plainly the strongest dial on a hard-run machine, so it
 * costs half again as much: 60/150/360%, or 5.7× the machine's price to max.
 *
 * A multiplier rather than a second ladder, deliberately. The 1×/2.5×/6× escalation is plan
 * §3's shape and applies to every dial; which dial you are buying scales that shape, and
 * writing it as one number per dial keeps the escalation defined in exactly one place.
 */
export const UPGRADE_COST_PERCENT_BY_DIAL: Readonly<Record<UpgradeDial, number>> = {
  [UpgradeDial.Speed]: 100,
  [UpgradeDial.Efficiency]: 150,
  [UpgradeDial.Capacity]: 100,
};

// --- belts and grabbers -----------------------------------------------------------
//
// PLAN §13, AND THE REPRESENTATION IS LOAD-BEARING: a belt segment is a sorted list of
// `(distanceAlongBelt, itemTypeId)`. The renderer derives particle positions from that list
// each frame rather than tracking an object per item, so there is no persistent particle
// per sim item and no sync bookkeeping. Do not replace this with per-item entities.

export const BeltTier = {
  Basic: 1,
  Fast: 2,
  Express: 3,
} as const;

export type BeltTier = (typeof BeltTier)[keyof typeof BeltTier];

/**
 * Gap between items on a belt, in subtiles. Four items per tile, which is what makes a
 * loaded belt read as a stream of goods rather than a dotted line.
 */
export const BELT_ITEM_SPACING_SUBTILES = 64;

export interface BeltSpec {
  readonly tier: BeltTier;
  readonly slug: string;
  /**
   * Subtiles travelled per 100 ticks. Per-100 because 60 items/min at 20 Hz is 3.2
   * subtiles/tick, and rounding that to 3 would quietly make every belt 6% slow. The
   * remainder accrues in the belt's own accumulator, exactly as player movement does.
   */
  readonly speedSubtilesPer100Ticks: number;
  /** Cents per tile of belt. */
  readonly priceCentsPerTile: number;
  readonly requiresTech: string;
}

/** Plan §5's three tiers: 60 / 120 / 240 items per minute. */
export const BELT_SPECS: readonly BeltSpec[] = [
  {
    tier: BeltTier.Basic,
    slug: 'belt-basic',
    speedSubtilesPer100Ticks: 320,
    priceCentsPerTile: 150,
    requiresTech: TechId.Belts,
  },
  {
    tier: BeltTier.Fast,
    slug: 'belt-fast',
    speedSubtilesPer100Ticks: 640,
    priceCentsPerTile: 400,
    requiresTech: TechId.BeltsFast,
  },
  {
    tier: BeltTier.Express,
    slug: 'belt-express',
    speedSubtilesPer100Ticks: 1280,
    priceCentsPerTile: 900,
    requiresTech: TechId.BeltsExpress,
  },
];

export function beltSpec(tier: BeltTier): BeltSpec | null {
  for (let i = 0; i < BELT_SPECS.length; i++) {
    const spec = BELT_SPECS[i]!;
    if (spec.tier === tier) return spec;
  }
  return null;
}

/** A single belt segment is straight; corners are two segments meeting. */
export const BELT_MAX_LENGTH_TILES = 16;

export const GrabberTier = {
  Mk1: 1,
  /** Filtered — moves one chosen item and leaves everything else alone. */
  Mk2: 2,
  /** Reaches two tiles, and is slower for it. */
  Long: 3,
} as const;

export type GrabberTier = (typeof GrabberTier)[keyof typeof GrabberTier];

export interface GrabberSpec {
  readonly tier: GrabberTier;
  readonly slug: string;
  /** Ticks per half-swing: one to pick up, one to put down. */
  readonly swingTicks: number;
  /** Tiles either side the arm can reach. */
  readonly reachTiles: number;
  readonly priceCents: number;
  /** Whether this arm can hold a filter. Mk1 cannot. */
  readonly filterable: boolean;
  readonly requiresTech: string;
}

export const GRABBER_SPECS: readonly GrabberSpec[] = [
  {
    tier: GrabberTier.Mk1,
    slug: 'grabber-mk1',
    swingTicks: 10,
    reachTiles: 1,
    priceCents: 500,
    filterable: false,
    requiresTech: TechId.Belts,
  },
  {
    tier: GrabberTier.Mk2,
    slug: 'grabber-mk2',
    swingTicks: 10,
    reachTiles: 1,
    priceCents: 1_200,
    filterable: true,
    requiresTech: TechId.BeltsFast,
  },
  {
    tier: GrabberTier.Long,
    slug: 'grabber-long',
    swingTicks: 12,
    reachTiles: 2,
    priceCents: 1_800,
    filterable: true,
    requiresTech: TechId.BeltsExpress,
  },
];

export function grabberSpec(tier: GrabberTier): GrabberSpec | null {
  for (let i = 0; i < GRABBER_SPECS.length; i++) {
    const spec = GRABBER_SPECS[i]!;
    if (spec.tier === tier) return spec;
  }
  return null;
}

// --- world layout -----------------------------------------------------------------

/**
 * One parcel of land, in tiles. THE STARTING LOT IS EXACTLY ONE OF THESE.
 *
 * Plan §5 says only this about land: *"the starter lot is free; adjacent parcels are
 * purchasable land deeds at escalating prices — a clean mid-game money sink that answers 'is
 * space free?' (No — but it's never scarce enough to softlock.)"* It fixes neither the parcel
 * size nor the price, so both are chosen here and the arithmetic is written down.
 *
 * SIXTEEN, because that is what the lot already was. Every world that exists was born on a
 * 16×16 map, so making the parcel any other size would mean the starting lot is not a parcel —
 * and then ownership has to describe a ragged shape rather than a set of squares, in the hash,
 * in the save, and in the fence the renderer draws. One number, and the migration is `[0]`.
 */
export const PARCEL_TILES = 16;

/**
 * The lot is a 4×4 grid of parcels — a 64×64 map: one parcel free, fifteen for sale.
 *
 * SIXTY-FOUR TILES A SIDE BECAUSE THE PLAN NAMES THAT NUMBER AND NO OTHER. Plan §5's Land
 * paragraph fixes no size at all, but §8's roadmap does — v0.2 is *"Zone brush, 64×64 map,
 * withering"* — and it is the only map dimension written down anywhere in the design. **The
 * `withering` half of that quote was struck from the plan on 2026-08-17 (item 124); the number
 * was not, and the number is the only part this constant ever borrowed.** The
 * roadmap slipped (the shipped game reached the soda line still on 16×16) but the number did
 * not stop being the plan's answer, and `FIELD_TILES_WIDE` below has carried a comment
 * pointing at it since v0.1.
 *
 * The alternative on the table was a 3×3 grid — 48×48, nine parcels — which is what an
 * earlier pass at this feature chose on the grounds that a doubling ladder prices the last of
 * sixteen deeds past plan §4's ten-hour curve. It does, and that is fine: the ten-hour curve
 * is the *reference* for pricing shape, not the end of the game. Plan §6 designs for hour 50+
 * (the Head Office, campuses, trophies), and a money sink whose last rung is reached around
 * hour 30 is a sink with headroom rather than scenery. See `DEED_PRICE_CENTS_BY_PURCHASE`.
 *
 * 4,096 tiles against the 256 the game shipped with — sixteen times the lot, and the fit
 * arithmetic for the two production lines is in `test/parcels.test.ts`.
 */
export const PARCELS_WIDE = 4;
export const PARCELS_HIGH = 4;
export const PARCEL_COUNT = PARCELS_WIDE * PARCELS_HIGH;

/**
 * The parcel every world starts owning, as a row-major parcel index.
 *
 * ZERO — the north-west corner — AND THAT IS THE WHOLE COMPATIBILITY ARGUMENT. The world grew
 * east and south from an origin that did not move, so every tile, machine, belt, pipe and pond
 * in an existing save is still at the coordinates it was saved at and the field is still at
 * (4,4). Centring the old lot in the new one would have been prettier and would have required
 * translating every coordinate in every save by (+16,+16) — a migration that moves a player's
 * factory, to buy symmetry nobody can see from inside the world.
 */
export const STARTING_PARCEL = 0;

/**
 * What each successive deed costs, in cents. Index 0 is the FIRST parcel bought, not parcel 0.
 *
 * ESCALATING, AND THE RATE IS THE POINT. Plan §4's curve has income roughly doubling every two
 * hours, so a ladder that doubles keeps every deed the same *reach*: about an hour of whatever
 * you are earning when you want it. The first is $200 against the ~$200/hr of a player around
 * hour four, which is when belts arrive and the yard first runs out; the fourth is $1,600
 * against the $600–900/hr §4 puts at hours nine and ten; the last is $3,276,800, which is an
 * hour of income at about hour thirty on the same doubling. Priced by HOW MANY YOU HAVE BOUGHT
 * rather than by which parcel it is, so two players who expanded in opposite directions paid
 * the same money and hash the same — the same argument that keeps a network's id geometric and
 * an inventory slot's boxes sorted.
 *
 * DOUBLING RATHER THAN A GENTLER CURVE FITTED TO FIFTEEN RUNGS, deliberately. A posted price
 * ladder is only stable if a player can hold it in their head (§4: "stable, posted on a board
 * from minute one"), and "the next one costs twice the last one" is the only rule here anybody
 * will remember. The far rungs being out of reach at hour ten is the money sink working: plan
 * §5 asks land to answer "is space free?" with *no, but never scarce enough to softlock*, and
 * one free parcel plus four affordable ones inside the reference curve is exactly that.
 *
 * Fifteen entries for fifteen buyable parcels. `deedPriceCents` returns -1 past the end rather
 * than extrapolating, because a sixteenth price would be a number nothing can spend.
 */
export const DEED_PRICE_CENTS_BY_PURCHASE: readonly number[] = [
  20_000, 40_000, 80_000, 160_000, 320_000, 640_000, 1_280_000, 2_560_000, 5_120_000, 10_240_000,
  20_480_000, 40_960_000, 81_920_000, 163_840_000, 327_680_000,
];

/**
 * The maximum extent of the lot, in tiles. NOT how much of it the player owns — that is
 * `WorldState.ownedParcels`, and a fresh world owns one sixteenth of this.
 */
export const WORLD_TILES_WIDE = PARCEL_TILES * PARCELS_WIDE;
export const WORLD_TILES_HIGH = PARCEL_TILES * PARCELS_HIGH;

/**
 * The parcel a world tile falls in, row-major, or -1 for a tile off the map.
 *
 * Pure geometry, so it lives here beside the numbers it divides rather than in `state.ts`
 * beside the list of what is owned. Ownership is a question about a world; which parcel a tile
 * is in is a question about arithmetic, and the two want different files.
 */
export function parcelIndexAt(tileX: number, tileY: number): number {
  if (tileX < 0 || tileY < 0 || tileX >= WORLD_TILES_WIDE || tileY >= WORLD_TILES_HIGH) return -1;
  const px = divFloor(tileX, PARCEL_TILES);
  const py = divFloor(tileY, PARCEL_TILES);
  return py * PARCELS_WIDE + px;
}

/** The north-west tile of a parcel. The inverse of `parcelIndexAt`, at parcel resolution. */
export function parcelOriginX(parcel: number): number {
  return (parcel % PARCELS_WIDE) * PARCEL_TILES;
}

export function parcelOriginY(parcel: number): number {
  return divFloor(parcel, PARCELS_WIDE) * PARCEL_TILES;
}

export function isParcelIndex(parcel: number): boolean {
  return Number.isInteger(parcel) && parcel >= 0 && parcel < PARCEL_COUNT;
}

/** Orthogonally touching. Corners do not count — a deed bought across a diagonal is a lie. */
export function parcelsAdjacent(a: number, b: number): boolean {
  if (!isParcelIndex(a) || !isParcelIndex(b)) return false;
  const ax = a % PARCELS_WIDE;
  const ay = divFloor(a, PARCELS_WIDE);
  const bx = b % PARCELS_WIDE;
  const by = divFloor(b, PARCELS_WIDE);
  const dx = ax > bx ? ax - bx : bx - ax;
  const dy = ay > by ? ay - by : by - ay;
  return dx + dy === 1;
}

/**
 * What the `n`th deed a world buys costs, in cents, or **-1 when there is no `n`th deed**.
 *
 * The sentinel rather than a clamp or a zero: a world that owns every parcel has no next price,
 * which is a different fact from "the next one is free", and the HUD needs to be able to tell
 * those apart to stop drawing a price on land nobody can buy.
 */
export function deedPriceCents(purchaseIndex: number): number {
  if (!Number.isInteger(purchaseIndex) || purchaseIndex < 0) return -1;
  return DEED_PRICE_CENTS_BY_PURCHASE[purchaseIndex] ?? -1;
}

// --- selling above the roadside stand ---------------------------------------------
//
// Plan §3's ladder for selling: carry to the stand → load a cart and send it → a belt-fed depot
// on standing contracts. The manual rung is a gift the world starts with and never rots (§1);
// these are the two above it.
//
// A CONTRACT CHOOSES LOGISTICS AND NEVER PRICE. Locked decision 3 fixes prices as stable and
// posted and §8 cuts fluctuating markets forever, so there is no price, bonus, premium, or
// volume discount anywhere in this section. A route says *what* to ship and *how much per run*.
// Every payout below is `listPriceCents(item) × count`, which is the same arithmetic the sell
// bin does — the money is identical at the bin, on a cart, and on a truck, and that is the
// point rather than a simplification.

/**
 * The road, as a tile column: **x = 0, the lot's west edge.**
 *
 * THE ROAD IS WHERE THE DESIGN ALREADY PUT IT. Plan §1 opens on "a weedy roadside lot" and
 * `createWorld` stands the roadside stand at `FIELD_ORIGIN_X - 2` — x = 2, two tiles west of the
 * field and hard against this edge. Nothing else in the world is a road, and this is the column
 * the one existing piece of commerce furniture was placed against.
 *
 * IT IS THE WEST EDGE RATHER THAN THE SELL BIN, and the reason is that a rule must not be
 * gameable. `MachineKind.SellBin` costs nothing and is refused no tech, so "distance to the
 * nearest bin" would be zero for the price of dropping a second bin beside the depot — a
 * one-click way to delete the haul. An edge of the map cannot be moved, bought, or duplicated.
 */
export const ROAD_EDGE_TILE_X = 0;

/**
 * How much longer a run takes per tile of distance from the road, in ticks.
 *
 * THIS IS THE ANSWER TO "WHAT DOES DISTANCE MEAN ON A 64×64 MAP". Before land deeds the lot was
 * sixteen tiles wide and haulage distance was not a decision anybody could make; now the far
 * parcels are 48 tiles further out, and a depot's placement is worth thinking about. Ten ticks
 * a tile is half an active second: a depot hard against the road adds nothing, one on the east
 * edge adds 630 ticks — about doubling a truck's round trip — so "put the depot near the road"
 * is a real layout consideration that a player can see on the progress track without being told.
 *
 * Measured on the vehicle's own `tileX` and nothing else. There is deliberately no path, no
 * route, and no pathfinding: see `runTicksFor` in `commerce.ts` for why the journey happens off
 * the map entirely and therefore crosses nobody's land.
 */
export const RUN_TICKS_PER_TILE_FROM_ROAD = 10;

/**
 * A cart's round trip at the roadside, in ticks — thirty active seconds before distance.
 *
 * Long enough that dispatching is a decision and not a click you spam, short enough that a
 * player who loads twenty bags sees the money inside the same visit to the yard.
 */
export const CART_RUN_BASE_TICKS = 30 * TICKS_PER_SECOND;

/** How many goods one cart holds. One product per run — see `Machine.cargoItem`. */
export const CART_CAPACITY = 20;

/**
 * A truck's round trip at the roadside, in ticks — forty-five active seconds before distance.
 *
 * SLOWER PER TRIP AND FASTER PER GOOD, which is what makes it the rung above the cart rather
 * than a reskin of it. A cart moves 20 goods in ~620 ticks; a truck moves up to 100 in ~1,000,
 * so the depot wins on throughput as well as on hands — and it should, because it costs four
 * times as much and sits behind a research node.
 */
export const DEPOT_RUN_BASE_TICKS = 45 * TICKS_PER_SECOND;

/**
 * How long a truck stands at the depot with its engine running before it leaves, in ticks.
 *
 * FIVE SECONDS EXISTS SO THE DEPARTURE IS A MOMENT. Plan §3's Hall of Hands promises the first
 * truck honks twice, and a ceremony needs the truck to still be at the dock when the horn
 * sounds — a run that went from "stock full" to "gone" inside one tick would leave the renderer
 * theatre nothing to play over. It is also the phase the panel labels "loading", which is the
 * only visible difference between a route that is about to go and one that is waiting on stock.
 */
export const DEPOT_LOAD_TICKS = 5 * TICKS_PER_SECOND;

/**
 * How many goods one depot holds across all of its routes, awaiting a run.
 *
 * ONE NUMBER FOR THE WHOLE DEPOT rather than a per-contract allowance, because that is the
 * building: a shed with a floor. Two routes competing for the same floor is a legible
 * consequence a player can watch happen, whereas a per-route allowance would make the depot's
 * total capacity a function of how many routes had been signed, which is a number nothing on
 * screen could explain.
 *
 * Deliberately larger than the biggest run so a belt keeps filling while a truck is out — a
 * depot that stalled its own inputs for the length of every journey would make the automated
 * rung *slower* than the assisted one.
 */
export const DEPOT_STOCK_CAPACITY = 200;

/** Routes one depot may hold at once. Bounds the state; four products is a full yard. */
export const DEPOT_MAX_CONTRACTS = 4;

/**
 * The most a single run may be written for. The panel offers 10/25/50/100.
 *
 * A ceiling rather than a fixed set, so the reducer refuses on a rule the client cannot argue
 * with while the client stays free to offer whatever round numbers read well.
 */
export const CONTRACT_MAX_QUANTITY = 100;

/**
 * Longest destination label the sim will store. Longer names are clipped, never rejected —
 * exactly as `ZONE_NAME_MAX_LENGTH` handles a zone's name.
 */
export const DESTINATION_MAX_LENGTH = 24;

/**
 * One fixed 8×8 field (plan §16.4), inside the starting parcel and staying there.
 *
 * THE FIELD DID NOT MOVE WHEN THE MAP GREW, and nothing about it is derived from the world's
 * size — which is what makes a pre-deed save load with every crop on the tile it was saved on.
 * Zones are clipped to these bounds, so zone painting is inside owned land by construction and
 * needs no ownership check of its own.
 */
export const FIELD_TILES_WIDE = 8;
export const FIELD_TILES_HIGH = 8;
export const FIELD_TILE_COUNT = FIELD_TILES_WIDE * FIELD_TILES_HIGH;
export const FIELD_ORIGIN_X = 4;
export const FIELD_ORIGIN_Y = 4;

/** Starting cash, in cents. Plan §4's curve opens at $50. */
export const STARTING_MONEY_CENTS = 5_000;
export const STARTING_SEEDS = 8;

/** How far the player can reach to water, plant, harvest, load, or sell, in subtiles. */
export const HAND_REACH_SUBTILES = 384;
export const HAND_REACH_SUBTILES_SQUARED = HAND_REACH_SUBTILES * HAND_REACH_SUBTILES;

/** 4 tiles/second, expressed per 100 ticks so the arithmetic stays exact (see tick.ts). */
export const PLAYER_SPEED_SUBTILES_PER_100_TICKS = 5_120;

// --- the assisted tier (plan §3's middle rung, on three ladders at once) ---------------
//
// §1 states what "assisted" MEANS mechanically and it is a design rule rather than flavour:
// *"Tedium may live only in walking and waiting — the two things automation removes. The hand
// actions themselves stay delightful forever."* An assisted tool COMPRESSES TRIPS and never
// REPLACES THE VERB. The scythe still wants you to walk the row and swing; it just pays three
// tiles for the swing. The cart still wants you to walk; it just carries more while you do.
//
// **THE BARREL SPRINKLER IS `MachineKind.Sprinkler`, AND IT HAS BEEN SINCE v0.1.** Item 023 asks
// for a distinct, cheaper Barrel on the grounds that item 011 disclaimed the $150 sprinkler as
// "the automated feel" — and re-reading the machine that actually shipped, that disclaimer is
// what is wrong, not the machine. It has a real `tankCapacityMl`, it is filled BY CAN through
// `RefillHopper`, it counts a `hopperRefill` touch, it shows `LampState.UtilityMissing` when it
// runs dry, and it stops when the barrel is empty. That is the assisted rung, in full, down to
// the lamp. The automated rung is the piped head at $250 and the Hub at $900, which need no
// filling at all — so the ladder is 0 → $150 → $250 → $900 and no rung is missing.
//
// Shipping a second machine with identical behaviour and a lower price would be two names for one
// rule, two prices for one object, and a build menu asking the player to decide something the
// design already decided — the exact argument `MachineKind.BeltJunction` makes about splitters and
// mergers. The debt item 023 was filed to pay was a LABEL, and this paragraph pays it.

/**
 * Subtiles per 100 ticks a hitched hand cart costs the player.
 *
 * **A DEDUCTION IN THE SAME UNITS AS THE SPEED, NEVER A FLOAT MULTIPLIER** (item 023's criterion,
 * stated exactly that way). `PlayerState.moveAccum` already carries movement in hundredths of a
 * subtile precisely so a rate that does not divide evenly stays exact, so a tow is one subtraction
 * inside that accumulator and nothing anywhere becomes fractional.
 *
 * 1,280 of 5,120 is a quarter: four tiles a second becomes three. Slow enough to feel in the legs
 * on a 64-tile lot, nowhere near slow enough to make the cart a mistake to own.
 */
export const TOW_SPEED_PENALTY_SUBTILES_PER_100_TICKS = 1_280;

/**
 * How many tiles one scythe swing cuts, and it is three because §3's table says
 * *"Push-scythe, 3-wide"*.
 *
 * The three are PERPENDICULAR TO THE PLAYER'S FACING and centred on the tile swung at, so walking
 * a row and swinging cuts a swathe the width of the row — which is the gesture the name describes.
 * Unready tiles cost nothing and are left exactly as they were; a swing that finds one ripe tile
 * and two bare ones harvests the one.
 */
export const SCYTHE_SWATHE_TILES = 3;

// --- Agri-Bots (plan §3's automated rung of harvesting) --------------------------------

/**
 * Subtiles per 100 ticks a bot walks. **Deliberately slower than the farmer.**
 *
 * 3,072 is 2.4 tiles a second against the player's 4. A bot that outran you would make the
 * automated rung feel like a cheat rather than a delegation, and §8's release gate for this
 * feature is whether the player *watches with pride or alt-tabs* — something visibly plodding
 * about its business is more watchable than something that blinks between tiles.
 *
 * It rides the same accumulator the player does, through the same function: see `movement.ts`.
 */
export const BOT_SPEED_SUBTILES_PER_100_TICKS = 3_072;

/** How many goods a harvester carries before it must walk back to the dock. */
export const BOT_CARRY_CAPACITY = 8;

/**
 * Seeds a harvester's POCKET holds before the pocket is what sends it home (item 088).
 *
 * Level with `BOT_CARRY_CAPACITY` on purpose: a one-shot crop returns one seed per tile and an
 * armful is a handful of tiles, so a bot that filled its arms and a bot that filled its pocket
 * are the same bot on the same trip. Setting this lower would invent a second, earlier trip
 * home that the produce cap does not; setting it higher would mean a full pocket is a state the
 * game only reaches when something downstream is already broken — which is exactly when a stall
 * needs to be legible rather than novel.
 */
export const BOT_SEED_POCKET_CAPACITY = 8;

/**
 * Seeds the harvester dock's SEED SHELF holds (item 088). One armful-scale slot, not a silo.
 *
 * ARMFUL SCALE IS THE POINT. The shelf is a place for seeds to WAIT for a belt, not a place to
 * keep them: 20 is a few round trips' worth, so a player who builds a harvester and no way for
 * the seeds to leave finds out within a round or two — a robot standing at a full shed, which
 * is visible from ten tiles up. A shelf big enough to never fill would hide the missing half of
 * the loop for an hour and then dump the problem on somebody mid-session.
 */
export const HARVESTER_SEED_SHELF_CAPACITY = 20;

/**
 * Condition one completed operation costs a bot. **PER OPERATION, NEVER PER TICK OR PER MINUTE**
 * — §4 names this case explicitly: *"Agri-Bot upkeep is per-harvest-op, not weekly."*
 *
 * That is a direct instruction against the obvious design. Time-based upkeep would charge a player
 * for leaving the tab open, which contradicts §6's clock outright, and a docked idle bot would
 * rust while nothing happened. Here a bot that never harvests never wears, forever, and
 * `test/bots.test.ts` pins exactly that over 10,000 ticks.
 *
 * Two per op against `CONDITION_MAX` of 1,000 is 500 harvests to the floor — a long afternoon,
 * and repaired for free by hand at the dock like everything else.
 */
export const BOT_WEAR_PER_OPERATION = 2;

/**
 * Ticks a bot pauses at a tile to do the work, and at the dock to unload.
 *
 * It exists for the same reason `DEPOT_LOAD_TICKS` does: an action that happened between two
 * ticks is an action the renderer has nothing to draw. Half an active second is a bend-down.
 */
export const BOT_WORK_TICKS = 10;

/**
 * How long a walk-to errand may live before the sim gives up on it, in ticks.
 *
 * SIXTY SECONDS IS NOT A BALANCE NUMBER, IT IS A DEADLOCK BREAKER. The longest honest walk on
 * the FULL 64×64 lot is corner to corner — 63 tiles each way, so 89.1 tiles diagonally, less
 * the errand's own 1.5 tiles of reach: 87.6 tiles, or 21.9 seconds at four tiles a second. So
 * anything still walking at sixty is not walking, it is stuck: clamped against the world edge,
 * or aimed at something it can never quite reach. An errand that cannot expire is a farmer who
 * can never move again, which is a far worse bug than a click that quietly gave up, so the
 * ceiling is generous and absolute rather than tuned.
 *
 * IT MOVED FROM 600 TO 1200 WHEN LAND DEEDS QUADRUPLED THE LOT'S WIDTH, and the arithmetic is
 * why rather than the round number. At 600 ticks the margin over the longest honest walk was
 * 1.37×, which is not a deadlock breaker any more — it is a timer that starts cancelling
 * errands that were merely long, on a map where crossing the whole lot is a thing a player
 * will do. At 1200 the margin is 2.7×, near the 5.3× the 16×16 lot enjoyed. Anything that
 * makes the world bigger again must redo this sum.
 */
export const WALK_ERRAND_TIMEOUT_TICKS = 1_200;

/** One net-worth sample per active minute; ten hours of history for the Peak Flow board. */
export const NET_WORTH_SAMPLE_PERIOD_TICKS = 1_200;
export const NET_WORTH_SAMPLE_LIMIT = 600;

// --- balance version --------------------------------------------------------------

/** One recipe, as a string. `2x11|1x23` reads "two of item 11 and one of item 23". */
function recipeDigest(inputs: readonly RecipeInput[]): string {
  let out = '';
  for (let i = 0; i < inputs.length; i++) {
    const line = inputs[i]!;
    out += `${i === 0 ? '' : '|'}${line.count}x${line.item}`;
  }
  return out;
}

/** One machine's typed ports, as a string. Ports are ordered, so this is order-sensitive. */
function portsDigest(ports: readonly LiquidPortSpec[]): string {
  let out = '';
  for (let i = 0; i < ports.length; i++) {
    const port = ports[i]!;
    out += `${i === 0 ? '' : '|'}${port.liquid}/${port.flow}/${port.capacityMl}/${port.intakeMlPerTick}/${port.mlPerOperation}`;
  }
  return out;
}

function balanceDigest(): string {
  let h = fnv1aInit();
  for (let i = 0; i < ITEM_SPECS.length; i++) {
    const spec = ITEM_SPECS[i]!;
    h = fnv1aString(
      h,
      `${spec.id}:${spec.slug}:${spec.listPriceCents}:${spec.purchasable}:${spec.sellable}`,
    );
  }
  for (let i = 0; i < CROP_SPECS.length; i++) {
    const spec = CROP_SPECS[i]!;
    h = fnv1aString(
      h,
      `${spec.id}:${spec.slug}:${spec.growthTicks}:${spec.growthVariancePermille}:${spec.seedItem}:${spec.yieldItem}:${spec.regrowTicks}:${spec.moistureDrainPerTick}:${spec.requiresTech}`,
    );
  }
  for (let i = 0; i < MACHINE_SPECS.length; i++) {
    const spec = MACHINE_SPECS[i]!;
    h = fnv1aString(
      h,
      `${spec.kind}:${spec.slug}:${spec.role}:${spec.tilesWide}x${spec.tilesHigh}:${spec.priceCents}:${spec.workPerOperation}:${spec.workRatePerTick}:${spec.inputCapacity}:${spec.outputCapacity}:${spec.tankCapacityMl}:${spec.wearPerOperation}:${recipeDigest(spec.inputs)}:${spec.outputItem}:${spec.overcookOutputItem}:${spec.requiresTech}:${spec.liquid}:${portsDigest(spec.ports)}:${spec.pumpRateMlPerMinute}:${spec.intakeMlPerTick}:${spec.coverageRadiusTiles}:${spec.moistureSensing}:${spec.fieldPlaceable}`,
    );
    // **THE ALTERNATE RECIPES ARE BALANCE DATA TOO** (item 111). `spec.inputs` above is only
    // the plain one, so without this line the entire flavour tier — every premium recipe and
    // every price it implies — could be rewritten without the digest noticing. Folded in after
    // the spec's own line so a machine with no alternates digests exactly as it did before.
    const recipes = machineRecipes(spec);
    for (let r = 0; r < recipes.length; r++) {
      const recipe = recipes[r]!;
      h = fnv1aString(h, `${spec.kind}/r${r}:${recipeDigest(recipe.consumes)}:${recipe.output}`);
    }
  }
  for (let i = 0; i < LIQUID_SPECS.length; i++) {
    const spec = LIQUID_SPECS[i]!;
    h = fnv1aString(h, `${spec.id}:${spec.slug}:${spec.tintRgb}`);
  }
  for (let i = 0; i < BELT_SPECS.length; i++) {
    const spec = BELT_SPECS[i]!;
    h = fnv1aString(
      h,
      `${spec.tier}:${spec.slug}:${spec.speedSubtilesPer100Ticks}:${spec.priceCentsPerTile}:${spec.requiresTech}`,
    );
  }
  for (let i = 0; i < GRABBER_SPECS.length; i++) {
    const spec = GRABBER_SPECS[i]!;
    h = fnv1aString(
      h,
      `${spec.tier}:${spec.slug}:${spec.swingTicks}:${spec.reachTiles}:${spec.priceCents}:${spec.filterable}:${spec.requiresTech}`,
    );
  }
  for (let i = 0; i < TECH_NODES.length; i++) {
    const node = TECH_NODES[i]!;
    h = fnv1aString(
      h,
      `${node.id}:${node.branch}:${node.priceCents}:${node.requires.join('|')}:${node.milestone}:${node.milestoneAmount}`,
    );
  }
  h = fnv1aString(
    h,
    `${MOISTURE_MAX}:${MOISTURE_DRAIN_PER_TICK}:${GROWTH_PER_WATERED_TICK}:${HAND_POUR_ML}:${CAN_CHARGES_MAX}:${SPRINKLER_POUR_ML}:${SPRINKLER_PERIOD_TICKS}:${SPRINKLER_RADIUS_TILES}:${CONDITION_MAX}:${CONDITION_EFFECT_THRESHOLD}:${STARTING_MONEY_CENTS}:${STARTING_SEEDS}:${PLAYER_SPEED_SUBTILES_PER_100_TICKS}:${HAND_REACH_SUBTILES}:${WALK_ERRAND_TIMEOUT_TICKS}`,
  );
  h = fnv1aString(
    h,
    `${AUTO_REPLANT_PERIOD_TICKS}:${ZONE_PAINT_MAX_SPAN}:${BELT_ITEM_SPACING_SUBTILES}:${BELT_MAX_LENGTH_TILES}:${WORK_RATE_SCALE}`,
  );
  h = fnv1aString(
    h,
    `${UPGRADE_MAX_LEVEL}:${SPEED_RATE_BONUS_PERCENT_PER_LEVEL}:${SPEED_WEAR_PENALTY_PERCENT_PER_LEVEL}:${EFFICIENCY_WEAR_CUT_PERCENT_PER_LEVEL}:${EFFICIENCY_WASTE_STRETCH_PERCENT_PER_LEVEL}:${CAPACITY_BONUS_PER_LEVEL}:${UPGRADE_COST_PERCENT_BY_LEVEL.join('|')}:${UPGRADE_COST_PERCENT_BY_DIAL[UpgradeDial.Speed]}/${UPGRADE_COST_PERCENT_BY_DIAL[UpgradeDial.Efficiency]}/${UPGRADE_COST_PERCENT_BY_DIAL[UpgradeDial.Capacity]}`,
  );
  // Maintenance and overcooking. The two condition constants are already folded in above with
  // the world numbers; everything a worn or neglected machine actually *does* is here.
  h = fnv1aString(
    h,
    `${REPAIR_PER_TOUCH}:${JAM_EVERY_N_OPERATIONS_WHEN_WORN}:${WASTE_PERIOD_AT_THRESHOLD}:${WASTE_PERIOD_AT_ZERO}:${REPAIR_KIT_PRICE_CENTS}:${REPAIR_KIT_RADIUS_TILES}:${OVERCOOK_BLOCKED_TICKS}:${RUSTIC_STYLE_NUMERATOR}/${RUSTIC_STYLE_DENOMINATOR}:${STATION_SERVICE_PERIOD_TICKS}:${DRONE_PART_PRICE_CENTS}`,
  );
  // The soda line's derived prices. The bundle premiums are ratios rather than literals, so the
  // digest folds in the ratio — a repriced bag of chips moves the Combo, and the digest with it.
  h = fnv1aString(
    h,
    `${SODA_PRICE_CENTS}:${SIX_PACK_COUNT}:${SIX_PACK_PREMIUM_NUMERATOR}/${SIX_PACK_PREMIUM_DENOMINATOR}:${SNACK_COMBO_PREMIUM_NUMERATOR}/${SNACK_COMBO_PREMIUM_DENOMINATOR}`,
  );
  // Boxing and scrapping. The RATIO rather than a payout table, for the same reason the bundle
  // premiums above are ratios — a repriced machine moves what its box fetches, and the digest
  // moves with it. The kind→item map is folded in too: which machine is in which box is the one
  // fact a save cannot survive being wrong about.
  h = fnv1aString(h, `${SCRAP_PAYOUT_NUMERATOR}/${SCRAP_PAYOUT_DENOMINATOR}`);
  for (let i = 0; i < BOXED_MACHINE_ROWS.length; i++) {
    const row = BOXED_MACHINE_ROWS[i]!;
    h = fnv1aString(h, `${row.kind}>${row.item}`);
  }
  // Retirement (item 090). A machine leaving the catalogue changes nothing about the numbers in
  // its spec and everything about what a player can do with them, so `MACHINE_SPECS` above folds
  // in a Parts Bench that is identical to yesterday's and this line is the only thing that says
  // it can no longer be bought. Without it, the biggest balance change of the item — a whole
  // production chain retired and automated maintenance made free — would leave `SIM_VERSION`
  // claiming the save was written by the same rules, which is the exact lie the digest exists
  // to make impossible.
  for (let i = 0; i < RETIRED_MACHINE_KINDS.length; i++) {
    h = fnv1aString(h, `retired:${RETIRED_MACHINE_KINDS[i]!}`);
  }
  // Land. THE MAP'S SHAPE IS BALANCE DATA, not layout trivia: a save records which parcels are
  // owned as indices into this grid, so a world balanced on a 4×4 lot of 16-tile parcels cannot
  // be read against a 3×3 one — parcel 5 would be somewhere else entirely. The deed ladder rides
  // along for the ordinary reason every other price does.
  h = fnv1aString(
    h,
    `${PARCEL_TILES}:${PARCELS_WIDE}x${PARCELS_HIGH}:${STARTING_PARCEL}:${DEED_PRICE_CENTS_BY_PURCHASE.join('|')}`,
  );
  // Selling above the stand. Run durations are the load-bearing half: a saved world can hold a
  // cart or a truck mid-journey, and a build that shortened the trip would describe that world's
  // in-flight timer as a different fraction of a run than the build that wrote it. The road's
  // column rides along because it is the origin every one of those durations is measured from.
  h = fnv1aString(
    h,
    `${ROAD_EDGE_TILE_X}:${RUN_TICKS_PER_TILE_FROM_ROAD}:${CART_RUN_BASE_TICKS}:${CART_CAPACITY}:${DEPOT_RUN_BASE_TICKS}:${DEPOT_LOAD_TICKS}:${DEPOT_STOCK_CAPACITY}:${DEPOT_MAX_CONTRACTS}:${CONTRACT_MAX_QUANTITY}:${DESTINATION_MAX_LENGTH}`,
  );
  // The return leg (item 131). `MACHINE_SPECS` above already folds in the two baskets' capacity
  // and the Washer's new recipe, so this line is the half that lives in a table of its own: which
  // products come home as empties, what they come home AS, and how many. Change a Six-Pack from
  // six bottles to four and a saved world's in-flight lorry is carrying a different future.
  for (let i = 0; i < EMPTIES_PER_DELIVERY.length; i++) {
    const row = EMPTIES_PER_DELIVERY[i]!;
    h = fnv1aString(h, `empties:${row.item}>${row.returnsItem}x${row.count}`);
  }
  h = fnv1aString(h, `${VEHICLE_EMPTIES_CAPACITY}:${USED_BOTTLE_SCRAP_CENTS}`);
  // Soil. A tile's soil is rolled once and saved, and the modifiers are read every time a crop is
  // sown on it — so a build that retuned sand would grow a different crop on the same saved tile.
  for (let i = 0; i < SOIL_SPECS.length; i++) {
    const spec = SOIL_SPECS[i]!;
    h = fnv1aString(
      h,
      `${spec.id}:${spec.slug}:${spec.growthPermille}:${spec.moistureDrainPermille}`,
    );
  }
  // What one harvest pays before the coin (item 124). It replaced the whole freshness and
  // fertility block that used to be digested here — the per-item windows, the bucket, the stack
  // cap, the crate, the compost ratios, the fertility bounds and the container ageing table —
  // and it is load-bearing for the one reason any of those were: a saved world's next harvest is
  // counted with it, so a build that changed it would pay a saved field differently.
  h = fnv1aString(h, `harvest:${HARVEST_BASE_COUNT}:cellar:${ROOT_CELLAR_CAPACITY}`);
  // The assisted tier and the bots. Every one of these is a rate or a capacity a saved world is
  // mid-way through spending: a hitched cart's next step, a bot's next harvest, a swing's width.
  h = fnv1aString(
    h,
    `${TOW_SPEED_PENALTY_SUBTILES_PER_100_TICKS}:${SCYTHE_SWATHE_TILES}:${BOT_SPEED_SUBTILES_PER_100_TICKS}:${BOT_CARRY_CAPACITY}:${BOT_SEED_POCKET_CAPACITY}:${HARVESTER_SEED_SHELF_CAPACITY}:${BOT_WEAR_PER_OPERATION}:${BOT_WORK_TICKS}`,
  );
  return fnv1aToHex(h);
}

/**
 * A digest of every number above. Saves record it; a mismatch on load means the world was
 * balanced under different data and needs a migration rather than a shrug.
 */
export const BALANCE_HASH = balanceDigest();
