// The till tool (item 066): player-made farmland, and the roll-once ledger under it.
//
// The golden fixture `the-till` pins that the whole story replays to one exact world. This
// file is the other half — each rule stated as the criterion it comes from, so a failure
// names the rule rather than a hash.

import { describe, expect, it } from 'vitest';

import {
  HARVEST_BASE_COUNT,
  type TileRect,
  type WorldState,
  CropId,
  ItemId,
  MachineKind,
  TillMode,
  addItem,
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
import { TechId } from '../src/tech';

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

  it('un-tills an EMPTY farm tile back to grass, and refuses a planted one gently', () => {
    const state = world();
    // A planted tile refuses.
    const planted = tileAt(state, 4, 4)!;
    plantCrop(state, planted, cropSpec(CropId.RussetPotato)!);
    expect(tillOne(state, 4, 4, TillMode.Untill)).toBe(false);
    expect(tileAt(state, 4, 4)).not.toBeNull();

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

    // Ten till–untill cycles; the ground never changes. One cycle proves the mechanism;
    // ten prove nobody is advancing a hidden stream.
    for (let i = 0; i < 10; i++) {
      expect(tillOne(state, GRASS_X, GRASS_Y, TillMode.Untill)).toBe(true);
      expect(tillOne(state, GRASS_X, GRASS_Y)).toBe(true);
      const back = tileAt(state, GRASS_X, GRASS_Y)!;
      expect(back.soil).toBe(soil);
    }
  });

  it('rolls the STARTING field tiles once ever too: the gift dirt survives the cycle', () => {
    const state = world();
    const born = tileAt(state, 7, 7)!;
    const soil = born.soil;
    expect(tillOne(state, 7, 7, TillMode.Untill)).toBe(true);
    expect(tillOne(state, 7, 7)).toBe(true);
    const back = tileAt(state, 7, 7)!;
    // The sequential birth roll, not a fresh position-keyed one — the ledger remembers.
    expect(back.soil).toBe(soil);
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
    // The WHOLE worlds agree, not just the two tiles: same tick, same touches, same field,
    // same ledger — the order of the drags survives only in the trace, which is not state.
    expect(hashState(a)).toBe(hashState(b));
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

// --- the middle rung (item 127) --------------------------------------------------------------

describe('the till un-plants before it un-tills', () => {
  /**
   * The owner's ask, 2026-08-17, verbatim: *"if I use a shovel on a planted tile that is not
   * fully grown, I want it to give me back the seed and keep it as dirt. If I click again, turn
   * it to grass, but I want a way to un-plant."*
   */
  it('THE ASK: a growing tile gives the seed back and stays dirt', () => {
    const state = world(1270);
    const spec = cropSpec(CropId.RussetPotato)!;
    const tile = tileAt(state, 6, 6)!;
    plantCrop(state, tile, spec);
    tile.growth = 1; // Under way, a long way from ready — the owner's "not fully grown".
    const seeds = itemCount(state, ItemId.PotatoSeed);

    expect(tillOne(state, 6, 6, TillMode.Unplant), 'the swing found nothing to lift').toBe(true);
    expect(itemCount(state, ItemId.PotatoSeed), 'the seed did not come back').toBe(seeds + 1);
    expect(tileAt(state, 6, 6), 'the ground went with the crop').not.toBeNull();
    expect(tileAt(state, 6, 6)!.crop).toBe(CropId.None);
    expect(tileAt(state, 6, 6)!.growth).toBe(0);
    expect(isFieldTile(state, 6, 6), 'it should still be dirt, not grass').toBe(true);
  });

  it('AND CLICK AGAIN FOR GRASS: two swings take a planted tile all the way back', () => {
    // The ladder, walked. Each swing removes exactly one layer of what the player did, in the
    // reverse of the order they did it — which is the whole reason the tool is guessable.
    const state = world(1271);
    plantCrop(state, tileAt(state, 6, 6)!, cropSpec(CropId.RussetPotato)!);

    expect(tillOne(state, 6, 6, TillMode.Unplant)).toBe(true);
    expect(isFieldTile(state, 6, 6)).toBe(true);
    expect(tillOne(state, 6, 6, TillMode.Untill)).toBe(true);
    expect(tileAt(state, 6, 6)).toBeNull();
    expect(isFieldTile(state, 6, 6)).toBe(false);

    // And the first two rungs are untouched: grass still tills, bare farmland still un-tills.
    expect(tillOne(state, GRASS_X, GRASS_Y, TillMode.Till)).toBe(true);
    expect(isFieldTile(state, GRASS_X, GRASS_Y)).toBe(true);
    expect(tillOne(state, GRASS_X, GRASS_Y, TillMode.Untill)).toBe(true);
    expect(isFieldTile(state, GRASS_X, GRASS_Y)).toBe(false);
  });

  it('**A RIPE TILE IS UN-PLANTED, NOT SKIPPED** — the ruling, and it agrees with item 121', () => {
    // Work item 127's working ruling was "the till SKIPS a ripe tile", on the grounds that a
    // tool which could silently shovel away a finished crop would generate a bug report about
    // lost work. THAT PREMISE IS FALSE HERE and this test is what says so: the produce comes
    // back through `takeHarvest`, the same pull a hand makes, so the player is paid precisely
    // what harvesting first would have paid. The argument is in `applyTillTile`.
    const state = world(1272);
    const spec = cropSpec(CropId.RussetPotato)!;
    const tile = tileAt(state, 6, 6)!;
    plantCrop(state, tile, spec);
    tile.growth = tile.growthTarget;
    const seeds = itemCount(state, ItemId.PotatoSeed);

    expect(tillOne(state, 6, 6, TillMode.Unplant), 'the ripe tile turned the till away').toBe(true);
    // The yield is `HARVEST_BASE_COUNT + a 0-or-1 roll`, so this brackets it rather than pinning
    // the roll — the same bracket `field-machines.test.ts` puts around the placement's payout.
    const picked = itemCount(state, ItemId.RussetPotato);
    expect(picked, 'the ripe crop was destroyed instead of handed back').toBeGreaterThanOrEqual(
      HARVEST_BASE_COUNT,
    );
    expect(picked).toBeLessThanOrEqual(HARVEST_BASE_COUNT + 1);
    expect(itemCount(state, ItemId.PotatoSeed), 'a one-shot crop owes a seed back').toBe(seeds + 1);
    expect(tileAt(state, 6, 6)!.crop).toBe(CropId.None);
    expect(isFieldTile(state, 6, 6), 'a ripe un-plant took the ground too').toBe(true);
  });

  it('skips a BARE farm tile and a patch of GRASS, which is what makes the anchor safe', () => {
    const state = world(1274);
    const traced = state.trace.length;
    expect(tillOne(state, 6, 6, TillMode.Unplant), 'a bare tile was un-planted').toBe(false);
    expect(tillOne(state, GRASS_X, GRASS_Y, TillMode.Unplant), 'grass was un-planted').toBe(false);
    expect(state.trace.length, 'a drag that changed nothing was traced').toBe(traced);
  });

  it('ONE MODE PER DRAG, CHOSEN BY THE ANCHOR: non-matching tiles are skipped', () => {
    // The zone-paint grammar (§16), extended to three modes rather than replaced by a per-tile
    // rule. The rejected alternative — each tile independently losing one layer — would un-till
    // the bare squares and un-plant the growing ones in the same gesture, which is exactly the
    // ambiguity the anchor exists to prevent. So: one rect over four kinds of ground, one mode,
    // and only the tiles that match it move.
    const state = world(1275);
    const spec = cropSpec(CropId.RussetPotato)!;
    const growing = tileAt(state, 4, 5)!;
    plantCrop(state, growing, spec);
    growing.growth = 1;
    const ripe = tileAt(state, 5, 5)!;
    plantCrop(state, ripe, spec);
    ripe.growth = ripe.growthTarget;
    // (7,5) is left bare, and y=3 is grass above the field.
    const seeds = itemCount(state, ItemId.PotatoSeed);
    const touches = state.stats.touches.handCarry;
    const traced = state.trace.length;

    // One drag, anchored (conceptually) on the growing tile, over the whole mixed row plus a
    // strip of grass above it.
    expect(till(state, { x: 4, y: 3, w: 5, h: 3 }, TillMode.Unplant)).toBe(true);

    expect(itemCount(state, ItemId.PotatoSeed), 'both laden crops owed a seed').toBe(seeds + 2);
    expect(growing.crop).toBe(CropId.None);
    expect(ripe.crop).toBe(CropId.None);
    // The bare tile and the grass are untouched — not converted, not destroyed, not charged for.
    expect(isFieldTile(state, 7, 5), 'a bare tile inside the rect was un-tilled').toBe(true);
    expect(isFieldTile(state, 5, 3), 'grass inside an Unplant rect became farmland').toBe(false);
    expect(state.stats.touches.handCarry, 'a mixed drag is one motion').toBe(touches + 1);
    expect(state.trace.length, 'one drag is one trace entry').toBe(traced + 1);
  });

  it('a rect anchored on each of the three states does exactly one of the three', () => {
    // The same rect, three times, over the same mixed row — and each mode touches only its own
    // tiles. This is the property the input layer's anchor rule rests on.
    const spec = cropSpec(CropId.RussetPotato)!;
    const mixed = (seed: number): WorldState => {
      const state = world(seed);
      const planted = tileAt(state, 4, 4)!;
      plantCrop(state, planted, spec);
      planted.growth = 1;
      return state;
    };
    const rect: TileRect = { x: 4, y: 2, w: 3, h: 3 };

    // Till: only the grass at y=2,3 converts; the field row at y=4 is already farm.
    const tilling = mixed(1276);
    expect(till(tilling, rect, TillMode.Till)).toBe(true);
    expect(isFieldTile(tilling, GRASS_X, GRASS_Y)).toBe(true);
    expect(tileAt(tilling, 4, 4)!.crop, 'a Till drag uprooted a crop').toBe(CropId.RussetPotato);

    // Unplant: only the planted tile; the grass and the bare farm tiles are left alone.
    const unplanting = mixed(1277);
    expect(till(unplanting, rect, TillMode.Unplant)).toBe(true);
    expect(tileAt(unplanting, 4, 4)!.crop).toBe(CropId.None);
    expect(isFieldTile(unplanting, GRASS_X, GRASS_Y), 'an Unplant drag broke ground').toBe(false);
    expect(isFieldTile(unplanting, 5, 4), 'an Unplant drag un-tilled a bare neighbour').toBe(true);

    // Untill: only the bare farm tiles; the planted one is left standing.
    const untilling = mixed(1278);
    expect(till(untilling, rect, TillMode.Untill)).toBe(true);
    expect(tileAt(untilling, 5, 4), 'a bare neighbour survived an Untill drag').toBeNull();
    expect(tileAt(untilling, 4, 4)!.crop, 'an Untill drag uprooted a crop').toBe(
      CropId.RussetPotato,
    );
  });

  it('un-plants a REGROWING crop and pays the seed, exactly as a placement does', () => {
    // Cane regrows, so a hand harvest leaves the plant standing and returns no seed.
    // The till uproots it, and the seed is what the plant is worth — `clearFieldTileForMachine`'s
    // rule, reached through a second trigger rather than a second copy of the rule.
    const state = world(1279);
    state.unlocked = [TechId.Cane];
    const spec = cropSpec(CropId.SugarCane)!;
    const tile = tileAt(state, 6, 6)!;
    plantCrop(state, tile, spec);
    tile.growth = tile.growthTarget;

    expect(tillOne(state, 6, 6, TillMode.Unplant)).toBe(true);
    expect(itemCount(state, ItemId.SugarCane), 'the ripe cane vanished').toBeGreaterThan(0);
    expect(itemCount(state, ItemId.CaneSeed), 'the uprooted plant paid nothing back').toBe(1);
    expect(tileAt(state, 6, 6)!.crop).toBe(CropId.None);
  });

  it('keeps a field-placed machine’s floor, exactly as an Untill drag does', () => {
    const state = world(1280);
    state.moneyCents = 1_000_000;
    expect(spawnMachine(state, MachineKind.Sprinkler, 7, 7)).not.toBeNull();
    const under = tileAt(state, 7, 7)!;
    plantCrop(state, under, cropSpec(CropId.RussetPotato)!);
    const seeds = itemCount(state, ItemId.PotatoSeed);

    expect(tillOne(state, 7, 7, TillMode.Unplant), 'the till reached under the machine').toBe(
      false,
    );
    expect(itemCount(state, ItemId.PotatoSeed)).toBe(seeds);
    expect(under.crop).toBe(CropId.RussetPotato);
  });

  it('refuses a mode it has never heard of, rather than guessing at one', () => {
    const state = world(1281);
    const traced = state.trace.length;
    plantCrop(state, tileAt(state, 6, 6)!, cropSpec(CropId.RussetPotato)!);
    step(state, {
      tick: state.tick,
      commands: [
        { type: 'TillTile', rect: { x: 6, y: 6, w: 1, h: 1 }, mode: 'harrow' as TillMode },
      ],
    });
    expect(tileAt(state, 6, 6)!.crop, 'an unknown mode fell through to a real one').toBe(
      CropId.RussetPotato,
    );
    expect(state.trace.length).toBe(traced);
  });

  it('**NOTHING CAN VANISH FOR WANT OF ROOM, BECAUSE THE BAG HAS NO BOTTOM**', () => {
    // Work item 127 asks for "a full bag refuses the un-plant rather than destroying the crop",
    // and that refusal is UNWRITABLE — the same wall item 121 hit. `addItem` has been unbounded
    // since item 068 struck the armful cap, so there is no reachable state in which a returned
    // crop has nowhere to go. Pinned as an executed statement rather than left as an assumption,
    // because the day somebody adds a cap this hand-back silently becomes a deletion.
    const state = world(1282);
    addItem(state, ItemId.RussetPotato, 1_000_000);
    expect(itemCount(state, ItemId.RussetPotato), 'the bag turned goods away').toBe(1_000_000);

    const spec = cropSpec(CropId.RussetPotato)!;
    const tile = tileAt(state, 6, 6)!;
    plantCrop(state, tile, spec);
    tile.growth = tile.growthTarget;
    const before = itemCount(state, ItemId.RussetPotato);

    expect(tillOne(state, 6, 6, TillMode.Unplant), 'a laden bag refused the un-plant').toBe(true);
    expect(
      itemCount(state, ItemId.RussetPotato),
      'the crop was destroyed rather than added to a bag that was already enormous',
    ).toBeGreaterThan(before);
  });
});
