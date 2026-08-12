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
  MachineRole,
  WORLD_TILES_HIGH,
  WORLD_TILES_WIDE,
  WiltStage,
  cropSpec,
  grabberSpec,
  machineSpec,
  wiltStageForAge,
} from './data';
import type { CropTile, WorldState } from './state';
import {
  bestTrailingGainCents,
  centiActiveHoursElapsed,
  centsPerKilolitre,
  lifetimeNetEarningsCents,
  totalManualTouches,
} from './stats';
import { effectiveInputCapacity, effectiveOutputCapacity } from './upgrades';
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
  /** `WiltStage` per tile: 0 fresh, 1 drooping, 2 turned. */
  wilt: number[];
  /** Ticks the tile has stood mature, for the "going Day-Old" countdown in the HUD. */
  readyAge: number[];
  /** Compost lying on the tile, waiting to be picked up. */
  compost: number[];
  /** Owning zone id, or 0. Drives the chunked zone-paint bake. */
  zone: number[];
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
  /** Effective buffer sizes, after the Capacity dial. */
  inputCapacity: number;
  outputCapacity: number;
  /** `ItemId` the machine eats and makes, or 0. Saves the HUD a spec lookup. */
  inputItem: number;
  outputItem: number;
  /** 0..3 on each dial, so the renderer can bolt on chrome exhausts and bigger hoppers. */
  speedLevel: number;
  efficiencyLevel: number;
  capacityLevel: number;
}

/**
 * One belt segment and the items riding it.
 *
 * `itemDist` and `itemType` are PARALLEL ARRAYS, not objects, because the renderer wants
 * columns: it walks them straight into a pooled particle buffer. Both are trimmed to
 * `itemCount` on every projection, so a belt that empties does not leave stale tails.
 */
export interface BeltView {
  id: number;
  tileX: number;
  tileY: number;
  dir: number;
  lengthTiles: number;
  tier: number;
  itemCount: number;
  /** Subtiles from the belt's start, ascending. */
  itemDist: number[];
  /** `ItemId` per entry, same index. */
  itemType: number[];
}

export interface GrabberView {
  id: number;
  tileX: number;
  tileY: number;
  dir: number;
  tier: number;
  /** `ItemId` filter, or 0 for unfiltered. */
  filter: number;
  /** `ItemId` in the hand, or 0. */
  held: number;
  /** How far through the current swing, for the arm animation. */
  swingPermille: number;
  opCount: number;
}

/** A zone card's live readout, already reduced. Plan §5's "47/60 planted · 12 mature · 3 dry". */
export interface ZoneView {
  id: number;
  name: string;
  crop: number;
  priority: number;
  /** 1 when auto-replant is armed. */
  autoReplant: number;
  tiles: number;
  planted: number;
  mature: number;
  wilting: number;
  wilted: number;
  dry: number;
  compost: number;
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
  belts: BeltView[];
  grabbers: GrabberView[];
  zones: ZoneView[];
  inventory: InventoryView[];
  /** Researched tech node ids, sorted. Copied, so the HUD cannot mutate the world's list. */
  unlocked: string[];
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
      wilt: new Array<number>(FIELD_TILE_COUNT).fill(0),
      readyAge: new Array<number>(FIELD_TILE_COUNT).fill(0),
      compost: new Array<number>(FIELD_TILE_COUNT).fill(0),
      zone: new Array<number>(FIELD_TILE_COUNT).fill(0),
    },
    machines: [],
    belts: [],
    grabbers: [],
    zones: [],
    inventory: [],
    unlocked: [],
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
  projectBelts(state, out);
  projectGrabbers(state, out);
  projectZones(state, out);
  projectInventory(state, out);
  projectUnlocked(state, out);
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
    field.wilt[i] = ready ? wiltStageForAge(tile.readyAge) : WiltStage.Fresh;
    field.readyAge[i] = tile.readyAge;
    field.compost[i] = tile.compost;
    field.zone[i] = tile.zone;
  }

  field.crop.length = state.field.length;
  field.stage.length = state.field.length;
  field.moisturePermille.length = state.field.length;
  field.ready.length = state.field.length;
  field.dry.length = state.field.length;
  field.fertility.length = state.field.length;
  field.wilt.length = state.field.length;
  field.readyAge.length = state.field.length;
  field.compost.length = state.field.length;
  field.zone.length = state.field.length;
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
        inputCapacity: 0,
        outputCapacity: 0,
        inputItem: 0,
        outputItem: 0,
        speedLevel: 0,
        efficiencyLevel: 0,
        capacityLevel: 0,
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
    mv.inputCapacity = spec === null ? 0 : effectiveInputCapacity(spec, machine);
    mv.outputCapacity = spec === null ? 0 : effectiveOutputCapacity(spec, machine);
    mv.inputItem = spec === null || spec.inputItem === null ? 0 : spec.inputItem;
    mv.outputItem = spec === null || spec.outputItem === null ? 0 : spec.outputItem;
    mv.speedLevel = machine.speedLevel;
    mv.efficiencyLevel = machine.efficiencyLevel;
    mv.capacityLevel = machine.capacityLevel;
  }

  out.machines.length = count;
}

/**
 * Belts, items and all.
 *
 * The item arrays are reused and trimmed rather than rebuilt: at three belt tiers and a
 * mature base this is the hottest loop in the projection, and it is the one place where
 * "plain data in reused buffers" earns its keep twenty times a second.
 */
