// Selling above the roadside stand: the delivery cart, the truck depot, and standing routes.
//
// Every test here pins a RULING rather than an implementation detail, in the spirit of the rest
// of the suite. The rulings are plan §3's three-tier ladder, plan §6's manual-touch taxonomy and
// its net-worth accounting, and locked decision 3's stable posted prices. If one of these goes
// red, a decision was reversed.
//
// The centrepiece is `the hands-free window`, which is the test the Hands-Free leaderboard board
// is adjudicable by: a real world, replayed from a golden fixture, running five thousand ticks
// with no commands at all while the money goes up.

import { describe, expect, it } from 'vitest';

import {
  type Command,
  type WorldState,
  CART_CAPACITY,
  CART_RUN_BASE_TICKS,
  CeremonyId,
  ContractPhase,
  DEPOT_LOAD_TICKS,
  DEPOT_MAX_CONTRACTS,
  DEPOT_RUN_BASE_TICKS,
  DEPOT_STOCK_CAPACITY,
  FIELD_ORIGIN_X,
  FIELD_ORIGIN_Y,
  ItemId,
  LampState,
  MachineKind,
  RUN_TICKS_PER_TILE_FROM_ROAD,
  SUBTILE,
  TECH_NODES,
  TechBranch,
  TechId,
  BeltTier,
  Direction,
  GrabberTier,
  addItem,
  cartRunTicks,
  computeNetWorthCents,
  createWorld,
  createWorldView,
  depotAccept,
  depotRunTicks,
  depotStockedCount,
  hashState,
  itemCount,
  listPriceCents,
  spawnBelt,
  spawnGrabber,
  spawnMachine,
  step,
  stepMany,
  totalManualTouches,
  view,
} from '../src/index';
import { loadFixture } from './goldens';

function run(state: WorldState, commands: Command[]): void {
  step(state, { tick: state.tick, commands });
}

/** Put the player on a tile so hand verbs are in reach. Position is not a command. */
function standOn(state: WorldState, tileX: number, tileY: number): void {
  state.player.xSub = tileX * SUBTILE + SUBTILE / 2;
  state.player.ySub = tileY * SUBTILE + SUBTILE / 2;
}

/** A world with a cart at `tileX`, the player beside it, and bags in the bag. */
function worldWithCart(seed: number, tileX = 2, tileY = 13) {
  const state = createWorld(seed);
  const cart = spawnMachine(state, MachineKind.DeliveryCart, tileX, tileY)!;
  addItem(state, ItemId.BaggedChips, 40);
  standOn(state, tileX, tileY);
  return { state, cart };
}

function worldWithDepot(seed: number, tileX = 5, tileY = 14) {
  const state = createWorld(seed);
  const depot = spawnMachine(state, MachineKind.TruckDepot, tileX, tileY)!;
  return { state, depot };
}

// --- the ladder ---------------------------------------------------------------------

