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
  addItem,
  boxedItemForMachine,
  createWorld,
  cropSpec,
  itemCount,
  machineHoppers,
  machineSpec,
  plantCrop,
  putStorage,
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
  ledgerCount,
  testFilesCalling,
} from './goods';

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
}

/** Step until the predicate holds, or give up. Returns the tick it happened on, or -1. */
function stepUntil(state: WorldState, limit: number, done: () => boolean): number {
  for (let i = 0; i < limit; i++) {
    stepMany(state, 1);
    if (done()) return state.tick;
  }
  return -1;
}

/**
 * **TURN EVERY STANDING ROW INTO A CROP THE BOT IS NOT CARRYING**, ripe and waiting.
 *
 * **DOOR 9'S NEW TRIGGER** (item 124). This replaces `wiltEveryRow`, which set `readyAge` past
 * `WILT_GRACE_TICKS + WILT_WINDOW_TICKS` so every tile handed back `spec.dayOldItem` instead of
 * `spec.yieldItem`. Nothing wilts any more, so that trigger is gone — and **the property door 9
 * guards is not**, which is exactly the mistake this comment exists to stop somebody making:
 *
 *   * `harvestUnderBot` reads **`tile.crop`**, not `zone.crop`;
 *   * `nextReadyTile` scans a zone on `isTileReady` alone, with no crop-identity filter at all;
 *   * `applyPlantTile` puts any seed in any farm tile, zone or no zone, and `SetZoneCrop`
 *     re-points a zone while a bot is already out on its round holding the last crop.
 *
 * So a bot with potatoes in its arms still walks onto a tile whose produce is a chili, and still
 * has to send the armful home whole rather than overwrite it. Same door, same deletion, same
 * four tests — one keypress instead of half an hour of not looking.
 */
function foreignCropEveryRow(state: WorldState): void {
  const foreign = cropSpec(CropId.ChiliPepper)!;
  for (let i = 0; i < state.field.length; i++) {
    const tile = state.field[i]!;
    if (tile.crop === CropId.None) continue;
    tile.crop = CropId.None;
    plantCrop(state, tile, foreign);
    tile.growth = tile.growthTarget;
  }
}

// --- doors 8, 8b and 8c: boxing a dock with a laden bot inside it --------------------------

