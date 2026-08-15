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
  SPRINKLER_PERIOD_TICKS,
  TillMode,
  addItem,
  createWorld,
  cropSpec,
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

  it('refuses a crop-bearing tile and a compost-bearing tile — nothing is silently destroyed', () => {
    const state = funded(672);
    const spec = cropSpec(CropId.RussetPotato)!;
    plantCrop(state, tileAt(state, 6, 6)!, spec);
    expect(place(state, MachineKind.Sprinkler, 6, 6), 'placed on a growing crop').toBe(false);

    tileAt(state, 8, 8)!.compost = 2;
    expect(place(state, MachineKind.Sprinkler, 8, 8), 'placed on waiting compost').toBe(false);
  });

  it('holds the whole footprint to the rule: a 2×2 Hub with one crop under any corner refuses', () => {
    const state = funded(673);
    state.unlocked = [TechId.IrrigationHub];
    const spec = cropSpec(CropId.RussetPotato)!;
    plantCrop(state, tileAt(state, 8, 7)!, spec);
    expect(place(state, MachineKind.IrrigationHub, 7, 7), 'a corner crop was overlooked').toBe(
      false,
    );
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
  it('a mid-field 5×5 sprinkler waters all 24 neighbours in one cycle and never its own feet', () => {
    const state = funded(676);
    const sprinkler = spawnMachine(state, MachineKind.Sprinkler, 7, 7)!;
    // A few dry ticks first, so tick 0 — which is also `lastPouredTick`'s "never" — is behind
    // us before the one pour this test watches.
    stepMany(state, 3);
    sprinkler.tankMl = machineSpec(MachineKind.Sprinkler)!.tankCapacityMl;
    const pourTick = state.tick;

    stepMany(state, SPRINKLER_PERIOD_TICKS + 2);
    expect(sprinkler.wateredCount, 'the cycle missed a neighbour or wet its own tile').toBe(24);
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const tile = tileAt(state, 7 + dx, 7 + dy)!;
        if (dx === 0 && dy === 0) {
          expect(tile.lastPouredTick, 'the head watered under itself').toBe(0);
        } else {
          expect(tile.lastPouredTick, `(${String(7 + dx)},${String(7 + dy)}) stayed dry`).toBe(
            pourTick,
          );
        }
      }
    }
    // 24 pours, not 25: the skipped tile cost no water. The barrel held exactly one cycle.
    expect(sprinkler.tankMl).toBe(0);
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
