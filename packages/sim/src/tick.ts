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
//   7. Commerce: carts on the road, then standing routes, both in ascending id order.
//   8. Zones (the seed hopper), in descending priority then ascending id.
//   9. Crops, in field index order — growth, withering, moisture.
//  10. Stats and the clock.
//
// Machines run before belts so a finished item is available to the grabber that empties it
// on the same tick it appeared, belts run before grabbers so an arm sees where the goods
// actually are, and commerce runs after grabbers so a bag delivered into a depot this tick can
// complete the run it completes rather than waiting a tick to be noticed. None of that is load-bearing for correctness — only for latency —
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
  type BuyDeedCommand,
  type BuyItemCommand,
  type CancelContractCommand,
  type Command,
  type CreateContractCommand,
  type CreateZoneCommand,
  type DeconstructMachineCommand,
  type DispatchCartCommand,
  type ApplyFertilizerCommand,
  type HarvestTileCommand,
  type HitchCartCommand,
  type LoadCartCommand,
  type LoadMachineCommand,
  type MoveMachineCommand,
  type PackCrateCommand,
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
  type RotateGrabberCommand,
  type SellBoxedMachineCommand,
  type SellItemCommand,
  type SetDockZoneCommand,
  type SetGrabberFilterCommand,
  type SetMoveDirectionCommand,
  type SetZoneAutoReplantCommand,
  type SetZoneCropCommand,
  type SetZonePriorityCommand,
  type SwingScytheCommand,
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
  COMPOST_PER_SPOILED_ITEM,
  CRATE_FRESHNESS_TICKS,
  CRATE_PACK_CAPACITY,
  FRESHNESS_BUCKET_TICKS,
  SCYTHE_SWATHE_TILES,
  TOW_SPEED_PENALTY_SUBTILES_PER_100_TICKS,
  COMPOST_PER_CROP,
  CAN_CHARGES_MAX,
  CONDITION_EFFECT_THRESHOLD,
  CONDITION_MAX,
  CropId,
  GROWTH_PER_WATERED_TICK,
  HAND_POUR_ML,
  HAND_REACH_SUBTILES,
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
  PortFlow,
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
  boxedItemForMachine,
  boxedMachineScrapCents,
  cropSpec,
  grabberSpec,
  isBotDockKind,
  isPerishable,
  isPurchasable,
  isSellable,
  listPriceCents,
  machineKindForBoxedItem,
  machineSpec,
  soilSpec,
} from './data';
import { advanceBelts, advanceGrabbers, advanceJunctions } from './belts';
import { advanceBots, dockWantedSeed } from './bots';
import { stepToward } from './movement';
import {
  advanceCommerce,
  cartRoomFor,
  cartRunTicks,
  contractItemLegal,
  contractQuantityLegal,
  depotHasContractRoom,
  depotRouteFor,
  isCart,
  isCartAway,
  isDepot,
  refundContract,
  releaseDepotContracts,
  removeContractById,
} from './commerce';
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
  BotKind,
  CeremonyId,
  ContractPhase,
  Direction,
  IntentAction,
  type PlayerIntent,
  type WorldState,
  addBoxedMachine,
  addItem,
  addItemFresh,
  armfulRoom,
  beltById,
  clipDestination,
  clipZoneName,
  computeNetWorthCents,
  contractById,
  directionStepX,
  directionStepY,
  fertilizeTile,
  grabberById,
  hasArmfulRoom,
  inventorySlot,
  isCompassDirection,
  isFieldTile,
  isInsideWorld,
  isOwnedTile,
  isParcelBuyable,
  isTileReady,
  itemCount,
  machineAt,
  machineById,
  machineCentreSubtiles,
  machineCoversTile,
  markCeremony,
  nextDeedPriceCents,
  ownParcel,
  peekBoxedMachine,
  plantCrop,
  removeBotsForDock,
  removeItem,
  rotateDirectionClockwise,
  soonestSpoilTick,
  spawnBot,
  spawnBelt,
  spawnGrabber,
  spawnMachine,
  spawnPipe,
  spawnZone,
  streamFor,
  takeBoxedMachine,
  takeHarvest,
  takeOneOutput,
  tileAt,
  tileOccupied,
  zoneById,
} from './state';
import {
  WaterDraw,
  nearestPointOfReservoir,
  nearestReservoir,
  rechargeReservoir,
  reservoirAdjacentToTile,
  reservoirWithinReach,
  takeWater,
} from './water';
import {
  type ManualTouchKind,
  advanceStatsClock,
  pushNetWorthSample,
  recordManualTouch,
  recordRefund,
  recordSale,
  recordSpend,
} from './stats';
import { TechId, hasTech, milestoneMet, insertUnlocked, prerequisitesMet, techNode } from './tech';
import {
  acceptsUpgrades,
  effectiveInputCapacity,
  effectiveOutputCapacity,
  effectivePortCapacityMl,
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
  TICKS_PER_IN_GAME_DAY,
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
  // Bots run with the machines rather than with the crops, and just after them: a bot is
  // machinery, its dock is a machine, and the goods it drops on that dock's floor should be
  // available to the belt that empties it on the same tick they land. The same latency argument
  // that puts `advanceMachines` before `advanceBelts`.
  advanceBots(state);
  advanceBelts(state);
  // Between the belts and the arms, and that is the only place it can go: a junction hands off
  // from one belt to another, so the belts must already have moved this tick and the grabbers
  // must not yet have reached in. Its own dispatch rather than a case in `advanceMachines` for
  // the same reason — it is a belt fitting that happens to be built and boxed like a machine.
  advanceJunctions(state);
  advanceGrabbers(state);
  advanceCommerce(state);
  advanceZones(state);
  advanceCrops(state);
  // LAST BEFORE THE CLOCK, AND THAT PLACEMENT IS THE ONE THING TO GET RIGHT ABOUT IT. A stack
  // spoils when `state.tick` reaches its deadline, and `state.tick` is incremented on the line
  // below — so running the sweep here means a stack stamped for tick N is swept on tick N, once,
  // by the tick that owns it. Running it before the commands would let a good the player picked
  // up this tick be judged against last tick's clock.
  advanceSpoilage(state);
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
    case 'RefillCan':
      return applyRefillCan(state);
    case 'PlantTile':
      return applyPlantTile(state, command);
    case 'HarvestTile':
      return applyHarvestTile(state, command);
    case 'SwingScythe':
      return applySwingScythe(state, command);
    case 'ApplyFertilizer':
      return applyApplyFertilizer(state, command);
    case 'PackCrate':
      return applyPackCrate(state, command);
    case 'HitchCart':
      return applyHitchCart(state, command);
    case 'UnhitchCart':
      return applyUnhitchCart(state);
    case 'SetDockZone':
      return applySetDockZone(state, command);
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
    case 'DeconstructMachine':
      return applyDeconstructMachine(state, command);
    case 'SellBoxedMachine':
      return applySellBoxedMachine(state, command);
    case 'UpgradeMachine':
      return applyUpgradeMachine(state, command);
    case 'ResearchTech':
      return applyResearchTech(state, command);
    case 'BuyDeed':
      return applyBuyDeed(state, command);
    case 'LoadCart':
      return applyLoadCart(state, command);
    case 'DispatchCart':
      return applyDispatchCart(state, command);
    case 'CreateContract':
      return applyCreateContract(state, command);
    case 'CancelContract':
      return applyCancelContract(state, command);
    case 'PlaceBelt':
      return applyPlaceBelt(state, command);
    case 'RemoveBelt':
      return applyRemoveBelt(state, command);
    case 'PlaceGrabber':
      return applyPlaceGrabber(state, command);
    case 'SetGrabberFilter':
      return applySetGrabberFilter(state, command);
    case 'RotateGrabber':
      return applyRotateGrabber(state, command);
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

/**
 * A hand landed on this machine: its untouched-work clock starts again from zero.
 *
 * SEPARATE FROM `touch()`, WHICH IS WORLD-LEVEL. Hands-Free asks "did the player do anything";
 * the Corporate Charter asks "was anybody's hand on *this machine*", and the two answers differ
 * on every tick the player is out harvesting a field while the line runs itself. Called beside
 * `touch()` at each of the eight verbs that reach a machine — load, unload, refill, repair, kit,
 * whack, upgrade, move — because those are precisely the ones plan §3 means by *untouched*.
 *
 * Note what is deliberately NOT here: a grabber feeding the hopper, and a truck taking the output
 * away. Those are the machinery doing its job, which is the thing being demonstrated.
 */
function handsOn(machine: Machine): void {
  machine.untouchedTicks = 0;
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
 * Pour the can on one tile. One pour is one charge of `CAN_CHARGES_MAX` (item 009, restored
 * by the 2026-08-13 ruling: plan §4's bold clause — "the watering can always fills at any
 * shore at any level" — governs the REFILL, which never fails; the can itself holds 8 pours,
 * §3's ladder, and "refill the can" is a beat of §2's Gardener circuit).
 *
 * AN EMPTY CAN REFUSES, GENTLY. Nothing is spent, nothing is lost, nothing is punished — the
 * pour simply does not happen, exactly as a plant with no seeds does not. The HUD reads
 * `player.canCharges === 0` off the view as the reason and points at the shore.
 *
 * THE WATER IS DRAWN AT THE REFILL, NOT AT THE POUR. `applyRefillCan` is where the can dips
 * into a reservoir through `takeWater()` — one draw of what the can actually takes — so a
 * pour here moves no reservoir and books no `waterDrawnMl`; that water was already counted
 * when it entered the can. (The starting can's eight pours were filled at home and are the
 * one canful the Dry County meter never sees.)
 *
 * Nothing else about the can changed: still free, still indestructible, still no cooldown and
 * no bonus (plan §1, and §7 ruling 8 bans "trusty tool" bonuses in the other direction), and
 * pouring on an already-wet tile still clamps at no cost — you cannot overwater (§2).
 */
function applyWaterTile(state: WorldState, command: WaterTileCommand): boolean {
  const tile = tileAt(state, command.tileX, command.tileY);
  if (tile === null) return false;
  if (!withinReachOfTile(state, command.tileX, command.tileY)) return false;
  if (state.player.canCharges <= 0) return false;

  tile.moisture = MOISTURE_MAX;
  state.player.canCharges -= 1;
  touch(state, 'handWater');
  return true;
}

/**
 * Dip the can at the shore: back to `CAN_CHARGES_MAX` pours, always.
 *
 * THE VERB §4'S BOLD CLAUSE IS ABOUT. The draw goes through `takeWater()` in `Shore` mode,
 * which never fails and never returns short — at a full pond, a drawn-down one, or a bone-dry
 * one, where the fiction is scooping the last puddle. The pond still floors at zero and the
 * draw is still counted in full through the one accounting path, so plan §6's Dry County
 * board measures the water the player actually took. Only the MISSING pours are drawn, so
 * topping up a half-full can takes half a canful.
 *
 * Legal while water is within hand reach — the same reach every other hand verb measures,
 * so the arm that can water a tile can dip the can, and a walk-to errand that stops "within
 * reach" of the shoreline has arrived. In a world with no reservoir at all the refill
 * succeeds anywhere, because §4's guarantee is about the can, not the pond, and a pondless
 * world must not be a world where farming ends after eight pours. Refused rather than
 * consumed when the can is already full, which is `UseRepairKit`'s rule: a no-op must not
 * spend a trace entry pretending it did something.
 */
function applyRefillCan(state: WorldState): boolean {
  if (state.player.canCharges >= CAN_CHARGES_MAX) return false;

  const shore = reservoirWithinReach(
    state,
    state.player.xSub,
    state.player.ySub,
    HAND_REACH_SUBTILES,
  );
  if (shore === null && state.reservoirs.length > 0) return false;

  const missing = CAN_CHARGES_MAX - state.player.canCharges;
  takeWater(state, shore, missing * HAND_POUR_ML, WaterDraw.Shore);
  state.player.canCharges = CAN_CHARGES_MAX;
  touch(state, 'hopperRefill');
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
  return harvestOneTile(state, tile);
}

/**
 * The hand-harvest of one tile, shared by the click and by each of the scythe's three.
 *
 * **A FULL PLAYER CANNOT HARVEST, AND THE CROP STAYS IN THE GROUND.** That is item 023's
 * criterion word for word and it is also the anti-softlock answer: refusing costs nothing,
 * because a tile you could not pick is a tile that is still there when you come back with room.
 * The alternative — harvest anyway and drop the overflow — is a fine for misplacement, which
 * plan §4 rules out. The check is deliberately pessimistic about the yield (it asks for room for
 * the whole armful the tile might give, plus the seed it hands back) rather than harvesting and
 * discovering.
 */
function harvestOneTile(state: WorldState, tile: WorldState['field'][number]): boolean {
  if (!isTileReady(tile)) {
    // Sweeping up after a crop you never got to. Still worth bending down for.
    if (tile.compost <= 0) return false;
    if (!hasArmfulRoom(state, tile.compost)) return false;
    addItem(state, ItemId.Compost, tile.compost);
    tile.compost = 0;
    touch(state, 'handCarry');
    return true;
  }

  const spec = cropSpec(tile.crop);
  if (spec === null) return false;

  // The most this pull could possibly hand over: the yield at its luckiest, the compost on the
  // tile, and the seed a one-shot returns. Asked BEFORE anything is mutated, because `takeHarvest`
  // clears the tile and there would be nothing to put back.
  const worstCase = tile.fertility + 1 + tile.compost + (spec.regrowTicks > 0 ? 0 : 1);
  if (!hasArmfulRoom(state, worstCase)) return false;

  const result = takeHarvest(state, tile, spec);
  if (result === null) return false;

  addItem(state, result.item, result.count);
  if (tile.compost > 0) {
    addItem(state, ItemId.Compost, tile.compost);
    tile.compost = 0;
  }
  // Any potato replants as a seed — the anti-softlock floor of plan §4. Regrowing crops keep the
  // plant instead and return nothing, which `takeHarvest` has already decided.
  if (spec.regrowTicks <= 0) addItem(state, spec.seedItem, 1);

  state.stats.itemsHarvestedByHand += result.count;
  touch(state, 'handHarvest');
  return true;
}

/**
 * Swing the push-scythe: `SCYTHE_SWATHE_TILES` across the player's path, centred on the tile aimed
 * at. Plan §3's assisted rung of the harvesting ladder.
 *
 * **ACROSS THE FACING, NOT ALONG IT**, which is what makes it a scythe rather than a longer reach:
 * you walk the row and cut sideways. Facing north or south cuts an east–west line; facing east or
 * west cuts a north–south one.
 *
 * **ONE SWING IS ONE `handHarvest` TOUCH, NOT THREE, AND THE HANDS-FREE BOARD READS THIS NUMBER
 * FOREVER** — item 023 asks for the decision and the reasoning in writing, so here it is. Plan
 * §6's taxonomy counts *hands on the world*: the unit it is measuring is the player reaching out
 * and doing something, and a scythe swing is one motion of one pair of arms. Counting three would
 * make the assisted rung score **worse** on Hands-Free than doing the same work by hand — three
 * touches for one gesture against three touches for three — which inverts the whole ladder plan
 * §3 is built on, and would mean the way to win a board about not touching things was to refuse
 * the tool that touches them less.
 *
 * Unready tiles cost nothing and are untouched. A swing that cuts nothing at all is refused, so it
 * appends nothing to the trace and the "every applied command changed the world" contract holds.
 */
function applySwingScythe(state: WorldState, command: SwingScytheCommand): boolean {
  if (itemCount(state, ItemId.PushScythe) <= 0) return false;
  if (!withinReachOfTile(state, command.tileX, command.tileY)) return false;

  // Perpendicular to the facing. `Direction.None` is not a facing the player can hold — `facing`
  // keeps the last real direction — but a default of east keeps this total.
  const alongX = state.player.facing === Direction.North || state.player.facing === Direction.South;
  const half = divFloor(SCYTHE_SWATHE_TILES, 2);

  let cut = 0;
  for (let offset = -half; offset <= half; offset++) {
    const x = command.tileX + (alongX ? offset : 0);
    const y = command.tileY + (alongX ? 0 : offset);
    const tile = tileAt(state, x, y);
    if (tile === null || !isTileReady(tile)) continue;

    const spec = cropSpec(tile.crop);
    if (spec === null) continue;
    const worstCase = tile.fertility + 1 + tile.compost + (spec.regrowTicks > 0 ? 0 : 1);
    if (!hasArmfulRoom(state, worstCase)) continue;

    const result = takeHarvest(state, tile, spec);
    if (result === null) continue;
    addItem(state, result.item, result.count);
    if (tile.compost > 0) {
      addItem(state, ItemId.Compost, tile.compost);
      tile.compost = 0;
    }
    if (spec.regrowTicks <= 0) addItem(state, spec.seedItem, 1);
    state.stats.itemsHarvestedByHand += result.count;
    cut += 1;
  }

  if (cut === 0) return false;
  touch(state, 'handHarvest');
  return true;
}

/** Work a bag of Fertilizer into a tile. Refused, never consumed, on ground already at 3★. */
function applyApplyFertilizer(state: WorldState, command: ApplyFertilizerCommand): boolean {
  const tile = tileAt(state, command.tileX, command.tileY);
  if (tile === null) return false;
  if (!withinReachOfTile(state, command.tileX, command.tileY)) return false;
  if (itemCount(state, ItemId.Fertilizer) <= 0) return false;
  if (!fertilizeTile(tile)) return false;

  removeItem(state, ItemId.Fertilizer, 1);
  // `handCarry` rather than a category of its own. Plan §6's taxonomy is seven categories and it
  // is inside the hash, so it is not a list to extend casually — and `handCarry` is already where
  // this codebase files every hand verb that is not one of the six named ones (rotating an arm,
  // selling at the bin, buying at the stand, moving a machine). Working a bag into the soil is
  // carrying something and putting it somewhere.
  touch(state, 'handCarry');
  return true;
}

/**
 * Pack a perishable stack into a crate: §4's *"45 crated"*.
 *
 * **REFUSED RATHER THAN CONSUMED WHEN IT WOULD NOT HELP**, which is `UseRepairKit`'s rule and for
 * the same reason — a misclick that silently ate eight dollars teaches the player to distrust the
 * tool. "Would not help" is precise: the item must perish at all, the player must have some, and
 * the new deadline must actually be later than what those units already carry, so crating a stack
 * you crated a minute ago is refused instead of resetting the clock for free.
 */
function applyPackCrate(state: WorldState, command: PackCrateCommand): boolean {
  if (command.count <= 0 || !Number.isInteger(command.count)) return false;
  if (!isPerishable(command.item)) return false;
  if (itemCount(state, ItemId.Crate) <= 0) return false;

  const held = itemCount(state, command.item);
  if (held <= 0) return false;

  const wanted = command.count < CRATE_PACK_CAPACITY ? command.count : CRATE_PACK_CAPACITY;
  const packed = wanted < held ? wanted : held;
  if (packed <= 0) return false;

  const deadline =
    divFloor(state.tick + CRATE_FRESHNESS_TICKS, FRESHNESS_BUCKET_TICKS) * FRESHNESS_BUCKET_TICKS;
  // Nothing to gain: the soonest-expiring stack already keeps longer than a crate would give it.
  const slot = inventorySlot(state, command.item);
  if (slot === null || soonestSpoilTick(slot) >= deadline) return false;

  // Out of the soonest-expiring stacks and back in at the crate's deadline — which is exactly
  // what packing is. `removeItem` already eats soonest-first, so the goods that were about to
  // turn are the goods that get saved.
  if (!removeItem(state, command.item, packed)) return false;
  addItemFresh(state, command.item, packed, deadline);
  removeItem(state, ItemId.Crate, 1);
  touch(state, 'handCarry');
  return true;
}

/** Every tile of a footprint is inside the world, owned, off the field, and unoccupied. */
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
      // A machine may not straddle the fence, not even by one tile of a 3×2 Bottler. Ownership
      // is asked per tile rather than per parcel for exactly that case.
      if (!isOwnedTile(state, x, y)) return false;
      if (isFieldTile(x, y)) return false;
      const occupant = machineAt(state, x, y);
      if (occupant !== null && occupant.id !== ignoreMachineId) return false;
      if (occupant === null && tileOccupied(state, x, y)) return false;
    }
  }
  return true;
}

