// The render projection.
//
// `view()` RETURNS PLAIN SERIALIZABLE DATA — numbers and arrays written into reused
// buffers — NOT REFERENCES INTO LIVE STATE. Plan §12 rules on this explicitly and the
// ruling is not negotiable: handing out live references is free today and would make the
// eventual move to a Worker a rewrite instead of a transport change. Everything below is
// structured-cloneable and JSON-safe.
//
// The buffers are reused so a 20 Hz projection does not allocate a fresh world twenty
// times a second. Call `createWorldView()` once per host, keep it, and pass it back in.
// The returned object is only valid until the next `view()` call on the same buffer — a
// consumer that wants to keep a snapshot must copy it.
//
// Interpolated render positions are WRITE-ONLY and do not appear here. They exist in the
// renderer, are never read back into the sim, never persisted, and never hashed. The `alpha`
// the host passes to its draw call is the renderer's business alone.

import {
  CONDITION_EFFECT_THRESHOLD,
  CONDITION_MAX,
  CropId,
  FIELD_ORIGIN_X,
  FIELD_ORIGIN_Y,
  FIELD_TILES_HIGH,
  FIELD_TILES_WIDE,
  FIELD_TILE_COUNT,
  MOISTURE_DRY_THRESHOLD,
  MOISTURE_MAX,
  MachineKind,
  WORLD_TILES_HIGH,
  WORLD_TILES_WIDE,
  cropSpec,
  machineSpec,
} from './data';
import type { CropTile, WorldState } from './state';
import {
  bestTrailingGainCents,
  centiActiveHoursElapsed,
  centsPerKilolitre,
  lifetimeNetEarningsCents,
  totalManualTouches,
} from './stats';
import { beatIndex, clampInt, divFloor, permille } from './units';

/**
 * Plan §5's status-lamp grammar, plus `Jammed`, which the renderer draws as the red
 * blocked lamp with its own icon. One grammar everywhere: a lamp means the same thing on
 * every machine in the game.
 */
export const LampState = {
  /** No work cycle — the sell bin, a decorative object. */
  Off: 0,
  /** Green. */
  Running: 1,
  /** Amber: no input. Look upstream. */
  Starved: 2,
  /** Red: output full. Look downstream. */
  Blocked: 3,
  /** Blue: a utility is missing — an empty sprinkler barrel, later an empty pipe. */
  UtilityMissing: 4,
  /** Red, with the whack icon. */
  Jammed: 5,
  /** Stopped dead at zero condition. Costs nothing, never explodes. */
  Halted: 6,
} as const;

export type LampState = (typeof LampState)[keyof typeof LampState];

/**
 * The field as parallel arrays, one entry per tile in row-major order. Parallel arrays
 * rather than per-tile objects because the renderer wants columns, and because 64 numbers
 * copy faster than 64 object writes.
 */
export interface FieldView {
  originX: number;
  originY: number;
  tilesWide: number;
  tilesHigh: number;
  /** `CropId` per tile. */
  crop: number[];
  /** Renderer growth stage, 0 (bare) up to the crop's ready stage. */
  stage: number[];
  /** Moisture as permille of full, so the ground can darken smoothly. */
  moisturePermille: number[];
  /** 1 when the tile can be harvested. */
  ready: number[];
  /** 1 when the tile reads as dry to the player. */
  dry: number[];
  fertility: number[];
}

export interface MachineView {
  id: number;
  kind: number;
  tileX: number;
  tileY: number;
  tilesWide: number;
  tilesHigh: number;
  lamp: number;
  /** 1 when the wrench overlay should show, independent of the lamp. */
  wrenchDue: number;
  progressPermille: number;
  conditionPermille: number;
  tankPermille: number;
  inputCount: number;
  outputCount: number;
}

export interface InventoryView {
  item: number;
  count: number;
}

/** The numbers the HUD panel reads, already reduced. All integers, all cents or counts. */
export interface StatsView {
  centiActiveHours: number;
  lifetimeNetEarningsCents: number;
  netWorthCents: number;
  peakNetWorthCents: number;
  bestTrailingFiveHourGainCents: number;
  waterDrawnMl: number;
  centsPerKilolitre: number;
  itemsSold: number;
  itemsProducedByMachine: number;
  itemsHarvestedByHand: number;
  totalManualTouches: number;
  longestHandsFreeTicks: number;
}

