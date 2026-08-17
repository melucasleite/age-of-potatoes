// **THE LAST TWO FRIDGES** (item 115): the Truck Depot floor, and a bot that cannot deliver.
//
// Item 110 closed a container's cargo. Its verifier found the bug had MOVED to the hopper, so
// item 112 went looking for the family instead of the bug and closed five doors — hopper, belt,
// grabber claw, dock shelf, and the output basket nobody had found. Item 112's OWN verifier then
// found two more, and this file is those two. The sentence under test has not changed since 110:
//
//   > *a perishable that goes into anything and comes back out is exactly as old as it was.*
//
// **DOOR 6 — THE TRUCK DEPOT FLOOR, MEASURED FOUR WAYS.** `Contract.stocked` was a bare integer,
// so a standing route was a warehouse with no clock in it. Three mechanisms, all of them the same
// mechanism item 110 found in a hand cart:
//
//   1. `depotAccept` took no freshness parameter — the door IN minted nothing but it recorded
//      nothing either, so whatever an arm was carrying was forgotten on the threshold.
//   2. Nothing anywhere spent the clock while the goods sat on the floor.
//   3. `refundContract` handed everything back through `addItem`, which stamps from NOW.
//
// The verifier's four routes, with what they measured before the fix:
//
//   | route                                     | went in | waited | came out |
//   | floor + `CancelContract`                  |   1,200 | 72,000 |   17,999 |
//   | floor + box the depot                     |     600 | 20,000 |    6,999 |
//   | cart→arm→belt→arm→depot then cancel       |   2,400 | 43,000 |   17,898 |
//   | cancelled off a lorry mid-run             |   1,200 |    301 |   17,998 |
//
// The third needs NO CLICKING AT ALL, which is what makes this a machine rather than an exploit.
//
// **DOOR 7 — A STALLED BOT IS AN UNBOUNDED FRIDGE.** Item 112 looked straight at a bot's pockets
// and decided, in writing, that they keep no clock: *"goods only ever enter it by being harvested
// from a tile, which is the moment a full window is correct, and nothing in the game can put an
// old good into a bot."* Every clause of that is true and the conclusion does not follow. A bot
// that harvests and then cannot deliver — a full shelf, a mismatched one, a pond in the way —
// stands there holding its armful for as long as the jam lasts, and the clock had never started.
// That is not a player laundering anything; it is a fridge that appears whenever a dock backs up,
// which is an ordinary factory state.
//
// Every test below was written and RED before a line of the fix existed.

import { describe, expect, it } from 'vitest';

import {
  type Machine,
  type WorldState,
  BOT_CARRY_CAPACITY,
  BeltTier,
  BotKind,
  BotPhase,
  CropId,
  Direction,
  FIELD_TILES_WIDE,
  GrabberTier,
  HARVESTER_SEED_SHELF_CAPACITY,
  ItemId,
  MachineKind,
  SUBTILE,
  addItem,
  beltInsert,
  createWorld,
  cropSpec,
  depotAccept,
  itemCount,
  machineSpec,
  plantCrop,
  remainingFreshness,
  spawnBelt,
  spawnBot,
  spawnGrabber,
  spawnMachine,
  spawnZone,
  step,
  stepMany,
} from '../src/index';

const ACTIVE_MINUTE = 1_200;
const ACTIVE_HOUR = 60 * ACTIVE_MINUTE;
const POTATO_WINDOW = 18_000;
const WASHED_WINDOW = 7_200;

function world(seed: number): WorldState {
  const state = createWorld(seed);
  state.player.xSub = 128;
  state.player.ySub = 128;
  return state;
}

/** Put the player on a tile so hand verbs are in reach. Position is not a command. */
function standOn(state: WorldState, tileX: number, tileY: number): void {
  state.player.xSub = tileX * SUBTILE + SUBTILE / 2;
  state.player.ySub = tileY * SUBTILE + SUBTILE / 2;
}

function run(state: WorldState, command: Parameters<typeof step>[1]['commands'][number]): void {
  step(state, { tick: state.tick, commands: [command] });
}