/**
 * Put a machine down — out of the bag if there is one in it, off the shelf otherwise.
 *
 * THE BOX IS CHECKED FIRST AND IT IS FREE. A boxed machine was already paid for, and moving one
 * around the lot has always been free (plan §4), so charging again for putting down the same
 * Fryer you just picked up would make rearranging cost money in a game whose stated rule is that
 * it does not. Buying new is the fallback rather than the other way round because a player with
 * a box in the bag and the cash for a new one almost never means "spend the cash", and the one
 * time they do, they can scrap the box for 40% and buy whatever they like.
 *
 * NOTHING IS CONSUMED UNTIL EVERY REFUSAL HAS PASSED. The order below matters: the box comes out
 * of the bag only after the footprint, the tech gate and the plumbing rules have all said yes,
 * because a refused placement that had already eaten the box would be a machine deleted by a
 * misclick — and misplacement is never a fine (plan §4).
 */
function applyPlaceMachine(state: WorldState, command: PlaceMachineCommand): boolean {
  const spec = machineSpec(command.kind);
  if (spec === null) return false;
  // The gate stands whether the machine is bought or unboxed. It costs nothing either way — a
  // box can only exist for a machine the player already researched, and nothing un-researches —
  // but the rule reading the same for both paths is worth more than the line it saves.
  if (!unlocked(state, spec.requiresTech)) return false;

  const boxedItem = boxedItemForMachine(command.kind);
  const box = boxedItem === null ? null : peekBoxedMachine(state, boxedItem);
  if (box === null && state.moneyCents < spec.priceCents) return false;

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

  if (box === null) {
    state.moneyCents -= spec.priceCents;
    recordSpend(state.stats, spec.priceCents);
  } else {
    // The same box `peek` promised, taken now that the placement is certain to happen.
    takeBoxedMachine(state, boxedItem as ItemId);
    machine.speedLevel = box.speedLevel;
    machine.efficiencyLevel = box.efficiencyLevel;
    machine.capacityLevel = box.capacityLevel;
    machine.condition = box.condition;
    // The invoice travels too, so net worth, the scrap value, and the next dial's price all
    // read the machine's real history rather than a fresh one's list price. A boxed machine
    // that came back invoiced at list would hand the player free net worth for a round trip.
    machine.investedCents = box.investedCents;
    touch(state, 'handCarry');
  }
  // A DOCK ARRIVES WITH ITS BOT. There is no `BuyBot` command and there should not be one: one
  // dock, one bot (item 038's instruction 1), so which bot you have is never a question separate
  // from which docks you built. It comes out of the shed at full condition and stands there until
  // the player points the dock at a zone, which is the one thing about it that IS a decision.
  if (isBotDockKind(command.kind)) {
    spawnBot(
      state,
      command.kind === MachineKind.PlanterDock ? BotKind.Planter : BotKind.Harvester,
      machine,
    );
  }
  // On edit only, never per tick. A machine that landed beside a pipe run is now on it.
  if (spec.liquid !== 0) rebuildNetworks(state);
  return true;
}

