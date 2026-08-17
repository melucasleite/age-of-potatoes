// **EVERY DOOR A PERISHABLE CAN WALK BACK OUT OF** (item 112).
//
// Item 110 closed one of them — a container's cargo — and its own adversarial verifier
// immediately found that the bug had not died, it had MOVED:
//
//   > "20 chili peppers with 2,400 ticks left sat in a Seasoner for an hour of world time and
//   > came back with 17,998 of an 18,000-tick window."
//
// A machine holds goods in three places, and until this item exactly one of them owned a clock:
//
//   1. `cargoItem` / `cargoCount`  — a cart's load, a cellar's shelf. Item 110. Closed.
//   2. `inputCounts[]`             — the hoppers. Stamped from NOW on the way out.
//   3. `outputCount`               — the basket. Stamped from NOW on the way out.
//
// And a fourth place outside machines entirely: a BELT, whose items were an id and a distance
// and nothing else, so `cellar → arm → belt → arm → cellar` minted a full window with no
// clicking at all.
//
// Every test below is one sentence — *a perishable that goes into anything and comes back out is
// exactly as old as it was* — asked of one of those four doors. They were all written and all
// RED before a line of the fix existed; that is what makes them evidence rather than decoration.

import { describe, expect, it } from 'vitest';

import {
  type WorldState,
  BeltTier,
  FRESHNESS_BUCKET_TICKS,
  Direction,
  GrabberTier,
  ItemId,
  MachineKind,
  addItem,
  beltAt,
  beltInsert,
  createWorld,
  itemCount,
  machineHoppers,
  machineSpec,
  remainingFreshness,
  spawnBelt,
  spawnGrabber,
  spawnMachine,
  step,
  stepMany,
} from '../src/index';

const ACTIVE_MINUTE = 1_200;
const POTATO_WINDOW = 18_000;
const PEPPER_WINDOW = 18_000;

function world(seed = 112): WorldState {
  const state = createWorld(seed);
  // Standing on the origin tile, so every reach check in this file passes without walking.
  state.player.xSub = 128;
  state.player.ySub = 128;
  return state;
}

/**
 * Goods in the player's arms with exactly `ticks` of clock left.
 *
 * Aged rather than stamped: the bag's deadlines are bucketed, so poking a number in would test
 * arithmetic this file does not own. Walking the world forward is what a player does.
 */
function agedTo(state: WorldState, item: ItemId, count: number, ticks: number): void {
  addItem(state, item, count);
  const spend = remainingFreshness(state, item) - ticks;
  if (spend > 0) stepMany(state, spend);
}

function load(state: WorldState, machineId: number, item: ItemId, count: number): void {
  step(state, { tick: state.tick, commands: [{ type: 'LoadMachine', machineId, item, count }] });
}

function box(state: WorldState, machineId: number): void {
  step(state, { tick: state.tick, commands: [{ type: 'DeconstructMachine', machineId }] });
}

function unload(state: WorldState, machineId: number, count: number): void {
  step(state, { tick: state.tick, commands: [{ type: 'UnloadMachine', machineId, count }] });
}

// --- door 2: the hopper -----------------------------------------------------------------

