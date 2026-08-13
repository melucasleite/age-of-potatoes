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

export const CropId = {
  None: 0,
  RussetPotato: 1,
  SugarCane: 2,
  Corn: 3,
  ChiliPepper: 4,
} as const;

export type CropId = (typeof CropId)[keyof typeof CropId];

/**
 * Plan §5 caps the recipe graph at ~50 items. We are at **26 items plus 5 liquids = 31 nodes**
 * (the soda line spent 6 item slots and 4 liquid slots). Numeric values are permanent — they
 * are in every save and on every belt.
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

  /** Wilted produce. Sells at half list as "Day-Old" — a discount, never a hole (plan §4). */
  DayOldPotato: 8,

  /** What an unharvested wilted crop collapses into. Nothing ever vanishes (plan §4). */
  Compost: 9,

  CaneSeed: 10,
  SugarCane: 11,
  DayOldCane: 12,

  CornSeed: 13,
  Corn: 14,
  DayOldCorn: 15,

  ChiliSeed: 16,
  ChiliPepper: 17,
  DayOldChili: 18,

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
 * call, and the same shape as `dayOldPriceCents` for the same reason.
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
 * The end of the chip chain, hoisted for the same reason seasoned chips are: the Snack Combo's
 * price is arithmetic on it rather than a second literal that drifts.
 */
export const BAGGED_CHIPS_PRICE_CENTS = 2000;

