// The tick.
//
// `step()` MUTATES `state` IN PLACE and returns nothing. That is a deliberate choice, not
// an optimisation that leaked: the renderer never holds a reference into the world — it
// reads through the `view()` seam — so there is no consumer that needs the old state to
// survive. Copy-on-write would allocate a world 20 times a second to serve nobody.
//
// System order is fixed and documented, because "the order systems run in" is exactly the
// kind of detail a refactor changes by accident and a golden hash catches a week later:
//
//   1. Commands, in arrival order.
//   2. Player movement from the held direction.
//   3. Machines, in ascending id order.
//   4. Crops, in field index order.
//   5. Stats and the clock.
//
// Commands are applied in the order they arrive in `input.commands` — an array index,
// which cannot tie. Nothing sorts them by tile, id, player, or type; any of those would
// introduce a tiebreak that differs between engines the first time two commands compare
// equal.

import {
  type Command,
  type HarvestTileCommand,
  type LoadMachineCommand,
  type PlaceMachineCommand,
  type PlantTileCommand,
  type RefillHopperCommand,
  type RepairMachineCommand,
  type SellItemCommand,
  type SetMoveDirectionCommand,
  type UnloadMachineCommand,
  type WaterTileCommand,
  type WhackJamCommand,
  appendTrace,
} from './commands';
import {
  CONDITION_EFFECT_THRESHOLD,
  CONDITION_MAX,
  CropId,
  GROWTH_PER_WATERED_TICK,
  HAND_POUR_ML,
  HAND_REACH_SUBTILES_SQUARED,
  JAM_EVERY_N_OPERATIONS_WHEN_WORN,
  MACHINE_SPECS,
  MOISTURE_DRAIN_PER_TICK,
  MOISTURE_MAX,
  MachineKind,
  NET_WORTH_SAMPLE_PERIOD_TICKS,
  PLAYER_SPEED_SUBTILES_PER_100_TICKS,
  REPAIR_PER_TOUCH,
  SPRINKLER_POUR_ML,
  SPRINKLER_PERIOD_TICKS,
  SPRINKLER_RADIUS_TILES,
  WORLD_TILES_HIGH,
  WORLD_TILES_WIDE,
  cropSpec,
  listPriceCents,
  machineSpec,
} from './data';
import { SystemId, nextBelow, nextRange } from './rng';
import {
  type Machine,
  Direction,
  type WorldState,
  addItem,
  computeNetWorthCents,
  isFieldTile,
  isInsideWorld,
  isTileReady,
  itemCount,
  machineAt,
  machineById,
  machineCentreSubtiles,
  removeItem,
  spawnMachine,
  streamFor,
  tileAt,
} from './state';
import {
  type ManualTouchKind,
  pushNetWorthSample,
  recordEarnings,
  recordManualTouch,
  recordSpend,
  recordWaterDrawn,
} from './stats';
import { SUBTILE, clampInt, distanceSquaredSubtiles, divFloor, tileCentreSubtiles } from './units';

/** What the host hands `step()` for one tick. */
export interface TickInput {
  /** Must equal `state.tick`. A mismatch means the host loop dropped or replayed a tick. */
  tick: number;
  /** In arrival order. Applied in that order, and only that order. */
  commands: readonly Command[];
}

/**
 * Advance the world by exactly one tick.
 *
 * Mutates `state`. Afterwards `state.tick` is `input.tick + 1`.
 */
export function step(state: WorldState, input: TickInput): void {
  if (input.tick !== state.tick) {
    throw new RangeError(
      `sim: tick mismatch — state is at ${state.tick} but was handed tick ${input.tick}`,
    );
  }

  applyCommands(state, input);
  advancePlayer(state);
  advanceMachines(state);
  advanceCrops(state);
  advanceStats(state);

  state.tick += 1;
}

/** Convenience for headless runs: advance `count` ticks with no player input. */
export function stepMany(state: WorldState, count: number): void {
  for (let i = 0; i < count; i++) {
    step(state, { tick: state.tick, commands: EMPTY_COMMANDS });
  }
}

const EMPTY_COMMANDS: readonly Command[] = [];

// --- 1. commands ------------------------------------------------------------------

function applyCommands(state: WorldState, input: TickInput): void {
  const commands = input.commands;
  for (let i = 0; i < commands.length; i++) {
    const command = commands[i]!;
    if (applyCommand(state, command)) {
      appendTrace(state, input.tick, command);
    }
  }
}

