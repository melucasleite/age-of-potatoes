// The world.
//
// `WorldState` is plain JSON data: numbers, strings, booleans, arrays, and objects with a
// fixed shape. No `Date`, no class instances, no functions, no getters, and no field that
// is sometimes absent and sometimes `undefined`. `JSON.parse(JSON.stringify(state))` must
// round-trip to a world that hashes identically — that is the property the save format,
// the golden fixtures, and any eventual Worker transport all stand on.
//
// Collections are ordered for deterministic iteration: the field is a flat row-major
// array, machines are an array kept sorted by id, and inventory is kept sorted by item id.
// Nothing here is iterated with `for...in`, and nothing depends on object key insertion
// order — integer-like keys sort ascending while string keys keep insertion order, and
// that mixed rule will eventually reorder entity iteration on somebody's engine.

import {
  CONDITION_MAX,
  CropId,
  FERTILITY_MAX,
  FERTILITY_MIN,
  FIELD_ORIGIN_X,
  FIELD_ORIGIN_Y,
  FIELD_TILES_HIGH,
  FIELD_TILES_WIDE,
  FIELD_TILE_COUNT,
  ItemId,
  MachineKind,
  STARTING_MONEY_CENTS,
  STARTING_SEEDS,
  WORLD_TILES_HIGH,
  WORLD_TILES_WIDE,
  listPriceCents,
  machineSpec,
} from './data';
import type { Command } from './commands';
import {
  type RngState,
  type SystemId,
  SystemId as SystemIds,
  deriveStream,
  nextRange,
} from './rng';
import { type WorldStats, createStats } from './stats';
import { SUBTILE, divFloor, tileCentreSubtiles } from './units';

/** The save-format shape version. Migrations are a chain of pure functions, never edits. */
export const WORLD_STATE_VERSION = 1;

/**
 * A held direction, not a delta. Input tells the sim *which way the player is holding*,
 * and the sim owns how fast that moves them — otherwise input frequency leaks into world
 * state and a laggy frame becomes a slower character.
 */
export const Direction = {
  None: 0,
  North: 1,
  East: 2,
  South: 3,
  West: 4,
} as const;

export type Direction = (typeof Direction)[keyof typeof Direction];

export interface PlayerState {
  /** Position in subtiles. */
  xSub: number;
  ySub: number;
  /** Last non-none direction, kept when the player stops. */
  facing: Direction;
  /** The direction currently held. `None` means standing still. */
  moveDir: Direction;
  /**
   * Sub-subtile movement remainder. 4 tiles/s at 20 Hz is 51.2 subtiles per tick, which is
   * not an integer — so movement accrues in hundredths and spends whole subtiles. Exact,
   * and the same technique every future rate that does not divide evenly will use.
   */
  moveAccum: number;
}

export interface InventorySlot {
  item: ItemId;
  count: number;
}

export interface CropTile {
  crop: CropId;
  /** Growth work-points accrued. Ready when it reaches `growthTarget`. */
  growth: number;
  /** Rolled per tile when planted, so a field ripens in waves rather than all at once. */
  growthTarget: number;
  /** 0..MOISTURE_MAX. Growth accrues only while this is above zero. */
  moisture: number;
  /** 1..3 stars. Decides yield. Decay-with-harvests arrives with soil types at v0.2. */
  fertility: number;
}

export interface Machine {
  id: number;
  kind: MachineKind;
  /** Top-left tile of the footprint. */
  tileX: number;
  tileY: number;
  /** Work-points accrued toward the current operation. */
  progress: number;
  inputCount: number;
  outputCount: number;
  /** Water held, in millilitres, for machines with a tank. */
  tankMl: number;
  /** 0..CONDITION_MAX. Wear is per completed operation, never per second. */
  condition: number;
  /** Completed operations, lifetime. Drives deterministic jamming. */
  opCount: number;
  /** Halted until whacked. Only ever set by a deterministic rule, never by a die roll. */
  jammed: boolean;
  /** Ticks until this machine's next periodic action, for machines that have one. */
  cooldown: number;
}

/** One entry of the append-only input trace. */
export interface TraceEntry {
  tick: number;
  command: Command;
}

export interface WorldState {
  version: number;
  /** The uint32 every RNG stream in this world is derived from. */
  worldSeed: number;
  /** The tick about to be simulated. `createWorld` starts at 0. */
  tick: number;

  moneyCents: number;

  player: PlayerState;
  /** Sorted ascending by item id. Never contains a zero-count slot. */
  inventory: InventorySlot[];

  /** Row-major, `FIELD_TILES_WIDE * FIELD_TILES_HIGH` entries. Index is the tile's id. */
  field: CropTile[];

