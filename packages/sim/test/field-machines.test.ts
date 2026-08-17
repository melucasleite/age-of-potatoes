// Item 067: machines on farm tiles. The `fieldPlaceable` spec flag lets the watering family
// — barrel Sprinkler, PipedSprinkler head, Irrigation Hub — stand ON empty farmland, while
// every other machine stays behind the fence. The occupied tile grows nothing, is skipped by
// planting (hand, hopper, bot), and gives its ground back untouched on deconstruction.
//
// The golden fixture `mid-field` watches the full story against real money and real walking;
// this file states the individual rules so a failure names one.

import { describe, expect, it } from 'vitest';

import {
  type WorldState,
  CropId,
  ItemId,
  MachineKind,
  MOISTURE_MAX,
  SPRINKLER_CHARGE_ML,
  SPRINKLER_PERIOD_TICKS,
  TillMode,
  WILT_GRACE_TICKS,
  WILT_WINDOW_TICKS,
  addItem,
  createWorld,
  cropSpec,
  freshnessTicks,
  itemCount,
  machineSpec,
  plantCrop,
  spawnMachine,
  step,
  stepMany,
} from '../src/index';
import { machineAt, tileAt } from '../src/state';
import { TechId } from '../src/tech';

/** A world rich enough to buy any machine in this file without earning it on camera. */
function funded(seed: number): WorldState {
  const state = createWorld(seed);
  state.moneyCents = 1_000_000;
  return state;
}

function place(state: WorldState, kind: MachineKind, tileX: number, tileY: number): boolean {
  const before = state.machines.length;
  step(state, { tick: state.tick, commands: [{ type: 'PlaceMachine', kind, tileX, tileY }] });
  return state.machines.length > before;
}