/** Returns true if the command changed the world. Rejected commands are silent no-ops. */
function applyCommand(state: WorldState, command: Command): boolean {
  switch (command.type) {
    case 'SetMoveDirection':
      return applySetMoveDirection(state, command);
    case 'WaterTile':
      return applyWaterTile(state, command);
    case 'PlantTile':
      return applyPlantTile(state, command);
    case 'HarvestTile':
      return applyHarvestTile(state, command);
    case 'PlaceMachine':
      return applyPlaceMachine(state, command);
    case 'LoadMachine':
      return applyLoadMachine(state, command);
    case 'UnloadMachine':
      return applyUnloadMachine(state, command);
    case 'RefillHopper':
      return applyRefillHopper(state, command);
    case 'RepairMachine':
      return applyRepairMachine(state, command);
    case 'WhackJam':
      return applyWhackJam(state, command);
    case 'SellItem':
      return applySellItem(state, command);
    default:
      return false;
  }
}

function withinReachOfTile(state: WorldState, tileX: number, tileY: number): boolean {
  return (
    distanceSquaredSubtiles(
      state.player.xSub,
      state.player.ySub,
      tileCentreSubtiles(tileX),
      tileCentreSubtiles(tileY),
    ) <= HAND_REACH_SUBTILES_SQUARED
  );
}

function withinReachOfMachine(state: WorldState, machine: Machine): boolean {
  const centre = machineCentreSubtiles(machine);
  return (
    distanceSquaredSubtiles(state.player.xSub, state.player.ySub, centre.xSub, centre.ySub) <=
    HAND_REACH_SUBTILES_SQUARED
  );
}

function touch(state: WorldState, kind: ManualTouchKind): void {
  recordManualTouch(state.stats, kind);
}

function applySetMoveDirection(state: WorldState, command: SetMoveDirectionCommand): boolean {
  if (state.player.moveDir === command.dir) return false;
  state.player.moveDir = command.dir;
  if (command.dir !== Direction.None) {
    state.player.facing = command.dir;
  }
  return true;
}

function applyWaterTile(state: WorldState, command: WaterTileCommand): boolean {
  const tile = tileAt(state, command.tileX, command.tileY);
  if (tile === null) return false;
  if (!withinReachOfTile(state, command.tileX, command.tileY)) return false;

  tile.moisture = MOISTURE_MAX;
  recordWaterDrawn(state.stats, HAND_POUR_ML);
  touch(state, 'handWater');
  return true;
}

function applyPlantTile(state: WorldState, command: PlantTileCommand): boolean {
  const tile = tileAt(state, command.tileX, command.tileY);
  if (tile === null || tile.crop !== CropId.None) return false;
  if (!withinReachOfTile(state, command.tileX, command.tileY)) return false;

  const spec = cropSpec(command.crop);
  if (spec === null) return false;
  if (!removeItem(state, spec.seedItem, 1)) return false;

  // Per-tile growth variance, so a field ripens in waves rather than all at once.
  const span = divFloor(spec.growthTicks * spec.growthVariancePermille, 1000);
  const jitter = nextRange(streamFor(state, SystemId.CropGrowth), -span, span);

  tile.crop = command.crop;
  tile.growth = 0;
  tile.growthTarget = spec.growthTicks + jitter;
  touch(state, 'handPlant');
  return true;
}

function applyHarvestTile(state: WorldState, command: HarvestTileCommand): boolean {
  const tile = tileAt(state, command.tileX, command.tileY);
  if (tile === null || !isTileReady(tile)) return false;
  if (!withinReachOfTile(state, command.tileX, command.tileY)) return false;

  const spec = cropSpec(tile.crop);
  if (spec === null) return false;

  const bonus = nextBelow(streamFor(state, SystemId.Harvest), 2);
  const yieldCount = tile.fertility + bonus;

  addItem(state, spec.yieldItem, yieldCount);
  // Any potato replants as a seed — the anti-softlock floor of plan §4.
  addItem(state, spec.seedItem, 1);

  tile.crop = CropId.None;
  tile.growth = 0;
  tile.growthTarget = 0;

  state.stats.itemsHarvestedByHand += yieldCount;
  touch(state, 'handHarvest');
  return true;
}

function applyPlaceMachine(state: WorldState, command: PlaceMachineCommand): boolean {
  const spec = machineSpec(command.kind);
  if (spec === null) return false;
  if (state.moneyCents < spec.priceCents) return false;

  for (let dy = 0; dy < spec.tilesHigh; dy++) {
    for (let dx = 0; dx < spec.tilesWide; dx++) {
      const tileX = command.tileX + dx;
      const tileY = command.tileY + dy;
      if (!isInsideWorld(tileX, tileY)) return false;
      if (isFieldTile(tileX, tileY)) return false;
      if (machineAt(state, tileX, tileY) !== null) return false;
    }
  }

  const machine = spawnMachine(state, command.kind, command.tileX, command.tileY);
  if (machine === null) return false;

  state.moneyCents -= spec.priceCents;
  recordSpend(state.stats, spec.priceCents);
  return true;
}

