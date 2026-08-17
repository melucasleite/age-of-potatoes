// **COUNT THE MOVES, NOT THE PLACES** (item 117).
//
// Items 110, 112 and 115 each found this family's bug one field to the left of where the last
// one fixed it: a hand cart, then a hopper, then a depot floor, then a stalled bot. Item 115
// finally wrote a list — `itemBearingPaths` in `freshness-depot-and-bot.test.ts` — that walks a
// live world and collects every field naming a good, and closed with the claim that there is no
// door eight.
//
// **THERE WERE THREE.** Wave 17's census verifier found them, and explained in one sentence why
// a sweep that had just been written could not see them:
//
//   > Item 115's sweep enumerates NODES — every place a good can sit. Every bug in this family
//   > has been an EDGE: a transfer between two properly-clocked nodes that dropped the number in
//   > transit. Door 8 is invisible to a node sweep *because both its endpoints are clocked*.
//
// And two of the three are worse than freshness bugs. They are food that stops existing, which
// is plan §4's floor rather than item 035's clock:
//
//   | door | edge                                    | measured                              |
//   | 8    | bot's arms → bag, on boxing the dock     | 9 potatoes, 5,999 ticks left → 17,938 |
//   | 8b   | bot's seed pocket → bag, ditto           | 1 PotatoSeed, bag 8 → 8. Gone.        |
//   | 8c   | dock's seed shelf → bag, ditto           | found HERE, same loop, same function  |
//   | 9    | bot's arms → nowhere, on a Day-Old row    | 3 RussetPotato deleted in plain play  |
//
// Door 8c is this item's own find and it is the argument for the census in one line: 8 and 8b
// were reported by a human reading a function, and the third hole in that same function went
// unreported because reading is not enumerating.
//
// Every test in the first half of this file was written and RED before a line of the fix
// existed. The second half is the census, and it is the deliverable that outlives the doors.

import { describe, expect, it } from 'vitest';

import {
  type Machine,
  type WorldState,
  BOT_CARRY_CAPACITY,
  BOT_SEED_POCKET_CAPACITY,
  BeltTier,
  BotKind,
  BotPhase,
  CropId,
  Direction,
  FIELD_TILES_WIDE,
  GrabberTier,
  HARVESTER_SEED_SHELF_CAPACITY,
  ItemId,
  MACHINE_SPECS,
  MachineKind,
  OVERCOOK_BLOCKED_TICKS,
  SUBTILE,
  WILT_GRACE_TICKS,
  WILT_WINDOW_TICKS,
  addItem,
  boxedItemForMachine,
  createWorld,
  cropSpec,
  itemCount,
  machineHoppers,
  machineSpec,
  plantCrop,
  putStorage,
  remainingFreshness,
  spawnBelt,
  spawnBot,
  spawnGrabber,
  spawnMachine,
  spawnZone,
  step,
  stepMany,
} from '../src/index';
import {
  BAG_DOOR_VERDICTS,
  DATA_IDENTITY_VERDICTS,
  DataIdentity,
  GOODS_COUNTS,
  MOVE_VERDICTS,
  bagDoors,
  dataItemFields,
  goodsLedger,
  goodsMoves,
  itemBearingPaths,
  ledgerClock,
  ledgerCount,
  perishable,
} from './goods';

const POTATO_WINDOW = 18_000;
/** Past the grace and past the droop, and a long way short of collapsing into compost. */
const WILTED_AGE = WILT_GRACE_TICKS + WILT_WINDOW_TICKS + 1;

function standOn(state: WorldState, tileX: number, tileY: number): void {
  state.player.xSub = tileX * SUBTILE + SUBTILE / 2;
  state.player.ySub = tileY * SUBTILE + SUBTILE / 2;
}

function run(state: WorldState, command: Parameters<typeof step>[1]['commands'][number]): void {
  step(state, { tick: state.tick, commands: [command] });
}

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
 * Jam the produce shelf with another product, so `unloadIntoDock` moves nothing and the bot
 * stands at the shed holding its armful — the house "look downstream" stall, and the only way to
 * hold a settled armful still long enough to age it and then box the shed around it.
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

/** Turn every standing crop in the world Day-Old, in place, without moving the clock. */
function wiltEveryRow(state: WorldState): void {
  for (let i = 0; i < state.field.length; i++) {
    const tile = state.field[i]!;
    if (tile.crop === CropId.None) continue;
    tile.readyAge = WILTED_AGE;
  }
}

// --- doors 8, 8b and 8c: boxing a dock with a laden bot inside it --------------------------