/**
 * A depot with one standing route on it, at `tileX`.
 *
 * `quantityPerRun` defaults high enough that the routes below never dispatch — the fridge under
 * test is a WAITING floor, which is the state a route spends nearly all of its life in.
 */
function depotWithRoute(
  seed: number,
  item: ItemId,
  quantityPerRun = 40,
  tileX = 7,
  tileY = 0,
): { state: WorldState; depot: Machine; contractId: number } {
  const state = world(seed);
  const depot = spawnMachine(state, MachineKind.TruckDepot, tileX, tileY)!;
  run(state, {
    type: 'CreateContract',
    depotId: depot.id,
    item,
    quantityPerRun,
    destination: 'Springfield',
  });
  const contract = state.contracts[state.contracts.length - 1]!;
  expect(contract.item, 'the route was signed').toBe(item);
  return { state, depot, contractId: contract.id };
}

// --- door 6, route 1: the floor and a cancelled route -------------------------------------

describe('a depot floor with a route waiting on it', () => {
  it('THE EXPLOIT: ten potatoes cannot sit out an hour on a depot floor and be cancelled back fresh', () => {
    // The verifier's first row, replayed. A minute of clock goes in, an hour of world time
    // passes, and under the old rule the cancel handed back 17,999 of an 18,000-tick window —
    // a route signed and torn up around a pile of produce was a free refrigerator with a
    // receipt.
    const { state, depot, contractId } = depotWithRoute(11_501, ItemId.RussetPotato);

    for (let i = 0; i < 10; i++) {
      expect(depotAccept(state, depot, ItemId.RussetPotato, ACTIVE_MINUTE)).toBe(true);
    }

    stepMany(state, ACTIVE_HOUR);
    const contract = state.contracts.find((entry) => entry.id === contractId)!;
    expect(contract.stocked, 'never enough for a run, so it just sat there').toBe(10);

    run(state, { type: 'CancelContract', contractId });

    // A minute of clock against an hour of standing still. They are compost, and the sweep that
    // turns them is the ordinary inventory one, a tick after they land in the bag.
    stepMany(state, 2);
    expect(itemCount(state, ItemId.RussetPotato)).toBe(0);
    expect(itemCount(state, ItemId.Compost)).toBeGreaterThanOrEqual(10);
  });

  it('hands the clock back rather than destroying it — cancel straight away and lose nothing', () => {
    // The other half of the ruling, and the reason it is a clock rather than a refusal:
    // cancelling is free and nothing vanishes (plan §4), so a player who signs a route, changes
    // their mind, and tears it up gets their produce back with the time it had.
    const { state, depot, contractId } = depotWithRoute(11_502, ItemId.RussetPotato);
    for (let i = 0; i < 6; i++) depotAccept(state, depot, ItemId.RussetPotato, 12_000);

    stepMany(state, ACTIVE_MINUTE);
    run(state, { type: 'CancelContract', contractId });

    expect(itemCount(state, ItemId.RussetPotato)).toBe(6);
    // A minute inside costs a minute, exactly as a minute outside does. The handful of ticks past
    // that are the command tick and the bucket rounding, which floors in the player's disfavour.
    const left = remainingFreshness(state, ItemId.RussetPotato);
    expect(left).toBeGreaterThan(12_000 - ACTIVE_MINUTE - 300);
    expect(left).toBeLessThanOrEqual(12_000 - ACTIVE_MINUTE);
  });

  it('spends the clock while the goods sit, so a floor is not a fridge either', () => {
    const { state, depot, contractId } = depotWithRoute(11_503, ItemId.RussetPotato);
    depotAccept(state, depot, ItemId.RussetPotato, 0);

    const contract = state.contracts.find((entry) => entry.id === contractId)!;
    const before = contract.stockedFreshTicks;
    expect(before, 'no opinion at the door means a full window').toBe(POTATO_WINDOW);

    stepMany(state, 5 * ACTIVE_MINUTE);
    expect(contract.stockedFreshTicks).toBe(before - 5 * ACTIVE_MINUTE);
  });

  it('merges an arriving crate into a stocked floor at the SOONER clock, never the later one', () => {
    // The exploit written the other way round: drop one fresh potato on the floor every quarter
    // hour and the pile underneath lives forever. `mergedFreshness`' rule, on a depot floor.
    const { state, depot, contractId } = depotWithRoute(11_504, ItemId.RussetPotato);
    const contract = state.contracts.find((entry) => entry.id === contractId)!;

    for (let i = 0; i < 5; i++) depotAccept(state, depot, ItemId.RussetPotato, 3_000);
    expect(contract.stockedFreshTicks).toBe(3_000);

    // Five brand-new potatoes, worth a full window, join five with two and a half minutes left.
    for (let i = 0; i < 5; i++) depotAccept(state, depot, ItemId.RussetPotato, POTATO_WINDOW);
    expect(contract.stocked).toBe(10);
    expect(contract.stockedFreshTicks, 'the sooner of the two, always').toBe(3_000);
  });

  it('leaves a shelf-stable route alone — bagged chips wait forever and lose nothing', () => {
    // Rot is not a tax on standing still; it is a clock on things that have one. A route for
    // chips is the ordinary end of the chip line, and nothing at all happens to it.
    const { state, depot, contractId } = depotWithRoute(11_505, ItemId.BaggedChips);
    for (let i = 0; i < 10; i++) depotAccept(state, depot, ItemId.BaggedChips, 0);

    const contract = state.contracts.find((entry) => entry.id === contractId)!;
    expect(contract.stockedFreshTicks).toBe(0);

    stepMany(state, ACTIVE_HOUR);
    expect(contract.stockedFreshTicks).toBe(0);

    run(state, { type: 'CancelContract', contractId });
    stepMany(state, 2);
    expect(itemCount(state, ItemId.BaggedChips), 'and none of them turned').toBe(10);
  });
});

