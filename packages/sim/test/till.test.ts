// The till tool (item 066): player-made farmland, and the roll-once ledger under it.
//
// The golden fixture `the-till` pins that the whole story replays to one exact world. This
// file is the other half — each rule stated as the criterion it comes from, so a failure
// names the rule rather than a hash.

import { describe, expect, it } from 'vitest';

import {
  type TileRect,
  type WorldState,
  CropId,
  ItemId,
  MachineKind,
  TillMode,
  createWorld,
  cropSpec,
  hashState,
  isFieldTile,
  itemCount,
  plantCrop,
  soilMemoryAt,
  spawnMachine,
  step,
  takeHarvest,
  tileAt,
  worldTileKey,
} from '../src/index';

/** Grass north of the starting field, inside the owned starting parcel. */
const GRASS_X = 5;
const GRASS_Y = 2;

function world(seed = 660): WorldState {
  return createWorld(seed);
}

function till(state: WorldState, rect: TileRect, mode: TillMode = TillMode.Till): boolean {
  const before = state.trace.length;
  step(state, { tick: state.tick, commands: [{ type: 'TillTile', rect, mode }] });
  return state.trace.length > before;
}

function tillOne(state: WorldState, x: number, y: number, mode: TillMode = TillMode.Till): boolean {
  return till(state, { x, y, w: 1, h: 1 }, mode);
}