describe('a starved machine hopper', () => {
  it('THE EXPLOIT: twenty peppers cannot sit out an hour in a Seasoner and come back fresh', () => {
    // The verifier's session, replayed exactly. A Seasoner with no chips in it can never run, so
    // it is boxable forever — and item 111 is what made its pepper hopper hand-loadable.
    const state = world();
    const seasoner = spawnMachine(state, MachineKind.Seasoner, 0, 0)!;
    agedTo(state, ItemId.ChiliPepper, 20, 2_400);

    load(state, seasoner.id, ItemId.ChiliPepper, 20);
    expect(itemCount(state, ItemId.ChiliPepper), 'all twenty went in').toBe(0);

    // An hour of world time. Nothing feeds it, so it never turns a batch.
    stepMany(state, 60 * ACTIVE_MINUTE);
    expect(seasoner.outputCount, 'a starved Seasoner made nothing').toBe(0);

    box(state, seasoner.id);

    // Two minutes of clock against an hour of standing still: they are compost, and the sweep
    // that turns them is the one that turns everything else.
    stepMany(state, 2);
    expect(itemCount(state, ItemId.ChiliPepper)).toBe(0);
    expect(itemCount(state, ItemId.Compost)).toBeGreaterThanOrEqual(20);
  });

  it('hands the clock back rather than destroying it — box it straight away and lose nothing', () => {
    // The other half of the ruling, and the reason it is a clock rather than a refusal: boxing is
    // the free rearranging verb, so a player who loads a hopper and immediately changes their
    // mind must get their peppers back with the time they had.
    const state = world(113);
    const seasoner = spawnMachine(state, MachineKind.Seasoner, 0, 0)!;
    agedTo(state, ItemId.ChiliPepper, 20, 12_000);

    load(state, seasoner.id, ItemId.ChiliPepper, 20);
    stepMany(state, ACTIVE_MINUTE);
    box(state, seasoner.id);

    expect(itemCount(state, ItemId.ChiliPepper)).toBe(20);
    // Twelve thousand ticks went in, a minute of world time passed, so a little under eleven
    // thousand come out. A minute inside costs a minute, exactly as a minute outside does — and
    // the handful of ticks past that minute are the two command ticks and the bucket rounding,
    // which is `spoilTickFromRemaining` flooring in the player's disfavour, on purpose.
    const left = remainingFreshness(state, ItemId.ChiliPepper);
    expect(left).toBeGreaterThan(12_000 - ACTIVE_MINUTE - FRESHNESS_BUCKET_TICKS);
    expect(left).toBeLessThanOrEqual(12_000 - ACTIVE_MINUTE);
  });

  it('spends the clock while the goods sit, so a hopper is not a fridge either', () => {
    const state = world(114);
    const seasoner = spawnMachine(state, MachineKind.Seasoner, 0, 0)!;
    addItem(state, ItemId.ChiliPepper, 10);
    load(state, seasoner.id, ItemId.ChiliPepper, 10);

    const hopper = machineHoppers(machineSpec(MachineKind.Seasoner)!).findIndex(
      (line) => line.item === ItemId.ChiliPepper,
    );
    expect(hopper, 'item 111 gave the Seasoner a pepper hopper').toBeGreaterThanOrEqual(0);

    // A tick short of the full window, because the tick that carried the LoadMachine command
    // also ran the sweep — the goods were inside for it. That is the direction every rounding in
    // this feature leans, and it is the direction a bug in it would not.
    const before = seasoner.inputFreshTicks[hopper]!;
    expect(before).toBe(PEPPER_WINDOW - 1);
    stepMany(state, 5 * ACTIVE_MINUTE);
    expect(seasoner.inputFreshTicks[hopper]!).toBe(before - 5 * ACTIVE_MINUTE);
  });

  it('merges an armful into a stocked hopper at the SOONER clock, never the later one', () => {
    // The exploit written the other way round: top a hopper up with one fresh pepper every
    // quarter hour and the old ones live forever. `mergedCargoFreshness`' rule, on a hopper.
    const state = world(115);
    const seasoner = spawnMachine(state, MachineKind.Seasoner, 0, 0)!;
    const hopper = machineHoppers(machineSpec(MachineKind.Seasoner)!).findIndex(
      (line) => line.item === ItemId.ChiliPepper,
    );

    agedTo(state, ItemId.ChiliPepper, 5, 3_000);
    load(state, seasoner.id, ItemId.ChiliPepper, 5);
    const older = seasoner.inputFreshTicks[hopper]!;
    expect(older).toBe(3_000 - 1);

    // Five brand-new peppers, worth a full fifteen minutes, join five with fifty seconds left.
    addItem(state, ItemId.ChiliPepper, 5);
    load(state, seasoner.id, ItemId.ChiliPepper, 5);
    expect(seasoner.inputCounts[hopper]!).toBe(10);
    expect(seasoner.inputFreshTicks[hopper]!, 'the sooner of the two, always').toBe(older - 1);
  });

  it('leaves a shelf-stable hopper alone — bagged chips wait forever and lose nothing', () => {
    // A Combo Packer starved of soda: it holds its chips and cannot run, which is the exact
    // shape of the exploit — and chips are shelf-stable, so the honest answer is that nothing
    // happens to them at all, for as long as the player likes. Rot is not a tax on standing
    // still; it is a clock on things that have one.
    const state = world(116);
    const packer = spawnMachine(state, MachineKind.ComboPacker, 0, 0)!;
    addItem(state, ItemId.BaggedChips, 10);
    load(state, packer.id, ItemId.BaggedChips, 10);

    stepMany(state, 60 * ACTIVE_MINUTE);
    expect(packer.outputCount, 'no soda, so it never ran').toBe(0);
    expect(packer.inputCounts.some((count) => count > 0)).toBe(true);
    expect(packer.inputFreshTicks.every((ticks) => ticks === 0)).toBe(true);

    box(state, packer.id);
    expect(itemCount(state, ItemId.BaggedChips)).toBe(10);
    stepMany(state, 2);
    expect(itemCount(state, ItemId.BaggedChips), 'and none of them turned').toBe(10);
  });
});