// --- door 6, route 2: boxing the depot -----------------------------------------------------

describe('boxing a depot with produce on its floor', () => {
  it('THE EXPLOIT: washed potatoes cannot age on a floor and come back inside their window', () => {
    // The verifier's second row: 600 ticks of a 7,200-tick window went in, twenty thousand ticks
    // passed, and boxing the shed handed back 6,999. `releaseDepotContracts` refunds through the
    // same door `CancelContract` does, so it inherited the same mint.
    const { state, depot, contractId } = depotWithRoute(11_506, ItemId.WashedPotato, 40, 7, 0);
    for (let i = 0; i < 5; i++) depotAccept(state, depot, ItemId.WashedPotato, 600);

    stepMany(state, 20_000);
    standOn(state, 7, 0);
    run(state, { type: 'DeconstructMachine', machineId: depot.id });

    expect(
      state.contracts.find((entry) => entry.id === contractId),
      'the route went with it',
    ).toBe(undefined);
    stepMany(state, 2);
    expect(itemCount(state, ItemId.WashedPotato)).toBe(0);
    expect(itemCount(state, ItemId.Compost)).toBeGreaterThanOrEqual(5);
  });

  it('boxing it straight away hands the floor back with the clock it had', () => {
    const { state, depot } = depotWithRoute(11_507, ItemId.WashedPotato, 40, 7, 0);
    for (let i = 0; i < 5; i++) depotAccept(state, depot, ItemId.WashedPotato, 4_800);

    stepMany(state, ACTIVE_MINUTE);
    standOn(state, 7, 0);
    run(state, { type: 'DeconstructMachine', machineId: depot.id });

    expect(itemCount(state, ItemId.WashedPotato)).toBe(5);
    const left = remainingFreshness(state, ItemId.WashedPotato);
    expect(left).toBeGreaterThan(0);
    expect(left, 'a refund is not a way to un-wait').toBeLessThanOrEqual(4_800 - ACTIVE_MINUTE);
    expect(left).toBeLessThan(WASHED_WINDOW);
  });
});

// --- door 6, route 3: the automated route, with no clicking at all -------------------------

