// Item 104: the bag of fertilizer gets a verb, and the soil gets a number the player can read.
//
// WHAT FAILS QUIETLY, and why each of these is worth a line:
//
//   · A CONSUMABLE WITH NO CURSOR IS INVISIBLE. `ApplyFertilizer` had zero emitters in this app
//     — no `ToolMode`, no `reachAdjusted` row, and `itemPlaceTool` returning -1 so the hotbar
//     REFUSED the bag with a flash. Nothing threw; the item simply could not be used, for the
//     whole life of the $120 node that makes it.
//   · A WALK-TO VERB THAT ONLY WORKS AT ARM'S LENGTH. Shipping the in-reach case alone is the
//     classic half-fix here: the click looks armed, the band is green, and standing anywhere
//     else does nothing at all. `IntentAction.Fertilize` is pinned by payload, because a wrong
//     action walks the farmer the whole way over and then does something else.
//   · A READOUT THAT DRIFTS FROM THE WORLD. The last two tests drive the REAL sim — the same
//     shape `belt-run.test.ts` argues for — so the tell is checked against a tile whose
//     fertility the reducer actually changed, rather than against a hand-built view.

import { describe, expect, it } from 'vitest';
import {
  FERTILITY_MAX,
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

import { Hotbar, itemPlaceTool } from './hotbar';
import { fertilizerBand, primaryCommand, reachAdjusted, soilStars, soilTell } from './pointer';
import { ToolMode, gestureFor } from './tools';

function standingOn(tileX: number, tileY: number): WorldView {
  const v = createWorldView();
  v.player.xSub = tileX * SUBTILE + SUBTILE / 2;
  v.player.ySub = tileY * SUBTILE + SUBTILE / 2;
  v.land.owned.push(0);
  return v;
}

function withFieldTile(v: WorldView, tileX: number, tileY: number, fertility: number): WorldView {
  v.field.count = 1;
  v.field.tileX[0] = tileX;
  v.field.tileY[0] = tileY;
  v.field.fertility[0] = fertility;
  return v;
}

function withItem(v: WorldView, item: number, count: number): WorldView {
  v.inventory.push({
    item,
    count,
    sellable: 1,
    boxedMachineKind: 0,
    boxes: [],
    ticksToSpoil: -1,
    spoilingCount: 0,
  } as WorldView['inventory'][number]);
  return v;
}

describe('the bag reaches the hand', () => {
  it('resolves to the fertilizer cursor, which is what the hotbar asks before it accepts a drop', () => {
    expect(itemPlaceTool(ItemId.Fertilizer)).toBe(ToolMode.ApplyFertilizer);
  });

  it('can be assigned to a slot — the drop used to flash and refuse', () => {
    const bar = new Hotbar(() => null);
    expect(bar.assignItem(7, ItemId.Fertilizer)).toBe(true);
    expect(bar.entryAt(7)).toEqual({ kind: 'item', item: ItemId.Fertilizer });
  });

  it('is a click and not a paint — one bag is one tile', () => {
    expect(gestureFor(ToolMode.ApplyFertilizer)).toBe('click');
  });
});

describe('the verb', () => {
  it('builds ApplyFertilizer for the clicked tile', () => {
    const v = standingOn(4, 4);
    expect(primaryCommand(v, { tileX: 4, tileY: 5 }, ToolMode.ApplyFertilizer, 0 as never)).toEqual(
      { type: 'ApplyFertilizer', tileX: 4, tileY: 5 },
    );
  });

  it('walks first when the tile is out of reach, carrying the Fertilize intent', () => {
    const v = standingOn(1, 1);
    const direct: Command = { type: 'ApplyFertilizer', tileX: 14, tileY: 14 };
    expect(reachAdjusted(v, { tileX: 14, tileY: 14 }, direct)).toEqual({
      type: 'WalkAndAct',
      action: IntentAction.Fertilize,
      tileX: 14,
      tileY: 14,
      item: 0,
      count: 0,
    });
  });

  it('emits the direct command in reach, rather than walking a zero-length errand', () => {
    const v = standingOn(4, 4);
    const direct: Command = { type: 'ApplyFertilizer', tileX: 4, tileY: 4 };
    expect(reachAdjusted(v, { tileX: 4, tileY: 4 }, direct)).toBe(direct);
  });
});

describe('the ghost under the cursor', () => {
  it('shows the step the bag would buy, and how many are left', () => {
    const v = withItem(withFieldTile(standingOn(4, 4), 4, 5, 1), ItemId.Fertilizer, 3);
    expect(fertilizerBand(v, { tileX: 4, tileY: 5 })).toMatchObject({
      tone: 'zone',
      label: '★☆☆ → ★★☆ · 3 left',
    });
  });

  it('refuses rich soil, an empty bag and bare grass, each with its reason', () => {
    const rich = withItem(
      withFieldTile(standingOn(4, 4), 4, 5, FERTILITY_MAX),
      ItemId.Fertilizer,
      3,
    );
    expect(fertilizerBand(rich, { tileX: 4, tileY: 5 })).toMatchObject({
      tone: 'blocked',
      label: 'fertilizer · this soil is already rich',
    });

    const empty = withFieldTile(standingOn(4, 4), 4, 5, 1);
    expect(fertilizerBand(empty, { tileX: 4, tileY: 5 }).label).toBe(
      'fertilizer · no fertilizer in the bag',
    );

    const grass = withItem(standingOn(4, 4), ItemId.Fertilizer, 3);
    expect(fertilizerBand(grass, { tileX: 4, tileY: 5 }).label).toBe(
      'fertilizer · only farmland takes it',
    );
  });
});

describe('the soil readout', () => {
  it('says nothing off the field — there is no soil to report', () => {
    expect(soilTell(standingOn(4, 4), { tileX: 4, tileY: 5 })).toBeNull();
  });

  it('reads on BARE farmland, which is the tile the decision is about', () => {
    const v = withFieldTile(standingOn(4, 4), 4, 5, 2);
    expect(soilTell(v, { tileX: 4, tileY: 5 })).toBe('soil ★★☆');
  });

  it('names the two ends: worn thin and rich', () => {
    const thin = withFieldTile(standingOn(4, 4), 4, 5, 1);
    expect(soilTell(thin, { tileX: 4, tileY: 5 })).toBe('soil ★☆☆ — worn thin');
    const rich = withFieldTile(standingOn(4, 4), 4, 5, FERTILITY_MAX);
    expect(soilTell(rich, { tileX: 4, tileY: 5 })).toBe('soil ★★★ — rich');
  });

  it('draws exactly FERTILITY_MAX stars, filled and hollow', () => {
    expect(soilStars(0)).toBe('☆'.repeat(FERTILITY_MAX));
    expect(soilStars(FERTILITY_MAX)).toBe('★'.repeat(FERTILITY_MAX));
    expect(soilStars(99)).toBe('★'.repeat(FERTILITY_MAX));
  });
});

// --- against the real sim ----------------------------------------------------------------

/** A world with the composting node and bags in the bag, standing on a worn farm tile. */
function wornWorld(): { state: WorldState; tileX: number; tileY: number } {
  const state = createWorld(4242);
  state.unlocked = [TechId.Composting];
  addItem(state, ItemId.Fertilizer, 5);

  // The first farm tile the lot happens to have — searched for rather than hard-coded, since
  // the starting field moves between releases.
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      if (!isFieldTile(state, x, y)) continue;
      const tile = tileAt(state, x, y)!;
      tile.fertility = 1;
      tile.fertilityWear = 3;
      state.player.xSub = x * SUBTILE + SUBTILE / 2;
      state.player.ySub = y * SUBTILE + SUBTILE / 2;
      return { state, tileX: x, tileY: y };
    }
  }
  throw new Error('no farmland on a fresh lot');
}

