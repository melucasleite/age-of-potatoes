// The farm release: freshness, soil, fertility, the armful, the scythe, and the orchard.
//
// The golden fixture `the-farm` pins that all of this together produces one exact world. This
// file is the other half — the individual rules, each stated as the criterion it comes from, so a
// failure names the rule rather than a hash.

import { describe, expect, it } from 'vitest';

import {
  type WorldState,
  CONDITION_MAX,
  CropId,
  ItemId,
  MachineKind,
  SOIL_SPECS,
  SoilType,
  addItem,
  carriedCount,
  createWorld,
  cropSpec,
  hashState,
  inventorySlot,
  itemCount,
  machineSpec,
  plantCrop,
  removeItem,
  soilSpec,
  spawnMachine,
  step,
  stepMany,
  takeHarvest,
} from '../src/index';

const ACTIVE_MINUTE = 1_200;

/** A world with the player standing on the middle of the field, holding nothing. */
function world(seed = 7): WorldState {
  return createWorld(seed);
}

/**
 * The same, with the eight starting seeds out of the player's hands.
 *
 * `STARTING_SEEDS` is a gift every world is born holding, and a test that wants to count
 * exactly what a verb put in the arms is better off starting from zero. (This mattered more
 * when the armful cap existed; it is kept for the counting, not the room.)
 */
function emptyHanded(seed = 7): WorldState {
  const state = world(seed);
  removeItem(state, ItemId.PotatoSeed, itemCount(state, ItemId.PotatoSeed));
  return state;
}

describe('harvested goods spoiling', () => {
  it('ages nothing at all while the tab is shut, because nothing steps', () => {
    // §4 and §6: "freshness counts active factory minutes only — the world sleeps when you do."
    const state = world();
    addItem(state, ItemId.RussetPotato, 3);
    const before = hashState(state);
    // Ten minutes of wall clock is zero ticks. The world is byte-identical.
    expect(hashState(state)).toBe(before);
    expect(itemCount(state, ItemId.RussetPotato)).toBe(3);
  });
});

describe('soil and fertility', () => {
  it('varies soil across the map from its own stream', () => {
    const state = world(12_345);
    const seen = new Set<number>();
    for (const tile of state.field) seen.add(tile.soil);
    expect(seen.size, 'a whole field of one soil is a stream that is not rolling').toBeGreaterThan(
      1,
    );
    for (const tile of state.field) {
      expect([SoilType.Loam, SoilType.Sand, SoilType.Clay]).toContain(tile.soil);
    }
  });

  it('grows a crop faster in sand than in clay, deterministically', () => {
    const sand = world(3);
    const clay = world(3);
    const spec = cropSpec(CropId.RussetPotato)!;

    sand.field[0]!.soil = SoilType.Sand;
    clay.field[0]!.soil = SoilType.Clay;
    plantCrop(sand, sand.field[0]!, spec);
    plantCrop(clay, clay.field[0]!, spec);

    expect(sand.field[0]!.growthTarget).toBeLessThan(clay.field[0]!.growthTarget);
    expect(Number.isInteger(sand.field[0]!.growthTarget)).toBe(true);
  });

  it('drains clay slower than sand, and never leaves clay wet forever', () => {
    const state = world(5);
    const spec = cropSpec(CropId.RussetPotato)!;
    const sandTile = state.field[0]!;
    const clayTile = state.field[1]!;
    sandTile.soil = SoilType.Sand;
    clayTile.soil = SoilType.Clay;
    plantCrop(state, sandTile, spec);
    plantCrop(state, clayTile, spec);
    sandTile.moisture = 3_600;
    clayTile.moisture = 3_600;

    stepMany(state, 1_000);
    expect(clayTile.moisture).toBeGreaterThan(sandTile.moisture);
    // AND CLAY REALLY DOES DRY. Without the accumulator `divFloor(1 × 700, 1000)` is zero and a
    // clay tile would stay wet forever, which is the bug `CropTile.moistureAccum` exists to stop.
    expect(clayTile.moisture).toBeLessThan(3_600);
  });

  it('makes Sugar Cane drink more than a Russet over the same period', () => {
    // §5's "thirsty" clause, as a comparison. (It was written against the Gold Potato until
    // item 145 cut that crop; cane is the roster's thirsty one now.)
    const state = world(21);
    const russet = cropSpec(CropId.RussetPotato)!;
    const gold = cropSpec(CropId.SugarCane)!;
    expect(gold.moistureDrainPerTick).toBeGreaterThan(russet.moistureDrainPerTick);

    const a = state.field[0]!;
    const b = state.field[1]!;
    a.soil = SoilType.Loam;
    b.soil = SoilType.Loam;
    plantCrop(state, a, russet);
    plantCrop(state, b, gold);
    a.moisture = 3_600;
    b.moisture = 3_600;

    stepMany(state, 600);
    expect(b.moisture).toBeLessThan(a.moisture);
  });

  it('keeps the soil table integer and loam neutral', () => {
    const loam = soilSpec(SoilType.Loam)!;
    expect(loam.growthPermille).toBe(1000);
    expect(loam.moistureDrainPermille).toBe(1000);
    for (const spec of SOIL_SPECS) {
      expect(Number.isInteger(spec.growthPermille)).toBe(true);
      expect(Number.isInteger(spec.moistureDrainPermille)).toBe(true);
    }
  });
});