describe('the belt-fed depot', () => {
  /**
   * The verifier's automated exploit, built out of real machines and one signature:
   *
   *   cart (0,0) → arm (1,0) → belt (2,0)..(5,0) → arm (6,0) → depot (7,0)
   *
   * Nothing in it needs a player after the route is signed, which is the point — every other
   * door in this family needed at least one keypress.
   */
  function loopIntoDepot(state: WorldState, item: ItemId, quantityPerRun = 40) {
    const from = spawnMachine(state, MachineKind.HandCart, 0, 0)!;
    spawnGrabber(state, GrabberTier.Mk1, 1, 0, Direction.East, 0);
    spawnBelt(state, BeltTier.Basic, 2, 0, Direction.East, 4);
    spawnGrabber(state, GrabberTier.Mk1, 6, 0, Direction.East, 0);
    const depot = spawnMachine(state, MachineKind.TruckDepot, 7, 0)!;
    run(state, {
      type: 'CreateContract',
      depotId: depot.id,
      item,
      quantityPerRun,
      destination: 'Shelbyville',
    });
    return { from, depot, contract: state.contracts[state.contracts.length - 1]! };
  }

  it('THE EXPLOIT, HANDS FREE: a cart → belt → depot → cancel round trip cannot mint a window', () => {
    const state = world(11_508);
    const { from, contract } = loopIntoDepot(state, ItemId.RussetPotato);

    addItem(state, ItemId.RussetPotato, 10);
    standOn(state, 0, 0);
    run(state, { type: 'LoadMachine', machineId: from.id, item: ItemId.RussetPotato, count: 10 });

    // Long enough for the arms to walk the whole load across and onto the floor.
    stepMany(state, 3_000);
    expect(contract.stocked, 'the load made it to the depot').toBeGreaterThan(0);
    const carried = contract.stocked;

    // Longer than any window in the game, twice over.
    stepMany(state, 43_000);
    run(state, { type: 'CancelContract', contractId: contract.id });
    stepMany(state, 2);

    expect(itemCount(state, ItemId.RussetPotato), 'a belt is not a time machine either').toBe(0);
    expect(itemCount(state, ItemId.Compost)).toBeGreaterThanOrEqual(carried);
  });

  it('carries the arm’s clock through the depot door rather than forgetting it on the threshold', () => {
    const state = world(11_509);
    const { from, contract } = loopIntoDepot(state, ItemId.RussetPotato);

    addItem(state, ItemId.RussetPotato, 10);
    standOn(state, 0, 0);
    run(state, { type: 'LoadMachine', machineId: from.id, item: ItemId.RussetPotato, count: 10 });

    stepMany(state, 3_000);
    expect(contract.stocked).toBeGreaterThan(0);
    // Three thousand ticks of cart, belt and claw are gone from the window, and the floor knows
    // it. Under the old rule this field did not exist and the cancel below minted a full one.
    expect(contract.stockedFreshTicks).toBeGreaterThan(0);
    expect(contract.stockedFreshTicks).toBeLessThanOrEqual(POTATO_WINDOW - 3_000);
  });
});

// --- door 6, route 4: cancelled off a lorry mid-run ----------------------------------------

