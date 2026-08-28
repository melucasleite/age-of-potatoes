// Item 103: the hand-plant verb sows the crop the player armed, and the dial can reach the
// whole roster — two crops since [[145]] cut corn, chili and the gold potato.
//
// WHAT FAILS QUIETLY HERE, which is the only reason any of this is pinned (AGENTS.md):
//
//   · A CONSTANT CREEPING BACK INTO `PlantTile`. That is the bug itself — `crop: V01_CROP`
//     threw nothing, refused nothing and simply planted a Russet for the whole of v0.2 while
//     four researched crops sat in the bag. A future "sensible default" would be silent in
//     exactly the same way, so the command's crop is asserted per crop rather than per shape.
//   · THE FAR HALF OF A DRAG COMING UP A DIFFERENT PLANT. The hold and the out-of-reach work
//     queue both RE-DERIVE their commands from `primaryCommand`, so each carries the crop the
//     press committed to; if either ever lost it the near tiles would be cane and the far ones
//     potatoes, in one gesture, with nothing on screen to say so.
//   · A CROP FALLING OUT OF THE CYCLE. The Gold Potato was missing from `CROP_CYCLE` and was
//     therefore unreachable everywhere in the game at once — `C`, zones, and the planter bot
//     that reads `zone.crop`. The cycle is driven for real here rather than eyeballed.

import { describe, expect, it } from 'vitest';
import {
  CropId,
  Direction,
  IntentAction,
  ItemId,
  SUBTILE,
  TechId,
  addItem,
  createWorld,
  createWorldView,
  isFieldTile,
  step,
  tileAt,
  view,
} from '@snack/sim';
import type { Command, WorldState, WorldView } from '@snack/sim';

import { firstRunSigns } from './first-run';
import {
  createHold,
  createWorkQueue,
  holdCommand,
  plantBand,
  primaryCommand,
  reachAdjusted,
} from './pointer';
import { nextCrop } from './system';
import { DEFAULT_CROP, ToolMode } from './tools';

const ALL_CROPS: readonly CropId[] = [CropId.RussetPotato, CropId.SugarCane];

const ALL_TECH: readonly string[] = [TechId.Cane];

/** Seed item per crop, from the sim's own table — never a second list over here. */
const SEEDS: Readonly<Record<number, number>> = {
  [CropId.RussetPotato]: ItemId.PotatoSeed,
  [CropId.SugarCane]: ItemId.CaneSeed,
};

function standingOn(tileX: number, tileY: number): WorldView {
  const view = createWorldView();
  view.player.xSub = tileX * SUBTILE + SUBTILE / 2;
  view.player.ySub = tileY * SUBTILE + SUBTILE / 2;
  view.land.owned.push(0);
  return view;
}

/** Farmland at exactly these tiles, in the row-major world order the picker binary-searches. */
function withFieldTiles(view: WorldView, tiles: readonly (readonly [number, number])[]): WorldView {
  const sorted = [...tiles].sort(
    (a, b) => a[1] * view.worldTilesWide + a[0] - (b[1] * view.worldTilesWide + b[0]),
  );
  view.field.count = sorted.length;
  sorted.forEach(([x, y], i) => {
    view.field.tileX[i] = x;
    view.field.tileY[i] = y;
  });
  return view;
}

function withItem(view: WorldView, item: number, count: number): WorldView {
  view.inventory.push({
    item,
    count,
    sellable: 1,
    boxedMachineKind: 0,
    boxes: [],
  } as WorldView['inventory'][number]);
  return view;
}

describe('the hand plants what is armed ([[103]])', () => {
  it.each(ALL_CROPS)('sows crop %i rather than a Russet', (crop) => {
    const view = standingOn(4, 4);
    expect(
      primaryCommand(view, { tileX: 4, tileY: 5 }, ToolMode.Plant, Direction.None, crop),
    ).toEqual({ type: 'PlantTile', tileX: 4, tileY: 5, crop });
  });

  it('carries the armed crop through an out-of-reach click, as the errand’s item', () => {
    const view = standingOn(1, 1);
    const direct = primaryCommand(
      view,
      { tileX: 14, tileY: 14 },
      ToolMode.Plant,
      Direction.None,
      CropId.SugarCane,
    )!;
    expect(reachAdjusted(view, { tileX: 14, tileY: 14 }, direct)).toEqual({
      type: 'WalkAndAct',
      action: IntentAction.Plant,
      tileX: 14,
      tileY: 14,
      item: CropId.SugarCane,
      count: 0,
    });
  });

  it('defaults to the starter crop when nobody names one — the one place a default is right', () => {
    const view = standingOn(4, 4);
    const command = primaryCommand(view, { tileX: 4, tileY: 5 }, ToolMode.Plant, Direction.None);
    expect(command).toEqual({ type: 'PlantTile', tileX: 4, tileY: 5, crop: DEFAULT_CROP });
  });
});

