// The canonical save payload: `WorldState` as plain, ordered, self-describing JSON.
//
// PLAIN JSON, AND EXPLICITLY NOT MORE (plan §12). No typed arrays, no binary packing, no
// compression, no schema compiler — none of it until saves genuinely exceed ~5 MB, which a
// v0.1 world (one 8×8 field) does not come close to. Being able to open a corrupt save in a
// text editor and *see* what went wrong is worth more, for years, than the bytes are.
//
// Two properties this file exists to guarantee:
//
//   1. CANONICAL. The same world always produces byte-identical JSON. Fields are written in
//      the fixed order below rather than by key enumeration, and the stream map — the one
//      collection in `WorldState` with unordered keys — is emitted as an array sorted by id.
//      (Object literal order survives `JSON.stringify` for string keys; every key here is
//      alphabetic, so none of them get the integer-key reordering rule applied to them.)
//
//   2. EXACTLY THE HASHED FIELDS, AND NOTHING ELSE. Everything `hashState()` digests is in
//      the payload, so `hashState(deserialize(serialize(state))) === hashState(state)`. That
//      round-trip is asserted in the tests and it is what makes the save meaningful: the
//      digest and the file can never disagree about what the world *is*.
//
// THE TRACE IS NOT IN THE PAYLOAD. It grows without bound over a persistent world, it is not
// save-compatibility surface, and rewriting the whole log on every autosave would make each
// save progressively more expensive for no benefit. It lives in its own IndexedDB object
// store in `apps/web`. It is also not hashed, so leaving it out costs the round-trip nothing.
//
// LEADERBOARD ACCUMULATORS ARE PERSISTED, NEVER RECOMPUTED (plan §12). They live inside
// `WorldState` and inside the hash; recomputing them on load would produce a world that
// hashes differently from the one that was saved, which is the definition of a broken save.

import { BeltTier, CropId, GrabberTier, ItemId, LiquidId, MachineKind } from '../data';
import type { RngState } from '../rng';
import {
  type Belt,
  type CropTile,
  type Grabber,
  type Machine,
  type Pipe,
  type PipeNetwork,
  type PlayerIntent,
  type PlayerState,
  type Reservoir,
  type TraceEntry,
  type WorldState,
  type Zone,
  Direction,
  IntentAction,
} from '../state';
import type { ManualTouchCounts, WorldStats } from '../stats';
import { SaveCorruptError } from './errors';

// --- the payload shape ------------------------------------------------------------

/**
 * A pending errand, flattened to six integers.
 *
 * THE FIRST NULLABLE FIELD IN THE ENTIRE PAYLOAD, and it is nullable rather than
 * sentinel-encoded because `PlayerIntent` is nullable in `WorldState` and the payload's job
 * is to mirror the world, not to invent a second encoding of it. A `{action: 0}` row meaning
 * "no errand" would be a second way to say `null` — and two encodings of the same fact is
 * how a canonical form stops being canonical.
 */
export interface SavePlayerIntent {
  action: number;
  count: number;
  issuedTick: number;
  item: number;
  tileX: number;
  tileY: number;
}

export interface SavePlayer {
  facing: number;
  intent: SavePlayerIntent | null;
  moveAccum: number;
  moveDir: number;
  xSub: number;
  ySub: number;
}

export interface SaveInventorySlot {
  count: number;
  item: number;
}

export interface SaveCropTile {
  compost: number;
  crop: number;
  fertility: number;
  growth: number;
  growthTarget: number;
  moisture: number;
  readyAge: number;
  zone: number;
}

export interface SaveMachine {
  blockedTicks: number;
  capacityLevel: number;
  condition: number;
  cooldown: number;
  efficiencyLevel: number;
  flowMlPerMinute: number;
  id: number;
  inputCount: number;
  investedCents: number;
  jammed: boolean;
  kind: number;
  network: number;
  opCount: number;
  outputCount: number;
  overcookedCount: number;
  progress: number;
  scanCursor: number;
  skippedCount: number;
  speedLevel: number;
  tankMl: number;
  throttled: boolean;
  tileX: number;
  tileY: number;
  wateredCount: number;
}

/** A body of water, and how much is actually left in it. */
export interface SaveReservoir {
  capacityMl: number;
  id: number;
  levelMl: number;
  rechargeAccum: number;
  tileX: number;
  tileY: number;
  tilesHigh: number;
  tilesWide: number;
}

/** One tile of pipe. It has no contents — see `Pipe` in state.ts. */
export interface SavePipe {
  id: number;
  liquid: number;
  network: number;
  tileX: number;
  tileY: number;
}