describe('the delivery cart', () => {
  it('counts a hand-carry touch to load and another to dispatch', () => {
    // PLAN §6'S TAXONOMY, AND THE WHOLE REASON THE ASSISTED RUNG IS NOT THE AUTOMATED ONE. The
    // cart is fewer hands, never no hands; a board that could be won by loading one would be
    // measuring nothing.
    const { state, cart } = worldWithCart(9001);
    expect(totalManualTouches(state.stats.touches)).toBe(0);

    run(state, [{ type: 'LoadCart', cartId: cart.id, item: ItemId.BaggedChips, count: 8 }]);
    expect(state.stats.touches.handCarry).toBe(1);
    expect(cart.cargoCount).toBe(8);
    expect(cart.cargoItem).toBe(ItemId.BaggedChips);

    run(state, [{ type: 'DispatchCart', cartId: cart.id }]);
    expect(state.stats.touches.handCarry).toBe(2);
    expect(cart.runTicksRemaining).toBeGreaterThan(0);
  });

  it('pays exactly the posted list price, the same as the bin would', () => {
    // Locked decision 3: prices are stable and posted. There is no premium for using a cart and
    // there is no penalty either — the money is identical on every route, and that is the point
    // rather than a simplification waiting to be replaced by a market.
    const { state, cart } = worldWithCart(9002);
    run(state, [{ type: 'LoadCart', cartId: cart.id, item: ItemId.BaggedChips, count: 10 }]);
    const before = state.moneyCents;
    run(state, [{ type: 'DispatchCart', cartId: cart.id }]);

    stepMany(state, cartRunTicks(cart));
    expect(state.moneyCents - before).toBe(listPriceCents(ItemId.BaggedChips) * 10);
    expect(state.stats.itemsSold).toBe(10);
    expect(state.stats.automatedGrossCents).toBe(listPriceCents(ItemId.BaggedChips) * 10);
    expect(cart.cargoCount).toBe(0);
  });

  it('does not dip net worth when it leaves, because the goods are still yours', () => {
    // PLAN §6, AND THE REASON `Contract.inTransit` AND THE CARGO FIELDS EXIST. Every board is
    // net-worth-accounted, so a dispatch that moved goods out of the books would record a loss
    // at the kerb and a windfall on the doorstep — neither of which happened.
    const { state, cart } = worldWithCart(9003);
    run(state, [{ type: 'LoadCart', cartId: cart.id, item: ItemId.BaggedChips, count: 12 }]);
    const loaded = computeNetWorthCents(state);
    run(state, [{ type: 'DispatchCart', cartId: cart.id }]);
    expect(computeNetWorthCents(state)).toBe(loaded);

    // And it does not dip on the way, either.
    let lowest = computeNetWorthCents(state);
    for (let i = 0; i < cartRunTicks(cart); i++) {
      stepMany(state, 1);
      const now = computeNetWorthCents(state);
      if (now < lowest) lowest = now;
    }
    expect(lowest).toBe(loaded);
    expect(computeNetWorthCents(state)).toBe(loaded);
  });

  it('carries one product per run, and refuses a second', () => {
    const { state, cart } = worldWithCart(9004);
    addItem(state, ItemId.RussetPotato, 5);
    run(state, [{ type: 'LoadCart', cartId: cart.id, item: ItemId.BaggedChips, count: 4 }]);
    run(state, [{ type: 'LoadCart', cartId: cart.id, item: ItemId.RussetPotato, count: 4 }]);
    expect(cart.cargoItem).toBe(ItemId.BaggedChips);
    expect(cart.cargoCount).toBe(4);
    expect(itemCount(state, ItemId.RussetPotato)).toBe(5);
  });

  it('clamps an over-large load rather than refusing it', () => {
    // The panel asks for `capacity - loaded`; a belt delivering one more bag between the render
    // and the click must not turn a "fill it" button into a silent no-op.
    const { state, cart } = worldWithCart(9005);
    run(state, [{ type: 'LoadCart', cartId: cart.id, item: ItemId.BaggedChips, count: 999 }]);
    expect(cart.cargoCount).toBe(CART_CAPACITY);
  });

  it('refuses seeds, exactly as the bin does', () => {
    // A cart that took seeds would be a bin that bought them with extra steps, and plan §4's
    // anti-softlock floor does not care which verb ended the world.
    const { state, cart } = worldWithCart(9006);
    const seeds = itemCount(state, ItemId.PotatoSeed);
    run(state, [{ type: 'LoadCart', cartId: cart.id, item: ItemId.PotatoSeed, count: 5 }]);
    expect(cart.cargoCount).toBe(0);
    expect(itemCount(state, ItemId.PotatoSeed)).toBe(seeds);
    expect(state.trace).toHaveLength(0);
  });

  it('cannot be loaded, moved, or boxed while it is on the road', () => {
    const { state, cart } = worldWithCart(9007);
    run(state, [{ type: 'LoadCart', cartId: cart.id, item: ItemId.BaggedChips, count: 6 }]);
    run(state, [{ type: 'DispatchCart', cartId: cart.id }]);
    const traceLength = state.trace.length;

    run(state, [{ type: 'LoadCart', cartId: cart.id, item: ItemId.BaggedChips, count: 2 }]);
    run(state, [{ type: 'MoveMachine', machineId: cart.id, tileX: 3, tileY: 13 }]);
    run(state, [{ type: 'DeconstructMachine', machineId: cart.id }]);
    // Three refusals, so nothing was appended and the cart is where and what it was.
    expect(state.trace).toHaveLength(traceLength);
    expect(cart.cargoCount).toBe(6);
    expect(cart.tileX).toBe(2);
    expect(state.machines).toHaveLength(2);
  });

  it('never leaves on its own — a full cart with no command sits there forever', () => {
    // THE ONE RULE THAT MAKES THIS THE ASSISTED RUNG. A cart that departed when full would be a
    // depot with no research behind it, and the automated rung would have nothing left to sell.
    const { state, cart } = worldWithCart(9008);
    run(state, [
      { type: 'LoadCart', cartId: cart.id, item: ItemId.BaggedChips, count: CART_CAPACITY },
    ]);
    const before = state.moneyCents;
    stepMany(state, CART_RUN_BASE_TICKS * 3);
    expect(cart.runTicksRemaining).toBe(0);
    expect(cart.cargoCount).toBe(CART_CAPACITY);
    expect(state.moneyCents).toBe(before);
  });
});

