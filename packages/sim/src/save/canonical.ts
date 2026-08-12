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

import { CropId, ItemId, MachineKind } from '../data';
import type { RngState } from '../rng';
import {
  type CropTile,
  type Machine,
  type PlayerState,
  type TraceEntry,
  type WorldState,
  Direction,
} from '../state';
import type { ManualTouchCounts, WorldStats } from '../stats';
import { SaveCorruptError } from './errors';

// --- the payload shape ------------------------------------------------------------

export interface SavePlayer {
  facing: number;
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
  crop: number;
  fertility: number;
  growth: number;
  growthTarget: number;
  moisture: number;
}

export interface SaveMachine {
  condition: number;
  cooldown: number;
  id: number;
  inputCount: number;
  jammed: boolean;
  kind: number;
  opCount: number;
  outputCount: number;
  progress: number;
  tankMl: number;
  tileX: number;
  tileY: number;
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
  ticksElapsed: number;
  ticksSinceManualTouch: number;
  touches: SaveTouchCounts;
  waterDrawnMl: number;
}

/** `WorldState` minus the trace, in canonical form. */
export interface SavePayload {
  field: SaveCropTile[];
  inventory: SaveInventorySlot[];
  machines: SaveMachine[];
  moneyCents: number;
  nextMachineId: number;
  player: SavePlayer;
  stats: SaveStats;
  streams: SaveStream[];
  tick: number;
  version: number;
  worldSeed: number;
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
      crop: tile.crop,
      fertility: tile.fertility,
      growth: tile.growth,
      growthTarget: tile.growthTarget,
      moisture: tile.moisture,
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
      condition: machine.condition,
      cooldown: machine.cooldown,
      id: machine.id,
      inputCount: machine.inputCount,
      jammed: machine.jammed,
      kind: machine.kind,
      opCount: machine.opCount,
      outputCount: machine.outputCount,
      progress: machine.progress,
      tankMl: machine.tankMl,
      tileX: machine.tileX,
      tileY: machine.tileY,
    });
  }

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
    field,
    inventory,
    machines,
    moneyCents: state.moneyCents,
    nextMachineId: state.nextMachineId,
    player: {
      facing: state.player.facing,
      moveAccum: state.player.moveAccum,
      moveDir: state.player.moveDir,
      xSub: state.player.xSub,
      ySub: state.player.ySub,
    },
    stats: {
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
    version: state.version,
    worldSeed: state.worldSeed,
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

const CROP_IDS: readonly number[] = [CropId.None, CropId.RussetPotato];
const ITEM_IDS: readonly number[] = [ItemId.PotatoSeed, ItemId.RussetPotato, ItemId.BaggedChips];
const MACHINE_KINDS: readonly number[] = [
  MachineKind.SellBin,
  MachineKind.ChipKitchen,
  MachineKind.Sprinkler,
];
const DIRECTIONS: readonly number[] = [
  Direction.None,
  Direction.North,
  Direction.East,
  Direction.South,
  Direction.West,
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
  const player: PlayerState = {
    xSub: int(playerRaw, 'xSub', 'payload.player'),
    ySub: int(playerRaw, 'ySub', 'payload.player'),
    facing: idInt(playerRaw, 'facing', 'payload.player', DIRECTIONS) as Direction,
    moveDir: idInt(playerRaw, 'moveDir', 'payload.player', DIRECTIONS) as Direction,
    moveAccum: int(playerRaw, 'moveAccum', 'payload.player'),
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
      cooldown: int(machine, 'cooldown', path),
    });
  }

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
