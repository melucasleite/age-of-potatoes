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
  type LiquidId,
  MachineKind,
  type MachineSpec,
  POND_ORIGIN_X,
  POND_ORIGIN_Y,
  PIPE_PRICE_CENTS_PER_TILE,
  POND_TILES_HIGH,
  POND_TILES_WIDE,
  RESERVOIR_CAPACITY_ML,
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
 * 3 — the liquid layer: reservoirs with a finite level, pipes, one-ledger networks, and the
 *     per-machine plumbing fields (network, flow, throttle, the Hub's scan cursor).
 * 4 — the walk-to errand: one pending `PlayerIntent`, or none.
 */
export const WORLD_STATE_VERSION = 4;

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

/**
 * The hand verbs an errand can be carrying. A SMALL FLAT ENUM, NOT A NESTED `Command`.
 *
 * An intent that stored a whole command inside itself would put a recursive shape in the
 * trace, in the save, and in the hash — three places that all want plain integers. The kind
 * plus a target tile plus at most two numbers says everything these nine verbs need, and it
 * stays readable when somebody is reading a raw trace at 2 a.m.
 *
 * These are exactly the verbs `tick.ts` gates on `HAND_REACH_SUBTILES`. A verb that is not
 * reach-gated has nothing to walk toward and does not belong here.
 */
export const IntentAction = {
  None: 0,
  Water: 1,
  Plant: 2,
  Harvest: 3,
  Load: 4,
  Unload: 5,
  RefillHopper: 6,
  Repair: 7,
  WhackJam: 8,
  Sell: 9,
} as const;

export type IntentAction = (typeof IntentAction)[keyof typeof IntentAction];

export const INTENT_ACTIONS: readonly IntentAction[] = [
  IntentAction.None,
  IntentAction.Water,
  IntentAction.Plant,
  IntentAction.Harvest,
  IntentAction.Load,
  IntentAction.Unload,
  IntentAction.RefillHopper,
  IntentAction.Repair,
  IntentAction.WhackJam,
  IntentAction.Sell,
];

/**
 * A pending errand: go there, then do that.
 *
 * WHY THIS IS WORLD STATE AND NOT CLIENT STATE. The obvious shortcut is to have the input
 * layer emit movement commands until the player is close enough and then emit the verb. That
 * shortcut is wrong twice over (plan §12): movement is a HELD DIRECTION precisely so the
 * trace stays small, and a client-driven walk would write a direction change into it every
 * few ticks for every click, forever — and a walk whose length is decided by client timing is
 * a walk whose length depends on framerate. Modelled here instead, an errand is one command,
 * and where the farmer ends up is a function of `seed + trace` like everything else.
 *
 * Integers only, and `null` when there is no errand — which is almost always.
 */
export interface PlayerIntent {
  /** What to do on arrival. Never `IntentAction.None` — that is what `null` is for. */
  action: IntentAction;
  /** The tile walked to. For a machine verb, a tile the machine's footprint covers. */
  tileX: number;
  tileY: number;
  /** `CropId` for Plant, `ItemId` for Sell, 0 for the verbs that need neither. */
  item: number;
  /** Stack size for Load, Unload, and Sell. 0 for the verbs that move nothing countable. */
  count: number;
  /**
   * The tick the errand was issued. THE ONLY THING THE TIMEOUT IS MEASURED FROM — an errand
   * that can never complete is a farmer who can never move again, so every errand carries the
   * clock that eventually kills it.
   */
  issuedTick: number;
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
  /**
   * The one pending errand, or `null`.
   *
   * ONE AT A TIME, DELIBERATELY. A new click replaces the old errand rather than queueing
   * behind it: click-three-tiles-do-all-three is a different feature with its own interface
   * problems (what is the order, how do you cancel the second one, what does the marker show)
   * and none of them are solved by letting this field become an array.
   */
  intent: PlayerIntent | null;
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
  /**
   * Consecutive ticks this machine has stood still with a full output buffer, reset to zero
   * the moment anything is taken out of it. Stays at zero on every machine whose spec names
   * no `overcookOutputItem`, because it is that rule's clock and nothing else's.
   *
   * IT COUNTS A LAYOUT CONDITION, NOT TIME. It only runs while demand-pull is holding the
   * machine stopped, which is a fact about what the player built — no belt off the Fryer, a
   * grabber pointed elsewhere, a basket nobody came back for. A closed tab advances it by
   * exactly nothing, because `step()` is the only thing that moves it.
   */
  blockedTicks: number;
  /**
   * How many of `outputCount` have turned into the spec's `overcookOutputItem`. Always
   * between 0 and `outputCount`, and always taken out FIRST — the burnt ones were at the
   * bottom of the basket, so they are the ones a grabber's hand closes on.
   */
  overcookedCount: number;
  /** Ticks until this machine's next periodic action, for machines that have one. */
  cooldown: number;
  /** Purchase price plus every upgrade bought since. What net worth invoices it at. */
  investedCents: number;
  /** 0..UPGRADE_MAX_LEVEL on each dial. Numbers only — dials never unlock a verb. */
  speedLevel: number;
  efficiencyLevel: number;
  capacityLevel: number;

  // --- the liquid layer (plan §5) ---
  //
  // Every field below is written by `pipes.ts` and read by `view.ts`. They are stored rather
  // than derived because the renderer must not compute network state of its own (plan §12),
  // and because a tank's net rate is a fact about the tick that just happened — there is
  // nowhere else for it to live.

  /**
   * The pipe network this machine is attached to, or 0. Recomputed on EDIT ONLY, by
   * `rebuildNetworks()`, never per tick.
   */
  network: number;
  /**
   * Signed net flow over the last tick, in millilitres per minute. Positive is in. This is
   * what a tank's **net rate and time-to-empty** are read off — plan §5's one label that
   * turns fluid management into arithmetic.
   */
  flowMlPerMinute: number;
  /**
   * Asked its network for water and got less than it asked for. Plan §5's AMBER DROPLET: the
   * network is over-demanded and every consumer on it is running slow, which is a readable
   * failure with a fixable cause rather than one machine mysteriously stopping.
   */
  throttled: boolean;
  /**
   * Where the Irrigation Hub's rotating scan is up to, as an offset into its coverage patch.
   *
   * IT LIVES HERE AND NOT IN A MODULE VARIABLE. Module state is invisible to the hash and to
   * saves, so a cursor kept there would make two identically-saved worlds water different
   * tiles after a reload — the exact class of bug the golden fixtures exist to catch.
   */
  scanCursor: number;
  /** Tiles this machine has actually watered, lifetime. A Hub's saving is the gap between… */
  wateredCount: number;
  /** …this and that: tiles it looked at, found already wet, and deliberately skipped. */
  skippedCount: number;
}

/**
 * A body of water with a countable amount in it.
 *
 * Plan §4: "~10,000 units recharging ~20 u/min ... pumps halve below 25% and sip at recharge
 * rate when empty — **reservoirs always recover**." The level is the whole point: it falls
 * when drawn from, rises when left alone, and the shoreline moves with it, so overdraw is
 * telegraphed in the world rather than in a panel.
 */
export interface Reservoir {
  id: number;
  /** Top-left tile of the footprint. */
  tileX: number;
  tileY: number;
  tilesWide: number;
  tilesHigh: number;
  /** Millilitres in it now. Floors at zero; `water.ts` is the only thing that moves it. */
  levelMl: number;
  capacityMl: number;
  /**
   * Recharge remainder, in millilitre-ticks. 40,000 ml a minute is 33⅓ ml a tick, so this
   * accrues and spends whole millilitres — the same integer accumulator the player's movement
   * uses, and for the same reason: rounding a rate is a float wearing a disguise.
   */
  rechargeAccum: number;
}

/**
 * One tile of pipe.
 *
 * A PIPE HAS NO CONTENTS. There is no fill level here and there must never be one — plan §5's
 * model is flow, not pressure, and a per-segment volume is the first step down the road to a
 * solver. A pipe knows what liquid its network carries and which network it belongs to. That
 * is all a pipe is.
 */
export interface Pipe {
  id: number;
  tileX: number;
  tileY: number;
  liquid: LiquidId;
  /** Its network's id, or 0. Recomputed on edit by `rebuildNetworks()`. */
  network: number;
}

/**
 * One connected run of pipe, and its ledger.
 *
 * The id is GEOMETRIC — the lowest row-major world tile index among its pipes — so two worlds
 * that built the same plumbing in a different order agree, and laying a pipe across the map
 * cannot renumber a network somewhere else.
 */
export interface PipeNetwork {
  id: number;
  liquid: LiquidId;
  /** The pump-rate remainder, in millilitre-ticks. See `Reservoir.rechargeAccum`. */
  supplyAccum: number;
  /** The round-robin rotation. Advances one step every tick the network is over-demanded. */
  rrOffset: number;
  /** Last tick's numbers, for the hover readout. Supply is a capacity, not a forced flow. */
  supplyMl: number;
  demandMl: number;
  deliveredMl: number;
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

  /** Sorted ascending by id. Finite, recharging, and never permanently dry (plan §4). */
  reservoirs: Reservoir[];
  nextReservoirId: number;

  /** Sorted ascending by id. One tile each; a run is many. */
  pipes: Pipe[];
  nextPipeId: number;

  /**
   * Sorted ascending by id, and the id is the network's lowest world tile index rather than a
   * counter — so there is deliberately no `nextNetworkId`. Rebuilt from the pipe list on
   * every edit by `rebuildNetworks()`, never per tick.
   */
  networks: PipeNetwork[];

  /**
   * One-shot celebrations this world has already played, sorted.
   *
   * Plan §3's Hall of Hands: "First activations get ~10 seconds of in-world theater
   * (sprinklers pop on down the rows)." The flag lives here rather than in the renderer so the
   * ceremony fires exactly once per WORLD and never replays after a reload — a first time that
   * happens twice is not a first time. The theatre itself is renderer-only and non-blocking;
   * the sim only records that it is owed.
   */
  ceremonies: string[];

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
      intent: null,
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
    reservoirs: [],
    nextReservoirId: 1,
    pipes: [],
    nextPipeId: 1,
    networks: [],
    ceremonies: [],
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

  // And so is the pond. Plan §3's Liquids ladder starts at "bucket/can at the shore", so the
  // shore has to exist on the first second too — the can is free, indestructible, and works
  // from a full pond and an empty one alike.
  spawnReservoir(state, POND_ORIGIN_X, POND_ORIGIN_Y, POND_TILES_WIDE, POND_TILES_HIGH);

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
    blockedTicks: 0,
    overcookedCount: 0,
    cooldown: 0,
    investedCents: spec.priceCents,
    speedLevel: 0,
    efficiencyLevel: 0,
    capacityLevel: 0,
    network: 0,
    flowMlPerMinute: 0,
    throttled: false,
    scanCursor: 0,
    wateredCount: 0,
    skippedCount: 0,
  };
  state.nextMachineId += 1;
  // Ids only increase, so appending keeps the array sorted by id.
  state.machines.push(machine);
  return machine;
}