function applyLoadMachine(state: WorldState, command: LoadMachineCommand): boolean {
  if (command.count <= 0) return false;
  const machine = machineById(state, command.machineId);
  if (machine === null || !withinReachOfMachine(state, machine)) return false;

  const spec = machineSpec(machine.kind);
  if (spec === null || spec.inputItem === null) return false;

  const space = spec.inputCapacity - machine.inputCount;
  const have = itemCount(state, spec.inputItem);
  const moved = Math.min(command.count, Math.min(space, have));
  if (moved <= 0) return false;

  removeItem(state, spec.inputItem, moved);
  machine.inputCount += moved;
  touch(state, 'handCarry');
  return true;
}

function applyUnloadMachine(state: WorldState, command: UnloadMachineCommand): boolean {
  if (command.count <= 0) return false;
  const machine = machineById(state, command.machineId);
  if (machine === null || !withinReachOfMachine(state, machine)) return false;

  const spec = machineSpec(machine.kind);
  if (spec === null || spec.outputItem === null) return false;

  const moved = Math.min(command.count, machine.outputCount);
  if (moved <= 0) return false;

  machine.outputCount -= moved;
  addItem(state, spec.outputItem, moved);
  touch(state, 'handCarry');
  return true;
}

function applyRefillHopper(state: WorldState, command: RefillHopperCommand): boolean {
  const machine = machineById(state, command.machineId);
  if (machine === null || !withinReachOfMachine(state, machine)) return false;

  const spec = machineSpec(machine.kind);
  if (spec === null || spec.tankCapacityMl <= 0) return false;

  const poured = spec.tankCapacityMl - machine.tankMl;
  if (poured <= 0) return false;

  machine.tankMl = spec.tankCapacityMl;
  // Water is counted where it leaves the source, which is here. What the sprinkler later
  // pours out of its own barrel is not a second draw.
  recordWaterDrawn(state.stats, poured);
  touch(state, 'hopperRefill');
  return true;
}

function applyRepairMachine(state: WorldState, command: RepairMachineCommand): boolean {
  const machine = machineById(state, command.machineId);
  if (machine === null || !withinReachOfMachine(state, machine)) return false;
  if (machine.condition >= CONDITION_MAX) return false;

  // Hold-to-repair is free and always available. Hand tools never rot (plan §1).
  machine.condition = Math.min(CONDITION_MAX, machine.condition + REPAIR_PER_TOUCH);
  touch(state, 'handRepair');
  return true;
}

function applyWhackJam(state: WorldState, command: WhackJamCommand): boolean {
  const machine = machineById(state, command.machineId);
  if (machine === null || !withinReachOfMachine(state, machine)) return false;
  if (!machine.jammed) return false;

  machine.jammed = false;
  touch(state, 'jamWhack');
  return true;
}

function applySellItem(state: WorldState, command: SellItemCommand): boolean {
  if (command.count <= 0) return false;
  if (!nearSellBin(state)) return false;
  if (!removeItem(state, command.item, command.count)) return false;

  const gross = listPriceCents(command.item) * command.count;
  state.moneyCents += gross;
  recordEarnings(state.stats, gross);
  state.stats.itemsSold += command.count;
  touch(state, 'handCarry');
  return true;
}

function nearSellBin(state: WorldState): boolean {
  for (let i = 0; i < state.machines.length; i++) {
    const machine = state.machines[i]!;
    if (machine.kind !== MachineKind.SellBin) continue;
    if (withinReachOfMachine(state, machine)) return true;
  }
  return false;
}

// --- 2. player --------------------------------------------------------------------

function advancePlayer(state: WorldState): void {
  const player = state.player;
  if (player.moveDir === Direction.None) {
    player.moveAccum = 0;
    return;
  }

  // 4 tiles/s at 20 Hz is 51.2 subtiles per tick. Accruing hundredths and spending whole
  // subtiles keeps that exact; rounding to 51 would quietly make the character slow.
  player.moveAccum += PLAYER_SPEED_SUBTILES_PER_100_TICKS;
  const stepSub = divFloor(player.moveAccum, 100);
  player.moveAccum -= stepSub * 100;
  if (stepSub === 0) return;

  if (player.moveDir === Direction.North) player.ySub -= stepSub;
  else if (player.moveDir === Direction.South) player.ySub += stepSub;
  else if (player.moveDir === Direction.West) player.xSub -= stepSub;
  else player.xSub += stepSub;

  player.xSub = clampInt(player.xSub, 0, WORLD_TILES_WIDE * SUBTILE - 1);
  player.ySub = clampInt(player.ySub, 0, WORLD_TILES_HIGH * SUBTILE - 1);
}

// --- 3. machines ------------------------------------------------------------------