/**
 * Take a machine off the lot and put it in the bag.
 *
 * IT PAYS NOTHING, AND THAT IS THE FEATURE. Boxing is the rearranging verb, not the selling
 * one: the machine is already paid for, so it comes back as itself — dials, condition and
 * invoice intact — and goes down again for free. The 40% is one deliberate step further on,
 * at `SellBoxedMachine`, so a player can never scrap a factory by fumbling the demolish key.
 *
 * WHAT "MID-BATCH" MEANS HERE, precisely, because the obvious reading is wrong. It is NOT
 * `progress > 0`: an upgraded machine finishes each operation with leftover work-points banked
 * — `effectiveWorkRate` rarely divides `workPerOperation` evenly — so `progress > 0` is the
 * resting state of every machine with a Speed dial on it, and refusing on it would ban boxing
 * exactly the machines this feature exists for. Mid-batch is a machine that WOULD ADVANCE THIS
 * TICK: it has the ingredients, it has the room, and it is turning. Stop it — take its output,
 * cut its supply — and it boxes, the same demand-pull vocabulary the whole factory is taught in.
 *
 * Everything countable comes back to the player's hands: the output buffer through the one take
 * path (burnt first, because that is the rule everywhere else), and every line of the recipe.
 * LIQUID DOES NOT, and cannot: there is no item id for a millilitre of anything in this game and
 * no price on one either, so a tank's contents go on the ground. Net worth has never counted
 * water — "a tank full of it is a machine doing its job, not inventory" — so nothing the game
 * measures is lost, and nothing it measures is gained.
 */
function applyDeconstructMachine(state: WorldState, command: DeconstructMachineCommand): boolean {
  const machine = machineById(state, command.machineId);
  if (machine === null || !withinReachOfMachine(state, machine)) return false;

  const spec = machineSpec(machine.kind);
  if (spec === null) return false;

  // No box for the sell bin — see `ItemId`. It is the world's gift and the only way to trade;
  // a lot with no bin on it is a save that cannot sell a potato.
  const boxedItem = boxedItemForMachine(machine.kind);
  if (boxedItem === null) return false;

  if (machine.jammed) return false;
  if (isMachineWorking(spec, machine)) return false;
  // A CART ON THE ROAD IS NOT ON THE LOT, so there is nothing standing here to put in a box.
  // This is the vehicles' version of the mid-batch refusal above and it is a separate check for
  // a precise reason: `isMachineWorking` tests `workPerOperation`, and a cart has none, so it
  // would cheerfully report a cart halfway to town as idle and boxable — which would delete a
  // load of goods and a running clock in one keypress.
  if (isCartAway(machine)) return false;

  for (;;) {
    const item = takeOneOutput(machine, spec);
    if (item === null) break;
    addItem(state, item, 1);
  }
  for (let i = 0; i < spec.inputs.length; i++) {
    const held = machine.inputCounts[i] ?? 0;
    if (held > 0) addItem(state, spec.inputs[i]!.item, held);
    machine.inputCounts[i] = 0;
  }
  // Cargo in a parked cart, a crate's contents, or a planter's seed hopper — all the same field,
  // and all of it comes back to the player's hands exactly as the recipe buffers do. The box
  // records the dials, the condition and the invoice — never the load.
  if (machine.cargoItem !== 0 && machine.cargoCount > 0) {
    addItem(state, machine.cargoItem, machine.cargoCount);
  }
  machine.cargoItem = 0;
  machine.cargoCount = 0;
  // A boxed dock takes its bot with it, and whatever the bot was carrying comes back too. Nothing
  // vanishes (plan §4), and a bot whose shed is in the player's bag has nowhere to walk to.
  const orphans = removeBotsForDock(state, machine.id);
  for (let i = 0; i < orphans.length; i++) {
    const bot = orphans[i]!;
    if (bot.carryItem !== 0 && bot.carryCount > 0) addItem(state, bot.carryItem, bot.carryCount);
  }
  // And a boxed hand cart cannot still be in tow. Cleared here rather than left for the mover to
  // notice, so `towedCartId` never names a machine that is not on the lot.
  if (state.player.towedCartId === machine.id) state.player.towedCartId = 0;
  // A depot's routes go with the depot, handing back the floor and anything already rolling. A
  // contract whose depot is in somebody's bag has nothing to load it — see `releaseDepotContracts`.
  if (spec.role === MachineRole.TruckDepot) releaseDepotContracts(state, machine.id);

  addBoxedMachine(state, boxedItem, {
    speedLevel: machine.speedLevel,
    efficiencyLevel: machine.efficiencyLevel,
    capacityLevel: machine.capacityLevel,
    condition: machine.condition,
    investedCents: machine.investedCents,
  });

  removeMachineById(state, machine.id);
  // The same recompute `MoveMachine` runs, for the same reason and then some: a machine with a
  // port has just LEFT its network, and a membership list that still names it is a ledger
  // dividing supply among a consumer that is in somebody's bag. Stale membership is a
  // determinism bug that hides for weeks, so it is a full rebuild on edit, never a patch.
  if (spec.liquid !== 0 || spec.ports.length > 0) rebuildNetworks(state);
  touch(state, 'handCarry');
  return true;
}