describe('who may stand on farmland', () => {
  it('flags exactly the watering family as fieldPlaceable', () => {
    expect(machineSpec(MachineKind.Sprinkler)!.fieldPlaceable).toBe(true);
    expect(machineSpec(MachineKind.PipedSprinkler)!.fieldPlaceable).toBe(true);
    expect(machineSpec(MachineKind.IrrigationHub)!.fieldPlaceable).toBe(true);
    expect(machineSpec(MachineKind.ChipKitchen)!.fieldPlaceable).toBe(false);
    expect(machineSpec(MachineKind.Fryer)!.fieldPlaceable).toBe(false);
    expect(machineSpec(MachineKind.SellBin)!.fieldPlaceable).toBe(false);
  });

  it('places a barrel sprinkler on an empty farm tile, and a kitchen nowhere near one', () => {
    const state = funded(671);
    expect(place(state, MachineKind.Sprinkler, 7, 7), 'the sprinkler was turned away').toBe(true);
    expect(machineAt(state, 7, 7)).not.toBeNull();
    // The non-flagged machine keeps meeting the fence, one tile over.
    expect(place(state, MachineKind.ChipKitchen, 9, 9), 'the kitchen squatted the field').toBe(
      false,
    );
  });

  it('takes a growing tile and hands the seed back — item 121 supersedes item 067’s refusal', () => {
    // The owner's ask, 2026-08-17: *"when I place a sprinkler in an already planted tile, it
    // should remove the seed and give it back to me and place the sprinkler"*. Item 067 refused
    // this on the rule that nothing is silently destroyed. The rule survives: nothing IS
    // destroyed, because the seed comes back.
    const state = funded(672);
    const spec = cropSpec(CropId.RussetPotato)!;
    const tile = tileAt(state, 6, 6)!;
    plantCrop(state, tile, spec);
    tile.growth = 1; // Under way, and a long way from ready.
    const seedsBefore = itemCount(state, ItemId.PotatoSeed);

    expect(place(state, MachineKind.Sprinkler, 6, 6), 'the growing tile turned the head away').toBe(
      true,
    );
    expect(machineAt(state, 6, 6), 'nothing was standing there afterwards').not.toBeNull();
    expect(tileAt(state, 6, 6)!.crop, 'the crop is still in the ground under the machine').toBe(
      CropId.None,
    );
    expect(itemCount(state, ItemId.PotatoSeed), 'the seed did not come back').toBe(seedsBefore + 1);
  });

  it('takes waiting compost too, rather than being blocked by it', () => {
    const state = funded(6721);
    tileAt(state, 8, 8)!.compost = 2;
    expect(place(state, MachineKind.Sprinkler, 8, 8), 'waiting compost blocked the head').toBe(
      true,
    );
    expect(itemCount(state, ItemId.Compost), 'the compost was left in the ground').toBe(2);
    expect(tileAt(state, 8, 8)!.compost).toBe(0);
  });

  it('**A RIPE TILE PAYS THE HARVEST, WHICH IS THE RULING** — produce, compost and seed', () => {
    // The open question item 121 left open, settled here and argued in `clearFieldTileForMachine`:
    // return the produce rather than refuse. What the player gets is EXACTLY what pulling the tile
    // by hand first would have paid them, because it is the same `takeHarvest`.
    const state = funded(6722);
    const spec = cropSpec(CropId.RussetPotato)!;
    const tile = tileAt(state, 6, 6)!;
    plantCrop(state, tile, spec);
    tile.growth = tile.growthTarget;
    tile.compost = 3;
    const fertility = tile.fertility;
    const seedsBefore = itemCount(state, ItemId.PotatoSeed);

    expect(place(state, MachineKind.Sprinkler, 6, 6), 'a ripe tile refused the head').toBe(true);
    // The yield is `fertility + a 0-or-1 roll`, so this brackets it rather than pinning the roll.
    const picked = itemCount(state, ItemId.RussetPotato);
    expect(picked, 'the ripe crop was destroyed instead of handed back').toBeGreaterThanOrEqual(
      fertility,
    );
    expect(picked).toBeLessThanOrEqual(fertility + 1);
    expect(itemCount(state, ItemId.Compost), 'the compost went with it').toBe(3);
    expect(itemCount(state, ItemId.PotatoSeed), 'a one-shot crop owes a seed back').toBe(
      seedsBefore + 1,
    );
    expect(tileAt(state, 6, 6)!.crop).toBe(CropId.None);
  });

  it('a TURNED tile pays the Day-Old grade, exactly as a hand harvest of it would', () => {
    // The age a standing crop carries crosses this boundary as the GRADE, which is the whole
    // reason a full freshness window on the way out is honest rather than a laundering trick:
    // the tile's `readyAge` is not thrown away, it is spent here.
    const state = funded(6723);
    const spec = cropSpec(CropId.RussetPotato)!;
    const tile = tileAt(state, 6, 6)!;
    plantCrop(state, tile, spec);
    tile.growth = tile.growthTarget;
    tile.readyAge = WILT_GRACE_TICKS + WILT_WINDOW_TICKS + 1;

    expect(place(state, MachineKind.Sprinkler, 6, 6)).toBe(true);
    expect(itemCount(state, ItemId.DayOldPotato), 'a turned crop came back fresh').toBeGreaterThan(
      0,
    );
    expect(itemCount(state, ItemId.RussetPotato), 'a turned crop paid the full grade').toBe(0);
  });

  it('a REGROWING crop loses its plant, so it gets a seed back a hand harvest would not give', () => {
    // Cane and chili regrow: `takeHarvest` leaves the plant standing and returns no seed, because
    // you still own the plant. A placement uproots it, so the seed is what the plant is worth.
    const state = funded(6724);
    state.unlocked = [TechId.Chili];
    const spec = cropSpec(CropId.ChiliPepper)!;
    const tile = tileAt(state, 6, 6)!;
    plantCrop(state, tile, spec);
    tile.growth = tile.growthTarget;

    expect(place(state, MachineKind.Sprinkler, 6, 6)).toBe(true);
    expect(itemCount(state, ItemId.ChiliPepper), 'the ripe chilis vanished').toBeGreaterThan(0);
    expect(itemCount(state, ItemId.ChiliSeed), 'the uprooted plant paid nothing back').toBe(1);
    expect(tileAt(state, 6, 6)!.crop, 'the plant regrew under the machine').toBe(CropId.None);
  });

  it('holds the whole footprint to the rule: a 2×2 Hub clears all four tiles it lands on', () => {
    const state = funded(673);
    state.unlocked = [TechId.IrrigationHub];
    const spec = cropSpec(CropId.RussetPotato)!;
    for (const [x, y] of [
      [7, 7],
      [8, 7],
      [7, 8],
      [8, 8],
    ]) {
      plantCrop(state, tileAt(state, x!, y!)!, spec);
    }
    const seedsBefore = itemCount(state, ItemId.PotatoSeed);

    expect(place(state, MachineKind.IrrigationHub, 7, 7), 'a corner crop turned the Hub away').toBe(
      true,
    );
    expect(itemCount(state, ItemId.PotatoSeed), 'the Hub kept some of the four seeds').toBe(
      seedsBefore + 4,
    );
    for (const [x, y] of [
      [7, 7],
      [8, 7],
      [7, 8],
      [8, 8],
    ]) {
      expect(tileAt(state, x!, y!)!.crop, `(${String(x)},${String(y)}) was left planted`).toBe(
        CropId.None,
      );
    }
  });

  it('**DOES NOT WIDEN PAST `fieldPlaceable`** — a kitchen still cannot take a planted tile', () => {
    // The one boundary item 121 draws explicitly. A machine that was never allowed on farmland is
    // not allowed on farmland now, and it certainly does not get to harvest one on the way.
    const state = funded(6725);
    const spec = cropSpec(CropId.RussetPotato)!;
    plantCrop(state, tileAt(state, 6, 6)!, spec);
    const seedsBefore = itemCount(state, ItemId.PotatoSeed);

    expect(place(state, MachineKind.ChipKitchen, 6, 6), 'the kitchen took a crop').toBe(false);
    expect(tileAt(state, 6, 6)!.crop, 'a refused placement cleared the tile anyway').toBe(
      CropId.RussetPotato,
    );
    expect(itemCount(state, ItemId.PotatoSeed), 'a refused placement paid out').toBe(seedsBefore);
  });

  it('a MOVE onto a planted tile hands the seed back too — the same rule, the other verb', () => {
    const state = funded(6726);
    const spec = cropSpec(CropId.RussetPotato)!;
    plantCrop(state, tileAt(state, 9, 9)!, spec);
    expect(place(state, MachineKind.Sprinkler, 6, 6)).toBe(true);
    const machine = machineAt(state, 6, 6)!;
    const seedsBefore = itemCount(state, ItemId.PotatoSeed);

    state.player.xSub = 9 * 256 + 128;
    state.player.ySub = 9 * 256 + 128;
    step(state, {
      tick: state.tick,
      commands: [{ type: 'MoveMachine', machineId: machine.id, tileX: 9, tileY: 9 }],
    });
    expect(machineAt(state, 9, 9), 'the move was refused by the crop').not.toBeNull();
    expect(itemCount(state, ItemId.PotatoSeed), 'the moved head ate the seed').toBe(
      seedsBefore + 1,
    );
    expect(tileAt(state, 9, 9)!.crop).toBe(CropId.None);
  });

  it('**NOTHING CAN VANISH FOR WANT OF ROOM, BECAUSE THE BAG HAS NO BOTTOM**', () => {
    // Item 121 asks for a refusal when the bag is full. That refusal is unwritable, and this is
    // the fact rather than the excuse: `addItem` is unbounded and has been since item 068 struck
    // the armful cap, so there is no reachable state in which a returned crop has nowhere to go.
    // Pinned as an executed statement, because the day somebody adds a cap this hand-back becomes
    // a deletion — and this test is what will say so.
    const state = funded(6727);
    addItem(state, ItemId.RussetPotato, 1_000_000);
    expect(itemCount(state, ItemId.RussetPotato), 'the bag turned goods away').toBe(1_000_000);

    const spec = cropSpec(CropId.RussetPotato)!;
    const tile = tileAt(state, 6, 6)!;
    plantCrop(state, tile, spec);
    tile.growth = tile.growthTarget;
    const before = itemCount(state, ItemId.RussetPotato);

    expect(place(state, MachineKind.Sprinkler, 6, 6), 'a laden bag refused the placement').toBe(
      true,
    );
    expect(
      itemCount(state, ItemId.RussetPotato),
      'the crop was destroyed rather than added to a bag that was already enormous',
    ).toBeGreaterThan(before);
  });

  it('what the hand-back MINTS on the shelf-stable doors really is shelf-stable', () => {
    // **THE VERDICT, FALSIFIED RATHER THAN ASSERTED.** Two of the three bag doors on
    // `clearFieldTileForMachine` claim `MintsShelfStable` — a claim of FACT about the goods, and
    // the one verdict in the table a machine can actually check. Door 8 made this exact claim
    // while carrying potatoes.
    expect(freshnessTicks(ItemId.Compost), 'compost keeps a clock').toBe(0);
    for (const crop of [
      CropId.RussetPotato,
      CropId.SugarCane,
      CropId.Corn,
      CropId.ChiliPepper,
      CropId.GoldPotato,
    ]) {
      const seed = cropSpec(crop)!.seedItem;
      expect(freshnessTicks(seed), `seed ${String(seed)} keeps a clock`).toBe(0);
    }
  });
});

