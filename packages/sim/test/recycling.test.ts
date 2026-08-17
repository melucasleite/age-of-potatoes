// **THE BOTTLE COMES BACK** (item 131).
//
// A delivery leaves the lot with soda and the vehicle comes home with the empties; a Washer turns
// them back into bottles the Bottler can use again. The owner's ask, verbatim: *"at a recycling
// center that takes used bottles, used bottles out of the depot once they come back from a
// delivery and turns them into clean bottles to be used by the bottler."*
//
// **THE OWNER RULED FOR THE WASHER** (2026-08-17: *"Okey washer it is."*) over a new Recycling
// Centre, and that ruling is the reason the first test in this file is an arithmetic one. A new
// machine costs two recipe-graph nodes — the item plus the machine — and plan §5 caps the graph at
// ~50. A recipe on a machine that already exists costs ONE. The graph is now at 50 of ~50, and the
// first test says so out loud so that the next feature to want a node finds a red assertion rather
// than a comment it can talk itself past.
//
// Everything else here is the loop, driven rather than described: out through a cart, out through
// a truck, home again, into a Washer, and back out as the same `ItemId.Bottle` the Bottler has
// eaten since v0.1.

import { describe, expect, it } from 'vitest';

import {
  type Machine,
  type WorldState,
  CART_CAPACITY,
  Direction,
  EMPTIES_PER_DELIVERY,
  GrabberTier,
  ITEM_SPECS,
  ItemId,
  LiquidId,
  MachineKind,
  SIX_PACK_COUNT,
  SUBTILE,
  USED_BOTTLE_SCRAP_CENTS,
  VEHICLE_EMPTIES_CAPACITY,
  addItem,
  createWorld,
  depotAccept,
  deserialize,
  emptiesForDelivery,
  freshnessTicks,
  hashState,
  hopperIndexFor,
  isPurchasable,
  isSellable,
  itemCount,
  listPriceCents,
  machineHoppers,
  machineRecipes,
  machineSpec,
  restoreWorld,
  serialize,
  spawnGrabber,
  spawnMachine,
  step,
  stepMany,
} from '../src/index';
import { loadFixture } from './goldens';
import formatSeven from './fixtures/saves/format-7.json';

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

/** A cart standing beside the player, loaded with `count` of `item` and already on the road. */
function dispatchedCart(state: WorldState, item: ItemId, count: number): Machine {
  const cart = spawnMachine(state, MachineKind.DeliveryCart, 6, 6)!;
  standOn(state, 6, 6);
  addItem(state, item, count);
  run(state, { type: 'LoadCart', cartId: cart.id, item, count });
  expect(cart.cargoCount, 'the cart took the load').toBe(count);
  run(state, { type: 'DispatchCart', cartId: cart.id });
  expect(cart.runTicksRemaining, 'the cart is on the road').toBeGreaterThan(0);
  return cart;
}

/** A depot with one route for `item`, its floor stocked to exactly one run. */
function loadedDepot(state: WorldState, item: ItemId, quantityPerRun: number): Machine {
  const depot = spawnMachine(state, MachineKind.TruckDepot, 6, 6)!;
  standOn(state, 6, 6);
  run(state, {
    type: 'CreateContract',
    depotId: depot.id,
    item,
    quantityPerRun,
    destination: 'Ridgeline Grocers',
  });
  expect(state.contracts, 'the route was signed').toHaveLength(1);
  for (let i = 0; i < quantityPerRun; i++) depotAccept(state, depot, item, 0);
  return depot;
}

// --- the node budget --------------------------------------------------------------------------