  /** Sorted ascending by id. */
  machines: Machine[];
  nextMachineId: number;

  /**
   * Per-system generator states, derived lazily on first draw. Lazy is deliberate: a world
   * that never draws from a stream never stores it, so introducing a new system leaves
   * existing worlds' hashes untouched. Only ever accessed by explicit key — never iterated
   * except through sorted keys in `hash.ts`.
   */
  streams: Record<string, RngState>;

  stats: WorldStats;

  /**
   * Append-only. Every command that was actually applied, in application order, never
   * mutated and never reordered.
   *
   * This is not dead anti-cheat code and must not be deleted as such — leaderboards are
   * only lightly validated (plan §10.9). It is here because seed + trace is a bug report
   * that reproduces exactly, which is the single most valuable debugging asset a solo dev
   * can have, and it costs an append-only array.
   */
  trace: TraceEntry[];
}

// --- construction -----------------------------------------------------------------

/**
 * Build a world deterministically from a seed. Same seed in, byte-identical world out, on
 * every machine, forever.
 */
export function createWorld(seed: number): WorldState {
  const worldSeed = Math.trunc(seed) >>> 0;
  const stats = createStats();

  const state: WorldState = {
    version: WORLD_STATE_VERSION,
    worldSeed,
    tick: 0,
    moneyCents: STARTING_MONEY_CENTS,
    player: {
      xSub: tileCentreSubtiles(FIELD_ORIGIN_X + divFloor(FIELD_TILES_WIDE, 2)),
      ySub: tileCentreSubtiles(FIELD_ORIGIN_Y + FIELD_TILES_HIGH),
      facing: Direction.North,
      moveDir: Direction.None,
      moveAccum: 0,
    },
    inventory: [],
    field: [],
    machines: [],
    nextMachineId: 1,
    streams: {},
    stats,
    trace: [],
  };

  const fieldRng = streamFor(state, SystemIds.FieldInit);
  for (let i = 0; i < FIELD_TILE_COUNT; i++) {
    state.field.push({
      crop: CropId.None,
      growth: 0,
      growthTarget: 0,
      moisture: 0,
      fertility: nextRange(fieldRng, FERTILITY_MIN, FERTILITY_MAX),
    });
  }

  // The roadside stand is a gift, not a purchase — selling by hand is the manual tier of
  // plan §3's ladder and must work from the first second.
  spawnMachine(state, MachineKind.SellBin, FIELD_ORIGIN_X - 2, FIELD_ORIGIN_Y + FIELD_TILES_HIGH);

  addItem(state, ItemId.PotatoSeed, STARTING_SEEDS);
  state.stats.netWorthCents = computeNetWorthCents(state);
  state.stats.peakNetWorthCents = state.stats.netWorthCents;

  return state;
}

/** Place a machine without charging for it. Command handling does the money. */
export function spawnMachine(
  state: WorldState,
  kind: MachineKind,
  tileX: number,
  tileY: number,
): Machine | null {
  const spec = machineSpec(kind);
  if (spec === null) return null;

  const machine: Machine = {
    id: state.nextMachineId,
    kind,
    tileX,
    tileY,
    progress: 0,
    inputCount: 0,
    outputCount: 0,
    tankMl: 0,
    condition: CONDITION_MAX,
    opCount: 0,
    jammed: false,
    cooldown: 0,
  };
  state.nextMachineId += 1;
  // Ids only increase, so appending keeps the array sorted by id.
  state.machines.push(machine);
  return machine;
}

// --- streams ----------------------------------------------------------------------

/**
 * The generator for one system of this world, derived on first use and stored thereafter.
 * This is the only way to reach randomness inside the sim.
 */
export function streamFor(state: WorldState, systemId: SystemId): RngState {
  const existing = state.streams[systemId];
  if (existing !== undefined) return existing;
  const created = deriveStream(state.worldSeed, systemId);
  state.streams[systemId] = created;
  return created;
}

// --- field ------------------------------------------------------------------------

export function isFieldTile(tileX: number, tileY: number): boolean {
  return (
    tileX >= FIELD_ORIGIN_X &&
    tileY >= FIELD_ORIGIN_Y &&
    tileX < FIELD_ORIGIN_X + FIELD_TILES_WIDE &&
    tileY < FIELD_ORIGIN_Y + FIELD_TILES_HIGH
  );
}

/** Row-major index of a world tile within the field, or -1 if it is not field. */
export function fieldIndex(tileX: number, tileY: number): number {
  if (!isFieldTile(tileX, tileY)) return -1;
  return (tileY - FIELD_ORIGIN_Y) * FIELD_TILES_WIDE + (tileX - FIELD_ORIGIN_X);
}

