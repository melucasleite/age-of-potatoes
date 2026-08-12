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
//   4. Belts, in ascending id order — items move, then heads hand off.
//   5. Grabbers, in ascending id order.
//   6. Zones (the seed hopper), in descending priority then ascending id.
//   7. Crops, in field index order — growth, withering, moisture.
//   8. Stats and the clock.
//
// Machines run before belts so a finished item is available to the grabber that empties it
// on the same tick it appeared, and belts run before grabbers so an arm sees where the
// goods actually are. None of that is load-bearing for correctness — only for latency —
// but the ORDER ITSELF is load-bearing for determinism, so it is written down.
//
// Commands are applied in the order they arrive in `input.commands` — an array index,
// which cannot tie. Nothing sorts them by tile, id, player, or type; any of those would
// introduce a tiebreak that differs between engines the first time two commands compare
// equal.

import {
  type BuyItemCommand,
  type Command,
  type CreateZoneCommand,
  type HarvestTileCommand,
  type LoadMachineCommand,
  type MoveMachineCommand,
  type PaintZoneCommand,
  type PlaceBeltCommand,
  type PlaceGrabberCommand,
  type PlaceMachineCommand,
  type PlantTileCommand,
  type RefillHopperCommand,
  type RemoveBeltCommand,
  type RemoveGrabberCommand,
  type RenameZoneCommand,
  type RepairMachineCommand,
  type ResearchTechCommand,
  type SellItemCommand,
  type SetGrabberFilterCommand,
  type SetMoveDirectionCommand,
  type SetZoneAutoReplantCommand,
  type SetZoneCropCommand,
  type SetZonePriorityCommand,
  type UnloadMachineCommand,
  type UpgradeMachineCommand,
  type WaterTileCommand,
  type WhackJamCommand,
  appendTrace,
} from './commands';
import {
  BELT_MAX_LENGTH_TILES,
  COMPOST_AFTER_TICKS,
  COMPOST_PER_CROP,
  CONDITION_EFFECT_THRESHOLD,
  CONDITION_MAX,
  CropId,
  GROWTH_PER_WATERED_TICK,
  HAND_POUR_ML,
  HAND_REACH_SUBTILES_SQUARED,
  ItemId,
  JAM_EVERY_N_OPERATIONS_WHEN_WORN,
  MACHINE_SPECS,
  MOISTURE_DRAIN_PER_TICK,
  MOISTURE_MAX,
  MachineKind,
  MachineRole,
  NET_WORTH_SAMPLE_PERIOD_TICKS,
  PLAYER_SPEED_SUBTILES_PER_100_TICKS,
  REPAIR_PER_TOUCH,
  SPRINKLER_POUR_ML,
  SPRINKLER_PERIOD_TICKS,
  SPRINKLER_RADIUS_TILES,
  UPGRADE_MAX_LEVEL,
  WILT_GRACE_TICKS,
  WILT_WINDOW_TICKS,
  WORLD_TILES_HIGH,
  WORLD_TILES_WIDE,
  WiltStage,
  ZONE_PRIORITY_MAX,
  ZONE_PRIORITY_MIN,
  beltSpec,
  cropSpec,
  grabberSpec,
  isPurchasable,
  listPriceCents,
  machineSpec,
  wiltStageForAge,
} from './data';
import { advanceBelts, advanceGrabbers } from './belts';
import { SystemId, nextBelow } from './rng';
import {
  type Machine,
  Direction,
  type WorldState,
  addItem,
  beltById,
  clipZoneName,
  computeNetWorthCents,
  directionStepX,
  directionStepY,
  grabberById,
  isCompassDirection,
  isFieldTile,
  isInsideWorld,
  isTileReady,
  itemCount,
  machineAt,
  machineById,
  machineCentreSubtiles,
  plantCrop,
  removeItem,
  spawnBelt,
  spawnGrabber,
  spawnMachine,
  spawnZone,
  streamFor,
  tileAt,
  tileOccupied,
  zoneById,
} from './state';
import {
  type ManualTouchKind,
  pushNetWorthSample,
  recordEarnings,
  recordManualTouch,
  recordRefund,
  recordSpend,
  recordWaterDrawn,
} from './stats';
import { TechId, hasTech, milestoneMet, insertUnlocked, prerequisitesMet, techNode } from './tech';
import {
  acceptsUpgrades,
  effectiveInputCapacity,
  effectiveOutputCapacity,
  effectiveTankCapacityMl,
  effectiveWear,
  effectiveWorkRate,
  setUpgradeLevel,
  upgradeCostCents,
  upgradeLevel,
} from './upgrades';
import { SUBTILE, clampInt, distanceSquaredSubtiles, divFloor, tileCentreSubtiles } from './units';
import { PaintMode, advanceZones, clipRectToField, paintZoneRect } from './zones';

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
  advanceBelts(state);
  advanceGrabbers(state);
  advanceZones(state);
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
    case 'BuyItem':
      return applyBuyItem(state, command);
    case 'MoveMachine':
      return applyMoveMachine(state, command);
    case 'UpgradeMachine':
      return applyUpgradeMachine(state, command);
    case 'ResearchTech':
      return applyResearchTech(state, command);
    case 'PlaceBelt':
      return applyPlaceBelt(state, command);
    case 'RemoveBelt':
      return applyRemoveBelt(state, command);
    case 'PlaceGrabber':
      return applyPlaceGrabber(state, command);
    case 'SetGrabberFilter':
      return applySetGrabberFilter(state, command);
    case 'RemoveGrabber':
      return applyRemoveGrabber(state, command);
    case 'CreateZone':
      return applyCreateZone(state, command);
    case 'PaintZone':
      return applyPaintZone(state, command);
    case 'SetZoneCrop':
      return applySetZoneCrop(state, command);
    case 'SetZonePriority':
      return applySetZonePriority(state, command);
    case 'RenameZone':
      return applyRenameZone(state, command);
    case 'SetZoneAutoReplant':
      return applySetZoneAutoReplant(state, command);
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

