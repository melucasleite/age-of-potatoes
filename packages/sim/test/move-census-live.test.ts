// **THE CENSUS, EXECUTED** (item 117, second pass).
//
// The first pass built the list of MOVES and gave every row a verdict. That was the right list,
// and it left one thing undone that the item asked for in as many words: *"for each transfer
// assert both invariants this family keeps breaking — count is conserved and the clock travels."*
// The verdicts were prose. Nothing ran them.
//
// The distinction is this family's whole history in one line. Item 115 shipped a node sweep whose
// rows each carried a careful sentence about where the clock came from, and three of those
// sentences were wrong — not because the sweep was badly made, but because a sentence in a comment
// is checked by whoever reads it, and the people reading were the same people who wrote the bug.
// Door 8 sat under a comment that lectured three times about the clock leaving with the goods.
//
// So every row on the census is now DATA (`MOVE_VERDICTS` in `goods.ts`), and this file is the
// thing that holds the code to it: each verb is driven in a live world, the ledger is read before
// and after, and the row's own verdict decides what must be true. A row that claims to conserve
// over code that deletes is a red test, not a nice piece of prose.
//
// **THREE THINGS THIS ADDS THAT THE LIST COULD NOT DO ON ITS OWN.**
//
//   1. **The conserving rows are executed.** Doors 8, 8b, 8c and 9 were all *count or clock*
//      failures on rows that would have been labelled "conserving" by anyone writing the list.
//   2. **The MINTS-SHELF-STABLE doors are falsified rather than trusted.** A door that stamps a
//      fresh window is only harmless if what it stamped has no window. Door 8 claimed exactly
//      that defence and was carrying potatoes. That claim is now checked against the goods that
//      actually arrive.
//   3. **SAVE/LOAD IS ON THE CENSUS AT LAST, AND IT COULD NOT HAVE BEEN BEFORE.** See the last
//      describe block — it is the third axis, and both existing sweeps are structurally blind
//      to it.

import { describe, expect, it } from 'vitest';

import {
  type Machine,
  type WorldState,
  BeltTier,
  BotKind,
  BotPhase,
  COMPOST_PER_SPOILED_ITEM,
  CropId,
  Direction,
  FIELD_TILES_WIDE,
  GrabberTier,
  ItemId,
  MachineKind,
  OVERCOOK_BLOCKED_TICKS,
  SUBTILE,
  addItem,
  beltInsert,
  createWorld,
  cropSpec,
  depotAccept,
  deserialize,
  freshnessTicks,
  fromPayload,
  machineHoppers,
  machineSpec,
  plantCrop,
  remainingFreshness,
  serialize,
  spawnBelt,
  spawnBot,
  spawnGrabber,
  spawnMachine,
  spawnZone,
  step,
  stepMany,
  toPayload,
} from '../src/index';
import {
  type ClockSite,
  type GoodsHolding,
  BAG_DOOR_VERDICTS,
  BagDoorVerdict,
  GOODS_COUNTS,
  MOVE_VERDICTS,
  MoveVerdict,
  basketGrades,
  boxLedger,
  clockBearingPaths,
  clockFieldCoverage,
  unfilledNumbers,
  goodsLedger,
  itemBearingPaths,
  ledgerClock,
  ledgerClocks,
  ledgerCount,
  ledgerDelta,
  ledgerItems,
  perishable,
  sumBoxes,
  sumLedger,
  unnamedGoods,
  worldDiff,
  zeroingIsCaught,
} from './goods';

// --- the harness -----------------------------------------------------------------------------

function standOn(state: WorldState, tileX: number, tileY: number): void {
  state.player.xSub = tileX * SUBTILE + SUBTILE / 2;
  state.player.ySub = tileY * SUBTILE + SUBTILE / 2;
}

function run(state: WorldState, command: Parameters<typeof step>[1]['commands'][number]): void {
  step(state, { tick: state.tick, commands: [command] });
}

function stepUntil(state: WorldState, limit: number, done: () => boolean): number {
  for (let i = 0; i < limit; i++) {
    stepMany(state, 1);
    if (done()) return state.tick;
  }
  return -1;
}

/**
 * **HOW LONG GOODS ARE LEFT TO AGE BEFORE A SCENARIO MOVES THEM**, and it is not a detail.
 *
 * A mint is a clock being set to a full window. Against goods that are already at a full window a
 * mint is INVISIBLE — the number before and the number after are the same, the test passes, and
 * the door stays open. Item 117's own audit found exactly this shape in `bots.test.ts`: a test
 * that asserted `spoilAtTick > tick`, which is true of any clock including a brand-new one.
 *
 * So everything a scenario is going to move is aged first, and `checkMove` below REFUSES a
 * conserving scenario that has not done it. A harness that cannot see the bug it exists for
 * should say so out loud rather than pass.
 *
 * **THIS IS NOT A HYPOTHETICAL.** The bespoke door-8 test further down was written without an
 * ageing step, and with door 8 deliberately re-opened it stayed GREEN — the armful's clock was
 * one tick short of a full window and the mint hid inside the difference. The guard covers the
 * table-driven checks; that one had to be taught the same lesson by hand.
 */
const AGE_TICKS = 6_000;

interface MoveCheck {
  /** What is being driven, in English. */
  readonly name: string;
  /** Census rows this drives. Every one must be a key of `MOVE_VERDICTS`. */
  readonly covers: readonly string[];
  /**
   * Bag doors this drives, from `BAG_DOOR_VERDICTS`. A SEPARATE FIELD because they are a separate
   * list answering a separate question — the census rows are about the count, the doors are about
   * the window — and collapsing the two is how a hand-back gets checked for the thing it did not
   * get wrong. Door 8 conserved its count perfectly.
   */
  readonly doors?: readonly string[];
  /**
   * Override the verdict derived from `covers`, for the one case that needs it: several census
   * rows are HALVES of a transfer. `state:removeItem:count` conserves when something catches what
   * it hands out and is a plain deletion when nothing does, and which of those it is depends on
   * the caller rather than the row. A scenario driving one half on purpose says so here.
   */
  readonly verdict?: MoveVerdict;
  /**
   * Set to a reason when the goods this moves have no clock at all (seeds, boxes, compost), which
   * makes the mint check vacuous rather than skipped. A REASON, not a boolean, because "this one
   * is exempt" is the sentence three items in this family shipped a bug inside of.
   */
  readonly clockless?: string;
  /** Build a world with its goods already aged, and return the move to make. */
  build(): { state: WorldState; act: () => void };
}

/**
 * The verdict a scenario is held to: the WEAKEST claim among the rows it drives.
 *
 * A scenario that touches both a conserving row and a sink is only entitled to the sink's
 * promise, because the sink is free to have eaten the difference. Taking the weakest is what
 * keeps one scenario covering several rows honest — the alternative is a scenario quietly
 * borrowing a strong assertion from one row and applying it to a verb that never made it.
 */
function combinedVerdict(covers: readonly string[]): MoveVerdict | 'mixed' {
  let source = false;
  let sink = false;
  let transform = false;
  for (const row of covers) {
    const verdict = MOVE_VERDICTS[row];
    if (verdict === MoveVerdict.Source) source = true;
    else if (verdict === MoveVerdict.Sink) sink = true;
    else if (verdict === MoveVerdict.Transform) transform = true;
  }
  if (source && sink) return 'mixed';
  if (source) return MoveVerdict.Source;
  if (sink) return MoveVerdict.Sink;
  if (transform) return MoveVerdict.Transform;
  return MoveVerdict.Conserving;
}

