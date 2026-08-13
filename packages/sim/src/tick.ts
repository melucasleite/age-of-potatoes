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
//   3. Water: reservoir recharge, then each pipe network's ledger, in ascending id order.
//   4. Machines, in ascending id order.
//   5. Belts, in ascending id order — items move, then heads hand off.
//   6. Grabbers, in ascending id order.
//   7. Zones (the seed hopper), in descending priority then ascending id.
//   8. Crops, in field index order — growth, withering, moisture.
//   9. Stats and the clock.
//
// Machines run before belts so a finished item is available to the grabber that empties it
// on the same tick it appeared, and belts run before grabbers so an arm sees where the
// goods actually are. None of that is load-bearing for correctness — only for latency —
// but the ORDER ITSELF is load-bearing for determinism, so it is written down.
//
// Water runs before machines for the same latency reason and one more: RECHARGE COMES FIRST,
// so a pump standing at an empty pond is served the millilitres the pond just made. That is
// plan §4's "sip at recharge rate when empty" falling straight out of the running order
// rather than needing a special case — and it is why a reservoir always recovers.
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
  type PlacePipeCommand,
  type PlantTileCommand,
  type RefillHopperCommand,
  type RemoveBeltCommand,
  type RemoveGrabberCommand,
  type RemovePipeCommand,
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
  type UseRepairKitCommand,
  type WalkAndActCommand,
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
  IRRIGATION_HUB_SCAN_PER_TICK,
  ItemId,
  JAM_EVERY_N_OPERATIONS_WHEN_WORN,
  MACHINE_SPECS,
  MOISTURE_DRAIN_PER_TICK,
  MOISTURE_DRY_THRESHOLD,
  MOISTURE_MAX,
  MachineKind,
  MachineRole,
  type MachineSpec,
  NET_WORTH_SAMPLE_PERIOD_TICKS,
  OVERCOOK_BLOCKED_TICKS,
  PIPE_MAX_PATH_TILES,
  PIPE_PRICE_CENTS_PER_TILE,
  PLAYER_SPEED_SUBTILES_PER_100_TICKS,
  RECIRCULATOR_ML_PER_MINUTE,
  REPAIR_KIT_RADIUS_TILES,
  REPAIR_PER_TOUCH,
  SPRINKLER_POUR_ML,
  SPRINKLER_PERIOD_TICKS,
  UPGRADE_MAX_LEVEL,
  WALK_ERRAND_TIMEOUT_TICKS,
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
import {
  BuildRefusal,
  advancePipes,
  liquidPlacementRefusal,
  pipeAt,
  pipePathRefusal,
  rebuildNetworks,
} from './pipes';
import { SystemId, nextBelow } from './rng';
import {
  type Machine,
  CeremonyId,
  Direction,
  IntentAction,
  type PlayerIntent,
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
  machineCoversTile,
  markCeremony,
  plantCrop,
  removeItem,
  spawnBelt,
  spawnGrabber,
  spawnMachine,
  spawnPipe,
  spawnZone,
  streamFor,
  takeOneOutput,
  tileAt,
  tileOccupied,
  zoneById,
} from './state';
import { WaterDraw, nearestReservoir, rechargeReservoir, takeWater } from './water';
import {
  type ManualTouchKind,
  pushNetWorthSample,
  recordEarnings,
  recordManualTouch,
  recordRefund,
  recordSpend,
} from './stats';
import { TechId, hasTech, milestoneMet, insertUnlocked, prerequisitesMet, techNode } from './tech';
import {
  acceptsUpgrades,
  effectiveInputCapacity,
  effectiveOutputCapacity,
  effectiveTankCapacityMl,
  effectiveWastePeriod,
  effectiveWear,
  effectiveWorkRate,
  setUpgradeLevel,
  upgradeCostCents,
  upgradeLevel,
} from './upgrades';
import {
  SUBTILE,
  TICKS_PER_MINUTE,
  clampInt,
  distanceSquaredSubtiles,
  divFloor,
  tileCentreSubtiles,
} from './units';
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
  advanceWater(state);
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
    case 'WalkAndAct':
      return applyWalkAndAct(state, command);
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
    case 'UseRepairKit':
      return applyUseRepairKit(state, command);
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
    case 'PlacePipe':
      return applyPlacePipe(state, command);
    case 'RemovePipe':
      return applyRemovePipe(state, command);
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

/**
 * Hold a direction — and, in doing so, abandon any errand.
 *
 * MANUAL CONTROL ALWAYS WINS, AND THAT IS WHY THE LINE IS HERE RATHER THAN SOMEWHERE
 * CLEVERER. Touching a movement key is the player saying "no, I will walk it myself", and a
 * walk-to feature that argues with that — finishing its errand first, or resuming afterwards
 * — is the exact thing that makes this convenience infuriating in other games. It is a
 * grabbed steering wheel, so it takes effect on the same tick and asks nothing.
 *
 * Note that it fires on a real direction CHANGE, including the release that sends `None`:
 * let go of the key and the errand you started mid-stride goes with it. That is the safe
 * direction to err in — the player is never surprised by the farmer walking off on their own.
 */
