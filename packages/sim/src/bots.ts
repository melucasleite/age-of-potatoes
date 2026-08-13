// Agri-Bots. Plan §3's automated rung of the harvesting ladder, and the first thing in this game
// that moves without the player.
//
// ────────────────────────────────────────────────────────────────────────────────────────
// **THE MOVEMENT IS NOT IN THIS FILE, AND THAT IS THE POINT OF THE FILE.**
//
// Item 039 requires its repair drones to reuse the Agri-Bot movement code *verbatim*, which is a
// promise you can only keep about code that lives in one place. So there is exactly ONE mover in
// this simulation — `stepToward` in `movement.ts` — and it is the player's own errand walk,
// generalised rather than copied. The farmer, Spudnik and every drone to come all accrue speed
// into a hundredths accumulator, spend whole subtiles, aim straight, clamp to the world and face
// the dominant axis, through the same twenty lines. See that file's header for the argument.
//
// What is in here is everything ABOVE the walk: what a bot wants, how it chooses, and what it
// does when it arrives.
// ────────────────────────────────────────────────────────────────────────────────────────
//
// **THE ROUTE IS DUMB ON PURPOSE** (item 038's constraint, stated as four separate prohibitions).
// A bot scans its zone's tiles in field-index order from a cursor stored in `WorldState`, takes
// the first one that wants work, and walks at it in a straight line. No A*, no float distances,
// no `Math.sqrt` heuristics, no dynamic avoidance, and a tile it cannot service is skipped rather
// than queued. Nothing in this world is solid enough to walk into, so a path around an obstacle
// would be a path around nothing — and pathing is where determinism usually dies.
//
// **THE CURSOR IS WORLD STATE RATHER THAN A MODULE VARIABLE**, for the reason the Irrigation
// Hub's scan cursor is: module state is invisible to the hash and to saves, so a cursor kept
// there would make two identically-saved worlds harvest different tiles after a reload — the
// exact class of bug the golden fixtures exist to catch.
//
// **UPKEEP IS PER COMPLETED OPERATION AND NEVER PER TICK** — plan §4 names this case by name:
// *"Agri-Bot upkeep is per-harvest-op, not weekly."* That is an instruction against the obvious
// design, because time-based upkeep would punish a player for leaving the tab open, which
// contradicts §6's clock outright. A docked idle bot wears exactly nothing, forever, and
// `test/bots.test.ts` pins that over 10,000 ticks.

import {
  BOT_CARRY_CAPACITY,
  BOT_SPEED_SUBTILES_PER_100_TICKS,
  BOT_WEAR_PER_OPERATION,
  BOT_WORK_TICKS,
  CONDITION_MAX,
  CropId,
  type ItemId,
  MachineKind,
  MachineRole,
  cropSpec,
  machineSpec,
} from './data';
import { resetMomentum, stepToward } from './movement';
import {
  type Bot,
  type CropTile,
  type Machine,
  type WorldState,
  BotKind,
  BotPhase,
  CeremonyId,
  fieldTileX,
  fieldTileY,
  isTileReady,
  machineById,
  markCeremony,
  plantCrop,
  takeHarvest,
} from './state';
import { effectiveOutputCapacity } from './upgrades';
import { clampInt, tileCentreSubtiles } from './units';

/** True for the two dock kinds. A dock is where a bot sleeps and what it fills. */
export function isBotDock(machine: Machine): boolean {
  const spec = machineSpec(machine.kind);
  return spec !== null && spec.role === MachineRole.BotDock;
}

/** How many seeds a planter dock's hopper is holding. Belt-fed or hand-fed; it cannot tell. */
export function dockSeedCount(dock: Machine): number {
  return dock.cargoItem === 0 ? 0 : dock.cargoCount;
}

/**
 * Take one item into a planter dock's seed hopper. **The one door seeds enter by.**
 *
 * Returns false when the hopper is full or already holds a different seed, which is what makes a
 * grabber aimed at a dock stall holding its item — the same "look downstream" stall a full Fryer
 * hopper gives, and the same shape as `depotAccept`. One seed type at a time, because a dock
 * serves one zone and a zone grows one crop.
 *
 * **IT COUNTS NO TOUCH, AND THE HANDS-FREE BOARD RESTS ON THAT.** §6's taxonomy makes
 * *"hand-refilling any hopper (seeds, kits, consumables)"* a disqualifier, so a belt-fed hopper
 * has to be free and a hand-filled one has to cost — which means the two paths must be different
 * functions. This is the belt's. The hand's is `RefillHopper` in `tick.ts`, and it is the one
 * that calls `touch('hopperRefill')`.
 */