/**
 * One network's ledger bookkeeping.
 *
 * Membership is NOT stored: it is recomputed from the pipe list on load exactly as it is on
 * every edit, so a save cannot contain a network whose shape disagrees with its pipes. What
 * is stored is the part that cannot be recomputed — the supply accumulator and the round-robin
 * rotation, which are history rather than geometry.
 */
export interface SavePipeNetwork {
  deliveredMl: number;
  demandMl: number;
  id: number;
  liquid: number;
  rrOffset: number;
  supplyAccum: number;
  supplyMl: number;
}

/** One item on a belt: how far along it is, and what it is. Nothing else exists. */
export interface SaveBeltItem {
  dist: number;
  item: number;
}

export interface SaveBelt {
  dir: number;
  id: number;
  /** Ascending by `dist`, exactly as the belt holds them. */
  items: SaveBeltItem[];
  lengthTiles: number;
  moveAccum: number;
  tier: number;
  tileX: number;
  tileY: number;
}

export interface SaveGrabber {
  cooldown: number;
  dir: number;
  filter: number;
  held: number;
  id: number;
  opCount: number;
  tier: number;
  tileX: number;
  tileY: number;
}

export interface SaveZone {
  autoReplant: boolean;
  crop: number;
  id: number;
  name: string;
  priority: number;
  replantCooldown: number;
}

/** One RNG stream, with its system id folded in — an array entry, not a map key. */
export interface SaveStream {
  id: string;
  s0: number;
  s1: number;
  s2: number;
  s3: number;
}

export interface SaveTouchCounts {
  handCarry: number;
  handHarvest: number;
  handPlant: number;
  handRepair: number;
  handWater: number;
  hopperRefill: number;
  jamWhack: number;
}

export interface SaveStats {
  inputsWastedByMachine: number;
  itemsHarvestedByHand: number;
  itemsProducedByMachine: number;
  itemsSold: number;
  lifetimeEarnedCents: number;
  lifetimeSpentCents: number;
  longestHandsFreeTicks: number;
  netWorthCents: number;
  netWorthSamples: number[];
  nextNetWorthSampleTick: number;
  peakNetWorthCents: number;
  repairKitSpendCents: number;
  repairKitsUsed: number;
  ticksElapsed: number;
  ticksSinceManualTouch: number;
  touches: SaveTouchCounts;
  waterDrawnMl: number;
}

/** `WorldState` minus the trace, in canonical form. Keys are alphabetical, always. */
export interface SavePayload {
  belts: SaveBelt[];
  /** One-shot celebrations already played, sorted. A first time must not happen twice. */
  ceremonies: string[];
  field: SaveCropTile[];
  grabbers: SaveGrabber[];
  inventory: SaveInventorySlot[];
  machines: SaveMachine[];
  moneyCents: number;
  networks: SavePipeNetwork[];
  nextBeltId: number;
  nextGrabberId: number;
  nextMachineId: number;
  nextPipeId: number;
  nextReservoirId: number;
  nextZoneId: number;
  pipes: SavePipe[];
  reservoirs: SaveReservoir[];
  player: SavePlayer;
  stats: SaveStats;
  streams: SaveStream[];
  tick: number;
  /** Researched node ids, sorted. Strings on purpose — they outlive any index. */
  unlocked: string[];
  version: number;
  worldSeed: number;
  zones: SaveZone[];
}

// --- writing ----------------------------------------------------------------------

/**
 * Project a world into its canonical payload. Pure, and it copies — the result shares no
 * object with `state`, so a payload handed to `JSON.stringify` cannot be perturbed by a tick
 * that lands while the write is in flight.
 */