/** Put a body of water on the map. Full to start; the level is a fact from here on. */
export function spawnReservoir(
  state: WorldState,
  tileX: number,
  tileY: number,
  tilesWide: number,
  tilesHigh: number,
): Reservoir {
  const reservoir: Reservoir = {
    id: state.nextReservoirId,
    tileX,
    tileY,
    tilesWide,
    tilesHigh,
    levelMl: RESERVOIR_CAPACITY_ML,
    capacityMl: RESERVOIR_CAPACITY_ML,
    rechargeAccum: 0,
  };
  state.nextReservoirId += 1;
  state.reservoirs.push(reservoir);
  return reservoir;
}

/** Lay one tile of pipe. Network membership is assigned by `rebuildNetworks()`, not here. */
export function spawnPipe(state: WorldState, tileX: number, tileY: number, liquid: LiquidId): Pipe {
  const pipe: Pipe = { id: state.nextPipeId, tileX, tileY, liquid, network: 0 };
  state.nextPipeId += 1;
  state.pipes.push(pipe);
  return pipe;
}

/**
 * Record that a one-shot celebration is owed, exactly once per world.
 *
 * Returns true the first time and false forever after, which is what makes the Hub's
 * pop-on-down-the-rows theatre a first time rather than a recurring animation.
 */