/** Plan §4: "syrup + carbonated water + bottle → soda (~$16)". This is the ~$16. */
export const SODA_PRICE_CENTS = 1600;

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
 * Day-Old prices are `floor(list / 2)` — see `DAY_OLD_NUMERATOR` below, which is the one
 * place that ratio is written. `test/sim.test.ts` asserts the table agrees with it, so the
 * literals here can never drift away from the rule.
 */
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
    listPriceCents: 200,
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
    listPriceCents: 300,
    purchasable: false,
    sellable: true,
  },
  {
    id: ItemId.PotatoSlices,
    slug: 'potato-slices',
    listPriceCents: 450,
    purchasable: false,
    sellable: true,
  },
  {
    id: ItemId.PlainChips,
    slug: 'plain-chips',
    listPriceCents: 900,
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
  {
    id: ItemId.DayOldPotato,
    slug: 'day-old-potato',
    listPriceCents: 100,
    purchasable: false,
    sellable: true,
  },
  { id: ItemId.Compost, slug: 'compost', listPriceCents: 20, purchasable: false, sellable: true },
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
    id: ItemId.DayOldCane,
    slug: 'day-old-cane',
    listPriceCents: 125,
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
  { id: ItemId.Corn, slug: 'corn', listPriceCents: 220, purchasable: false, sellable: true },
  {
    id: ItemId.DayOldCorn,
    slug: 'day-old-corn',
    listPriceCents: 110,
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
    listPriceCents: 300,
    purchasable: false,
    sellable: true,
  },
  {
    id: ItemId.DayOldChili,
    slug: 'day-old-chili',
    listPriceCents: 150,
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
];

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

// --- withering and spoilage -------------------------------------------------------
//
// Plan §7 ruling 6: "spoilage teaches layout, not panic." Every number below was softened
// deliberately and none of them should be tightened to "make it feel like a game".

/**
 * In-ground grace after a crop matures: ~30 active minutes (plan §4, §7 ruling 6). An
 * active hour is 72,000 ticks, so a minute is 1,200 and thirty of them is this.
 *
 * The stated reason for the length: plan §2's staggered horizons put the player's own
 * build projects at 15 minutes or more, and a grace shorter than that would make every long
 * build interruptible by dirt.
 */
export const WILT_GRACE_TICKS = 36_000;
/** The telegraphed droop before the crop actually turns — five active minutes of warning. */
export const WILT_WINDOW_TICKS = 6_000;
/** How long a wilted crop sits pickable before it collapses into compost. Ten minutes. */
export const COMPOST_AFTER_TICKS = 12_000;
/** What one collapsed crop leaves on the tile. Nothing vanishes (plan §4). */
export const COMPOST_PER_CROP = 1;

/**
 * The Day-Old ratio, written once. Money is cents and nothing here divides by 100, so the
 * rounding policy is stated rather than implied: floor, always, in the player's favour
 * nowhere and against them nowhere.
 */
export const DAY_OLD_NUMERATOR = 1;
export const DAY_OLD_DENOMINATOR = 2;

/** Half of list, floored. The one function anything charging for Day-Old goods may call. */
export function dayOldPriceCents(freshItem: ItemId): number {
  return divFloor(listPriceCents(freshItem) * DAY_OLD_NUMERATOR, DAY_OLD_DENOMINATOR);
}

/** Freshness of a matured tile, derived from its age. There is no clock but the tick. */
export const WiltStage = {
  /** Growing, or mature and inside its grace. */
  Fresh: 0,
  /** Mature, past grace, visibly drooping. Still harvests as the fresh good. */
  Wilting: 1,
  /** Turned. Harvests as the Day-Old good; collapses to compost if left. */
  Wilted: 2,
} as const;

export type WiltStage = (typeof WiltStage)[keyof typeof WiltStage];

/** Which freshness band a matured tile's age falls in. Pure arithmetic, no rolls. */
export function wiltStageForAge(readyAge: number): WiltStage {
  if (readyAge < WILT_GRACE_TICKS) return WiltStage.Fresh;
  if (readyAge < WILT_GRACE_TICKS + WILT_WINDOW_TICKS) return WiltStage.Wilting;
  return WiltStage.Wilted;
}

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
  /** What a harvest yields, before the fertility and bonus terms. */
  readonly yieldItem: ItemId;
  /** What a *wilted* harvest yields instead. Half price, badged Day-Old. */
  readonly dayOldItem: ItemId;
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
    dayOldItem: ItemId.DayOldPotato,
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
    dayOldItem: ItemId.DayOldCane,
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
    dayOldItem: ItemId.DayOldCorn,
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
    dayOldItem: ItemId.DayOldChili,
    stageCount: 5,
    regrowTicks: 45 * TICKS_PER_SECOND,
    moistureDrainPerTick: 1,
    requiresTech: TechId.Chili,
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

export const FERTILITY_MIN = 1;
export const FERTILITY_MAX = 3;

/** One pour from the can. */
export const HAND_POUR_ML = 2000;
/** One sprinkler head servicing one tile. Wetting an already-wet tile still costs water. */
export const SPRINKLER_POUR_ML = 1500;

// --- reservoirs -------------------------------------------------------------------
//
// Plan §4: "Reservoirs ~10,000 units recharging ~20 u/min; overdraw is telegraphed
// (shoreline recedes, mud ring), pumps halve below 25% and sip at recharge rate when empty —
// reservoirs always recover. ... The watering can always fills at any shore at any level."
//
// THE DERIVATION, WRITTEN DOWN BECAUSE EVERY LATER WATER NUMBER COMES OUT OF IT.
// §4's "unit" is a design-scale quantity, not a millilitre. The two drain rates that already
// exist decide what one is worth: `HAND_POUR_ML` is 2,000 and `SPRINKLER_POUR_ML` is 1,500,
// so a "unit" is one pour — call it the can's, the larger of the two. Then:
//
//   capacity  10,000 units × 2,000 ml = 20,000,000 ml = 20,000 L   — a pond, not a bucket
//   recharge      20 units/min × 2,000 ml =  40,000 ml/min = 40 L/min
//
// Sanity, which is the point of doing it out loud: one dumb sprinkler head wets 25 tiles per
// 100 ticks at 1,500 ml a tile, which is 450 L/min — eleven times the recharge, and it drains
// a full pond in about 45 active minutes. That is a budget the player can feel inside one
// session without ever being stopped, which is exactly the pressure §4 asks for.

/** One §4 "unit" of water, in millilitres: one pour from the can. */
export const RESERVOIR_UNIT_ML = HAND_POUR_ML;
/** §4's "~10,000 units". */
export const RESERVOIR_CAPACITY_UNITS = 10_000;
export const RESERVOIR_CAPACITY_ML = RESERVOIR_CAPACITY_UNITS * RESERVOIR_UNIT_ML;
/** §4's "~20 u/min". Per minute, because it is not a whole number of ml per tick. */
export const RESERVOIR_RECHARGE_UNITS_PER_MINUTE = 20;
export const RESERVOIR_RECHARGE_ML_PER_MINUTE =
  RESERVOIR_RECHARGE_UNITS_PER_MINUTE * RESERVOIR_UNIT_ML;

/**
 * "Pumps halve below 25%" — 250 permille of capacity, and the one place that threshold is
 * written. Below it a pump runs at half rate; at a level of exactly zero it sips at the
 * recharge rate instead, which is the clause that guarantees a pond always recovers.
 */
export const RESERVOIR_LOW_PERMILLE = 250;

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
} as const;