function projectBelts(state: WorldState, out: WorldView): void {
  const count = state.belts.length;

  for (let i = 0; i < count; i++) {
    const belt = state.belts[i]!;

    let bv = out.belts[i];
    if (bv === undefined) {
      bv = {
        id: 0,
        tileX: 0,
        tileY: 0,
        dir: 0,
        lengthTiles: 0,
        tier: 0,
        itemCount: 0,
        itemDist: [],
        itemType: [],
      };
      out.belts.push(bv);
    }

    bv.id = belt.id;
    bv.tileX = belt.tileX;
    bv.tileY = belt.tileY;
    bv.dir = belt.dir;
    bv.lengthTiles = belt.lengthTiles;
    bv.tier = belt.tier;

    const items = belt.items.length;
    for (let j = 0; j < items; j++) {
      const entry = belt.items[j]!;
      bv.itemDist[j] = entry.dist;
      bv.itemType[j] = entry.item;
    }
    bv.itemDist.length = items;
    bv.itemType.length = items;
    bv.itemCount = items;
  }

  out.belts.length = count;
}

function projectGrabbers(state: WorldState, out: WorldView): void {
  const count = state.grabbers.length;

  for (let i = 0; i < count; i++) {
    const grabber = state.grabbers[i]!;
    const spec = grabberSpec(grabber.tier);

    let gv = out.grabbers[i];
    if (gv === undefined) {
      gv = {
        id: 0,
        tileX: 0,
        tileY: 0,
        dir: 0,
        tier: 0,
        filter: 0,
        held: 0,
        swingPermille: 0,
        opCount: 0,
      };
      out.grabbers.push(gv);
    }

    gv.id = grabber.id;
    gv.tileX = grabber.tileX;
    gv.tileY = grabber.tileY;
    gv.dir = grabber.dir;
    gv.tier = grabber.tier;
    gv.filter = grabber.filter;
    gv.held = grabber.held;
    gv.swingPermille =
      spec === null || spec.swingTicks <= 0
        ? 0
        : permille(spec.swingTicks - grabber.cooldown, spec.swingTicks);
    gv.opCount = grabber.opCount;
  }

  out.grabbers.length = count;
}

/**
 * Zone cards, with their readouts already counted.
 *
 * One pass over the field per projection rather than one per zone: the counts are gathered
 * into the view objects in a single sweep, keyed by the tile's owner. Zones are few and the
 * field is small, but the shape is the one that stays cheap when the map is 64×64.
 */
function projectZones(state: WorldState, out: WorldView): void {
  const count = state.zones.length;

  for (let i = 0; i < count; i++) {
    const zone = state.zones[i]!;

    let zv = out.zones[i];
    if (zv === undefined) {
      zv = {
        id: 0,
        name: '',
        crop: 0,
        priority: 0,
        autoReplant: 0,
        tiles: 0,
        planted: 0,
        mature: 0,
        wilting: 0,
        wilted: 0,
        dry: 0,
        compost: 0,
      };
      out.zones.push(zv);
    }

    zv.id = zone.id;
    zv.name = zone.name;
    zv.crop = zone.crop;
    zv.priority = zone.priority;
    zv.autoReplant = zone.autoReplant ? 1 : 0;
    zv.tiles = 0;
    zv.planted = 0;
    zv.mature = 0;
    zv.wilting = 0;
    zv.wilted = 0;
    zv.dry = 0;
    zv.compost = 0;
  }

  out.zones.length = count;
  if (count === 0) return;

  for (let i = 0; i < state.field.length; i++) {
    const tile = state.field[i]!;
    if (tile.zone === 0) continue;

    let zv: ZoneView | undefined;
    for (let j = 0; j < count; j++) {
      const candidate = out.zones[j]!;
      if (candidate.id === tile.zone) {
        zv = candidate;
        break;
      }
    }
    if (zv === undefined) continue;

    zv.tiles += 1;
    zv.compost += tile.compost;
    if (tile.moisture < MOISTURE_DRY_THRESHOLD) zv.dry += 1;
    if (tile.crop === CropId.None) continue;

    zv.planted += 1;
    if (tile.growth < tile.growthTarget) continue;

    const stage = wiltStageForAge(tile.readyAge);
    if (stage === WiltStage.Wilted) zv.wilted += 1;
    else if (stage === WiltStage.Wilting) zv.wilting += 1;
    else zv.mature += 1;
  }
}

function projectUnlocked(state: WorldState, out: WorldView): void {
  for (let i = 0; i < state.unlocked.length; i++) {
    out.unlocked[i] = state.unlocked[i]!;
  }
  out.unlocked.length = state.unlocked.length;
}

function lampFor(state: WorldState, index: number): LampState {
  const machine = state.machines[index]!;
  const spec = machineSpec(machine.kind);
  if (spec === null) return LampState.Off;

  if (machine.jammed) return LampState.Jammed;
  if (machine.condition <= 0) return LampState.Halted;

  if (spec.role === MachineRole.Sprinkler) {
    return machine.tankMl <= 0 ? LampState.UtilityMissing : LampState.Running;
  }

  if (spec.workPerOperation <= 0) return LampState.Off;
  // Blocked before starved: a machine that is both is a downstream problem, and plan §5's
  // grammar says a red lamp means look downstream while amber means look upstream.
  if (machine.outputCount >= effectiveOutputCapacity(spec, machine)) return LampState.Blocked;
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