describe('the recipe graph after item 131', () => {
  it('STANDS AT 50 OF ~50, which is the whole reason this is a Washer recipe and not a machine', () => {
    // Plan §5 caps the graph at ~50 items and `data.ts`'s `ItemId` header calls the cap "a real
    // constraint". The count is non-boxed items plus liquids: a boxed machine is not a node,
    // because nothing eats one, nothing makes one, and no belt will ever carry one.
    const nodes = ITEM_SPECS.filter((spec) => !spec.slug.startsWith('boxed-')).length;
    const liquids = Object.values(LiquidId).filter((id) => id !== LiquidId.None).length;

    expect(nodes).toBe(45);
    expect(liquids).toBe(5);
    expect(nodes + liquids).toBe(50);

    // **THE SENTENCE THIS TEST EXISTS TO MAKE UNAVOIDABLE.** There is no headroom left. The next
    // feature that wants a node buys a raise from the owner or it does not ship, and the way it
    // finds that out is this line going red rather than a paragraph nobody re-read.
    expect(nodes + liquids).toBeLessThanOrEqual(50);
  });

  it('spent that node on the item and NOT on a machine — the Washer grew a recipe instead', () => {
    const washer = machineSpec(MachineKind.Washer)!;
    const recipes = machineRecipes(washer);
    expect(recipes.map((recipe) => recipe.output)).toEqual([
      ItemId.WashedGoldPotato,
      ItemId.Bottle,
      ItemId.WashedPotato,
    ]);
    // No Recycling Centre, and the negative is the assertion: the roster gained no machine.
    expect(Object.keys(MachineKind).some((kind) => /recycl/i.test(kind))).toBe(false);
  });

  it('KEEPS THE EXISTING HOPPER INDICES, which is a save-compatibility rule and not a preference', () => {
    // `machine.inputCounts` is stored parallel to `machineHoppers()` in every save on disk. The
    // bottle recipe is declared SECOND precisely so the new hopper lands on the end: declared
    // first, it would have inserted at index 1 and slid the gold-potato line to index 2, which
    // silently relabels every saved Washer's gold potatoes as used bottles.
    const washer = machineSpec(MachineKind.Washer)!;
    expect(machineHoppers(washer).map((line) => line.item)).toEqual([
      ItemId.RussetPotato,
      ItemId.GoldPotato,
      ItemId.UsedBottle,
    ]);
    expect(hopperIndexFor(washer, ItemId.RussetPotato)).toBe(0);
    expect(hopperIndexFor(washer, ItemId.GoldPotato)).toBe(1);
    expect(hopperIndexFor(washer, ItemId.UsedBottle)).toBe(2);
  });
});

// --- what an empty is -------------------------------------------------------------------------

describe('the used bottle', () => {
  it('is sellable at a TENTH of a clean bottle, and cannot be bought', () => {
    // The anti-rubbish clause: a player who never builds the loop still accumulates these the
    // moment they deliver a soda, and plan §4's floor says nothing they own is stranded. The ratio
    // is what makes washing the obvious move without any arithmetic — ten times, always.
    expect(isSellable(ItemId.UsedBottle)).toBe(true);
    expect(isPurchasable(ItemId.UsedBottle)).toBe(false);
    expect(listPriceCents(ItemId.UsedBottle)).toBe(USED_BOTTLE_SCRAP_CENTS);
    expect(listPriceCents(ItemId.Bottle)).toBe(listPriceCents(ItemId.UsedBottle) * 10);
  });

  it('keeps no clock, exactly as the bottle it used to be does not', () => {
    expect(freshnessTicks(ItemId.UsedBottle)).toBe(0);
    expect(freshnessTicks(ItemId.Bottle)).toBe(0);
  });
});