describe('the armful, unlimited', () => {
  it('hand-harvests 50 items in one trip with no refusal and no speed penalty', () => {
    // ITEM 068'S STORY, WATCHED START TO FINISH (owner ruling 2026-08-14: the cap is removed,
    // not raised — no refusal at the thirteenth potato, no teeter, no slowdown). Fifty ready
    // tiles, fifty pulls, zero refusals, and the arms just keep taking it.
    const state = emptyHanded(31);
    const spec = cropSpec(CropId.RussetPotato)!;

    let planted = 0;
    const targets: { x: number; y: number }[] = [];
    for (const tile of state.field) {
      if (planted >= 50) break;
      plantCrop(state, tile, spec);
      tile.growth = tile.growthTarget;
      targets.push({ x: tile.tileX, y: tile.tileY });
      planted += 1;
    }
    expect(planted).toBe(50);

    let pulls = 0;
    for (const { x, y } of targets) {
      state.player.xSub = x * 256 + 128;
      state.player.ySub = y * 256 + 128;
      const trace = state.trace.length;
      step(state, { tick: state.tick, commands: [{ type: 'HarvestTile', tileX: x, tileY: y }] });
      expect(state.trace.length, `the pull at (${String(x)},${String(y)}) was refused`).toBe(
        trace + 1,
      );
      pulls += 1;
    }
    expect(pulls).toBe(50);
    // Fifty yields plus fifty returned seeds: far past the old twelve-item cap, in one trip.
    expect(carriedCount(state)).toBeGreaterThanOrEqual(100);

    // And no speed penalty for any of it: a hundred ticks of walking under the full load
    // covers exactly the distance empty arms would. (Towing is the one legal slowdown.)
    const loaded = state.player.xSub;
    step(state, { tick: state.tick, commands: [{ type: 'SetMoveDirection', dir: 2 }] });
    stepMany(state, 99);
    const loadedDistance = state.player.xSub - loaded;

    const free = emptyHanded(31);
    free.player.xSub = loaded;
    free.player.ySub = state.player.ySub;
    step(free, { tick: free.tick, commands: [{ type: 'SetMoveDirection', dir: 2 }] });
    stepMany(free, 99);
    expect(loadedDistance).toBe(free.player.xSub - loaded);
  });

  it('does not count boxed machines against the arms', () => {
    // A box is not a good: the bin refuses one, and demolishing a factory must not fill your
    // hands with turnips. See `carriedCount`.
    const state = emptyHanded(32);
    const kitchen = spawnMachine(state, MachineKind.Washer, 0, 0)!;
    state.player.xSub = 128;
    state.player.ySub = 128;
    step(state, {
      tick: state.tick,
      commands: [{ type: 'DeconstructMachine', machineId: kitchen.id }],
    });
    expect(itemCount(state, ItemId.BoxedWasher)).toBe(1);
    expect(carriedCount(state), 'a boxed machine filled the arms').toBe(0);
  });

  it('never blocks goods being handed BACK, or bought, at any count', () => {
    // Half the callers of `addItem` are involuntary — a belt taken up, a machine boxed with a
    // full hopper. §4's floor is that nothing vanishes; since item 068 the voluntary doors are
    // exactly as open as the involuntary ones.
    const state = emptyHanded(33);
    addItem(state, ItemId.BaggedChips, 12);
    addItem(state, ItemId.SeasonedChips, 40);
    expect(itemCount(state, ItemId.SeasonedChips)).toBe(40);
    expect(carriedCount(state)).toBe(52);
  });
});