/** Tech gates are money-only outside the Charters, but they are gates (plan §7 ruling 3). */
function unlocked(state: WorldState, required: string | null): boolean {
  if (required === null) return true;
  return hasTech(state.unlocked, required);
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
  if (!unlocked(state, spec.requiresTech)) return false;
  if (!removeItem(state, spec.seedItem, 1)) return false;

  plantCrop(state, tile, spec);
  touch(state, 'handPlant');
  return true;
}

/**
 * Pull a tile.
 *
 * Three outcomes and no fourth: a fresh or drooping crop yields its ordinary good, a wilted
 * one yields the Day-Old good at half price, and a bare tile with compost on it yields the
 * compost. NOTHING EVER VANISHES (plan §4) — there is no path out of a crop tile that pays
 * zero.
 */
function applyHarvestTile(state: WorldState, command: HarvestTileCommand): boolean {
  const tile = tileAt(state, command.tileX, command.tileY);
  if (tile === null) return false;
  if (!withinReachOfTile(state, command.tileX, command.tileY)) return false;

  if (!isTileReady(tile)) {
    // Sweeping up after a crop you never got to. Still worth bending down for.
    if (tile.compost <= 0) return false;
    addItem(state, ItemId.Compost, tile.compost);
    tile.compost = 0;
    touch(state, 'handCarry');
    return true;
  }

  const spec = cropSpec(tile.crop);
  if (spec === null) return false;

  const bonus = nextBelow(streamFor(state, SystemId.Harvest), 2);
  const yieldCount = tile.fertility + bonus;
  const wilted = wiltStageForAge(tile.readyAge) === WiltStage.Wilted;

  addItem(state, wilted ? spec.dayOldItem : spec.yieldItem, yieldCount);
  if (tile.compost > 0) {
    addItem(state, ItemId.Compost, tile.compost);
    tile.compost = 0;
  }

  if (spec.regrowTicks > 0) {
    // A regrowing crop keeps its plant and returns no seed — you already own the plant.
    const regrown = tile.growthTarget - spec.regrowTicks;
    tile.growth = regrown < 0 ? 0 : regrown;
    tile.readyAge = 0;
  } else {
    // Any potato replants as a seed — the anti-softlock floor of plan §4.
    addItem(state, spec.seedItem, 1);
    tile.crop = CropId.None;
    tile.growth = 0;
    tile.growthTarget = 0;
    tile.readyAge = 0;
  }

  state.stats.itemsHarvestedByHand += yieldCount;
  touch(state, 'handHarvest');
  return true;
}