describe('EMPTIES_PER_DELIVERY', () => {
  it('counts the bottles that ACTUALLY WENT OUT, read off the recipes that built each product', () => {
    // Nothing in the table is invented. A Soda is one bottle; a Six-Pack is `SIX_PACK_COUNT`
    // sodas and therefore that many bottles; a Snack Combo is a bag of chips and one soda.
    const bottler = machineSpec(MachineKind.Bottler)!;
    expect(bottler.inputs.find((line) => line.item === ItemId.Bottle)?.count).toBe(1);

    const sixPacker = machineSpec(MachineKind.SixPacker)!;
    expect(sixPacker.inputs.find((line) => line.item === ItemId.Soda)?.count).toBe(SIX_PACK_COUNT);

    const combo = machineSpec(MachineKind.ComboPacker)!;
    expect(combo.inputs.find((line) => line.item === ItemId.Soda)?.count).toBe(1);

    expect(emptiesForDelivery(ItemId.Soda, 1)).toEqual({ item: ItemId.UsedBottle, count: 1 });
    expect(emptiesForDelivery(ItemId.SixPack, 1)).toEqual({
      item: ItemId.UsedBottle,
      count: SIX_PACK_COUNT,
    });
    expect(emptiesForDelivery(ItemId.SnackCombo, 1)).toEqual({
      item: ItemId.UsedBottle,
      count: 1,
    });
  });

  it('says nothing about the forty-two goods that contain no bottle', () => {
    expect(emptiesForDelivery(ItemId.RussetPotato, 10)).toBeNull();
    expect(emptiesForDelivery(ItemId.BaggedChips, 10)).toBeNull();
    // A delivery of nothing returns nothing, rather than an empty promise of zero.
    expect(emptiesForDelivery(ItemId.Soda, 0)).toBeNull();
    expect(EMPTIES_PER_DELIVERY.every((row) => row.returnsItem === ItemId.UsedBottle)).toBe(true);
  });

  it('sizes a vehicle basket at one cart-load of six-packs', () => {
    // `VEHICLE_EMPTIES_CAPACITY` is a literal because `CART_CAPACITY` is declared below
    // `MACHINE_SPECS` and a spec cannot read a constant that has not been evaluated yet. This is
    // the derivation, executed, so the two cannot drift.
    expect(VEHICLE_EMPTIES_CAPACITY).toBe(CART_CAPACITY * SIX_PACK_COUNT);
    expect(machineSpec(MachineKind.DeliveryCart)!.outputCapacity).toBe(VEHICLE_EMPTIES_CAPACITY);
    expect(machineSpec(MachineKind.TruckDepot)!.outputCapacity).toBe(VEHICLE_EMPTIES_CAPACITY);
  });
});

// --- the return leg ---------------------------------------------------------------------------

describe('a completed delivery returns its empties', () => {
  it('LANDS THEM IN THE CART, one per soda, on the tick the run completes', () => {
    const state = createWorld(13_100);
    const cart = dispatchedCart(state, ItemId.Soda, 6);
    const before = state.moneyCents;

    expect(cart.outputCount).toBe(0);
    const arrived = stepUntil(state, 3_000, () => cart.runTicksRemaining === 0);
    expect(arrived).toBeGreaterThan(0);

    expect(cart.outputItem).toBe(ItemId.UsedBottle);
    expect(cart.outputCount).toBe(6);
    // The sale still happens in full — the return leg is beside the payout, not instead of it.
    expect(state.moneyCents - before).toBe(6 * listPriceCents(ItemId.Soda));
    expect(cart.cargoCount).toBe(0);
    expect(cart.cargoItem).toBe(0);
  });

  it('LANDS THEM ON THE DEPOT FLOOR, SIX PER SIX-PACK — the row whose count is not one', () => {
    const state = createWorld(13_101);
    const depot = loadedDepot(state, ItemId.SixPack, 4);

    const arrived = stepUntil(state, 8_000, () => depot.outputCount > 0);
    expect(arrived).toBeGreaterThan(0);
    expect(depot.outputItem).toBe(ItemId.UsedBottle);
    expect(depot.outputCount).toBe(4 * SIX_PACK_COUNT);
    expect(state.contracts[0]!.runsCompleted).toBe(1);
  });

  it('returns NOTHING from a delivery with no bottle in it', () => {
    const state = createWorld(13_102);
    const cart = dispatchedCart(state, ItemId.RussetPotato, 6);
    stepUntil(state, 3_000, () => cart.runTicksRemaining === 0);
    expect(cart.outputCount).toBe(0);
    expect(cart.outputItem).toBe(0);
  });

  it('sends them to the depot that SIGNED the route, not to whichever shed is first', () => {
    // Two depots, one route. A load returning to the wrong yard would be a teleport.
    const state = createWorld(13_103);
    const other = spawnMachine(state, MachineKind.TruckDepot, 20, 20)!;
    const depot = loadedDepot(state, ItemId.Soda, 5);

    stepUntil(state, 8_000, () => depot.outputCount > 0);
    expect(depot.outputCount).toBe(5);
    expect(other.outputCount).toBe(0);
  });

  it('accumulates across runs rather than replacing the last load', () => {
    const state = createWorld(13_104);
    const depot = loadedDepot(state, ItemId.Soda, 3);
    stepUntil(state, 8_000, () => depot.outputCount > 0);
    expect(depot.outputCount).toBe(3);

    for (let i = 0; i < 3; i++) depotAccept(state, depot, ItemId.Soda, 0);
    stepUntil(state, 8_000, () => depot.outputCount > 3);
    expect(depot.outputCount).toBe(6);
  });
});

