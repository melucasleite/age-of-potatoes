// The world.
//
// `WorldState` is plain JSON data: numbers, strings, booleans, arrays, and objects with a
// fixed shape. No `Date`, no class instances, no functions, no getters, and no field that
// is sometimes absent and sometimes `undefined`. `JSON.parse(JSON.stringify(state))` must
// round-trip to a world that hashes identically — that is the property the save format,
// the golden fixtures, and any eventual Worker transport all stand on.
//
// Collections are ordered for deterministic iteration: the field is a flat row-major
// array; machines, belts, grabbers, and zones are arrays kept sorted by id; inventory is
// kept sorted by item id; the unlock list is kept sorted by node id. Nothing here is
// iterated with `for...in`, and nothing depends on object key insertion order — integer-like
// keys sort ascending while string keys keep insertion order, and that mixed rule will
// eventually reorder entity iteration on somebody's engine.

import {
  BELT_ITEM_SPACING_SUBTILES,
  type BeltTier,
  CONDITION_MAX,
  CropId,
  type CropSpec,
  FERTILITY_MAX,
  FERTILITY_MIN,
  FIELD_ORIGIN_X,
  FIELD_ORIGIN_Y,
  FIELD_TILES_HIGH,
  FIELD_TILES_WIDE,
  FIELD_TILE_COUNT,
  type GrabberTier,
  ItemId,
  MachineKind,
  STARTING_MONEY_CENTS,
  STARTING_SEEDS,
  WORLD_TILES_HIGH,
  WORLD_TILES_WIDE,
  ZONE_NAME_MAX_LENGTH,
  ZONE_PRIORITY_DEFAULT,
  beltSpec,
  grabberSpec,
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

/**
 * The save-format shape version.
 *
 * 1 — v0.1: field, machines, inventory, stats.
 * 2 — the factory: belts, grabbers, zones, tech unlocks, machine upgrade dials, and the
 *     per-tile withering clock. Migrations are a chain of pure functions, never edits.
 */
export const WORLD_STATE_VERSION = 2;

/**
 * A held direction, not a delta. Input tells the sim *which way the player is holding*,
 * and the sim owns how fast that moves them — otherwise input frequency leaks into world
 * state and a laggy frame becomes a slower character.
 *
 * Belts and grabbers reuse the same four compass values for which way they face. `None` is
 * not a legal facing for either.
 */
export const Direction = {
  None: 0,
  North: 1,
  East: 2,
  South: 3,
  West: 4,
} as const;

export type Direction = (typeof Direction)[keyof typeof Direction];

/** The tile step one compass direction represents. `None` is the zero vector. */
export function directionStepX(dir: Direction): number {
  if (dir === Direction.East) return 1;
  if (dir === Direction.West) return -1;
  return 0;
}

export function directionStepY(dir: Direction): number {
  if (dir === Direction.South) return 1;
  if (dir === Direction.North) return -1;
  return 0;
}

export function isCompassDirection(dir: number): boolean {
  return (
    dir === Direction.North ||
    dir === Direction.East ||
    dir === Direction.South ||
    dir === Direction.West
  );
}

export function oppositeDirection(dir: Direction): Direction {
  if (dir === Direction.North) return Direction.South;
  if (dir === Direction.South) return Direction.North;
  if (dir === Direction.East) return Direction.West;
  if (dir === Direction.West) return Direction.East;
  return Direction.None;
}

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
  /** 1..3 stars. Decides yield. Decay-with-harvests arrives with soil types. */
  fertility: number;
  /**
   * Ticks this tile has stood mature and unharvested. THE ONLY CLOCK WITHERING HAS. It
   * advances inside `step()`, so it counts active factory minutes and nothing else — a
   * closed tab ages no crop, because time does not pass (plan §4, §6).
   */
  readyAge: number;
  /** Compost left by a crop that was never picked. Nothing vanishes (plan §4). */
  compost: number;
  /** The zone that claims this tile, or 0. A tile belongs to at most one zone. */
  zone: number;
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
  /** Purchase price plus every upgrade bought since. What net worth invoices it at. */
  investedCents: number;
  /** 0..UPGRADE_MAX_LEVEL on each dial. Numbers only — dials never unlock a verb. */
  speedLevel: number;
  efficiencyLevel: number;
  capacityLevel: number;
}