describe('the till tool', () => {
  it('turns owned grass into a farm tile that plants, waters, and zones like any other', () => {
    const state = world();
    expect(tileAt(state, GRASS_X, GRASS_Y)).toBeNull();
    expect(tillOne(state, GRASS_X, GRASS_Y)).toBe(true);

    const tile = tileAt(state, GRASS_X, GRASS_Y);
    expect(tile).not.toBeNull();
    expect(isFieldTile(state, GRASS_X, GRASS_Y)).toBe(true);

    // Plantable exactly as an original field tile is — same reducer, same rules. The player
    // spawns out of reach of the new tile, so the tile is exercised through the sim's own
    // mechanics rather than a walk: plant, grow, harvest.
    const spec = cropSpec(CropId.RussetPotato)!;
    plantCrop(state, tile!, spec);
    tile!.moisture = 1;
    tile!.growth = tile!.growthTarget;
    const result = takeHarvest(state, tile!, spec);
    expect(result).not.toBeNull();
    expect(result!.count).toBeGreaterThan(0);

    // Zonable: a CreateZone rect over the tilled tile takes.
    step(state, {
      tick: state.tick,
      commands: [
        {
          type: 'CreateZone',
          rect: { x: GRASS_X, y: GRASS_Y, w: 1, h: 1 },
          crop: CropId.RussetPotato,
        },
      ],
    });
    expect(tileAt(state, GRASS_X, GRASS_Y)!.zone).not.toBe(0);
  });

  it('refuses unowned grass, occupied ground, and ground that already is what was asked', () => {
    const state = world();
    // Parcel 1 starts unowned: tile (16,4) is real ground with a price on it, not farmland.
    expect(tillOne(state, 16, 4)).toBe(false);
    // Under a machine: the sell bin's own tile.
    const bin = state.machines.find((m) => m.kind === MachineKind.SellBin)!;
    expect(tillOne(state, bin.tileX, bin.tileY)).toBe(false);
    // Already farm: the starting field. Nothing changes, so nothing is traced.
    expect(tillOne(state, 4, 4)).toBe(false);
    // Already grass, asked for grass.
    expect(tillOne(state, GRASS_X, GRASS_Y, TillMode.Untill)).toBe(false);
  });

  it('un-tills an EMPTY farm tile back to grass, and refuses planted or compost tiles gently', () => {
    const state = world();
    // A planted tile refuses.
    const planted = tileAt(state, 4, 4)!;
    plantCrop(state, planted, cropSpec(CropId.RussetPotato)!);
    expect(tillOne(state, 4, 4, TillMode.Untill)).toBe(false);
    expect(tileAt(state, 4, 4)).not.toBeNull();

    // A compost-bearing tile refuses — the till never destroys what a hand must pick up.
    const composted = tileAt(state, 5, 4)!;
    composted.compost = 2;
    expect(tillOne(state, 5, 4, TillMode.Untill)).toBe(false);

    // An empty one goes, and the world genuinely loses the tile.
    expect(tillOne(state, 6, 4, TillMode.Untill)).toBe(true);
    expect(tileAt(state, 6, 4)).toBeNull();
    expect(isFieldTile(state, 6, 4)).toBe(false);
  });

  it('rolls soil once per position, ever: re-tilling returns the identical ground', () => {
    const state = world();
    expect(tillOne(state, GRASS_X, GRASS_Y)).toBe(true);
    const born = tileAt(state, GRASS_X, GRASS_Y)!;
    const soil = born.soil;
    const fertility = born.fertility;

    // Ten till–untill cycles; the ground never changes. One cycle proves the mechanism;
    // ten prove nobody is advancing a hidden stream.
    for (let i = 0; i < 10; i++) {
      expect(tillOne(state, GRASS_X, GRASS_Y, TillMode.Untill)).toBe(true);
      expect(tillOne(state, GRASS_X, GRASS_Y)).toBe(true);
      const back = tileAt(state, GRASS_X, GRASS_Y)!;
      expect(back.soil).toBe(soil);
      expect(back.fertility).toBe(fertility);
    }
  });

  it('rolls the STARTING field tiles once ever too: the gift dirt survives the cycle', () => {
    const state = world();
    const born = tileAt(state, 7, 7)!;
    const soil = born.soil;
    const fertility = born.fertility;
    expect(tillOne(state, 7, 7, TillMode.Untill)).toBe(true);
    expect(tillOne(state, 7, 7)).toBe(true);
    const back = tileAt(state, 7, 7)!;
    // The sequential birth roll, not a fresh position-keyed one — the ledger remembers.
    expect(back.soil).toBe(soil);
    expect(back.fertility).toBe(fertility);
  });

  it('is order-independent: two worlds tilling the same tiles in opposite order agree', () => {
    const a = world(123);
    const b = world(123);
    expect(tillOne(a, 5, 2)).toBe(true);
    expect(tillOne(a, 9, 2)).toBe(true);
    expect(tillOne(b, 9, 2)).toBe(true);
    expect(tillOne(b, 5, 2)).toBe(true);
    expect(tileAt(a, 5, 2)!.soil).toBe(tileAt(b, 5, 2)!.soil);
    expect(tileAt(a, 9, 2)!.soil).toBe(tileAt(b, 9, 2)!.soil);
    expect(tileAt(a, 5, 2)!.fertility).toBe(tileAt(b, 5, 2)!.fertility);
    // The WHOLE worlds agree, not just the two tiles: same tick, same touches, same field,
    // same ledger — the order of the drags survives only in the trace, which is not state.
    expect(hashState(a)).toBe(hashState(b));
  });

  it('remembers worn fertility across the cycle — no laundering worn dirt through grass', () => {
    const state = world();
    expect(tillOne(state, GRASS_X, GRASS_Y)).toBe(true);
    const tile = tileAt(state, GRASS_X, GRASS_Y)!;
    const spec = cropSpec(CropId.RussetPotato)!;

    // Harvest it once: `fertilityWear` advances (and fertility may step down at the wrap).
    plantCrop(state, tile, spec);
    tile.growth = tile.growthTarget;
    expect(takeHarvest(state, tile, spec)).not.toBeNull();
    const wornFertility = tile.fertility;
    const wear = tile.fertilityWear;

    expect(tillOne(state, GRASS_X, GRASS_Y, TillMode.Untill)).toBe(true);
    expect(tillOne(state, GRASS_X, GRASS_Y)).toBe(true);
    const back = tileAt(state, GRASS_X, GRASS_Y)!;
    expect(back.fertility).toBe(wornFertility);
    expect(back.fertilityWear).toBe(wear);
  });

  it('keeps the field sorted by world key, whatever order the player tills in', () => {
    const state = world();
    expect(tillOne(state, 9, 2)).toBe(true);
    expect(tillOne(state, 5, 2)).toBe(true);
    expect(tillOne(state, 7, 1)).toBe(true);
    for (let i = 1; i < state.field.length; i++) {
      const prev = state.field[i - 1]!;
      const here = state.field[i]!;
      expect(worldTileKey(here.tileX, here.tileY)).toBeGreaterThan(
        worldTileKey(prev.tileX, prev.tileY),
      );
    }
  });

  it('drops an un-tilled tile from its zone, and prunes the zone that loses its last tile', () => {
    const state = world();
    expect(tillOne(state, GRASS_X, GRASS_Y)).toBe(true);
    step(state, {
      tick: state.tick,
      commands: [
        {
          type: 'CreateZone',
          rect: { x: GRASS_X, y: GRASS_Y, w: 1, h: 1 },
          crop: CropId.None,
        },
      ],
    });
    expect(state.zones.length).toBe(1);
    expect(tillOne(state, GRASS_X, GRASS_Y, TillMode.Untill)).toBe(true);
    // The zone's one tile left the world, so the plan goes with it.
    expect(state.zones.length).toBe(0);
  });

  it('refuses a CreateZone drag over pure grass rather than leaving an empty plan', () => {
    const state = world();
    const before = state.nextZoneId;
    step(state, {
      tick: state.tick,
      commands: [{ type: 'CreateZone', rect: { x: 0, y: 0, w: 2, h: 2 }, crop: CropId.None }],
    });
    expect(state.zones.length).toBe(0);
    expect(state.nextZoneId).toBe(before);
  });

  it('is free, counts one touch per drag, and a no-op drag is not traced', () => {
    const state = world();
    const money = state.moneyCents;
    const touches = state.stats.touches.handCarry;
    expect(till(state, { x: 4, y: 2, w: 4, h: 1 })).toBe(true);
    expect(state.moneyCents).toBe(money);
    expect(state.stats.touches.handCarry).toBe(touches + 1);
    expect(itemCount(state, ItemId.Compost)).toBe(0);

    const traceBefore = state.trace.length;
    // The same drag again converts nothing, so it is refused and leaves no trace entry.
    expect(till(state, { x: 4, y: 2, w: 4, h: 1 })).toBe(false);
    expect(state.trace.length).toBe(traceBefore);
  });

  it('keeps the roll-once ledger in the digest: remembered ground is world state', () => {
    const state = world(9);
    expect(tillOne(state, GRASS_X, GRASS_Y)).toBe(true);
    expect(tillOne(state, GRASS_X, GRASS_Y, TillMode.Untill)).toBe(true);
    expect(soilMemoryAt(state, worldTileKey(GRASS_X, GRASS_Y))).not.toBeNull();

    // Two worlds identical in every field EXCEPT one forgotten ledger entry must disagree:
    // what an un-tilled position WOULD roll back is a fact about the world's future.
    const amnesiac = JSON.parse(JSON.stringify(state)) as WorldState;
    amnesiac.soilMemory = amnesiac.soilMemory.filter(
      (entry) => entry.tile !== worldTileKey(GRASS_X, GRASS_Y),
    );
    expect(hashState(amnesiac)).not.toBe(hashState(state));
  });
});