/** Whether any perishable in this ledger is carrying a PART-SPENT clock — see `AGE_TICKS`. */
function hasAgedGoods(ledger: Map<ItemId, GoodsHolding>): boolean {
  for (const item of ledgerItems(ledger)) {
    if (!perishable(item)) continue;
    const clock = ledgerClock(ledger, item);
    if (clock > 0 && clock < freshnessTicks(item)) return true;
  }
  return false;
}

/**
 * **DRIVE ONE VERB AND HOLD IT TO ITS OWN VERDICT.**
 *
 * Count first, because count is plan §4 and a deleted potato is worse than a refreshed one; then
 * the clock, because a refreshed potato is what item 035 is for and what four doors got wrong.
 */
function checkMove(check: MoveCheck): void {
  const { state, act } = check.build();
  const before = goodsLedger(state);
  const verdict = check.verdict ?? combinedVerdict(check.covers);

  // The guard that stops this harness from lying about its own reach.
  if (verdict === MoveVerdict.Conserving && check.clockless === undefined) {
    expect(
      hasAgedGoods(before),
      `${check.name}: nothing it moves has a part-spent clock, so a mint would be invisible ` +
        'here. Age the goods, or declare "clockless" with a reason.',
    ).toBe(true);
  }

  act();
  const after = goodsLedger(state);
  const story = () => `${check.name}: ${ledgerDelta(before, after)}`;

  if (verdict === MoveVerdict.Source) {
    expect(sumLedger(after), `${story()} — a SOURCE lost goods`).toBeGreaterThanOrEqual(
      sumLedger(before),
    );
    return;
  }
  if (verdict === MoveVerdict.Sink) {
    expect(sumLedger(after), `${story()} — a SINK minted goods`).toBeLessThanOrEqual(
      sumLedger(before),
    );
    return;
  }
  if (verdict === MoveVerdict.Transform) {
    // Total only. A transformation is free to move the ids around, and the goods whose clock ran
    // out have left — so the SOONEST clock is entitled to rise, and asking it not to would be
    // asserting something false.
    expect(sumLedger(after), `${story()} — a TRANSFORMATION changed the total`).toBe(
      sumLedger(before),
    );
    return;
  }
  if (verdict === 'mixed') return;

  // Conserving: the strict form. Every item, exactly.
  for (const item of ledgerItems(before, after)) {
    expect(ledgerCount(after, item), `${story()} — units of item ${item} changed`).toBe(
      ledgerCount(before, item),
    );
  }
  // **UNIT BY UNIT, NOT MINIMUM AGAINST MINIMUM** (item 118). `ledgerClock` is a minimum across
  // every holder of an id, so a mint on one holder was invisible whenever a second holder was
  // running a sooner clock — measured at 4,321 hiding behind 1,111. The counts are already known
  // equal by the loop above, so the two lists are the same length: pair them freshest-first and
  // no unit can come out ahead of the unit it replaced.
  for (const item of ledgerItems(before, after)) {
    if (!perishable(item)) continue;
    const was = ledgerClocks(before, item).sort((a, b) => b - a);
    const now = ledgerClocks(after, item).sort((a, b) => b - a);
    for (let i = 0; i < Math.min(was.length, now.length); i++) {
      // A zero is "no opinion" rather than "expired" — the game's own reading everywhere a clock
      // is passed — and a take door is entitled to answer it with a full window.
      if (was[i]! <= 0 || now[i]! <= 0) continue;
      expect(
        now[i],
        `${story()} — the ${i + 1}th freshest unit of item ${item} came out FRESHER than it went in`,
      ).toBeLessThanOrEqual(was[i]!);
    }
  }
}

// --- the worlds each scenario is built out of -------------------------------------------------

/** A bag with `count` of `item` in it, already `AGE_TICKS` into its window, and a player beside. */
function agedBag(seed: number, item: ItemId, count: number, tileX = 6, tileY = 6): WorldState {
  const state = createWorld(seed);
  addItem(state, item, count);
  stepMany(state, AGE_TICKS);
  standOn(state, tileX, tileY);
  return state;
}

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

// --- THE CHECKS ------------------------------------------------------------------------------
//
// Each one names the census rows it drives. The coverage test at the bottom then asserts that
// every CONSERVING row in the census is either driven by one of these or written into
// `UNREACHED` with a reason — which is the property that makes this a census rather than a
// selection of tests that happen to exist.

