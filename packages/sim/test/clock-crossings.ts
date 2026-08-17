// **THE CLOCK COLUMN, EXECUTED** (item 119).
//
// `CLOCK_CROSSING_VERDICTS` in `goods.ts` says what every clock crossing in the sim claims to do.
// This is where the ones that claim to CARRY are made to prove it against a live world.
//
// **WHY THIS IS A MODULE AND NOT A TEST FILE.** Item 119's report measured the concentration:
// all 27 clock catches in the suite came from `move-census-live.test.ts`, largely three tests, so
// deleting one file would have silently un-guarded every clock in the game. A guard with a single
// point of failure is a guard you are one `rm` away from not having. So the scenarios live here,
// each naming the file that runs it, and `clock-doors.test.ts` sweeps the test directory to check
// that every named file exists AND actually calls `runClockCrossings` with its own name. Delete
// the file that drives the belt seam and the census goes red naming it.
//
// **WHAT EACH SCENARIO ASSERTS, AND WHY IT IS NOT "CONSERVING".** The generic harness in
// `move-census-live.test.ts` weighs a whole world before and after a verb. That is the right
// instrument for "nothing vanished" and the wrong one for these nine, because a clock crossing is
// one argument at one call site and a whole-world ledger cannot say which call site minted. So
// each check here names the clock that LEFT and the clock that ARRIVED and holds the pair to the
// one sentence `Carries` makes: *no unit comes out of a door fresher than it went in.*

import { expect, it } from 'vitest';

import {
  type Machine,
  type WorldState,
  BeltTier,
  Direction,
  GrabberTier,
  ItemId,
  MachineKind,
  SUBTILE,
  addItem,
  beltInsert,
  createWorld,
  freshnessTicks,
  machineHoppers,
  machineSpec,
  remainingFreshness,
  spawnBelt,
  spawnGrabber,
  spawnMachine,
  step,
  stepMany,
  takeDockShelf,
} from '../src/index';

/**
 * **HOW SPENT A CLOCK IS BEFORE A SCENARIO MOVES IT.**
 *
 * A mint is invisible against goods that are already at a full window — the number before and the
 * number after are the same, the test passes, and the door stays open. `AGE_TICKS` in
 * `move-census-live.test.ts` is the same idea driven by stepping the world; here the clock is set
 * outright, because these scenarios need a container's clock at a known value and several of the
 * containers involved cannot be filled by any command a player has.
 *
 * Deliberately nowhere near a full potato window (18,000) and nowhere near zero, so a mint
 * overshoots by a mile and expiry does not end the scenario early.
 */
const AGED = 5_000;

/** Put the player on a tile, so the reach-gated verbs are in reach. Position is not a command. */
function standOn(state: WorldState, tileX: number, tileY: number): void {
  state.player.xSub = tileX * SUBTILE + SUBTILE / 2;
  state.player.ySub = tileY * SUBTILE + SUBTILE / 2;
}

function run(state: WorldState, command: Parameters<typeof step>[1]['commands'][number]): void {
  step(state, { tick: state.tick, commands: [command] });
}

/** Step one tick at a time until `done`, returning how many it took, or -1 if it never did. */
function stepUntil(state: WorldState, limit: number, done: () => boolean): number {
  for (let i = 1; i <= limit; i++) {
    stepMany(state, 1);
    if (done()) return i;
  }
  return -1;
}

/**
 * **THE ONE SENTENCE `Carries` MAKES**, asserted on a pair of numbers.
 *
 * Three clauses, and the middle one is the load-bearing one. The first two would both pass
 * against a door that had never moved anything at all.
 */
function expectCarried(
  what: string,
  item: ItemId,
  departed: number,
  arrived: number,
  spent = 0,
): void {
  const window = freshnessTicks(item);
  // The goods really were part-spent, so a mint has somewhere to show. A scenario that skipped
  // this would be asserting something true of a brand-new potato.
  expect(departed, `${what}: the goods were not aged, so a mint would be invisible`).toBeLessThan(
    window,
  );
  expect(arrived, `${what}: nothing arrived carrying a clock at all`).toBeGreaterThan(0);
  // **THE ASSERTION THE MUTANT DIES ON.** A literal 0 at the door reads as "no opinion", and
  // `beltInsert`, `putHopper`, `mergedFreshness` and `addItemFresh` all answer no opinion with a
  // FULL window — so a broken door does not lose time here, it MINTS it, and lands above this.
  expect(
    arrived,
    `${what}: came out of the door FRESHER than it went in — ${String(arrived)} > ${String(
      departed,
    )} (a full window for this item is ${String(window)})`,
  ).toBeLessThanOrEqual(departed - spent);
}