describe('a full basket', () => {
  it('MINTS FEWER EMPTIES AND NEVER STALLS THE RUN — the clause that protects every old save', () => {
    const state = createWorld(13_110);
    const cart = spawnMachine(state, MachineKind.DeliveryCart, 6, 6)!;
    // Two units short of full, so a six-soda run has room for exactly two.
    cart.outputItem = ItemId.UsedBottle;
    cart.outputCount = VEHICLE_EMPTIES_CAPACITY - 2;

    standOn(state, 6, 6);
    addItem(state, ItemId.Soda, 6);
    run(state, { type: 'LoadCart', cartId: cart.id, item: ItemId.Soda, count: 6 });
    run(state, { type: 'DispatchCart', cartId: cart.id });
    const before = state.moneyCents;

    stepUntil(state, 3_000, () => cart.runTicksRemaining === 0);

    expect(cart.outputCount).toBe(VEHICLE_EMPTIES_CAPACITY);
    // The run completed and paid in full. The alternative design — refuse to dispatch while the
    // basket is full — would have frozen this route instead, which is a brand-new stall in the
    // one ladder whose selling point is that you stop touching it.
    expect(state.moneyCents - before).toBe(6 * listPriceCents(ItemId.Soda));
    expect(cart.cargoCount).toBe(0);
  });

  it('keeps a standing route running forever with nobody emptying it', () => {
    const state = createWorld(13_111);
    const depot = loadedDepot(state, ItemId.Soda, 10);
    depot.outputItem = ItemId.UsedBottle;
    depot.outputCount = VEHICLE_EMPTIES_CAPACITY;

    for (let i = 0; i < 40; i++) depotAccept(state, depot, ItemId.Soda, 0);
    const contract = state.contracts[0]!;
    stepUntil(state, 40_000, () => contract.runsCompleted >= 3);

    expect(contract.runsCompleted).toBeGreaterThanOrEqual(3);
    expect(depot.outputCount).toBe(VEHICLE_EMPTIES_CAPACITY);
  });
});

// --- getting them out again -------------------------------------------------------------------

describe('the empties come out of the vehicle', () => {
  it('BY HAND — the gate that used to read "this machine makes nothing"', () => {
    // `applyUnloadMachine` bailed on `spec.outputItem === null`, which is true of every vehicle,
    // so before item 131 a cart's basket could be filled and never emptied.
    const state = createWorld(13_120);
    const cart = dispatchedCart(state, ItemId.Soda, 6);
    stepUntil(state, 3_000, () => cart.outputCount > 0);

    standOn(state, 6, 6);
    run(state, { type: 'UnloadMachine', machineId: cart.id, count: 99 });
    expect(itemCount(state, ItemId.UsedBottle)).toBe(6);
    expect(cart.outputCount).toBe(0);
    // An emptied basket forgets what it held, so "empty" has one spelling in the hash.
    expect(cart.outputItem).toBe(0);
  });

  it('BY ARM — the same gate, on the grabber side, so hand and claw cannot disagree', () => {
    const state = createWorld(13_121);
    const depot = loadedDepot(state, ItemId.Soda, 4);
    stepUntil(state, 8_000, () => depot.outputCount > 0);
    expect(depot.outputCount).toBe(4);

    // The depot is 2×2 at (6,6); an arm at (8,6) reaches back into (7,6) and forward to (9,6).
    spawnGrabber(state, GrabberTier.Mk1, 8, 6, Direction.East, 0);
    spawnMachine(state, MachineKind.RootCellar, 9, 6);

    stepUntil(state, 2_000, () => depot.outputCount < 4);
    expect(depot.outputCount).toBeLessThan(4);
  });

  it('AND COME BACK IN THE BOX when the vehicle is torn down — nothing vanishes', () => {
    const state = createWorld(13_122);
    const cart = dispatchedCart(state, ItemId.Soda, 6);
    stepUntil(state, 3_000, () => cart.outputCount > 0);

    standOn(state, 6, 6);
    run(state, { type: 'DeconstructMachine', machineId: cart.id });
    expect(itemCount(state, ItemId.UsedBottle)).toBe(6);
  });
});