describe('the occupied tile grows nothing', () => {
  it('refuses hand planting under the machine', () => {
    const state = funded(674);
    expect(place(state, MachineKind.Sprinkler, 7, 7)).toBe(true);
    state.player.xSub = 7 * 256 + 128;
    state.player.ySub = 8 * 256 + 128;
    addItem(state, ItemId.PotatoSeed, 1);
    const seeds = itemCount(state, ItemId.PotatoSeed);
    step(state, {
      tick: state.tick,
      commands: [{ type: 'PlantTile', tileX: 7, tileY: 7, crop: CropId.RussetPotato }],
    });
    expect(tileAt(state, 7, 7)!.crop, 'a crop sprouted under the machine').toBe(CropId.None);
    expect(itemCount(state, ItemId.PotatoSeed), 'the refusal ate a seed').toBe(seeds);
  });

  it('keeps its ground while the till sweeps over it', () => {
    const state = funded(675);
    expect(place(state, MachineKind.Sprinkler, 7, 7)).toBe(true);
    step(state, {
      tick: state.tick,
      commands: [{ type: 'TillTile', rect: { x: 6, y: 7, w: 3, h: 1 }, mode: TillMode.Untill }],
    });
    // The neighbours went back to grass; the machine kept its floor.
    expect(tileAt(state, 6, 7)).toBeNull();
    expect(tileAt(state, 8, 7)).toBeNull();
    expect(tileAt(state, 7, 7), 'the ground was pulled from under the machine').not.toBeNull();
  });
});