const CHECKS: readonly MoveCheck[] = [
  {
    name: 'a hand loads an aged armful into a container',
    covers: [
      'state:putStorage:cargoCount',
      'state:removeItem:count',
      'state:takeFromStacks:count',
      'state:takeFromStacks:stacks[]',
    ],
    build() {
      const state = agedBag(12_001, ItemId.RussetPotato, 8);
      const cellar = spawnMachine(state, MachineKind.RootCellar, 6, 6)!;
      return {
        state,
        act: () =>
          run(state, {
            type: 'LoadMachine',
            machineId: cellar.id,
            item: ItemId.RussetPotato,
            count: 8,
          }),
      };
    },
  },
  {
    name: 'a hand takes it back out again',
    covers: [
      'state:takeStorage:cargoCount',
      'state:addItemFresh:count',
      'state:addStack:count',
      'state:addStack:stacks[]',
    ],
    build() {
      const state = agedBag(12_002, ItemId.RussetPotato, 8);
      const cellar = spawnMachine(state, MachineKind.RootCellar, 6, 6)!;
      run(state, {
        type: 'LoadMachine',
        machineId: cellar.id,
        item: ItemId.RussetPotato,
        count: 8,
      });
      return {
        state,
        act: () => run(state, { type: 'UnloadMachine', machineId: cellar.id, count: 8 }),
      };
    },
  },
  {
    name: 'a hand loads a machine hopper, and boxing a STARVED one hands it back',
    covers: ['state:putHopper:inputCounts[]', 'state:takeHopper:inputCounts[]'],
    doors: ['tick:applyDeconstructMachine:addItemFresh'],
    build() {
      // A Seasoner with peppers but no chips is starved, so it never runs and stays boxable —
      // `freshness-doors.test.ts`' trick, and the supported way to hold a hopper still.
      const state = agedBag(12_003, ItemId.ChiliPepper, 6);
      const seasoner = spawnMachine(state, MachineKind.Seasoner, 6, 6)!;
      run(state, {
        type: 'LoadMachine',
        machineId: seasoner.id,
        item: ItemId.ChiliPepper,
        count: 6,
      });
      return {
        state,
        act: () => run(state, { type: 'DeconstructMachine', machineId: seasoner.id }),
      };
    },
  },
  {
    name: 'a belt is laid, loaded, and taken up one tile at a time',
    covers: ['state:beltInsert:items[]', 'belts:beltTakeFromTile:items[]'],
    doors: ['tick:applyRemoveBeltTile:addItemFresh'],
    build() {
      const state = agedBag(12_004, ItemId.RussetPotato, 1);
      const belt = spawnBelt(state, BeltTier.Basic, 4, 4, Direction.East, 3)!;
      beltInsert(belt, 0, ItemId.RussetPotato, remainingFreshness(state, ItemId.RussetPotato));
      standOn(state, 4, 4);
      return {
        state,
        act: () => run(state, { type: 'RemoveBeltTile', tileX: 4, tileY: 4 }),
      };
    },
  },
  {
    name: 'a whole loaded belt run is torn up at once',
    covers: [],
    doors: ['tick:applyRemoveBelt:addItemFresh'],
    build() {
      const state = agedBag(12_005, ItemId.RussetPotato, 1);
      const belt = spawnBelt(state, BeltTier.Basic, 4, 4, Direction.East, 3)!;
      beltInsert(belt, 0, ItemId.RussetPotato, remainingFreshness(state, ItemId.RussetPotato));
      standOn(state, 4, 4);
      return { state, act: () => run(state, { type: 'RemoveBelt', beltId: belt.id }) };
    },
  },
  {
    name: 'an arm lifts an aged good off a belt and puts it down again',
    covers: [
      'belts:advanceGrabber:held',
      'belts:grabberSource:items[]',
      'belts:handOffFromHead:items[]',
    ],
    build() {
      const state = agedBag(12_006, ItemId.RussetPotato, 1);
      const belt = spawnBelt(state, BeltTier.Basic, 2, 4, Direction.East, 4)!;
      spawnGrabber(state, GrabberTier.Mk1, 6, 4, Direction.East, 0);
      spawnMachine(state, MachineKind.RootCellar, 7, 4);
      beltInsert(belt, 0, ItemId.RussetPotato, remainingFreshness(state, ItemId.RussetPotato));
      return { state, act: () => stepMany(state, 400) };
    },
  },
  {
    name: 'an arm holding an aged good is torn out of the ground',
    covers: [],
    doors: ['tick:applyRemoveGrabber:addItemFresh'],
    build() {
      const state = agedBag(12_007, ItemId.RussetPotato, 1);
      const belt = spawnBelt(state, BeltTier.Basic, 2, 4, Direction.East, 4)!;
      const grabber = spawnGrabber(state, GrabberTier.Mk1, 6, 4, Direction.East, 0)!;
      beltInsert(belt, 0, ItemId.RussetPotato, remainingFreshness(state, ItemId.RussetPotato));
      stepUntil(state, 600, () => grabber.held !== 0);
      standOn(state, 6, 4);
      return { state, act: () => run(state, { type: 'RemoveGrabber', grabberId: grabber.id }) };
    },
  },
  {
    name: 'a depot takes aged stock off an arm, and a torn-up route hands it back',
    covers: [
      'commerce:depotAccept:stocked',
      'commerce:refundContract:stocked',
      'commerce:refundContract:inTransit',
    ],
    doors: ['commerce:refundContract:addItemFresh'],
    build() {
      const state = agedBag(12_008, ItemId.RussetPotato, 4);
      const depot = spawnMachine(state, MachineKind.TruckDepot, 6, 6)!;
      run(state, {
        type: 'CreateContract',
        depotId: depot.id,
        item: ItemId.RussetPotato,
        quantityPerRun: 4,
        destination: 'Ridgeline Grocers',
      });
      const contract = state.contracts[0]!;
      // Straight off the arm, at the clock the bag's own potatoes are carrying.
      const left = remainingFreshness(state, ItemId.RussetPotato);
      for (let i = 0; i < 4; i++) depotAccept(state, depot, ItemId.RussetPotato, left);
      return {
        state,
        act: () => run(state, { type: 'CancelContract', contractId: contract.id }),
      };
    },
  },
  {
    name: 'a hand loads a delivery cart',
    covers: ['tick:applyLoadCart:cargoCount'],
    build() {
      const state = agedBag(12_009, ItemId.RussetPotato, 6);
      const cart = spawnMachine(state, MachineKind.DeliveryCart, 6, 6)!;
      return {
        state,
        act: () =>
          run(state, {
            type: 'LoadCart',
            cartId: cart.id,
            item: ItemId.RussetPotato,
            count: 6,
          }),
      };
    },
  },
  {
    name: 'a bot carrying an aged armful unloads into its dock',
    covers: [
      'bots:unloadIntoDock:cargoCount',
      'bots:unloadIntoDock:carryCount',
      'bots:unloadIntoDock:seedCount',
      'bots:unloadIntoDock:seedShelfCount',
    ],
    build() {
      const { state } = farmWithHarvester(12_010);
      const bot = state.bots[0]!;
      stepUntil(state, 20_000, () => bot.carryCount > 0 && bot.seedCount > 0);
      // **THE FIELD IS CLEARED SO THE ONLY THING LEFT TO MEASURE IS THE HANDOVER.** Stepping a
      // live farm runs the bot's whole loop, and `harvestUnderBot` is a SOURCE — goods enter the
      // world. A scenario that let it fire while claiming to weigh an unload would be reading the
      // harvest's arrivals as proof the handover conserved, which is a test that cannot fail.
      for (let i = 0; i < state.field.length; i++) {
        const tile = state.field[i]!;
        tile.crop = CropId.None;
        tile.zone = 0;
      }
      const held = bot.carryCount;
      return {
        state,
        act: () => stepUntil(state, 20_000, () => bot.carryCount < held),
      };
    },
  },
  {
    name: 'the goods in a bag turn to compost where they stand',
    covers: ['tick:advanceSpoilage:count', 'tick:advanceSpoilage:stacks[]'],
    build() {
      const state = agedBag(12_011, ItemId.RussetPotato, 5);
      return { state, act: () => stepMany(state, freshnessTicks(ItemId.RussetPotato) + 10) };
    },
  },
  {
    name: 'the goods in a container turn where they stand',
    covers: ['tick:advanceStorageSpoilage:cargoCount'],
    build() {
      const state = agedBag(12_012, ItemId.RussetPotato, 5);
      const cart = spawnMachine(state, MachineKind.HandCart, 6, 6)!;
      run(state, {
        type: 'LoadMachine',
        machineId: cart.id,
        item: ItemId.RussetPotato,
        count: 5,
      });
      return { state, act: () => stepMany(state, freshnessTicks(ItemId.RussetPotato) + 10) };
    },
  },
  {
    name: 'an armful turns to compost in a bot’s arms',
    covers: ['tick:advanceBotSpoilage:carryCount'],
    build() {
      const { state, dock } = farmWithHarvester(12_013);
      const bot = state.bots[0]!;
      // Jam the shelf so the armful can never be put down, and let its clock run out.
      dock.cargoItem = ItemId.ChiliPepper;
      dock.cargoCount = machineSpec(MachineKind.HarvesterDock)!.outputCapacity;
      dock.cargoFreshTicks = 0;
      stepUntil(state, 20_000, () => bot.carryCount > 0 && bot.phase === BotPhase.Returning);
      return { state, act: () => stepMany(state, freshnessTicks(ItemId.RussetPotato) + 10) };
    },
  },
  {
    name: 'a bot pulls a crop out of the ground',
    covers: ['bots:harvestUnderBot:carryCount', 'bots:harvestUnderBot:seedCount'],
    build() {
      const { state } = farmWithHarvester(12_014);
      const bot = state.bots[0]!;
      return { state, act: () => stepUntil(state, 20_000, () => bot.carryCount > 0) };
    },
  },
  {
    name: 'goods are sold at the bin',
    covers: ['state:removeItem:count'],
    doors: ['tick:applySellItem:removeItem'],
    // The census has NO move row for "goods leave the world at the sell bin" — the sale's only
    // trace is the bag door, because `applySellItem` writes no count of its own and goes out
    // through `removeItem`. So the row it covers is a half, and this says which half.
    verdict: MoveVerdict.Sink,
    build() {
      const state = agedBag(12_015, ItemId.RussetPotato, 5);
      return {
        state,
        act: () => run(state, { type: 'SellItem', item: ItemId.RussetPotato, count: 5 }),
      };
    },
  },
  {
    // **DOOR 10, DRIVEN — AND THE ROW THIS USED TO BE UNABLE TO REACH.**
    //
    // `state:takeOneOutput:outputCount` sat in `UNREACHED` with a reason that was true and was
    // not the whole truth: it said a basket needs a machine to have RUN. It also could not have
    // passed. A `Conserving` check on this row went RED AGAINST CORRECT CODE, because the ledger
    // filed every burnt unit under `machines[].outputItem` and taking one out therefore looked
    // like a PlainChips vanishing and a RusticStyleChips appearing from nowhere.
    //
    // The item's own instruction was not to tune the check until it passed. It does not need
    // tuning: `basketGrades` taught the ledger to read the spec, so the burnt unit is on the
    // books as a burnt unit BEFORE the pull, and the pull conserves. That is the census learning
    // to see identity rather than looking away, and this scenario is the proof.
    name: 'a burnt chip is unloaded out of a stopped Fryer’s basket',
    covers: ['state:takeOneOutput:outputCount', 'state:takeOneOutput:overcookedCount'],
    doors: ['tick:applyUnloadMachine:addItemFresh'],
    clockless:
      'PlainChips and RusticStyleChips are both shelf-stable — which is exactly why door 10 ' +
      'is an IDENTITY bug and not a clock one, and why no amount of clock-watching found it.',
    build() {
      const state = createWorld(12_017);
      const spec = machineSpec(MachineKind.Fryer)!;
      const fryer = spawnMachine(state, MachineKind.Fryer, 6, 6)!;
      fryer.outputItem = ItemId.PlainChips;
      fryer.outputCount = spec.outputCapacity;
      // Nothing takes the basket away, so it browns one chip per interval — the layout condition,
      // driven rather than assigned.
      stepMany(state, OVERCOOK_BLOCKED_TICKS * 2);
      expect(fryer.overcookedCount, 'the basket went rustic while nobody came for it').toBe(2);
      // **THROUGH THE PLAYER'S OWN DOOR, NOT THE PRIMITIVE.** `takeOneOutput` hands the unit back
      // as a return value and puts it nowhere; calling it bare deletes a chip and the harness
      // says so, which is the harness working. A transfer needs both ends.
      standOn(state, 6, 6);
      return {
        state,
        act: () => run(state, { type: 'UnloadMachine', machineId: fryer.id, count: 1 }),
      };
    },
  },
  {
    // **THE TRANSFORM ITSELF**, which is the line that has no quantity in it anywhere. A Fryer
    // browning a chip writes `overcookedCount += 1` and nothing else: `outputCount` holds,
    // `outputItem` holds, and one good has become another where it stands. The total is the same
    // and the ids move, which is what a Transform is.
    name: 'a stopped Fryer turns one chip rustic where it stands',
    covers: ['tick:advanceOvercooking:overcookedCount'],
    build() {
      const state = createWorld(12_018);
      const fryer = spawnMachine(state, MachineKind.Fryer, 6, 6)!;
      fryer.outputItem = ItemId.PlainChips;
      fryer.outputCount = machineSpec(MachineKind.Fryer)!.outputCapacity;
      return { state, act: () => stepMany(state, OVERCOOK_BLOCKED_TICKS) };
    },
  },
  {
    name: 'a route runs, and the lorry takes the floor away with it',
    covers: ['commerce:advanceContract:stocked', 'commerce:advanceContract:inTransit'],
    build() {
      const state = agedBag(12_016, ItemId.RussetPotato, 4);
      const depot = spawnMachine(state, MachineKind.TruckDepot, 6, 6)!;
      run(state, {
        type: 'CreateContract',
        depotId: depot.id,
        item: ItemId.RussetPotato,
        quantityPerRun: 4,
        destination: 'Ridgeline Grocers',
      });
      const left = remainingFreshness(state, ItemId.RussetPotato);
      for (let i = 0; i < 4; i++) depotAccept(state, depot, ItemId.RussetPotato, left);
      return { state, act: () => stepMany(state, 3_000) };
    },
  },
];