/**
 * One item riding a belt.
 *
 * PLAN §13's REPRESENTATION, AND IT IS LOAD-BEARING: a belt is a sorted list of
 * `(distanceAlongBelt, itemTypeId)` and nothing else. The renderer derives screen positions
 * from this list into a pooled particle buffer every frame — a rendered item is a query
 * result, not an object. There is no persistent particle per sim item, no id per item, and
 * no sync bookkeeping, which is exactly what makes `ParticleContainer` (no interactivity,
 * no children) survivable: picking a belt item is a sim-side lookup, not a sprite hit-test.
 */
export interface BeltItem {
  /** Subtiles from the belt's start. Strictly ascending within a belt. */
  dist: number;
  item: ItemId;
}

export interface Belt {
  id: number;
  /** The first tile of the segment. */
  tileX: number;
  tileY: number;
  /** Which way goods travel. Always a compass direction, never `None`. */
  dir: Direction;
  /** Tiles covered, including the first. Segments are straight; corners are two belts. */
  lengthTiles: number;
  tier: BeltTier;
  /** Sorted ascending by `dist`, never closer together than the tier's item spacing. */
  items: BeltItem[];
  /** Sub-subtile movement remainder, in hundredths — the same trick the player uses. */
  moveAccum: number;
}

export interface Grabber {
  id: number;
  tileX: number;
  tileY: number;
  /** The way the arm faces: it takes from behind and puts down ahead. */
  dir: Direction;
  tier: GrabberTier;
  /** Only move this item, or 0 for "anything". Mk1 arms cannot hold one. */
  filter: number;
  /** What the hand is holding, or 0. */
  held: number;
  /** Ticks left in the current swing. */
  cooldown: number;
  /** Items delivered, lifetime. A diagnostic, and a trophy stat. */
  opCount: number;
}

/**
 * A painted Grow Zone.
 *
 * A ZONE IS A PLAN, NOT A MACHINE (plan §5). Membership lives on the tiles (`CropTile.zone`)
 * rather than in a rect list here, because tiles belong to at most one zone and a flat
 * per-tile owner id is what makes "47/60 planted" unambiguous and O(1) to maintain.
 */
export interface Zone {
  id: number;
  /** Player-facing, clipped to `ZONE_NAME_MAX_LENGTH`. Cosmetic, and hashed anyway. */
  name: string;
  /** What the player intends to grow here. `CropId.None` means undecided. */
  crop: CropId;
  /** 0..9. Higher goes first when the seed hopper decides which zone to serve. */
  priority: number;
  /** Rejected until the seed hopper is researched — locked in the sim, not just the UI. */
  autoReplant: boolean;
  /** Ticks until this zone's next auto-replant attempt. */
  replantCooldown: number;
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

  /** Sorted ascending by id. */
  belts: Belt[];
  nextBeltId: number;

  /** Sorted ascending by id. */
  grabbers: Grabber[];
  nextGrabberId: number;

  /** Sorted ascending by id. */
  zones: Zone[];
  nextZoneId: number;

  /**
   * Researched tech node ids, sorted ascending. Sorted rather than insertion-ordered so
   * two worlds that bought the same nodes in a different order hash identically — they are
   * the same world, and the digest has to agree.
   */
  unlocked: string[];

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
    belts: [],
    nextBeltId: 1,
    grabbers: [],
    nextGrabberId: 1,
    zones: [],
    nextZoneId: 1,
    unlocked: [],
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
      readyAge: 0,
      compost: 0,
      zone: 0,
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
    investedCents: spec.priceCents,
    speedLevel: 0,
    efficiencyLevel: 0,
    capacityLevel: 0,
  };
  state.nextMachineId += 1;
  // Ids only increase, so appending keeps the array sorted by id.
  state.machines.push(machine);
  return machine;
}

/** Place a belt without charging for it. */
export function spawnBelt(
  state: WorldState,
  tier: BeltTier,
  tileX: number,
  tileY: number,
  dir: Direction,
  lengthTiles: number,
): Belt | null {
  if (beltSpec(tier) === null) return null;

  const belt: Belt = {
    id: state.nextBeltId,
    tileX,
    tileY,
    dir,
    lengthTiles,
    tier,
    items: [],
    moveAccum: 0,
  };
  state.nextBeltId += 1;
  state.belts.push(belt);
  return belt;
}