describe('a route cancelled while its truck is on the road', () => {
  it('THE EXPLOIT: goods on a lorry come back with the clock they left with, not a new one', () => {
    // The verifier's fourth row: 1,200 ticks in, cancelled 301 ticks later, 17,998 back. The
    // truck is not the fridge here — a run is bounded — the MINT is, and `refundContract` hands
    // back `inTransit` through the same `addItem` the floor went through.
    const { state, depot, contractId } = depotWithRoute(11_510, ItemId.RussetPotato, 5);
    for (let i = 0; i < 5; i++) depotAccept(state, depot, ItemId.RussetPotato, ACTIVE_MINUTE);

    // One tick commits the floor to the truck; the rest is road.
    stepMany(state, 301);
    const contract = state.contracts.find((entry) => entry.id === contractId)!;
    expect(contract.inTransit, 'the lorry is loaded and rolling').toBe(5);
    expect(contract.stocked).toBe(0);

    run(state, { type: 'CancelContract', contractId });
    expect(itemCount(state, ItemId.RussetPotato)).toBe(5);
    expect(
      remainingFreshness(state, ItemId.RussetPotato),
      'a lorry is not a way to buy back a window',
    ).toBeLessThanOrEqual(ACTIVE_MINUTE);
  });

  it('empties both clocks when the money arrives, so an idle route hashes as zeroes', () => {
    const { state, depot, contractId } = depotWithRoute(11_511, ItemId.RussetPotato, 5);
    for (let i = 0; i < 5; i++) depotAccept(state, depot, ItemId.RussetPotato, ACTIVE_MINUTE);

    const contract = state.contracts.find((entry) => entry.id === contractId)!;
    stepMany(state, 5_000);
    expect(contract.runsCompleted, 'the truck came back').toBeGreaterThanOrEqual(1);
    expect(contract.stocked).toBe(0);
    expect(contract.inTransit).toBe(0);
    expect(contract.stockedFreshTicks, 'empty is one state, not two').toBe(0);
    expect(contract.inTransitFreshTicks).toBe(0);
  });
});

// --- door 7: a bot that cannot put its armful down -----------------------------------------

/** A world with one zone over the first two rows of the field and a harvester dock bound to it. */
function farmWithHarvester(seed: number): { state: WorldState; dock: Machine } {
  const state = createWorld(seed);
  const zone = spawnZone(state, CropId.RussetPotato);
  for (let i = 0; i < FIELD_TILES_WIDE * 2; i++) state.field[i]!.zone = zone.id;

  const dock = spawnMachine(state, MachineKind.HarvesterDock, 0, 0)!;
  dock.boundZone = zone.id;
  spawnBot(state, BotKind.Harvester, dock);

  const spec = cropSpec(CropId.RussetPotato)!;
  for (let i = 0; i < state.field.length; i++) {
    const tile = state.field[i]!;
    if (tile.zone !== zone.id) continue;
    plantCrop(state, tile, spec);
    tile.growth = tile.growthTarget;
  }
  return { state, dock };
}

/**
 * Put another product on the dock's produce shelf, filled to the brim.
 *
 * Two independent reasons `unloadIntoDock` will move nothing — wrong product AND no room — so the
 * stall cannot quietly clear itself if either rule is relaxed later. The shelf's own clock is left
 * at 0 so the sweep does not turn it into Compost and change what the mismatch is a mismatch with.
 */
function jamProduceShelf(state: WorldState, dock: Machine): void {
  dock.cargoItem = ItemId.ChiliPepper;
  dock.cargoCount = machineSpec(MachineKind.HarvesterDock)!.outputCapacity;
  dock.cargoFreshTicks = 0;
}

/** Step until the predicate holds, or give up. Returns the tick it happened on, or -1. */
function stepUntil(state: WorldState, limit: number, done: () => boolean): number {
  for (let i = 0; i < limit; i++) {
    stepMany(state, 1);
    if (done()) return state.tick;
  }
  return -1;
}

