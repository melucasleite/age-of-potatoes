// Balance data — crops, items, machines, prices, rates.
//
// This lives inside `packages/sim` on purpose (plan §12): balance data is
// save-compatibility surface exactly as much as code is, so it is versioned with the sim
// and folded into `BALANCE_HASH` below. A world saved under one balance table and loaded
// under another is a migration, not a coincidence.
//
// Everything here is an integer. Prices are cents. Volumes are millilitres. Progress is
// work-points. Durations are ticks.
//
// Numbers are the v0.1 first draft against plan §4's ten-hour reference curve; they are a
// two-way door and expected to move in playtest. The *shape* is what matters here.

import { fnv1aInit, fnv1aString, fnv1aToHex } from './hash';
import { TICKS_PER_SECOND } from './units';

// --- identifiers ------------------------------------------------------------------
// `as const` objects, never `enum`: Node's native type stripping cannot execute enums,
// and these ids are written into saves, so their numeric values are permanent.

export const CropId = {
  None: 0,
  RussetPotato: 1,
} as const;

export type CropId = (typeof CropId)[keyof typeof CropId];

export const ItemId = {
  PotatoSeed: 1,
  RussetPotato: 2,
  BaggedChips: 3,
} as const;

export type ItemId = (typeof ItemId)[keyof typeof ItemId];

export const MachineKind = {
  SellBin: 1,
  ChipKitchen: 2,
  Sprinkler: 3,
} as const;

export type MachineKind = (typeof MachineKind)[keyof typeof MachineKind];

// --- items ------------------------------------------------------------------------

export interface ItemSpec {
  readonly id: ItemId;
  /** Stable slug for the renderer's atlas lookup and for save debugging. */
  readonly slug: string;
  /** List price in cents. Everything is sellable (plan §5). */
  readonly listPriceCents: number;
}

export const ITEM_SPECS: readonly ItemSpec[] = [
  { id: ItemId.PotatoSeed, slug: 'potato-seed', listPriceCents: 50 },
  { id: ItemId.RussetPotato, slug: 'russet-potato', listPriceCents: 200 },
  { id: ItemId.BaggedChips, slug: 'bagged-chips', listPriceCents: 2000 },
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
  /** Renderer growth stages, including the bare-soil stage. */
  readonly stageCount: number;
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

/** A fully watered tile, in moisture units. One unit drains per tick. */
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

// --- machines ---------------------------------------------------------------------

export interface MachineSpec {
  readonly kind: MachineKind;
  readonly slug: string;
  /** Footprint in tiles. The Chip Kitchen splits into three machines at v0.3. */
  readonly tilesWide: number;
  readonly tilesHigh: number;
  /** Purchase price, and the invoice value net worth accounts it at (plan §6). */
  readonly priceCents: number;
  /** Work-points one operation costs, or 0 for machines that do not run a work cycle. */
  readonly workPerOperation: number;
  /** Work-points produced per tick at full condition. */
  readonly workRatePerTick: number;
  /** Items the input buffer holds. */
  readonly inputCapacity: number;
  readonly outputCapacity: number;
  /** Water tank, for machines that hold one. */
  readonly tankCapacityMl: number;
  /** Condition lost per completed operation. Wear is per-operation, never per second. */
  readonly wearPerOperation: number;
  readonly inputItem: ItemId | null;
  readonly outputItem: ItemId | null;
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

export const MACHINE_SPECS: readonly MachineSpec[] = [
  {
    kind: MachineKind.SellBin,
    slug: 'sell-bin',
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
  },
  {
    // Deliberately one monolithic machine in v0.1. It splits into Washer / Slicer / Fryer
    // at v0.3, which is when belts arrive to connect them.
    kind: MachineKind.ChipKitchen,
    slug: 'chip-kitchen',
    tilesWide: 2,
    tilesHigh: 2,
    priceCents: 10_000,
    workPerOperation: 120,
    workRatePerTick: 2,
    inputCapacity: 20,
    outputCapacity: 20,
    tankCapacityMl: 0,
    wearPerOperation: 5,
    inputItem: ItemId.RussetPotato,
    outputItem: ItemId.BaggedChips,
  },
  {
    // The $150 sprinkler of plan §7 — the whole v0.1 design gate. You fill its barrel by
    // can; piped sprinklers arrive at v0.4.
    kind: MachineKind.Sprinkler,
    slug: 'sprinkler',
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
  },
];

export function machineSpec(kind: MachineKind): MachineSpec | null {
  for (let i = 0; i < MACHINE_SPECS.length; i++) {
    const spec = MACHINE_SPECS[i]!;
    if (spec.kind === kind) return spec;
  }
  return null;
}

// --- world layout -----------------------------------------------------------------

export const WORLD_TILES_WIDE = 16;
export const WORLD_TILES_HIGH = 16;

/** v0.1 is one fixed 8×8 field (plan §16). Zones and a 64×64 map arrive at v0.2. */
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
    h = fnv1aString(h, `${spec.id}:${spec.slug}:${spec.listPriceCents}`);
  }
  for (let i = 0; i < CROP_SPECS.length; i++) {
    const spec = CROP_SPECS[i]!;
    h = fnv1aString(
      h,
      `${spec.id}:${spec.slug}:${spec.growthTicks}:${spec.growthVariancePermille}:${spec.seedItem}:${spec.yieldItem}`,
    );
  }
  for (let i = 0; i < MACHINE_SPECS.length; i++) {
    const spec = MACHINE_SPECS[i]!;
    h = fnv1aString(
      h,
      `${spec.kind}:${spec.slug}:${spec.tilesWide}x${spec.tilesHigh}:${spec.priceCents}:${spec.workPerOperation}:${spec.workRatePerTick}:${spec.inputCapacity}:${spec.outputCapacity}:${spec.tankCapacityMl}:${spec.wearPerOperation}`,
    );
  }
  h = fnv1aString(
    h,
    `${MOISTURE_MAX}:${MOISTURE_DRAIN_PER_TICK}:${GROWTH_PER_WATERED_TICK}:${HAND_POUR_ML}:${SPRINKLER_POUR_ML}:${SPRINKLER_PERIOD_TICKS}:${SPRINKLER_RADIUS_TILES}:${CONDITION_MAX}:${CONDITION_EFFECT_THRESHOLD}:${STARTING_MONEY_CENTS}:${STARTING_SEEDS}:${PLAYER_SPEED_SUBTILES_PER_100_TICKS}`,
  );
  return fnv1aToHex(h);
}

/**
 * A digest of every number above. Saves record it; a mismatch on load means the world was
 * balanced under different data and needs a migration rather than a shrug.
 */
export const BALANCE_HASH = balanceDigest();