export function toPayload(state: WorldState): SavePayload {
  const field: SaveCropTile[] = [];
  for (let i = 0; i < state.field.length; i++) {
    const tile = state.field[i]!;
    field.push({
      compost: tile.compost,
      crop: tile.crop,
      fertility: tile.fertility,
      growth: tile.growth,
      growthTarget: tile.growthTarget,
      moisture: tile.moisture,
      readyAge: tile.readyAge,
      zone: tile.zone,
    });
  }

  const inventory: SaveInventorySlot[] = [];
  for (let i = 0; i < state.inventory.length; i++) {
    const slot = state.inventory[i]!;
    inventory.push({ count: slot.count, item: slot.item });
  }

  const machines: SaveMachine[] = [];
  for (let i = 0; i < state.machines.length; i++) {
    const machine = state.machines[i]!;
    machines.push({
      blockedTicks: machine.blockedTicks,
      capacityLevel: machine.capacityLevel,
      condition: machine.condition,
      cooldown: machine.cooldown,
      efficiencyLevel: machine.efficiencyLevel,
      flowMlPerMinute: machine.flowMlPerMinute,
      id: machine.id,
      inputCount: machine.inputCount,
      investedCents: machine.investedCents,
      jammed: machine.jammed,
      kind: machine.kind,
      network: machine.network,
      opCount: machine.opCount,
      outputCount: machine.outputCount,
      overcookedCount: machine.overcookedCount,
      progress: machine.progress,
      scanCursor: machine.scanCursor,
      skippedCount: machine.skippedCount,
      speedLevel: machine.speedLevel,
      tankMl: machine.tankMl,
      throttled: machine.throttled,
      tileX: machine.tileX,
      tileY: machine.tileY,
      wateredCount: machine.wateredCount,
    });
  }

  const belts: SaveBelt[] = [];
  for (let i = 0; i < state.belts.length; i++) {
    const belt = state.belts[i]!;
    const items: SaveBeltItem[] = [];
    for (let j = 0; j < belt.items.length; j++) {
      const entry = belt.items[j]!;
      items.push({ dist: entry.dist, item: entry.item });
    }
    belts.push({
      dir: belt.dir,
      id: belt.id,
      items,
      lengthTiles: belt.lengthTiles,
      moveAccum: belt.moveAccum,
      tier: belt.tier,
      tileX: belt.tileX,
      tileY: belt.tileY,
    });
  }

  const grabbers: SaveGrabber[] = [];
  for (let i = 0; i < state.grabbers.length; i++) {
    const grabber = state.grabbers[i]!;
    grabbers.push({
      cooldown: grabber.cooldown,
      dir: grabber.dir,
      filter: grabber.filter,
      held: grabber.held,
      id: grabber.id,
      opCount: grabber.opCount,
      tier: grabber.tier,
      tileX: grabber.tileX,
      tileY: grabber.tileY,
    });
  }

  const zones: SaveZone[] = [];
  for (let i = 0; i < state.zones.length; i++) {
    const zone = state.zones[i]!;
    zones.push({
      autoReplant: zone.autoReplant,
      crop: zone.crop,
      id: zone.id,
      name: zone.name,
      priority: zone.priority,
      replantCooldown: zone.replantCooldown,
    });
  }

  const reservoirs: SaveReservoir[] = [];
  for (let i = 0; i < state.reservoirs.length; i++) {
    const reservoir = state.reservoirs[i]!;
    reservoirs.push({
      capacityMl: reservoir.capacityMl,
      id: reservoir.id,
      levelMl: reservoir.levelMl,
      rechargeAccum: reservoir.rechargeAccum,
      tileX: reservoir.tileX,
      tileY: reservoir.tileY,
      tilesHigh: reservoir.tilesHigh,
      tilesWide: reservoir.tilesWide,
    });
  }

  const pipes: SavePipe[] = [];
  for (let i = 0; i < state.pipes.length; i++) {
    const pipe = state.pipes[i]!;
    pipes.push({
      id: pipe.id,
      liquid: pipe.liquid,
      network: pipe.network,
      tileX: pipe.tileX,
      tileY: pipe.tileY,
    });
  }

  const networks: SavePipeNetwork[] = [];
  for (let i = 0; i < state.networks.length; i++) {
    const network = state.networks[i]!;
    networks.push({
      deliveredMl: network.deliveredMl,
      demandMl: network.demandMl,
      id: network.id,
      liquid: network.liquid,
      rrOffset: network.rrOffset,
      supplyAccum: network.supplyAccum,
      supplyMl: network.supplyMl,
    });
  }

  const ceremonies: string[] = [];
  for (let i = 0; i < state.ceremonies.length; i++) ceremonies.push(state.ceremonies[i]!);

  const unlocked: string[] = [];
  for (let i = 0; i < state.unlocked.length; i++) unlocked.push(state.unlocked[i]!);

  // Sorted keys, never enumeration order. Two worlds that acquired the same streams in a
  // different order must serialize identically, exactly as they already hash identically.
  const streamKeys = Object.keys(state.streams).sort();
  const streams: SaveStream[] = [];
  for (let i = 0; i < streamKeys.length; i++) {
    const key = streamKeys[i]!;
    const rng = state.streams[key]!;
    streams.push({ id: key, s0: rng.s0, s1: rng.s1, s2: rng.s2, s3: rng.s3 });
  }

  const stats = state.stats;
  const samples: number[] = [];
  for (let i = 0; i < stats.netWorthSamples.length; i++) samples.push(stats.netWorthSamples[i]!);

  return {
    belts,
    ceremonies,
    field,
    grabbers,
    inventory,
    machines,
    moneyCents: state.moneyCents,
    networks,
    nextBeltId: state.nextBeltId,
    nextGrabberId: state.nextGrabberId,
    nextMachineId: state.nextMachineId,
    nextPipeId: state.nextPipeId,
    nextReservoirId: state.nextReservoirId,
    nextZoneId: state.nextZoneId,
    pipes,
    reservoirs,
    player: {
      facing: state.player.facing,
      // An explicit copy, never an alias. This file's stated guarantee is that the payload
      // shares no object with `state` and is therefore safe to build mid-tick — and the
      // errand is the one field on the player that is an object rather than a number.
      intent:
        state.player.intent === null
          ? null
          : {
              action: state.player.intent.action,
              count: state.player.intent.count,
              issuedTick: state.player.intent.issuedTick,
              item: state.player.intent.item,
              tileX: state.player.intent.tileX,
              tileY: state.player.intent.tileY,
            },
      moveAccum: state.player.moveAccum,
      moveDir: state.player.moveDir,
      xSub: state.player.xSub,
      ySub: state.player.ySub,
    },
    stats: {
      inputsWastedByMachine: stats.inputsWastedByMachine,
      itemsHarvestedByHand: stats.itemsHarvestedByHand,
      itemsProducedByMachine: stats.itemsProducedByMachine,
      itemsSold: stats.itemsSold,
      lifetimeEarnedCents: stats.lifetimeEarnedCents,
      lifetimeSpentCents: stats.lifetimeSpentCents,
      longestHandsFreeTicks: stats.longestHandsFreeTicks,
      netWorthCents: stats.netWorthCents,
      netWorthSamples: samples,
      nextNetWorthSampleTick: stats.nextNetWorthSampleTick,
      peakNetWorthCents: stats.peakNetWorthCents,
      repairKitSpendCents: stats.repairKitSpendCents,
      repairKitsUsed: stats.repairKitsUsed,
      ticksElapsed: stats.ticksElapsed,
      ticksSinceManualTouch: stats.ticksSinceManualTouch,
      touches: {
        handCarry: stats.touches.handCarry,
        handHarvest: stats.touches.handHarvest,
        handPlant: stats.touches.handPlant,
        handRepair: stats.touches.handRepair,
        handWater: stats.touches.handWater,
        hopperRefill: stats.touches.hopperRefill,
        jamWhack: stats.touches.jamWhack,
      },
      waterDrawnMl: stats.waterDrawnMl,
    },
    streams,
    tick: state.tick,
    unlocked,
    version: state.version,
    worldSeed: state.worldSeed,
    zones,
  };
}