function applySetMoveDirection(state: WorldState, command: SetMoveDirectionCommand): boolean {
  if (state.player.moveDir === command.dir) return false;
  state.player.moveDir = command.dir;
  if (command.dir !== Direction.None) {
    state.player.facing = command.dir;
  }
  state.player.intent = null;
  return true;
}

/**
 * Take on an errand: walk to a tile, then do one thing there.
 *
 * Accepted only if the verb is one that could ever work at that tile — a plant errand aimed
 * at an occupied tile, or a repair errand aimed at bare grass, is refused here and now rather
 * than walked across the field and abandoned on arrival. What is deliberately NOT checked is
 * anything that can legitimately change during the walk: seeds in the bag, money, buffer
 * space. Those belong to the reducer that runs on arrival, and if it refuses, the errand ends
 * exactly as an out-of-seeds click does today — quietly, having cost a walk.
 *
 * A second errand replaces the first. There is no queue (see `PlayerState.intent`).
 */
function applyWalkAndAct(state: WorldState, command: WalkAndActCommand): boolean {
  if (command.action === IntentAction.None) return false;
  // A HELD KEY REFUSES THE ERRAND, which is the other half of "manual control always wins".
  // `applySetMoveDirection` covers the player who grabs the wheel DURING a walk; this covers
  // the player who was already steering when they clicked, and without it that player is
  // overruled by their own click while the key is still down. Refusing — rather than queueing
  // the errand until they let go — is deliberate: a pending errand that fires on key release
  // is the farmer walking off on their own, which is the surprise this whole feature is
  // supposed to avoid. It also makes `advancePlayer`'s "no arbitration to do here" true.
  if (state.player.moveDir !== Direction.None) return false;
  // Integer payloads, checked once on the way in. Every other command only READS its payload,
  // but this one stores it — a fractional tile would land in the world, the hash, and the save.
  // `Number.isInteger`, not `Math.trunc(x) !== x`: the latter passes ±Infinity through, and an
  // infinite count reaches world state and then refuses to serialize.
  if (
    !Number.isInteger(command.tileX) ||
    !Number.isInteger(command.tileY) ||
    !Number.isInteger(command.item) ||
    !Number.isInteger(command.count)
  ) {
    return false;
  }
  if (!isInsideWorld(command.tileX, command.tileY)) return false;

  const intent: PlayerIntent = {
    action: command.action,
    tileX: command.tileX,
    tileY: command.tileY,
    item: command.item,
    count: command.count,
    issuedTick: state.tick,
  };
  if (intentTargetSubtiles(state, intent) === null) return false;

  state.player.intent = intent;
  return true;
}

/**
 * Pour the can on one tile.
 *
 * THE CAN IS SPECIAL AND THIS IS WHERE IT SAYS SO. Plan §4: "**The watering can always fills
 * at any shore at any level** — hand-scale farming can never be water-starved." So this draw
 * uses `WaterDraw.Shore`, which never fails and never returns short, even at a bone-dry pond
 * or in a world with no pond at all. It is an anti-softlock guarantee in plan §1's tradition,
 * not a balance number, and it must not be tuned away for tension.
 *
 * The draw is still COUNTED, in full, through the one accounting path — plan §6's Dry County
 * board measures the water the player used, and hand-watering is water the player used.
 *
 * Nothing else about the can changed: still free, still indestructible, still no cooldown and
 * no bonus (plan §1, and §7 ruling 8 bans "trusty tool" bonuses in the other direction). The
 * inspector readout the Mogul-era can gets is `inspectTile()` in `view.ts` — information,
 * never a mechanical advantage.
 */
function applyWaterTile(state: WorldState, command: WaterTileCommand): boolean {
  const tile = tileAt(state, command.tileX, command.tileY);
  if (tile === null) return false;
  if (!withinReachOfTile(state, command.tileX, command.tileY)) return false;

  tile.moisture = MOISTURE_MAX;
  takeWater(
    state,
    nearestReservoir(state, command.tileX, command.tileY),
    HAND_POUR_ML,
    WaterDraw.Shore,
  );
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
  // A pump must stand on a bank, and it may not join a network that already has one. The same
  // function powers the renderer's placement ghost, so the refusal is on the object before the
  // click lands rather than a click that silently does nothing (plan §5).
  if (
    liquidPlacementRefusal(state, command.kind, command.tileX, command.tileY) !== BuildRefusal.None
  ) {
    return false;
  }

  const machine = spawnMachine(state, command.kind, command.tileX, command.tileY);
  if (machine === null) return false;

  state.moneyCents -= spec.priceCents;
  recordSpend(state.stats, spec.priceCents);
  // On edit only, never per tick. A machine that landed beside a pipe run is now on it.
  if (spec.liquid !== 0) rebuildNetworks(state);
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
  if (
    liquidPlacementRefusal(state, machine.kind, command.tileX, command.tileY) !== BuildRefusal.None
  ) {
    return false;
  }

  machine.tileX = command.tileX;
  machine.tileY = command.tileY;
  // Moving is free and always will be (plan §4), but a moved pump has left its network and a
  // moved head may have joined one. Recompute rather than guess.
  if (spec.liquid !== 0) rebuildNetworks(state);
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

  // One unit at a time through the one take path, rather than a single subtraction, because
  // a buffer can hold two grades at once — a Fryer's burnt chips come out before its good
  // ones — and a hand that emptied it in one arithmetic step would have to reimplement that
  // rule to know what it was holding.
  for (let i = 0; i < moved; i++) {
    const item = takeOneOutput(machine, spec);
    if (item === null) break;
    addItem(state, item, 1);
  }

  touch(state, 'handCarry');
  return true;
}