describe('boxing a dock that still has a laden bot in it', () => {
  it('THE MINT (door 8): an armful with a quarter of its window left does not come back full', () => {
    // The verifier's measurement, replayed: 9 potatoes with 5,999 ticks left came back as 17,938
    // of an 18,000-tick window — through `addItem`, in the one function whose comments lecture
    // three times about the clock leaving with the goods.
    const { state, dock } = farmWithHarvester(11_701);
    const bot = state.bots[0]!;
    jamProduceShelf(state, dock);

    const stalled = stepUntil(
      state,
      20_000,
      () => bot.phase === BotPhase.Returning && bot.carryCount >= BOT_CARRY_CAPACITY,
    );
    expect(stalled, 'the bot filled its arms and came home to a jam').toBeGreaterThan(0);
    expect(bot.carryItem).toBe(ItemId.RussetPotato);

    // Two thirds of the window spent standing at the shed. The jam is what makes the armful sit
    // still; the clock item 115 gave it is what makes the waiting cost something.
    stepMany(state, 12_000);
    const held = bot.carryCount;
    const left = bot.carryFreshTicks;
    expect(left, 'a third of the window left, give or take a bucket').toBeLessThan(POTATO_WINDOW);
    expect(left).toBeGreaterThan(0);

    standOn(state, 0, 0);
    run(state, { type: 'DeconstructMachine', machineId: dock.id });

    expect(itemCount(state, ItemId.RussetPotato), 'nothing vanished').toBe(held);
    expect(
      remainingFreshness(state, ItemId.RussetPotato),
      'a box is not a way to un-wait',
    ).toBeLessThanOrEqual(left);
  });

  it('THE DELETION (door 8b): the bot’s seed pocket comes back too', () => {
    // The verifier's second measurement, and the plainest bug in the family: the loop that hands
    // an armful back never mentions `seedItem`/`seedCount` at all. Bag went 8 → 8, under a
    // comment reading "Nothing vanishes (plan §4)".
    const { state, dock } = farmWithHarvester(11_702);
    const bot = state.bots[0]!;
    bot.seedItem = ItemId.PotatoSeed;
    bot.seedCount = 3;

    const before = itemCount(state, ItemId.PotatoSeed);
    standOn(state, 0, 0);
    run(state, { type: 'DeconstructMachine', machineId: dock.id });

    expect(state.bots.length, 'the bot went in the box with its shed').toBe(0);
    expect(itemCount(state, ItemId.PotatoSeed)).toBe(before + 3);
  });

  it('THE THIRD DELETION (door 8c): the dock’s own seed shelf comes back too', () => {
    // **NOT IN THE REPORT — found by this item, one line below the one that was.** The seed shelf
    // is a container (item 088) with its own take path, and `applyDeconstructMachine` returns
    // `cargoItem` and stops. A shed full of seeds went in the box and nothing came out.
    const { state, dock } = farmWithHarvester(11_703);
    dock.seedShelfItem = ItemId.PotatoSeed;
    dock.seedShelfCount = HARVESTER_SEED_SHELF_CAPACITY;

    const before = itemCount(state, ItemId.PotatoSeed);
    standOn(state, 0, 0);
    run(state, { type: 'DeconstructMachine', machineId: dock.id });

    expect(itemCount(state, ItemId.PotatoSeed)).toBe(before + HARVESTER_SEED_SHELF_CAPACITY);
  });

  it('hands back the armful, the pocket and the shelf in one box, all at once', () => {
    // The three doors together, because they are one loop and a fix that closed two of them
    // would leave this file green and the family open.
    const { state, dock } = farmWithHarvester(11_704);
    const bot = state.bots[0]!;
    jamProduceShelf(state, dock);

    const stalled = stepUntil(
      state,
      20_000,
      () => bot.phase === BotPhase.Returning && bot.carryCount >= BOT_CARRY_CAPACITY,
    );
    expect(stalled).toBeGreaterThan(0);
    expect(bot.seedCount, 'a one-shot crop hands back a seed').toBeGreaterThan(0);
    dock.seedShelfItem = ItemId.PotatoSeed;
    dock.seedShelfCount = 5;

    const held = bot.carryCount;
    const pocketed = bot.seedCount;
    const seedsBefore = itemCount(state, ItemId.PotatoSeed);
    const chilliBefore = itemCount(state, ItemId.ChiliPepper);

    standOn(state, 0, 0);
    run(state, { type: 'DeconstructMachine', machineId: dock.id });

    expect(itemCount(state, ItemId.RussetPotato)).toBe(held);
    expect(itemCount(state, ItemId.PotatoSeed)).toBe(seedsBefore + pocketed + 5);
    expect(itemCount(state, ItemId.ChiliPepper), 'and the jammed shelf as ever').toBe(
      chilliBefore + machineSpec(MachineKind.HarvesterDock)!.outputCapacity,
    );
  });
});

