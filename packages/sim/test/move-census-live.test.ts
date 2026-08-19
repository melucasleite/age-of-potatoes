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
  fromPayload,
  machineHoppers,
  machineSpec,
  plantCrop,
  serialize,
  spawnBelt,
  spawnBot,
  spawnGrabber,
  spawnMachine,
  spawnZone,
  step,
  stepMany,
  TillMode,
  toPayload,
} from '../src/index';
import {
  type GoodsHolding,
  BAG_DOOR_VERDICTS,
  BagDoorVerdict,
  GOODS_COUNTS,
  MOVE_VERDICTS,
  MoveVerdict,
  basketGrades,
  boxLedger,
  callSitesInSim,
  containersFilledWorld,
  farmWithHarvester,
  stepUntil,
  testFilesCalling,
  UNFILLED_BY_DESIGN,
  unfilledNumbers,
  goodsLedger,
  witnessMoves,
  itemBearingPaths,
  ledgerCount,
  ledgerDelta,
  ledgerItems,
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

/**
 * **DRIVE ONE VERB AND HOLD IT TO ITS OWN VERDICT.**
 *
 * Count first, because count is plan §4 and a deleted potato is worse than a refreshed one; then
 * the clock, because a refreshed potato is what item 035 is for and what four doors got wrong.
 */
function checkMove(check: MoveCheck): void {
  const { state, act } = check.build();
  const before = goodsLedger(state);

  // **THE DECLARATION IS NOW A PREDICTION, AND THIS IS WHERE IT IS SETTLED** (item 123). `covers`
  // and `doors` used to be believed. `witnessMoves` runs the same `act` behind tripwires on every
  // quantity in `GOODS_COUNTS` and reports the census rows whose SOURCE LINES actually executed,
  // so a scenario that names a row it cannot reach is red rather than decorative. That is not a
  // hypothetical: the arm scenario below claimed `belts:handOffFromHead:items[]` while building a
  // single belt, and `handOffFromHead` returns at `next === null`. The claim had been on the
  // census for six items.
  const witness = witnessMoves(state, act);

  const after = goodsLedger(state);
  weighTheMove(check, before, after);

  expect(
    check.covers.filter((row) => !witness.moves.has(row)),
    `${check.name} declares census rows whose code it never reached — it drove ` +
      `[${[...witness.moves].sort().join(', ')}]`,
  ).toEqual([]);
  expect(
    (check.doors ?? []).filter((door) => !witness.doors.has(door)),
    `${check.name} declares bag doors it never opened — it opened ` +
      `[${[...witness.doors].sort().join(', ')}]`,
  ).toEqual([]);
}

/** The ledger half: the verdict the row claims, held against what the ledger says happened. */
function weighTheMove(
  check: MoveCheck,
  before: Map<ItemId, GoodsHolding>,
  after: Map<ItemId, GoodsHolding>,
): void {
  const verdict = check.verdict ?? combinedVerdict(check.covers);
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

// --- THE CHECKS ------------------------------------------------------------------------------
//
// Each one names the census rows it drives. The coverage test at the bottom then asserts that
// every CONSERVING row in the census is either driven by one of these or written into
// `UNREACHED` with a reason — which is the property that makes this a census rather than a
// selection of tests that happen to exist.

const CHECKS: readonly MoveCheck[] = [
  {
    name: 'a hand loads an aged armful into a container',
    covers: ['state:putStorage:cargoCount', 'state:removeItem:count'],
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
    covers: ['state:takeStorage:cargoCount', 'state:addItem:count'],
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
    // **`#2` IS THE HOPPER, AND THE NUMBER IS LOAD-BEARING.** This scenario boxes a STARVED
    // Seasoner, so its output basket — call site `#1` — is empty and this drives nothing there.
    // Until item 121 numbered the bag doors, the bare key covered both and this claim read as
    // coverage of a basket nobody had put anything in.
    build() {
      // A Seasoner with peppers but no chips is starved, so it never runs and stays boxable —
      // `freshness-doors.test.ts`' trick, and the supported way to hold a hopper still.
      const state = agedBag(12_003, ItemId.ChiliPepper, 6);
      const seasoner = spawnMachine(state, MachineKind.Seasoner, 6, 6)!;
      return {
        state,
        // **BOTH HALVES INSIDE `act`, AND ITEM 123 IS WHY.** The load used to sit up in `build`,
        // which made `state:putHopper:inputCounts[]` a row this scenario ran BEFORE the ledger was
        // opened: the line executed, and nothing weighed it. `witnessMoves` counts what happens
        // between the two ledger reads, because that is the only span the row's own verdict can
        // be applied to — the `before` book had the peppers in the hopper already.
        act: () => {
          run(state, {
            type: 'LoadMachine',
            machineId: seasoner.id,
            item: ItemId.ChiliPepper,
            count: 6,
          });
          run(state, { type: 'DeconstructMachine', machineId: seasoner.id });
        },
      };
    },
  },
  {
    name: 'a belt is laid, loaded, and taken up one tile at a time',
    // **THIS ROW USED TO SAY SOMETHING ELSE, AND BOTH HALVES OF IT WERE FALSE** (item 123). It
    // claimed `state:beltInsert:items[]`, which runs in `build` and is therefore inside the
    // `before` ledger rather than across it; and `belts:beltTakeFromTile:items[]`, which
    // `applyRemoveBeltTile` does not call — it splits the run and hands the freed riders to
    // `addItem`. Neither could ever have been reached from here. What the verb DOES drive is the
    // bag taking the cut's leavings, so that is what it now says, and `witnessMoves` agrees.
    covers: ['state:addItem:count'],
    // `#2` is the CUT: this belt is three tiles, so the one-tile branch above it never runs.
    doors: ['tick:applyRemoveBeltTile:addItem#2'],
    build() {
      const state = agedBag(12_004, ItemId.RussetPotato, 1);
      const belt = spawnBelt(state, BeltTier.Basic, 4, 4, Direction.East, 3)!;
      beltInsert(belt, 0, ItemId.RussetPotato);
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
    build() {
      const state = agedBag(12_005, ItemId.RussetPotato, 1);
      const belt = spawnBelt(state, BeltTier.Basic, 4, 4, Direction.East, 3)!;
      beltInsert(belt, 0, ItemId.RussetPotato);
      standOn(state, 4, 4);
      return { state, act: () => run(state, { type: 'RemoveBelt', beltId: belt.id }) };
    },
  },
  {
    name: 'an aged good crosses a belt seam, is lifted off, and is put down again',
    covers: [
      'belts:advanceGrabber:held',
      'belts:grabberSource:items[]',
      'belts:handOffFromHead:items[]',
      'state:beltInsert:items[]',
    ],
    // **THE SECOND BELT IS ITEM 123'S WHOLE STORY.** This scenario built ONE, and claimed
    // `handOffFromHead` — a function that reads `beltAt(exit tile)` and returns at `next === null`
    // when there is nothing there. The claim had been on the census since item 117 and could not
    // have been true for a single tick of it. Nothing checked; `witnessMoves` now does, and the
    // fix is a real seam rather than a smaller claim: a run laid in two pieces must carry a potato
    // exactly as one long belt would (item 112), which is the thing the row is for.
    //
    // The hand-off goes THROUGH `beltInsert`, so the seam drives that row too — the one the belt
    // teardown scenario above used to claim from inside its `build`.
    build() {
      const state = agedBag(12_006, ItemId.RussetPotato, 1);
      const upstream = spawnBelt(state, BeltTier.Basic, 2, 4, Direction.East, 3)!;
      spawnBelt(state, BeltTier.Basic, 5, 4, Direction.East, 1);
      spawnGrabber(state, GrabberTier.Mk1, 6, 4, Direction.East, 0);
      spawnMachine(state, MachineKind.RootCellar, 7, 4);
      beltInsert(upstream, 0, ItemId.RussetPotato);
      return { state, act: () => stepMany(state, 800) };
    },
  },
  {
    name: 'an arm holding an aged good is torn out of the ground',
    covers: [],
    build() {
      const state = agedBag(12_007, ItemId.RussetPotato, 1);
      const belt = spawnBelt(state, BeltTier.Basic, 2, 4, Direction.East, 4)!;
      const grabber = spawnGrabber(state, GrabberTier.Mk1, 6, 4, Direction.East, 0)!;
      beltInsert(belt, 0, ItemId.RussetPotato);
      stepUntil(state, 600, () => grabber.held !== 0);
      standOn(state, 6, 4);
      return { state, act: () => run(state, { type: 'RemoveGrabber', grabberId: grabber.id }) };
    },
  },
  {
    // **THE ARM PUTTING IT THERE IS A SEPARATE SCENARIO NOW** (item 123). This one used to claim
    // `commerce:depotAccept:stocked` as well, and stocked the floor in `build` — so the row ran
    // before the books opened and the refund was the only thing this ever weighed. The accept has
    // gone to a scenario with an actual arm in it, below, which is what its own name always said.
    name: 'a torn-up route hands a depot floor back',
    covers: ['commerce:refundContract:stocked', 'commerce:refundContract:inTransit'],
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
      for (let i = 0; i < 4; i++) depotAccept(state, depot, ItemId.RussetPotato);
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
      // **STANDING AT THE BIN, WHICH THIS SCENARIO DID NOT DO FOR SIX ITEMS** (item 123). The bag
      // helper leaves the player at tile (6, 6) and a fresh world's sell bin is at (2, 12), so
      // `applySellItem` refused at `nearSellBin`, the command was never even traced, and not one
      // potato moved. Nothing about that could go red: a SINK promises *"the total may fall, never
      // rise"*, and a world where nothing happened at all keeps that promise perfectly.
      //
      // **THAT IS THE ENTIRE SHAPE OF THIS FAMILY, ONE LEVEL FURTHER OUT.** The label was not
      // wrong. The scenario under it was empty, and no label can notice that. The bin is found
      // rather than typed, so a lot that moves it moves this too.
      const bin = state.machines.find((machine) => machine.kind === MachineKind.SellBin)!;
      standOn(state, bin.tileX, bin.tileY);
      return {
        state,
        act: () => run(state, { type: 'SellItem', item: ItemId.RussetPotato, count: 5 }),
      };
    },
  },
  {
    // **THE ACCEPT, OFF AN ACTUAL ARM** (item 123). `depotAccept` has exactly one caller in the
    // sim — `grabberDeliver`, when the tile in front of a claw is a depot with a route that names
    // what it is holding — so this is the only shape in which the row is a TRANSFER rather than an
    // appearance. Driven the old way, by calling the primitive with nothing on the other end, the
    // goods arrived from nowhere and a conserving verdict could not have been asserted about it;
    // that is why the call sat in a `build` and the row went six items without being weighed.
    name: 'an arm puts an aged good on a depot floor',
    covers: ['commerce:depotAccept:stocked', 'belts:grabberSource:items[]'],
    build() {
      const state = agedBag(12_023, ItemId.RussetPotato, 1);
      const belt = spawnBelt(state, BeltTier.Basic, 2, 4, Direction.East, 4)!;
      spawnGrabber(state, GrabberTier.Mk1, 6, 4, Direction.East, 0);
      const depot = spawnMachine(state, MachineKind.TruckDepot, 7, 4)!;
      run(state, {
        type: 'CreateContract',
        depotId: depot.id,
        item: ItemId.RussetPotato,
        quantityPerRun: 4,
        destination: 'Ridgeline Grocers',
      });
      beltInsert(belt, 0, ItemId.RussetPotato);
      const contract = state.contracts[0]!;
      // Stopped the moment the floor takes it. The route wants four and has one, so no lorry
      // rolls — which matters, because a run that dispatched would turn this into a Sink and the
      // conserving half is the half worth measuring.
      return { state, act: () => stepUntil(state, 3_000, () => contract.stocked > 0) };
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
    // **ITEM 131'S TRANSFER, TRIGGER ONE OF TWO.** `landEmpties` is one write and therefore one
    // census row, and a row driven by one of its two callers is the collapse `MOVE_VERDICTS`'
    // header warns about — so the cart and the truck get a scenario each.
    //
    // A SOURCE, and the ledger says exactly why: the six sodas leave through `payForDelivery` and
    // become money, which the ledger does not count, while six empties arrive in the cart's
    // basket, which it does. The total may rise and may never fall — and it may never fall is the
    // half worth asserting, because the same tick clears `cargoItem`, `cargoCount` and
    // `cargoFreshTicks`, and a return leg that mislaid its arithmetic would show up here as a
    // sale that ate its own returns. The exact counts are pinned in `recycling.test.ts`.
    name: 'a delivery cart comes home from a soda run with the empties',
    covers: ['commerce:landEmpties:outputCount', 'commerce:advanceCart:cargoCount'],
    verdict: MoveVerdict.Source,
    build() {
      const state = createWorld(12_021);
      addItem(state, ItemId.Soda, 6);
      const cart = spawnMachine(state, MachineKind.DeliveryCart, 6, 6)!;
      standOn(state, 6, 6);
      run(state, { type: 'LoadCart', cartId: cart.id, item: ItemId.Soda, count: 6 });
      run(state, { type: 'DispatchCart', cartId: cart.id });
      return { state, act: () => stepUntil(state, 3_000, () => cart.outputCount > 0) };
    },
  },
  {
    // **THE SAME TRANSFER, THE OTHER TRIGGER.** Six-packs rather than sodas, so the scenario also
    // drives the one row of `EMPTIES_PER_DELIVERY` whose count is not 1: four six-packs come home
    // as twenty-four empties, and a return leg that forgot to multiply would still be a Source.
    // `recycling.test.ts` is where that number is pinned; this is where the books are.
    name: 'a truck comes home from a six-pack route with the empties',
    covers: ['commerce:landEmpties:outputCount'],
    verdict: MoveVerdict.Source,
    build() {
      const state = createWorld(12_022);
      const depot = spawnMachine(state, MachineKind.TruckDepot, 6, 6)!;
      standOn(state, 6, 6);
      run(state, {
        type: 'CreateContract',
        depotId: depot.id,
        item: ItemId.SixPack,
        quantityPerRun: 4,
        destination: 'Ridgeline Grocers',
      });
      for (let i = 0; i < 4; i++) depotAccept(state, depot, ItemId.SixPack);
      return { state, act: () => stepUntil(state, 5_000, () => depot.outputCount > 0) };
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
      for (let i = 0; i < 4; i++) depotAccept(state, depot, ItemId.RussetPotato);
      return { state, act: () => stepMany(state, 3_000) };
    },
  },
  {
    // **ITEM 121'S TRANSFER, DRIVEN THROUGH A REAL WORLD** — because a verdict is not checked for
    // truth by being written down. All three doors at once: a ripe crop, waiting compost, and the
    // seed, off one tile, through one placement of one sprinkler.
    //
    // A SOURCE, and the ledger says why: a crop standing in the ground is not on the books at all
    // — `goodsLedger` counts bags, hoppers, baskets, belts and shelves, and a tile is none of
    // those. So the grand total can only RISE here, exactly as it does when a bot pulls a row.
    // What it may never do is fall, and that is the assertion: nothing is destroyed on the way
    // out of the soil. The exact counts, the Day-Old grade and the seed are pinned tile-by-tile in
    // `field-machines.test.ts`, which can afford to be specific because it is not generic.
    name: 'a sprinkler is dropped on a ripe, composted row and hands the whole tile back',
    covers: [],
    doors: ['tick:clearFieldTileForMachine:addItem', 'tick:clearFieldTileForMachine:addItem#2'],
    verdict: MoveVerdict.Source,
    build() {
      const state = createWorld(12_019);
      state.moneyCents = 1_000_000;
      const tile = state.field.find((entry) => entry.tileX === 6 && entry.tileY === 6)!;
      plantCrop(state, tile, cropSpec(CropId.RussetPotato)!);
      tile.growth = tile.growthTarget;
      standOn(state, 6, 6);
      return {
        state,
        act: () =>
          run(state, { type: 'PlaceMachine', kind: MachineKind.Sprinkler, tileX: 6, tileY: 6 }),
      };
    },
  },
  {
    // **THE SAME TRANSFER, THE OTHER TRIGGER** (item 127). The till's new middle rung hands a
    // laden tile back through the very same `clearFieldTileForMachine`, so it opens no new door
    // and adds no row to the census — and THAT CLAIM IS WHAT THIS SCENARIO CHECKS. A reused
    // primitive that had quietly grown a second path would show up here as a door driven by a
    // verb the door list has never heard of, or as a ledger that stopped adding up.
    //
    // A drag rather than a single tile, because the drag is where the reuse could go wrong: one
    // `TillTile` over three laden tiles is three trips through the primitive inside one command,
    // and a hand-back that leaked would leak three times.
    //
    // A SOURCE, for the reason the placement scenario is one: a crop standing in the ground is
    // not on the books at all — `goodsLedger` counts bags, hoppers, baskets, belts and shelves,
    // and a tile is none of those. So the total may rise and may never fall.
    name: 'the till sweeps a laden row and hands every tile back',
    covers: [],
    doors: ['tick:clearFieldTileForMachine:addItem', 'tick:clearFieldTileForMachine:addItem#2'],
    verdict: MoveVerdict.Source,
    build() {
      const state = createWorld(12_020);
      const spec = cropSpec(CropId.RussetPotato)!;
      const growing = state.field.find((t) => t.tileX === 5 && t.tileY === 6)!;
      plantCrop(state, growing, spec);
      growing.growth = 1;
      const ripe = state.field.find((t) => t.tileX === 6 && t.tileY === 6)!;
      plantCrop(state, ripe, spec);
      ripe.growth = ripe.growthTarget;
      standOn(state, 6, 7);
      return {
        state,
        act: () =>
          run(state, {
            type: 'TillTile',
            rect: { x: 5, y: 6, w: 3, h: 1 },
            mode: TillMode.Unplant,
          }),
      };
    },
  },
];

// --- the tests -------------------------------------------------------------------------------

describe('the move census, executed', () => {
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

  it('settles the one excuse that is a claim about the SIM rather than about this harness', () => {
    // **AN EXCUSE THAT COSTS SOMETHING.** `belts:beltTakeFromTile:items[]` is excused below on
    // the grounds that the game never calls the function — the only reason on that list that the
    // source can be asked about. So it is asked. Wire `beltTakeFromTile` up to anything and this
    // goes red, and the row has to be driven for real rather than go on being excused by a
    // sentence that stopped being true.
    //
    // It also records a fact worth an owner's attention rather than a silent exemption: an
    // exported sim function with no callers is either dead or a missing verb (taking one item off
    // a belt by hand), and the census is the thing that noticed.
    expect(
      callSitesInSim('beltTakeFromTile'),
      'beltTakeFromTile has a caller now — drive the row instead of excusing it',
    ).toEqual([]);
    expect(
      UNREACHED['belts:beltTakeFromTile:items[]'],
      'and the excuse is still on file',
    ).toContain('THE SIM NEVER CALLS IT');
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
  //
  // **THE SEVEN BELOW ARE ITEM 121'S NUMBERING BILL, AND THEY ARE PAID IN FULL BY THE CLOCK
  // CENSUS.** Numbering the bag doors by call site split six functions into their real doors, and
  // each of the new halves is a `Carries` claim that this harness does not drive. It does not need
  // to: `clockDoors()` already keys every one of these call sites — more finely than a door list
  // can, by the clock EXPRESSION it hands over — and `clock-doors.test.ts` holds each of them to a
  // live scenario or to a written reason of its own. Two lists of the same fact is how a census
  // starts drifting from itself, so this one defers and says where it is deferring to.
  'commerce:refundContract:addItemFresh#2':
    'the LORRY’s half of a torn-up route; the scenario above cancels before a truck rolls, so it ' +
    'drives the floor. `contract.inTransitFreshTicks` is on the clock census, driven by the ' +
    'commerce scenarios that cancel a route mid-journey.',
  'tick:applyDeconstructMachine:addItemFresh':
    'boxing a machine with goods in its OUTPUT BASKET. One of item 119’s nine, and it has a live ' +
    'clock scenario of its own — the reason the starved-Seasoner check above had to be re-pointed ' +
    'to `#2` rather than left claiming this.',
  'tick:applyDeconstructMachine:addItemFresh#3':
    'boxing a loaded container or cart, so the cargo bay comes home; on the clock census as ' +
    '`machine.cargoFreshTicks`.',
  'tick:applyDeconstructMachine:addItemFresh#4':
    'boxing a dock with a bot mid-errand — **this line was DOOR 8**, and the ' +
    '“BOXING A DOCK MINTS ONLY SEEDS” test in this same file weighs the armful it hands back.',
  'tick:applyRemoveBeltTile:addItemFresh':
    'taking up a ONE-TILE belt whole. One of item 119’s nine, driven by name in ' +
    '`clock-crossings.ts`; the scenario above uses a three-tile belt and so drives the CUT.',
  'tick:applyUnloadMachine:addItemFresh':
    'a container’s cargo bay emptied by hand — driven through `state:takeStorage:cargoCount` by ' +
    'the aged-container scenarios above, and clocked on the clock census.',
  'tick:applyUnloadMachine:addItemFresh#2':
    'a harvester dock’s PRODUCE shelf emptied by hand; the shelf’s clock is on the clock census ' +
    'and bots.test.ts drives the shelf by name.',
};

const UNREACHED: Readonly<Record<string, string>> = {
  'belts:beltTakeFromTile:items[]':
    'THE SIM NEVER CALLS IT. `beltTakeFromTile` is exported and on the census and has no call ' +
    'site in src/ — an arm takes off a belt through `grabberSource`, which splices for itself, ' +
    'and a hand takes a whole tile up through `applyRemoveBeltTile`, which splits the run and ' +
    'hands the riders to `addItem`. The belt scenario above claimed this row for six items on ' +
    'the strength of its name. Unlike every other reason here this one is a claim about the SIM ' +
    'rather than about this harness, so it is CHECKED — see the test below.',
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
  // **THE FIXTURE MOVED TO `goods.ts` (item 123)**, so `save.test.ts` can run the same two
  // name-blind guards over the same world. It used to be declared here, which made this file the
  // only place either guard existed — see `UNFILLED_BY_DESIGN`'s header for why that was the
  // concentration risk item 123 was filed about.
  const loadedWorld = containersFilledWorld;

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
      { item: ItemId.PlainChips, count: 1 },
      { item: ItemId.RusticStyleChips, count: 3 },
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
    ).toEqual(UNFILLED_BY_DESIGN);
  });
});