export type MachineRole = (typeof MachineRole)[keyof typeof MachineRole];

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
   * line with a count of six. `machine.inputCounts` is sized from this and indexed by it.
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
    tankCapacityMl: 30_000,
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
    moistureSensing: false,
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
  },
  {
    // THE TOP RUNG OF PLAN §3'S WATERING LADDER, and deliberately no better at watering than
    // the barrel it replaces: same pour, same period, same radius. The only thing it buys is
    // that you never fill it again. An automated tier that also waters *better* would make
    // the lower rungs rot, and plan §1 says manual never rots.
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
    /** Ten pours of head-room, so a brief throttle does not stop the cycle dead. */
    tankCapacityMl: 15_000,
    wearPerOperation: 0,
    inputs: [],
    outputItem: null,
    overcookOutputItem: null,
    requiresTech: TechId.PipedSprinklers,
    liquid: LiquidId.Water,
    ports: [],
    pumpRateMlPerMinute: 0,
    /** 400 ml/tick — a touch over the 375 it averages, so it stays topped up when it can. */
    intakeMlPerTick: 400,
    coverageRadiusTiles: SPRINKLER_RADIUS_TILES,
    moistureSensing: false,
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
    /** The hottest thing on the soda side, and the only one there that wears like a Fryer. */
    wearPerOperation: 3,
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
  },
];