describe('the push-scythe', () => {
  it('cuts three tiles across the path in one swing, and one touch', () => {
    const state = emptyHanded(41);
    const spec = cropSpec(CropId.RussetPotato)!;
    // Facing north, so the swathe runs east–west across tiles (4,5), (5,5) and (6,5).
    for (const x of [4, 5, 6]) {
      const tile = state.field[(5 - 4) * 8 + (x - 4)]!;
      plantCrop(state, tile, spec);
      tile.growth = tile.growthTarget;
    }
    addItem(state, ItemId.PushScythe, 1);
    state.player.xSub = 5 * 256 + 128;
    state.player.ySub = 5 * 256 + 128;

    const before = state.stats.touches.handHarvest;
    step(state, { tick: state.tick, commands: [{ type: 'SwingScythe', tileX: 5, tileY: 5 }] });

    for (const x of [4, 5, 6]) {
      expect(state.field[(5 - 4) * 8 + (x - 4)]!.crop, `tile ${String(x)} survived the swing`).toBe(
        CropId.None,
      );
    }
    // ONE SWING, ONE TOUCH. Three would make the assisted rung score worse on Hands-Free than
    // doing the work by hand, which inverts the whole ladder.
    expect(state.stats.touches.handHarvest).toBe(before + 1);
  });

  it('does nothing to tiles that are not ready, and nothing at all without a scythe', () => {
    const state = emptyHanded(42);
    state.player.xSub = 5 * 256 + 128;
    state.player.ySub = 5 * 256 + 128;

    // No scythe in the bag: refused outright, so nothing enters the trace.
    const traceBefore = state.trace.length;
    step(state, { tick: state.tick, commands: [{ type: 'SwingScythe', tileX: 5, tileY: 5 }] });
    expect(state.trace.length).toBe(traceBefore);

    // With a scythe but bare ground: still nothing, and still no touch.
    addItem(state, ItemId.PushScythe, 1);
    const touches = state.stats.touches.handHarvest;
    step(state, { tick: state.tick, commands: [{ type: 'SwingScythe', tileX: 5, tileY: 5 }] });
    expect(state.stats.touches.handHarvest).toBe(touches);
    expect(itemCount(state, ItemId.PushScythe), 'the scythe is never consumed').toBe(1);
  });
});