// --- reading ----------------------------------------------------------------------
//
// Everything below treats the stored bytes as hostile. They came off a disk that a browser
// may have half-written, a text editor may have been pointed at, or a sync layer may have
// truncated. A validating reader that names the bad field beats a world full of `NaN` that
// only reveals itself twenty minutes later as a machine that never finishes an operation.

function fail(path: string, reason: string): never {
  throw new SaveCorruptError(`Save payload is not readable at \`${path}\`: ${reason}.`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(path, `expected an object, found ${describe(value)}`);
  }
  return value as Record<string, unknown>;
}

/**
 * An object, or an explicit `null`. `undefined` is NOT accepted.
 *
 * A missing key falls through to `record()` and fails loudly as `undefined`, which is what
 * we want: a format-4 payload always writes `intent`, so an absent one means the file is
 * damaged or the migration did not run. Quietly reading a missing key as "no errand" would
 * turn both of those into a world that looks fine.
 */
function recordOrNull(value: unknown, path: string): Record<string, unknown> | null {
  if (value === null) return null;
  return record(value, path);
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}

/** An integer, and nothing else — no floats, no NaN, no numeric strings, no `BigInt`. */
function int(source: Record<string, unknown>, key: string, path: string): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    fail(`${path}.${key}`, `expected an integer, found ${JSON.stringify(value) ?? 'undefined'}`);
  }
  return value;
}

/** An integer restricted to a known set, so an unrecognised id fails here and not later. */
function idInt(
  source: Record<string, unknown>,
  key: string,
  path: string,
  allowed: readonly number[],
): number {
  const value = int(source, key, path);
  for (let i = 0; i < allowed.length; i++) {
    if (allowed[i] === value) return value;
  }
  fail(`${path}.${key}`, `${String(value)} is not an id this build knows about`);
}