describe('a harvester bot that cannot deliver', () => {
  it('THE EXPLOIT: a jammed dock does not freeze the armful the bot is standing there holding', () => {
    // Item 112 reasoned that a bot's pocket needs no clock because "nothing in the game can put
    // an old good into a bot". True, and beside the point: the goods GET old in the bot. Jam the
    // shelf with another product and the bot stands at the shed holding potatoes forever.
    const { state, dock } = farmWithHarvester(11_512);
    const bot = state.bots[0]!;

    // The shelf holds a different product from the outset, so `unloadIntoDock` moves nothing and
    // the bot stalls on arrival — the house "look downstream" stall, and an ordinary factory
    // state. Set before the first pull so the jam is what the bot walks home into.
    jamProduceShelf(state, dock);

    // It fills its arms, walks home, and stands there. `BOT_CARRY_CAPACITY` is what a full
    // armful is; waiting for it is what makes `held` a settled number rather than a race.
    const stalled = stepUntil(
      state,
      20_000,
      () => bot.phase === BotPhase.Returning && bot.carryCount >= BOT_CARRY_CAPACITY,
    );
    expect(stalled, 'the bot filled up and came home').toBeGreaterThan(0);
    expect(bot.carryItem).toBe(ItemId.RussetPotato);

    const held = bot.carryCount;
    stepMany(state, ACTIVE_HOUR);

    expect(bot.phase, 'still standing at the shed').toBe(BotPhase.Returning);
    expect(bot.carryCount, 'nothing vanished').toBe(held);
    expect(bot.carryItem, 'an hour in a robot’s arms is an hour').toBe(ItemId.Compost);
  });

  it('hands the shelf the clock it walked home with, not a fresh window', () => {
    // The quiet half of the same bug: even an unjammed bot minted the length of its own walk,
    // every round, forever. The shelf's clock now starts when the crop leaves the ground.
    const { state, dock } = farmWithHarvester(11_513);
    const bot = state.bots[0]!;

    const picked = stepUntil(state, 5_000, () => bot.carryCount > 0);
    expect(picked).toBeGreaterThan(0);
    const walked = stepUntil(state, 5_000, () => dock.cargoCount > 0);
    expect(walked, 'and walked it home').toBeGreaterThan(picked);

    expect(dock.cargoItem).toBe(ItemId.RussetPotato);
    expect(
      dock.cargoFreshTicks,
      'the walk home is spent, not refunded on arrival',
    ).toBeLessThanOrEqual(POTATO_WINDOW - (walked - picked));
    expect(dock.cargoFreshTicks).toBeGreaterThan(0);
  });

  it('starts the clock at the pull, and spends it while the bot walks', () => {
    const { state } = farmWithHarvester(11_514);
    const bot = state.bots[0]!;

    const picked = stepUntil(state, 5_000, () => bot.carryCount > 0);
    expect(picked).toBeGreaterThan(0);
    // A tick short of the full window, because the tick that carried the harvest also ran the
    // sweep — the goods were in the bot's arms for it. That is the direction every rounding in
    // this feature leans, and it is the same tick a hopper loses to `applyLoadMachine`.
    const atPull = bot.carryFreshTicks;
    expect(atPull, 'a crop leaving the ground is worth a full window').toBe(POTATO_WINDOW - 1);

    stepMany(state, 100);
    expect(bot.carryFreshTicks).toBe(atPull - 100);
  });

  it('leaves the seed pocket alone — a seed is shelf-stable and keeps no clock', () => {
    // Rot is a clock on things that have one, and a seed has none. Both shelves are jammed —
    // item 088 made them independent transfers, so an unjammed seed shelf would simply empty the
    // pocket and this file would be testing nothing.
    const { state, dock } = farmWithHarvester(11_515);
    const bot = state.bots[0]!;
    jamProduceShelf(state, dock);
    dock.seedShelfItem = ItemId.CornSeed;
    dock.seedShelfCount = HARVESTER_SEED_SHELF_CAPACITY;

    const stalled = stepUntil(
      state,
      20_000,
      () => bot.phase === BotPhase.Returning && bot.carryCount >= BOT_CARRY_CAPACITY,
    );
    expect(stalled, 'it came home with a full armful and a pocketed seed').toBeGreaterThan(0);
    expect(bot.seedCount, 'a one-shot crop hands back a seed').toBeGreaterThan(0);

    const seeds = bot.seedCount;
    stepMany(state, ACTIVE_HOUR);

    expect(bot.seedItem, 'seeds do not turn').toBe(ItemId.PotatoSeed);
    expect(bot.seedCount).toBe(seeds);
  });
});

// --- and the proof that there is no door eight --------------------------------------------

/**
 * Every path in `WorldState` that names a good, found by walking a world rather than by reading
 * the types — because a type is what somebody wrote down and a world is what is actually there.
 *
 * Array indices are collapsed to `[]`, so one machine stands for all of them.
 */