describe('the hand cart', () => {
  it('slows the player while towed and follows them tile for tile', () => {
    const state = world(51);
    const cart = spawnMachine(state, MachineKind.HandCart, 20, 20)!;
    state.player.xSub = 20 * 256 + 128;
    state.player.ySub = 20 * 256 + 128;

    step(state, { tick: state.tick, commands: [{ type: 'HitchCart', cartId: cart.id }] });
    expect(state.player.towedCartId).toBe(cart.id);

    const startX = state.player.xSub;
    step(state, { tick: state.tick, commands: [{ type: 'SetMoveDirection', dir: 2 }] });
    stepMany(state, 100);
    const towedDistance = state.player.xSub - startX;

    // And the cart came along.
    expect(cart.tileX).toBe(Math.floor(state.player.xSub / 256));

    // Free walking, same hundred ticks.
    const free = world(51);
    free.player.xSub = 20 * 256 + 128;
    free.player.ySub = 20 * 256 + 128;
    const freeStart = free.player.xSub;
    step(free, { tick: free.tick, commands: [{ type: 'SetMoveDirection', dir: 2 }] });
    stepMany(free, 100);
    const freeDistance = free.player.xSub - freeStart;

    expect(towedDistance).toBeLessThan(freeDistance);
    expect(Number.isInteger(state.player.moveAccum), 'no float multiplier anywhere').toBe(true);
  });

  it('holds a real load, and never quietly loses part of it', () => {
    // **THIS TEST USED TO BE CALLED "stops the clock on what is inside" AND THAT WAS THE BUG**
    // (item 110): a barrow with a tarp over it is not a refrigerator, and while it was one the
    // $250 Root Cellar was worth $80. What survives here is the capacity claim and the
    // nothing-vanishes floor; the clock is `a trip through storage`'s subject now.
    //
    // The cargo is poked in rather than loaded, so it carries no clock at all — which is exactly
    // the state format 18 grandfathers an old save into, and it must simply sit there.
    const state = world(52);
    const cart = spawnMachine(state, MachineKind.HandCart, 20, 20)!;
    const spec = machineSpec(MachineKind.HandCart)!;
    // Twenty potatoes ride without complaint. (The cart's promotion used to be "more than an
    // armful"; since item 068 the arms are unbounded and its pitch is the walking it saves.)
    expect(spec.inputCapacity).toBeGreaterThanOrEqual(20);

    cart.cargoItem = ItemId.RussetPotato;
    cart.cargoCount = 20;
    stepMany(state, 30_000);
    expect(cart.cargoCount).toBe(20);
    expect(cart.cargoItem, 'a parked cart quietly changed what it was holding').toBe(
      ItemId.RussetPotato,
    );
  });

  it('lets go when the cart is boxed, rather than dragging a ghost', () => {
    const state = world(53);
    const cart = spawnMachine(state, MachineKind.HandCart, 0, 0)!;
    state.player.xSub = 128;
    state.player.ySub = 128;
    step(state, { tick: state.tick, commands: [{ type: 'HitchCart', cartId: cart.id }] });
    expect(state.player.towedCartId).toBe(cart.id);

    step(state, {
      tick: state.tick,
      commands: [{ type: 'DeconstructMachine', machineId: cart.id }],
    });
    expect(state.player.towedCartId).toBe(0);
  });
});

describe('the orchard', () => {
  it('fruits on a cooldown, survives forever, and stops when its buffer is full', () => {
    const state = world(61);
    const tree = spawnMachine(state, MachineKind.KolaTree, 20, 20)!;
    const spec = machineSpec(MachineKind.KolaTree)!;

    stepMany(state, 400);
    expect(tree.outputCount).toBe(1);
    expect(spec.outputItem, 'the kola tree drops the nut the Grinder eats').toBe(ItemId.KolaNut);

    // DEMAND-PULL, LIKE EVERYTHING ELSE: a full tree stops and nothing rots on the branch.
    stepMany(state, 60_000);
    expect(tree.outputCount).toBe(spec.outputCapacity);
    // AND NO WEAR. A tree is not machinery.
    expect(tree.condition).toBe(CONDITION_MAX);
    expect(tree.jammed).toBe(false);
  });

  // (The untouched-work-credit test lived here until item 147 cut the Corporate Charter's
  // clock; `MachineRole.Orchard` stays for the reasons on the role itself.)

  it('takes 2×2 and comes back in a box with its fruit in your hands', () => {
    const state = world(63);
    const spec = machineSpec(MachineKind.KolaTree)!;
    expect(spec.tilesWide).toBe(2);
    expect(spec.tilesHigh).toBe(2);

    const tree = spawnMachine(state, MachineKind.KolaTree, 0, 0)!;
    stepMany(state, 40_000);
    const fruit = tree.outputCount;
    expect(fruit).toBeGreaterThan(0);

    state.player.xSub = 128;
    state.player.ySub = 128;
    step(state, {
      tick: state.tick,
      commands: [{ type: 'DeconstructMachine', machineId: tree.id }],
    });
    expect(itemCount(state, ItemId.KolaNut)).toBe(fruit);
    expect(itemCount(state, ItemId.BoxedKolaTree)).toBe(1);
  });
});

// --- item 110: a trip through storage does not reset the freshness clock ---------------
//
// THE BUG, VERBATIM, from item 105's adversarial verifier: *"a round trip through an eighty
// dollar hand cart resets the freshness clock, so I kept ten potatoes alive for three and a half
// times their natural lifespan by clicking twice. Rot is now opt-in."*
//
// Every test below is the same sentence asked of a different door. The first one is the
// verifier's own session, replayed.