// --- door 3: the output basket ----------------------------------------------------------

describe('a backed-up output basket', () => {
  it('THE EXPLOIT, WITH NO BOXING AT ALL: washed potatoes cannot age in the basket for free', () => {
    // This one needs one keypress, not two. A Washer fills its basket, the belt behind it is
    // missing or full, the player walks over an hour later and unloads — and under the old rule
    // took delivery of a brand-new six-minute window on potatoes washed an hour ago.
    const state = world(117);
    const washer = spawnMachine(state, MachineKind.Washer, 0, 0)!;
    addItem(state, ItemId.RussetPotato, 40);
    load(state, washer.id, ItemId.RussetPotato, 40);

    stepMany(state, 60 * ACTIVE_MINUTE);
    expect(washer.outputCount, 'it filled its basket and stopped').toBeGreaterThan(0);

    unload(state, washer.id, 99);
    stepMany(state, 2);
    expect(itemCount(state, ItemId.WashedPotato)).toBe(0);
    expect(itemCount(state, ItemId.Compost)).toBeGreaterThan(0);
  });

  it('starts its clock when the unit is made, and hands back what is left', () => {
    const state = world(118);
    const washer = spawnMachine(state, MachineKind.Washer, 0, 0)!;
    addItem(state, ItemId.RussetPotato, 4);
    load(state, washer.id, ItemId.RussetPotato, 4);

    stepMany(state, 600);
    expect(washer.outputCount).toBeGreaterThan(0);
    const made = washer.outputFreshTicks;
    expect(made).toBeGreaterThan(0);

    stepMany(state, ACTIVE_MINUTE);
    expect(washer.outputFreshTicks).toBe(made - ACTIVE_MINUTE);

    unload(state, washer.id, 99);
    const left = remainingFreshness(state, ItemId.WashedPotato);
    expect(left).toBeGreaterThan(0);
    expect(left, 'never more clock than the basket was holding').toBeLessThanOrEqual(made);
  });

  it('leaves a shelf-stable basket alone — a Fryer of chips keeps no clock', () => {
    const state = world(119);
    const fryer = spawnMachine(state, MachineKind.Fryer, 0, 0)!;
    addItem(state, ItemId.PotatoSlices, 20);
    load(state, fryer.id, ItemId.PotatoSlices, 20);

    stepMany(state, 20 * ACTIVE_MINUTE);
    expect(fryer.outputCount).toBeGreaterThan(0);
    expect(fryer.outputFreshTicks, 'chips are shelf-stable forever (§4)').toBe(0);
  });
});

// --- door 4: the belt -------------------------------------------------------------------