export function machineSpec(kind: MachineKind): MachineSpec | null {
  for (let i = 0; i < MACHINE_SPECS.length; i++) {
    const spec = MACHINE_SPECS[i]!;
    if (spec.kind === kind) return spec;
  }
  return null;
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

export const WORLD_TILES_WIDE = 16;
export const WORLD_TILES_HIGH = 16;

/** v0.1 is one fixed 8×8 field (plan §16). The 64×64 map is a renderer-side change. */
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

/**
 * How long a walk-to errand may live before the sim gives up on it, in ticks.
 *
 * THIRTY SECONDS IS NOT A BALANCE NUMBER, IT IS A DEADLOCK BREAKER. The longest honest walk
 * in a 16×16 world is corner to corner — about 22.6 tiles, or 5.7 seconds at four tiles a
 * second — so anything still walking at thirty is not walking, it is stuck: clamped against
 * the world edge, or aimed at something it can never quite reach. An errand that cannot
 * expire is a farmer who can never move again, which is a far worse bug than a click that
 * quietly gave up, so the ceiling is generous and absolute rather than tuned.
 */
export const WALK_ERRAND_TIMEOUT_TICKS = 600;

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
      `${spec.id}:${spec.slug}:${spec.growthTicks}:${spec.growthVariancePermille}:${spec.seedItem}:${spec.yieldItem}:${spec.dayOldItem}:${spec.regrowTicks}:${spec.moistureDrainPerTick}:${spec.requiresTech}`,
    );
  }
  for (let i = 0; i < MACHINE_SPECS.length; i++) {
    const spec = MACHINE_SPECS[i]!;
    h = fnv1aString(
      h,
      `${spec.kind}:${spec.slug}:${spec.role}:${spec.tilesWide}x${spec.tilesHigh}:${spec.priceCents}:${spec.workPerOperation}:${spec.workRatePerTick}:${spec.inputCapacity}:${spec.outputCapacity}:${spec.tankCapacityMl}:${spec.wearPerOperation}:${recipeDigest(spec.inputs)}:${spec.outputItem}:${spec.overcookOutputItem}:${spec.requiresTech}:${spec.liquid}:${portsDigest(spec.ports)}:${spec.pumpRateMlPerMinute}:${spec.intakeMlPerTick}:${spec.coverageRadiusTiles}:${spec.moistureSensing}`,
    );
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
    `${MOISTURE_MAX}:${MOISTURE_DRAIN_PER_TICK}:${GROWTH_PER_WATERED_TICK}:${HAND_POUR_ML}:${SPRINKLER_POUR_ML}:${SPRINKLER_PERIOD_TICKS}:${SPRINKLER_RADIUS_TILES}:${CONDITION_MAX}:${CONDITION_EFFECT_THRESHOLD}:${STARTING_MONEY_CENTS}:${STARTING_SEEDS}:${PLAYER_SPEED_SUBTILES_PER_100_TICKS}:${HAND_REACH_SUBTILES}:${WALK_ERRAND_TIMEOUT_TICKS}`,
  );
  h = fnv1aString(
    h,
    `${WILT_GRACE_TICKS}:${WILT_WINDOW_TICKS}:${COMPOST_AFTER_TICKS}:${COMPOST_PER_CROP}:${DAY_OLD_NUMERATOR}/${DAY_OLD_DENOMINATOR}:${AUTO_REPLANT_PERIOD_TICKS}:${ZONE_PAINT_MAX_SPAN}:${BELT_ITEM_SPACING_SUBTILES}:${BELT_MAX_LENGTH_TILES}:${WORK_RATE_SCALE}`,
  );
  h = fnv1aString(
    h,
    `${UPGRADE_MAX_LEVEL}:${SPEED_RATE_BONUS_PERCENT_PER_LEVEL}:${SPEED_WEAR_PENALTY_PERCENT_PER_LEVEL}:${EFFICIENCY_WEAR_CUT_PERCENT_PER_LEVEL}:${EFFICIENCY_WASTE_STRETCH_PERCENT_PER_LEVEL}:${CAPACITY_BONUS_PER_LEVEL}:${UPGRADE_COST_PERCENT_BY_LEVEL.join('|')}:${UPGRADE_COST_PERCENT_BY_DIAL[UpgradeDial.Speed]}/${UPGRADE_COST_PERCENT_BY_DIAL[UpgradeDial.Efficiency]}/${UPGRADE_COST_PERCENT_BY_DIAL[UpgradeDial.Capacity]}`,
  );
  // Maintenance and overcooking. The two condition constants are already folded in above with
  // the world numbers; everything a worn or neglected machine actually *does* is here.
  h = fnv1aString(
    h,
    `${REPAIR_PER_TOUCH}:${JAM_EVERY_N_OPERATIONS_WHEN_WORN}:${WASTE_PERIOD_AT_THRESHOLD}:${WASTE_PERIOD_AT_ZERO}:${REPAIR_KIT_PRICE_CENTS}:${REPAIR_KIT_RADIUS_TILES}:${OVERCOOK_BLOCKED_TICKS}:${RUSTIC_STYLE_NUMERATOR}/${RUSTIC_STYLE_DENOMINATOR}`,
  );
  // The soda line's derived prices. The bundle premiums are ratios rather than literals, so the
  // digest folds in the ratio — a repriced bag of chips moves the Combo, and the digest with it.
  h = fnv1aString(
    h,
    `${SODA_PRICE_CENTS}:${SIX_PACK_COUNT}:${SIX_PACK_PREMIUM_NUMERATOR}/${SIX_PACK_PREMIUM_DENOMINATOR}:${SNACK_COMBO_PREMIUM_NUMERATOR}/${SNACK_COMBO_PREMIUM_DENOMINATOR}`,
  );
  return fnv1aToHex(h);
}

/**
 * A digest of every number above. Saves record it; a mismatch on load means the world was
 * balanced under different data and needs a migration rather than a shrug.
 */
export const BALANCE_HASH = balanceDigest();