// --- the tests -------------------------------------------------------------------------------

describe('the move census, executed', () => {
  it('pins the one constant that makes a grand total a conservation law', () => {
    // Every "the total held" assertion in this family is only a conservation law while one
    // spoiled unit makes exactly one Compost. Tune this to 2 and a dozen tests keep passing
    // while quietly checking nothing, which is strictly worse than deleting them.
    expect(COMPOST_PER_SPOILED_ITEM).toBe(1);
  });

  for (const check of CHECKS) {
    it(`${check.name}`, () => {
      checkMove(check);
    });
  }

  it('a machine goes into a box and comes back out, and the box is conserved too', () => {
    // **THE PAPERWORK'S OWN BOOKS**, and the reason they had to exist. `addBoxedMachine` does
    // `slot.count += 1`, so a box sits in the bag wearing a goods count — item 117's first pass
    // assumed the goods ledger already skipped boxes and excused these two rows on that basis.
    // It did not, and every grand-total assertion over a verb that boxes something was quietly
    // off by one. The ledger now counts goods; this counts boxes; both are checked.
    // **THE SPRINKLER, AND THE REASON IS WORTH A LINE.** `PlaceMachine` refuses a kind whose tech
    // is not researched even when the player is holding a box of it, so in a fresh world the
    // sprinkler is the only boxable machine that can actually go back down. Every other kind
    // deconstructs into a box that then will not place — which looks like a leak and is a tech
    // gate, and is exactly the sort of thing a test wants to have found out on purpose.
    const state = createWorld(12_300);
    const machine = spawnMachine(state, MachineKind.Sprinkler, 6, 6)!;
    standOn(state, 6, 6);
    expect(sumBoxes(boxLedger(state)), 'nothing boxed yet').toBe(0);

    run(state, { type: 'DeconstructMachine', machineId: machine.id });
    const boxed = boxLedger(state);
    expect(sumBoxes(boxed), 'the machine went into exactly one box').toBe(1);
    const [boxItem] = [...boxed.keys()];

    // And the goods ledger does NOT see it, which is the fix being asserted rather than assumed.
    expect(ledgerCount(goodsLedger(state), boxItem!), 'a box is not a good').toBe(0);

    // Put it back on the tile it was standing on, so ownership and footprint are known-good and
    // the only thing this can be measuring is whether the box left the bag.
    run(state, { type: 'PlaceMachine', kind: MachineKind.Sprinkler, tileX: 6, tileY: 6 });
    expect(sumBoxes(boxLedger(state)), 'the box came back out of the bag').toBe(0);
    expect(
      state.machines.some((entry) => entry.kind === MachineKind.Sprinkler),
      'and the machine is standing again',
    ).toBe(true);
  });

  it('drives every row the census calls CONSERVING, or says why it cannot', () => {
    // **THE PROPERTY THAT MAKES THIS A CENSUS AND NOT A PILE OF TESTS.** Every conserving row is
    // either executed above or written below with a reason. Add a transfer to the sim and
    // `move-census.test.ts` goes red until it is classified; classify it as conserving and THIS
    // goes red until it is either driven or excused in writing.
    const conserving = Object.keys(MOVE_VERDICTS).filter(
      (row) => MOVE_VERDICTS[row] === MoveVerdict.Conserving,
    );
    const driven = new Set(CHECKS.flatMap((check) => check.covers));
    const missing = conserving.filter((row) => !driven.has(row) && UNREACHED[row] === undefined);
    expect(missing, 'conserving rows with neither a live check nor a stated reason').toEqual([]);

    // And no reason may rot into an excuse for a row that IS driven, or for a row that no longer
    // exists — either would be a census quietly shrinking its own reach.
    for (const row of Object.keys(UNREACHED)) {
      expect(MOVE_VERDICTS[row], `${row} is excused but is not on the census`).toBeDefined();
      expect(driven.has(row), `${row} is excused AND driven — delete the excuse`).toBe(false);
    }
  });

  it('holds every scenario to rows that actually exist', () => {
    // A scenario naming a row that has been renamed away would otherwise go on claiming coverage
    // of something that no longer exists — a census rotting quietly rather than going red.
    for (const check of CHECKS) {
      for (const row of check.covers) {
        expect(
          MOVE_VERDICTS[row],
          `${check.name} claims ${row}, which is not on the census`,
        ).toBeDefined();
      }
      for (const door of check.doors ?? []) {
        expect(
          BAG_DOOR_VERDICTS[door],
          `${check.name} claims bag door ${door}, which is not on the door list`,
        ).toBeDefined();
      }
    }
  });

  it('drives every door that CARRIES a clock back into the bag', () => {
    // The doors list's own conserving half. A `Carries` door is one that promised to hand the
    // deadline back with the goods, which is precisely the promise door 8 broke — so every one of
    // them is either driven above or excused in writing, on the same terms as the census rows.
    const carries = Object.keys(BAG_DOOR_VERDICTS).filter(
      (door) => BAG_DOOR_VERDICTS[door] === BagDoorVerdict.Carries,
    );
    const driven = new Set(CHECKS.flatMap((check) => check.doors ?? []));
    const missing = carries.filter(
      (door) => !driven.has(door) && UNREACHED_DOORS[door] === undefined,
    );
    expect(missing, 'carrying doors with neither a live check nor a stated reason').toEqual([]);
    for (const door of Object.keys(UNREACHED_DOORS)) {
      expect(BAG_DOOR_VERDICTS[door], `${door} is excused but is not a door`).toBeDefined();
      expect(driven.has(door), `${door} is excused AND driven — delete the excuse`).toBe(false);
    }
  });
});