describe('the belt loop', () => {
  /**
   * The verifier's automated exploit, built out of real machines: a cart, an arm, a run of belt,
   * a second arm, a second cart. No clicking; it runs itself.
   *
   *   cart A (0,0) → arm (1,0) → belt (2,0)..(5,0) → arm (6,0) → cart B (7,0)
   */
  function loop(state: WorldState) {
    const from = spawnMachine(state, MachineKind.HandCart, 0, 0)!;
    spawnGrabber(state, GrabberTier.Mk1, 1, 0, Direction.East, 0);
    spawnBelt(state, BeltTier.Basic, 2, 0, Direction.East, 4);
    spawnGrabber(state, GrabberTier.Mk1, 6, 0, Direction.East, 0);
    const to = spawnMachine(state, MachineKind.HandCart, 7, 0)!;
    return { from, to };
  }

  it('THE EXPLOIT: a cart → belt → cart round trip cannot mint a window', () => {
    const state = world(120);
    const { from, to } = loop(state);

    agedTo(state, ItemId.RussetPotato, 10, 2_400);
    load(state, from.id, ItemId.RussetPotato, 10);
    expect(from.cargoFreshTicks).toBe(2_400 - 1);

    // Long enough for the arms to walk the whole load across.
    stepMany(state, 2_000);
    expect(to.cargoCount, 'the load made it across').toBeGreaterThan(0);
    expect(to.cargoItem).toBe(ItemId.RussetPotato);
    expect(
      to.cargoFreshTicks,
      'a belt is a place goods pass through, not a place they get younger',
    ).toBeLessThanOrEqual(2_400);
  });

  it('spends the clock while an item rides, and turns it to compost where it stands', () => {
    // A belt item HAS an identity field, so unlike a hopper line it can turn in place — exactly
    // as a cellar's load does. The player watches compost ride into their Bagger, which is the
    // diagnostic plan §5 asks for.
    const state = world(121);
    const from = spawnMachine(state, MachineKind.HandCart, 0, 0)!;
    spawnGrabber(state, GrabberTier.Mk1, 1, 0, Direction.East, 0);
    spawnBelt(state, BeltTier.Basic, 2, 0, Direction.East, 4);

    agedTo(state, ItemId.RussetPotato, 4, 600);
    load(state, from.id, ItemId.RussetPotato, 4);

    stepMany(state, 60);
    const belt = beltAt(state, 2, 0)!;
    expect(belt.items.length).toBeGreaterThan(0);
    expect(belt.items[0]!.freshTicks).toBeGreaterThan(0);
    expect(belt.items[0]!.freshTicks).toBeLessThanOrEqual(600);

    // Nothing takes them off the end, so they queue up and run out of time in the open.
    stepMany(state, 2_000);
    const stalled = beltAt(state, 2, 0)!;
    expect(stalled.items.length).toBeGreaterThan(0);
    expect(stalled.items.every((entry) => entry.item === ItemId.Compost)).toBe(true);
    expect(stalled.items.every((entry) => entry.freshTicks === 0)).toBe(true);
  });

  it('carries no clock for a shelf-stable good, so nothing on a chip line ever changes', () => {
    const state = world(122);
    const belt = spawnBelt(state, BeltTier.Basic, 2, 0, Direction.East, 4)!;
    const from = spawnMachine(state, MachineKind.HandCart, 0, 0)!;
    spawnGrabber(state, GrabberTier.Mk1, 1, 0, Direction.East, 0);

    addItem(state, ItemId.PlainChips, 4);
    load(state, from.id, ItemId.PlainChips, 4);
    stepMany(state, 200);

    expect(belt.items.length).toBeGreaterThan(0);
    expect(belt.items.every((entry) => entry.item === ItemId.PlainChips)).toBe(true);
    expect(belt.items.every((entry) => entry.freshTicks === 0)).toBe(true);
  });
});

// --- the teardown verbs, which are the doors it is easiest to forget ----------------------
//
// Every one of these hands goods back to the player, and every one of them called `addItem`
// until this item — which is the exact shape of the bug, four more times. They are gathered
// here rather than beside their features because the lesson is the pattern: **the last thing a
// clock has to survive is the verb that dismantles the thing holding it.**