describe('how far the truck has to drive', () => {
  it('costs ten ticks a tile from the road at the lot’s west edge', () => {
    // THE ANSWER TO "WHAT DOES DISTANCE MEAN ON A 64×64 MAP". Before land deeds the lot was
    // sixteen tiles wide and this was not a decision anybody could make.
    const near = createWorld(9100);
    const nearCart = spawnMachine(near, MachineKind.DeliveryCart, 0, 13)!;
    const farCart = spawnMachine(near, MachineKind.DeliveryCart, 40, 13)!;
    expect(cartRunTicks(nearCart)).toBe(CART_RUN_BASE_TICKS);
    expect(cartRunTicks(farCart)).toBe(CART_RUN_BASE_TICKS + 40 * RUN_TICKS_PER_TILE_FROM_ROAD);

    const depot = spawnMachine(near, MachineKind.TruckDepot, 20, 20)!;
    expect(depotRunTicks(depot)).toBe(DEPOT_RUN_BASE_TICKS + 20 * RUN_TICKS_PER_TILE_FROM_ROAD);
  });

  it('advances a run only inside step(), one tick at a time', () => {
    // NO WALL CLOCK, ANYWHERE (plan §6: there is no offline progress, ever). Close the tab
    // mid-journey and the truck is exactly where it was, because nothing but `step()` moves it.
    const { state, cart } = worldWithCart(9101);
    run(state, [{ type: 'LoadCart', cartId: cart.id, item: ItemId.BaggedChips, count: 3 }]);
    run(state, [{ type: 'DispatchCart', cartId: cart.id }]);

    const parked = cart.runTicksRemaining;
    // A thousand imaginary seconds pass. The world is not stepped, so nothing happens at all.
    expect(cart.runTicksRemaining).toBe(parked);
    stepMany(state, 7);
    expect(cart.runTicksRemaining).toBe(parked - 7);
  });
});

describe('the truck depot', () => {
  it('sells with zero player input and counts no manual touch at all', () => {
    const { state, depot } = worldWithDepot(9200);
    run(state, [
      {
        type: 'CreateContract',
        depotId: depot.id,
        item: ItemId.BaggedChips,
        quantityPerRun: 5,
        destination: 'Ridgeline Grocers',
      },
    ]);
    const contract = state.contracts[0]!;
    // Five bags arrive off a belt, through the one door a grabber uses.
    for (let i = 0; i < 5; i++) expect(depotAccept(state, depot, ItemId.BaggedChips)).toBe(true);
    expect(depotStockedCount(state, depot.id)).toBe(5);

    const before = state.moneyCents;
    stepMany(state, DEPOT_LOAD_TICKS + depotRunTicks(depot) + 2);

    expect(contract.runsCompleted).toBe(1);
    expect(state.moneyCents - before).toBe(listPriceCents(ItemId.BaggedChips) * 5);
    expect(contract.grossCents).toBe(listPriceCents(ItemId.BaggedChips) * 5);
    // THE FACT THE HANDS-FREE BOARD STANDS ON.
    expect(totalManualTouches(state.stats.touches)).toBe(0);
    expect(state.stats.ticksSinceManualTouch).toBeGreaterThan(0);
  });

  it('holds net worth flat from the belt to the bank', () => {
    const { state, depot } = worldWithDepot(9201);
    run(state, [
      {
        type: 'CreateContract',
        depotId: depot.id,
        item: ItemId.BaggedChips,
        quantityPerRun: 4,
        destination: 'Halvorsen & Sons',
      },
    ]);
    for (let i = 0; i < 4; i++) depotAccept(state, depot, ItemId.BaggedChips);

    const stocked = computeNetWorthCents(state);
    // Across the commit, the loading beat, the whole road, and the payout: never once below.
    let lowest = stocked;
    for (let i = 0; i < DEPOT_LOAD_TICKS + depotRunTicks(depot) + 5; i++) {
      stepMany(state, 1);
      const now = computeNetWorthCents(state);
      if (now < lowest) lowest = now;
    }
    expect(lowest).toBe(stocked);
  });

  it('walks a route through waiting, loading, and rolling — and honks once, on departure', () => {
    const { state, depot } = worldWithDepot(9202);
    run(state, [
      {
        type: 'CreateContract',
        depotId: depot.id,
        item: ItemId.BaggedChips,
        quantityPerRun: 2,
        destination: 'The Filling Station',
      },
    ]);
    const contract = state.contracts[0]!;
    expect(contract.phase).toBe(ContractPhase.Waiting);
    expect(state.ceremonies).not.toContain(CeremonyId.FirstTruck);

    depotAccept(state, depot, ItemId.BaggedChips);
    stepMany(state, 1);
    expect(contract.phase).toBe(ContractPhase.Waiting);

    depotAccept(state, depot, ItemId.BaggedChips);
    stepMany(state, 1);
    expect(contract.phase).toBe(ContractPhase.Loading);
    expect(contract.inTransit).toBe(2);
    expect(contract.stocked).toBe(0);
    // Still at the dock: a first time needs the truck to be there when the horn sounds.
    expect(state.ceremonies).not.toContain(CeremonyId.FirstTruck);

    stepMany(state, DEPOT_LOAD_TICKS);
    expect(contract.phase).toBe(ContractPhase.Rolling);
    expect(state.ceremonies).toContain(CeremonyId.FirstTruck);

    // And exactly once, forever — the second run adds no second entry.
    const ceremonies = state.ceremonies.length;
    stepMany(state, depotRunTicks(depot) + 1);
    expect(contract.runsCompleted).toBe(1);
    depotAccept(state, depot, ItemId.BaggedChips);
    depotAccept(state, depot, ItemId.BaggedChips);
    stepMany(state, DEPOT_LOAD_TICKS + depotRunTicks(depot) + 4);
    expect(contract.runsCompleted).toBe(2);
    expect(state.ceremonies).toHaveLength(ceremonies);
  });

  it('refuses goods it has no route for, so a mis-aimed arm never picks them up', () => {
    const { state, depot } = worldWithDepot(9203);
    expect(depotAccept(state, depot, ItemId.BaggedChips)).toBe(false);
    run(state, [
      {
        type: 'CreateContract',
        depotId: depot.id,
        item: ItemId.BaggedChips,
        quantityPerRun: 10,
        destination: 'Comfort Foods Depot',
      },
    ]);
    expect(depotAccept(state, depot, ItemId.RussetPotato)).toBe(false);
    expect(depotAccept(state, depot, ItemId.BaggedChips)).toBe(true);
  });

  it('fills to its floor and then refuses, which is what backs a belt up', () => {
    const { state, depot } = worldWithDepot(9204);
    run(state, [
      {
        type: 'CreateContract',
        depotId: depot.id,
        item: ItemId.BaggedChips,
        // Bigger than the floor, so nothing ever ships and the stock genuinely piles up.
        quantityPerRun: 100,
        destination: 'Route 9 Wholesale',
      },
    ]);
    let accepted = 0;
    for (let i = 0; i < DEPOT_STOCK_CAPACITY + 25; i++) {
      if (depotAccept(state, depot, ItemId.BaggedChips)) accepted += 1;
    }
    expect(accepted).toBe(DEPOT_STOCK_CAPACITY);
  });

  it('IS ASKED BEFORE THE CLAW CLOSES (item 085): no route, no pickup; sign one and it flows', () => {
    // The depot's door, through the arm rather than through the function. `depotCanAcceptRoute`
    // is the predicate — one copy, returning the very contract `depotAccept` increments — and
    // this is the behaviour it buys: a belt pointed at a depot that has not been given a route
    // leaves its goods on the belt instead of parking one in a claw until the player notices.
    const { state, depot } = worldWithDepot(9205, 5, 5);
    const belt = spawnBelt(state, BeltTier.Basic, 2, 5, Direction.East, 1)!;
    const arm = spawnGrabber(state, GrabberTier.Mk1, 3, 5, Direction.East, 0)!;
    // The depot covers (5,5) outward, so the arm at (3,5) drops on (4,5) — one tile short. Put
    // the depot where the arm actually reaches.
    depot.tileX = 4;
    depot.tileY = 5;
    belt.items.push({ dist: 0, item: ItemId.BaggedChips });

    stepMany(state, 400);
    expect(arm.held).toBe(0);
    expect(belt.items).toHaveLength(1);
    expect(depotStockedCount(state, depot.id)).toBe(0);

    // A route is signed. Nothing else changes, and the same goods walk in.
    run(state, [
      {
        type: 'CreateContract',
        depotId: depot.id,
        item: ItemId.BaggedChips,
        quantityPerRun: 100,
        destination: 'Route 9 Wholesale',
      },
    ]);
    stepMany(state, 100);
    expect(belt.items).toHaveLength(0);
    expect(depotStockedCount(state, depot.id)).toBe(1);
  });
});