/**
 * Is this machine actually turning right now? See `applyDeconstructMachine` for why this is the
 * mid-batch test rather than `progress > 0`.
 *
 * A machine with no work cycle at all — a sprinkler, a tank, a pump — is never mid-batch. It has
 * no operation to be in the middle of, and `recipeSatisfied` on an empty recipe is vacuously
 * true, which would otherwise make every one of them permanently un-boxable.
 */
function isMachineWorking(spec: MachineSpec, machine: Machine): boolean {
  if (spec.workPerOperation <= 0) return false;
  if (machine.condition <= 0) return false;
  // **A TREE IS NEVER MID-BATCH, AND WITHOUT THIS LINE A TREE COULD NEVER BE DUG UP AT ALL.**
  // The mid-batch refusal means "it has the ingredients and it has the room, so stop it first" —
  // and an orchard has no ingredients, so `recipeSatisfied` is vacuously true and any tree with
  // one space left in its basket reads as running, forever. The player would be able to move a
  // tree only in the ten seconds after its buffer filled, which is not a rule anybody could
  // guess. What is lost by digging one up mid-fruit is banked progress, which is what every
  // other machine loses too: work-points are not an item and cannot be spilled.
  if (spec.role === MachineRole.Orchard) return false;
  return recipeSatisfied(spec, machine) && outputHasRoom(spec, machine);
}

function removeMachineById(state: WorldState, id: number): void {
  for (let i = 0; i < state.machines.length; i++) {
    if (state.machines[i]!.id === id) {
      state.machines.splice(i, 1);
      return;
    }
  }
}

/**
 * Scrap one boxed machine for 40% of what was invested in it.
 *
 * NOT LOCATION-GATED, and that is the one place this verb parts company with `SellItem`. The
 * bin is a physical stand you carry goods to; this is paperwork done from the inventory panel,
 * the same shape as `ResearchTech`, which also spends money from wherever the player happens to
 * be standing. Item 054 states it directly: the bin does not accept boxed machines, and the
 * panel is where they are sold.
 *
 * BOOKED AS A REFUND, NOT AS EARNINGS. The player spent 100% on that machine and got 40% back,
 * so they are out 60% — which is exactly what `recordRefund` leaves on the ledger, because it
 * reverses a spend rather than inventing income. Counting it as earnings would inflate the
 * gross receipts every leaderboard board is read off, and putting it through `itemsSold` would
 * let a player buy and scrap machines to walk a Charter milestone that is supposed to mean
 * "you sold two hundred things you made".
 */
function applySellBoxedMachine(state: WorldState, command: SellBoxedMachineCommand): boolean {
  if (machineKindForBoxedItem(command.item) === null) return false;

  const box = takeBoxedMachine(state, command.item);
  if (box === null) return false;

  const payout = boxedMachineScrapCents(box.investedCents);
  state.moneyCents += payout;
  recordRefund(state.stats, payout);
  touch(state, 'handCarry');
  return true;
}

/** Free, always. Buffers, condition, and dials travel with the machine (plan §4). */
function applyMoveMachine(state: WorldState, command: MoveMachineCommand): boolean {
  const machine = machineById(state, command.machineId);
  if (machine === null) return false;
  if (machine.tileX === command.tileX && machine.tileY === command.tileY) return false;
  // You cannot push a cart that is not here. Refused rather than allowed-and-ignored, because
  // the run's duration was measured from where it set off and a cart that teleported mid-journey
  // would arrive somewhere it never left from.
  if (isCartAway(machine)) return false;

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
  handsOn(machine);
  touch(state, 'handCarry');
  return true;
}

/**
 * Load a machine by hand.
 *
 * THE COMMAND STAYS `{ machineId, count }` AND THE RECIPE LINE IS OPTIONAL, deliberately. Every
 * machine in the game but one takes a single ingredient, and making the HUD name a line for the
 * Washer would be a worse interface bought for one Combo Packer. With no line given, the machine
 * takes the first ingredient the player is actually carrying and has room for — a total order
 * over the recipe, so a replay picks the same one forever.
 */
function applyLoadMachine(state: WorldState, command: LoadMachineCommand): boolean {
  if (command.count <= 0) return false;
  const machine = machineById(state, command.machineId);
  if (machine === null || !withinReachOfMachine(state, machine)) return false;

  const spec = machineSpec(machine.kind);
  if (spec === null) return false;

  // Storage takes one product and as much of it as fits — see `applyUnloadMachine` for why the
  // pair of verbs is shared rather than duplicated. Which product is whichever the command names,
  // or whatever the box already holds; a box holding potatoes refuses corn rather than mixing,
  // because "what is in this" has to stay one word.
  if (spec.role === MachineRole.Storage) {
    if (command.item === undefined) return false;
    if (machine.cargoItem !== 0 && machine.cargoItem !== command.item) return false;
    const room = spec.inputCapacity - machine.cargoCount;
    const have = itemCount(state, command.item);
    const moved = Math.min(command.count, Math.min(room, have));
    if (moved <= 0) return false;

    removeItem(state, command.item, moved);
    machine.cargoItem = command.item;
    machine.cargoCount += moved;
    handsOn(machine);
    touch(state, 'handCarry');
    return true;
  }

  if (spec.inputs.length === 0) return false;

  const capacity = effectiveInputCapacity(spec, machine);
  for (let i = 0; i < spec.inputs.length; i++) {
    const line = spec.inputs[i]!;
    if (command.item !== undefined && command.item !== line.item) continue;

    const space = capacity - (machine.inputCounts[i] ?? 0);
    const have = itemCount(state, line.item);
    const moved = Math.min(command.count, Math.min(space, have));
    if (moved <= 0) continue;

    removeItem(state, line.item, moved);
    machine.inputCounts[i] = (machine.inputCounts[i] ?? 0) + moved;
    handsOn(machine);
    touch(state, 'handCarry');
    return true;
  }
  return false;
}

/**
 * Take hold of a hand cart. Reach-gated, and it drops whatever was already in tow.
 *
 * A player has one back, so hitching a second cart lets the first one go where the player is
 * standing — which is the only reading that does not require a second `towedCartId`.
 */
function applyHitchCart(state: WorldState, command: HitchCartCommand): boolean {
  const cart = machineById(state, command.cartId);
  if (cart === null || cart.kind !== MachineKind.HandCart) return false;
  if (!withinReachOfMachine(state, cart)) return false;
  if (state.player.towedCartId === cart.id) return false;

  state.player.towedCartId = cart.id;
  handsOn(cart);
  touch(state, 'handCarry');
  return true;
}

/** Let go. The cart stands where the player is standing; free, always. */
function applyUnhitchCart(state: WorldState): boolean {
  if (state.player.towedCartId === 0) return false;
  state.player.towedCartId = 0;
  touch(state, 'handCarry');
  return true;
}

/**
 * Point a dock at a zone. Paperwork: no reach check, no touch — see `SetDockZoneCommand`.
 *
 * A zone id of 0 unbinds, which is a legal thing to want and is how a player retires a dock
 * without boxing it. An id that names no zone is refused rather than stored, because a dock
 * pointed at a zone that does not exist is a machine with instructions nothing can read.
 */
function applySetDockZone(state: WorldState, command: SetDockZoneCommand): boolean {
  const dock = machineById(state, command.machineId);
  if (dock === null || !isBotDockKind(dock.kind)) return false;
  if (dock.boundZone === command.zoneId) return false;
  if (command.zoneId !== 0 && zoneById(state, command.zoneId) === null) return false;

  dock.boundZone = command.zoneId;
  return true;
}