// --- door 9: a row that turns Day-Old under a working bot -----------------------------------

describe('a bot whose row turns Day-Old under it', () => {
  it('THE DELETION (door 9): the armful it is already holding is not overwritten', () => {
    // No boxing, no keypress, no exploit — one zone that produces two item ids, which is what a
    // wilting row IS. `takeHarvest` returns `dayOldItem` for a wilted tile, the switch sets
    // `phase = Returning`, and then the very next line zeroes the count it was about to send
    // home. The comment calls the case "impossible by construction" three words after handling it.
    const { state, dock } = farmWithHarvester(11_705);
    const bot = state.bots[0]!;

    const picked = stepUntil(state, 5_000, () => bot.carryCount > 0);
    expect(picked, 'it pulled a fresh tile first').toBeGreaterThan(0);
    expect(bot.carryItem).toBe(ItemId.RussetPotato);

    // And now the rest of the row turns, which takes half an hour of not looking at it.
    wiltEveryRow(state);
    const held = bot.carryCount;
    expect(held).toBeGreaterThan(0);

    // The next errand is the one that used to delete them: it walks onto a turned tile, and
    // under the old rule the armful in its hands was overwritten by what it found there.
    const delivered = stepUntil(state, 10_000, () => dock.cargoCount > 0);
    expect(delivered, 'it reached the shed').toBeGreaterThan(0);

    // Wherever they are — still in its arms or already on the shelf — the count is the count.
    // Under the old rule the shelf took DAY-OLD potatoes and the fresh ones were simply gone.
    expect(dock.cargoItem, 'the shelf took the wrong product entirely').toBe(ItemId.RussetPotato);
    const russets = dock.cargoCount + (bot.carryItem === ItemId.RussetPotato ? bot.carryCount : 0);
    expect(russets, 'three potatoes stopped existing').toBeGreaterThanOrEqual(held);
  });

  it('leaves the turned tile standing rather than pulling what it cannot carry', () => {
    // The fix's shape, and it is the shape the seed-pocket check four lines above already uses:
    // ASK BEFORE THE PULL. A bot holding potatoes that walks onto a Day-Old tile takes nothing
    // and goes home — the tile is still there next round, which is a stall a player can see.
    const { state } = farmWithHarvester(11_706);
    const bot = state.bots[0]!;

    stepUntil(state, 5_000, () => bot.carryCount > 0);
    expect(bot.carryItem).toBe(ItemId.RussetPotato);
    wiltEveryRow(state);

    const standing = state.field.filter((tile) => tile.crop !== CropId.None).length;
    expect(standing, 'a field of turned rows').toBeGreaterThan(0);

    // It walks to a turned tile, refuses it, and heads home. Nothing is pulled that has nowhere
    // to go, so the count of standing crops cannot fall while the bot's arms hold the other id.
    stepUntil(state, 3_000, () => bot.phase === BotPhase.Returning);
    expect(state.field.filter((tile) => tile.crop !== CropId.None).length).toBe(standing);
    expect(bot.carryItem, 'still holding what it walked out with').toBe(ItemId.RussetPotato);
  });

  it('picks the Day-Old row up on the next round, once its arms are empty', () => {
    // A refusal must not be a stall forever: the point of going home is that it comes back. Once
    // the fresh potatoes are off its hands the same bot pulls the turned tiles as Day-Old goods.
    //
    // It stops at the ARMS rather than at the shelf on purpose. The dock's shelf holds one
    // product at a time — `unloadIntoDock`'s documented stall — so a wilted zone genuinely does
    // back its own shed up, and that is a jam the player can see, not a hole.
    const { state } = farmWithHarvester(11_707);
    const bot = state.bots[0]!;

    stepUntil(state, 5_000, () => bot.carryCount > 0);
    wiltEveryRow(state);

    const gotThere = stepUntil(state, 20_000, () => bot.carryItem === ItemId.DayOldPotato);
    expect(gotThere, 'the turned row never got picked up at all').toBeGreaterThan(0);
    expect(bot.carryCount).toBeGreaterThan(0);
  });

  it('conserves every unit across a shift on a row that turns mid-round', () => {
    // The same story with the books open: harvest a while, turn the row, run a few thousand
    // ticks, and count everything the world holds. Crops leave the ground and goods arrive.
    //
    // The window is deliberately shorter than both clocks that would legitimately eat the
    // evidence — a turned tile collapses to compost 12,000 ticks after it turns, and a potato in
    // the bag has 18,000 — because this test is about DELETION, and a test that let spoilage in
    // would be asserting the sweep works rather than that the transfers do.
    const { state, dock } = farmWithHarvester(11_708);
    const bot = state.bots[0]!;

    stepUntil(state, 5_000, () => bot.carryCount > 0);
    wiltEveryRow(state);
    const pulled = () => bot.carryCount + dock.cargoCount;

    const before = pulled();
    const standingBefore = state.field.filter((tile) => tile.crop !== CropId.None).length;
    stepMany(state, 6_000);
    const standingAfter = state.field.filter((tile) => tile.crop !== CropId.None).length;

    // Every tile that left the ground is a unit or more in somebody's hands, and no tile that
    // left the ground is nowhere. `fertility + bonus` is at least one per tile, so this is a
    // floor rather than an equality — which is the direction that catches a deletion.
    expect(standingAfter).toBeLessThanOrEqual(standingBefore);
    expect(pulled(), 'goods went missing over the shift').toBeGreaterThanOrEqual(
      before + (standingBefore - standingAfter),
    );
  });
});