describe('the seed hopper skips the obstruction', () => {
  it('auto-replants around a machine-occupied zone tile and keeps the seed', () => {
    const state = funded(679);
    state.unlocked = [TechId.AutoReplant];
    expect(place(state, MachineKind.Sprinkler, 7, 7)).toBe(true);
    addItem(state, ItemId.PotatoSeed, 10);

    step(state, {
      tick: state.tick,
      commands: [
        { type: 'CreateZone', crop: CropId.RussetPotato, rect: { x: 6, y: 7, w: 2, h: 1 } },
      ],
    });
    const zone = state.zones[state.zones.length - 1]!;
    step(state, {
      tick: state.tick,
      commands: [{ type: 'SetZoneAutoReplant', zoneId: zone.id, on: true }],
    });

    // Plenty of periods for a hopper that wanted to plant both tiles.
    stepMany(state, 500);
    expect(tileAt(state, 6, 7)!.crop, 'the free tile went unplanted').toBe(CropId.RussetPotato);
    expect(tileAt(state, 7, 7)!.crop, 'the hopper planted under the machine').toBe(CropId.None);
  });
});

describe('watering around the obstruction', () => {
  it('a mid-field 5×5 sprinkler waters all 24 neighbours on one charge, never its own feet', () => {
    // THE SUBJECT IS THE FOOTPRINT, NOT THE BARREL. Item 067's rule is that a head standing on
    // farmland never waters the tile it occupies, and that the other 24 in its 5×5 all get
    // served. Item 086 briefly made that take three hauls — ten charges, ten, then four — and
    // item 097's owner ruling put it back in one: "when they spend a charge, they should water
    // everything in a 5x5". One cycle, one charge, 24 tiles.
    const state = funded(676);
    const sprinkler = spawnMachine(state, MachineKind.Sprinkler, 7, 7)!;
    const full = machineSpec(MachineKind.Sprinkler)!.tankCapacityMl;
    // A few dry ticks first, so tick 0 — which is also `lastPouredTick`'s "never" — is behind
    // us before the pours this test watches.
    stepMany(state, 3);

    sprinkler.tankMl = full;
    stepMany(state, SPRINKLER_PERIOD_TICKS + 2);

    expect(sprinkler.wateredCount, 'the cycle missed a neighbour or wet its own tile').toBe(24);
    expect(sprinkler.tankMl, 'one full patch cost other than one charge').toBe(
      full - SPRINKLER_CHARGE_ML,
    );
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const tile = tileAt(state, 7 + dx, 7 + dy)!;
        if (dx === 0 && dy === 0) {
          expect(tile.lastPouredTick, 'the head watered under itself').toBe(0);
        } else {
          expect(
            tile.lastPouredTick,
            `(${String(7 + dx)},${String(7 + dy)}) stayed dry`,
          ).toBeGreaterThan(0);
        }
      }
    }
    // Nine charges left, and one more cycle over the patch it has just finished wetting: 24
    // tiles looked at and passed over, and NOT 25. The head's own tile is no more a saving
    // than it was a pour — it was never waterable, so skipping it saved nothing and is
    // counted as nothing.
    const held = sprinkler.tankMl;
    const skippedBefore = sprinkler.skippedCount;
    // Stepped to the next cycle rather than for a fixed span: a whole cycle happens inside one
    // tick, so waiting for the counter to move measures exactly one of them however the
    // cooldown happens to be phased.
    for (
      let i = 0;
      i < 2 * SPRINKLER_PERIOD_TICKS && sprinkler.skippedCount === skippedBefore;
      i++
    ) {
      stepMany(state, 1);
    }
    expect(sprinkler.skippedCount - skippedBefore).toBe(24);
    expect(sprinkler.tankMl, 'a cycle that watered nothing still spent a charge').toBe(held);
  });

  it('the Hub scans past occupied tiles without pouring or counting them as savings', () => {
    const state = funded(677);
    const hub = spawnMachine(state, MachineKind.IrrigationHub, 7, 7)!;
    hub.tankMl = machineSpec(MachineKind.IrrigationHub)!.tankCapacityMl;

    // Long enough for the bounded scan to lap the whole coverage patch at least once.
    stepMany(state, 4_000);
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = 0; dx <= 1; dx++) {
        expect(
          tileAt(state, 7 + dx, 7 + dy)!.lastPouredTick,
          'the Hub poured under its own 2×2',
        ).toBe(0);
      }
    }
    expect(hub.wateredCount, 'the Hub watered nothing at all').toBeGreaterThan(0);
  });
});