// --- the wash ---------------------------------------------------------------------------------

describe('the Washer', () => {
  it('turns a used bottle into THE SAME ItemId.Bottle THE BOTTLER HAS ALWAYS EATEN', () => {
    const state = createWorld(13_130);
    const washer = spawnMachine(state, MachineKind.Washer, 8, 8)!;
    standOn(state, 8, 8);
    addItem(state, ItemId.UsedBottle, 4);
    run(state, { type: 'LoadMachine', machineId: washer.id, item: ItemId.UsedBottle, count: 4 });

    stepUntil(state, 2_000, () => washer.outputCount >= 4);
    expect(washer.outputItem).toBe(ItemId.Bottle);
    expect(washer.outputCount).toBe(4);
    expect(
      washer.inputCounts[hopperIndexFor(machineSpec(MachineKind.Washer)!, ItemId.UsedBottle)],
    ).toBe(0);

    // The identity that makes the loop close: a Bottler's hopper is for exactly this id.
    expect(hopperIndexFor(machineSpec(MachineKind.Bottler)!, ItemId.Bottle)).toBeGreaterThanOrEqual(
      0,
    );
  });

  it('WASHES BOTTLES BEFORE RUSSETS and falls straight back to potatoes when they run out', () => {
    // Order is production priority, this file's own idiom: the scarce burst goes above the
    // continuous staple, exactly as a chili line goes above plain salt. What matters as much is
    // the second half — the plain line is always reachable, so nothing can deadlock.
    const state = createWorld(13_131);
    const washer = spawnMachine(state, MachineKind.Washer, 8, 8)!;
    standOn(state, 8, 8);
    addItem(state, ItemId.UsedBottle, 2);
    addItem(state, ItemId.RussetPotato, 2);
    run(state, { type: 'LoadMachine', machineId: washer.id, item: ItemId.UsedBottle, count: 2 });
    run(state, { type: 'LoadMachine', machineId: washer.id, item: ItemId.RussetPotato, count: 2 });

    stepUntil(state, 2_000, () => washer.outputCount > 0);
    expect(washer.outputItem).toBe(ItemId.Bottle);

    // Take the glass away and the potatoes go through, which is the fallback being real rather
    // than promised: a basket holds one product, so the line resumes the moment it is drained.
    stepUntil(state, 2_000, () => washer.outputCount >= 2);
    run(state, { type: 'UnloadMachine', machineId: washer.id, count: 99 });
    stepUntil(state, 2_000, () => washer.outputCount > 0);
    expect(washer.outputItem).toBe(ItemId.WashedPotato);
  });

  it('still washes a plain potato line exactly as it did before this item', () => {
    const state = createWorld(13_132);
    const washer = spawnMachine(state, MachineKind.Washer, 8, 8)!;
    standOn(state, 8, 8);
    addItem(state, ItemId.RussetPotato, 3);
    run(state, { type: 'LoadMachine', machineId: washer.id, item: ItemId.RussetPotato, count: 3 });
    stepUntil(state, 2_000, () => washer.outputCount >= 3);
    expect(washer.outputItem).toBe(ItemId.WashedPotato);
    expect(washer.outputCount).toBe(3);
  });
});

// --- the whole loop, on one lot ---------------------------------------------------------------

