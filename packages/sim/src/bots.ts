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
  BOT_SEED_POCKET_CAPACITY,
  BOT_SPEED_SUBTILES_PER_100_TICKS,
  HARVESTER_SEED_SHELF_CAPACITY,
  BOT_WEAR_PER_OPERATION,
  BOT_WORK_TICKS,
  CONDITION_EFFECT_THRESHOLD,
  CONDITION_MAX,
  CropId,
  ItemId,
  MachineKind,
  MachineRole,
  cropSpec,
  machineSpec,
} from './data';
import { StepOutcome, resetMomentum, stepToward } from './movement';
import {
  type Bot,
  type CropTile,
  type Machine,
  type WorldState,
  BotKind,
  BotPhase,
  CeremonyId,
  harvestItemFor,
  isTileReady,
  machineAt,
  machineById,
  markCeremony,
  plantCrop,
  takeHarvest,
  tileByKey,
  worldKeyTileX,
  worldKeyTileY,
  worldTileKey,
} from './state';
import { effectiveOutputCapacity } from './upgrades';
import { clampInt, tileCentreSubtiles } from './units';
import { waterAtSubtile } from './water';

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
  if (!dockCanAcceptSeed(state, dock, item)) return false;

  dock.cargoItem = item as ItemId;
  dock.cargoCount += 1;
  return true;
}

/**
 * **THE PLANTER HOPPER'S ACCEPT-DOOR PREDICATE** (item 085): every reason a seed bounces off a
 * planter dock, in one place, asked without touching anything.
 *
 * `dockAcceptSeed` above is now this plus two assignments, which is the point: an arm's
 * look-ahead and the delivery it commits to a tick later read the *same* four refusals. A
 * second copy would drift — and the symptom would be an arm that picks up a cane seed for a
 * potato zone, exactly the mistake item 085 exists to stop.
 */
export function dockCanAcceptSeed(state: WorldState, dock: Machine, item: number): boolean {
  const spec = machineSpec(dock.kind);
  if (spec === null || spec.role !== MachineRole.BotDock) return false;
  if (dock.kind !== MachineKind.PlanterDock) return false;
  if (!dockSeedIsWanted(state, dock, item)) return false;
  if (dock.cargoItem !== 0 && dock.cargoItem !== item) return false;
  if (dock.cargoCount >= spec.inputCapacity) return false;
  return true;
}

/**
 * The one belt door into ANY dock's hopper — the branch `belts.ts` calls.
 *
 * **THERE IS EXACTLY ONE HOPPER BEHIND THIS NAME NOW** (item 090). A planter's wants its zone's
 * seed; a harvester dock and a Drone Bay want nothing at all, and the bay's "nothing" is new:
 * repair drones fix machines for free, so the parts door it used to keep is gone in both its
 * spellings rather than left as a peek at a door nobody can walk through. What refuses a bay is
 * `dockCanAcceptSeed`'s `PlanterDock` line — one rule, in the place the other refusals live,
 * which is why closing the door took a deletion rather than a new check.
 *
 * The pair survives the deletion because the pair is not about the bay: `belts.ts` asks one
 * question about docks (*they have a door*) and this is where the answer lives. Counts NO
 * touch, like `dockAcceptSeed` — the belt path is the free one, and that split is what keeps
 * the Hands-Free board honest.
 */
export function dockAcceptDelivery(state: WorldState, dock: Machine, item: number): boolean {
  return dockAcceptSeed(state, dock, item);
}

/**
 * The same door, asked rather than walked through (item 085's look-ahead).
 *
 * NOT ONE REFUSAL RULE IS WRITTEN TWICE: both halves bottom out in `dockCanAcceptSeed`, so an
 * arm's peek a swing early and the delivery it commits to a tick later cannot disagree.
 * `bots.test.ts` pins the pair against each other over every dock kind — including the bay,
 * which must now refuse everything through both spellings.
 */
export function dockCanAcceptDelivery(state: WorldState, dock: Machine, item: number): boolean {
  return dockCanAcceptSeed(state, dock, item);
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
    else if (bot.kind === BotKind.Repair) advanceRepairDrone(state, bot, dock);
    else advancePlanter(state, bot, dock);
  }
}

