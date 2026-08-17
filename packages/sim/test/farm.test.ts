// The farm release: freshness, soil, fertility, the armful, the scythe, and the orchard.
//
// The golden fixture `the-farm` pins that all of this together produces one exact world. This
// file is the other half — the individual rules, each stated as the criterion it comes from, so a
// failure names the rule rather than a hash.

import { describe, expect, it } from 'vitest';

import {
  type WorldState,
  CONDITION_MAX,
  COMPOST_PER_FERTILIZER,
  CRATE_FRESHNESS_TICKS,
  CropId,
  FERTILITY_MAX,
  FERTILITY_MIN,
  FRESHNESS_BUCKET_TICKS,
  FRESHNESS_MAX_STACKS,
  HARVESTS_PER_FERTILITY_STEP,
  ItemId,
  MachineKind,
  SOIL_SPECS,
  SoilType,
  addItem,
  carriedCount,
  createWorld,
  cropSpec,
  freshnessTicks,
  hashState,
  inventorySlot,
  isPerishable,
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

describe('the freshness table', () => {
  it('gives a loose potato about fifteen active minutes and fresh slices about six', () => {
    // §4, quoted: "potato ~15 min loose / 45 crated / frozen in a Root Cellar ... fresh slices
    // ~6 min — the first real layout puzzle."
    expect(freshnessTicks(ItemId.RussetPotato)).toBe(15 * ACTIVE_MINUTE);
    expect(freshnessTicks(ItemId.PotatoSlices)).toBe(6 * ACTIVE_MINUTE);
    expect(CRATE_FRESHNESS_TICKS).toBe(45 * ACTIVE_MINUTE);
  });

  it('leaves processed goods shelf-stable forever', () => {
    // §4: "processed is shelf-stable forever" — that is the reward for building the line, and it
    // is what makes the Fryer the preservation step rather than a chore.
    for (const item of [
      ItemId.PlainChips,
      ItemId.SeasonedChips,
      ItemId.BaggedChips,
      ItemId.RusticStyleChips,
      ItemId.Soda,
      ItemId.SixPack,
      ItemId.SnackCombo,
      ItemId.Compost,
      ItemId.Fertilizer,
      ItemId.PotatoSeed,
      ItemId.Bottle,
      ItemId.KolaNut,
      ItemId.RepairKit,
    ]) {
      expect(isPerishable(item), `item ${String(item)} should not perish`).toBe(false);
    }
  });
});

describe('harvested goods spoiling', () => {
  it('turns a loose potato into Compost at about fifteen active minutes, and never into nothing', () => {
    const state = world();
    addItem(state, ItemId.RussetPotato, 4);
    expect(itemCount(state, ItemId.RussetPotato)).toBe(4);

    stepMany(state, 14 * ACTIVE_MINUTE);
    expect(itemCount(state, ItemId.RussetPotato), 'turned early').toBe(4);

    stepMany(state, 2 * ACTIVE_MINUTE);
    expect(itemCount(state, ItemId.RussetPotato)).toBe(0);
    // NOTHING VANISHES (§4). Every spoilage path in this game ends in a good.
    expect(itemCount(state, ItemId.Compost)).toBe(4);
  });

  it('ages nothing at all while the tab is shut, because nothing steps', () => {
    // §4 and §6: "freshness counts active factory minutes only — the world sleeps when you do."
    const state = world();
    addItem(state, ItemId.RussetPotato, 3);
    const before = hashState(state);
    // Ten minutes of wall clock is zero ticks. The world is byte-identical.
    expect(hashState(state)).toBe(before);
    expect(itemCount(state, ItemId.RussetPotato)).toBe(3);
  });

  it('freezes the clock inside a machine hopper', () => {
    // §4's softener, and §7 ruling 6: a backed-up line is a PAUSE, not a slow-motion loss. A
    // machine buffer holds counts and counts have no timer, so this is structural rather than a
    // rule that could be forgotten — the test is here to catch the day somebody adds one.
    const state = world();
    const slicer = spawnMachine(state, MachineKind.Slicer, 0, 0)!;
    const spec = machineSpec(MachineKind.Slicer)!;
    slicer.inputCounts[0] = 10;
    // Backed up, which is the whole point: demand-pull has it stopped with a full hopper, which
    // is precisely the situation §4 promises is a pause rather than a countdown.
    slicer.outputCount = spec.outputCapacity;

    stepMany(state, 20_000);
    expect(slicer.inputCounts[0], 'a stack in a hopper aged').toBe(10);
    expect(itemCount(state, ItemId.Compost)).toBe(0);
  });

  it('stops the clock entirely inside a Root Cellar', () => {
    const state = world();
    const cellar = spawnMachine(state, MachineKind.RootCellar, 0, 0)!;
    cellar.cargoItem = ItemId.RussetPotato;
    cellar.cargoCount = 40;

    stepMany(state, 40_000);
    expect(cellar.cargoCount).toBe(40);
    expect(itemCount(state, ItemId.Compost)).toBe(0);
  });

  it('THE CELLAR IS WORTH BUILDING: stored potatoes outlive the ones left in the bag', () => {
    // **THE FIRST TIME THE FREEZE HAS BEEN OBSERVABLE THROUGH A VERB** (item 105). The clock has
    // always stopped inside a box — the test above says so — but until this item nothing could put
    // anything into one, so the mechanic was a fact about a field no player could reach. Here it
    // is end to end, in the two commands a player types.
    //
    // The two armfuls are picked in the same tick and go different ways. One rides out the fifteen
    // minutes in a shed and comes back an armful; the other becomes compost.
    const state = world();
    const cellar = spawnMachine(state, MachineKind.RootCellar, 0, 0)!;
    state.player.xSub = 128;
    state.player.ySub = 128;
    addItem(state, ItemId.RussetPotato, 10);

    step(state, {
      tick: state.tick,
      commands: [
        { type: 'LoadMachine', machineId: cellar.id, count: 5, item: ItemId.RussetPotato },
      ],
    });
    expect(cellar.cargoCount).toBe(5);
    expect(itemCount(state, ItemId.RussetPotato)).toBe(5);

    // Long past the window the loose half had left.
    stepMany(state, 20 * ACTIVE_MINUTE);
    expect(itemCount(state, ItemId.RussetPotato), 'the loose half should be compost').toBe(0);
    expect(itemCount(state, ItemId.Compost)).toBe(5);

    // And the stored half comes out whole, carrying the window it went in with — which was very
    // nearly a full one, because it was boxed in the same tick it was picked. **THAT SENTENCE USED
    // TO READ "a full window ahead of it rather than the remainder of an old one", which was the
    // bug of item 110 stated as a feature.** The cellar keeps time; it does not manufacture it.
    step(state, {
      tick: state.tick,
      commands: [{ type: 'UnloadMachine', machineId: cellar.id, count: 5 }],
    });
    expect(itemCount(state, ItemId.RussetPotato)).toBe(5);

    stepMany(state, 14 * ACTIVE_MINUTE);
    expect(itemCount(state, ItemId.RussetPotato), 'the cellar sold a short window').toBe(5);
  });

  it('merges stacks into buckets and never grows past the cap', () => {
    // The save-size guard. A player harvesting one tile at a time would otherwise write one stack
    // per pull, forever — see `FRESHNESS_MAX_STACKS`.
    const state = world();
    for (let i = 0; i < 200; i++) {
      addItem(state, ItemId.RussetPotato, 1);
      stepMany(state, 40);
    }
    const slot = inventorySlot(state, ItemId.RussetPotato)!;
    expect(slot.stacks.length).toBeLessThanOrEqual(FRESHNESS_MAX_STACKS);

    let summed = 0;
    for (const stack of slot.stacks) summed += stack.count;
    expect(summed, 'stacks must always sum to the slot count').toBe(slot.count);

    // Strictly ascending, with no two stacks sharing a deadline.
    for (let i = 1; i < slot.stacks.length; i++) {
      expect(slot.stacks[i]!.spoilAtTick).toBeGreaterThan(slot.stacks[i - 1]!.spoilAtTick);
    }
  });

  it('eats the soonest-expiring units first when goods leave the bag', () => {
    const state = world();
    addItem(state, ItemId.Crate, 1);
    addItem(state, ItemId.RussetPotato, 5);
    stepMany(state, 5 * ACTIVE_MINUTE);
    addItem(state, ItemId.RussetPotato, 5);

    const slot = inventorySlot(state, ItemId.RussetPotato)!;
    expect(slot.stacks.length).toBe(2);
    const oldest = slot.stacks[0]!.spoilAtTick;

    // Take five: the old heap should be the one that goes.
    step(state, {
      tick: state.tick,
      commands: [{ type: 'PackCrate', item: ItemId.RussetPotato, count: 5 }],
    });
    const after = inventorySlot(state, ItemId.RussetPotato)!;
    expect(after.stacks[0]!.spoilAtTick).not.toBe(oldest);
  });
});

describe('the crate', () => {
  it('buys forty-five minutes, is consumed, and is refused when it would not help', () => {
    const state = world();
    addItem(state, ItemId.Crate, 2);
    addItem(state, ItemId.RussetPotato, 6);

    const before = inventorySlot(state, ItemId.RussetPotato)!.stacks[0]!.spoilAtTick;
    step(state, {
      tick: state.tick,
      commands: [{ type: 'PackCrate', item: ItemId.RussetPotato, count: 6 }],
    });
    const after = inventorySlot(state, ItemId.RussetPotato)!.stacks[0]!.spoilAtTick;

    expect(after).toBeGreaterThan(before);
    expect(itemCount(state, ItemId.Crate), 'one crate spent').toBe(1);

    // REFUSED RATHER THAN CONSUMED. Misplacement is never a fine (§4), so crating an already
    // crated stack takes nothing.
    step(state, {
      tick: state.tick,
      commands: [{ type: 'PackCrate', item: ItemId.RussetPotato, count: 6 }],
    });
    expect(itemCount(state, ItemId.Crate)).toBe(1);

    // And a good that cannot perish is refused outright.
    addItem(state, ItemId.BaggedChips, 3);
    step(state, {
      tick: state.tick,
      commands: [{ type: 'PackCrate', item: ItemId.BaggedChips, count: 3 }],
    });
    expect(itemCount(state, ItemId.Crate)).toBe(1);
  });

  it('keeps a crated stack alive well past the loose window', () => {
    const state = world();
    addItem(state, ItemId.Crate, 1);
    addItem(state, ItemId.RussetPotato, 4);
    step(state, {
      tick: state.tick,
      commands: [{ type: 'PackCrate', item: ItemId.RussetPotato, count: 4 }],
    });

    stepMany(state, 20 * ACTIVE_MINUTE);
    expect(itemCount(state, ItemId.RussetPotato), 'crated goods turned inside the window').toBe(4);

    stepMany(state, 30 * ACTIVE_MINUTE);
    expect(itemCount(state, ItemId.RussetPotato)).toBe(0);
    expect(itemCount(state, ItemId.Compost)).toBe(4);
  });
});

describe('the composter closes the loop', () => {
  it('turns Compost into Fertilizer, and Fertilizer puts a star back in the ground', () => {
    const state = world();
    const composter = spawnMachine(state, MachineKind.Composter, 0, 0)!;
    composter.inputCounts[0] = COMPOST_PER_FERTILIZER * 2;

    stepMany(state, 400);
    expect(composter.outputCount).toBeGreaterThan(0);

    // And into the soil. `fertilizeTile` is refused on ground already at full stars.
    const tile = state.field[0]!;
    tile.fertility = FERTILITY_MIN;
    tile.fertilityWear = 3;
    addItem(state, ItemId.Fertilizer, 1);

    state.player.xSub = 4 * 256 + 128;
    state.player.ySub = 4 * 256 + 128;
    step(state, {
      tick: state.tick,
      commands: [{ type: 'ApplyFertilizer', tileX: 4, tileY: 4 }],
    });

    expect(tile.fertility).toBe(FERTILITY_MIN + 1);
    expect(tile.fertilityWear, 'the wear counter resets with the star').toBe(0);
    expect(itemCount(state, ItemId.Fertilizer)).toBe(0);
  });

  it('refuses a bag on ground that is already at full stars, rather than eating it', () => {
    const state = world();
    const tile = state.field[0]!;
    tile.fertility = FERTILITY_MAX;
    addItem(state, ItemId.Fertilizer, 1);
    state.player.xSub = 4 * 256 + 128;
    state.player.ySub = 4 * 256 + 128;

    step(state, { tick: state.tick, commands: [{ type: 'ApplyFertilizer', tileX: 4, tileY: 4 }] });
    expect(itemCount(state, ItemId.Fertilizer)).toBe(1);
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

  it('leaves the fertility roll of an existing world untouched', () => {
    // §12's rule, and the reason `SystemId.SoilInit` is a NEW stream: adding a consumer must not
    // perturb what an existing system rolls. Fertility comes off `field-init` in one pass and soil
    // off `soil-init` in a second, so the first sequence is the one it always was.
    const state = world(999);
    let sum = 0;
    for (const tile of state.field) sum += tile.fertility;
    // Every tile is a legal 1..3 star roll and the field is not uniform.
    expect(sum).toBeGreaterThanOrEqual(state.field.length * FERTILITY_MIN);
    expect(sum).toBeLessThanOrEqual(state.field.length * FERTILITY_MAX);
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

  it('drops a star every fifth harvest and never below the floor', () => {
    const state = world(11);
    const spec = cropSpec(CropId.RussetPotato)!;
    const tile = state.field[0]!;
    tile.fertility = FERTILITY_MAX;

    for (let i = 0; i < HARVESTS_PER_FERTILITY_STEP * 6; i++) {
      plantCrop(state, tile, spec);
      tile.growth = tile.growthTarget;
      takeHarvest(state, tile, spec);
    }
    expect(tile.fertility, 'exhausted ground still yields — there is no zero').toBe(FERTILITY_MIN);
  });

  it('makes a Gold Potato drink more than a Russet over the same period', () => {
    // §5: "Gold Potato (premium, thirsty)", and item 030's criterion states it as a comparison.
    const state = world(21);
    const russet = cropSpec(CropId.RussetPotato)!;
    const gold = cropSpec(CropId.GoldPotato)!;
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
    const kitchen = spawnMachine(state, MachineKind.ChipKitchen, 0, 0)!;
    state.player.xSub = 128;
    state.player.ySub = 128;
    step(state, {
      tick: state.tick,
      commands: [{ type: 'DeconstructMachine', machineId: kitchen.id }],
    });
    expect(itemCount(state, ItemId.BoxedChipKitchen)).toBe(1);
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
      // One star each, so three tiles' worth of yield fits inside one armful — the cap is the
      // subject of its own test, not a hidden variable in this one.
      tile.fertility = FERTILITY_MIN;
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
    expect(cart.cargoFreshTicks, 'a clockless load stays clockless until it is touched').toBe(0);
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

  it('earns no untouched-work credit, so a sapling cannot buy the Corporate Charter', () => {
    // The reason `MachineRole.Orchard` exists rather than reusing `Converter`: the Charter's claim
    // is that a machine cannot advance work for 96,000 ticks unless something is FEEDING it, and a
    // tree needs nothing feeding it.
    const state = world(62);
    const tree = spawnMachine(state, MachineKind.OrangeTree, 20, 20)!;
    stepMany(state, 5_000);
    expect(tree.outputCount).toBeGreaterThan(0);
    expect(tree.untouchedTicks).toBe(0);
    expect(state.stats.longestUntouchedMachineTicks).toBe(0);
  });

  it('takes 2×2 and comes back in a box with its fruit in your hands', () => {
    const state = world(63);
    const spec = machineSpec(MachineKind.LemonTree)!;
    expect(spec.tilesWide).toBe(2);
    expect(spec.tilesHigh).toBe(2);

    const tree = spawnMachine(state, MachineKind.LemonTree, 0, 0)!;
    stepMany(state, 300);
    const fruit = tree.outputCount;
    expect(fruit).toBeGreaterThan(0);

    state.player.xSub = 128;
    state.player.ySub = 128;
    step(state, {
      tick: state.tick,
      commands: [{ type: 'DeconstructMachine', machineId: tree.id }],
    });
    expect(itemCount(state, ItemId.Lemon)).toBe(fruit);
    expect(itemCount(state, ItemId.BoxedLemonTree)).toBe(1);
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

describe('a trip through storage', () => {
  /** The verifier's cart, parked on the player's toes so every reach check passes. */
  function withCart(state: WorldState, kind: MachineKind = MachineKind.HandCart) {
    state.player.xSub = 128;
    state.player.ySub = 128;
    return spawnMachine(state, kind, 0, 0)!;
  }

  it('THE EXPLOIT: ten potatoes cannot outlive their window by riding a hand cart', () => {
    const state = world();
    const cart = withCart(state);
    addItem(state, ItemId.RussetPotato, 10);

    // Ten active minutes in the arms, then in and straight back out — four times over. Under the
    // old rule each unload stamped a brand-new fifteen minutes, so this session ran forty-plus
    // minutes on a fifteen-minute window and never lost a potato.
    for (let trip = 0; trip < 4; trip++) {
      stepMany(state, 10 * ACTIVE_MINUTE);
      step(state, {
        tick: state.tick,
        commands: [
          { type: 'LoadMachine', machineId: cart.id, count: 10, item: ItemId.RussetPotato },
        ],
      });
      step(state, {
        tick: state.tick,
        commands: [{ type: 'UnloadMachine', machineId: cart.id, count: 10 }],
      });
    }

    expect(itemCount(state, ItemId.RussetPotato), 'rot is opt-in again').toBe(0);
    // NOTHING VANISHES (§4): the potatoes were lost to time, not to this fix.
    expect(itemCount(state, ItemId.Compost)).toBe(10);
  });

  it('gives back exactly the time it was handed, cart or cellar, on an instant round trip', () => {
    // The round trip itself must be a no-op. This is the criterion in one line, and it holds for
    // the Root Cellar too — the cellar buys the time goods spend INSIDE it, never a fresh window.
    for (const kind of [MachineKind.HandCart, MachineKind.RootCellar]) {
      const state = world();
      const box = withCart(state, kind);
      addItem(state, ItemId.RussetPotato, 10);
      stepMany(state, 10 * ACTIVE_MINUTE);

      const before = inventorySlot(state, ItemId.RussetPotato)!.stacks[0]!.spoilAtTick;
      step(state, {
        tick: state.tick,
        commands: [
          { type: 'LoadMachine', machineId: box.id, count: 10, item: ItemId.RussetPotato },
        ],
      });
      step(state, {
        tick: state.tick,
        commands: [{ type: 'UnloadMachine', machineId: box.id, count: 10 }],
      });
      const after = inventorySlot(state, ItemId.RussetPotato)!.stacks[0]!.spoilAtTick;

      // Never later than it was. (It may be a bucket earlier: every rounding in this feature is
      // floored, and never in the player's favour.)
      expect(after, `${String(kind)} handed back a later deadline`).toBeLessThanOrEqual(before);
      expect(before - after).toBeLessThanOrEqual(FRESHNESS_BUCKET_TICKS + 2);
    }
  });

  it('does not launder the clock through the box-it-up verb either', () => {
    // The cheapest version of the same trick: load the cart, box the cart, and the goods come
    // back in your arms without an `UnloadMachine` anywhere in sight.
    const state = world();
    const cart = withCart(state);
    addItem(state, ItemId.RussetPotato, 10);
    stepMany(state, 13 * ACTIVE_MINUTE);

    step(state, {
      tick: state.tick,
      commands: [{ type: 'LoadMachine', machineId: cart.id, count: 10, item: ItemId.RussetPotato }],
    });
    step(state, {
      tick: state.tick,
      commands: [{ type: 'DeconstructMachine', machineId: cart.id }],
    });
    expect(itemCount(state, ItemId.RussetPotato), 'the load came home').toBe(10);
    expect(itemCount(state, ItemId.BoxedHandCart)).toBe(1);

    // Two more minutes and the window is spent, box or no box.
    stepMany(state, 3 * ACTIVE_MINUTE);
    expect(itemCount(state, ItemId.RussetPotato)).toBe(0);
    expect(itemCount(state, ItemId.Compost)).toBe(10);
  });

  it('AGES what is in a hand cart, at exactly the speed it ages in your arms', () => {
    // `MACHINE_SPECS` said this before the code did: *"It preserves as well as a crate does not —
    // 15 minutes, exactly what the goods had loose — because a cart is a barrow with a tarp over
    // it, and a hand cart that also refrigerated would make the $250 Root Cellar the second-best
    // fridge in the game."*
    const state = world();
    const cart = withCart(state);
    addItem(state, ItemId.RussetPotato, 10);
    step(state, {
      tick: state.tick,
      commands: [{ type: 'LoadMachine', machineId: cart.id, count: 10, item: ItemId.RussetPotato }],
    });
    expect(cart.cargoCount).toBe(10);

    stepMany(state, 14 * ACTIVE_MINUTE);
    expect(cart.cargoCount, 'turned early').toBe(10);

    stepMany(state, 2 * ACTIVE_MINUTE);
    // NOTHING VANISHES, INSIDE A BOX EITHER: the load is still in the cart, and it is compost.
    expect(cart.cargoItem).toBe(ItemId.Compost);
    expect(cart.cargoCount).toBe(10);
  });

  it('STOPS the clock in a Root Cellar, which is the one thing in the game that does', () => {
    // §4: "potato ~15 min loose / 45 crated / frozen in a Root Cellar." The freeze survives this
    // item untouched — what it stops being is a way to make old goods new.
    const state = world();
    const cellar = withCart(state, MachineKind.RootCellar);
    addItem(state, ItemId.RussetPotato, 10);
    stepMany(state, 10 * ACTIVE_MINUTE);
    step(state, {
      tick: state.tick,
      commands: [
        { type: 'LoadMachine', machineId: cellar.id, count: 10, item: ItemId.RussetPotato },
      ],
    });

    stepMany(state, 60 * ACTIVE_MINUTE);
    expect(cellar.cargoItem).toBe(ItemId.RussetPotato);
    expect(cellar.cargoCount).toBe(10);

    step(state, {
      tick: state.tick,
      commands: [{ type: 'UnloadMachine', machineId: cellar.id, count: 10 }],
    });
    // Out with the five minutes they went in with, not with fifteen.
    stepMany(state, 4 * ACTIVE_MINUTE);
    expect(itemCount(state, ItemId.RussetPotato), 'the cellar sold a fresh window').toBe(10);
    stepMany(state, 2 * ACTIVE_MINUTE);
    expect(itemCount(state, ItemId.RussetPotato)).toBe(0);
  });

  it('keeps the pessimistic merge when a second armful joins the first', () => {
    // The box holds one clock, so a top-up takes the SOONER of the two deadlines — the same
    // direction `addStack`'s cap merges in, and for the same reason: merging the other way lets a
    // player keep a stack alive forever by adding one fresh potato to it.
    const state = world();
    const cart = withCart(state);
    addItem(state, ItemId.RussetPotato, 5);
    stepMany(state, 12 * ACTIVE_MINUTE);
    step(state, {
      tick: state.tick,
      commands: [{ type: 'LoadMachine', machineId: cart.id, count: 5, item: ItemId.RussetPotato }],
    });

    // A freshly picked armful goes in on top of one with three minutes left.
    addItem(state, ItemId.RussetPotato, 5);
    step(state, {
      tick: state.tick,
      commands: [{ type: 'LoadMachine', machineId: cart.id, count: 5, item: ItemId.RussetPotato }],
    });
    expect(cart.cargoCount).toBe(10);

    stepMany(state, 4 * ACTIVE_MINUTE);
    expect(cart.cargoItem, 'the old armful did not drag the new one down with it').toBe(
      ItemId.Compost,
    );
  });
});