export function markCeremony(state: WorldState, id: string): boolean {
  for (let i = 0; i < state.ceremonies.length; i++) {
    const current = state.ceremonies[i]!;
    if (current === id) return false;
    if (current > id) {
      state.ceremonies.splice(i, 0, id);
      return true;
    }
  }
  state.ceremonies.push(id);
  return true;
}

/** The ids `markCeremony` uses. Strings, and they are save surface, so they are permanent. */
export const CeremonyId = {
  /** Plan §3's named example: the first time an Irrigation Hub waters a row. */
  IrrigationHub: 'irrigation-hub-first-run',
  /** The first piped head that pours without anyone having filled it. */
  PipedSprinkler: 'piped-sprinkler-first-run',
  /**
   * THE ONE THE WHOLE v0.1 GATE IS ABOUT: the first time the $150 barrel sprinkler pours by
   * itself. It arrived last, after its two automated descendants already had ids, which is
   * exactly backwards — plan §8's ship/no-ship question is whether a fresh player grins at
   * THIS moment, and it was the only one of the three that could not be marked.
   */
  Sprinkler: 'sprinkler-first-run',
} as const;

export type CeremonyId = (typeof CeremonyId)[keyof typeof CeremonyId];

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

/**
 * What the next unit out of a machine's output buffer is, or `null` when it is empty.
 *
 * BURNT GOES FIRST. A Fryer's overcooked chips were at the bottom of the basket — they are
 * the batch that sat there while the buffer stayed full — so they are what the next hand or
 * grabber closes on. Taking them last would let a player drain the good chips and leave the
 * burnt ones to be quietly forgotten, which is both wrong and unreadable.
 */