// --- the seed pocket's own edge, which door 9 shares -----------------------------------------

describe('the seed pocket across a product switch', () => {
  it('keeps its seeds when the bot changes product mid-round', () => {
    // The pocket is a second armful with a second edge, and the switch above is where a fix that
    // reset "the bot" rather than "the bot's arms" would quietly empty it.
    const { state } = farmWithHarvester(11_709);
    const bot = state.bots[0]!;

    stepUntil(state, 5_000, () => bot.seedCount > 0);
    wiltEveryRow(state);
    // Read AFTER the row turns, so this is what the pocket held walking into the switch.
    const pocketed = bot.seedCount;
    expect(pocketed).toBeGreaterThan(0);
    expect(pocketed).toBeLessThanOrEqual(BOT_SEED_POCKET_CAPACITY);

    stepUntil(state, 3_000, () => bot.phase === BotPhase.Returning);
    expect(bot.seedItem).toBe(ItemId.PotatoSeed);
    expect(bot.seedCount, 'the pocket emptied itself on a product switch').toBeGreaterThanOrEqual(
      pocketed,
    );
  });
});

// --- THE MOVE CENSUS ------------------------------------------------------------------------
//
// Item 115 wrote the list of PLACES. This is the list of MOVES, and it is derived from that one
// rather than beside it: a container is a name and a number, the node sweep finds the names, and
// `GOODS_COUNTS` in `goods.ts` says how each name's number is spelled. Every line in the sim that
// writes one of those numbers is a transfer, and every transfer is below with a verdict on it.
//
// It fails the day somebody adds a transfer, exactly as the node sweep fails the day somebody
// adds a container. There are only ever two legal verdicts, and they are the family's two
// sentences: **does the count survive the move, and does the clock travel with it.**