describe('taking it all back up', () => {
  it('hands back a belt run with the clocks its goods were riding on', () => {
    const state = world(130);
    const belt = spawnBelt(state, BeltTier.Basic, 2, 0, Direction.East, 4)!;
    beltInsert(belt, 0, ItemId.RussetPotato, 1_800);

    stepMany(state, 600);
    step(state, { tick: state.tick, commands: [{ type: 'RemoveBelt', beltId: belt.id }] });

    expect(itemCount(state, ItemId.RussetPotato)).toBe(1);
    const left = remainingFreshness(state, ItemId.RussetPotato);
    expect(left, 'ten minutes of riding is not undone by a refund').toBeLessThanOrEqual(1_200);
  });

  it("hands back the one tile it cut, with that tile's clock", () => {
    const state = world(131);
    const belt = spawnBelt(state, BeltTier.Basic, 2, 0, Direction.East, 4)!;
    beltInsert(belt, 2 * 256 + 40, ItemId.RussetPotato, 1_500);

    step(state, { tick: state.tick, commands: [{ type: 'RemoveBeltTile', tileX: 4, tileY: 0 }] });
    expect(itemCount(state, ItemId.RussetPotato)).toBe(1);
    expect(remainingFreshness(state, ItemId.RussetPotato)).toBeLessThanOrEqual(1_500);
  });

  it('hands back what a stalled arm was holding, with the hour it stood there', () => {
    // The arm grabs while the cart has room, then the cart fills and it stands. That is item
    // 085's one remaining stall, and it is the only way an arm holds anything for long.
    const state = world(132);
    const cellar = spawnMachine(state, MachineKind.RootCellar, 0, 0)!;
    const arm = spawnGrabber(state, GrabberTier.Mk1, 2, 0, Direction.East, 0)!;
    const dest = spawnMachine(state, MachineKind.HandCart, 3, 0)!;
    cellar.cargoItem = ItemId.RussetPotato;
    cellar.cargoCount = 5;
    cellar.cargoFreshTicks = 3_000;
    dest.cargoItem = ItemId.RussetPotato;
    dest.cargoCount = 1;
    dest.cargoFreshTicks = 3_000;

    // Wait for the exact tick the claw closes, then fill the cart under it. An arm asks its
    // destination BEFORE it grabs (item 085), so an arm aimed at an already-full cart never picks
    // anything up and there is no stall to test.
    let grabbed = false;
    for (let i = 0; i < 200 && !grabbed; i++) {
      stepMany(state, 1);
      grabbed = arm.held !== 0;
    }
    expect(arm.held, 'the arm closed on a potato').toBe(ItemId.RussetPotato);
    dest.cargoCount = machineSpec(MachineKind.HandCart)!.inputCapacity;

    stepMany(state, 2 * ACTIVE_MINUTE);
    expect(arm.held, 'and could not put it down').toBe(ItemId.RussetPotato);

    const before = itemCount(state, ItemId.RussetPotato);
    step(state, { tick: state.tick, commands: [{ type: 'RemoveGrabber', grabberId: arm.id }] });
    expect(itemCount(state, ItemId.RussetPotato)).toBe(before + 1);
    expect(
      remainingFreshness(state, ItemId.RussetPotato),
      'a refund is not a way to un-stand-there',
    ).toBeLessThan(3_000 - ACTIVE_MINUTE);
  });

  it('unloads a harvester dock at the clock its shelf has been spending', () => {
    const state = world(133);
    const dock = spawnMachine(state, MachineKind.HarvesterDock, 0, 0)!;
    dock.cargoItem = ItemId.RussetPotato;
    dock.cargoCount = 6;
    dock.cargoFreshTicks = 4_800;

    stepMany(state, 3 * ACTIVE_MINUTE);
    expect(dock.cargoFreshTicks, 'a shed is not a fridge either').toBe(4_800 - 3 * ACTIVE_MINUTE);

    unload(state, dock.id, 6);
    expect(itemCount(state, ItemId.RussetPotato)).toBe(6);
    expect(remainingFreshness(state, ItemId.RussetPotato)).toBeLessThanOrEqual(
      4_800 - 3 * ACTIVE_MINUTE,
    );
  });
});

// --- the grandfathered box --------------------------------------------------------------

describe('a box grandfathered by format 18', () => {
  it('grants one window in total, not one per unit taken', () => {
    // Recorded by item 110's verifier and undersold by its log: a clockless box handed every
    // take a brand-new window measured from the tick of that take, so two takes ten thousand
    // ticks apart were both stamped 18,000 — a cellar that had been sitting since before this
    // build was a perpetual-motion machine, one armful at a time.
    // A CART RATHER THAN A CELLAR, and the difference is the whole ladder: the Root Cellar's
    // clock is genuinely stopped (`STORAGE_AGING_BY_KIND` gives it the only 0 in the game), so a
    // cellar handing out a full window ten thousand ticks later is the $250 machine doing its
    // job. The cart is what a grandfathered container looks like when it is supposed to age.
    const state = world(123);
    const cart = spawnMachine(state, MachineKind.HandCart, 0, 0)!;
    cart.cargoItem = ItemId.RussetPotato;
    cart.cargoCount = 20;
    cart.cargoFreshTicks = 0; // exactly what migration 17 → 18 writes.

    unload(state, cart.id, 1);
    const first = remainingFreshness(state, ItemId.RussetPotato);
    expect(first, 'the format-17 promise is kept for the first armful').toBeGreaterThan(
      POTATO_WINDOW - 2 * ACTIVE_MINUTE,
    );

    stepMany(state, 10_000);
    expect(
      cart.cargoFreshTicks,
      'the clock started on first contact and has been running ever since',
    ).toBeLessThanOrEqual(POTATO_WINDOW - 10_000);
    expect(cart.cargoFreshTicks).toBeGreaterThan(0);

    // The second armful gets what is LEFT of that one window, not a fresh one measured from now.
    unload(state, cart.id, 1);
    const second = state.tick + cart.cargoFreshTicks;
    expect(second, 'one window in total').toBeLessThan(POTATO_WINDOW + ACTIVE_MINUTE);
  });
});