export interface PlayerView {
  xSub: number;
  ySub: number;
  facing: number;
  /** 1 while a direction is held. */
  moving: number;
}

export interface WorldView {
  tick: number;
  /** The Music Box beat this tick falls on. Audio schedules ahead against it. */
  beat: number;
  worldTilesWide: number;
  worldTilesHigh: number;
  moneyCents: number;
  player: PlayerView;
  field: FieldView;
  machines: MachineView[];
  inventory: InventoryView[];
  stats: StatsView;
}

const TRAILING_WINDOW_MINUTES = 300;

/** Allocate a projection buffer. One per host; reuse it forever. */
export function createWorldView(): WorldView {
  return {
    tick: 0,
    beat: 0,
    worldTilesWide: WORLD_TILES_WIDE,
    worldTilesHigh: WORLD_TILES_HIGH,
    moneyCents: 0,
    player: { xSub: 0, ySub: 0, facing: 0, moving: 0 },
    field: {
      originX: FIELD_ORIGIN_X,
      originY: FIELD_ORIGIN_Y,
      tilesWide: FIELD_TILES_WIDE,
      tilesHigh: FIELD_TILES_HIGH,
      crop: new Array<number>(FIELD_TILE_COUNT).fill(0),
      stage: new Array<number>(FIELD_TILE_COUNT).fill(0),
      moisturePermille: new Array<number>(FIELD_TILE_COUNT).fill(0),
      ready: new Array<number>(FIELD_TILE_COUNT).fill(0),
      dry: new Array<number>(FIELD_TILE_COUNT).fill(0),
      fertility: new Array<number>(FIELD_TILE_COUNT).fill(0),
    },
    machines: [],
    inventory: [],
    stats: {
      centiActiveHours: 0,
      lifetimeNetEarningsCents: 0,
      netWorthCents: 0,
      peakNetWorthCents: 0,
      bestTrailingFiveHourGainCents: 0,
      waterDrawnMl: 0,
      centsPerKilolitre: 0,
      itemsSold: 0,
      itemsProducedByMachine: 0,
      itemsHarvestedByHand: 0,
      totalManualTouches: 0,
      longestHandsFreeTicks: 0,
    },
  };
}

/**
 * Project the world into `out`, allocating a fresh buffer only if none is given.
 *
 * Nothing in the result aliases `state`. Every number is copied.
 */
export function view(state: WorldState, out: WorldView = createWorldView()): WorldView {
  out.tick = state.tick;
  out.beat = beatIndex(state.tick);
  out.worldTilesWide = WORLD_TILES_WIDE;
  out.worldTilesHigh = WORLD_TILES_HIGH;
  out.moneyCents = state.moneyCents;

  out.player.xSub = state.player.xSub;
  out.player.ySub = state.player.ySub;
  out.player.facing = state.player.facing;
  out.player.moving = state.player.moveDir === 0 ? 0 : 1;

  projectField(state, out);
  projectMachines(state, out);
  projectInventory(state, out);
  projectStats(state, out);

  return out;
}

function projectField(state: WorldState, out: WorldView): void {
  const field = out.field;
  field.originX = FIELD_ORIGIN_X;
  field.originY = FIELD_ORIGIN_Y;
  field.tilesWide = FIELD_TILES_WIDE;
  field.tilesHigh = FIELD_TILES_HIGH;

  for (let i = 0; i < state.field.length; i++) {
    const tile = state.field[i]!;
    const ready = tile.crop !== CropId.None && tile.growth >= tile.growthTarget;
    field.crop[i] = tile.crop;
    field.stage[i] = growthStage(tile);
    field.moisturePermille[i] = permille(tile.moisture, MOISTURE_MAX);
    field.ready[i] = ready ? 1 : 0;
    field.dry[i] = tile.moisture < MOISTURE_DRY_THRESHOLD ? 1 : 0;
    field.fertility[i] = tile.fertility;
  }

  field.crop.length = state.field.length;
  field.stage.length = state.field.length;
  field.moisturePermille.length = state.field.length;
  field.ready.length = state.field.length;
  field.dry.length = state.field.length;
  field.fertility.length = state.field.length;
}