export function dockAcceptSeed(state: WorldState, dock: Machine, item: number): boolean {
  const spec = machineSpec(dock.kind);
  if (spec === null || spec.role !== MachineRole.BotDock) return false;
  if (dock.kind !== MachineKind.PlanterDock) return false;
  if (!dockSeedIsWanted(state, dock, item)) return false;
  if (dock.cargoItem !== 0 && dock.cargoItem !== item) return false;
  if (dock.cargoCount >= spec.inputCapacity) return false;

  dock.cargoItem = item as ItemId;
  dock.cargoCount += 1;
  return true;
}

/**
 * The seed this dock's zone actually wants, or 0 when it wants nothing.
 *
 * Refusing the wrong seed is what stops a mixed belt silently filling the hopper with cane seed
 * for a potato zone and leaving the bot standing there. A dock with no zone or no assigned crop
 * wants nothing at all — it has no instructions, so it takes no deliveries by belt and none by
 * hand either.
 */
export function dockWantedSeed(state: WorldState, dock: Machine): ItemId | 0 {
  const crop = dockCrop(state, dock);
  return crop === null ? 0 : crop.seedItem;
}

function dockSeedIsWanted(state: WorldState, dock: Machine, item: number): boolean {
  const wanted = dockWantedSeed(state, dock);
  return wanted !== 0 && wanted === item;
}

/** The crop spec a dock's bound zone is assigned, or null when it has no instructions. */
function dockCrop(state: WorldState, dock: Machine): ReturnType<typeof cropSpec> {
  if (dock.boundZone === 0) return null;
  for (let i = 0; i < state.zones.length; i++) {
    const zone = state.zones[i]!;
    if (zone.id !== dock.boundZone) continue;
    if (zone.crop === CropId.None) return null;
    return cropSpec(zone.crop);
  }
  return null;
}

// --- the tick ---------------------------------------------------------------------

/**
 * Every bot, in ascending id order — `state.bots` is kept sorted, so the loop is that order by
 * construction, exactly as `advanceMachines` relies on for machines.
 */
export function advanceBots(state: WorldState): void {
  for (let i = 0; i < state.bots.length; i++) {
    const bot = state.bots[i]!;
    const dock = machineById(state, bot.dockId);
    // A bot whose dock is gone should not exist — `removeBotsForDock` deletes them with it — so
    // this is a guard rather than a case. It parks rather than throwing, because a tick that can
    // throw is a tick that can end a session over a bookkeeping slip.
    if (dock === null) continue;

    // Worn out. It stands where it is, holding what it has, and costs nothing — plan §4's rule
    // for a machine at zero condition is that it "costs nothing, keeps its buffers, and never
    // explodes", and a robot is not an exception to it. Hand repair at the dock brings it back.
    if (bot.condition <= 0) {
      resetMomentum(bot);
      continue;
    }

    if (bot.kind === BotKind.Harvester) advanceHarvester(state, bot, dock);
    else advancePlanter(state, bot, dock);
  }
}

function advanceHarvester(state: WorldState, bot: Bot, dock: Machine): void {
  switch (bot.phase) {
    case BotPhase.Idle: {
      // Full, or holding something after the zone went quiet: take it home.
      if (bot.carryCount >= BOT_CARRY_CAPACITY) {
        bot.phase = BotPhase.Returning;
        return;
      }
      const target = nextReadyTile(state, bot, dock);
      if (target < 0) {
        // Nothing ripe. Walk home if there is anything to drop off or anywhere to be, and
        // otherwise stand still — an idle bot burns no condition and no cursor.
        if (bot.carryCount > 0 || !atDock(bot, dock)) bot.phase = BotPhase.Returning;
        else resetMomentum(bot);
        return;
      }
      bot.targetTile = target;
      bot.phase = BotPhase.Outbound;
      return;
    }

    case BotPhase.Outbound: {
      const tile = state.field[bot.targetTile];
      // The errand went stale — the player pulled the tile first, which they are always allowed
      // to do (§1: manual never rots). Pick again rather than walking to bare dirt.
      if (tile === undefined || !isTileReady(tile)) {
        bot.phase = BotPhase.Idle;
        bot.targetTile = -1;
        return;
      }
      if (walkToTile(bot, bot.targetTile)) {
        bot.phase = BotPhase.Working;
        bot.workTicks = BOT_WORK_TICKS;
      }
      return;
    }

    case BotPhase.Working: {
      if (bot.workTicks > 0) {
        bot.workTicks -= 1;
        return;
      }
      harvestUnderBot(state, bot);
      bot.targetTile = -1;
      bot.phase = bot.carryCount >= BOT_CARRY_CAPACITY ? BotPhase.Returning : BotPhase.Idle;
      return;
    }

    case BotPhase.Returning:
    default: {
      if (!walkToMachine(bot, dock)) return;
      if (bot.carryCount <= 0) {
        bot.phase = BotPhase.Idle;
        return;
      }
      if (bot.workTicks > 0) {
        bot.workTicks -= 1;
        return;
      }
      unloadIntoDock(bot, dock);
      return;
    }
  }
}