export interface ClockCrossingCheck {
  /** The `clockCrossings()` key this drives. Must be a key of `CLOCK_CROSSING_VERDICTS`. */
  readonly crossing: string;
  /** The test file that runs it — the column that stops all of this living in one file. */
  readonly owner: string;
  /** What is being driven, in English. */
  readonly name: string;
  run(): void;
}

/** A Seasoner is starved without chips, so it holds a hopper still instead of eating it. */
function seasonerHopperLine(seasoner: Machine, item: ItemId): number {
  const hoppers = machineHoppers(machineSpec(seasoner.kind)!);
  return hoppers.findIndex((line) => line.item === item);
}

export const CLOCK_CROSSINGS: readonly ClockCrossingCheck[] = [
  {
    // Its own comment predicted the exploit: "the fix would be defeated by laying belt in short
    // pieces". `belt-tiles.test.ts`' throughput-parity test drives a live clock across this exact
    // seam and asserts only the RATE, which is how a fixed line and a broken one both passed.
    crossing: 'belts:handOffFromHead:beltInsert(head.freshTicks)',
    owner: 'belt-tiles',
    name: 'a potato crossing a belt seam keeps the clock it was riding',
    run() {
      const state = createWorld(119_101);
      const first = spawnBelt(state, BeltTier.Basic, 4, 4, Direction.East, 2)!;
      const second = spawnBelt(state, BeltTier.Basic, 6, 4, Direction.East, 2)!;
      beltInsert(first, 0, ItemId.RussetPotato, AGED);

      const ticks = stepUntil(state, 500, () => second.items.length > 0);
      expect(ticks, 'the potato never reached the second segment').toBeGreaterThan(0);

      // A belt spends exactly one tick of clock per tick, so the arithmetic is exact rather than
      // approximate: whatever it cost to get there is what it should have cost.
      expectCarried(
        'belt → belt seam',
        ItemId.RussetPotato,
        AGED,
        second.items[0]!.freshTicks,
        ticks,
      );
      expect(second.items[0]!.freshTicks, 'the seam is not free, and not costly either').toBe(
        AGED - ticks,
      );
    },
  },
  {
    // A 1-tile belt taken up WHOLE, which is a different branch of `applyRemoveBeltTile` from the
    // goods freed by cutting a longer run — the same line of code written twice, one covered and
    // one not. That is why `clockDoors()` numbers duplicate keys instead of collapsing them.
    crossing:
      'tick:applyRemoveBeltTile:addItemFresh(spoilTickFromRemaining(state, entry.freshTicks))',
    owner: 'belt-tiles',
    name: 'taking up a ONE-TILE belt hands its rider back at the clock it was riding',
    run() {
      const state = createWorld(119_102);
      const belt = spawnBelt(state, BeltTier.Basic, 4, 4, Direction.East, 1)!;
      beltInsert(belt, 0, ItemId.RussetPotato, AGED);
      standOn(state, 4, 4);

      run(state, { type: 'RemoveBeltTile', tileX: 4, tileY: 4 });

      expect(state.belts, 'the one-tile belt should be gone').toHaveLength(0);
      expectCarried(
        'a one-tile belt → the bag',
        ItemId.RussetPotato,
        AGED,
        remainingFreshness(state, ItemId.RussetPotato),
      );
    },
  },
  {
    // A junction has no buffer and so no clock of its own; the rider's remainder crosses with it.
    crossing: 'belts:advanceJunction:placeOnFace(head.freshTicks)',
    owner: 'factory',
    name: 'a potato crossing a belt junction keeps the clock it was riding',
    run() {
      const state = createWorld(119_103);
      const feed = spawnBelt(state, BeltTier.Basic, 0, 5, Direction.East, 3)!;
      spawnMachine(state, MachineKind.BeltJunction, 3, 5);
      const out = spawnBelt(state, BeltTier.Basic, 4, 5, Direction.East, 4)!;
      beltInsert(feed, 0, ItemId.RussetPotato, AGED);

      const ticks = stepUntil(state, 600, () => out.items.length > 0);
      expect(ticks, 'the potato never crossed the junction').toBeGreaterThan(0);

      expectCarried(
        'belt → junction face',
        ItemId.RussetPotato,
        AGED,
        out.items[0]!.freshTicks,
        ticks,
      );
      expect(out.items[0]!.freshTicks, 'a junction holds nothing, so it costs nothing').toBe(
        AGED - ticks,
      );
    },
  },
  {
    // `grabberSource` has FOUR take-paths and item 119's sweep found two of them guarded and two
    // not. This is the machine's output basket — the arm's half of the same door the hand goes
    // through in `applyUnloadMachine`, which has two tests.
    crossing: 'belts:grabberSource:heldFreshTicks = freshTicks',
    owner: 'freshness-doors',
    name: 'an arm pulling from an output basket carries the basket’s clock, not a new one',
    run() {
      const state = createWorld(119_104);
      const washer = spawnMachine(state, MachineKind.Washer, 0, 0)!;
      spawnGrabber(state, GrabberTier.Mk1, 2, 0, Direction.East, 0);
      const sink = spawnBelt(state, BeltTier.Basic, 3, 0, Direction.East, 2)!;

      washer.outputItem = ItemId.WashedPotato;
      washer.outputCount = 3;
      washer.outputFreshTicks = AGED;

      const ticks = stepUntil(state, 600, () => sink.items.length > 0);
      expect(ticks, 'the arm never emptied the basket onto the belt').toBeGreaterThan(0);

      expectCarried('basket → claw → belt', ItemId.WashedPotato, AGED, sink.items[0]!.freshTicks);
    },
  },
  {
    // The other unguarded take-path: a harvester dock's produce shelf. A dock that handed an arm
    // a fresh window would be doing the $250 Root Cellar's job for free.
    crossing: 'belts:grabberSource:heldFreshTicks = took.freshTicks',
    owner: 'freshness-depot-and-bot',
    name: 'an arm draining a dock’s produce shelf carries the shelf’s clock',
    run() {
      const state = createWorld(119_105);
      const dock = spawnMachine(state, MachineKind.HarvesterDock, 0, 0)!;
      spawnGrabber(state, GrabberTier.Mk1, 2, 0, Direction.East, 0);
      const sink = spawnBelt(state, BeltTier.Basic, 3, 0, Direction.East, 2)!;

      dock.cargoItem = ItemId.RussetPotato;
      dock.cargoCount = 3;
      dock.cargoFreshTicks = AGED;

      const ticks = stepUntil(state, 600, () => sink.items.length > 0);
      expect(ticks, 'the arm never drained the shelf onto the belt').toBeGreaterThan(0);

      expectCarried(
        'dock shelf → claw → belt',
        ItemId.RussetPotato,
        AGED,
        sink.items[0]!.freshTicks,
      );
    },
  },
  {
    // The belt-fed twin of the hand's `applyLoadMachine`. Its own comment records the original
    // bug — "This line used to pass a literal 0" — and until item 119 the 0 went straight back in
    // with 1,544 tests green.
    crossing: 'belts:grabberDeliver:putHopper(grabber.heldFreshTicks)',
    owner: 'freshness-doors',
    name: 'an arm feeding a hopper hands over the clock the claw was holding',
    run() {
      const state = createWorld(119_106);
      const belt = spawnBelt(state, BeltTier.Basic, 0, 0, Direction.East, 1)!;
      spawnGrabber(state, GrabberTier.Mk1, 1, 0, Direction.East, 0);
      // A Seasoner with peppers but no chips is starved, so it never runs and the hopper holds
      // still — `freshness-doors.test.ts`' own trick for looking at a hopper at rest.
      const seasoner = spawnMachine(state, MachineKind.Seasoner, 2, 0)!;
      const line = seasonerHopperLine(seasoner, ItemId.ChiliPepper);
      expect(line, 'a Seasoner should have a chili pepper line').toBeGreaterThanOrEqual(0);

      beltInsert(belt, 0, ItemId.ChiliPepper, AGED);
      const ticks = stepUntil(state, 600, () => (seasoner.inputCounts[line] ?? 0) > 0);
      expect(ticks, 'the arm never fed the hopper').toBeGreaterThan(0);

      expectCarried('claw → hopper', ItemId.ChiliPepper, AGED, seasoner.inputFreshTicks[line] ?? 0);
    },
  },
  {
    // Boxing reads the basket's clock before the take, because the last unit off a basket zeroes
    // the field. The scenario that "covered" this verb boxed a STARVED SEASONER — whose basket is
    // empty — so the hoppers were checked and the basket never was.
    crossing:
      'tick:applyDeconstructMachine:addItemFresh(spoilTickFromRemaining(state, freshTicks))',
    owner: 'freshness-doors',
    name: 'boxing a machine hands its OUTPUT BASKET back at the clock it was spending',
    run() {
      const state = createWorld(119_107);
      const washer = spawnMachine(state, MachineKind.Washer, 6, 6)!;
      standOn(state, 6, 6);

      washer.outputItem = ItemId.WashedPotato;
      washer.outputCount = 3;
      washer.outputFreshTicks = AGED;

      run(state, { type: 'DeconstructMachine', machineId: washer.id });

      expectCarried(
        'basket → the bag, by boxing',
        ItemId.WashedPotato,
        AGED,
        remainingFreshness(state, ItemId.WashedPotato),
      );
    },
  },
  {
    // A cart never SPENDS its clock — it is not `MachineRole.Storage`, so nothing ages its load —
    // which is exactly why nothing about the cart itself could ever show this loss. The door it
    // closes is the way back OUT, when the cart is boxed.
    crossing:
      'tick:applyLoadCart:cargoFreshTicks = mergedCargoFreshnessForCart(cart, count, command.item, freshTicks)',
    owner: 'container-clock-view',
    name: 'loading a cart from the bag puts the bag’s clock on the load',
    run() {
      const state = createWorld(119_108);
      // A DeliveryCart, because `isCart` is a ROLE test and the hand cart does not have the role.
      // And a POTATO rather than the bagged chips every other cart test uses, which is the point:
      // bagged chips are shelf-stable, so a cart test built on them cannot see a clock at all.
      const cart = spawnMachine(state, MachineKind.DeliveryCart, 6, 6)!;
      standOn(state, 6, 6);

      addItem(state, ItemId.RussetPotato, 6);
      const spend = remainingFreshness(state, ItemId.RussetPotato) - AGED;
      if (spend > 0) stepMany(state, spend);
      const departed = remainingFreshness(state, ItemId.RussetPotato);

      run(state, { type: 'LoadCart', cartId: cart.id, item: ItemId.RussetPotato, count: 4 });
      expect(cart.cargoCount, 'the cart never took the load').toBe(4);

      expectCarried('bag → cart', ItemId.RussetPotato, departed, cart.cargoFreshTicks);
    },
  },
  {
    // **A REPAIR, NOT A CARRY.** A format-18 save recorded no clock for a dock shelf, so there is
    // nothing to carry and a full window is the honest answer — but ONE window shared by the
    // whole shelf, not one per unit taken. That is the property, and the mutant that leaves the
    // field at zero fails it by handing out a fresh window on every single pull forever.
    crossing: 'state:takeDockShelf:cargoFreshTicks = freshnessTicks(item)',
    owner: 'freshness-depot-and-bot',
    name: 'a dock shelf whose clock was never written down grants ONE window, not one per unit',
    run() {
      const state = createWorld(119_109);
      const dock = spawnMachine(state, MachineKind.HarvesterDock, 0, 0)!;
      dock.cargoItem = ItemId.RussetPotato;
      dock.cargoCount = 4;
      dock.cargoFreshTicks = 0; // the format that wrote this save had nowhere to record one.

      const window = freshnessTicks(ItemId.RussetPotato);
      const first = takeDockShelf(dock, 1);
      expect(first, 'the shelf refused the first pull').not.toBeNull();
      expect(first!.freshTicks, 'the repair grants a full window').toBe(window);
      expect(
        dock.cargoFreshTicks,
        'and WRITES it down, so the rest of the shelf shares it rather than being repaired again',
      ).toBe(window);

      // Spend some of it, then pull again: the second unit must be older than the first, which is
      // the whole difference between one window and one window per pull.
      dock.cargoFreshTicks -= 1_000;
      const second = takeDockShelf(dock, 1);
      expect(second, 'the shelf refused the second pull').not.toBeNull();
      expect(second!.freshTicks, 'a second pull is not a second repair').toBe(window - 1_000);
    },
  },
];

/**
 * Run every crossing this file owns. Called by name from the test file named in `owner`, and
 * `clock-doors.test.ts` sweeps the test directory to check that each call actually exists — so a
 * scenario cannot be orphaned by deleting the only file that ran it.
 */
export function runClockCrossings(owner: string): void {
  for (const check of CLOCK_CROSSINGS) {
    if (check.owner !== owner) continue;
    it(`clock crossing: ${check.name}`, () => {
      check.run();
    });
  }
}