function applyUnloadMachine(state: WorldState, command: UnloadMachineCommand): boolean {
  if (command.count <= 0) return false;
  const machine = machineById(state, command.machineId);
  if (machine === null || !withinReachOfMachine(state, machine)) return false;

  const spec = machineSpec(machine.kind);
  if (spec === null) return false;

  // A STORAGE MACHINE HAS NO OUTPUT BUFFER; IT HAS CONTENTS. Emptying a Root Cellar or a hand
  // cart is the same verb the player already knows, aimed at the same key, counted the same way —
  // which is the whole reason storage is a machine role rather than a new entity with its own
  // pair of commands. Freshness is stamped on the way OUT, from this tick, because nothing inside
  // any machine ages (see `InventorySlot.stacks`) and goods that have just come back into the
  // player's arms are loose again.
  if (spec.role === MachineRole.Storage) {
    if (machine.cargoItem === 0 || machine.cargoCount <= 0) return false;
    const wanted = Math.min(command.count, machine.cargoCount);
    const taken = Math.min(wanted, armfulRoom(state));
    if (taken <= 0) return false;

    const item = machine.cargoItem;
    machine.cargoCount -= taken;
    if (machine.cargoCount === 0) machine.cargoItem = 0;
    addItem(state, item, taken);
    handsOn(machine);
    touch(state, 'handCarry');
    return true;
  }

  if (spec.outputItem === null) return false;

  const wanted = Math.min(command.count, machine.outputCount);
  const moved = Math.min(wanted, armfulRoom(state));
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

  handsOn(machine);
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
  if (spec === null) return false;

  // **A SEED HOPPER FILLED BY HAND, AND THIS IS THE LINE THE HANDS-FREE BOARD RESTS ON.** §6's
  // taxonomy names *"hand-refilling any hopper (seeds, kits, consumables)"* as a disqualifier, so
  // the hand path has to cost a touch and the belt path has to cost nothing — which means they
  // cannot be one function with a flag. This is the hand path; `dockAcceptSeed` in `bots.ts` is
  // the belt's, and it counts nothing. A genuinely hands-free farm therefore has to feed its
  // planter by belt, which is the design turning the board into a logistics problem rather than a
  // purchase.
  //
  // It routes through `RefillHopper` rather than a new command because that command already
  // exists, already counts `hopperRefill`, and already has a walk-to errand wired — item 023 says
  // in as many words: do not invent a second refill path.
  if (spec.role === MachineRole.BotDock) {
    if (machine.kind !== MachineKind.PlanterDock) return false;
    const seed = dockWantedSeed(state, machine);
    if (seed === 0) return false;
    if (machine.cargoItem !== 0 && machine.cargoItem !== seed) return false;

    const room = spec.inputCapacity - machine.cargoCount;
    const have = itemCount(state, seed);
    const moved = Math.min(room, have);
    if (moved <= 0) return false;

    removeItem(state, seed, moved);
    machine.cargoItem = seed;
    machine.cargoCount += moved;
    handsOn(machine);
    touch(state, 'hopperRefill');
    return true;
  }

  if (spec.tankCapacityMl <= 0) return false;

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
  handsOn(machine);
  touch(state, 'hopperRefill');
  return true;
}

function applyRepairMachine(state: WorldState, command: RepairMachineCommand): boolean {
  const machine = machineById(state, command.machineId);
  if (machine === null || !withinReachOfMachine(state, machine)) return false;

  // **A DOCK'S BOTS ARE REPAIRED BY REPAIRING THE DOCK**, and that is a deliberate choice about
  // where the player stands rather than a shortcut. A bot is somewhere in a field on most ticks,
  // so a repair aimed at the bot itself would mean chasing a robot around a zone with the repair
  // key held — which is the opposite of what the automated rung was bought for. You service it in
  // its shed, like anything else with wheels.
  const serviced = repairBotsAtDock(state, machine);
  if (machine.condition >= CONDITION_MAX) {
    if (!serviced) return false;
    handsOn(machine);
    touch(state, 'handRepair');
    return true;
  }

  // Hold-to-repair is free and always available. Hand tools never rot (plan §1).
  machine.condition = Math.min(CONDITION_MAX, machine.condition + REPAIR_PER_TOUCH);
  handsOn(machine);
  touch(state, 'handRepair');
  return true;
}

/** One repair pulse into every bot living in this machine. Returns true if any of them wanted it. */
function repairBotsAtDock(state: WorldState, dock: Machine): boolean {
  let serviced = false;
  for (let i = 0; i < state.bots.length; i++) {
    const bot = state.bots[i]!;
    if (bot.dockId !== dock.id) continue;
    if (bot.condition >= CONDITION_MAX) continue;
    bot.condition = Math.min(CONDITION_MAX, bot.condition + REPAIR_PER_TOUCH);
    serviced = true;
  }
  return serviced;
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
    // A kit tops a dock's bots up with everything else in the cell. "One trip services a cell"
    // (plan §4) would be a strange promise if the one thing in the cell that actually moves had
    // to be serviced separately.
    let wantsBots = false;
    for (let j = 0; j < state.bots.length; j++) {
      const bot = state.bots[j]!;
      if (bot.dockId === machine.id && bot.condition < CONDITION_MAX) wantsBots = true;
    }
    if (machine.condition >= CONDITION_MAX && !machine.jammed && !wantsBots) continue;

    machine.condition = CONDITION_MAX;
    machine.jammed = false;
    for (let j = 0; j < state.bots.length; j++) {
      const bot = state.bots[j]!;
      if (bot.dockId === machine.id) bot.condition = CONDITION_MAX;
    }
    handsOn(machine);
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
  handsOn(machine);
  touch(state, 'jamWhack');
  return true;
}

function applySellItem(state: WorldState, command: SellItemCommand): boolean {
  if (command.count <= 0) return false;
  // THE BIN DOES NOT BUY SEEDS. Plan §4's anti-softlock floor is that a harvested potato always
  // hands one back, and a bin that bought them at list would let a misclick sell a world's
  // ability to plant — for the same price the stand will sell it straight back, so it is not
  // even a trade. Refused here rather than hidden in the HUD, and `InventoryView.sellable`
  // carries the same fact outward so the affordance is greyed rather than merely ignored.
  if (!isSellable(command.item)) return false;
  if (!nearSellBin(state)) return false;
  if (!removeItem(state, command.item, command.count)) return false;

  const gross = listPriceCents(command.item) * command.count;
  state.moneyCents += gross;
  // `recordSale` owns the gross, the unit count, and the per-item row in one write, here and
  // in `payForDelivery` — the two doors every sale in the game walks through (item 062).
  recordSale(state.stats, command.item, command.count, gross);
  touch(state, 'handCarry');
  return true;
}

/** The roadside stand sells seeds back. Prices are the number on the board (plan §4). */
function applyBuyItem(state: WorldState, command: BuyItemCommand): boolean {
  if (command.count <= 0) return false;
  if (!isPurchasable(command.item)) return false;
  if (!nearSellBin(state)) return false;

  // The armful again: you can only buy what you can carry home. Refused rather than clamped,
  // because the count is the player's own number off a panel and quietly buying four of twenty
  // would be the shop deciding for them — and unlike a harvest there is nothing to leave behind.
  if (!hasArmfulRoom(state, command.count)) return false;

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

  const cost = upgradeCostCents(spec, level, command.dial);
  if (cost < 0 || state.moneyCents < cost) return false;

  state.moneyCents -= cost;
  recordSpend(state.stats, cost);
  machine.investedCents += cost;
  setUpgradeLevel(machine, command.dial, level + 1);
  handsOn(machine);
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
      // Ticks to whole in-game days, converted HERE so `tech.ts` stays a leaf that has never
      // heard of a tick. Plan §3 quotes the Corporate Charter in days and this is the one place
      // that unit is turned into the other.
      divFloor(state.stats.longestUntouchedMachineTicks, TICKS_PER_IN_GAME_DAY),
    )
  ) {
    return false;
  }
  if (state.moneyCents < node.priceCents) return false;

  state.moneyCents -= node.priceCents;
  recordSpend(state.stats, node.priceCents);
  return insertUnlocked(state.unlocked, node.id);
}

// --- land -------------------------------------------------------------------------

/**
 * Buy the deed to one parcel (plan §5: *"adjacent parcels are purchasable land deeds at
 * escalating prices"*).
 *
 * THREE REFUSALS AND THEY ARE ALL THE WORLD'S, not the client's: the parcel must be on the map
 * and not already owned, it must touch land this world holds, and the money must be there. The
 * price is never in the payload — `nextDeedPriceCents` reads the ladder and the count of deeds
 * already bought, so a replay cannot depend on what some build thought land was worth.
 *
 * THE MONEY MOVES BEFORE THE LAND DOES, which matters here more than it does anywhere else in
 * this file: `nextDeedPriceCents` is a function OF `ownedParcels`, so owning the parcel first
 * would charge the player the *next* deed's price for the one they just took. Read the price,
 * check it, spend it, then own it.
 *
 * SHAPED LIKE `ResearchTech` RATHER THAN LIKE A PLACEMENT: no reach check, no footprint, no
 * walk-to errand. Buying land is signing for it — there is nothing on the parcel to stand next
 * to, and a reach gate would mean walking onto land you do not own to buy the right to be
 * there. See `BuyDeedCommand` for the same argument at the payload.
 */
function applyBuyDeed(state: WorldState, command: BuyDeedCommand): boolean {
  if (!isParcelBuyable(state, command.parcel)) return false;

  const price = nextDeedPriceCents(state);
  // -1 means the ladder has run out, which cannot happen while a parcel is still buyable —
  // but a sentinel that is silently treated as "free" is exactly how one eventually does.
  if (price < 0) return false;
  if (state.moneyCents < price) return false;

  state.moneyCents -= price;
  recordSpend(state.stats, price);
  // The land goes on the books at what it cost, so buying a parcel is neutral on plan §6's
  // net-worth boards rather than a self-inflicted loss. `computeNetWorthCents` reads
  // `landValueCents` off this list; nothing else has to be told.
  return ownParcel(state, command.parcel);
}