// --- the repair drone (item 039) ----------------------------------------------------
//
// The same four-phase errand the farm bots run, aimed at machines instead of tiles: pick the
// next wrench-due machine from a wrapping cursor, fly straight at it through `stepToward`,
// service it, fly home. **NO RADIUS** — the drone serves the whole lot, which is what a
// capstone that outranks the 7×7 station is for.
//
// **AND "WRENCH-DUE" NOW MEANS WHAT IT MEANS EVERYWHERE ELSE.** It used to mean it only here,
// and the difference cost the player a visible bug: see `machineWantsService` below for the
// dock that could never look ill and the drone that therefore never came.
//
// **THE SERVICE IS FREE, AND ITEM 090 REPEALED THE RULE THAT SAID OTHERWISE.** Item 039 built
// this drone to burn one manufactured part per fix and wrote "no parts, no service, no
// exceptions" into the dispatch gate, the service, a hopper, a lamp and a whole Parts Bench
// behind it. The owner's ruling is one sentence: *"The drone bay shouldn't require parts. It
// should just fix stuff."* So the price of automated maintenance is now entirely CAPITAL — the
// $5,000 tech node and the $2,000 hangar — and nothing at all after that. A bay is a bay; there
// is no supply line to starve, no hopper to fill, and no state in which a drone declines.
//
// What that costs, stated plainly rather than buried: §4's "automation saves your hands, not
// the bill" no longer holds at the top of the maintenance ladder. It still holds at the rung
// below — the Maintenance Station spends real $8 kits off a real belt and starves honestly —
// which is now the ladder's whole argument, and the capstone is the reward for finishing it.
//
// **A DRONE'S SERVICE IS NOT A HAND.** It calls no `touch`: the Hands-Free board keeps
// running while an automated line is automatically maintained. (It used to also spare the
// serviced machine's untouched-work clock, until item 147 cut that clock with its Charter.)

/**
 * **DOES THIS MACHINE WANT SERVICE? ONE ANSWER, FOR EVERY THING THAT SERVICES** — the hand's
 * kit, the Maintenance Station, and the repair drone.
 *
 * IT EXISTS BECAUSE THE THREE SPELLINGS DRIFTED, and a player found the gap. The drone's own
 * test used to be `jammed || condition < threshold` and nothing else, which sounds complete
 * and is not: **a bot dock's `wearPerOperation` is 0**, so a dock's own condition never falls
 * and it can never jam — by that test a shed full of worn robots is a machine in perfect
 * health, and the drone flew past it forever. The owner's report was exactly that: *"The drone
 * is not repairing the docks."*
 *
 * The kit and the station both already knew better, because a dock's health is not in the shed,
 * it is in the ROBOTS ASLEEP IN IT — so both carried the third clause and the drone did not.
 * Three copies of one rule is two chances to be wrong, and this is the maintenance twin of the
 * discipline item 085 imposed on the accept-doors: the peek and the deed read one predicate,
 * and so do the three things that hold a wrench.
 *
 * The threshold is the wrench overlay's, deliberately: this answers *"would a player walk over
 * here"*, which is a different and stricter question from *"is there a point in the top-up now
 * that somebody has"* — that second one is `CONDITION_MAX` and belongs at the service itself.
 */
export function machineWantsService(state: WorldState, machine: Machine): boolean {
  if (machine.jammed || machine.condition < CONDITION_EFFECT_THRESHOLD) return true;
  return dockBotWrenchDue(state, machine);
}

/**
 * Whether a bot asleep in this machine is below the wrench threshold — 0 for everything that
 * is not a dock, since nothing else has bots in it.
 *
 * This is the clause a dock's condition CANNOT express. `wearBot` wears the robot, not the
 * shed, so `dock.condition` stays at `CONDITION_MAX` for the whole life of a world while the
 * harvester living in it grinds down to nothing.
 */
export function dockBotWrenchDue(state: WorldState, dock: Machine): boolean {
  for (let i = 0; i < state.bots.length; i++) {
    const bot = state.bots[i]!;
    if (bot.dockId === dock.id && bot.condition < CONDITION_EFFECT_THRESHOLD) return true;
  }
  return false;
}