function bool(source: Record<string, unknown>, key: string, path: string): boolean {
  const value = source[key];
  if (typeof value !== 'boolean') {
    fail(`${path}.${key}`, `expected a boolean, found ${describe(value)}`);
  }
  return value;
}

function str(source: Record<string, unknown>, key: string, path: string): string {
  const value = source[key];
  if (typeof value !== 'string') {
    fail(`${path}.${key}`, `expected a string, found ${describe(value)}`);
  }
  return value;
}

function list(source: Record<string, unknown>, key: string, path: string): unknown[] {
  const value = source[key];
  if (!Array.isArray(value)) {
    fail(`${path}.${key}`, `expected an array, found ${describe(value)}`);
  }
  return value;
}

const CROP_IDS: readonly number[] = [
  CropId.None,
  CropId.RussetPotato,
  CropId.SugarCane,
  CropId.Corn,
  CropId.ChiliPepper,
];
const ITEM_IDS: readonly number[] = [
  ItemId.PotatoSeed,
  ItemId.RussetPotato,
  ItemId.BaggedChips,
  ItemId.WashedPotato,
  ItemId.PotatoSlices,
  ItemId.PlainChips,
  ItemId.SeasonedChips,
  ItemId.DayOldPotato,
  ItemId.Compost,
  ItemId.CaneSeed,
  ItemId.SugarCane,
  ItemId.DayOldCane,
  ItemId.CornSeed,
  ItemId.Corn,
  ItemId.DayOldCorn,
  ItemId.ChiliSeed,
  ItemId.ChiliPepper,
  ItemId.DayOldChili,
];
/** A grabber's filter and its hand both accept 0 for "nothing", on top of the real ids. */
const ITEM_IDS_OR_NONE: readonly number[] = [0, ...ITEM_IDS];
const MACHINE_KINDS: readonly number[] = [
  MachineKind.SellBin,
  MachineKind.ChipKitchen,
  MachineKind.Sprinkler,
  MachineKind.Washer,
  MachineKind.Slicer,
  MachineKind.Fryer,
  MachineKind.Seasoner,
  MachineKind.Bagger,
  MachineKind.Pump,
  MachineKind.Tank,
  MachineKind.PipedSprinkler,
  MachineKind.IrrigationHub,
  MachineKind.Recirculator,
];
/** `None` is not a legal liquid for a pipe: a pipe that carries nothing is not a pipe. */
const LIQUIDS: readonly number[] = [LiquidId.Water];
const BELT_TIERS: readonly number[] = [BeltTier.Basic, BeltTier.Fast, BeltTier.Express];
const GRABBER_TIERS: readonly number[] = [GrabberTier.Mk1, GrabberTier.Mk2, GrabberTier.Long];
/** Belts and grabbers face a compass direction. `None` is not a legal facing for either. */
const FACINGS: readonly number[] = [
  Direction.North,
  Direction.East,
  Direction.South,
  Direction.West,
];
const DIRECTIONS: readonly number[] = [
  Direction.None,
  Direction.North,
  Direction.East,
  Direction.South,
  Direction.West,
];
/** `None` is not a legal errand action: an errand to do nothing is what `null` is for. */
const ERRAND_ACTIONS: readonly number[] = [
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
 * Rebuild a `WorldState` from a canonical payload, validating as it goes.
 *
 * `trace` is supplied separately because it is stored separately; omit it and the world
 * comes back with an empty log, which is correct — the trace is a session artefact, not
 * part of the world, and nothing in the hash depends on it.
 *
 * Throws `SaveCorruptError` naming the first bad field.
 */
export function fromPayload(value: unknown, trace: readonly TraceLike[] = []): WorldState {
  const p = record(value, 'payload');

  const playerRaw = record(p['player'], 'payload.player');
  const intentRaw = recordOrNull(playerRaw['intent'], 'payload.player.intent');
  const intent: PlayerIntent | null =
    intentRaw === null
      ? null
      : {
          action: idInt(
            intentRaw,
            'action',
            'payload.player.intent',
            ERRAND_ACTIONS,
          ) as IntentAction,
          tileX: int(intentRaw, 'tileX', 'payload.player.intent'),
          tileY: int(intentRaw, 'tileY', 'payload.player.intent'),
          item: int(intentRaw, 'item', 'payload.player.intent'),
          count: int(intentRaw, 'count', 'payload.player.intent'),
          issuedTick: int(intentRaw, 'issuedTick', 'payload.player.intent'),
        };
  const player: PlayerState = {
    xSub: int(playerRaw, 'xSub', 'payload.player'),
    ySub: int(playerRaw, 'ySub', 'payload.player'),
    facing: idInt(playerRaw, 'facing', 'payload.player', DIRECTIONS) as Direction,
    moveDir: idInt(playerRaw, 'moveDir', 'payload.player', DIRECTIONS) as Direction,
    moveAccum: int(playerRaw, 'moveAccum', 'payload.player'),
    intent,
  };

  const inventoryRaw = list(p, 'inventory', 'payload');
  const inventory: WorldState['inventory'] = [];
  for (let i = 0; i < inventoryRaw.length; i++) {
    const path = `payload.inventory[${String(i)}]`;
    const slot = record(inventoryRaw[i], path);
    inventory.push({
      item: idInt(slot, 'item', path, ITEM_IDS) as ItemId,
      count: int(slot, 'count', path),
    });
  }

  const fieldRaw = list(p, 'field', 'payload');
  const field: CropTile[] = [];
  for (let i = 0; i < fieldRaw.length; i++) {
    const path = `payload.field[${String(i)}]`;
    const tile = record(fieldRaw[i], path);
    field.push({
      crop: idInt(tile, 'crop', path, CROP_IDS) as CropId,
      growth: int(tile, 'growth', path),
      growthTarget: int(tile, 'growthTarget', path),
      moisture: int(tile, 'moisture', path),
      fertility: int(tile, 'fertility', path),
      readyAge: int(tile, 'readyAge', path),
      compost: int(tile, 'compost', path),
      zone: int(tile, 'zone', path),
    });
  }

  const machinesRaw = list(p, 'machines', 'payload');
  const machines: Machine[] = [];
  for (let i = 0; i < machinesRaw.length; i++) {
    const path = `payload.machines[${String(i)}]`;
    const machine = record(machinesRaw[i], path);
    machines.push({
      id: int(machine, 'id', path),
      kind: idInt(machine, 'kind', path, MACHINE_KINDS) as MachineKind,
      tileX: int(machine, 'tileX', path),
      tileY: int(machine, 'tileY', path),
      progress: int(machine, 'progress', path),
      inputCount: int(machine, 'inputCount', path),
      outputCount: int(machine, 'outputCount', path),
      tankMl: int(machine, 'tankMl', path),
      condition: int(machine, 'condition', path),
      opCount: int(machine, 'opCount', path),
      jammed: bool(machine, 'jammed', path),
      blockedTicks: int(machine, 'blockedTicks', path),
      overcookedCount: int(machine, 'overcookedCount', path),
      cooldown: int(machine, 'cooldown', path),
      investedCents: int(machine, 'investedCents', path),
      speedLevel: int(machine, 'speedLevel', path),
      efficiencyLevel: int(machine, 'efficiencyLevel', path),
      capacityLevel: int(machine, 'capacityLevel', path),
      network: int(machine, 'network', path),
      flowMlPerMinute: int(machine, 'flowMlPerMinute', path),
      throttled: bool(machine, 'throttled', path),
      scanCursor: int(machine, 'scanCursor', path),
      wateredCount: int(machine, 'wateredCount', path),
      skippedCount: int(machine, 'skippedCount', path),
    });
  }

  const reservoirsRaw = list(p, 'reservoirs', 'payload');
  const reservoirs: Reservoir[] = [];
  for (let i = 0; i < reservoirsRaw.length; i++) {
    const path = `payload.reservoirs[${String(i)}]`;
    const reservoir = record(reservoirsRaw[i], path);
    reservoirs.push({
      id: int(reservoir, 'id', path),
      tileX: int(reservoir, 'tileX', path),
      tileY: int(reservoir, 'tileY', path),
      tilesWide: int(reservoir, 'tilesWide', path),
      tilesHigh: int(reservoir, 'tilesHigh', path),
      levelMl: int(reservoir, 'levelMl', path),
      capacityMl: int(reservoir, 'capacityMl', path),
      rechargeAccum: int(reservoir, 'rechargeAccum', path),
    });
  }

  const pipesRaw = list(p, 'pipes', 'payload');
  const pipes: Pipe[] = [];
  for (let i = 0; i < pipesRaw.length; i++) {
    const path = `payload.pipes[${String(i)}]`;
    const pipe = record(pipesRaw[i], path);
    pipes.push({
      id: int(pipe, 'id', path),
      tileX: int(pipe, 'tileX', path),
      tileY: int(pipe, 'tileY', path),
      liquid: idInt(pipe, 'liquid', path, LIQUIDS) as LiquidId,
      network: int(pipe, 'network', path),
    });
  }

  const networksRaw = list(p, 'networks', 'payload');
  const networks: PipeNetwork[] = [];
  for (let i = 0; i < networksRaw.length; i++) {
    const path = `payload.networks[${String(i)}]`;
    const network = record(networksRaw[i], path);
    networks.push({
      id: int(network, 'id', path),
      liquid: idInt(network, 'liquid', path, LIQUIDS) as LiquidId,
      supplyAccum: int(network, 'supplyAccum', path),
      rrOffset: int(network, 'rrOffset', path),
      supplyMl: int(network, 'supplyMl', path),
      demandMl: int(network, 'demandMl', path),
      deliveredMl: int(network, 'deliveredMl', path),
    });
  }

  const ceremoniesRaw = list(p, 'ceremonies', 'payload');
  const ceremonies: string[] = [];
  for (let i = 0; i < ceremoniesRaw.length; i++) {
    const value = ceremoniesRaw[i];
    if (typeof value !== 'string') {
      fail(`payload.ceremonies[${String(i)}]`, 'expected a string ceremony id');
    }
    ceremonies.push(value);
  }
  ceremonies.sort();

  const beltsRaw = list(p, 'belts', 'payload');
  const belts: Belt[] = [];
  for (let i = 0; i < beltsRaw.length; i++) {
    const path = `payload.belts[${String(i)}]`;
    const belt = record(beltsRaw[i], path);
    const itemsRaw = list(belt, 'items', path);
    const items: Belt['items'] = [];
    for (let j = 0; j < itemsRaw.length; j++) {
      const itemPath = `${path}.items[${String(j)}]`;
      const entry = record(itemsRaw[j], itemPath);
      items.push({
        dist: int(entry, 'dist', itemPath),
        item: idInt(entry, 'item', itemPath, ITEM_IDS) as ItemId,
      });
    }
    belts.push({
      id: int(belt, 'id', path),
      tileX: int(belt, 'tileX', path),
      tileY: int(belt, 'tileY', path),
      dir: idInt(belt, 'dir', path, FACINGS) as Direction,
      lengthTiles: int(belt, 'lengthTiles', path),
      tier: idInt(belt, 'tier', path, BELT_TIERS) as BeltTier,
      items,
      moveAccum: int(belt, 'moveAccum', path),
    });
  }

  const grabbersRaw = list(p, 'grabbers', 'payload');
  const grabbers: Grabber[] = [];
  for (let i = 0; i < grabbersRaw.length; i++) {
    const path = `payload.grabbers[${String(i)}]`;
    const grabber = record(grabbersRaw[i], path);
    grabbers.push({
      id: int(grabber, 'id', path),
      tileX: int(grabber, 'tileX', path),
      tileY: int(grabber, 'tileY', path),
      dir: idInt(grabber, 'dir', path, FACINGS) as Direction,
      tier: idInt(grabber, 'tier', path, GRABBER_TIERS) as GrabberTier,
      filter: idInt(grabber, 'filter', path, ITEM_IDS_OR_NONE),
      held: idInt(grabber, 'held', path, ITEM_IDS_OR_NONE),
      cooldown: int(grabber, 'cooldown', path),
      opCount: int(grabber, 'opCount', path),
    });
  }

  const zonesRaw = list(p, 'zones', 'payload');
  const zones: Zone[] = [];
  for (let i = 0; i < zonesRaw.length; i++) {
    const path = `payload.zones[${String(i)}]`;
    const zone = record(zonesRaw[i], path);
    zones.push({
      id: int(zone, 'id', path),
      name: str(zone, 'name', path),
      crop: idInt(zone, 'crop', path, CROP_IDS) as CropId,
      priority: int(zone, 'priority', path),
      autoReplant: bool(zone, 'autoReplant', path),
      replantCooldown: int(zone, 'replantCooldown', path),
    });
  }

  // Unknown node ids are kept rather than rejected: a save written by a newer balance patch
  // that this build then reads has already passed the formatVersion gate, and dropping a
  // node the player paid for would be worse than carrying a string nothing looks up.
  const unlockedRaw = list(p, 'unlocked', 'payload');
  const unlocked: string[] = [];
  for (let i = 0; i < unlockedRaw.length; i++) {
    const value = unlockedRaw[i];
    if (typeof value !== 'string') {
      fail(`payload.unlocked[${String(i)}]`, 'expected a string node id');
    }
    unlocked.push(value);
  }
  unlocked.sort();

  const streamsRaw = list(p, 'streams', 'payload');
  const streams: Record<string, RngState> = {};
  for (let i = 0; i < streamsRaw.length; i++) {
    const path = `payload.streams[${String(i)}]`;
    const stream = record(streamsRaw[i], path);
    streams[str(stream, 'id', path)] = {
      s0: int(stream, 's0', path),
      s1: int(stream, 's1', path),
      s2: int(stream, 's2', path),
      s3: int(stream, 's3', path),
    };
  }

  const statsRaw = record(p['stats'], 'payload.stats');
  const touchesRaw = record(statsRaw['touches'], 'payload.stats.touches');
  const touches: ManualTouchCounts = {
    handWater: int(touchesRaw, 'handWater', 'payload.stats.touches'),
    handPlant: int(touchesRaw, 'handPlant', 'payload.stats.touches'),
    handHarvest: int(touchesRaw, 'handHarvest', 'payload.stats.touches'),
    handCarry: int(touchesRaw, 'handCarry', 'payload.stats.touches'),
    handRepair: int(touchesRaw, 'handRepair', 'payload.stats.touches'),
    jamWhack: int(touchesRaw, 'jamWhack', 'payload.stats.touches'),
    hopperRefill: int(touchesRaw, 'hopperRefill', 'payload.stats.touches'),
  };

  const samplesRaw = list(statsRaw, 'netWorthSamples', 'payload.stats');
  const netWorthSamples: number[] = [];
  for (let i = 0; i < samplesRaw.length; i++) {
    const sample = samplesRaw[i];
    if (typeof sample !== 'number' || !Number.isInteger(sample)) {
      fail(`payload.stats.netWorthSamples[${String(i)}]`, 'expected an integer');
    }
    netWorthSamples.push(sample);
  }

  const stats: WorldStats = {
    ticksElapsed: int(statsRaw, 'ticksElapsed', 'payload.stats'),
    lifetimeEarnedCents: int(statsRaw, 'lifetimeEarnedCents', 'payload.stats'),
    lifetimeSpentCents: int(statsRaw, 'lifetimeSpentCents', 'payload.stats'),
    waterDrawnMl: int(statsRaw, 'waterDrawnMl', 'payload.stats'),
    itemsSold: int(statsRaw, 'itemsSold', 'payload.stats'),
    itemsProducedByMachine: int(statsRaw, 'itemsProducedByMachine', 'payload.stats'),
    itemsHarvestedByHand: int(statsRaw, 'itemsHarvestedByHand', 'payload.stats'),
    inputsWastedByMachine: int(statsRaw, 'inputsWastedByMachine', 'payload.stats'),
    repairKitsUsed: int(statsRaw, 'repairKitsUsed', 'payload.stats'),
    repairKitSpendCents: int(statsRaw, 'repairKitSpendCents', 'payload.stats'),
    netWorthCents: int(statsRaw, 'netWorthCents', 'payload.stats'),
    peakNetWorthCents: int(statsRaw, 'peakNetWorthCents', 'payload.stats'),
    netWorthSamples,
    nextNetWorthSampleTick: int(statsRaw, 'nextNetWorthSampleTick', 'payload.stats'),
    ticksSinceManualTouch: int(statsRaw, 'ticksSinceManualTouch', 'payload.stats'),
    longestHandsFreeTicks: int(statsRaw, 'longestHandsFreeTicks', 'payload.stats'),
    touches,
  };

  const restoredTrace: TraceEntry[] = [];
  for (let i = 0; i < trace.length; i++) restoredTrace.push(trace[i]! as TraceEntry);

  return {
    version: int(p, 'version', 'payload'),
    worldSeed: int(p, 'worldSeed', 'payload'),
    tick: int(p, 'tick', 'payload'),
    moneyCents: int(p, 'moneyCents', 'payload'),
    player,
    inventory,
    field,
    machines,
    nextMachineId: int(p, 'nextMachineId', 'payload'),
    belts,
    nextBeltId: int(p, 'nextBeltId', 'payload'),
    grabbers,
    nextGrabberId: int(p, 'nextGrabberId', 'payload'),
    zones,
    nextZoneId: int(p, 'nextZoneId', 'payload'),
    reservoirs,
    nextReservoirId: int(p, 'nextReservoirId', 'payload'),
    pipes,
    nextPipeId: int(p, 'nextPipeId', 'payload'),
    networks,
    ceremonies,
    unlocked,
    streams,
    stats,
    trace: restoredTrace,
  };
}

/**
 * The trace entries a host may hand back at load, kept structural so the storage layer does
 * not have to import the `TraceEntry` nominal type to satisfy it.
 */
export interface TraceLike {
  tick: number;
  command: unknown;
}