describe('the readout and the world agree', () => {
  it('changes visibly when a bag goes in, through the client’s own click', () => {
    const { state, tileX, tileY } = wornWorld();
    const buffer = createWorldView();

    const before = view(state, buffer);
    expect(soilTell(before, { tileX, tileY })).toBe('soil ★☆☆ — worn thin');

    const click = primaryCommand(before, { tileX, tileY }, ToolMode.ApplyFertilizer, 0 as never)!;
    step(state, { tick: state.tick, commands: [reachAdjusted(before, { tileX, tileY }, click)] });

    const after = view(state, buffer);
    expect(soilTell(after, { tileX, tileY })).toBe('soil ★★☆');
    // The bag was spent, and the wear counter reset — the reducer's whole promise.
    expect(tileAt(state, tileX, tileY)!.fertilityWear).toBe(0);
  });

  it('walks the farmer over and works the bag in when the click was out of reach', () => {
    const { state, tileX, tileY } = wornWorld();
    const buffer = createWorldView();
    // Eight tiles east: far enough to need the errand, near enough to arrive in the budget.
    state.player.xSub = (tileX + 8) * SUBTILE + SUBTILE / 2;
    state.player.ySub = tileY * SUBTILE + SUBTILE / 2;

    const projection = view(state, buffer);
    const click = primaryCommand(
      projection,
      { tileX, tileY },
      ToolMode.ApplyFertilizer,
      0 as never,
    )!;
    const errand = reachAdjusted(projection, { tileX, tileY }, click);
    expect(errand).toMatchObject({ type: 'WalkAndAct', action: IntentAction.Fertilize });

    step(state, { tick: state.tick, commands: [errand] });
    for (let i = 0; i < 600; i++) step(state, { tick: state.tick, commands: [] });

    expect(tileAt(state, tileX, tileY)!.fertility).toBe(2);
    expect(soilTell(view(state, buffer), { tileX, tileY })).toBe('soil ★★☆');
  });
});