/**
 * **WHAT THIS HARNESS CANNOT DRIVE, AND WHY — WRITTEN DOWN RATHER THAN LEFT OUT.**
 *
 * A census that quietly omits what it could not reach is a list again. Each of these is a
 * conserving row with no live scenario above; the day one becomes drivable the entry should go,
 * and the test above fails if an entry ever names a row that IS driven.
 */
const UNREACHED_DOORS: Readonly<Record<string, string>> = {
  'tick:applyPackCrate:addItemFresh':
    'a crate needs a crate item in the bag and goods matching its manifest; parcels.test.ts owns ' +
    'that fixture and drives the door with it.',
  // `tick:applyUnloadMachine:addItemFresh` used to be excused here, on the grounds that this
  // harness drove the container and the same verb also serves baskets and hoppers. Item 118's
  // burnt-chip scenario drives the basket, so the excuse is gone rather than reworded.
};

const UNREACHED: Readonly<Record<string, string>> = {
  'belts:advanceJunction:items[]':
    'a junction needs two belts pointing into it and a good arriving on the tick the junction ' +
    'polls; the existing belt-tiles suite drives that geometry and this harness would be a ' +
    'second, worse copy of it.',
  'bots:dockAcceptSeed:cargoCount':
    'a planter dock fed by belt — reachable, but it needs a seed source on a belt and a bound ' +
    'zone, which is a fixture rather than a scenario. Seeds carry no clock, so the half of the ' +
    'census this family keeps breaking does not apply to it.',
  'state:addBoxedMachine:count':
    'driven by "a machine goes into a box and comes back out" above, which weighs it on ' +
    '`boxLedger` rather than the goods ledger — the generic harness conserves GOODS, and a boxed ' +
    'machine is not one. Listed here rather than on that scenario because it needs a different ' +
    'instrument, not because nobody looked.',
  'state:takeBoxedMachine:count': 'the other half of the same paperwork, driven by the same test.',
  'state:takeDockShelf:cargoCount':
    'the shelf drains to an arm or a hand; both are driven above through other rows, and the ' +
    'dock-specific path is covered by name in bots.test.ts and freshness-depot-and-bot.test.ts.',
  'state:takeDockSeedShelf:seedShelfCount':
    'seeds only, so there is no clock to travel; the count is covered by door 8c in ' +
    'move-census.test.ts, which boxes a laden seed shelf and counts what comes back.',
  'tick:applyDeconstructMachine:cargoCount':
    'driven exhaustively by the boxing ledger test in move-census.test.ts, across every machine ' +
    'kind the game will let you load and box, which is a stronger check than one scenario.',
  'tick:applyDeconstructMachine:seedShelfCount': 'door 8c, driven in move-census.test.ts.',
  'tick:applyRefillHopper:cargoCount':
    'a planter dock with a bound zone and seeds in the bag; the same fixture the dockAcceptSeed ' +
    'row needs, and clockless for the same reason.',
};

// --- THE MINT DEFENCE, FALSIFIED ---------------------------------------------------------------

describe('the doors that mint a fresh window', () => {
  it('lists which defence each one is making', () => {
    // Three defences, and only one of them is checkable by machine. `MintsNew` is a judgement —
    // "these goods did not exist a moment ago" — and no sweep can confirm it. `MintsShelfStable`
    // is a claim of FACT about the goods, and a fact can be falsified. Door 8 made the second
    // claim while carrying potatoes.
    const shelfStable = Object.keys(BAG_DOOR_VERDICTS).filter(
      (door) => BAG_DOOR_VERDICTS[door] === BagDoorVerdict.MintsShelfStable,
    );
    expect(shelfStable).toEqual([
      'state:createWorld:addItem',
      'tick:advanceSpoilage:addItem',
      'tick:applyDeconstructMachine:addItem',
      'tick:applyUnloadMachine:addItem',
    ]);
  });

  it('a new world’s opening stock is shelf-stable, as `createWorld` claims', () => {
    const state = createWorld(12_100);
    for (const slot of state.inventory) {
      expect(
        freshnessTicks(slot.item),
        `createWorld mints ${slot.item} through addItem, and it RUNS A CLOCK`,
      ).toBe(0);
    }
  });

  it('what spoilage mints is Compost, and Compost keeps no clock', () => {
    expect(freshnessTicks(ItemId.Compost)).toBe(0);
  });

  it('**BOXING A DOCK MINTS ONLY SEEDS — THIS IS DOOR 8’S DEFENCE, CHECKED**', () => {
    // The armful used to come back through this door. It now comes back through `addItemFresh`,
    // and what is left on the minting line is the bot's seed pocket and the dock's seed shelf.
    // Both are shelf-stable, which is the whole reason minting them is free — so this asserts
    // the FACT the defence rests on, against the goods that actually arrive.
    const { state, dock } = farmWithHarvester(12_101);
    const bot = state.bots[0]!;
    dock.cargoItem = ItemId.ChiliPepper;
    dock.cargoCount = machineSpec(MachineKind.HarvesterDock)!.outputCapacity;
    dock.cargoFreshTicks = 0;
    stepUntil(state, 20_000, () => bot.carryCount > 0 && bot.seedCount > 0);
    dock.seedShelfItem = ItemId.PotatoSeed;
    dock.seedShelfCount = 5;

    // **A TEST THAT DOES NOT ASSERT ITS OWN SETUP IS A TEST THAT PASSES WHEN THE SETUP FAILS.**
    // Found the hard way: with door 8 deliberately re-opened this test stayed green, because the
    // armful it was supposed to be weighing had a clock one tick off a full window and the mint
    // was hiding inside the rounding. The armful is aged on purpose now, and the preconditions
    // say so out loud.
    expect(bot.carryCount, 'the bot is holding an armful to hand back').toBeGreaterThan(0);
    stepMany(state, AGE_TICKS);
    expect(bot.carryFreshTicks, 'and the armful has spent real time').toBeLessThan(
      freshnessTicks(ItemId.RussetPotato) - AGE_TICKS + 1,
    );
    expect(bot.carryFreshTicks).toBeGreaterThan(0);

    const before = goodsLedger(state);
    expect(
      ledgerClock(before, ItemId.RussetPotato),
      'the potatoes on the books are the part-spent ones in its arms',
    ).toBe(bot.carryFreshTicks);
    standOn(state, 0, 0);
    run(state, { type: 'DeconstructMachine', machineId: dock.id });
    const after = goodsLedger(state);

    // Nothing vanished, and nothing came back with more clock than it had — the whole family's
    // two sentences, asked of the function all four doors lived in.
    expect(sumLedger(after), `boxing the dock: ${ledgerDelta(before, after)}`).toBe(
      sumLedger(before),
    );
    for (const item of ledgerItems(before, after)) {
      if (!perishable(item)) continue;
      const was = ledgerClock(before, item);
      const now = ledgerClock(after, item);
      if (was <= 0 || now <= 0) continue;
      expect(now, `item ${item} left the box fresher than it went in`).toBeLessThanOrEqual(was);
    }
  });
});