// --- selling above the roadside stand ----------------------------------------------

/**
 * Load a cart by hand.
 *
 * COUNTS A `handCarry` TOUCH, and that is not a formality — plan §6's taxonomy lists
 * "hand-carry/load/unload" as one category, and the cart is the ASSISTED rung of the ladder,
 * which means fewer hands rather than none. If this ever stopped counting, the Hands-Free board
 * would be won by loading a cart, which is the one thing it is supposed to measure the absence
 * of.
 *
 * The count is clamped to what fits rather than refused: the panel asks for `capacity - loaded`,
 * and a belt that delivered one more bag between the render and the click must not turn a
 * "fill it" button into a silent no-op.
 */
function applyLoadCart(state: WorldState, command: LoadCartCommand): boolean {
  if (command.count <= 0 || !Number.isInteger(command.count)) return false;

  const cart = machineById(state, command.cartId);
  if (cart === null || !isCart(cart)) return false;
  if (!withinReachOfMachine(state, cart)) return false;
  // A cart on the road is not there to be loaded. The refusal is on `isCartAway` rather than on
  // a flag, so it cannot disagree with the clock that is actually counting.
  if (isCartAway(cart)) return false;
  // The same rule the bin refuses on, for the same anti-softlock reason: a cart is a way to sell
  // things, so a cart that would take seeds is a bin that would buy them with extra steps.
  if (!contractItemLegal(command.item)) return false;

  const room = cartRoomFor(cart, command.item);
  if (room <= 0) return false;
  const count = command.count < room ? command.count : room;
  if (!removeItem(state, command.item, count)) return false;

  cart.cargoItem = command.item;
  cart.cargoCount += count;
  touch(state, 'handCarry');
  return true;
}

/** Send it. Counts a hand-carry touch; an empty or already-departed cart is refused. */
function applyDispatchCart(state: WorldState, command: DispatchCartCommand): boolean {
  const cart = machineById(state, command.cartId);
  if (cart === null || !isCart(cart)) return false;
  if (!withinReachOfMachine(state, cart)) return false;
  if (isCartAway(cart)) return false;
  if (cart.cargoCount <= 0 || cart.cargoItem === 0) return false;

  // Measured now, from where the cart is standing, and stored as a countdown rather than as a
  // return tick. A stored deadline would be a number that means nothing after a save is loaded
  // into a world whose clock is at a different place — a countdown means the same thing forever.
  cart.runTicksRemaining = cartRunTicks(cart);
  touch(state, 'handCarry');
  return true;
}

/**
 * Sign a standing route.
 *
 * NO TOUCH, AND NO REACH CHECK. Both follow from the same fact: this is paperwork rather than a
 * verb you do with your hands, so there is nothing to stand next to and nobody to charge. It is
 * the same shape as `ResearchTech`, which also spends money from wherever the player happens to
 * be, and it is what makes a depot genuinely hands-free rather than hands-free-after-a-walk.
 *
 * ONE ROUTE PER PRODUCT PER DEPOT. Two routes for bagged chips on one depot would compete for
 * the same floor, and whichever had the lower id would take every bag while the other sat at
 * zero forever — a rule nothing on screen could explain. Refused here, so it cannot happen.
 */
function applyCreateContract(state: WorldState, command: CreateContractCommand): boolean {
  const depot = machineById(state, command.depotId);
  if (depot === null || !isDepot(depot)) return false;
  if (!contractItemLegal(command.item)) return false;
  if (!contractQuantityLegal(command.quantityPerRun)) return false;
  if (!depotHasContractRoom(state, command.depotId)) return false;
  if (depotRouteFor(state, command.depotId, command.item) !== null) return false;

  // Ids only increase, so appending keeps the list sorted — the same invariant every other
  // id-keyed collection in `WorldState` holds by construction rather than by sorting.
  state.contracts.push({
    id: state.nextContractId,
    depotId: command.depotId,
    item: command.item,
    quantityPerRun: command.quantityPerRun,
    destination: clipDestination(command.destination),
    stocked: 0,
    inTransit: 0,
    phase: ContractPhase.Waiting,
    ticksRemaining: 0,
    runsCompleted: 0,
    grossCents: 0,
  });
  state.nextContractId += 1;
  return true;
}

/** Tear a route up. Free, always, and everything comes back — see `refundContract`. */
function applyCancelContract(state: WorldState, command: CancelContractCommand): boolean {
  const contract = contractById(state, command.contractId);
  if (contract === null) return false;
  refundContract(state, contract);
  return removeContractById(state, contract.id);
}

// --- belts and grabbers -----------------------------------------------------------

/**
 * Lay a belt run: one segment, or two meeting at a right angle.
 *
 * BOTH LEGS ARE JUDGED BEFORE EITHER IS BUILT, which is the whole reason an L is one command
 * (see `PlaceBeltCommand`). The tile loop below runs over the entire run and the money is
 * checked against the entire run, so a bend whose far leg crosses a machine lays nothing at
 * all rather than leaving half of itself on the lot.
 *
 * `BELT_MAX_LENGTH_TILES` IS PER LEG, NOT PER RUN, and that is the reading that was already
 * true rather than a relaxation: the cap is a property of a `Belt`, which is one straight
 * segment, and two segments meeting at a corner are two belts by every other rule in this
 * file — separate ids, separate item lists, separate refunds when they come back up. A player
 * who wants a longer run drags again from the end, exactly as before; what changes is that
 * the corner between the two no longer costs a second gesture.
 */
function applyPlaceBelt(state: WorldState, command: PlaceBeltCommand): boolean {
  const spec = beltSpec(command.tier);
  if (spec === null) return false;
  if (!unlocked(state, spec.requiresTech)) return false;
  if (!isCompassDirection(command.dir)) return false;
  if (command.lengthTiles < 1 || command.lengthTiles > BELT_MAX_LENGTH_TILES) return false;

  const dx = directionStepX(command.dir);
  const dy = directionStepY(command.dir);

  // The second leg, if there is one. It starts at the first leg's EXIT tile — one step past
  // its last — so the elbow belongs to the second segment and the hand-off in `belts.ts`
  // finds a belt starting exactly where the first one delivers.
  const turnDir = command.turnDir ?? Direction.None;
  const turnLength = command.turnLengthTiles ?? 0;
  const turning = turnDir !== Direction.None || turnLength > 0;
  let turnDx = 0;
  let turnDy = 0;
  let turnOriginX = 0;
  let turnOriginY = 0;

  if (turning) {
    if (!isCompassDirection(turnDir)) return false;
    if (turnLength < 1 || turnLength > BELT_MAX_LENGTH_TILES) return false;
    turnDx = directionStepX(turnDir);
    turnDy = directionStepY(turnDir);
    // Perpendicular, or nothing. Parallel is a straight run written in two pieces and
    // anti-parallel is a belt folded back over itself; both would also make the two legs
    // fight over tiles, which the disjointness the loops below rely on assumes away.
    if (turnDx * dx + turnDy * dy !== 0) return false;
    turnOriginX = command.tileX + dx * command.lengthTiles;
    turnOriginY = command.tileY + dy * command.lengthTiles;
  }

  const totalTiles = command.lengthTiles + (turning ? turnLength : 0);

  for (let i = 0; i < totalTiles; i++) {
    const onFirst = i < command.lengthTiles;
    const step = onFirst ? i : i - command.lengthTiles;
    const x = onFirst ? command.tileX + dx * step : turnOriginX + turnDx * step;
    const y = onFirst ? command.tileY + dy * step : turnOriginY + turnDy * step;
    if (!isInsideWorld(x, y)) return false;
    // The whole run or none of it, the same rule a pipe path follows: a belt dragged across
    // the fence is refused rather than clipped at it, because a stub that stops where the
    // player did not aim is a stub they now have to find and take up. With a bend that rule
    // spans both legs, which is why this loop walks the run rather than one segment.
    if (!isOwnedTile(state, x, y)) return false;
    if (isFieldTile(x, y)) return false;
    if (tileOccupied(state, x, y)) return false;
  }

  const cost = spec.priceCentsPerTile * totalTiles;
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

  if (turning) {
    const second = spawnBelt(state, command.tier, turnOriginX, turnOriginY, turnDir, turnLength);
    // Nothing above can make this fail — the tiles were all checked and `spawnBelt` refuses
    // only what those checks already cover — but a half-laid run is the one outcome this
    // command exists to prevent, so the first leg goes back rather than being left standing.
    if (second === null) {
      removeBeltById(state, belt.id);
      return false;
    }
  }

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
  if (!isOwnedTile(state, command.tileX, command.tileY)) return false;
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

/**
 * Turn a placed arm one step clockwise.
 *
 * REACH-GATED, unlike `SetGrabberFilter` beside it, and the difference is not an oversight in
 * either direction. Retuning a filter is paperwork — a dropdown on a panel that names an arm.
 * Rotating one is the player reaching out and shoving it, the same physical verb as repairing
 * or whacking a machine, and it is the verb item 052 asks for: *"fixes it with one keypress
 * standing next to it"*. Standing next to it is half the sentence.
 *
 * It takes the tile rather than a footprint centre because a grabber is one tile and always
 * will be — `Grabber` has no size, only a position.
 *
 * WHAT IT DOES NOT DO IS DROP WHAT THE ARM IS HOLDING. An arm mid-swing keeps its item and its
 * cooldown and simply finishes the swing facing the new way, which is both the readable answer
 * — you turned the arm, you did not empty its hand — and the one that cannot make an item
 * vanish (plan §4).
 */
function applyRotateGrabber(state: WorldState, command: RotateGrabberCommand): boolean {
  const grabber = grabberById(state, command.grabberId);
  if (grabber === null) return false;
  if (!withinReachOfTile(state, grabber.tileX, grabber.tileY)) return false;

  const turned = rotateDirectionClockwise(grabber.dir);
  // `None` is not a legal facing, so a grabber that somehow held one has nowhere to turn to.
  // Refusing keeps the "every applied command changed the world" contract the trace rests on.
  if (turned === Direction.None) return false;

  grabber.dir = turned;
  touch(state, 'handCarry');
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
    dragTowedCart(state);
    return;
  }

  if (player.moveDir === Direction.None) {
    player.moveAccum = 0;
    dragTowedCart(state);
    return;
  }

  // 4 tiles/s at 20 Hz is 51.2 subtiles per tick. Accruing hundredths and spending whole
  // subtiles keeps that exact; rounding to 51 would quietly make the character slow.
  player.moveAccum += playerSpeed(state);
  const stepSub = divFloor(player.moveAccum, 100);
  player.moveAccum -= stepSub * 100;
  if (stepSub === 0) {
    dragTowedCart(state);
    return;
  }

  if (player.moveDir === Direction.North) player.ySub -= stepSub;
  else if (player.moveDir === Direction.South) player.ySub += stepSub;
  else if (player.moveDir === Direction.West) player.xSub -= stepSub;
  else player.xSub += stepSub;

  player.xSub = clampInt(player.xSub, 0, WORLD_TILES_WIDE * SUBTILE - 1);
  player.ySub = clampInt(player.ySub, 0, WORLD_TILES_HIGH * SUBTILE - 1);
  dragTowedCart(state);
}