export function nextOutputItem(machine: Machine, spec: MachineSpec): ItemId | null {
  if (machine.outputCount <= 0) return null;
  if (machine.overcookedCount > 0 && spec.overcookOutputItem !== null) {
    return spec.overcookOutputItem;
  }
  return spec.outputItem;
}

/**
 * Take exactly one unit out of a machine's output buffer and say what it was.
 *
 * THE ONE PLACE OUTPUT LEAVES A MACHINE — grabbers and the player's own hands both come
 * through here, for the same reason `takeWater()` is the only draw path: two code paths that
 * both decrement `outputCount` would eventually disagree about which grade came out.
 *
 * Any pull resets the overcook clock. A basket that moved is a basket out of the oil.
 */
export function takeOneOutput(machine: Machine, spec: MachineSpec): ItemId | null {
  const item = nextOutputItem(machine, spec);
  if (item === null) return null;

  const burnt = machine.overcookedCount > 0 && spec.overcookOutputItem !== null;
  machine.outputCount -= 1;
  if (burnt) machine.overcookedCount -= 1;
  machine.blockedTicks = 0;
  return item;
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

/**
 * True when anything at all already occupies a tile — including a pipe, and including open
 * water. A pond is scenery you cannot build on; a Pump stands on the bank next to it.
 */
export function tileOccupied(state: WorldState, tileX: number, tileY: number): boolean {
  return (
    machineAt(state, tileX, tileY) !== null ||
    beltAt(state, tileX, tileY) !== null ||
    grabberAt(state, tileX, tileY) !== null ||
    pipeAtTile(state, tileX, tileY) !== null ||
    reservoirAtTile(state, tileX, tileY) !== null
  );
}

/**
 * Pipe and reservoir lookups, duplicated here rather than imported.
 *
 * `pipes.ts` and `water.ts` both import from this module, so reaching back into them for a
 * two-line scan would be a cycle. These are the same rule written once more, and the tests
 * hold them together.
 */
function pipeAtTile(state: WorldState, tileX: number, tileY: number): Pipe | null {
  for (let i = 0; i < state.pipes.length; i++) {
    const pipe = state.pipes[i]!;
    if (pipe.tileX === tileX && pipe.tileY === tileY) return pipe;
  }
  return null;
}

function reservoirAtTile(state: WorldState, tileX: number, tileY: number): Reservoir | null {
  for (let i = 0; i < state.reservoirs.length; i++) {
    const reservoir = state.reservoirs[i]!;
    if (
      tileX >= reservoir.tileX &&
      tileY >= reservoir.tileY &&
      tileX < reservoir.tileX + reservoir.tilesWide &&
      tileY < reservoir.tileY + reservoir.tilesHigh
    ) {
      return reservoir;
    }
  }
  return null;
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
      // A burnt batch is invoiced at what it will actually fetch, not at what it would have
      // fetched. Net worth that quietly counted twenty rustic chips as twenty good ones would
      // make neglect invisible on the one number plan §6's boards are read off.
      const overcooked = spec.overcookOutputItem;
      const burnt = overcooked === null ? 0 : machine.overcookedCount;
      total += listPriceCents(spec.outputItem) * (machine.outputCount - burnt);
      if (overcooked !== null && burnt > 0) total += listPriceCents(overcooked) * burnt;
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

  // Pipe is an asset like belt is. WATER IS NOT: a pond is terrain rather than stock, and a
  // tank full of it is a machine doing its job, not inventory. Counting water would make
  // filling a tank read as profit and draining it as a loss, which is precisely backwards.
  total += PIPE_PRICE_CENTS_PER_TILE * state.pipes.length;

  return total;
}