describe('a standing contract', () => {
  it('chooses a product and a quantity, and nothing that could be a price', () => {
    // LOCKED DECISION 3, AS A SHAPE RATHER THAN A CONVENTION. §8 cuts fluctuating market prices
    // forever, so a contract must be unable to express value. This is that assertion: the only
    // fields a route carries beyond bookkeeping are what to ship, how much, and a name on a
    // door — and the run is worth exactly what the same goods fetch by hand.
    const { state, depot } = worldWithDepot(9300);
    run(state, [
      {
        type: 'CreateContract',
        depotId: depot.id,
        item: ItemId.BaggedChips,
        quantityPerRun: 25,
        destination: 'Ridgeline Grocers',
      },
    ]);
    const contract = state.contracts[0]!;
    const configurable = Object.keys(contract).filter(
      (key) => !['id', 'depotId', 'stocked', 'inTransit', 'phase', 'ticksRemaining'].includes(key),
    );
    expect(configurable.sort()).toEqual([
      'destination',
      'grossCents',
      'item',
      'quantityPerRun',
      'runsCompleted',
    ]);
    // `grossCents` and `runsCompleted` are a receipt, not a lever: both start at zero and only
    // a completed run moves them.
    expect(contract.grossCents).toBe(0);
    expect(contract.runsCompleted).toBe(0);
  });

  it('refuses a route for seeds, a silly quantity, or a product already on the books', () => {
    const { state, depot } = worldWithDepot(9301);
    const bad: Command[] = [
      {
        type: 'CreateContract',
        depotId: depot.id,
        item: ItemId.PotatoSeed,
        quantityPerRun: 10,
        destination: 'x',
      },
      {
        type: 'CreateContract',
        depotId: depot.id,
        item: ItemId.BaggedChips,
        quantityPerRun: 0,
        destination: 'x',
      },
      {
        type: 'CreateContract',
        depotId: depot.id,
        item: ItemId.BaggedChips,
        quantityPerRun: 101,
        destination: 'x',
      },
    ];
    for (const command of bad) run(state, [command]);
    expect(state.contracts).toHaveLength(0);
    expect(state.trace).toHaveLength(0);

    run(state, [
      {
        type: 'CreateContract',
        depotId: depot.id,
        item: ItemId.BaggedChips,
        quantityPerRun: 10,
        destination: 'Ridgeline Grocers',
      },
    ]);
    run(state, [
      {
        type: 'CreateContract',
        depotId: depot.id,
        item: ItemId.BaggedChips,
        quantityPerRun: 50,
        destination: 'Halvorsen & Sons',
      },
    ]);
    // One route per product per depot: the second would starve behind the first forever.
    expect(state.contracts).toHaveLength(1);
    expect(state.contracts[0]!.quantityPerRun).toBe(10);
  });

  it('stops at four routes a depot', () => {
    const { state, depot } = worldWithDepot(9302);
    const products = [
      ItemId.BaggedChips,
      ItemId.RussetPotato,
      ItemId.PlainChips,
      ItemId.SeasonedChips,
      ItemId.WashedPotato,
    ];
    for (const item of products) {
      run(state, [
        { type: 'CreateContract', depotId: depot.id, item, quantityPerRun: 10, destination: 'x' },
      ]);
    }
    expect(state.contracts).toHaveLength(DEPOT_MAX_CONTRACTS);
  });

  it('is cancelled for free, and hands back the floor AND the lorry', () => {
    // NOTHING EVER VANISHES (plan §4), and paying out the truck instead would delete the run
    // time — sign, wait for the load, cancel, re-sign is the same money with the journey
    // removed. Handing the crates back can never beat waiting, which is the point.
    const { state, depot } = worldWithDepot(9303);
    run(state, [
      {
        type: 'CreateContract',
        depotId: depot.id,
        item: ItemId.BaggedChips,
        quantityPerRun: 4,
        destination: 'Route 9 Wholesale',
      },
    ]);
    const contract = state.contracts[0]!;
    for (let i = 0; i < 7; i++) depotAccept(state, depot, ItemId.BaggedChips);
    stepMany(state, 1);
    expect(contract.inTransit).toBe(4);
    expect(contract.stocked).toBe(3);

    const money = state.moneyCents;
    const worth = computeNetWorthCents(state);
    run(state, [{ type: 'CancelContract', contractId: contract.id }]);

    expect(state.contracts).toHaveLength(0);
    expect(state.moneyCents).toBe(money);
    expect(itemCount(state, ItemId.BaggedChips)).toBe(7);
    // Free means free: the goods changed hands, not value.
    expect(computeNetWorthCents(state)).toBe(worth);
  });

  it('goes with its depot when the depot is boxed', () => {
    const { state, depot } = worldWithDepot(9304);
    run(state, [
      {
        type: 'CreateContract',
        depotId: depot.id,
        item: ItemId.BaggedChips,
        quantityPerRun: 10,
        destination: 'Ridgeline Grocers',
      },
    ]);
    for (let i = 0; i < 6; i++) depotAccept(state, depot, ItemId.BaggedChips);
    standOn(state, depot.tileX, depot.tileY);

    run(state, [{ type: 'DeconstructMachine', machineId: depot.id }]);
    expect(state.contracts).toHaveLength(0);
    expect(itemCount(state, ItemId.BaggedChips)).toBe(6);
    expect(itemCount(state, ItemId.BoxedTruckDepot)).toBe(1);
  });

  it('keeps its destination out of the world hash, because it is a name on a door', () => {
    // THE ONE STORED STRING THAT IS NOT HASHED, and the exception is deliberate — see hash.ts.
    // Two lots shipping the same chips on the same schedule to two differently-named towns are
    // the same world. The day a destination gains a distance or a premium, this test is the one
    // that should be deleted, on the same day it moves into `data.ts`.
    const build = (destination: string): WorldState => {
      const { state, depot } = worldWithDepot(9305);
      run(state, [
        {
          type: 'CreateContract',
          depotId: depot.id,
          item: ItemId.BaggedChips,
          quantityPerRun: 10,
          destination,
        },
      ]);
      return state;
    };
    const a = build('Ridgeline Grocers');
    const b = build('Halvorsen & Sons');
    expect(a.contracts[0]!.destination).not.toBe(b.contracts[0]!.destination);
    expect(hashState(a)).toBe(hashState(b));
  });
});