/**
 * How fast the player walks this tick: four tiles a second, less a quarter while towing.
 *
 * **A DEDUCTION IN SUBTILES-PER-100-TICKS, NEVER A FLOAT MULTIPLIER** — item 023's criterion says
 * so in those words, and `moveAccum` is why it costs nothing to obey: movement already accrues in
 * hundredths of a subtile precisely so a rate that does not divide evenly stays exact, so a tow is
 * one subtraction inside a number that was already integer.
 */
function playerSpeed(state: WorldState): number {
  if (state.player.towedCartId === 0) return PLAYER_SPEED_SUBTILES_PER_100_TICKS;
  const speed = PLAYER_SPEED_SUBTILES_PER_100_TICKS - TOW_SPEED_PENALTY_SUBTILES_PER_100_TICKS;
  // Floored at one subtile per 100 ticks rather than at zero: a penalty that could stop the player
  // dead would be a cart that softlocks the farmer in a field, and plan §4's anti-softlock posture
  // does not have exceptions for balance numbers somebody might retune later.
  return speed < 1 ? 1 : speed;
}

/**
 * The towed cart follows the player's tile, every tick, with no collision check.
 *
 * **NO FOOTPRINT TEST, AND THAT IS DELIBERATE.** A cart in tow is in the player's hands rather
 * than standing on the ground, and the farmer already walks over belts, pipes and machines alike
 * — a cart that refused to cross a belt would be the first collision geometry in the game, added
 * to stop a player dragging a barrow across their own yard. It lands for real on `UnhitchCart`,
 * where it simply stands where the player was.
 *
 * Clamped to the world, because a cart is a machine and a machine off the map is a machine
 * `machineAt` can never find again.
 */
function dragTowedCart(state: WorldState): void {
  const id = state.player.towedCartId;
  if (id === 0) return;
  const cart = machineById(state, id);
  if (cart === null) {
    // The cart stopped existing — boxed, scrapped, or never there. Let go rather than carry a
    // reference to nothing.
    state.player.towedCartId = 0;
    return;
  }
  cart.tileX = clampInt(divFloor(state.player.xSub, SUBTILE), 0, WORLD_TILES_WIDE - 1);
  cart.tileY = clampInt(divFloor(state.player.ySub, SUBTILE), 0, WORLD_TILES_HIGH - 1);
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
  // STRAIGHT AT IT, THROUGH ANYTHING IN THE WAY, AND THROUGH THE ONE MOVER IN THE SIMULATION.
  // This walk used to be written out here, and it was the only walk there was; item 038 needed
  // bots to move and item 039 requires its drones to reuse the bots' movement code *verbatim*, so
  // the arithmetic moved to `movement.ts` and this call is what is left. Nothing about it changed
  // in the move — the same operations in the same order, so a replay of a pre-bot world walks the
  // farmer over exactly the same subtiles — and there is now no second implementation to drift.
  //
  // Obstacle avoidance is still deliberately absent rather than forgotten: nothing in this world
  // is solid enough to walk into, so A* would be pathing around obstacles that do not exist. When
  // something finally blocks a footstep, `stepToward` is the one function that grows a path and
  // every mover in the game gets it at once.
  stepToward(player, target.xSub, target.ySub, playerSpeed(state));
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
    case IntentAction.Harvest:
    case IntentAction.Fertilize:
    case IntentAction.Scythe: {
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

    case IntentAction.RefillCan: {
      // Any tile that touches water is a legal place to click. The WALK aims at the nearest
      // point of the water itself rather than at the clicked tile: an errand arrives "within
      // reach" of its target, and reach-of-a-bank-tile can still be a step short of
      // reach-of-the-water — the farmer would stop, dip at nothing, and shrug. Aiming at the
      // shoreline makes arrival and "can actually dip" the same fact.
      const reservoir = reservoirAdjacentToTile(state, intent.tileX, intent.tileY);
      if (reservoir === null) return null;
      return nearestPointOfReservoir(
        reservoir,
        tileCentreSubtiles(intent.tileX),
        tileCentreSubtiles(intent.tileY),
      );
    }

    case IntentAction.Load:
    case IntentAction.Unload:
    case IntentAction.RefillHopper:
    case IntentAction.Repair:
    case IntentAction.WhackJam:
    case IntentAction.Deconstruct:
    case IntentAction.HitchCart:
    case IntentAction.Sell:
    case IntentAction.Buy: {
      // Resolved from the tile every tick rather than pinned by id at issue time, and that is
      // on purpose: pick-up-and-move is free and always will be (plan §4), so the machine you
      // set off toward may not be there when you arrive. Aim at the FOOTPRINT CENTRE, which is
      // where `withinReachOfMachine` measures from — walking to the corner tile of a 2×2 and
      // finding yourself out of reach would be a maddening near-miss.
      const machine = machineAt(state, intent.tileX, intent.tileY);
      if (machine === null) return null;
      // Both counter verbs want the stand and nothing else. Walking to a Fryer to buy seeds is
      // an errand that was never going to work, so it is refused on issue rather than walked.
      if (intent.action === IntentAction.Sell && machine.kind !== MachineKind.SellBin) return null;
      if (intent.action === IntentAction.Buy && machine.kind !== MachineKind.SellBin) return null;
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
    case IntentAction.RefillCan:
      return { type: 'RefillCan' };
    case IntentAction.Fertilize:
      return { type: 'ApplyFertilizer', tileX: intent.tileX, tileY: intent.tileY };
    case IntentAction.Scythe:
      return { type: 'SwingScythe', tileX: intent.tileX, tileY: intent.tileY };
    case IntentAction.Sell:
      return { type: 'SellItem', item: intent.item as ItemId, count: intent.count };
    // Buy resolves without the machine for the same reason Sell does: `nearSellBin` inside the
    // reducer is the gate, and it measures from the player rather than from the tile clicked.
    case IntentAction.Buy:
      return { type: 'BuyItem', item: intent.item as ItemId, count: intent.count };
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
    case IntentAction.Deconstruct:
      return { type: 'DeconstructMachine', machineId: machine.id };
    case IntentAction.HitchCart:
      return { type: 'HitchCart', cartId: machine.id };
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
    } else if (spec.role === MachineRole.Orchard) {
      advanceOrchard(machine, spec);
    }
  }
}

/**
 * One tick of a fruit tree: §5's *"2×2 trees, permanent, fruit on a cycle"*.
 *
 * **DEMAND-PULL, LIKE EVERYTHING ELSE.** A tree whose buffer is full stops accruing and simply
 * stands there with fruit on it — it does not drop anything on the ground and nothing rots. That
 * is the same one stop rule the Fryer and the Juicer obey, and it means an unpicked orchard is a
 * pause rather than a loss, which is what §7 ruling 6 asks of every clock in this game.
 *
 * **IT IS NOT `advanceConverter` WITH AN EMPTY RECIPE**, and `MachineRole.Orchard` carries the
 * long version of why: a converter advancing work ticks `untouchedTicks`, and the Corporate
 * Charter's entire claim is that a machine cannot advance work for 96,000 straight ticks unless
 * something is *feeding* it. A tree needs nothing feeding it, so a tree on the converter path
 * would hand out that Charter for planting a sapling and running one belt.
 *
 * No wear, no jam, no waste cadence. A tree is not machinery, and §8 forbids landing a
 * maintenance system inside a release that is not about maintenance.
 */