/**
 * Top up a barrel by hand — the Assisted rung of plan §3's watering ladder.
 *
 * METERED, unlike the can. Hauling barrel-loads is a pump you operate with your legs, so it
 * takes what the pond actually has and stops when the pond is empty. That is the first place
 * a player meets the finite reservoir, and it is a partial fill rather than a refusal: you get
 * what is there.
 *
 * Water is counted where it leaves the SOURCE, which is here. What the sprinkler later pours
 * out of its own barrel is not a second draw.
 */
function applyRefillHopper(state: WorldState, command: RefillHopperCommand): boolean {
  const machine = machineById(state, command.machineId);
  if (machine === null || !withinReachOfMachine(state, machine)) return false;

  const spec = machineSpec(machine.kind);
  if (spec === null || spec.tankCapacityMl <= 0) return false;

  const capacity = effectiveTankCapacityMl(spec, machine);
  const room = capacity - machine.tankMl;
  if (room <= 0) return false;

  const poured = takeWater(
    state,
    nearestReservoir(state, machine.tileX, machine.tileY),
    room,
    WaterDraw.Metered,
  );
  if (poured <= 0) return false;

  machine.tankMl += poured;
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

/**
 * Spend one kit on a spot and service the cell around it.
 *
 * WHAT THE PLAYER IS BUYING IS THE WALK, NOT THE REPAIR. Hand repair is free forever and
 * always works (plan §1, §3), so a kit that merely repaired one machine would be a strictly
 * worse version of a hand and nobody would ever buy one. What it actually saves is ten trips
 * and ten holds: everything within `REPAIR_KIT_RADIUS_TILES` comes back to full at once,
 * jams included, which is plan §4's "one trip services a cell" stated as arithmetic.
 *
 * REFUSED RATHER THAN WASTED when nothing in range wants anything. Misplacement is never a
 * fine (plan §4), and a misclick that silently ate $8 would teach the player to distrust the
 * tool — so a kit is consumed only when it did something.
 */
function applyUseRepairKit(state: WorldState, command: UseRepairKitCommand): boolean {
  if (!isInsideWorld(command.tileX, command.tileY)) return false;
  if (!withinReachOfTile(state, command.tileX, command.tileY)) return false;
  if (itemCount(state, ItemId.RepairKit) <= 0) return false;

  let serviced = 0;
  for (let i = 0; i < state.machines.length; i++) {
    const machine = state.machines[i]!;
    if (!machineWithinKitRadius(machine, command.tileX, command.tileY)) continue;
    if (machine.condition >= CONDITION_MAX && !machine.jammed) continue;

    machine.condition = CONDITION_MAX;
    machine.jammed = false;
    serviced += 1;
  }

  if (serviced === 0) return false;

  removeItem(state, ItemId.RepairKit, 1);
  state.stats.repairKitsUsed += 1;
  touch(state, 'handRepair');
  return true;
}

/** Chebyshev distance from a tile to the nearest tile of a machine's footprint. */
function machineWithinKitRadius(machine: Machine, tileX: number, tileY: number): boolean {
  const spec = machineSpec(machine.kind);
  if (spec === null) return false;

  const dx = Math.max(machine.tileX - tileX, tileX - (machine.tileX + spec.tilesWide - 1), 0);
  const dy = Math.max(machine.tileY - tileY, tileY - (machine.tileY + spec.tilesHigh - 1), 0);
  return Math.max(dx, dy) <= REPAIR_KIT_RADIUS_TILES;
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
  // Counted at the till, not at the machine: plan §4 wants kit spend held near 5% of value
  // added, and a kit bought and never used is money the factory cost you all the same.
  if (command.item === ItemId.RepairKit) state.stats.repairKitSpendCents += cost;
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

// --- pipes ------------------------------------------------------------------------

/**
 * Lay a run of pipe. ONE DRAG, ONE COMMAND, ONE TRACE ENTRY — a thirty-tile run appends one
 * entry carrying its path, exactly as a zone paint carries a rect.
 *
 * The whole run is accepted or the whole run is refused; there is no partial lay. A drag that
 * clips a machine half way along should not leave the player with a stub they now have to
 * find and remove.
 */
function applyPlacePipe(state: WorldState, command: PlacePipeCommand): boolean {
  if (!hasTech(state.unlocked, TechId.Pumps)) return false;
  if (
    pipePathRefusal(state, command.path, command.liquid, PIPE_MAX_PATH_TILES) !== BuildRefusal.None
  ) {
    return false;
  }

  const cost = PIPE_PRICE_CENTS_PER_TILE * command.path.length;
  if (state.moneyCents < cost) return false;

  for (let i = 0; i < command.path.length; i++) {
    const node = command.path[i]!;
    spawnPipe(state, node.x, node.y, command.liquid);
  }

  state.moneyCents -= cost;
  recordSpend(state.stats, cost);
  rebuildNetworks(state);
  return true;
}

/**
 * Take a run of pipe back up — the exact inverse of the `PlacePipe` that laid it.
 *
 * Full refund. Misplacement is never a fine (plan §4), and a pipe holds nothing, so unlike a
 * belt there is nothing riding it to hand back.
 */
function applyRemovePipe(state: WorldState, command: RemovePipeCommand): boolean {
  if (command.path.length < 1 || command.path.length > PIPE_MAX_PATH_TILES) return false;

  let removed = 0;
  for (let i = 0; i < command.path.length; i++) {
    const node = command.path[i]!;
    const pipe = pipeAt(state, node.x, node.y);
    if (pipe === null) continue;
    for (let j = 0; j < state.pipes.length; j++) {
      if (state.pipes[j]!.id === pipe.id) {
        state.pipes.splice(j, 1);
        break;
      }
    }
    removed += 1;
  }
  if (removed === 0) return false;

  const refund = PIPE_PRICE_CENTS_PER_TILE * removed;
  state.moneyCents += refund;
  // A refund reverses a spend rather than earning income — the same rule belts follow, and the
  // reason buying and re-selling the same pipe a thousand times lands exactly where it started.
  recordRefund(state.stats, refund);
  rebuildNetworks(state);
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
//
// Two ways the farmer's legs can be driven, and never both at once: a held direction, or a
// pending errand. The errand wins while it exists, and it only exists while the player has
// not touched a movement key — `applySetMoveDirection` clears it on any change, so there is
// no arbitration to do here beyond asking which one is live.
//
// This runs AFTER commands rather than before them, which is worth one sentence: it means a
// `WalkAndAct` aimed at something already in reach fires on the very tick it arrives, instead
// of waiting a tick to discover it had nowhere to walk. The documented system order is
// unchanged — the errand is player movement, and player movement is step 2.

function advancePlayer(state: WorldState): void {
  const player = state.player;
  if (player.intent !== null) {
    advanceErrand(state, player.intent);
    return;
  }

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

/**
 * One tick of a walk-to errand: expire it, abandon it, finish it, or take a step.
 *
 * THE FOUR ENDINGS ARE ALL EXPLICIT, IN THIS ORDER, BECAUSE THE MISSING ONE IS ALWAYS THE BUG.
 * An errand that only ever ended by arriving would strand the player the first time a tile was
 * harvested out from under them, and a walk with no ceiling on it is a farmer who can never
 * move again. Manual control is the fifth ending and it lives in `applySetMoveDirection`,
 * where the interruption actually happens.
 */
function advanceErrand(state: WorldState, intent: PlayerIntent): void {
  const player = state.player;

  // 1. It timed out. Nothing about the world is wrong; this errand simply is not happening.
  if (state.tick - intent.issuedTick >= WALK_ERRAND_TIMEOUT_TICKS) {
    abandonErrand(player);
    return;
  }

  // 2. It stopped making sense — the tile was harvested, the machine was picked up and moved.
  const target = intentTargetSubtiles(state, intent);
  if (target === null) {
    abandonErrand(player);
    return;
  }

  // 3. Close enough to touch it. Run the verb through EXACTLY the reducer a direct click would
  // have reached — same validation, same refusals, same stats — and then let go of the errand
  // whether it worked or not. Arriving to find the bag empty is an errand that is over.
  //
  // The arrival is NOT appended to the trace. One click was one command, and this is that one
  // command still happening; recording it again would make a replay apply the verb twice.
  if (
    distanceSquaredSubtiles(player.xSub, player.ySub, target.xSub, target.ySub) <=
    HAND_REACH_SUBTILES_SQUARED
  ) {
    const command = intentCommand(state, intent);
    if (command !== null) applyCommand(state, command);
    abandonErrand(player);
    return;
  }

  // 4. Still walking.
  //
  // STRAIGHT AT IT, THROUGH ANYTHING IN THE WAY. Obstacle avoidance is deliberately deferred,
  // not forgotten: there is nothing in this world solid enough to walk into — the player
  // strolls over belts, pipes and machines alike — so A* would be pathing around obstacles
  // that do not exist. When something finally blocks a footstep, this is the function that
  // grows a path, and the errand's shape (a target and a verb) is already the right shape for
  // one. Until then, a straight line is not a simplification; it is the correct answer.
  player.moveAccum += PLAYER_SPEED_SUBTILES_PER_100_TICKS;
  const budget = divFloor(player.moveAccum, 100);
  player.moveAccum -= budget * 100;
  if (budget === 0) return;

  const dx = target.xSub - player.xSub;
  const dy = target.ySub - player.ySub;

  // `sqrt` is the one non-trivial float operation the determinism rules allow, because
  // IEEE-754 requires it to be correctly rounded — every engine returns the same bits. The
  // truncations either side keep it out of world state: what gets stored is always an integer
  // number of subtiles, so the walk can be replayed a decade from now.
  const distance = Math.trunc(Math.sqrt(dx * dx + dy * dy));
  if (distance <= budget) {
    // Unreachable while reach (384) exceeds a tick's budget (~52) — the check above would
    // have fired first. Kept because it is the guard against dividing by a zero distance, and
    // because the day someone tunes either number it stops being unreachable.
    player.xSub = target.xSub;
    player.ySub = target.ySub;
  } else {
    player.xSub += Math.trunc((dx * budget) / distance);
    player.ySub += Math.trunc((dy * budget) / distance);
  }

  player.xSub = clampInt(player.xSub, 0, WORLD_TILES_WIDE * SUBTILE - 1);
  player.ySub = clampInt(player.ySub, 0, WORLD_TILES_HIGH * SUBTILE - 1);

  // Face the way you are going. The sprite has no idea an errand exists; it just wants a
  // compass direction, and the dominant axis is the one a person would say they were walking.
  if (dx * dx >= dy * dy) {
    player.facing = dx >= 0 ? Direction.East : Direction.West;
  } else {
    player.facing = dy >= 0 ? Direction.South : Direction.North;
  }
}

/** Drop the errand and the momentum with it. The player stands where they stopped. */
function abandonErrand(player: WorldState['player']): void {
  player.intent = null;
  player.moveAccum = 0;
}

/**
 * Where an errand is walking to, or `null` when it no longer means anything.
 *
 * This is the single validity rule, shared by the tick that issues the errand and every tick
 * that continues it — so "can this still happen" cannot drift between the two. It answers
 * questions about the SHAPE of the world only: does the tile exist, is the machine still
 * standing there, is the tile still plantable. Whether the player can afford it, has the seed,
 * or has room for the output is the arrival reducer's business, checked when it matters.
 */
function intentTargetSubtiles(
  state: WorldState,
  intent: PlayerIntent,
): { xSub: number; ySub: number } | null {
  if (!isInsideWorld(intent.tileX, intent.tileY)) return null;

  switch (intent.action) {
    case IntentAction.Water:
    case IntentAction.Plant:
    case IntentAction.Harvest: {
      const tile = tileAt(state, intent.tileX, intent.tileY);
      if (tile === null) return null;
      // Planting a tile something else already planted, or harvesting one something else
      // already pulled, is the errand going stale mid-walk. Let it go rather than marching
      // the player over to stand there doing nothing.
      if (intent.action === IntentAction.Plant && tile.crop !== CropId.None) return null;
      if (intent.action === IntentAction.Harvest && !isTileReady(tile) && tile.compost <= 0) {
        return null;
      }
      return {
        xSub: tileCentreSubtiles(intent.tileX),
        ySub: tileCentreSubtiles(intent.tileY),
      };
    }

    case IntentAction.Load:
    case IntentAction.Unload:
    case IntentAction.RefillHopper:
    case IntentAction.Repair:
    case IntentAction.WhackJam:
    case IntentAction.Sell: {
      // Resolved from the tile every tick rather than pinned by id at issue time, and that is
      // on purpose: pick-up-and-move is free and always will be (plan §4), so the machine you
      // set off toward may not be there when you arrive. Aim at the FOOTPRINT CENTRE, which is
      // where `withinReachOfMachine` measures from — walking to the corner tile of a 2×2 and
      // finding yourself out of reach would be a maddening near-miss.
      const machine = machineAt(state, intent.tileX, intent.tileY);
      if (machine === null) return null;
      if (intent.action === IntentAction.Sell && machine.kind !== MachineKind.SellBin) return null;
      return machineCentreSubtiles(machine);
    }

    default:
      return null;
  }
}

/**
 * The direct command an arrived errand becomes.
 *
 * The whole point of routing through the ordinary `Command` shapes is that walking to a thing
 * and clicking it while standing there are the SAME EVENT as far as the world is concerned —
 * same reducer, same touch counters, same anti-softlock rules. There is no second
 * implementation of planting here to fall out of step with the first.
 */
function intentCommand(state: WorldState, intent: PlayerIntent): Command | null {
  switch (intent.action) {
    case IntentAction.Water:
      return { type: 'WaterTile', tileX: intent.tileX, tileY: intent.tileY };
    case IntentAction.Plant:
      return {
        type: 'PlantTile',
        tileX: intent.tileX,
        tileY: intent.tileY,
        crop: intent.item as CropId,
      };
    case IntentAction.Harvest:
      return { type: 'HarvestTile', tileX: intent.tileX, tileY: intent.tileY };
    case IntentAction.Sell:
      return { type: 'SellItem', item: intent.item as ItemId, count: intent.count };
    default:
      break;
  }

  const machine = machineAt(state, intent.tileX, intent.tileY);
  if (machine === null) return null;

  switch (intent.action) {
    case IntentAction.Load:
      return { type: 'LoadMachine', machineId: machine.id, count: intent.count };
    case IntentAction.Unload:
      return { type: 'UnloadMachine', machineId: machine.id, count: intent.count };
    case IntentAction.RefillHopper:
      return { type: 'RefillHopper', machineId: machine.id };
    case IntentAction.Repair:
      return { type: 'RepairMachine', machineId: machine.id };
    case IntentAction.WhackJam:
      return { type: 'WhackJam', machineId: machine.id };
    default:
      return null;
  }
}

// --- 3. water ---------------------------------------------------------------------

/**
 * Reservoir recharge, then every network's ledger.
 *
 * RECHARGE FIRST, and the order is the mechanism: a pump at an empty pond is served the
 * millilitres the pond made this tick and no more, which is exactly plan §4's "sip at
 * recharge rate when empty". No special case, no floor, no clamp — the guarantee that a
 * reservoir always recovers is a consequence of two lines being in this order.
 */
function advanceWater(state: WorldState): void {
  for (let i = 0; i < state.reservoirs.length; i++) {
    rechargeReservoir(state.reservoirs[i]!);
  }
  advancePipes(state);
}

// --- 4. machines ------------------------------------------------------------------

function advanceMachines(state: WorldState): void {
  // `state.machines` is kept sorted by id, so this is id order by construction.
  for (let i = 0; i < state.machines.length; i++) {
    const machine = state.machines[i]!;
    const spec = machineSpec(machine.kind);
    if (spec === null) continue;

    // Dispatch on role, not on kind: adding the Bagger should not have meant editing the
    // tick, and adding the Carbonator should not either. The Pump and the Tank have no case
    // here at all — the pipe ledger already moved their water, and a machine whose whole job
    // is a number in `advancePipes` has nothing left to do on its own.
    if (spec.role === MachineRole.Sprinkler) {
      advanceSprinkler(state, machine, spec, effectiveWear(spec, machine));
      // Marked here rather than inside `advanceSprinkler`, which the piped head shares and
      // which owes a different id. `wateredCount` is lifetime and hashed, so the mark is
      // idempotent and survives a reload — the renderer no longer has to infer "has it ever
      // poured?" from a counter that a demolish-and-rebuild resets.
      if (machine.wateredCount > 0) markCeremony(state, CeremonyId.Sprinkler);
    } else if (spec.role === MachineRole.PipedSprinkler) {
      advancePipedSprinkler(state, machine, spec);
    } else if (spec.role === MachineRole.Recirculator) {
      advanceRecirculator(state, machine);
    } else if (spec.role === MachineRole.Converter) {
      advanceConverter(state, machine);
    }
  }
}

/**
 * One cycle of a head that wets everything in range, wet or dry.
 *
 * Shared by the v0.1 barrel sprinkler and the piped head, because they ARE the same machine
 * with different plumbing — plan §1's "manual never rots" cuts both ways, and an automated
 * rung that also watered *better* would make the rung below it a mistake to have bought.
 * Wasting water on a soaked tile is the sloppiness tax showing up on the Dry County board;
 * moisture sensing is the Hub's job and the Hub's alone.
 */
function advanceSprinkler(
  state: WorldState,
  machine: Machine,
  spec: MachineSpec,
  wearPerCycle: number,
): void {
  if (machine.jammed || machine.condition <= 0) return;
  if (machine.cooldown > 0) {
    machine.cooldown -= 1;
    return;
  }
  if (machine.tankMl < SPRINKLER_POUR_ML) return;

  const radius = spec.coverageRadiusTiles;
  let watered = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (machine.tankMl < SPRINKLER_POUR_ML) break;
      const tile = tileAt(state, machine.tileX + dx, machine.tileY + dy);
      if (tile === null) continue;
      tile.moisture = MOISTURE_MAX;
      machine.tankMl -= SPRINKLER_POUR_ML;
      watered += 1;
    }
  }

  machine.cooldown = SPRINKLER_PERIOD_TICKS;
  if (watered > 0) {
    machine.opCount += 1;
    machine.wateredCount += watered;
    if (wearPerCycle > 0) wear(machine, wearPerCycle);
  }
}

/**
 * A head on a pipe network: the automated rung of plan §3's watering ladder.
 *
 * No wear (Entropy is its own release), no jamming, no flooding, no way to damage a crop. It
 * pours from the small buffer the ledger keeps topped up, and when the network cannot fill
 * that buffer it simply stops — showing `LampState.UtilityMissing`, the blue "a utility is
 * missing" lamp §5's grammar already defines, which means the same thing here as it does on a
 * sprinkler with an empty barrel.
 */
function advancePipedSprinkler(state: WorldState, machine: Machine, spec: MachineSpec): void {
  if (spec.moistureSensing) {
    advanceIrrigationHub(state, machine, spec);
    return;
  }
  advanceSprinkler(state, machine, spec, 0);
  if (machine.wateredCount > 0) markCeremony(state, CeremonyId.PipedSprinkler);
}

/**
 * The Irrigation Hub: §4's "moisture-sensing heads water only dry tiles".
 *
 * THE SCAN IS BOUNDED AND ITS CURSOR IS IN `WorldState`. A fixed slice of the coverage patch
 * is examined per tick from `machine.scanCursor`, so the Hub's cost does not scale with the
 * field and never will — and the cursor is world state rather than a module variable, because
 * module state is invisible to the hash and to saves, which would make two identically-saved
 * worlds water different tiles after a reload.
 *
 * The saving IS the promotion. A dumb head at this coverage would re-wet every soaked tile on
 * every cycle; this skips them, and the difference lands where the player can already see it —
 * plan §6's Dry County board and the Shift Report's water line — rather than in a tooltip.
 * `skippedCount` is what a skip is worth, counted so the readout can show it.
 *
 * Coverage is anchored on the machine's top-left tile, the same as every other head, so what
 * the placement overlay draws is exactly what gets watered.
 */
function advanceIrrigationHub(state: WorldState, machine: Machine, spec: MachineSpec): void {
  if (machine.jammed || machine.condition <= 0) return;

  const radius = spec.coverageRadiusTiles;
  const span = radius * 2 + 1;
  const patch = span * span;
  if (patch <= 0) return;

  for (let scanned = 0; scanned < IRRIGATION_HUB_SCAN_PER_TICK; scanned++) {
    // `% patch` rather than a bare index, so a save whose coverage changed under it lands
    // somewhere legal instead of scanning off the end of the patch.
    const offset = machine.scanCursor % patch;
    const dx = (offset % span) - radius;
    const dy = divFloor(offset, span) - radius;
    const tile = tileAt(state, machine.tileX + dx, machine.tileY + dy);

    if (tile !== null) {
      // ONE DEFINITION OF DRY, and it is the one the ground is drawn with.
      if (tile.moisture >= MOISTURE_DRY_THRESHOLD) {
        machine.skippedCount += 1;
      } else {
        // Out of water: hold the cursor here rather than skating past a dry tile. The Hub
        // resumes exactly where it stopped when its buffer refills.
        if (machine.tankMl < SPRINKLER_POUR_ML) return;
        machine.tankMl -= SPRINKLER_POUR_ML;
        // Clamps, always. No overwatering is possible on any rung (plan §2, hard rule).
        tile.moisture = MOISTURE_MAX;
        machine.wateredCount += 1;
        machine.opCount += 1;
        // Plan §3's Hall of Hands: the first activation is owed ~10 seconds of theatre, once
        // per world, ever. The renderer plays it; the sim only remembers that it happened.
        markCeremony(state, CeremonyId.IrrigationHub);
      }
    }

    machine.scanCursor = (offset + 1) % patch;
  }
}

/**
 * The Recirculator: §4's "Recirculators reclaim washer graywater".
 *
 * IT FILLS A TANK, NOT A NETWORK, AND THAT IS NOT A BUG. Plan §5 allows exactly ONE PUMP PER
 * NETWORK, and a second source injecting straight into the pipes would break the single rule
 * that keeps the ledger a division instead of a solver. Pouring into an adjacent tank is the
 * sanctioned way to add supply — the tank is already the thing that covers a shortfall — and
 * it is the cleanest teaching example of why the one-pump rule exists. Anyone who reads this
 * and thinks "surely it should just feed the pipe" is exactly who this comment is for.
 *
 * It reclaims while the Washer is actually washing: has an input, is not blocked, is not
 * broken. An idle Washer produces no graywater, because there is no wash.
 */
function advanceRecirculator(state: WorldState, machine: Machine): void {
  if (!washerRunningBeside(state, machine)) {
    machine.flowMlPerMinute = 0;
    return;
  }

  const tank = tankBeside(state, machine);
  if (tank === null) {
    machine.flowMlPerMinute = 0;
    return;
  }

  const tankSpec = machineSpec(tank.kind);
  if (tankSpec === null) return;

  // Per-minute rate through the same integer accumulator everything else uses — the machine's
  // own `progress` field, which a Recirculator has no other use for.
  machine.progress += RECIRCULATOR_ML_PER_MINUTE;
  const whole = divFloor(machine.progress, TICKS_PER_MINUTE);
  if (whole <= 0) return;
  machine.progress -= whole * TICKS_PER_MINUTE;

  const room = effectiveTankCapacityMl(tankSpec, tank) - tank.tankMl;
  const put = room < whole ? room : whole;
  if (put <= 0) {
    machine.flowMlPerMinute = 0;
    return;
  }

  tank.tankMl += put;
  tank.flowMlPerMinute += put * TICKS_PER_MINUTE;
  machine.flowMlPerMinute = put * TICKS_PER_MINUTE;
  machine.opCount += 1;
}

/** Orthogonal neighbours of a machine's footprint, scanned in a fixed order. */
function neighbourMachine(
  state: WorldState,
  machine: Machine,
  match: (candidate: Machine, spec: MachineSpec) => boolean,
): Machine | null {
  const spec = machineSpec(machine.kind);
  if (spec === null) return null;

  let best: Machine | null = null;
  for (let dy = -1; dy <= spec.tilesHigh; dy++) {
    for (let dx = -1; dx <= spec.tilesWide; dx++) {
      const x = machine.tileX + dx;
      const y = machine.tileY + dy;
      if (machineCoversTile(machine, x, y)) continue;
      const candidate = machineAt(state, x, y);
      if (candidate === null || candidate.id === machine.id) continue;
      const candidateSpec = machineSpec(candidate.kind);
      if (candidateSpec === null || !match(candidate, candidateSpec)) continue;
      // Lowest id wins, so two eligible neighbours resolve by a total order rather than by
      // which direction the scan happened to reach first.
      if (best === null || candidate.id < best.id) best = candidate;
    }
  }
  return best;
}

function washerRunningBeside(state: WorldState, machine: Machine): boolean {
  return (
    neighbourMachine(state, machine, (candidate, spec) => {
      if (spec.kind !== MachineKind.Washer) return false;
      if (candidate.jammed || candidate.condition <= 0) return false;
      if (candidate.inputCount <= 0) return false;
      return candidate.outputCount < effectiveOutputCapacity(spec, candidate);
    }) !== null
  );
}

function tankBeside(state: WorldState, machine: Machine): Machine | null {
  return neighbourMachine(state, machine, (_candidate, spec) => spec.role === MachineRole.Tank);
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

  if (machine.outputCount >= effectiveOutputCapacity(spec, machine)) {
    // Stopped by demand-pull, with a full basket. This is the only clock overcooking has.
    advanceOvercooking(machine, spec);
    return;
  }
  machine.blockedTicks = 0;

  if (machine.inputCount <= 0) return;

  machine.progress += effectiveWorkRate(spec, machine);
  if (machine.progress < spec.workPerOperation) return;

  machine.progress -= spec.workPerOperation;
  machine.inputCount -= 1;
  machine.opCount += 1;

  // THE OPERATION HAPPENED EITHER WAY. A worn machine still turns, still swallows the input,
  // and still wears — it just does not always produce anything. Waste is a cadence read off
  // `opCount`, never a roll (see `WASTE_PERIOD_AT_THRESHOLD`).
  const wastePeriod = effectiveWastePeriod(spec, machine);
  if (wastePeriod > 0 && machine.opCount % wastePeriod === 0) {
    state.stats.inputsWastedByMachine += 1;
  } else {
    machine.outputCount += 1;
    state.stats.itemsProducedByMachine += 1;
  }

  wear(machine, effectiveWear(spec, machine));

  if (
    machine.condition < CONDITION_EFFECT_THRESHOLD &&
    machine.opCount % JAM_EVERY_N_OPERATIONS_WHEN_WORN === 0
  ) {
    machine.jammed = true;
  }
}

/**
 * One tick of a machine that is stopped with a full output buffer.
 *
 * THE CAUSE IS THE PLAYER'S LAYOUT, NOT A DIE ROLL (plan §7 ruling 5). Standing still with a
 * full basket is something a factory does — no belt off the Fryer, a grabber aimed at the
 * wrong tile, or nobody coming back for it — and it is visible from in front of the machine.
 * Every `OVERCOOK_BLOCKED_TICKS` of *continuous* blockage one more unit turns, oldest first,
 * until the whole basket has gone rustic; any pull resets the clock in `takeOneOutput`.
 *
 * One unit per interval rather than the whole basket at once, deliberately. A cliff would
 * make the loss binary and unreadable, and it would pay a player who deliberately let a
 * basket sit — a chip at a time makes neglect a slope you can watch, and makes farming the
 * rustic price take thirty seconds of stopped Fryer per chip, which is a terrible trade.
 *
 * Machines whose spec names no overcooked grade do nothing here but hold still. Neither does a
 * jammed or halted one — the caller returns before it gets here, deliberately: plan §4 says a
 * machine at zero condition "costs nothing", and a Fryer that kept browning its basket while
 * dead would be charging the player for the one failure state that is supposed to be free.
 */
function advanceOvercooking(machine: Machine, spec: MachineSpec): void {
  if (spec.overcookOutputItem === null) return;
  if (machine.overcookedCount >= machine.outputCount) return;

  machine.blockedTicks += 1;
  if (machine.blockedTicks < OVERCOOK_BLOCKED_TICKS) return;

  machine.blockedTicks = 0;
  machine.overcookedCount += 1;
}

function wear(machine: Machine, amount: number): void {
  machine.condition = clampInt(machine.condition - amount, 0, CONDITION_MAX);
}

// --- 8. crops ---------------------------------------------------------------------

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

// --- 9. stats and the clock -------------------------------------------------------

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