// --- the projection ------------------------------------------------------------------

describe('the commerce projection', () => {
  it('publishes exactly what the Dispatch panel reads, in ticks and cents', () => {
    const { state, depot } = worldWithDepot(9400);
    const cart = spawnMachine(state, MachineKind.DeliveryCart, 3, 13)!;
    addItem(state, ItemId.BaggedChips, 20);
    standOn(state, 3, 13);
    run(state, [{ type: 'LoadCart', cartId: cart.id, item: ItemId.BaggedChips, count: 5 }]);
    run(state, [
      {
        type: 'CreateContract',
        depotId: depot.id,
        item: ItemId.BaggedChips,
        quantityPerRun: 10,
        destination: 'Ridgeline Grocers',
      },
    ]);
    depotAccept(state, depot, ItemId.BaggedChips);

    const projected = view(state, createWorldView());
    expect(projected.commerce.carts).toHaveLength(1);
    expect(projected.commerce.carts[0]).toMatchObject({
      id: cart.id,
      loaded: 5,
      capacity: CART_CAPACITY,
      item: ItemId.BaggedChips,
      away: 0,
      ticksRemaining: 0,
      runTicks: cartRunTicks(cart),
    });
    expect(projected.commerce.depots[0]).toMatchObject({
      id: depot.id,
      stocked: 1,
      capacity: DEPOT_STOCK_CAPACITY,
      contractIds: [state.contracts[0]!.id],
    });
    expect(projected.commerce.contracts[0]).toMatchObject({
      depotId: depot.id,
      item: ItemId.BaggedChips,
      quantityPerRun: 10,
      destination: 'Ridgeline Grocers',
      stocked: 1,
      phase: ContractPhase.Waiting,
    });
    expect(projected.commerce.firstDepartureSeen).toBe(0);
  });

  it('empties its buffers when the yard does, rather than leaving last frame’s cart behind', () => {
    // The projection buffer is reused forever, so a cart that has been boxed must disappear
    // from it. This is the truncation, asserted.
    const { state, depot } = worldWithDepot(9401);
    const cart = spawnMachine(state, MachineKind.DeliveryCart, 3, 13)!;
    standOn(state, 3, 13);
    const buffer = createWorldView();
    expect(view(state, buffer).commerce.carts).toHaveLength(1);

    run(state, [{ type: 'DeconstructMachine', machineId: cart.id }]);
    standOn(state, depot.tileX, depot.tileY);
    run(state, [{ type: 'DeconstructMachine', machineId: depot.id }]);
    const after = view(state, buffer);
    expect(after.commerce.carts).toHaveLength(0);
    expect(after.commerce.depots).toHaveLength(0);
  });
});