function advanceRepairDrone(state: WorldState, bot: Bot, bay: Machine): void {
  switch (bot.phase) {
    case BotPhase.Idle: {
      // NO HOPPER GATE (item 090). There used to be one here, refusing to pick a target the
      // bay could not pay for; a free service has nothing to pay, so the only reason a drone
      // stays home is that nothing on the lot wants a wrench.
      const target = nextServiceTarget(state, bot);
      if (target <= 0) {
        if (!atDock(bot, bay)) bot.phase = BotPhase.Returning;
        else resetMomentum(bot);
        return;
      }
      // `targetTile` holds a MACHINE ID for this kind — see `BotKind.Repair`.
      bot.targetTile = target;
      bot.phase = BotPhase.Outbound;
      // Plan §3's Hall of Hands, on the tick the first drone rises out of its bay — departure,
      // like the truck's horn, because that is the moment on screen (item 039 instruction 10).
      markCeremony(state, CeremonyId.FirstDrone);
      return;
    }

    case BotPhase.Outbound: {
      const machine = machineById(state, bot.targetTile);
      // Stale errand: the player got there first with a free hand, which they are always
      // allowed to do (§1). Pick again rather than flying to a healthy machine.
      if (machine === null || !machineWantsService(state, machine)) {
        bot.phase = BotPhase.Idle;
        bot.targetTile = -1;
        return;
      }
      // No water predicate: the drone flies, and the pond is not an obstacle to the air.
      if (walkToMachine(bot, machine) === StepOutcome.Arrived) {
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
      serviceUnderDrone(state, bot);
      bot.targetTile = -1;
      bot.phase = BotPhase.Returning;
      return;
    }

    case BotPhase.Returning:
    default: {
      if (walkToMachine(bot, bay) === StepOutcome.Arrived) bot.phase = BotPhase.Idle;
      return;
    }
  }
}

/**
 * The next machine on the lot that wants a wrench, scanning `state.machines` once from the
 * bot's wrapping cursor — the same dumb-on-purpose route discipline the zone scan uses, over
 * machines instead of tiles. The cursor lands one past the choice, so two worn machines are
 * served alternately rather than the lower id starving the other.
 */
function nextServiceTarget(state: WorldState, bot: Bot): number {
  const count = state.machines.length;
  if (count <= 0) return 0;

  const start = bot.routeCursor % count;
  for (let step = 0; step < count; step++) {
    const index = (start + step) % count;
    const machine = state.machines[index]!;
    if (!machineWantsService(state, machine)) continue;
    bot.routeCursor = (index + 1) % count;
    return machine.id;
  }
  return 0;
}

/**
 * One service: a full restore and an un-jam, for nothing (item 090).
 *
 * **IT DOES NOT TAKE THE BAY**, and the missing parameter is the feature. This used to decrement
 * a part off the bay's shelf and needed the bay to do it; a service that spends nothing needs
 * to know nothing about where the drone sleeps, so the argument went with the cost. A future
 * reader looking for the consumable will not find a hopper here to wonder about.
 *
 * **AND IT BOOKS NO SPEND.** `state.stats.repairKitSpendCents += DRONE_PART_PRICE_CENTS` was
 * the last line of this function and it is gone with the rest: the Shift Report's kit-spend row
 * now means kits — bought at the stand, thrown by a hand or by a Maintenance Station — and
 * nothing else. A drone that fixes a machine moves no number in the books, which is exactly
 * what "free" has to mean if the report is to stay honest.
 *
 * The one thing it still costs is the drone's own condition, which is not a price — every bot
 * in this game wears per completed operation, and a robot that never wore would be a robot that
 * never needed the wrench it carries.
 *
 * **AND IT SERVICES THE ROBOTS ASLEEP IN THE SHED**, which is the other half of the owner's bug.
 * Restoring only `machine.condition` at a dock would have been a drone that flew the errand its
 * new eligibility test finally sent it on and then achieved literally nothing, because a dock's
 * own condition was already full — it is the bots that were worn. Same rule as the kit and the
 * station: everything in the shed comes back to full. A drone servicing its OWN bay tops itself
 * up along with any sibling, which is correct and slightly funny, and then pays the wear below
 * for the operation it just performed — it is a robot, not an exception.
 */
function serviceUnderDrone(state: WorldState, bot: Bot): void {
  const machine = machineById(state, bot.targetTile);
  if (machine === null || !machineWantsService(state, machine)) return;

  machine.condition = CONDITION_MAX;
  machine.jammed = false;
  restoreDockedBots(state, machine);
  wearBot(bot);
}

/** Every bot living in this machine, back to full. The kit's rule and the station's, shared. */
export function restoreDockedBots(state: WorldState, dock: Machine): void {
  for (let i = 0; i < state.bots.length; i++) {
    const bot = state.bots[i]!;
    if (bot.dockId === dock.id) bot.condition = CONDITION_MAX;
  }
}

function advanceHarvester(state: WorldState, bot: Bot, dock: Machine): void {
  switch (bot.phase) {
    case BotPhase.Idle: {
      // Full, or holding something after the zone went quiet: take it home. A FULL POCKET
      // SENDS IT HOME TOO (item 088) — a bot that kept working with nowhere to put the next
      // seed would have to choose between stalling in a field and deleting one, and neither is
      // a thing this game does.
      if (bot.carryCount >= BOT_CARRY_CAPACITY || bot.seedCount >= BOT_SEED_POCKET_CAPACITY) {
        bot.phase = BotPhase.Returning;
        return;
      }
      const target = nextReadyTile(state, bot, dock);
      if (target < 0) {
        // Nothing ripe. Walk home if there is anything to drop off or anywhere to be, and
        // otherwise stand still — an idle bot burns no condition and no cursor.
        if (bot.carryCount > 0 || bot.seedCount > 0 || !atDock(bot, dock)) {
          bot.phase = BotPhase.Returning;
        } else resetMomentum(bot);
        return;
      }
      bot.targetTile = target;
      bot.phase = BotPhase.Outbound;
      return;
    }

    case BotPhase.Outbound: {
      const tile = tileByKey(state, bot.targetTile);
      // The errand went stale — the player pulled the tile first (or un-tilled the ground from
      // under it), which they are always allowed to do (§1: manual never rots). Pick again
      // rather than walking to bare dirt.
      if (tile === null || !isTileReady(tile)) {
        bot.phase = BotPhase.Idle;
        bot.targetTile = -1;
        return;
      }
      const outcome = walkToTile(bot, bot.targetTile, groundBlocked(state));
      // A wet footstep skips the target exactly as a stale one does (item 080): back to Idle
      // with the cursor already one past it, so the scan moves on rather than marching a
      // rolling bot into the pond — and never livelocks against it.
      if (outcome === StepOutcome.Blocked) {
        bot.phase = BotPhase.Idle;
        bot.targetTile = -1;
        return;
      }
      if (outcome === StepOutcome.Arrived) {
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
      const wantsHome = harvestUnderBot(state, bot);
      bot.targetTile = -1;
      bot.phase =
        wantsHome ||
        bot.carryCount >= BOT_CARRY_CAPACITY ||
        bot.seedCount >= BOT_SEED_POCKET_CAPACITY
          ? BotPhase.Returning
          : BotPhase.Idle;
      return;
    }

    case BotPhase.Returning:
    default: {
      // A blocked walk home is a STALL, not a loss: the bot stands at the shore holding its
      // armful — visible from ten tiles up, like every other stall — and retries; ponds do
      // not move, but the player can hand-repair the situation by re-siting the dock.
      if (walkToMachine(bot, dock, groundBlocked(state)) !== StepOutcome.Arrived) return;
      if (bot.carryCount <= 0 && bot.seedCount <= 0) {
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
      const tile = tileByKey(state, bot.targetTile);
      if (tile === null || tile.crop !== CropId.None || dockSeedCount(dock) <= 0) {
        bot.phase = BotPhase.Idle;
        bot.targetTile = -1;
        return;
      }
      const outcome = walkToTile(bot, bot.targetTile, groundBlocked(state));
      // Wet footstep: skip the target like a stale one (item 080). See the harvester.
      if (outcome === StepOutcome.Blocked) {
        bot.phase = BotPhase.Idle;
        bot.targetTile = -1;
        return;
      }
      if (outcome === StepOutcome.Arrived) {
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
      if (walkToMachine(bot, dock, groundBlocked(state)) === StepOutcome.Arrived) {
        bot.phase = BotPhase.Idle;
      }
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
 * `takeHarvest`, which is the same function the player's own pull uses, so the yield and the
 * regrowth rule are identical — what differs is only where the goods land
 * and what gets counted, which is a two-line difference in plain sight.
 *
 * ONE PRODUCT AT A TIME, like a cart: a bot holding potatoes that reaches a ripe chili takes the
 * chili home first. That is a zone-assignment problem, not a bot problem, and the zone already
 * has one crop.
 *
 * **AND THE SEED COMES HOME (item 088.)** The hand's `harvestOneTile` has always done
 * `addItem(spec.seedItem, 1)` for a one-shot crop — plan §4's anti-softlock floor — while this
 * path routed only through `takeHarvest`, which by its own contract returns no seed. So the bot
 * dropped it, and automation quietly cost a seed a tile: a parity bug since item 038, not a
 * balance choice anyone made. The test for "does it come back" is `spec.regrowTicks <= 0`, the
 * SAME expression the hand uses, so the two paths cannot drift apart.
 *
 * Returns whether the bot should head home now — because it refused a tile, either one whose seed
 * it could not pocket or one whose produce it could not add to the armful it is already carrying.
 * Both refusals leave the tile standing, and neither is a loss.
 */
function harvestUnderBot(state: WorldState, bot: Bot): boolean {
  const tile = tileByKey(state, bot.targetTile);
  if (tile === null) return false;
  const spec = tile.crop === CropId.None ? null : cropSpec(tile.crop);
  if (spec === null) return false;

  // CHECKED BEFORE THE PULL, BECAUSE AFTER THE PULL IS TOO LATE. A one-shot crop hands back a
  // seed, and nothing in this game is ever deleted (plan §4). If the pocket cannot take it —
  // full, or holding a different crop's seed — the tile is LEFT STANDING and the bot walks
  // home, which is a stall the player can see and fix rather than a seed that silently was not
  // there. `takeHarvest` would already have the crop out of the ground by the time a check
  // after it noticed.
  if (spec.regrowTicks <= 0 && !pocketRoomFor(bot, spec.seedItem)) return true;

  // **AND THE SAME CHECK FOR THE ARMS, FOR THE SAME REASON** (item 117, DOOR 9).
  //
  // **ITEM 124 TOOK ITS ORIGINAL TRIGGER AWAY AND DID NOT MAKE IT DEAD CODE.** The trigger this
  // guard was written against was the crop clock: a turned tile handed back the Day-Old good, so
  // one zone produced two item ids for free, with no keypress and no exploit. Nothing wilts now
  // and `harvestItemFor` is constant per crop — which removes ONE way in, not the property.
  //
  // The live trigger is four lines up: this function reads **`tile.crop`**, not `zone.crop`. A
  // zone is a rectangle, `applyPlantTile` will put any seed in any farm tile inside it, and
  // `SetZoneCrop` re-points a zone at a different crop while a bot is already out on its round
  // holding an armful of the last one. Either of those puts a bot over a tile whose produce is
  // not what it is carrying, and neither involves a clock.
  //
  // The old code pulled first and sorted it out afterwards, which it could not do. It set
  // `phase = Returning` — the right idea, and the comment describing it survives below — and then
  // overwrote `carryItem` and zeroed `carryCount` on the very next line, DELETING the armful it
  // had just decided to send home. Three potatoes, measured, in plain play.
  //
  // Asking first is the only shape that keeps both: the armful goes home whole and the foreign
  // tile is still standing when the bot comes back with empty arms.
  if (bot.carryItem !== 0 && bot.carryItem !== harvestItemFor(spec)) return true;

  const result = takeHarvest(state, tile, spec);
  if (result === null) return false;

  // Empty arms take the new product's id. Anything else was refused above, so this cannot be
  // reached with an armful of something different — the case the old code handled by deleting it.
  if (bot.carryItem === 0) {
    bot.carryItem = result.item;
    bot.carryCount = 0;
  }
  bot.carryCount += result.count;

  // One seed, one one-shot tile — the hand's rule, in the hand's words. Regrowers keep the
  // plant and return nothing, which `takeHarvest` has already decided.
  if (spec.regrowTicks <= 0) {
    bot.seedItem = spec.seedItem;
    bot.seedCount += 1;
  }

  wearBot(bot);
  // Plan §3's Hall of Hands. Marked on the completed harvest rather than on the dock being
  // placed: the moment worth ten seconds of theatre is a crop leaving the ground without a hand
  // on it, which is a thing that has never happened in this game before.
  markCeremony(state, CeremonyId.FirstBot);
  return false;
}

/** Whether the seed pocket will take one more of this seed. One seed type at a time. */
function pocketRoomFor(bot: Bot, seed: ItemId): boolean {
  if (bot.seedItem !== 0 && bot.seedItem !== seed) return false;
  return bot.seedCount < BOT_SEED_POCKET_CAPACITY;
}

/** Sow the tile the bot is standing on from the dock's hopper. */
function plantUnderBot(state: WorldState, bot: Bot, dock: Machine): void {
  const tile = tileByKey(state, bot.targetTile);
  if (tile === null || tile.crop !== CropId.None) return;
  // A machine landed here mid-walk (item 067). The tile grows nothing; keep the seed.
  if (machineAt(state, tile.tileX, tile.tileY) !== null) return;
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
 * Put what the bot is carrying on the dock's shelf, where a belt, a grabber, or a hand can
 * take it — WITH ITS NAME ON IT.
 *
 * The shelf is the dock's CARGO, the same `cargoItem`/`cargoCount` pair the planter keeps
 * seeds in and the cart keeps goods in (item 083). It used to be `outputCount`, and that was
 * the bug: the output buffer's identity comes from the machine SPEC, and the dock's spec
 * honestly says it produces nothing — so every armful a bot delivered became anonymous, and
 * anonymous goods can never leave. Cargo carries its own identity, so what the bot put down
 * is what the grabber picks up.
 *
 * **~~THE SHELF CARRIES NO CLOCK~~ — TRUE OF EVERYTHING NOW (item 124).** This used to be a
 * decision worth defending: a bot had no freshness on its back, so it had nothing to hand the
 * shelf, and produce waited there indefinitely while everything else in the game aged. The
 * question was whether a shelf that preserves for free was a laundering hole (it was not — a
 * player cannot put anything INTO a dock; `applyLoadMachine` refuses it, a dock being neither
 * storage nor a recipe, so there was no round trip to make) or an automation-balance question.
 * **Freshness is deleted, so the exception stopped being one.** Nothing anywhere carries a clock,
 * and `carryItem`/`carryCount` being a bare pair of numbers is now the shape of every buffer in
 * the game rather than this shelf's special case.
 *
 * A FULL DOCK IS A STALL, NOT A LOSS — and so is a MISMATCHED one. The shelf holds one product
 * at a time, like every cargo pair in the game, and a bot arriving with chili while the shelf
 * still holds potatoes stands there holding its armful (the house "look downstream" stall)
 * until the shelf drains. That trip is real, not theoretical, and item 124 did not make it less
 * so — it only changed which door produces it. The clock is gone, but `SetZoneCrop` re-points a
 * zone mid-round and `applyPlantTile` will put any seed in any farm tile inside one, so a bot
 * still comes home with chili to a shelf holding potatoes. Nothing vanishes (plan §4), and the
 * diagnostic is a robot standing at a full shed, visible from ten tiles up.
 */
function unloadIntoDock(bot: Bot, dock: Machine): void {
  const spec = machineSpec(dock.kind);
  if (spec === null) return;

  // TWO SHELVES, TWO INDEPENDENT TRANSFERS (item 088). Neither can block the other: a full
  // produce shelf must not strand the seeds, and a full seed shelf must not strand the potatoes
  // — a dock where one jam stops both would turn a small downstream mistake into a total halt,
  // and it would make the stall say the wrong thing about which belt is missing.
  if (bot.carryItem !== 0 && (dock.cargoItem === 0 || dock.cargoItem === bot.carryItem)) {
    // The shelf is sized by `outputCapacity` — the harvester dock's one buffer number, scaled by
    // the same Capacity dial the old path honoured. Its `inputCapacity` is 0 and stays unused.
    const room = effectiveOutputCapacity(spec, dock) - dock.cargoCount;
    if (room > 0) {
      const moved = bot.carryCount < room ? bot.carryCount : room;
      dock.cargoItem = bot.carryItem;
      dock.cargoCount += moved;
      bot.carryCount -= moved;
      // Empty arms are ONE state, not two — a remainder left lying on an empty bot would hash
      // differently from an identical bot that reached empty by another route.
      if (bot.carryCount <= 0) bot.carryItem = 0;
    }
  }

  // The seed shelf. A FIXED cap rather than the Capacity dial's: the dial buys warehouse for
  // the thing you sell, and a seed shelf is a place seeds WAIT for a belt (see
  // `HARVESTER_SEED_SHELF_CAPACITY`). One seed type at a time, like every cargo pair here.
  if (bot.seedItem !== 0 && (dock.seedShelfItem === 0 || dock.seedShelfItem === bot.seedItem)) {
    const seedRoom = HARVESTER_SEED_SHELF_CAPACITY - dock.seedShelfCount;
    if (seedRoom > 0) {
      const moved = bot.seedCount < seedRoom ? bot.seedCount : seedRoom;
      dock.seedShelfItem = bot.seedItem;
      dock.seedShelfCount += moved;
      bot.seedCount -= moved;
      if (bot.seedCount <= 0) bot.seedItem = 0;
    }
  }

  // Back to work only when BOTH hands are empty. Still holding either is the stall — the robot
  // standing at a full shed, visible from ten tiles up — and nothing was deleted to reach it.
  if (bot.carryCount <= 0 && bot.seedCount <= 0) bot.phase = BotPhase.Idle;
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
  // A farm tile hosting a field-placed machine (item 067) grows nothing while it stands, so
  // the planter never sets out for one. Ready tiles need no such check: an occupied tile
  // cannot hold a crop in the first place.
  return scanZone(
    state,
    bot,
    dock,
    (tile) => tile.crop === CropId.None && machineAt(state, tile.tileX, tile.tileY) === null,
  );
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
    // THE WORLD KEY, NOT THE ARRAY INDEX. Tilling inserts and removes field entries, so an
    // index handed out this tick may name a different tile next tick; the key names ground.
    return worldTileKey(tile.tileX, tile.tileY);
  }
  return -1;
}

// --- walking ------------------------------------------------------------------------
//
// Both of these are one line of intent over `stepToward`. They exist so that "where is the middle
// of a tile" and "where is the middle of a dock" are answered in one place each rather than at
// four call sites, and so a drone reusing this file gets the same answers.
//
// GROUND BOTS DO NOT WALK ON WATER (item 080); THE DRONE FLIES OVER IT. The harvester and the
// planter roll along the dirt, so they pass `stepToward` the same water predicate the player's
// errand does and get the same edge-stop. The repair drone "rises out of its bay" and crosses
// the lot in the air, so it passes nothing and the pond never blocks it — which is also why
// `walkToMachine` takes the predicate as a parameter rather than assuming one.

/** The item-080 footstep predicate for a bot that rolls rather than flies. */
function groundBlocked(state: WorldState): (xSub: number, ySub: number) => boolean {
  return (xSub, ySub) => waterAtSubtile(state, xSub, ySub);
}

function walkToTile(
  bot: Bot,
  key: number,
  blockedAt?: (xSub: number, ySub: number) => boolean,
): StepOutcome {
  return stepToward(
    bot,
    tileCentreSubtiles(worldKeyTileX(key)),
    tileCentreSubtiles(worldKeyTileY(key)),
    BOT_SPEED_SUBTILES_PER_100_TICKS,
    blockedAt,
  );
}

function walkToMachine(
  bot: Bot,
  machine: Machine,
  blockedAt?: (xSub: number, ySub: number) => boolean,
): StepOutcome {
  if (atDock(bot, machine)) return StepOutcome.Arrived;
  return stepToward(
    bot,
    tileCentreSubtiles(machine.tileX),
    tileCentreSubtiles(machine.tileY),
    BOT_SPEED_SUBTILES_PER_100_TICKS,
    blockedAt,
  );
}

function atDock(bot: Bot, dock: Machine): boolean {
  return bot.xSub === tileCentreSubtiles(dock.tileX) && bot.ySub === tileCentreSubtiles(dock.tileY);
}