describe('boxing a dock that still has a laden bot in it', () => {
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

// --- door 9: a row that becomes another crop under a working bot ----------------------------

describe('a bot whose row becomes a crop it is not carrying', () => {
  it('THE DELETION (door 9): the armful it is already holding is not overwritten', () => {
    // One zone holding two item ids, which a hand-planted row or a re-pointed `SetZoneCrop`
    // produces for free. `takeHarvest` returns the tile's own produce, the switch sets
    // `phase = Returning`, and then the very next line zeroed the count it was about to send
    // home. The comment called the case "impossible by construction" three words after handling
    // it. (Originally triggered by a row turning Day-Old; item 124 deleted that grade and did
    // not delete this door — see `foreignCropEveryRow`.)
    const { state, dock } = farmWithHarvester(11_705);
    const bot = state.bots[0]!;

    const picked = stepUntil(state, 5_000, () => bot.carryCount > 0);
    expect(picked, 'it pulled a fresh tile first').toBeGreaterThan(0);
    expect(bot.carryItem).toBe(ItemId.RussetPotato);

    // And now the rest of the row is something else.
    foreignCropEveryRow(state);
    const held = bot.carryCount;
    expect(held).toBeGreaterThan(0);

    // The next errand is the one that used to delete them: it walks onto a turned tile, and
    // under the old rule the armful in its hands was overwritten by what it found there.
    const delivered = stepUntil(state, 10_000, () => dock.cargoCount > 0);
    expect(delivered, 'it reached the shed').toBeGreaterThan(0);

    // Wherever they are — still in its arms or already on the shelf — the count is the count.
    // Under the old rule the shelf took the OTHER crop and the potatoes were simply gone.
    expect(dock.cargoItem, 'the shelf took the wrong product entirely').toBe(ItemId.RussetPotato);
    const russets = dock.cargoCount + (bot.carryItem === ItemId.RussetPotato ? bot.carryCount : 0);
    expect(russets, 'three potatoes stopped existing').toBeGreaterThanOrEqual(held);
  });

  it('leaves the foreign tile standing rather than pulling what it cannot carry', () => {
    // The fix's shape, and it is the shape the seed-pocket check four lines above already uses:
    // ASK BEFORE THE PULL. A bot holding potatoes that walks onto a chili tile takes nothing and
    // goes home — the tile is still there next round, which is a stall a player can see.
    const { state } = farmWithHarvester(11_706);
    const bot = state.bots[0]!;

    stepUntil(state, 5_000, () => bot.carryCount > 0);
    expect(bot.carryItem).toBe(ItemId.RussetPotato);
    foreignCropEveryRow(state);

    const standing = state.field.filter((tile) => tile.crop !== CropId.None).length;
    expect(standing, 'a field of foreign rows').toBeGreaterThan(0);

    // It walks to a foreign tile, refuses it, and heads home. Nothing is pulled that has nowhere
    // to go, so the count of standing crops cannot fall while the bot's arms hold the other id.
    stepUntil(state, 3_000, () => bot.phase === BotPhase.Returning);
    expect(state.field.filter((tile) => tile.crop !== CropId.None).length).toBe(standing);
    expect(bot.carryItem, 'still holding what it walked out with').toBe(ItemId.RussetPotato);
  });

  it('conserves every unit across a shift on a row that changes crop mid-round', () => {
    // The same story with the books open: harvest a while, switch the row, run a few thousand
    // ticks, and count everything the world holds. Crops leave the ground and goods arrive.
    //
    // It used to need a window short enough to keep two spoilage clocks out of the evidence.
    // Item 124 deleted both, so the count is now unconditional: nothing in this world can turn
    // into anything, and a unit that is missing was deleted.
    const { state, dock } = farmWithHarvester(11_708);
    const bot = state.bots[0]!;

    stepUntil(state, 5_000, () => bot.carryCount > 0);
    foreignCropEveryRow(state);
    const pulled = () => bot.carryCount + dock.cargoCount;

    const before = pulled();
    const standingBefore = state.field.filter((tile) => tile.crop !== CropId.None).length;
    stepMany(state, 6_000);
    const standingAfter = state.field.filter((tile) => tile.crop !== CropId.None).length;

    // Every tile that left the ground is a unit or more in somebody's hands, and no tile that
    // left the ground is nowhere. `HARVEST_BASE_COUNT + bonus` is at least one per tile, so this
    // is a floor rather than an equality — the direction that catches a deletion.
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
    // reset "the bot" rather than "the bot's arms" would quietly empty it. Note the pocket keeps
    // POTATO seeds while the row is chili: the two pockets switch product independently, which
    // is the whole reason this edge is its own test.
    const { state } = farmWithHarvester(11_709);
    const bot = state.bots[0]!;

    stepUntil(state, 5_000, () => bot.seedCount > 0);
    foreignCropEveryRow(state);
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

  it('keeps the two NAME-BLIND guards in more than one file, and says so out loud', () => {
    // **THE HALF OF ITEM 123 THAT IS NOT ABOUT THE CENSUS AT ALL.** `worldDiff` and
    // `unfilledNumbers` are the only two guards in this family that name no field, which makes
    // them the only two that cover a count, a dial or a cursor added tomorrow. Both used to be
    // asserted in `move-census-live.test.ts` and nowhere else, so deleting that one file took the
    // whole name-blind layer with it — and it would have gone QUIETLY, because a guard against
    // unknown fields is not missed by anyone reading a list of known ones. Item 119 spread the
    // clock scenarios across five files for exactly this reason and these two were left behind.
    //
    // They are spread now, and this is the part that notices if they stop being. It lives in a
    // THIRD file on purpose: put the counter in either of the two homes and deleting that home
    // deletes the counter with it, which is the same bug wearing a hat.
    for (const guard of ['worldDiff', 'unfilledNumbers']) {
      const homes = testFilesCalling(guard);
      expect(
        homes.length,
        `${guard} is asserted in ${homes.join(', ')} — one file, so deleting it un-guards ` +
          'every field nobody has thought of yet. Spread it back out.',
      ).toBeGreaterThan(1);
    }
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

    for (let i = 0; i < 60; i++) {
      stepMany(state, 200);
      const potatoes = ledgerCount(goodsLedger(state), ItemId.RussetPotato);
      expect(potatoes, `a unit appeared or vanished at tick ${state.tick}`).toBe(held);
    }
  });
});