describe('the move census', () => {
  it('has every transfer of goods in the sim on it, with a verdict on each', () => {
    // Sorted, so the list is the census' own order rather than an argument's. Each row is a VERB
    // — a function and the quantity it changes — because a move is a verb, and two writes to
    // `carryCount` inside one function are one transfer described twice.
    // **ONE LIST, AND IT IS `MOVE_VERDICTS` IN `goods.ts`.** Item 117's first pass wrote the
    // verdicts out as `//` comments beside a hand-copied array here, which made two lists that
    // had to agree and gave the verdicts to a medium nobody can execute. They are data now: the
    // census still fails the day somebody adds a transfer, but greening it means classifying the
    // new line as one of six sentences, and the live harness then holds it to that sentence.
    expect(goodsMoves()).toEqual(Object.keys(MOVE_VERDICTS).sort());
  });

  it('has every door into the player’s bag on it, and says which of them mint', () => {
    // **THE HALF THAT WOULD HAVE CAUGHT DOOR 8**, and the reason the census is two lists rather
    // than one. A hand-back into the bag writes no count at the call site — it calls `addItem` or
    // `addItemFresh`, both of which are ONE row above (`state:addItemFresh:count`) no matter who
    // called them. The bag is the only container whose clock is chosen by which function you
    // call, so its doors are enumerated by CALLER and each caller says which it is.
    //
    // Door 8 was a single `addItem` where an `addItemFresh` belonged, sitting inside a function
    // that already made four correct `addItemFresh` calls. On this list it would have had to be
    // written down as "mints a full window", four lines under four rows that do not.
    // Verdicts live in `goods.ts` as DATA rather than as comments here, because
    // `move-census-live.test.ts` executes them: every CARRIES door is driven in a live world
    // and made to hand its clock back, and every MINTS-SHELF-STABLE door is made to prove that
    // what it stamped a fresh window onto had no window to begin with. Door 8 claimed exactly
    // that and was carrying potatoes.
    expect(bagDoors()).toEqual(Object.keys(BAG_DOOR_VERDICTS).sort());
  });

  it('has an edge for every container the node sweep can find', () => {
    // The two lists, tied together. A container with no transfer into it is either dead code or a
    // census that has stopped looking, and this is what makes the edge list DERIVED rather than
    // merely adjacent: it is item 115's node list, differentiated.
    const state = createWorld(11_710);
    const nodes = new Set(itemBearingPaths(state));
    // The three the node list itself marks as not containers, in its own words: a receipt, an
    // input log, and — in a world with no bots yet — nothing else.
    for (const path of ['stats.salesByItem', 'trace[].command.item']) nodes.delete(path);

    const covered = new Set(GOODS_COUNTS.map((entry) => entry.node));
    for (const node of nodes) {
      expect(covered.has(node), `${node} is a container with no quantity in GOODS_COUNTS`).toBe(
        true,
      );
    }
    // And every quantity in the table is actually written somewhere, so a row cannot rot into a
    // pattern that matches nothing and quietly stops being a check.
    const moves = goodsMoves();
    for (const entry of GOODS_COUNTS) {
      expect(
        moves.some((move) => move.endsWith(`:${entry.quantity}`)),
        `nothing in the sim writes ${entry.quantity} — the census is watching a dead field`,
      ).toBe(true);
    }
  });

  // --- THE TWO COLUMNS ITEM 118 ADDED --------------------------------------------------------
  //
  // A good is three things: how many, what it is, and how long it has left. Every row above was
  // a number saying how many. These are the other two, and each is checked against something
  // outside the table rather than against the table's own opinion of itself.

  it('says WHAT the goods in every container are, and the answer is real', () => {
    // The identity column is either `'state'` — the node field is the id, which is the boring and
    // safe case — or a path into the balance data, which is door 10's shape. A data path that
    // does not exist is a row claiming to have thought about identity while naming nothing, so
    // every one of them is held to `dataItemFields()`, which walks the data the way item 115
    // walked a world.
    const dataFields = new Set(dataItemFields());
    for (const entry of GOODS_COUNTS) {
      if (entry.identity === 'state') continue;
      expect(
        dataFields.has(entry.identity),
        `${entry.node}/${entry.quantity} says its id comes from ${entry.identity}, ` +
          'and no such field exists in the balance data',
      ).toBe(true);
    }
    // And the one row whose goods have no name in the world at all is on the census by name, so
    // deleting it is a visible act rather than a quiet narrowing.
    const burnt = GOODS_COUNTS.find((entry) => entry.quantity === 'overcookedCount');
    expect(burnt?.identity, 'door 10 is not on the census').toBe(
      'MACHINE_SPECS[].overcookOutputItem',
    );
  });

  it('has every item id in the BALANCE DATA on a list too, and says what it does', () => {
    // **ITEM 115'S SWEEP, POINTED AT THE OTHER HALF OF THE GAME.** Item 115 walked a live world
    // for every field naming a good, because "a type is what somebody wrote down and a world is
    // what is actually there". True, and it has a blind side: door 10's good is named in a spec
    // table and appears in no world anywhere. So the data gets the same treatment, and the day
    // somebody adds a second grade to a machine this goes red until they say which of four
    // sentences it is.
    expect(dataItemFields()).toEqual(Object.keys(DATA_IDENTITY_VERDICTS).sort());
  });

  it('names exactly one data field that RE-LABELS goods where they stand', () => {
    // The whole point of the verdicts above, in one assertion. Three of the four sentences are
    // harmless — a good that is minted, consumed or looked up leaves its id in a state field the
    // node sweep can see. `Relabels` means units that already exist, in a container, are quietly
    // a different good; that is the only kind the ledger has to read data to get right, and
    // `basketGrades` is where it does.
    const relabels = Object.keys(DATA_IDENTITY_VERDICTS).filter(
      (path) => DATA_IDENTITY_VERDICTS[path] === DataIdentity.Relabels,
    );
    expect(relabels).toEqual(['MACHINE_SPECS[].overcookOutputItem']);
  });

  it('gives every container a clock or a reason it has none', () => {
    // The fourth column's own half of the argument. Whether the named clock is a REAL field, and
    // whether every real field is named, is asked in `move-census-live.test.ts` against the
    // save fixture — that file owns the world rich enough to have one of everything in it.
    //
    // A `null` clock with no reason beside it is the sentence three items in this family shipped
    // a bug inside of, so the reason is the assertion here rather than a convention.
    for (const entry of GOODS_COUNTS) {
      if (entry.clock !== null) continue;
      expect(
        entry.clockless,
        `${entry.node}/${entry.quantity} has no clock and no reason why not`,
      ).toBeTruthy();
    }
    // Nine clocks, and door 11's own table listed eight — the bag's `spoilAtTick` is the ninth,
    // and it is on the census here for the same reason the other eight are.
    const clocks = new Set(
      GOODS_COUNTS.map((entry) => entry.clock).filter((clock): clock is string => clock !== null),
    );
    expect([...clocks].sort()).toEqual([
      'belts[].items[].freshTicks',
      'bots[].carryFreshTicks',
      'contracts[].inTransitFreshTicks',
      'contracts[].stockedFreshTicks',
      'grabbers[].heldFreshTicks',
      'inventory[].stacks[].spoilAtTick',
      'machines[].cargoFreshTicks',
      'machines[].inputFreshTicks[]',
      'machines[].outputFreshTicks',
    ]);
  });
});