function advancePlanter(state: WorldState, bot: Bot, dock: Machine): void {
  switch (bot.phase) {
    case BotPhase.Idle: {
      const target = nextPlantableTile(state, bot, dock);
      if (target < 0) {
        if (!atDock(bot, dock)) bot.phase = BotPhase.Returning;
        else resetMomentum(bot);
        return;
      }
      bot.targetTile = target;
      bot.phase = BotPhase.Outbound;
      return;
    }

    case BotPhase.Outbound: {
      const tile = state.field[bot.targetTile];
      if (tile === undefined || tile.crop !== CropId.None || dockSeedCount(dock) <= 0) {
        bot.phase = BotPhase.Idle;
        bot.targetTile = -1;
        return;
      }
      if (walkToTile(bot, bot.targetTile)) {
        bot.phase = BotPhase.Working;
        bot.workTicks = BOT_WORK_TICKS;
      }
      return;
    }

    case BotPhase.Working: {
      if (bot.workTicks > 0) {
        bot.workTicks -= 1;
        return;
      }
      plantUnderBot(state, bot, dock);
      bot.targetTile = -1;
      bot.phase = BotPhase.Idle;
      return;
    }

    case BotPhase.Returning:
    default: {
      if (walkToMachine(bot, dock)) bot.phase = BotPhase.Idle;
      return;
    }
  }
}

// --- what a bot does when it gets there --------------------------------------------

/**
 * Pull the tile the bot is standing on into its arms.
 *
 * **NO MANUAL TOUCH AND NO `itemsHarvestedByHand`.** That is the whole feature: plan §6's
 * Hands-Free board exists to reward exactly this, so counting a robot's harvest would make the
 * automation the player bought score as though they had bent down themselves. It goes through
 * `takeHarvest`, which is the same function the player's own pull uses, so the yield, the
 * regrowth rule and the fertility cost are identical — what differs is only where the goods land
 * and what gets counted, which is a two-line difference in plain sight.
 *
 * ONE PRODUCT AT A TIME, like a cart: a bot holding potatoes that reaches a ripe chili takes the
 * chili home first. That is a zone-assignment problem, not a bot problem, and the zone already
 * has one crop.
 */
function harvestUnderBot(state: WorldState, bot: Bot): void {
  const tile = state.field[bot.targetTile];
  if (tile === undefined) return;
  const spec = tile.crop === CropId.None ? null : cropSpec(tile.crop);
  if (spec === null) return;

  const result = takeHarvest(state, tile, spec);
  if (result === null) return;

  if (bot.carryItem !== 0 && bot.carryItem !== result.item) {
    // Two products, one pair of arms. Everything it is already holding goes home first; this
    // tile has been pulled and its goods would otherwise vanish, so they are what it carries and
    // the rest is impossible by construction — a bot only ever holds one product at a time.
    bot.phase = BotPhase.Returning;
  }
  if (bot.carryItem === 0 || bot.carryItem !== result.item) {
    bot.carryItem = result.item;
    bot.carryCount = 0;
  }
  bot.carryCount += result.count;

  wearBot(bot);
  // Plan §3's Hall of Hands. Marked on the completed harvest rather than on the dock being
  // placed: the moment worth ten seconds of theatre is a crop leaving the ground without a hand
  // on it, which is a thing that has never happened in this game before.
  markCeremony(state, CeremonyId.FirstBot);
}