describe('a gesture keeps the crop it started with', () => {
  it('freezes the hold’s crop at the press, so C mid-row cannot split a furrow', () => {
    const view = withFieldTiles(standingOn(4, 4), [
      [4, 4],
      [4, 5],
    ]);
    const pressed: Command = { type: 'PlantTile', tileX: 4, tileY: 4, crop: CropId.SugarCane };
    const hold = createHold(1, 0, 0, view, { tileX: 4, tileY: 4 }, ToolMode.Plant, pressed);
    expect(hold.crop).toBe(CropId.SugarCane);
    expect(holdCommand(view, hold, { tileX: 4, tileY: 5 })).toEqual({
      type: 'PlantTile',
      tileX: 4,
      tileY: 5,
      crop: CropId.SugarCane,
    });
  });

  it('reads the queue’s crop off a walk-to-plant errand, where it rides as `item`', () => {
    const view = standingOn(1, 1);
    const dispatched: Command = {
      type: 'WalkAndAct',
      action: IntentAction.Plant,
      tileX: 14,
      tileY: 14,
      item: CropId.SugarCane,
      count: 0,
    };
    expect(createWorkQueue(view, ToolMode.Plant, dispatched).crop).toBe(CropId.SugarCane);
  });

  it('leaves a water queue on the default crop rather than inventing one', () => {
    const view = standingOn(1, 1);
    const dispatched: Command = { type: 'WaterTile', tileX: 2, tileY: 2 };
    expect(createWorkQueue(view, ToolMode.Water, dispatched).crop).toBe(DEFAULT_CROP);
  });
});