// --- the ledger: the census, run against a live world ----------------------------------------

describe('the goods ledger', () => {
  it('counts every unit in a world, wherever it is standing', () => {
    // The ledger reads the same nodes the sweep enumerates, so "what the world is holding" has
    // one definition rather than one per test. Built here out of a bag, a belt, a claw, a cellar
    // and a bot, so a hole in any of the five shows up as a number that does not add up.
    const { state, dock } = farmWithHarvester(11_711);
    const bot = state.bots[0]!;
    jamProduceShelf(state, dock);
    stepUntil(state, 20_000, () => bot.carryCount >= BOT_CARRY_CAPACITY);

    const ledger = goodsLedger(state);
    expect(ledgerCount(ledger, ItemId.RussetPotato), 'the armful is in the books').toBe(
      bot.carryCount,
    );
    expect(ledgerCount(ledger, ItemId.ChiliPepper), 'and so is the jam').toBe(dock.cargoCount);
    expect(ledgerCount(ledger, ItemId.PotatoSeed), 'bag plus pocket').toBe(
      itemCount(state, ItemId.PotatoSeed) + bot.seedCount,
    );
    expect(ledgerClock(ledger, ItemId.RussetPotato), 'and the clock came with it').toBe(
      bot.carryFreshTicks,
    );
  });

  it('BOXING ANY LADEN CONTAINER CONSERVES THE COUNT AND NEVER ADDS CLOCK', () => {
    // **THE GENERAL FORM OF DOORS 8, 8b, 8c AND OF ITEM 110's ORIGINAL BUG**, asked of every
    // machine kind the game will let you box, with goods put in through the machine's own front
    // door. Every one of those doors was a container handing its load back through the wrong
    // function; this asks the whole question of the whole set at once.
    //
    // The kinds are derived — every spec with a boxed item — rather than listed, so a new
    // container arrives inside this test instead of beside it, and every one of them is driven
    // through the PLAYER'S OWN front door rather than a helper: `LoadMachine` fills a container
    // or a hopper, and `DeconstructMachine` boxes it, in one step so the machine never gets a
    // tick in between to turn its ingredients into something else.
    const boxable = MACHINE_SPECS.filter((spec) => boxedItemForMachine(spec.kind) !== null);
    expect(boxable.length, 'the build menu is not empty').toBeGreaterThan(10);

    const boxedWithGoods: string[] = [];
    const unreached: string[] = [];
    for (const spec of boxable) {
      const state = createWorld(11_712 + spec.kind);
      const machine = spawnMachine(state, spec.kind, 6, 6);
      if (machine === null) {
        unreached.push(`${spec.slug}: will not stand on open ground`);
        continue;
      }
      const hoppers = machineHoppers(spec);
      const item = hoppers.length > 0 ? hoppers[0]!.item : ItemId.RussetPotato;

      // **AGED IN THE BAG BEFORE IT GOES IN**, which is the whole design of this test. A mint on
      // the way out is only visible against goods that had already lost time on the way in — box
      // something brand new and a stamped full window looks exactly like a preserved one.
      addItem(state, item, 4);
      stepMany(state, 6_000);
      const clockIn = remainingFreshness(state, item);
      standOn(state, 6, 6);

      const before = goodsLedger(state);
      run(state, { type: 'LoadMachine', machineId: machine.id, item, count: 4 });
      const holding =
        machine.cargoCount + machine.inputCounts.reduce((sum, count) => sum + count, 0);
      if (holding <= 0) {
        unreached.push(`${spec.slug}: has no door a hand can put that good through`);
        continue;
      }
      run(state, { type: 'DeconstructMachine', machineId: machine.id });
      if (state.machines.some((entry) => entry.id === machine.id)) {
        unreached.push(`${spec.slug}: loaded, then refused the box (mid-batch, by design)`);
        continue;
      }
      boxedWithGoods.push(spec.slug);

      const after = goodsLedger(state);
      expect(ledgerCount(after, item), `boxing a ${spec.slug} changed how many units exist`).toBe(
        ledgerCount(before, item),
      );
      if (perishable(item)) {
        expect(
          ledgerClock(after, item),
          `boxing a ${spec.slug} handed back more clock than went in`,
        ).toBeLessThanOrEqual(clockIn);
      }
    }

    // **THE REACH, WRITTEN DOWN, BECAUSE A CENSUS THAT HIDES ITS REACH IS A LIST AGAIN.**
    //
    // Everything this test could actually load and then box is checked above. Everything it could
    // not is below WITH ITS REASON, pinned rather than mentioned — so the day a machine becomes
    // loadable or boxable in a state it was not, this line goes red and somebody decides whether
    // that is a feature. The big group is the production line, and its reason is a rule rather
    // than a gap: a machine with ingredients and room IS mid-batch, and `applyDeconstructMachine`
    // refuses to box one. `freshness-doors.test.ts` drives those two rooms — hopper and basket —
    // by stopping the machine first, which is the supported way to box a loaded Washer.
    expect(unreached).toEqual([
      // **THE PRODUCTION LINE, AND ITS REASON IS A RULE RATHER THAN A GAP.** A machine with
      // ingredients and room IS mid-batch, and `applyDeconstructMachine` refuses to box one —
      // "stop it first" is the supported way, and `freshness-doors.test.ts` does exactly that to
      // drive the hopper and the basket. Loading these and finding the box refused is therefore
      // this test confirming a design rule, not skipping a door.
      'chip-kitchen: loaded, then refused the box (mid-batch, by design)',
      'sprinkler: has no door a hand can put that good through',
      'washer: loaded, then refused the box (mid-batch, by design)',
      'slicer: loaded, then refused the box (mid-batch, by design)',
      'fryer: loaded, then refused the box (mid-batch, by design)',
      'seasoner: loaded, then refused the box (mid-batch, by design)',
      'bagger: loaded, then refused the box (mid-batch, by design)',
      // The liquid layer holds millilitres, and there is no item id for a millilitre — stated in
      // `applyDeconstructMachine`'s own header, where a tank's contents go on the ground.
      'pump: has no door a hand can put that good through',
      'tank: has no door a hand can put that good through',
      'piped-sprinkler: has no door a hand can put that good through',
      'irrigation-hub: has no door a hand can put that good through',
      'recirculator: has no door a hand can put that good through',
      'juicer: loaded, then refused the box (mid-batch, by design)',
      'kettle: has no door a hand can put that good through',
      'grinder: loaded, then refused the box (mid-batch, by design)',
      'carbonator: has no door a hand can put that good through',
      // **THE FIVE WORTH READING TWICE.** Each of these DOES hold goods and each refuses a hand,
      // because its door is a belt, an arm, a bot or a contract instead. They are exactly the
      // machines this family's bugs lived in, so none of them is left to this general sweep:
      // the depot is item 115's `freshness-depot-and-bot.test.ts`, and the harvester dock's
      // three rooms — shelf, seed shelf and the bot standing in it — are doors 8, 8b and 8c at
      // the top of this file.
      'delivery-cart: has no door a hand can put that good through',
      'truck-depot: has no door a hand can put that good through',
      'belt-junction: has no door a hand can put that good through',
      'composter: loaded, then refused the box (mid-batch, by design)',
      'orange-tree: has no door a hand can put that good through',
      'lemon-tree: has no door a hand can put that good through',
      'kola-tree: has no door a hand can put that good through',
      'harvester-dock: has no door a hand can put that good through',
      'planter-dock: has no door a hand can put that good through',
      'drone-bay: has no door a hand can put that good through',
    ]);
    expect(boxedWithGoods, 'the containers this test actually loaded and boxed').toEqual([
      'syrup-mixer',
      'bottler',
      'six-packer',
      'combo-packer',
      'root-cellar',
      'hand-cart',
      'maintenance-station',
      'parts-bench',
    ]);
  });

  it('BOXING A PART-BURNT BASKET HANDS BACK BOTH GRADES, NOT TWO OF THE BETTER ONE', () => {
    // **DOOR 10 ASKED OF THE FUNCTION DOORS 8, 8b AND 8c ALL LIVED IN.** `applyDeconstructMachine`
    // empties a basket through `takeOneOutput` in a loop, and that is the one take path in the
    // game that knows a Fryer's basket is two goods at once. So the sim was already right — and
    // this test could not have been written before item 118, because the instrument it needs is
    // a ledger that can tell a RusticStyleChips from a PlainChips, and until now there was not
    // one. The old books recorded four PlainChips going into the box and four coming out, which
    // is exactly what laundering three burnt chips into good ones also looks like.
    const state = createWorld(11_715);
    const spec = machineSpec(MachineKind.Fryer)!;
    const fryer = spawnMachine(state, MachineKind.Fryer, 6, 6)!;
    fryer.outputItem = ItemId.PlainChips;
    fryer.outputCount = spec.outputCapacity;
    stepMany(state, OVERCOOK_BLOCKED_TICKS * 3);

    const before = goodsLedger(state);
    const burnt = ledgerCount(before, ItemId.RusticStyleChips);
    const good = ledgerCount(before, ItemId.PlainChips);
    expect(burnt, 'three intervals of nobody coming for it').toBe(3);
    expect(good).toBe(spec.outputCapacity - 3);

    standOn(state, 6, 6);
    run(state, { type: 'DeconstructMachine', machineId: fryer.id });
    expect(
      state.machines.some((entry) => entry.id === fryer.id),
      'it went in the box',
    ).toBe(false);

    // In the bag now, and still the same two goods in the same two amounts. A burnt chip sells
    // for 70% of a seasoned one, so a grade that changed in the box would be money out of thin air.
    expect(itemCount(state, ItemId.RusticStyleChips), 'the burnt chips came back burnt').toBe(
      burnt,
    );
    expect(itemCount(state, ItemId.PlainChips)).toBe(good);
  });

  it('a transport loop running by itself neither mints nor deletes, over an hour', () => {
    // No crops, no recipes, no player: a cart, two arms, a belt and a cellar, and nothing in the
    // world that is allowed to CREATE a good. So the ledger's total is a constant and its clock
    // only ever falls — which is the whole family's claim, stated once over moving parts rather
    // than once per door.
    const state = createWorld(11_713);
    const from = spawnMachine(state, MachineKind.HandCart, 0, 0)!;
    spawnGrabber(state, GrabberTier.Mk1, 1, 0, Direction.East, 0);
    spawnBelt(state, BeltTier.Basic, 2, 0, Direction.East, 4);
    spawnGrabber(state, GrabberTier.Mk1, 6, 0, Direction.East, 0);
    spawnMachine(state, MachineKind.RootCellar, 7, 0)!;

    addItem(state, ItemId.RussetPotato, 10);
    standOn(state, 0, 0);
    run(state, { type: 'LoadMachine', machineId: from.id, item: ItemId.RussetPotato, count: 10 });

    const start = goodsLedger(state);
    const held = ledgerCount(start, ItemId.RussetPotato);
    expect(held, 'ten potatoes went in').toBe(10);

    let clock = ledgerClock(start, ItemId.RussetPotato);
    for (let i = 0; i < 60; i++) {
      stepMany(state, 200);
      const now = goodsLedger(state);
      const potatoes = ledgerCount(now, ItemId.RussetPotato);
      const compost = ledgerCount(now, ItemId.Compost);
      expect(potatoes + compost, `a unit appeared or vanished at tick ${state.tick}`).toBe(held);
      if (potatoes === 0) break;
      const nowClock = ledgerClock(now, ItemId.RussetPotato);
      expect(nowClock, `the clock went UP at tick ${state.tick}`).toBeLessThanOrEqual(clock);
      clock = nowClock;
    }
    // And the run was long enough to be worth something: the load actually moved.
    expect(ledgerCount(goodsLedger(state), ItemId.RussetPotato)).toBeLessThanOrEqual(held);
  });
});