/** Every tile of a footprint is inside the world, off the field, and unoccupied. */
function footprintFree(
  state: WorldState,
  tileX: number,
  tileY: number,
  tilesWide: number,
  tilesHigh: number,
  ignoreMachineId: number,
): boolean {
  for (let dy = 0; dy < tilesHigh; dy++) {
    for (let dx = 0; dx < tilesWide; dx++) {
      const x = tileX + dx;
      const y = tileY + dy;
      if (!isInsideWorld(x, y)) return false;
      if (isFieldTile(x, y)) return false;
      const occupant = machineAt(state, x, y);
      if (occupant !== null && occupant.id !== ignoreMachineId) return false;
      if (occupant === null && tileOccupied(state, x, y)) return false;
    }
  }
  return true;
}

function applyPlaceMachine(state: WorldState, command: PlaceMachineCommand): boolean {
  const spec = machineSpec(command.kind);
  if (spec === null) return false;
  if (!unlocked(state, spec.requiresTech)) return false;
  if (state.moneyCents < spec.priceCents) return false;
  if (!footprintFree(state, command.tileX, command.tileY, spec.tilesWide, spec.tilesHigh, 0)) {
    return false;
  }

  const machine = spawnMachine(state, command.kind, command.tileX, command.tileY);
  if (machine === null) return false;

  state.moneyCents -= spec.priceCents;
  recordSpend(state.stats, spec.priceCents);
  return true;
}

/** Free, always. Buffers, condition, and dials travel with the machine (plan §4). */
function applyMoveMachine(state: WorldState, command: MoveMachineCommand): boolean {
  const machine = machineById(state, command.machineId);
  if (machine === null) return false;
  if (machine.tileX === command.tileX && machine.tileY === command.tileY) return false;

  const spec = machineSpec(machine.kind);
  if (spec === null) return false;
  if (
    !footprintFree(state, command.tileX, command.tileY, spec.tilesWide, spec.tilesHigh, machine.id)
  ) {
    return false;
  }

  machine.tileX = command.tileX;
  machine.tileY = command.tileY;
  touch(state, 'handCarry');
  return true;
}