// --- the tree ------------------------------------------------------------------------

describe('the trucking node', () => {
  it('hangs off Commerce behind the Charter, and gates the depot but not the cart', () => {
    // Plan §3's ladder: the assisted rung needs no research, exactly as the $150 barrel
    // sprinkler needs none. The Charter's visible half is 200 items sold, so a player cannot
    // buy their way out of selling by hand before they have demonstrably done it.
    const node = TECH_NODES.find((entry) => entry.id === TechId.Trucking)!;
    expect(node.branch).toBe(TechBranch.Commerce);
    expect(node.requires).toContain(TechId.WorkshopCharter);

    const state = createWorld(9500);
    standOn(state, FIELD_ORIGIN_X - 2, FIELD_ORIGIN_Y + 8);
    state.moneyCents = 1_000_000;
    run(state, [{ type: 'PlaceMachine', kind: MachineKind.TruckDepot, tileX: 5, tileY: 14 }]);
    expect(state.machines.filter((m) => m.kind === MachineKind.TruckDepot)).toHaveLength(0);

    run(state, [{ type: 'PlaceMachine', kind: MachineKind.DeliveryCart, tileX: 2, tileY: 13 }]);
    expect(state.machines.filter((m) => m.kind === MachineKind.DeliveryCart)).toHaveLength(1);
  });
});

// --- the fixture ----------------------------------------------------------------------

// --- the sell bin's belt door (item 087) ---------------------------------------------

/**
 * A chip line that ends at the bin, built by hand.
 *
 *   Chip Kitchen (6,14) ──arm(6,13)──▶ belt (6,12)→(4,12) ──arm(3,12)──▶ SELL BIN (2,12)
 *
 * The bin is the one every world starts with, at `(FIELD_ORIGIN_X - 2, FIELD_ORIGIN_Y + 8)`.
 * The kitchen's hopper is loaded directly rather than by command, on `depot-run`'s precedent
 * and for its reason: what is being proved is the last link — production to money — and a
 * hand-loaded hopper before the window is honest about where the hands were.
 */
function soldUnits(state: WorldState, item: ItemId): number {
  // `salesByItem` is a sparse list sorted by item id, not an array indexed by one.
  return state.stats.salesByItem.find((row) => row.item === item)?.units ?? 0;
}

function chipLineToBin(seed: number, potatoes = 12) {
  const state = createWorld(seed);
  const kitchen = spawnMachine(state, MachineKind.ChipKitchen, 6, 14)!;
  kitchen.inputCounts[0] = potatoes;
  const feeder = spawnGrabber(state, GrabberTier.Mk1, 6, 13, Direction.North, 0)!;
  const belt = spawnBelt(state, BeltTier.Basic, 6, 12, Direction.West, 3)!;
  const teller = spawnGrabber(state, GrabberTier.Mk1, 3, 12, Direction.West, 0)!;
  return { state, kitchen, feeder, belt, teller };
}