/** Sow the tile the bot is standing on from the dock's hopper. */
function plantUnderBot(state: WorldState, bot: Bot, dock: Machine): void {
  const tile = state.field[bot.targetTile];
  if (tile === undefined || tile.crop !== CropId.None) return;
  const spec = dockCrop(state, dock);
  if (spec === null) return;
  if (dock.cargoItem !== spec.seedItem || dock.cargoCount <= 0) return;

  dock.cargoCount -= 1;
  if (dock.cargoCount === 0) dock.cargoItem = 0;
  plantCrop(state, tile, spec);
  wearBot(bot);
  markCeremony(state, CeremonyId.FirstBot);
}

/**
 * Put what the bot is carrying on the dock's floor, where a belt or a grabber can take it.
 *
 * A FULL DOCK IS A STALL, NOT A LOSS. The bot stands there holding its armful — the same "look
 * downstream" stall a blocked grabber gives — rather than dropping goods on the ground or
 * quietly deleting them. Nothing vanishes (plan §4), and the diagnostic is a robot standing at a
 * full shed, which is a thing the player can see from ten tiles up.
 */
function unloadIntoDock(bot: Bot, dock: Machine): void {
  const spec = machineSpec(dock.kind);
  if (spec === null) return;
  const room = effectiveOutputCapacity(spec, dock) - dock.outputCount;
  if (room <= 0) return;

  const moved = bot.carryCount < room ? bot.carryCount : room;
  dock.outputCount += moved;
  bot.carryCount -= moved;
  if (bot.carryCount <= 0) {
    bot.carryItem = 0;
    bot.phase = BotPhase.Idle;
  }
}

/** Condition, per completed operation and never per tick. See the header. */
function wearBot(bot: Bot): void {
  bot.opCount += 1;
  bot.condition = clampInt(bot.condition - BOT_WEAR_PER_OPERATION, 0, CONDITION_MAX);
}

// --- choosing a tile ---------------------------------------------------------------

/**
 * The next tile in this bot's zone that wants pulling, or -1.
 *
 * Scans the whole field ONCE from the stored cursor, wrapping, so the cost is bounded by the
 * field rather than by how far the bot has walked, and so two bots on two zones never trip over
 * each other's order. The cursor lands one past whatever was chosen, which is what makes a bot
 * work its way along a row instead of returning to the same corner every time.
 */
function nextReadyTile(state: WorldState, bot: Bot, dock: Machine): number {
  return scanZone(state, bot, dock, (tile) => isTileReady(tile));
}

/** The next empty tile in this bot's zone, or -1 — and only while the hopper has a seed in it. */
function nextPlantableTile(state: WorldState, bot: Bot, dock: Machine): number {
  const spec = dockCrop(state, dock);
  if (spec === null) return -1;
  if (dock.cargoItem !== spec.seedItem || dock.cargoCount <= 0) return -1;
  return scanZone(state, bot, dock, (tile) => tile.crop === CropId.None);
}

function scanZone(
  state: WorldState,
  bot: Bot,
  dock: Machine,
  wants: (tile: CropTile) => boolean,
): number {
  if (dock.boundZone === 0) return -1;
  const count = state.field.length;
  if (count <= 0) return -1;

  const start = bot.routeCursor % count;
  for (let step = 0; step < count; step++) {
    const index = (start + step) % count;
    const tile = state.field[index]!;
    if (tile.zone !== dock.boundZone) continue;
    if (!wants(tile)) continue;
    bot.routeCursor = (index + 1) % count;
    return index;
  }
  return -1;
}

// --- walking ------------------------------------------------------------------------
//
// Both of these are one line of intent over `stepToward`. They exist so that "where is the middle
// of a tile" and "where is the middle of a dock" are answered in one place each rather than at
// four call sites, and so a drone reusing this file gets the same answers.

function walkToTile(bot: Bot, index: number): boolean {
  return stepToward(
    bot,
    tileCentreSubtiles(fieldTileX(index)),
    tileCentreSubtiles(fieldTileY(index)),
    BOT_SPEED_SUBTILES_PER_100_TICKS,
  );
}

function walkToMachine(bot: Bot, machine: Machine): boolean {
  if (atDock(bot, machine)) return true;
  return stepToward(
    bot,
    tileCentreSubtiles(machine.tileX),
    tileCentreSubtiles(machine.tileY),
    BOT_SPEED_SUBTILES_PER_100_TICKS,
  );
}

function atDock(bot: Bot, dock: Machine): boolean {
  return bot.xSub === tileCentreSubtiles(dock.tileX) && bot.ySub === tileCentreSubtiles(dock.tileY);
}