function itemBearingPaths(state: WorldState): string[] {
  const found = new Set<string>();
  const seen = new Set<object>();

  const walk = (node: unknown, path: string): void => {
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const entry of node) walk(entry, `${path}[]`);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const here = path === '' ? key : `${path}.${key}`;
      // `held` is the grabber's claw, which names a good without saying "item" — the one place
      // this sweep would miss if it trusted the naming convention.
      if (/item$/i.test(key) || key === 'held') found.add(here);
      walk(value, here);
    }
  };

  walk(state, '');
  return [...found].sort();
}

describe('the whole family of doors', () => {
  it('has a clock on every place in the world a perishable can sit, and nowhere else left', () => {
    // **THIS IS THE TEST ITEMS 110, 112 AND 115 EACH WISHED THE ONE BEFORE HAD WRITTEN.** Every
    // one of them fixed the bug in front of it, shipped, and had its own verifier find the same
    // bug one field to the left — a hand cart, then a hopper, then a depot floor. The pattern was
    // never "this container is wrong"; it was "nobody has a list of the containers".
    //
    // So this is the list, taken from a live world rather than from a comment, and it FAILS THE
    // DAY SOMEBODY ADDS A PLACE GOODS CAN SIT. What it cannot check is whether the new place got
    // a clock — only that a human had to come here and say which of the four answers below applies.
    const state = world(11_599);
    spawnMachine(state, MachineKind.RootCellar, 3, 3);
    const belt = spawnBelt(state, BeltTier.Basic, 5, 5, Direction.East, 2)!;
    // A LOADED belt, and the empty one that caught this sweep out first time round is exactly the
    // point: a place goods can sit is invisible to a walk of the world until something sits in it.
    beltInsert(belt, 0, ItemId.RussetPotato, 6_000);
    spawnGrabber(state, GrabberTier.Mk1, 8, 8, Direction.East, 0);
    addItem(state, ItemId.RussetPotato, 1);
    const { state: depotState, depot } = depotWithRoute(11_598, ItemId.RussetPotato);
    depotAccept(depotState, depot, ItemId.RussetPotato, 0);
    const farm = farmWithHarvester(11_597);
    stepUntil(farm.state, 5_000, () => farm.state.bots[0]!.carryCount > 0);

    const paths = [
      ...new Set([
        ...itemBearingPaths(state),
        ...itemBearingPaths(depotState),
        ...itemBearingPaths(farm.state),
      ]),
    ].sort();

    // Sorted, so the list is the sweep's own order rather than an argument's — and each line says
    // which clock covers it, or why it needs none. Those are the only two legal answers.
    expect(paths).toEqual([
      'belts[].items[].item', //     CLOCK: BeltItem.freshTicks            (item 112)
      'bots[].carryItem', //         CLOCK: Bot.carryFreshTicks            (item 115)
      'bots[].seedItem', //          none: a seed is shelf-stable — a clock would count to nothing
      'contracts[].item', //         CLOCK: Contract.stockedFreshTicks     (item 115)
      //                             and Contract.inTransitFreshTicks, frozen because a run is
      //                             bounded — the Delivery Cart's already-taken rule.
      'grabbers[].held', //          CLOCK: Grabber.heldFreshTicks         (item 112)
      'inventory[].item', //         CLOCK: InventorySlot.stacks[]         (item 110)
      'machines[].cargoItem', //     CLOCK: Machine.cargoFreshTicks        (items 110 + 112)
      'machines[].outputItem', //    CLOCK: Machine.outputFreshTicks       (item 112)
      'machines[].seedShelfItem', // none: the same seed, on the far side of the handover
      'stats.salesByItem', //        none: a RECEIPT. Goods already sold are the one kind that
      //                             cannot spoil.
      'trace[].command.item', //     none: the INPUT LOG. "Sell 10 potatoes" is a record of a
      //                             keypress, not ten potatoes.
      //
      // NOT IN THIS LIST BECAUSE IT HAS NO ID OF ITS OWN: `machines[].inputCounts`, the hoppers.
      // Their identity comes from `machineHoppers(spec)[i]` rather than from a stored field, which
      // is why a hopper's clock CLAMPS instead of turning — there is nowhere to write "Compost".
      // Clocked by `Machine.inputFreshTicks` (item 112).
    ]);
  });
});