describe('deconstruction hands the ground back', () => {
  it('soil, fertility, and moisture ride through placement and deconstruction untouched', () => {
    const state = funded(678);
    const tile = tileAt(state, 7, 7)!;
    tile.moisture = MOISTURE_MAX;
    const before = { soil: tile.soil, fertility: tile.fertility };

    expect(place(state, MachineKind.Sprinkler, 7, 7)).toBe(true);
    const machine = machineAt(state, 7, 7)!;
    stepMany(state, 50);
    const moistureBefore = tileAt(state, 7, 7)!.moisture;

    state.player.xSub = 7 * 256 + 128;
    state.player.ySub = 8 * 256 + 128;
    step(state, {
      tick: state.tick,
      commands: [{ type: 'DeconstructMachine', machineId: machine.id }],
    });
    expect(machineAt(state, 7, 7), 'the machine refused to leave').toBeNull();

    const after = tileAt(state, 7, 7)!;
    expect(after.soil).toBe(before.soil);
    expect(after.fertility).toBe(before.fertility);
    // Deconstruction itself moves no moisture: one tick of ordinary decay for the tick the
    // command rode in on, and not a drop more.
    expect(after.moisture).toBe(moistureBefore - 1);
    expect(after.moisture).toBeGreaterThan(0);

    // And the freed tile plants again, immediately.
    addItem(state, ItemId.PotatoSeed, 1);
    step(state, {
      tick: state.tick,
      commands: [{ type: 'PlantTile', tileX: 7, tileY: 7, crop: CropId.RussetPotato }],
    });
    expect(after.crop, 'the freed tile refused the seed').toBe(CropId.RussetPotato);
  });
});