/** Place a grabber without charging for it. */
export function spawnGrabber(
  state: WorldState,
  tier: GrabberTier,
  tileX: number,
  tileY: number,
  dir: Direction,
  filter: number,
): Grabber | null {
  if (grabberSpec(tier) === null) return null;

  const grabber: Grabber = {
    id: state.nextGrabberId,
    tileX,
    tileY,
    dir,
    tier,
    filter,
    held: 0,
    cooldown: 0,
    opCount: 0,
  };
  state.nextGrabberId += 1;
  state.grabbers.push(grabber);
  return grabber;
}

/** Create an empty zone. Painting tiles into it is a separate step. */
export function spawnZone(state: WorldState, crop: CropId): Zone {
  const id = state.nextZoneId;
  const zone: Zone = {
    id,
    name: clipZoneName(`Zone ${String(id)}`),
    crop,
    priority: ZONE_PRIORITY_DEFAULT,
    autoReplant: false,
    replantCooldown: 0,
  };
  state.nextZoneId += 1;
  state.zones.push(zone);
  return zone;
}

/** Clip rather than reject: a long name is a typo, not a reason to eat the command. */
export function clipZoneName(name: string): string {
  return name.length <= ZONE_NAME_MAX_LENGTH ? name : name.slice(0, ZONE_NAME_MAX_LENGTH);
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

/** The world tile a field index sits on. The inverse of `fieldIndex`. */
export function fieldTileX(index: number): number {
  return FIELD_ORIGIN_X + (index % FIELD_TILES_WIDE);
}

export function fieldTileY(index: number): number {
  return FIELD_ORIGIN_Y + divFloor(index, FIELD_TILES_WIDE);
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

/**
 * Put a crop in the ground and roll its growth variance.
 *
 * The one place a tile is planted, so hand-planting and the seed hopper draw from the same
 * stream in the same way. Seed accounting is the caller's job — the hopper spends from the
 * player's stock and a hand-plant does too, but a future greenhouse might not.
 */
export function plantCrop(state: WorldState, tile: CropTile, spec: CropSpec): void {
  // Per-tile growth variance, so a field ripens in waves rather than all at once.
  const span = divFloor(spec.growthTicks * spec.growthVariancePermille, 1000);
  const jitter = nextRange(streamFor(state, SystemIds.CropGrowth), -span, span);

  tile.crop = spec.id;
  tile.growth = 0;
  tile.growthTarget = spec.growthTicks + jitter;
  tile.readyAge = 0;
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

// --- belts and grabbers -----------------------------------------------------------

export function beltById(state: WorldState, id: number): Belt | null {
  for (let i = 0; i < state.belts.length; i++) {
    const belt = state.belts[i]!;
    if (belt.id === id) return belt;
  }
  return null;
}

/** How far along a belt an item can travel, in subtiles. */
export function beltEndDist(belt: Belt): number {
  return belt.lengthTiles * SUBTILE - 1;
}

/** Which tile of a belt a distance falls on, as an index from its start. */
export function beltTileIndexForDist(belt: Belt, dist: number): number {
  const index = divFloor(dist, SUBTILE);
  if (index < 0) return 0;
  return index >= belt.lengthTiles ? belt.lengthTiles - 1 : index;
}

/** The world tile at a given index along a belt. */
export function beltTileAtIndex(belt: Belt, index: number): { tileX: number; tileY: number } {
  return {
    tileX: belt.tileX + directionStepX(belt.dir) * index,
    tileY: belt.tileY + directionStepY(belt.dir) * index,
  };
}

/** The index of a world tile along a belt, or -1 if the belt does not cover it. */
export function beltIndexOfTile(belt: Belt, tileX: number, tileY: number): number {
  const dx = directionStepX(belt.dir);
  const dy = directionStepY(belt.dir);
  const offset = dx !== 0 ? (tileX - belt.tileX) * dx : (tileY - belt.tileY) * dy;
  if (offset < 0 || offset >= belt.lengthTiles) return -1;
  // The other axis has to match exactly, or a parallel belt one row over would answer.
  if (dx !== 0 && tileY !== belt.tileY) return -1;
  if (dy !== 0 && tileX !== belt.tileX) return -1;
  return offset;
}

export function beltCoversTile(belt: Belt, tileX: number, tileY: number): boolean {
  return beltIndexOfTile(belt, tileX, tileY) >= 0;
}

export function beltAt(state: WorldState, tileX: number, tileY: number): Belt | null {
  for (let i = 0; i < state.belts.length; i++) {
    const belt = state.belts[i]!;
    if (beltCoversTile(belt, tileX, tileY)) return belt;
  }
  return null;
}

/**
 * Insert an item at `dist`, keeping the list sorted and the spacing legal.
 *
 * Returns false and changes nothing when the slot is occupied — which is what a backed-up
 * belt looks like from the outside, and the reason a grabber holding an item is a jam the
 * player can see rather than an item that disappeared.
 */
export function beltInsert(belt: Belt, dist: number, item: ItemId): boolean {
  if (dist < 0 || dist > beltEndDist(belt)) return false;

  let insertAt = belt.items.length;
  for (let i = 0; i < belt.items.length; i++) {
    const existing = belt.items[i]!;
    const gap = existing.dist - dist;
    const spacing = gap < 0 ? -gap : gap;
    if (spacing < BELT_ITEM_SPACING_SUBTILES) return false;
    if (existing.dist > dist) {
      insertAt = i;
      break;
    }
  }

  belt.items.splice(insertAt, 0, { dist, item });
  return true;
}

export function grabberById(state: WorldState, id: number): Grabber | null {
  for (let i = 0; i < state.grabbers.length; i++) {
    const grabber = state.grabbers[i]!;
    if (grabber.id === id) return grabber;
  }
  return null;
}

export function grabberAt(state: WorldState, tileX: number, tileY: number): Grabber | null {
  for (let i = 0; i < state.grabbers.length; i++) {
    const grabber = state.grabbers[i]!;
    if (grabber.tileX === tileX && grabber.tileY === tileY) return grabber;
  }
  return null;
}

/** True when anything at all already occupies a tile. */
export function tileOccupied(state: WorldState, tileX: number, tileY: number): boolean {
  return (
    machineAt(state, tileX, tileY) !== null ||
    beltAt(state, tileX, tileY) !== null ||
    grabberAt(state, tileX, tileY) !== null
  );
}

// --- zones ------------------------------------------------------------------------

export function zoneById(state: WorldState, id: number): Zone | null {
  for (let i = 0; i < state.zones.length; i++) {
    const zone = state.zones[i]!;
    if (zone.id === id) return zone;
  }
  return null;
}

/** How many field tiles a zone owns. */
export function zoneTileCount(state: WorldState, zoneId: number): number {
  let count = 0;
  for (let i = 0; i < state.field.length; i++) {
    if (state.field[i]!.zone === zoneId) count += 1;
  }
  return count;
}

/** Drop a zone and release its tiles. Called when the last tile is painted away. */
export function removeZone(state: WorldState, zoneId: number): void {
  for (let i = 0; i < state.field.length; i++) {
    const tile = state.field[i]!;
    if (tile.zone === zoneId) tile.zone = 0;
  }
  for (let i = 0; i < state.zones.length; i++) {
    if (state.zones[i]!.id === zoneId) {
      state.zones.splice(i, 1);
      return;
    }
  }
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
 * Net worth: cash, plus inventory at list, plus machines at invoice scaled by condition,
 * plus everything sitting in a buffer or riding a belt.
 *
 * Every board is net-worth-accounted (plan §6) so that investing during a scoring window
 * is neutral while letting machines rust is a visible loss. Upgrade spend counts through
 * `investedCents` for the same reason: an upgraded Fryer is worth more than a bare one, and
 * a board that said otherwise would punish the player for buying the dial. Growing crops
 * are deliberately not counted — they are not inventory until they are harvested.
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
    total += divFloor(machine.investedCents * machine.condition, CONDITION_MAX);
    if (spec.outputItem !== null) {
      total += listPriceCents(spec.outputItem) * machine.outputCount;
    }
    if (spec.inputItem !== null) {
      total += listPriceCents(spec.inputItem) * machine.inputCount;
    }
  }

  for (let i = 0; i < state.belts.length; i++) {
    const belt = state.belts[i]!;
    const spec = beltSpec(belt.tier);
    if (spec !== null) total += spec.priceCentsPerTile * belt.lengthTiles;
    for (let j = 0; j < belt.items.length; j++) {
      total += listPriceCents(belt.items[j]!.item);
    }
  }

  for (let i = 0; i < state.grabbers.length; i++) {
    const grabber = state.grabbers[i]!;
    const spec = grabberSpec(grabber.tier);
    if (spec !== null) total += spec.priceCents;
    if (grabber.held !== 0) total += listPriceCents(grabber.held as ItemId);
  }

  return total;
}