describe('a grabber pointed into the sell bin', () => {
  it('SELLS THE CHIP LINE HANDS-FREE: money climbs and no touch is counted', () => {
    // Owner ruling, 2026-08-15: "if I point a picker from a track that has snacks to the trade
    // post, it should be able to sell." Before item 087 the bin matched none of `grabberPlace`'s
    // doors, so the arm stood at the counter holding a bag of chips forever.
    const { state, teller } = chipLineToBin(8701);
    const moneyBefore = state.moneyCents;
    const touchesBefore = { ...state.stats.touches };

    // Not one command from here to the end of the test.
    stepMany(state, 3_000);

    expect(state.moneyCents).toBeGreaterThan(moneyBefore);
    expect(state.stats.itemsSold).toBeGreaterThan(0);
    expect(soldUnits(state, ItemId.BaggedChips)).toBeGreaterThan(0);
    // The arm is not stuck at the counter holding the first bag it ever picked up.
    expect(teller.opCount).toBeGreaterThan(1);
    // **ZERO MANUAL TOUCHES.** Belt selling is the hands-free path by construction, which is
    // what makes plan §6's Hands-Free board count an automated bin correctly for free.
    expect(state.stats.touches).toEqual(touchesBefore);
    expect(totalManualTouches(state.stats.touches)).toBe(0);
  });

  it('books each unit ONCE, at list, through the same door a hand sale walks through', () => {
    const { state } = chipLineToBin(8702);
    const purse = state.moneyCents;
    stepMany(state, 3_000);

    const sold = state.stats.itemsSold;
    expect(sold).toBeGreaterThan(0);
    // One multiplication, one credit: gross, money and the per-item row all agree, and none of
    // them is double-counted. If a second booking ever appears anywhere, two of these three
    // stop matching.
    expect(state.moneyCents - purse).toBe(sold * listPriceCents(ItemId.BaggedChips));
    expect(soldUnits(state, ItemId.BaggedChips)).toBe(sold);
    expect(state.stats.lifetimeEarnedCents).toBe(state.moneyCents - purse);
  });

  it('pays a Day-Old bag exactly what a hand sale would pay for it, at the same tick', () => {
    // ONE PRICE PATH. Day-Old goods are their own item id with their own list price, so the
    // belt sale and the hand sale are literally the same multiplication — this pins that they
    // stay so, rather than a freshness rule quietly forking.
    const { state, belt } = chipLineToBin(8703, 0);
    belt.items.push({ dist: 0, item: ItemId.DayOldPotato });
    const before = state.moneyCents;
    stepMany(state, 600);

    const beltGross = state.moneyCents - before;
    expect(beltGross).toBe(listPriceCents(ItemId.DayOldPotato));

    // The same bag, sold by hand from the same world.
    const hand = createWorld(8703);
    addItem(hand, ItemId.DayOldPotato, 1);
    standOn(hand, FIELD_ORIGIN_X - 2, FIELD_ORIGIN_Y + 8);
    const handBefore = hand.moneyCents;
    run(hand, [{ type: 'SellItem', item: ItemId.DayOldPotato, count: 1 }]);
    expect(hand.moneyCents - handBefore).toBe(beltGross);
    // And the hand's sale DID cost a touch, which is the only thing the two doors disagree on.
    expect(totalManualTouches(hand.stats.touches)).toBe(1);
  });

  it('REFUSES A SEED at the bin exactly as it refuses one from hands — and never picks it up', () => {
    // Plan §4's anti-softlock floor: a world can always plant. An arm quietly selling seeds
    // would break it on a schedule while the player was three screens away — worse than the
    // misclick `applySellItem` already refuses.
    //
    // **REWRITTEN BY ITEM 085, WHOSE RULING THIS TEST USED TO PIN THE OPPOSITE OF.** It asserted
    // that the arm STALLS holding the seed forever ("the ordinary look-downstream stall"). The
    // owner overruled that on 2026-08-15 — "if it grabs something that the machine can't take,
    // it shouldn't grab it" — so the arm now asks the bin BEFORE closing its claw, hears no, and
    // leaves the seed on the belt. Same refusal, one swing earlier, and the goods stay where
    // the player put them instead of being held hostage to make the point.
    const { state, teller, belt } = chipLineToBin(8704, 0);
    belt.items.push({ dist: 0, item: ItemId.PotatoSeed });
    const moneyBefore = state.moneyCents;

    stepMany(state, 1_000);
    expect(state.moneyCents).toBe(moneyBefore);
    expect(state.stats.itemsSold).toBe(0);
    // NOT IN ITS HAND, AND NOT EATEN: the seed is still on the belt, a thousand ticks later.
    expect(teller.held).toBe(0);
    expect(teller.opCount).toBe(0);
    expect(belt.items.map((entry) => entry.item)).toEqual([ItemId.PotatoSeed]);

    // The diagnostic moved to the lamp and did not evaporate: red, look downstream — the arm
    // has something to take and is pointed at a thing that will not have it.
    const arm = view(state, createWorldView()).grabbers.find((g) => g.id === teller.id)!;
    expect(arm.lamp).toBe(LampState.Blocked);

    // And the hand's door says the same thing about the same seed.
    const hand = createWorld(8704);
    addItem(hand, ItemId.PotatoSeed, 1);
    standOn(hand, FIELD_ORIGIN_X - 2, FIELD_ORIGIN_Y + 8);
    const purse = hand.moneyCents;
    const seeds = itemCount(hand, ItemId.PotatoSeed);
    run(hand, [{ type: 'SellItem', item: ItemId.PotatoSeed, count: 1 }]);
    expect(hand.moneyCents).toBe(purse);
    expect(itemCount(hand, ItemId.PotatoSeed)).toBe(seeds);
  });

  it('keeps the bin stateless — a sale is instantaneous, nothing accumulates on the machine', () => {
    const { state } = chipLineToBin(8705);
    stepMany(state, 3_000);
    const bin = state.machines.find((m) => m.kind === MachineKind.SellBin)!;
    expect(bin.cargoItem).toBe(0);
    expect(bin.cargoCount).toBe(0);
    expect(bin.inputCounts.every((n) => n === 0)).toBe(true);
    expect(bin.outputCount).toBe(0);
    expect(bin.opCount).toBe(0);
  });

  it("leaves the depot's door alone: a truck sale still books automated gross, a bin sale does not", () => {
    // `automatedGrossCents` means "gross that left the lot on a cart or a truck" and the
    // Dispatch panel's header is read off it. A bin sale left on neither. Widening that number
    // to mean "income I did not carry by hand" is an owner's call, flagged for item 046 —
    // pinned here so the decision is made deliberately rather than by drift.
    const { state } = chipLineToBin(8706);
    stepMany(state, 3_000);
    expect(state.stats.itemsSold).toBeGreaterThan(0);
    expect(state.stats.automatedGrossCents).toBe(0);
  });
});