function advanceMachines(state: WorldState): void {
  // `state.machines` is kept sorted by id, so this is id order by construction.
  for (let i = 0; i < state.machines.length; i++) {
    const machine = state.machines[i]!;
    if (machine.kind === MachineKind.Sprinkler) {
      advanceSprinkler(state, machine);
    } else if (machine.kind === MachineKind.ChipKitchen) {
      advanceConverter(state, machine);
    }
  }
}

function advanceSprinkler(state: WorldState, machine: Machine): void {
  if (machine.jammed || machine.condition <= 0) return;
  if (machine.cooldown > 0) {
    machine.cooldown -= 1;
    return;
  }
  if (machine.tankMl < SPRINKLER_POUR_ML) return;

  let watered = 0;
  for (let dy = -SPRINKLER_RADIUS_TILES; dy <= SPRINKLER_RADIUS_TILES; dy++) {
    for (let dx = -SPRINKLER_RADIUS_TILES; dx <= SPRINKLER_RADIUS_TILES; dx++) {
      if (machine.tankMl < SPRINKLER_POUR_ML) break;
      const tile = tileAt(state, machine.tileX + dx, machine.tileY + dy);
      if (tile === null) continue;
      // A plain head wets everything in range, wet or dry. Wasting water on a soaked tile
      // is the sloppiness tax showing up on the Dry County board; moisture-sensing heads
      // are the automated tier (plan §3), not the first one.
      tile.moisture = MOISTURE_MAX;
      machine.tankMl -= SPRINKLER_POUR_ML;
      watered += 1;
    }
  }

  machine.cooldown = SPRINKLER_PERIOD_TICKS;
  if (watered > 0) {
    machine.opCount += 1;
    wear(machine, 1);
  }
}

function advanceConverter(state: WorldState, machine: Machine): void {
  const spec = machineSpec(machine.kind);
  if (spec === null || spec.outputItem === null) return;
  if (machine.jammed || machine.condition <= 0) return;
  if (machine.inputCount <= 0) return;
  if (machine.outputCount >= spec.outputCapacity) return;

  // Below the effect threshold a machine runs at half speed. Deterministic, per-operation,
  // and visible on the wrench lamp — there are no random or time-based failures anywhere.
  const rate =
    machine.condition < CONDITION_EFFECT_THRESHOLD
      ? Math.max(1, divFloor(spec.workRatePerTick, 2))
      : spec.workRatePerTick;

  machine.progress += rate;
  if (machine.progress < spec.workPerOperation) return;

  machine.progress -= spec.workPerOperation;
  machine.inputCount -= 1;
  machine.outputCount += 1;
  machine.opCount += 1;
  state.stats.itemsProducedByMachine += 1;
  wear(machine, spec.wearPerOperation);

  if (
    machine.condition < CONDITION_EFFECT_THRESHOLD &&
    machine.opCount % JAM_EVERY_N_OPERATIONS_WHEN_WORN === 0
  ) {
    machine.jammed = true;
  }
}

function wear(machine: Machine, amount: number): void {
  machine.condition = clampInt(machine.condition - amount, 0, CONDITION_MAX);
}

// --- 4. crops ---------------------------------------------------------------------

function advanceCrops(state: WorldState): void {
  for (let i = 0; i < state.field.length; i++) {
    const tile = state.field[i]!;

    if (tile.crop !== CropId.None && tile.moisture > 0 && tile.growth < tile.growthTarget) {
      tile.growth += GROWTH_PER_WATERED_TICK;
    }

    if (tile.moisture > 0) {
      tile.moisture = Math.max(0, tile.moisture - MOISTURE_DRAIN_PER_TICK);
    }
  }
}

// --- 5. stats and the clock -------------------------------------------------------

function advanceStats(state: WorldState): void {
  const stats = state.stats;

  stats.ticksElapsed += 1;
  stats.ticksSinceManualTouch += 1;
  if (stats.ticksSinceManualTouch > stats.longestHandsFreeTicks) {
    stats.longestHandsFreeTicks = stats.ticksSinceManualTouch;
  }

  stats.netWorthCents = computeNetWorthCents(state);
  if (stats.netWorthCents > stats.peakNetWorthCents) {
    stats.peakNetWorthCents = stats.netWorthCents;
  }

  if (state.tick >= stats.nextNetWorthSampleTick) {
    pushNetWorthSample(stats, stats.netWorthCents);
    stats.nextNetWorthSampleTick = state.tick + NET_WORTH_SAMPLE_PERIOD_TICKS;
  }
}

/** Every machine kind the sim knows how to run. Exported for the renderer's atlas keys. */
export const KNOWN_MACHINE_KINDS: readonly MachineKind[] = MACHINE_SPECS.map((spec) => spec.kind);