describe('the C dial ([[103]]: the Gold Potato was not in it)', () => {
  it('reaches every crop in the game once everything is researched', () => {
    const seen = new Set<number>();
    let crop: CropId = DEFAULT_CROP;
    seen.add(crop);
    for (let i = 0; i < 200; i++) {
      crop = nextCrop(crop, ALL_TECH);
      seen.add(crop);
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([...ALL_CROPS].sort((a, b) => a - b));
  });

  it('skips what is not researched — an unresearched crop cannot be armed', () => {
    // Holding cane with the node unresearched, C escapes back to the Russet rather than
    // standing on a crop the reducer would refuse.
    expect(nextCrop(CropId.SugarCane, [])).toBe(CropId.RussetPotato);
  });

  it('stands still on a fresh save, where the Russet is the only thing there is', () => {
    expect(nextCrop(CropId.RussetPotato, [])).toBe(CropId.RussetPotato);
  });
});

describe('the plant ghost says which crop, before the button goes down', () => {
  const field = (crop: CropId, seeds: number): WorldView => {
    const view = withFieldTiles(standingOn(4, 4), [[4, 5]]);
    return seeds > 0 ? withItem(view, SEEDS[crop]!, seeds) : view;
  };

  it('names the armed crop and advertises the key', () => {
    const view = field(CropId.SugarCane, 5);
    expect(plantBand(view, { tileX: 4, tileY: 5 }, CropId.SugarCane)).toMatchObject({
      tone: 'zone',
      label: 'Sugar Cane · C to change',
    });
  });

  it('goes red with the reason when the bag has no seed — the sim refuses that click silently', () => {
    const view = field(CropId.SugarCane, 0);
    expect(plantBand(view, { tileX: 4, tileY: 5 }, CropId.SugarCane)).toMatchObject({
      tone: 'blocked',
      label: 'Sugar Cane · no seed in the bag',
    });
  });

  it('says till it first on bare grass, and already planted on a taken tile', () => {
    const grass = withItem(standingOn(4, 4), ItemId.PotatoSeed, 5);
    expect(plantBand(grass, { tileX: 4, tileY: 5 }, CropId.RussetPotato).label).toBe(
      'Russet Potato · till it first',
    );

    const taken = field(CropId.RussetPotato, 5);
    taken.field.crop[0] = CropId.RussetPotato;
    expect(plantBand(taken, { tileX: 4, tileY: 5 }, CropId.RussetPotato).label).toBe(
      'Russet Potato · already planted',
    );
  });

  it('names every crop on the roster — [[103]]: an unnamed crop is an unannouncable one', () => {
    const names: Readonly<Record<number, string>> = {
      [CropId.RussetPotato]: 'Russet Potato',
      [CropId.SugarCane]: 'Sugar Cane',
    };
    for (const crop of ALL_CROPS) {
      const view = field(crop, 1);
      expect(plantBand(view, { tileX: 4, tileY: 5 }, crop).label).toContain(names[crop]!);
    }
  });
});

describe('the first-run sign no longer promises potatoes', () => {
  it('names whatever crop is armed', () => {
    const view = standingOn(4, 4);
    const signs = firstRunSigns(view, () => '3', CropId.SugarCane);
    expect(signs[0]?.body).toBe('press 3, click the dirt — sugar cane');
  });

  it('still says russet potato on a brand-new save, because that is what is armed', () => {
    const view = standingOn(4, 4);
    expect(firstRunSigns(view, () => '3')[0]?.body).toBe('press 3, click the dirt — russet potato');
  });
});

// --- against the real sim ------------------------------------------------------------------
//
// The item's headline criterion is not "the command has the right field" — it is A CROP THAT IS
// NOT A POTATO ENDS UP IN THE GROUND. So the last test drives the reducer: the client's own
// click, through `step`, onto a real world, once per crop. `belt-run.test.ts` makes the argument
// for this shape — a claim the input layer makes ABOUT the sim is worth asking the sim.

/** A researched world with one seed of `crop`, the farmer standing on a tilled tile. */
function readyToSow(crop: CropId): { state: WorldState; tileX: number; tileY: number } {
  const state = createWorld(4242);
  state.unlocked = [...ALL_TECH];
  addItem(state, SEEDS[crop]! as ItemId, 1);

  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      if (!isFieldTile(state, x, y)) continue;
      const tile = tileAt(state, x, y)!;
      if (tile.crop !== CropId.None) continue;
      state.player.xSub = x * SUBTILE + SUBTILE / 2;
      state.player.ySub = y * SUBTILE + SUBTILE / 2;
      return { state, tileX: x, tileY: y };
    }
  }
  throw new Error('no empty farmland on a fresh lot');
}

describe('a crop that is not a potato ends up in the ground', () => {
  it.each(ALL_CROPS)('sows crop %i through the client’s own click', (crop) => {
    const { state, tileX, tileY } = readyToSow(crop);
    const seeds = (): number => state.inventory.find((s) => s.item === SEEDS[crop])?.count ?? 0;
    const before = seeds();
    const projection = view(state, createWorldView());

    const command = primaryCommand(
      projection,
      { tileX, tileY },
      ToolMode.Plant,
      Direction.None,
      crop,
    )!;
    step(state, { tick: state.tick, commands: [command] });

    expect(tileAt(state, tileX, tileY)!.crop).toBe(crop);
    // The seed came out of the bag, which is the half that makes the stand matter. Counted as a
    // difference because a fresh lot already ships with potato seeds in it.
    expect(seeds()).toBe(before - 1);
  });

  it('refuses a crop whose node is not researched, spending no seed', () => {
    const { state, tileX, tileY } = readyToSow(CropId.SugarCane);
    state.unlocked = [];
    const projection = view(state, createWorldView());
    const command = primaryCommand(
      projection,
      { tileX, tileY },
      ToolMode.Plant,
      Direction.None,
      CropId.SugarCane,
    )!;
    step(state, { tick: state.tick, commands: [command] });

    expect(tileAt(state, tileX, tileY)!.crop).toBe(CropId.None);
    expect(state.inventory.find((s) => s.item === ItemId.CaneSeed)?.count ?? 0).toBe(1);
  });
});