describe('the hands-free window', () => {
  it('runs 5,000 ticks of a depot run with the touch counters frozen', () => {
    // **THE TEST THE HANDS-FREE BOARD IS ADJUDICABLE BY** (plan §6: "seed-to-sold 30 active min
    // with zero manual touches"). Until the depot existed this interval could not contain a
    // sale, because every sale ended in a command a human issued.
    //
    // The world is `depot-run.json` — a real played session, farmed up from $50 to the Workshop
    // Charter, the Belts node and Trucking, with a Chip Kitchen feeding a grabber feeding a
    // depot on a standing route. It is replayed to the tick its last command landed, and then
    // stepped five thousand more with an EMPTY command list.
    //
    // WHAT THIS DOES NOT PROVE, said plainly: seed-to-*sold* is not reachable today, because
    // nothing in this game harvests a crop for you. The kitchen's hopper is filled by hand
    // immediately before the window opens. What is proven is that the last link — production to
    // money — is genuinely hands-free, which is the link this work item was asked for.
    const fixture = loadFixture('depot-run');
    const boundary = fixture.handsOffFromTick!;
    expect(boundary).toBeGreaterThan(0);
    expect(fixture.ticks - boundary).toBe(5000);
    // Nothing is issued after the boundary. If a future edit adds one, this catches it.
    for (const entry of fixture.commands) expect(entry.tick).toBeLessThan(boundary);

    const state = createWorld(fixture.seed);
    const byTick = new Map<number, Command[]>();
    for (const entry of fixture.commands) {
      const bucket = byTick.get(entry.tick);
      if (bucket === undefined) byTick.set(entry.tick, [entry.command]);
      else bucket.push(entry.command);
    }
    const none: Command[] = [];
    while (state.tick < boundary) {
      step(state, { tick: state.tick, commands: byTick.get(state.tick) ?? none });
    }

    const touchesBefore = { ...state.stats.touches };
    const moneyBefore = state.moneyCents;
    const grossBefore = state.stats.automatedGrossCents;
    const soldBefore = state.stats.itemsSold;
    stepMany(state, 5000);

    expect(state.stats.touches).toEqual(touchesBefore);
    expect(totalManualTouches(state.stats.touches)).toBe(
      totalManualTouches(touchesBefore as typeof state.stats.touches),
    );
    // And it did something: money arrived, by truck, with nobody there.
    expect(state.moneyCents).toBeGreaterThan(moneyBefore);
    expect(state.stats.automatedGrossCents).toBeGreaterThan(grossBefore);
    expect(state.stats.itemsSold).toBeGreaterThan(soldBefore);
    expect(state.contracts[0]!.runsCompleted).toBeGreaterThanOrEqual(2);
    expect(state.ceremonies).toContain(CeremonyId.FirstTruck);
  });
});