// --- THE THIRD AXIS: SAVE AND LOAD -------------------------------------------------------------
//
// **THE EDGE NEITHER SWEEP CAN SEE, AND THE ITEM ASKED FOR IT BY NAME.**
//
// Item 115's sweep enumerates NODES. Item 117's first pass enumerates count-WRITES. Save/load is
// neither, and that is a fact about the code rather than an oversight: `src/save/` contains **zero
// lines** matching any pattern in `GOODS_COUNTS`, because the serializer does not increment
// counts — it builds new objects out of old ones. `goodsMoves()` therefore returns nothing from
// the entire save subtree, and cannot, whatever anyone adds to it.
//
// And it is the single widest edge in the game. Every other transfer moves one armful between two
// containers. This one moves EVERY GOOD IN THE WORLD across a serialization boundary, and a field
// left out of `toPayload` deletes all of it at once, everywhere, for everyone, silently — the
// exact failure mode plan §4 exists to forbid, at the largest scale the game can produce it.

describe('the save/load round trip', () => {
  /** A world with something in every container the node sweep can find. */
  function loadedWorld(seed: number): WorldState {
    const { state, dock } = farmWithHarvester(seed);
    const bot = state.bots[0]!;
    // Jam the shelf so the bot stalls holding a part-spent armful and a seed pocket.
    dock.cargoItem = ItemId.ChiliPepper;
    dock.cargoCount = 4;
    dock.cargoFreshTicks = 5_000;
    dock.seedShelfItem = ItemId.PotatoSeed;
    dock.seedShelfCount = 7;
    stepUntil(state, 20_000, () => bot.carryCount > 0 && bot.seedCount > 0);

    const cellar = spawnMachine(state, MachineKind.RootCellar, 8, 8)!;
    cellar.cargoItem = ItemId.RussetPotato;
    cellar.cargoCount = 9;
    cellar.cargoFreshTicks = 4_321;

    const seasoner = spawnMachine(state, MachineKind.Seasoner, 10, 10)!;
    const hoppers = machineHoppers(machineSpec(MachineKind.Seasoner)!);
    if (hoppers.length > 0) {
      seasoner.inputCounts[0] = 3;
      seasoner.inputFreshTicks[0] = 2_222;
    }
    seasoner.outputItem = ItemId.BaggedChips;
    seasoner.outputCount = 2;
    seasoner.outputFreshTicks = 0;

    // **THE HOLE ITEM 118'S CLOCK SWEEP FOUND IN THIS VERY FIXTURE.** Every basket above holds a
    // shelf-stable good, so `machines[].outputFreshTicks` was 0 on all five machines — and a
    // round trip that compares 0 to 0 proves nothing whatever about the field. That is precisely
    // why door 11's mutation sweep found this clock "caught by nothing": the assertion existed
    // and the fixture never gave it anything to be about.
    const washer = spawnMachine(state, MachineKind.Washer, 12, 4)!;
    washer.outputItem = ItemId.WashedPotato;
    washer.outputCount = 2;
    washer.outputFreshTicks = 1_234;

    // **AND DOOR 10 GOES ACROSS THE SAVE TOO.** A basket that is two grades at once is the one
    // container whose contents cannot be read off its own fields, so it is the one most worth
    // carrying over a serialization boundary on purpose.
    const fryer = spawnMachine(state, MachineKind.Fryer, 14, 4)!;
    fryer.outputItem = ItemId.PlainChips;
    fryer.outputCount = 4;
    fryer.overcookedCount = 3;

    const belt = spawnBelt(state, BeltTier.Basic, 2, 12, Direction.East, 4)!;
    beltInsert(belt, 0, ItemId.RussetPotato, 3_333);
    const grabber = spawnGrabber(state, GrabberTier.Mk1, 7, 12, Direction.East, 0)!;
    grabber.held = ItemId.RussetPotato;
    grabber.heldFreshTicks = 1_111;

    const depot = spawnMachine(state, MachineKind.TruckDepot, 14, 14)!;
    run(state, {
      type: 'CreateContract',
      depotId: depot.id,
      item: ItemId.RussetPotato,
      quantityPerRun: 2,
      destination: 'Ridgeline Grocers',
    });
    const contract = state.contracts[0]!;
    contract.stocked = 2;
    contract.stockedFreshTicks = 6_543;
    contract.inTransit = 3;
    contract.inTransitFreshTicks = 7_654;

    addItem(state, ItemId.RussetPotato, 5);
    return state;
  }

  it('the fixture fills every container the node sweep can find', () => {
    // **DERIVED, NOT LISTED**, and this is what makes the round trip below fail the day somebody
    // adds a container: the fixture is checked against item 115's own live sweep, so a new place
    // goods can sit turns THIS red until it is filled — and only then can the round trip notice
    // whether the serializer carries it.
    const state = loadedWorld(12_200);
    const nodes = itemBearingPaths(state);
    for (const path of [
      'belts[].items[].item',
      'bots[].carryItem',
      'bots[].seedItem',
      'contracts[].item',
      'grabbers[].held',
      'inventory[].item',
      'machines[].cargoItem',
      'machines[].outputItem',
      'machines[].seedShelfItem',
    ]) {
      expect(nodes, `the round-trip fixture leaves ${path} empty`).toContain(path);
    }
    // The hoppers have no id field of their own, so the sweep cannot see them — item 115's own
    // note. Checked directly instead, because "invisible to the sweep" is exactly the excuse
    // this whole family of bugs has been hiding behind.
    const loadedHopper = state.machines.some((machine) =>
      machine.inputCounts.some((count) => count > 0),
    );
    expect(loadedHopper, 'the fixture leaves every machine hopper empty').toBe(true);
  });

  it('**CARRIES EVERY UNIT AND EVERY CLOCK ACROSS A SAVE**', () => {
    const state = loadedWorld(12_201);
    const before = goodsLedger(state);
    expect(sumLedger(before), 'the fixture is holding goods worth counting').toBeGreaterThan(20);

    const restored = deserialize(serialize(state));
    const after = goodsLedger(restored);

    // Counts first: a field missed by `toPayload` deletes goods, which is plan §4's floor.
    for (const item of ledgerItems(before, after)) {
      expect(
        ledgerCount(after, item),
        `a save/load lost or minted units of item ${item}: ${ledgerDelta(before, after)}`,
      ).toBe(ledgerCount(before, item));
    }
    // Then the clocks: a freshness field missed by `toPayload` reads back as 0, which the game
    // spells "no opinion" and every take-door then answers with a brand-new full window. That is
    // item 110's original bug, reachable by saving and loading rather than by buying a barrow.
    //
    // **EVERY CLOCK, NOT THE SOONEST ONE** (item 118). `ledgerClock` is a minimum across holders,
    // and wave 18's adversary measured what that costs: holders at 4,321 and 1,111, delete the
    // 4,321 entirely, and this assertion still read 1,111 both sides and passed. The line below
    // used to be that assertion.
    for (const item of ledgerItems(before, after)) {
      expect(
        ledgerClocks(after, item),
        `a save/load changed the clocks on item ${item}: ${ledgerDelta(before, after)}`,
      ).toEqual(ledgerClocks(before, item));
    }
  });

  it('the ledger cannot hide a deleted holder behind a sooner one', () => {
    // **THE MEASUREMENT, REPLAYED.** Two holders of one id at different clocks; delete the later
    // one; and the old instruments — a per-item count check and a minimum clock — both reported
    // that nothing had happened. It is worth a test of its own rather than trust in the round
    // trip above, because the round trip only catches it while somebody remembers to build a
    // fixture with two holders in it.
    const state = loadedWorld(12_203);
    const cellar = state.machines.find((machine) => machine.kind === MachineKind.RootCellar)!;
    const grabber = state.grabbers[0]!;
    // Both holders hold RussetPotato; the cellar is running the LATER clock. (Both are a tick
    // short of the numbers the fixture writes, because creating the contract steps the world.)
    expect(grabber.heldFreshTicks, 'the sooner clock').toBeLessThan(cellar.cargoFreshTicks);

    const before = goodsLedger(state);
    // **THE MUTATION A DROPPED SAVE FIELD ACTUALLY MAKES.** Not a deleted holder — a holder whose
    // clock comes back as 0, which the game reads as "no opinion" and every take-door answers
    // with a brand-new full window. Nine potatoes still exist; they have simply stopped ageing.
    cellar.cargoFreshTicks = 0;
    const after = goodsLedger(state);

    // Both old instruments agree that nothing happened. That is the bug, asserted rather than
    // described: the count is per item and unchanged, and the clock is a MINIMUM, so the holder
    // that lost its deadline is standing behind one that did not.
    expect(ledgerCount(after, ItemId.RussetPotato)).toBe(ledgerCount(before, ItemId.RussetPotato));
    expect(ledgerClock(after, ItemId.RussetPotato)).toBe(ledgerClock(before, ItemId.RussetPotato));

    // The multiset does not agree, and neither does the delta anybody reads on a failure.
    expect(ledgerClocks(after, ItemId.RussetPotato)).not.toEqual(
      ledgerClocks(before, ItemId.RussetPotato),
    );
    expect(ledgerDelta(before, after)).not.toBe('(nothing changed)');
    expect(ledgerDelta(before, after)).toContain(String(ItemId.RussetPotato));
  });

  it('carries the BURNT GRADE across a save, and it is still burnt on the far side', () => {
    // Door 10 over the widest edge in the game. A Fryer's basket is `outputItem` and a count and
    // a second count, and only the third of those says that three of these four chips are a
    // different good with a different price. A serializer that carried the first two and dropped
    // the third would launder three burnt chips into good ones on every reload — and the ledger
    // could not have told you, because before item 118 it filed all four under PlainChips.
    const state = loadedWorld(12_204);
    const fryer = state.machines.find((machine) => machine.kind === MachineKind.Fryer)!;
    const spec = machineSpec(MachineKind.Fryer)!;
    expect(basketGrades(fryer, spec), 'a basket holding two grades at once').toEqual([
      { item: ItemId.PlainChips, count: 1, freshTicks: 0 },
      { item: ItemId.RusticStyleChips, count: 3, freshTicks: 0 },
    ]);

    const before = goodsLedger(state);
    expect(ledgerCount(before, ItemId.RusticStyleChips), 'the fixture holds burnt chips').toBe(3);

    const after = goodsLedger(deserialize(serialize(state)));
    expect(ledgerCount(after, ItemId.RusticStyleChips)).toBe(3);
    // PlainChips are counted here as a TOTAL rather than as the Fryer's one, because the
    // Seasoner's hopper three screens up is full of them — which is worth knowing: an assertion
    // pinned to the basket's share would have been counting somebody else's chips.
    expect(ledgerCount(after, ItemId.PlainChips)).toBe(ledgerCount(before, ItemId.PlainChips));
  });

  it('never holds units with no name — the one thing `hold` is allowed to drop', () => {
    // `goodsLedger` skips anything whose id is 0, which is right for a container at rest and
    // would be a silent deletion for a container holding goods it has not labelled. `basketGrades`
    // exists partly for this: `heldOutputItem` falls back to the SPEC, so a machine really can
    // carry `outputItem: 0` with `outputCount: 3`, and the raw-field read those units were
    // counted by returned nothing at all.
    const state = loadedWorld(12_205);
    expect(unnamedGoods(state)).toEqual([]);
    expect(unnamedGoods(deserialize(serialize(state)))).toEqual([]);

    // And the guard can actually see one, so it is not a function that returns `[]` forever.
    const cellar = state.machines.find((machine) => machine.kind === MachineKind.RootCellar)!;
    cellar.cargoItem = 0;
    expect(unnamedGoods(state)).toEqual(['machines[].cargoItem: 9 units with no item id']);
  });

  it('and the reloaded world keeps them: no take-door mints on the far side', () => {
    // The bug this shape produces does not fire during the load — it fires on the FIRST TAKE
    // afterwards, when a container whose clock came back as 0 hands out a full window. So the
    // round trip is followed by a take.
    const state = loadedWorld(12_202);
    const restored = deserialize(serialize(state));
    const cellar = restored.machines.find((machine) => machine.kind === MachineKind.RootCellar)!;
    const clockIn = cellar.cargoFreshTicks;
    expect(clockIn, 'the cellar came back with a part-spent clock').toBeGreaterThan(0);
    expect(clockIn).toBeLessThan(freshnessTicks(ItemId.RussetPotato));

    standOn(restored, 8, 8);
    run(restored, { type: 'UnloadMachine', machineId: cellar.id, count: 9 });
    expect(
      remainingFreshness(restored, ItemId.RussetPotato),
      'the reloaded cellar handed out more clock than it was holding',
    ).toBeLessThanOrEqual(clockIn);
  });

  // --- THE GENERAL GUARD ------------------------------------------------------------------
  //
  // **THE ITEM ASKED FOR A GUARD THAT COVERS A NINTH CLOCK FIELD ADDED TOMORROW WITHOUT ANYONE
  // REMEMBERING TO WRITE A TEST**, and every list-shaped answer to that fails identically:
  // somebody has to remember to add the field to the list. The four tests below are the answer
  // in two halves, and neither half is a list.
  //
  //   1. `worldDiff` — a round trip is STRUCTURALLY IDENTICAL, every leaf. No field is named, so
  //      no field can be forgotten. This is what covers a ninth clock, and a tenth count, and a
  //      dial nobody has thought of.
  //   2. `clockBearingPaths` — the fixture must actually FILL every clock, because a field left
  //      at 0 round-trips as 0 whether it is carried or dropped. This is the whole of door 11:
  //      five of eight clocks were "caught by nothing" while an assertion about them existed,
  //      because nothing ever put a number in them. It caught a sixth in this file's own fixture.
  //   3. The mutation sweep, executed: zero each clock in turn and prove the guard goes red.
  //   4. And the payload's clocks against the world's, so a clock that is never serialized AT ALL
  //      is a difference between two swept sets rather than a silent zero on the far side.

  it('**A ROUND TRIP IS STRUCTURALLY IDENTICAL — EVERY FIELD, NAMED BY NOBODY**', () => {
    const state = loadedWorld(12_206);
    // The trace is handed back rather than excepted: it is stored outside the payload by design
    // (see canonical.ts), so passing it makes the claim total instead of nearly total. There is
    // no exception list here at all, and that is the point — an exception list is where three
    // items in this family kept the bug.
    const restored = deserialize(serialize(state), state.trace);
    const diff = worldDiff(state, restored);
    expect(diff.slice(0, 12), `a save/load changed ${String(diff.length)} fields`).toEqual([]);
  });

  it('**LEAVES NO NUMBER UNFILLED THAT NOBODY HAS EXCUSED — THE NAME-BLIND HALF**', () => {
    // **THIS IS WHAT REPLACES `isClockKey`, AND WHY A BETTER REGEX WOULD NOT HAVE DONE.**
    //
    // Every net above this one reads FIELD NAMES. `clockBearingPaths` matches `/freshticks$/i`,
    // `GOODS_COUNTS[].clock` is a list of names, and both are dodged for free by a clock called
    // `pocketStaleness` — unfilled and dropped from `toPayload`, it passes the entire suite,
    // because `worldDiff` is name-blind but a field left at 0 round-trips as 0 whether it is
    // carried or dropped.
    //
    // `unfilledNumbers` never looks at a name. It walks the world, finds every number whose every
    // occurrence is zero, and hands back the list — so a new field of ANY name shows up here the
    // day it is added, and the only ways off the list are to fill it in the fixture (which gives
    // `worldDiff` and the zeroing sweep something real to be about) or to say why a permanent
    // zero is right. **Not one clock is on this list**, which is the assertion this makes: the
    // fixture fills all nine, and it is provable without knowing what any of them are called.
    const state = loadedWorld(12_210);
    expect(
      unfilledNumbers(state),
      'a number this fixture never fills — fill it, or add it here with a reason',
    ).toEqual([
      // Counters, cursors, dials and ledgers that are legitimately zero in a fixture nobody has
      // played: no machine has completed an operation, no route has run, no money has moved, and
      // every upgrade is at its opening level. A clock arriving here would be a clock the round
      // trip cannot see, which is the whole point of the check.
      'bots[].workTicks',
      'contracts[].grossCents',
      'contracts[].phase',
      'contracts[].runsCompleted',
      'contracts[].ticksRemaining',
      'field[].compost',
      'field[].lastPouredTick',
      'field[].moisture',
      'field[].moistureAccum',
      'grabbers[].cooldown',
      'grabbers[].filter',
      'grabbers[].opCount',
      'machines[].blockedTicks',
      'machines[].capacityLevel',
      'machines[].cooldown',
      'machines[].efficiencyLevel',
      'machines[].flowMlPerMinute',
      'machines[].junctionInCursor',
      'machines[].junctionOutCursor',
      'machines[].network',
      'machines[].opCount',
      'machines[].progress',
      'machines[].runTicksRemaining',
      'machines[].scanCursor',
      'machines[].skippedCount',
      'machines[].speedLevel',
      'machines[].tankMl',
      'machines[].untouchedTicks',
      'machines[].wateredCount',
      'player.moveAccum',
      'player.moveDir',
      'player.towedCartId',
      'reservoirs[].rechargeAccum',
      'soilMemory[].fertilityWear',
      'stats.automatedGrossCents',
      'stats.cheatsUsed',
      'stats.dawnsSeen',
      'stats.hourMark.earnedCents',
      'stats.hourMark.hour',
      'stats.hourMark.inputsWasted',
      'stats.hourMark.itemsProduced',
      'stats.hourMark.itemsSold',
      'stats.hourMark.spentCents',
      'stats.hourMark.tick',
      'stats.hourMark.waterMl',
      'stats.inputsWastedByMachine',
      'stats.itemsHarvestedByHand',
      'stats.itemsProducedByMachine',
      'stats.itemsSold',
      'stats.lifetimeEarnedCents',
      'stats.lifetimeSpentCents',
      'stats.longestUntouchedMachineTicks',
      'stats.repairKitSpendCents',
      'stats.repairKitsUsed',
      'stats.touches.handCarry',
      'stats.touches.handHarvest',
      'stats.touches.handPlant',
      'stats.touches.handRepair',
      'stats.touches.handWater',
      'stats.touches.hopperRefill',
      'stats.touches.jamWhack',
      'stats.waterDrawnMl',
      'zones[].replantCooldown',
    ]);
  });

  it('fills every clock a live world has, so a dropped one has something to differ from', () => {
    // **THIS TEST FOUND A HOLE IN THE FIXTURE ABOVE THE MOMENT IT WAS WRITTEN.** Every basket in
    // it held a shelf-stable good, so `machines[].outputFreshTicks` was 0 on all five machines —
    // exactly the field door 11's sweep reported as caught by nothing. The Washer three screens
    // up is the fix, and this is what will catch the next one.
    const state = loadedWorld(12_207);
    const empty = [...clockFieldCoverage(state).entries()]
      .filter(([, count]) => count.filled === 0)
      .map(([path, count]) => `${path} (0 of ${String(count.total)} filled)`)
      .sort();
    expect(
      empty,
      'clocks this fixture never puts a number in — fill them or they prove nothing',
    ).toEqual([]);
  });

  it('has the same clocks in the SAVE as in the world', () => {
    // The third net, and the one that catches a field `toPayload` never writes at all. A clock
    // that is only in the world reads back as 0 on the far side, which the game spells "no
    // opinion" — the quietest possible way to lose a deadline.
    const state = loadedWorld(12_208);
    const inWorld = [...clockFieldCoverage(state).keys()].sort();
    const inSave = [...clockFieldCoverage(toPayload(state)).keys()].sort();
    expect(inSave, 'a clock the world keeps and the save does not').toEqual(inWorld);

    // And it is the nine the census declares, from the other direction: `GOODS_COUNTS[].clock`
    // hangs the list off the CONTAINERS, this hangs it off the NAMING CONVENTION, and a clock
    // that only one net catches is a clock somebody should look at.
    const declared = new Set(
      GOODS_COUNTS.map((entry) => entry.clock).filter((clock): clock is string => clock !== null),
    );
    expect(inWorld).toEqual([...declared].sort());
  });

  it('**ZEROING ANY CLOCK IN THE SAVE FAILS THE GUARD — THE SWEEP, RUN**', () => {
    // Door 11's own experiment, as a test rather than as a measurement in a note. Wave 18's
    // adversary zeroed each clock field in `toPayload` and ran 648 sim tests per mutant to see
    // which ones anybody noticed; three of eight were caught. This asks the same question of
    // every clock in the payload and asserts the answer is all of them — and it asks it of
    // whatever clocks exist on the day it runs, which is the part that survives a ninth field.
    const state = loadedWorld(12_209);
    const payload = toPayload(state);
    const restore = (mutant: unknown): unknown => fromPayload(mutant, state.trace);

    const byField = new Map<string, ClockSite[]>();
    for (const site of clockBearingPaths(payload)) {
      const had = byField.get(site.collapsed);
      if (had === undefined) byField.set(site.collapsed, [site]);
      else had.push(site);
    }

    const unguarded: string[] = [];
    for (const [field, sites] of byField) {
      const filled = sites.filter((site) => site.value !== 0);
      if (filled.length === 0) {
        unguarded.push(`${field}: the fixture leaves it empty, so the mutant is not a mutant`);
        continue;
      }
      // Every filled occurrence, not one representative: a serializer that carried the first
      // machine's clock and dropped the rest is a bug this would otherwise walk straight past.
      for (const site of filled) {
        if (zeroingIsCaught(payload, site.path, restore, state)) continue;
        unguarded.push(`${field}: zeroing ${site.path.join('.')} changed nothing anybody checks`);
      }
    }
    expect(unguarded, 'clocks a save could drop without a single test going red').toEqual([]);

    // And the sweep did real work rather than finding nothing to do — the shape of green that
    // this family has been bitten by twice.
    expect(byField.size, 'the sweep found no clocks at all, which cannot be right').toBe(9);
  });
});
