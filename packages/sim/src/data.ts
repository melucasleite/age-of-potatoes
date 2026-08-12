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
 * Plan §5 caps the recipe graph at ~50 items. We are at 19. Numeric values are permanent —
 * they are in every save and on every belt.
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
} as const;

export type MachineKind = (typeof MachineKind)[keyof typeof MachineKind];

// --- items ------------------------------------------------------------------------

export interface ItemSpec {
  readonly id: ItemId;
  /** Stable slug for the renderer's atlas lookup and for save debugging. */
  readonly slug: string;
  /** List price in cents. Everything is sellable (plan §5). */
  readonly listPriceCents: number;
  /** True for items the roadside stand will sell *to* the player. Seeds, for now. */
  readonly purchasable: boolean;
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
  { id: ItemId.PotatoSeed, slug: 'potato-seed', listPriceCents: 50, purchasable: true },
  { id: ItemId.RussetPotato, slug: 'russet-potato', listPriceCents: 200, purchasable: false },
  { id: ItemId.BaggedChips, slug: 'bagged-chips', listPriceCents: 2000, purchasable: false },
  { id: ItemId.WashedPotato, slug: 'washed-potato', listPriceCents: 300, purchasable: false },
  { id: ItemId.PotatoSlices, slug: 'potato-slices', listPriceCents: 450, purchasable: false },
  { id: ItemId.PlainChips, slug: 'plain-chips', listPriceCents: 900, purchasable: false },
  { id: ItemId.SeasonedChips, slug: 'seasoned-chips', listPriceCents: 1400, purchasable: false },
  { id: ItemId.DayOldPotato, slug: 'day-old-potato', listPriceCents: 100, purchasable: false },
  { id: ItemId.Compost, slug: 'compost', listPriceCents: 20, purchasable: false },
  { id: ItemId.CaneSeed, slug: 'cane-seed', listPriceCents: 80, purchasable: true },
  { id: ItemId.SugarCane, slug: 'sugar-cane', listPriceCents: 250, purchasable: false },
  { id: ItemId.DayOldCane, slug: 'day-old-cane', listPriceCents: 125, purchasable: false },
  { id: ItemId.CornSeed, slug: 'corn-seed', listPriceCents: 70, purchasable: true },
  { id: ItemId.Corn, slug: 'corn', listPriceCents: 220, purchasable: false },
  { id: ItemId.DayOldCorn, slug: 'day-old-corn', listPriceCents: 110, purchasable: false },
  { id: ItemId.ChiliSeed, slug: 'chili-seed', listPriceCents: 90, purchasable: true },
  { id: ItemId.ChiliPepper, slug: 'chili-pepper', listPriceCents: 300, purchasable: false },
  { id: ItemId.DayOldChili, slug: 'day-old-chili', listPriceCents: 150, purchasable: false },
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
  /** Pours from its own barrel on a period. */
  Sprinkler: 2,
} as const;

export type MachineRole = (typeof MachineRole)[keyof typeof MachineRole];

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
  readonly inputItem: ItemId | null;
  readonly outputItem: ItemId | null;
  /** The node that makes this machine buildable, or null for the v0.1 three. */
  readonly requiresTech: string | null;
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
    inputItem: null,
    outputItem: null,
    requiresTech: null,
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
    inputItem: ItemId.RussetPotato,
    outputItem: ItemId.BaggedChips,
    requiresTech: null,
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
    inputItem: null,
    outputItem: null,
    requiresTech: null,
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
    inputItem: ItemId.RussetPotato,
    outputItem: ItemId.WashedPotato,
    requiresTech: TechId.WashAndSlice,
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
    inputItem: ItemId.WashedPotato,
    outputItem: ItemId.PotatoSlices,
    requiresTech: TechId.WashAndSlice,
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
    inputItem: ItemId.PotatoSlices,
    outputItem: ItemId.PlainChips,
    requiresTech: TechId.Fryer,
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
    inputItem: ItemId.PlainChips,
    outputItem: ItemId.SeasonedChips,
    requiresTech: TechId.Finishing,
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
    inputItem: ItemId.SeasonedChips,
    outputItem: ItemId.BaggedChips,
    requiresTech: TechId.Finishing,
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
  /** −20% wear per level. The expensive track. */
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
 * Cost of each level as a percentage of the machine's invoice price: 1× / 2.5× / 6×
 * escalation (plan §3), so maxing one Fryer competes with buying a second one.
 */
export const UPGRADE_COST_PERCENT_BY_LEVEL: readonly number[] = [40, 100, 240];

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

/** One net-worth sample per active minute; ten hours of history for the Peak Flow board. */
export const NET_WORTH_SAMPLE_PERIOD_TICKS = 1_200;
export const NET_WORTH_SAMPLE_LIMIT = 600;

// --- balance version --------------------------------------------------------------

function balanceDigest(): string {
  let h = fnv1aInit();
  for (let i = 0; i < ITEM_SPECS.length; i++) {
    const spec = ITEM_SPECS[i]!;
    h = fnv1aString(h, `${spec.id}:${spec.slug}:${spec.listPriceCents}:${spec.purchasable}`);
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
      `${spec.kind}:${spec.slug}:${spec.role}:${spec.tilesWide}x${spec.tilesHigh}:${spec.priceCents}:${spec.workPerOperation}:${spec.workRatePerTick}:${spec.inputCapacity}:${spec.outputCapacity}:${spec.tankCapacityMl}:${spec.wearPerOperation}:${spec.inputItem}:${spec.outputItem}:${spec.requiresTech}`,
    );
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
    `${MOISTURE_MAX}:${MOISTURE_DRAIN_PER_TICK}:${GROWTH_PER_WATERED_TICK}:${HAND_POUR_ML}:${SPRINKLER_POUR_ML}:${SPRINKLER_PERIOD_TICKS}:${SPRINKLER_RADIUS_TILES}:${CONDITION_MAX}:${CONDITION_EFFECT_THRESHOLD}:${STARTING_MONEY_CENTS}:${STARTING_SEEDS}:${PLAYER_SPEED_SUBTILES_PER_100_TICKS}`,
  );
  h = fnv1aString(
    h,
    `${WILT_GRACE_TICKS}:${WILT_WINDOW_TICKS}:${COMPOST_AFTER_TICKS}:${COMPOST_PER_CROP}:${DAY_OLD_NUMERATOR}/${DAY_OLD_DENOMINATOR}:${AUTO_REPLANT_PERIOD_TICKS}:${ZONE_PAINT_MAX_SPAN}:${BELT_ITEM_SPACING_SUBTILES}:${BELT_MAX_LENGTH_TILES}:${WORK_RATE_SCALE}`,
  );
  h = fnv1aString(
    h,
    `${UPGRADE_MAX_LEVEL}:${SPEED_RATE_BONUS_PERCENT_PER_LEVEL}:${SPEED_WEAR_PENALTY_PERCENT_PER_LEVEL}:${EFFICIENCY_WEAR_CUT_PERCENT_PER_LEVEL}:${CAPACITY_BONUS_PER_LEVEL}:${UPGRADE_COST_PERCENT_BY_LEVEL.join('|')}`,
  );
  return fnv1aToHex(h);
}

/**
 * A digest of every number above. Saves record it; a mismatch on load means the world was
 * balanced under different data and needs a migration rather than a shrug.
 */
export const BALANCE_HASH = balanceDigest();