function advanceOrchard(machine: Machine, spec: MachineSpec): void {
  if (spec.outputItem === null || spec.workPerOperation <= 0) return;
  if (machine.outputCount >= effectiveOutputCapacity(spec, machine)) return;

  machine.progress += effectiveWorkRate(spec, machine);
  if (machine.progress < spec.workPerOperation) return;

  machine.progress -= spec.workPerOperation;
  machine.outputCount += 1;
  machine.opCount += 1;
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
      if ((candidate.inputCounts[0] ?? 0) <= 0) return false;
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
  if (spec === null) return;
  if (machine.jammed || machine.condition <= 0) return;

  if (!outputHasRoom(spec, machine)) {
    // Stopped by demand-pull, with a full basket. This is the only clock overcooking has.
    advanceOvercooking(machine, spec);
    return;
  }
  machine.blockedTicks = 0;

  if (!recipeSatisfied(spec, machine)) return;

  // THE UNTOUCHED-WORK CLOCK, AND THIS LINE IS THE WHOLE DEFINITION OF "A LINE RUNNING ITSELF".
  // It ticks here — past demand-pull, past the recipe check, on a tick this machine genuinely
  // moved an operation forward — and nowhere else, so a machine standing idle with nothing to
  // eat earns the Corporate Charter nothing. Every hand-verb that reaches a machine calls
  // `handsOn` and puts it back to zero. The high-water mark is what the milestone reads; see
  // `WorldStats.longestUntouchedMachineTicks` for why it is a mark rather than a live maximum.
  machine.untouchedTicks += 1;
  if (machine.untouchedTicks > state.stats.longestUntouchedMachineTicks) {
    state.stats.longestUntouchedMachineTicks = machine.untouchedTicks;
  }

  machine.progress += effectiveWorkRate(spec, machine);
  if (machine.progress < spec.workPerOperation) return;

  machine.progress -= spec.workPerOperation;
  consumeRecipe(spec, machine);
  machine.opCount += 1;

  // THE OPERATION HAPPENED EITHER WAY. A worn machine still turns, still swallows the input,
  // and still wears — it just does not always produce anything. Waste is a cadence read off
  // `opCount`, never a roll (see `WASTE_PERIOD_AT_THRESHOLD`), and the Efficiency dial buys a
  // longer cadence rather than a lower chance, because there is no chance in it to lower.
  const wastePeriod = effectiveWastePeriod(spec, machine);
  if (wastePeriod > 0 && machine.opCount % wastePeriod === 0) {
    state.stats.inputsWastedByMachine += 1;
  } else {
    produceRecipe(spec, machine);
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
 * Demand-pull, asked of whichever side this machine's output comes out of.
 *
 * ONE RULE, TWO OUTLETS. Plan §7 ruling 6 is that a machine with nowhere to put its output stops
 * dead rather than consuming an input — and a Juicer whose juice has nowhere to go is in exactly
 * the same situation as a Fryer with a full basket. Writing it once is what makes "an idle
 * Carbonator is a ratio lesson" true of the soda line as well as the chip line.
 */
function outputHasRoom(spec: MachineSpec, machine: Machine): boolean {
  if (spec.outputItem !== null && machine.outputCount >= effectiveOutputCapacity(spec, machine)) {
    return false;
  }
  for (let i = 0; i < spec.ports.length; i++) {
    const port = spec.ports[i]!;
    if (port.flow !== PortFlow.Outlet) continue;
    const held = machine.ports[i];
    if (held === undefined) return false;
    // Room for a WHOLE operation, not a drop: a half-poured litre is the fractional state this
    // whole model is arranged to never have.
    if (held.ml + port.mlPerOperation > effectivePortCapacityMl(port, machine)) return false;
  }
  return true;
}

/** Every line of the recipe, solid and liquid, present in full. Checked before anything moves. */
function recipeSatisfied(spec: MachineSpec, machine: Machine): boolean {
  for (let i = 0; i < spec.inputs.length; i++) {
    const line = spec.inputs[i]!;
    if ((machine.inputCounts[i] ?? 0) < line.count) return false;
  }
  for (let i = 0; i < spec.ports.length; i++) {
    const port = spec.ports[i]!;
    if (port.flow !== PortFlow.Intake) continue;
    const held = machine.ports[i];
    if (held === undefined || held.ml < port.mlPerOperation) return false;
  }
  return true;
}

/**
 * Take every input at once.
 *
 * ATOMIC, AND THE CALLER HAS ALREADY CHECKED. There is no state in which a Bottler has swallowed
 * the bottle and is waiting for the syrup — a half-consumed recipe would be a machine the player
 * cannot reason about and a save that cannot be described.
 */
function consumeRecipe(spec: MachineSpec, machine: Machine): void {
  for (let i = 0; i < spec.inputs.length; i++) {
    machine.inputCounts[i] = (machine.inputCounts[i] ?? 0) - spec.inputs[i]!.count;
  }
  for (let i = 0; i < spec.ports.length; i++) {
    const port = spec.ports[i]!;
    if (port.flow !== PortFlow.Intake) continue;
    const held = machine.ports[i];
    if (held !== undefined) held.ml -= port.mlPerOperation;
  }
}

/** And put the output where it goes: the item buffer, an outlet port, or both if it ever wants. */
function produceRecipe(spec: MachineSpec, machine: Machine): void {
  if (spec.outputItem !== null) machine.outputCount += 1;
  for (let i = 0; i < spec.ports.length; i++) {
    const port = spec.ports[i]!;
    if (port.flow !== PortFlow.Outlet) continue;
    const held = machine.ports[i];
    if (held !== undefined) held.ml += port.mlPerOperation;
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
      // THIRST × SOIL, THROUGH AN ACCUMULATOR. The crop says how much it drinks (a Gold Potato
      // drinks three times a Russet) and the ground says how well it holds water (clay at 700‰,
      // sand at 1500‰). Multiplied and floored directly, clay under a Russet would drain
      // `divFloor(1 × 700, 1000)` = zero, forever — so the product accrues in thousandths and
      // whole units are spent, the same integer accumulator the player's legs and the pond's
      // recharge already use.
      const base = spec === null ? MOISTURE_DRAIN_PER_TICK : spec.moistureDrainPerTick;
      const soil = soilSpec(tile.soil);
      tile.moistureAccum += base * (soil === null ? 1000 : soil.moistureDrainPermille);
      const drain = divFloor(tile.moistureAccum, 1000);
      if (drain > 0) {
        tile.moistureAccum -= drain * 1000;
        tile.moisture = Math.max(0, tile.moisture - drain);
      }
    } else {
      // Dry ground banks nothing. Without this a tile that sat empty for an hour would drain its
      // first whole unit the instant it was watered, which is a bucket of water evaporating on
      // contact and a number the player cannot see the cause of.
      tile.moistureAccum = 0;
    }
  }
}

// --- 10. spoilage -----------------------------------------------------------------

/**
 * Turn every stack whose deadline has come into Compost.
 *
 * **NOTHING VANISHES** (§4, and item 021's standing constraint): every spoilage path in this game
 * ends in a good, so a turned stack is not deleted — it is `COMPOST_PER_SPOILED_ITEM` of Compost
 * per unit, which the Composter turns into Fertilizer, which goes back in the ground. That is
 * plan §4's loop closing, and it is the reason there is no zero-value outcome anywhere in this
 * feature.
 *
 * **NO ROLL ANYWHERE IN IT.** A stack turns when `state.tick` reaches an integer that was written
 * when the goods entered the bag. Same seed and same commands, same potatoes turn on the same
 * ticks, forever (§7 ruling 5).
 *
 * The scan is cheap and bounded: the inventory is a few dozen slots and each holds at most
 * `FRESHNESS_MAX_STACKS` stacks, sorted — so on almost every tick this reads one integer per
 * perishable slot and stops.
 *
 * The compost is added AFTER the sweep rather than inside it, because `addItem` walks the same
 * inventory this loop is iterating and inserting a slot mid-scan is how an off-by-one gets into a
 * hashed collection. It also cannot cascade: Compost does not perish, so nothing added here can
 * be swept by the same pass.
 */
function advanceSpoilage(state: WorldState): void {
  let composted = 0;

  for (let i = 0; i < state.inventory.length; i++) {
    const slot = state.inventory[i]!;
    if (slot.stacks.length === 0) continue;

    let spoiled = 0;
    while (slot.stacks.length > 0 && slot.stacks[0]!.spoilAtTick <= state.tick) {
      spoiled += slot.stacks[0]!.count;
      slot.stacks.shift();
    }
    if (spoiled <= 0) continue;

    slot.count -= spoiled;
    composted += spoiled * COMPOST_PER_SPOILED_ITEM;
  }

  // Drop any slot the sweep emptied. Backwards, so the splices cannot skip an entry.
  for (let i = state.inventory.length - 1; i >= 0; i--) {
    if (state.inventory[i]!.count <= 0) state.inventory.splice(i, 1);
  }

  if (composted > 0) addItem(state, ItemId.Compost, composted);
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

  // The hour ledger and the dawn snapshot (item 062). After the transactions of this tick and
  // before the clock increments, so a boundary tick's money lands in the hour that owned it.
  advanceStatsClock(stats, state.tick);
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