export function tileAt(state: WorldState, tileX: number, tileY: number): CropTile | null {
  const index = fieldIndex(tileX, tileY);
  if (index < 0) return null;
  return state.field[index] ?? null;
}

export function isInsideWorld(tileX: number, tileY: number): boolean {
  return tileX >= 0 && tileY >= 0 && tileX < WORLD_TILES_WIDE && tileY < WORLD_TILES_HIGH;
}

export function isTileReady(tile: CropTile): boolean {
  return tile.crop !== CropId.None && tile.growth >= tile.growthTarget;
}

// --- machines ---------------------------------------------------------------------

export function machineById(state: WorldState, id: number): Machine | null {
  for (let i = 0; i < state.machines.length; i++) {
    const machine = state.machines[i]!;
    if (machine.id === id) return machine;
  }
  return null;
}

export function machineCoversTile(machine: Machine, tileX: number, tileY: number): boolean {
  const spec = machineSpec(machine.kind);
  if (spec === null) return false;
  return (
    tileX >= machine.tileX &&
    tileY >= machine.tileY &&
    tileX < machine.tileX + spec.tilesWide &&
    tileY < machine.tileY + spec.tilesHigh
  );
}

export function machineAt(state: WorldState, tileX: number, tileY: number): Machine | null {
  for (let i = 0; i < state.machines.length; i++) {
    const machine = state.machines[i]!;
    if (machineCoversTile(machine, tileX, tileY)) return machine;
  }
  return null;
}

/** The subtile centre of a machine's footprint, for reach checks. */
export function machineCentreSubtiles(machine: Machine): { xSub: number; ySub: number } {
  const spec = machineSpec(machine.kind);
  const wide = spec === null ? 1 : spec.tilesWide;
  const high = spec === null ? 1 : spec.tilesHigh;
  return {
    xSub: tileCentreSubtiles(machine.tileX) + divFloor((wide - 1) * SUBTILE, 2),
    ySub: tileCentreSubtiles(machine.tileY) + divFloor((high - 1) * SUBTILE, 2),
  };
}

// --- inventory --------------------------------------------------------------------

export function itemCount(state: WorldState, item: ItemId): number {
  for (let i = 0; i < state.inventory.length; i++) {
    const slot = state.inventory[i]!;
    if (slot.item === item) return slot.count;
    if (slot.item > item) return 0;
  }
  return 0;
}

/** Add items, keeping the inventory sorted ascending by item id. */
export function addItem(state: WorldState, item: ItemId, count: number): void {
  if (count <= 0) return;
  for (let i = 0; i < state.inventory.length; i++) {
    const slot = state.inventory[i]!;
    if (slot.item === item) {
      slot.count += count;
      return;
    }
    if (slot.item > item) {
      state.inventory.splice(i, 0, { item, count });
      return;
    }
  }
  state.inventory.push({ item, count });
}

/** Remove items. Returns false and changes nothing if the player does not have them. */
export function removeItem(state: WorldState, item: ItemId, count: number): boolean {
  if (count <= 0) return true;
  for (let i = 0; i < state.inventory.length; i++) {
    const slot = state.inventory[i]!;
    if (slot.item !== item) continue;
    if (slot.count < count) return false;
    slot.count -= count;
    if (slot.count === 0) state.inventory.splice(i, 1);
    return true;
  }
  return false;
}

// --- money ------------------------------------------------------------------------

/**
 * Net worth: cash, plus inventory at list, plus machines at invoice scaled by condition.
 *
 * Every board is net-worth-accounted (plan §6) so that investing during a scoring window
 * is neutral while letting machines rust is a visible loss. Growing crops are deliberately
 * not counted — they are not inventory until they are harvested.
 */
export function computeNetWorthCents(state: WorldState): number {
  let total = state.moneyCents;

  for (let i = 0; i < state.inventory.length; i++) {
    const slot = state.inventory[i]!;
    total += listPriceCents(slot.item) * slot.count;
  }

  for (let i = 0; i < state.machines.length; i++) {
    const machine = state.machines[i]!;
    const spec = machineSpec(machine.kind);
    if (spec === null) continue;
    total += divFloor(spec.priceCents * machine.condition, CONDITION_MAX);
    if (spec.outputItem !== null) {
      total += listPriceCents(spec.outputItem) * machine.outputCount;
    }
    if (spec.inputItem !== null) {
      total += listPriceCents(spec.inputItem) * machine.inputCount;
    }
  }

  return total;
}