/** Bare soil is stage 0, ready is the crop's last stage, and growth fills the middle. */
export function growthStage(tile: CropTile): number {
  if (tile.crop === CropId.None) return 0;
  const spec = cropSpec(tile.crop);
  if (spec === null) return 0;
  if (tile.growth >= tile.growthTarget) return spec.stageCount - 1;

  const growingStages = spec.stageCount - 2;
  if (growingStages <= 0) return 0;
  const target = tile.growthTarget > 0 ? tile.growthTarget : 1;
  const stage = divFloor(tile.growth * growingStages, target);
  return 1 + clampInt(stage, 0, growingStages - 1);
}

function projectMachines(state: WorldState, out: WorldView): void {
  const count = state.machines.length;

  for (let i = 0; i < count; i++) {
    const machine = state.machines[i]!;
    const spec = machineSpec(machine.kind);

    let mv = out.machines[i];
    if (mv === undefined) {
      mv = {
        id: 0,
        kind: 0,
        tileX: 0,
        tileY: 0,
        tilesWide: 1,
        tilesHigh: 1,
        lamp: LampState.Off,
        wrenchDue: 0,
        progressPermille: 0,
        conditionPermille: 0,
        tankPermille: 0,
        inputCount: 0,
        outputCount: 0,
      };
      out.machines.push(mv);
    }

    mv.id = machine.id;
    mv.kind = machine.kind;
    mv.tileX = machine.tileX;
    mv.tileY = machine.tileY;
    mv.tilesWide = spec === null ? 1 : spec.tilesWide;
    mv.tilesHigh = spec === null ? 1 : spec.tilesHigh;
    mv.lamp = lampFor(state, i);
    mv.wrenchDue = machine.condition < CONDITION_EFFECT_THRESHOLD ? 1 : 0;
    mv.progressPermille =
      spec === null || spec.workPerOperation <= 0
        ? 0
        : permille(machine.progress, spec.workPerOperation);
    mv.conditionPermille = permille(machine.condition, CONDITION_MAX);
    mv.tankPermille =
      spec === null || spec.tankCapacityMl <= 0 ? 0 : permille(machine.tankMl, spec.tankCapacityMl);
    mv.inputCount = machine.inputCount;
    mv.outputCount = machine.outputCount;
  }

  out.machines.length = count;
}

function lampFor(state: WorldState, index: number): LampState {
  const machine = state.machines[index]!;
  const spec = machineSpec(machine.kind);
  if (spec === null) return LampState.Off;

  if (machine.jammed) return LampState.Jammed;
  if (machine.condition <= 0) return LampState.Halted;

  if (machine.kind === MachineKind.Sprinkler) {
    return machine.tankMl <= 0 ? LampState.UtilityMissing : LampState.Running;
  }

  if (spec.workPerOperation <= 0) return LampState.Off;
  if (machine.outputCount >= spec.outputCapacity) return LampState.Blocked;
  if (machine.inputCount <= 0) return LampState.Starved;
  return LampState.Running;
}

function projectInventory(state: WorldState, out: WorldView): void {
  const count = state.inventory.length;
  for (let i = 0; i < count; i++) {
    const slot = state.inventory[i]!;
    let iv = out.inventory[i];
    if (iv === undefined) {
      iv = { item: 0, count: 0 };
      out.inventory.push(iv);
    }
    iv.item = slot.item;
    iv.count = slot.count;
  }
  out.inventory.length = count;
}

function projectStats(state: WorldState, out: WorldView): void {
  const stats = state.stats;
  const s = out.stats;
  s.centiActiveHours = centiActiveHoursElapsed(stats);
  s.lifetimeNetEarningsCents = lifetimeNetEarningsCents(stats);
  s.netWorthCents = stats.netWorthCents;
  s.peakNetWorthCents = stats.peakNetWorthCents;
  s.bestTrailingFiveHourGainCents = bestTrailingGainCents(stats, TRAILING_WINDOW_MINUTES);
  s.waterDrawnMl = stats.waterDrawnMl;
  s.centsPerKilolitre = centsPerKilolitre(stats);
  s.itemsSold = stats.itemsSold;
  s.itemsProducedByMachine = stats.itemsProducedByMachine;
  s.itemsHarvestedByHand = stats.itemsHarvestedByHand;
  s.totalManualTouches = totalManualTouches(stats.touches);
  s.longestHandsFreeTicks = stats.longestHandsFreeTicks;
}