describe('the loop closes', () => {
  it('DELIVERS, RETURNS, WASHES AND FEEDS THE BOTTLER without a hand on any of it', () => {
    // cart(6,6) → arm(7,6) → Washer(8,6..9,7) → arm(10,6) → Bottler(11,6..13,7)
    //
    // The Bottler has no syrup and no carbonated water, so it cannot run — which is exactly what
    // makes it a measuring instrument here: bottles arriving in its hopper stay there to be
    // counted, and what is counted is glass that started the run inside a soda.
    const state = createWorld(13_140);
    const cart = dispatchedCart(state, ItemId.Soda, 8);

    spawnGrabber(state, GrabberTier.Mk1, 7, 6, Direction.East, 0);
    const washer = spawnMachine(state, MachineKind.Washer, 8, 6)!;
    spawnGrabber(state, GrabberTier.Mk1, 10, 6, Direction.East, 0);
    const bottler = spawnMachine(state, MachineKind.Bottler, 11, 6)!;
    const bottleLine = hopperIndexFor(machineSpec(MachineKind.Bottler)!, ItemId.Bottle);
    expect(bottleLine).toBeGreaterThanOrEqual(0);

    // The player walks away the moment the cart is dispatched. Everything after this is machines.
    standOn(state, 40, 40);
    const landed = stepUntil(state, 20_000, () => (bottler.inputCounts[bottleLine] ?? 0) >= 8);

    expect(landed).toBeGreaterThan(0);
    expect(bottler.inputCounts[bottleLine]).toBe(8);
    expect(cart.outputCount).toBe(0);
    expect(washer.outputCount).toBe(0);
  });

  it('BEATS BUYING, and the numbers that make it so are these', () => {
    // A clean bottle is 120¢ and there is no cash cost to washing one: the Washer consumes no
    // liquid (`LiquidId.None`, no ports — it has never consumed water for a potato either), so
    // what a wash costs is one wear point, the same as a potato, plus the Washer-seconds and the
    // floor space. That is the answer to "what does washing cost", and it is deliberately NOT
    // water: item 130 had just landed the Artesian Well because the owner was short of it, and a
    // recycling loop that ate a scarce resource would be a frustration rather than a tension.
    const washer = machineSpec(MachineKind.Washer)!;
    expect(washer.liquid).toBe(LiquidId.None);
    expect(washer.ports).toHaveLength(0);
    expect(washer.wearPerOperation).toBe(1);

    // The margin, per soda: a bottle is 7.5% of what a soda sells for, and recycling returns all
    // of it. That is the SCALING answer plan §4 asks for rather than a replacement — buying stays
    // exactly as viable as it was for a player who never builds the return leg, because nothing
    // about `ItemId.Bottle`'s posted price moved.
    expect(listPriceCents(ItemId.Bottle) * 100).toBe(listPriceCents(ItemId.Soda) * 7.5);
    expect(isPurchasable(ItemId.Bottle)).toBe(true);
    expect(listPriceCents(ItemId.Bottle)).toBe(120);
  });
});

// --- the golden, replayed watching ------------------------------------------------------------

describe('the bottle-return golden', () => {
  it('CLOSES THE CIRCLE IN A PINNED WORLD — bought, filled, driven, returned, washed, refilled', () => {
    // **A HASH SAYS "NOTHING CHANGED"; IT DOES NOT SAY WHAT HAPPENED.** `golden.test.ts` replays
    // this fixture and compares one digest, which is exactly the right thing for determinism and
    // no use at all if the story inside quietly stops happening — a fixture whose cart is refused
    // for want of money would replay to a stable hash forever while pinning nothing. So this is
    // the same replay with somebody watching, the pattern `factory.test.ts` uses on `idle-wear`,
    // `maintenance` and `worn-to-zero`.
    const fixture = loadFixture('bottle-return');
    const state = createWorld(fixture.seed);
    let next = 0;
    for (let tick = 0; tick < fixture.ticks; tick++) {
      const commands = [];
      while (next < fixture.commands.length && fixture.commands[next]!.tick === tick) {
        commands.push(fixture.commands[next++]!.command);
      }
      step(state, { tick, commands });
    }

    expect(hashState(state), 'the fixture still replays to its pinned hash').toBe(
      fixture.expectedHash,
    );

    // The liquid build was actually built, rather than refused for money and skipped.
    for (const kind of [
      MachineKind.Juicer,
      MachineKind.Kettle,
      MachineKind.SyrupMixer,
      MachineKind.Bottler,
      MachineKind.Carbonator,
      MachineKind.Grinder,
      MachineKind.Washer,
      MachineKind.Pump,
      MachineKind.DeliveryCart,
    ]) {
      expect(
        state.machines.some((machine) => machine.kind === kind),
        `the fixture is missing machine kind ${String(kind)}`,
      ).toBe(true);
    }

    // The cart went out and came back: it is home, empty of cargo, and its basket has been
    // emptied by hand — which is only possible if it had something in it.
    const cart = state.machines.find((machine) => machine.kind === MachineKind.DeliveryCart)!;
    expect(cart.runTicksRemaining).toBe(0);
    expect(cart.cargoCount).toBe(0);

    // **THE ONE ASSERTION THE WHOLE FIXTURE IS FOR.** The Bottler is holding clean bottles it did
    // not buy — every bottle bought at the stand was consumed making the soda that was driven
    // away, so glass in that hopper at the end of this session came back off a lorry and through
    // a Washer. Nothing else on the lot can have put it there.
    const bottler = state.machines.find((machine) => machine.kind === MachineKind.Bottler)!;
    const line = hopperIndexFor(machineSpec(MachineKind.Bottler)!, ItemId.Bottle);
    expect(bottler.inputCounts[line]).toBeGreaterThan(0);
    expect(itemCount(state, ItemId.Bottle)).toBe(0);
    expect(itemCount(state, ItemId.UsedBottle)).toBe(0);
    expect(itemCount(state, ItemId.Soda)).toBe(0);
  });
});