function applyLoadMachine(state: WorldState, command: LoadMachineCommand): boolean {
  if (command.count <= 0) return false;
  const machine = machineById(state, command.machineId);
  if (machine === null || !withinReachOfMachine(state, machine)) return false;

  const spec = machineSpec(machine.kind);
  if (spec === null || spec.inputItem === null) return false;

  const space = effectiveInputCapacity(spec, machine) - machine.inputCount;
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

  const capacity = effectiveTankCapacityMl(spec, machine);
  const poured = capacity - machine.tankMl;
  if (poured <= 0) return false;

  machine.tankMl = capacity;
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

/** The roadside stand sells seeds back. Prices are the number on the board (plan §4). */
function applyBuyItem(state: WorldState, command: BuyItemCommand): boolean {
  if (command.count <= 0) return false;
  if (!isPurchasable(command.item)) return false;
  if (!nearSellBin(state)) return false;

  const cost = listPriceCents(command.item) * command.count;
  if (cost <= 0 || state.moneyCents < cost) return false;

  state.moneyCents -= cost;
  recordSpend(state.stats, cost);
  addItem(state, command.item, command.count);
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

// --- upgrades and research --------------------------------------------------------

/** Machines that run a work cycle. The visible half of the Assembly Charter's gate. */
function workingMachineCount(state: WorldState): number {
  let count = 0;
  for (let i = 0; i < state.machines.length; i++) {
    const spec = machineSpec(state.machines[i]!.kind);
    if (spec !== null && spec.workPerOperation > 0) count += 1;
  }
  return count;
}

function applyUpgradeMachine(state: WorldState, command: UpgradeMachineCommand): boolean {
  if (!hasTech(state.unlocked, TechId.UpgradeBench)) return false;

  const machine = machineById(state, command.machineId);
  // "Bought at the machine" (plan §3) — you stand next to the thing you are improving.
  if (machine === null || !withinReachOfMachine(state, machine)) return false;

  const spec = machineSpec(machine.kind);
  if (spec === null || !acceptsUpgrades(spec)) return false;

  const level = upgradeLevel(machine, command.dial);
  if (level >= UPGRADE_MAX_LEVEL) return false;

  const cost = upgradeCostCents(spec, level);
  if (cost < 0 || state.moneyCents < cost) return false;

  state.moneyCents -= cost;
  recordSpend(state.stats, cost);
  machine.investedCents += cost;
  setUpgradeLevel(machine, command.dial, level + 1);
  touch(state, 'handCarry');
  return true;
}

function applyResearchTech(state: WorldState, command: ResearchTechCommand): boolean {
  const node = techNode(command.techId);
  if (node === null) return false;
  if (hasTech(state.unlocked, node.id)) return false;
  if (!prerequisitesMet(state.unlocked, node)) return false;
  if (
    !milestoneMet(
      node,
      state.stats.itemsSold,
      workingMachineCount(state),
      state.stats.itemsProducedByMachine,
    )
  ) {
    return false;
  }
  if (state.moneyCents < node.priceCents) return false;

  state.moneyCents -= node.priceCents;
  recordSpend(state.stats, node.priceCents);
  return insertUnlocked(state.unlocked, node.id);
}

// --- belts and grabbers -----------------------------------------------------------

function applyPlaceBelt(state: WorldState, command: PlaceBeltCommand): boolean {
  const spec = beltSpec(command.tier);
  if (spec === null) return false;
  if (!unlocked(state, spec.requiresTech)) return false;
  if (!isCompassDirection(command.dir)) return false;
  if (command.lengthTiles < 1 || command.lengthTiles > BELT_MAX_LENGTH_TILES) return false;

  const dx = directionStepX(command.dir);
  const dy = directionStepY(command.dir);
  for (let i = 0; i < command.lengthTiles; i++) {
    const x = command.tileX + dx * i;
    const y = command.tileY + dy * i;
    if (!isInsideWorld(x, y)) return false;
    if (isFieldTile(x, y)) return false;
    if (tileOccupied(state, x, y)) return false;
  }

  const cost = spec.priceCentsPerTile * command.lengthTiles;
  if (state.moneyCents < cost) return false;

  const belt = spawnBelt(
    state,
    command.tier,
    command.tileX,
    command.tileY,
    command.dir,
    command.lengthTiles,
  );
  if (belt === null) return false;

  state.moneyCents -= cost;
  recordSpend(state.stats, cost);
  return true;
}

/**
 * Take a belt up. Full refund, and everything riding it comes back to the player's hands.
 *
 * Misplacement is never a fine (plan §4) and nothing vanishes (plan §4) — a belt torn out
 * with forty slices on it hands you forty slices, not a lesson.
 */
function applyRemoveBelt(state: WorldState, command: RemoveBeltCommand): boolean {
  const belt = beltById(state, command.beltId);
  if (belt === null) return false;

  const spec = beltSpec(belt.tier);
  if (spec !== null) {
    const refund = spec.priceCentsPerTile * belt.lengthTiles;
    state.moneyCents += refund;
    // A refund is money back, not income: it reverses a spend rather than earning one.
    recordRefund(state.stats, refund);
  }

  for (let i = 0; i < belt.items.length; i++) {
    addItem(state, belt.items[i]!.item, 1);
  }

  removeBeltById(state, belt.id);
  touch(state, 'handCarry');
  return true;
}

function removeBeltById(state: WorldState, id: number): void {
  for (let i = 0; i < state.belts.length; i++) {
    if (state.belts[i]!.id === id) {
      state.belts.splice(i, 1);
      return;
    }
  }
}

function applyPlaceGrabber(state: WorldState, command: PlaceGrabberCommand): boolean {
  const spec = grabberSpec(command.tier);
  if (spec === null) return false;
  if (!unlocked(state, spec.requiresTech)) return false;
  if (!isCompassDirection(command.dir)) return false;
  if (command.filter !== 0 && !spec.filterable) return false;
  if (!isInsideWorld(command.tileX, command.tileY)) return false;
  if (isFieldTile(command.tileX, command.tileY)) return false;
  if (tileOccupied(state, command.tileX, command.tileY)) return false;
  if (state.moneyCents < spec.priceCents) return false;

  const grabber = spawnGrabber(
    state,
    command.tier,
    command.tileX,
    command.tileY,
    command.dir,
    command.filter,
  );
  if (grabber === null) return false;

  state.moneyCents -= spec.priceCents;
  recordSpend(state.stats, spec.priceCents);
  return true;
}

function applySetGrabberFilter(state: WorldState, command: SetGrabberFilterCommand): boolean {
  const grabber = grabberById(state, command.grabberId);
  if (grabber === null) return false;
  if (grabber.filter === command.filter) return false;

  const spec = grabberSpec(grabber.tier);
  if (spec === null) return false;
  if (command.filter !== 0 && !spec.filterable) return false;

  grabber.filter = command.filter;
  return true;
}

function applyRemoveGrabber(state: WorldState, command: RemoveGrabberCommand): boolean {
  const grabber = grabberById(state, command.grabberId);
  if (grabber === null) return false;

  const spec = grabberSpec(grabber.tier);
  if (spec !== null) {
    state.moneyCents += spec.priceCents;
    recordRefund(state.stats, spec.priceCents);
  }
  if (grabber.held !== 0) addItem(state, grabber.held as ItemId, 1);

  for (let i = 0; i < state.grabbers.length; i++) {
    if (state.grabbers[i]!.id === grabber.id) {
      state.grabbers.splice(i, 1);
      break;
    }
  }
  touch(state, 'handCarry');
  return true;
}

// --- zones ------------------------------------------------------------------------

function cropAssignable(state: WorldState, crop: CropId): boolean {
  if (crop === CropId.None) return true;
  const spec = cropSpec(crop);
  if (spec === null) return false;
  return unlocked(state, spec.requiresTech);
}

function applyCreateZone(state: WorldState, command: CreateZoneCommand): boolean {
  if (!cropAssignable(state, command.crop)) return false;
  // Check before creating: a zone that gets rolled back would still have burned an id, and
  // "the command changed nothing" has to mean exactly that.
  if (clipRectToField(command.rect) === null) return false;

  const zone = spawnZone(state, command.crop);
  paintZoneRect(state, zone.id, command.rect, PaintMode.Add);
  return true;
}

function applyPaintZone(state: WorldState, command: PaintZoneCommand): boolean {
  if (zoneById(state, command.zoneId) === null) return false;
  if (command.mode !== PaintMode.Add && command.mode !== PaintMode.Remove) return false;
  return paintZoneRect(state, command.zoneId, command.rect, command.mode) > 0;
}

function applySetZoneCrop(state: WorldState, command: SetZoneCropCommand): boolean {
  const zone = zoneById(state, command.zoneId);
  if (zone === null || zone.crop === command.crop) return false;
  if (!cropAssignable(state, command.crop)) return false;
  zone.crop = command.crop;
  return true;
}

function applySetZonePriority(state: WorldState, command: SetZonePriorityCommand): boolean {
  const zone = zoneById(state, command.zoneId);
  if (zone === null) return false;
  const priority = clampInt(command.priority, ZONE_PRIORITY_MIN, ZONE_PRIORITY_MAX);
  if (zone.priority === priority) return false;
  zone.priority = priority;
  return true;
}

function applyRenameZone(state: WorldState, command: RenameZoneCommand): boolean {
  const zone = zoneById(state, command.zoneId);
  if (zone === null) return false;
  const name = clipZoneName(command.name);
  if (name.length === 0 || zone.name === name) return false;
  zone.name = name;
  return true;
}

/** Locked in the simulation, not just in the UI, until the seed hopper is researched. */
function applySetZoneAutoReplant(state: WorldState, command: SetZoneAutoReplantCommand): boolean {
  if (!hasTech(state.unlocked, TechId.AutoReplant)) return false;
  const zone = zoneById(state, command.zoneId);
  if (zone === null || zone.autoReplant === command.on) return false;
  zone.autoReplant = command.on;
  if (!command.on) zone.replantCooldown = 0;
  return true;
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
    const spec = machineSpec(machine.kind);
    if (spec === null) continue;

    // Dispatch on role, not on kind: adding the Bagger should not have meant editing the
    // tick, and adding the Carbonator should not either.
    if (spec.role === MachineRole.Sprinkler) {
      advanceSprinkler(state, machine);
    } else if (spec.role === MachineRole.Converter) {
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

/**
 * One converter's tick.
 *
 * DEMAND-PULL, ALWAYS (plan §7 ruling 6): a machine with a full output buffer stops dead
 * rather than consuming an input it cannot place. That is what makes the Fryer's 2:1 ratio
 * teachable — the Slicer in front of it sits visibly idle and free, and nothing rots to
 * make the point.
 */
function advanceConverter(state: WorldState, machine: Machine): void {
  const spec = machineSpec(machine.kind);
  if (spec === null || spec.outputItem === null) return;
  if (machine.jammed || machine.condition <= 0) return;
  if (machine.inputCount <= 0) return;
  if (machine.outputCount >= effectiveOutputCapacity(spec, machine)) return;

  machine.progress += effectiveWorkRate(spec, machine);
  if (machine.progress < spec.workPerOperation) return;

  machine.progress -= spec.workPerOperation;
  machine.inputCount -= 1;
  machine.outputCount += 1;
  machine.opCount += 1;
  state.stats.itemsProducedByMachine += 1;
  wear(machine, effectiveWear(spec, machine));

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

// --- 7. crops ---------------------------------------------------------------------

/** A crop is gone from the tile this long after it turns. */
const COMPOST_AT_AGE = WILT_GRACE_TICKS + WILT_WINDOW_TICKS + COMPOST_AFTER_TICKS;

/**
 * Growth, withering, and moisture, in that order, over every tile.
 *
 * WITHERING IS DETERMINISTIC AND ROLLS NOTHING. `readyAge` is an integer that advances one
 * per tick inside `step()`, so it counts active factory minutes and only those — close the
 * tab and not one crop ages, because time does not pass (plan §4, §6). A crop that wilted
 * on a die roll would teach nothing, which is why plan §7 ruling 5's house style applies
 * here even harder than it does to machines.
 */
function advanceCrops(state: WorldState): void {
  for (let i = 0; i < state.field.length; i++) {
    const tile = state.field[i]!;
    const spec = tile.crop === CropId.None ? null : cropSpec(tile.crop);

    if (spec !== null) {
      if (tile.moisture > 0 && tile.growth < tile.growthTarget) {
        tile.growth += GROWTH_PER_WATERED_TICK;
      }

      if (tile.growth >= tile.growthTarget) {
        tile.readyAge += 1;
        if (tile.readyAge >= COMPOST_AT_AGE) {
          // Left too long. It becomes compost on the spot and the tile is replantable —
          // the one thing that must never happen is the crop becoming nothing.
          tile.compost += COMPOST_PER_CROP;
          tile.crop = CropId.None;
          tile.growth = 0;
          tile.growthTarget = 0;
          tile.readyAge = 0;
        }
      }
    }

    if (tile.moisture > 0) {
      const drain = spec === null ? MOISTURE_DRAIN_PER_TICK : spec.moistureDrainPerTick;
      tile.moisture = Math.max(0, tile.moisture - drain);
    }
  }
}

// --- 8. stats and the clock -------------------------------------------------------

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

/** The chip line in chain order, for tooltips, tutorials, and the ratio panel. */
export const CHIP_LINE_KINDS: readonly MachineKind[] = [
  MachineKind.Washer,
  MachineKind.Slicer,
  MachineKind.Fryer,
  MachineKind.Seasoner,
  MachineKind.Bagger,
];