// --- saves ------------------------------------------------------------------------------------

describe('the save', () => {
  it('carries empties in a basket and a used bottle in a hopper through a round trip', () => {
    // No new field and no migration: the empties live in `machines[].outputItem`/`outputCount`,
    // which every save has carried since v0.1, and the Washer's third hopper lands on the END of
    // `inputCounts`, which is the case `readInputCounts` was already written to absorb.
    const state = createWorld(13_150);
    const depot = loadedDepot(state, ItemId.Soda, 4);
    stepUntil(state, 8_000, () => depot.outputCount > 0);

    const washer = spawnMachine(state, MachineKind.Washer, 20, 20)!;
    standOn(state, 20, 20);
    addItem(state, ItemId.UsedBottle, 5);
    run(state, { type: 'LoadMachine', machineId: washer.id, item: ItemId.UsedBottle, count: 5 });

    const before = hashState(state);
    const restored = deserialize(serialize(state));
    expect(hashState(restored)).toBe(before);

    const depotBack = restored.machines.find((machine) => machine.id === depot.id)!;
    expect(depotBack.outputItem).toBe(ItemId.UsedBottle);
    expect(depotBack.outputCount).toBe(4);

    const washerBack = restored.machines.find((machine) => machine.id === washer.id)!;
    const line = hopperIndexFor(machineSpec(MachineKind.Washer)!, ItemId.UsedBottle);
    expect(washerBack.inputCounts[line]).toBe(5);
    expect(washerBack.inputCounts).toHaveLength(3);
  });

  it('GIVES A FORMAT-7 WASHER ITS THIRD HOPPER WITHOUT MOVING THE POTATOES IN THE FIRST', () => {
    // **THE ONE ASSERTION BEHIND FOUR MOVED DIGESTS IN `save.test.ts`.** Growing the Washer's
    // recipe list grows its hopper array, `hashState` writes that array's length, and so every
    // saved world holding a Washer hashes differently than it did yesterday. That is either a
    // migration working or a save breaking, and the difference is exactly this: does the eleven
    // russet potatoes' count stay at index 0?
    //
    // No migration STEP was needed and none was added. `readHopperArray` sizes the array from
    // today's spec and fills missing tails with 0 — the "a spec that gained a line" case it was
    // written for — which is why the bottle recipe had to be declared second rather than first.
    // First, the new line would have landed at index 1, and this test would be reading eleven
    // USED BOTTLES out of a hopper that has held potatoes since 2026.
    const restored = restoreWorld(formatSeven).state;
    const washer = restored.machines.find((machine) => machine.kind === MachineKind.Washer)!;

    expect(washer.inputCounts).toEqual([11, 0, 0]);
    const spec = machineSpec(MachineKind.Washer)!;
    expect(washer.inputCounts[hopperIndexFor(spec, ItemId.RussetPotato)]).toBe(11);
    expect(washer.inputCounts[hopperIndexFor(spec, ItemId.GoldPotato)]).toBe(0);
    expect(washer.inputCounts[hopperIndexFor(spec, ItemId.UsedBottle)]).toBe(0);
  });
});
