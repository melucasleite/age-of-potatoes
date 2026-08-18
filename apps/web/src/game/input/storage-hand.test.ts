// Item 105, the input half: the hand verb for a box, and the sentence it says on hover.
//
// THE BUG THIS PINS PRODUCED NO ERROR OF ANY KIND. Clicking a $250 Root Cellar built no command
// — not a refused one, an absent one — because the sim's `outputCount` stayed 0 and the client's
// recipe table has no row for a machine with no recipe. So every assertion below is about a
// SILENCE, and the two that matter most are:
//
//   · THE COMMAND NAMES THE ITEM. `applyLoadMachine` refuses a `LoadMachine` at a box that names
//     nothing, deliberately and permanently — a box has no recipe to guess from. An unnamed load
//     is byte-identical to the bug.
//   · THE ROLE, NOT THE KIND. Every structural case runs twice, over the Root Cellar and the $80
//     Hand Cart, from one table — so a special-cased kind shows up as one row disagreeing with
//     the other. That is the whole test that the fix went in the right place.

import { describe, expect, it } from 'vitest';
import {
  IntentAction,
  ItemId,
  MachineKind,
  SUBTILE,
  TECH_NODES,
  addItem,
  createWorld,
  createWorldView,
  itemCount,
  machineHoppers,
  machineSpec,
  step,
  view,
} from '@snack/sim';
import type { Command, WorldState, WorldView } from '@snack/sim';

import { machineTell, primaryCommand, reachAdjusted } from './pointer';
import { ToolMode } from './tools';

const BOXES = [
  { name: 'Root Cellar', kind: MachineKind.RootCellar },
  { name: 'Hand Cart', kind: MachineKind.HandCart },
] as const;

const CAPACITY: Readonly<Record<number, number>> = {
  [MachineKind.RootCellar]: machineSpec(MachineKind.RootCellar)!.inputCapacity,
  [MachineKind.HandCart]: machineSpec(MachineKind.HandCart)!.inputCapacity,
};

function standingOn(tileX: number, tileY: number): WorldView {
  const v = createWorldView();
  v.player.xSub = tileX * SUBTILE + SUBTILE / 2;
  v.player.ySub = tileY * SUBTILE + SUBTILE / 2;
  v.land.owned.push(0);
  return v;
}

/**
 * `recipe` and `inputCapacity` are derived rather than omitted, exactly as `projectRecipe`
 * would publish them for an empty machine (item 111): the hand's load branch reads the
 * machine's hoppers now instead of a table of machine kinds, so a literal without them is a
 * `MachineView` the sim could never emit. A box has no hoppers and gets `[]`, which is the
 * whole point of the two Washer cases at the foot of this file — they are the control.
 */
function withMachine(
  v: WorldView,
  tileX: number,
  tileY: number,
  kind: number,
  cargoItem = 0,
  cargoCount = 0,
): WorldView {
  const spec = machineSpec(kind as MachineKind);
  v.machines.push({
    id: 1,
    kind,
    tileX,
    tileY,
    tilesWide: 1,
    tilesHigh: 1,
    cargoItem,
    cargoCount,
    outputCount: 0,
    inputCapacity: spec === null ? 0 : spec.inputCapacity,
    recipe:
      spec === null
        ? []
        : machineHoppers(spec).map((line) => ({
            item: line.item,
            perOperation: line.count,
            count: 0,
          })),
  } as WorldView['machines'][number]);
  return v;
}

function withItem(v: WorldView, item: number, count: number, boxedMachineKind = 0): WorldView {
  v.inventory.push({
    item,
    count,
    sellable: boxedMachineKind === 0 ? 1 : 0,
    boxedMachineKind,
    boxes: [],
  } as WorldView['inventory'][number]);
  return v;
}

/** The Hand's click on the tile the machine stands on. */
function click(v: WorldView, tileX = 4, tileY = 5): Command | null {
  return primaryCommand(v, { tileX, tileY }, ToolMode.Hand, 0 as never);
}

describe.each(BOXES)('the hand at a $name', ({ kind }) => {
  it('puts the biggest stack in when it is empty, and names the item', () => {
    const v = withItem(
      withItem(withMachine(standingOn(4, 4), 4, 5, kind), ItemId.RussetPotato, 20),
      ItemId.PlainChips,
      5,
    );
    expect(click(v)).toEqual({
      type: 'LoadMachine',
      machineId: 1,
      count: 20,
      item: ItemId.RussetPotato,
    });
  });

  it('tops up what it already holds rather than raiding it', () => {
    const v = withItem(
      withMachine(standingOn(4, 4), 4, 5, kind, ItemId.RussetPotato, 4),
      ItemId.RussetPotato,
      9,
    );
    expect(click(v)).toEqual({
      type: 'LoadMachine',
      machineId: 1,
      count: 9,
      item: ItemId.RussetPotato,
    });
  });

  it('empties it — all of it — when your hands are empty', () => {
    const v = withMachine(standingOn(4, 4), 4, 5, kind, ItemId.RussetPotato, 7);
    expect(click(v)).toEqual({ type: 'UnloadMachine', machineId: 1, count: 7 });
  });

  it('empties it when you are carrying something else, since a box holds one product', () => {
    const v = withItem(
      withMachine(standingOn(4, 4), 4, 5, kind, ItemId.RussetPotato, 7),
      ItemId.Corn,
      30,
    );
    expect(click(v)).toEqual({ type: 'UnloadMachine', machineId: 1, count: 7 });
  });

  it('empties a FULL one even while you hold more of the same', () => {
    const full = CAPACITY[kind]!;
    const v = withItem(
      withMachine(standingOn(4, 4), 4, 5, kind, ItemId.RussetPotato, full),
      ItemId.RussetPotato,
      9,
    );
    expect(click(v)).toEqual({ type: 'UnloadMachine', machineId: 1, count: full });
  });

  it('says nothing at all when the box is empty and so are you', () => {
    expect(click(withMachine(standingOn(4, 4), 4, 5, kind))).toBeNull();
  });

  it('never stuffs a boxed machine into it — that box has its own verb', () => {
    const v = withItem(
      withMachine(standingOn(4, 4), 4, 5, kind),
      ItemId.BoxedFryer,
      2,
      MachineKind.Fryer,
    );
    expect(click(v)).toBeNull();
  });

  it('walks there first from across the lot, carrying the item AND the count', () => {
    const v = withItem(withMachine(standingOn(1, 1), 14, 14, kind), ItemId.RussetPotato, 20);
    const direct = primaryCommand(v, { tileX: 14, tileY: 14 }, ToolMode.Hand, 0 as never)!;
    expect(reachAdjusted(v, { tileX: 14, tileY: 14 }, direct)).toEqual({
      type: 'WalkAndAct',
      action: IntentAction.Load,
      tileX: 14,
      tileY: 14,
      item: ItemId.RussetPotato,
      count: 20,
    });
  });

  it('says what it holds on hover, empty or stocked', () => {
    const slug = machineSpec(kind)!.slug.split('-').join(' ');
    const capacity = CAPACITY[kind]!;

    const empty = withMachine(standingOn(4, 4), 4, 5, kind);
    expect(machineTell(empty, { tileX: 4, tileY: 5 })).toBe(`${slug} — empty, ${capacity} slots`);

    const stocked = withMachine(standingOn(4, 4), 4, 5, kind, ItemId.RussetPotato, 12);
    expect(machineTell(stocked, { tileX: 4, tileY: 5 })).toBe(
      `${slug} — 12 of ${capacity} russet potato`,
    );
  });
});

// --- against the real sim ------------------------------------------------------------------
//
// The criterion is not "the command is shaped right" — it is GOODS GO IN AND COME BACK OUT. So
// this block places a real box in a real world and clicks it with the client's own code, in
// reach and from across the lot. `belt-run.test.ts` makes the argument for the shape.

/** A funded, fully researched world with a box on clear ground and potatoes in the bag. */
function lotWithBox(kind: number): { state: WorldState; tileX: number; tileY: number } {
  const state = createWorld(4242);
  state.moneyCents = 10_000_000;
  state.unlocked = TECH_NODES.map((node) => node.id);
  addItem(state, ItemId.RussetPotato, 20);

  const spec = machineSpec(kind as MachineKind)!;
  for (let y = 1; y < 60; y++) {
    for (let x = 1; x < 60; x++) {
      state.player.xSub = (x - 1) * SUBTILE + SUBTILE / 2;
      state.player.ySub = y * SUBTILE + SUBTILE / 2;
      const before = state.machines.length;
      step(state, {
        tick: state.tick,
        commands: [{ type: 'PlaceMachine', kind: kind as MachineKind, tileX: x, tileY: y }],
      });
      if (state.machines.length === before) continue;
      // REACH IS MEASURED TO THE FOOTPRINT'S CENTRE, so the tile beside a 2×2 cellar's ANCHOR is
      // out of arm's length while the same tile beside a 1×1 cart is not. Standing at the centre
      // keeps the two rows of this table comparing the verb rather than the geometry.
      state.player.xSub = Math.round((x + spec.tilesWide / 2) * SUBTILE);
      state.player.ySub = Math.round((y + spec.tilesHigh / 2) * SUBTILE);
      return { state, tileX: x, tileY: y };
    }
  }
  throw new Error('nowhere to put a box');
}

describe.each(BOXES)('a real $name on a real lot', ({ kind }) => {
  it('takes the armful in, and hands it back on the next click', () => {
    const { state, tileX, tileY } = lotWithBox(kind);
    const buffer = createWorldView();

    const loaded = primaryCommand(
      view(state, buffer),
      { tileX, tileY },
      ToolMode.Hand,
      0 as never,
    )!;
    step(state, { tick: state.tick, commands: [loaded] });
    const box = state.machines.find((m) => m.tileX === tileX && m.tileY === tileY)!;
    expect(box.cargoItem).toBe(ItemId.RussetPotato);
    expect(box.cargoCount).toBe(20);
    expect(itemCount(state, ItemId.RussetPotato)).toBe(0);

    const emptied = primaryCommand(
      view(state, buffer),
      { tileX, tileY },
      ToolMode.Hand,
      0 as never,
    )!;
    step(state, { tick: state.tick, commands: [emptied] });
    expect(box.cargoCount).toBe(0);
    expect(itemCount(state, ItemId.RussetPotato)).toBe(20);
  });

  it('walks there and loads when the click comes from across the lot', () => {
    const { state, tileX, tileY } = lotWithBox(kind);
    const buffer = createWorldView();
    // Far enough to need the errand, close enough that the walk finishes inside the budget.
    state.player.xSub = (tileX + 8) * SUBTILE + SUBTILE / 2;
    state.player.ySub = tileY * SUBTILE + SUBTILE / 2;

    const projection = view(state, buffer);
    const direct = primaryCommand(projection, { tileX, tileY }, ToolMode.Hand, 0 as never)!;
    const errand = reachAdjusted(projection, { tileX, tileY }, direct);
    expect(errand.type).toBe('WalkAndAct');
    step(state, { tick: state.tick, commands: [errand] });

    for (let i = 0; i < 600; i++) step(state, { tick: state.tick, commands: [] });

    const box = state.machines.find((m) => m.tileX === tileX && m.tileY === tileY)!;
    expect(box.cargoCount).toBe(20);
    expect(box.cargoItem).toBe(ItemId.RussetPotato);
  });
});

describe('the machines that are not boxes are untouched', () => {
  it('still loads a Washer from the recipe, with no item named', () => {
    const v = withItem(
      withMachine(standingOn(4, 4), 4, 5, MachineKind.Washer),
      ItemId.RussetPotato,
      6,
    );
    expect(click(v)).toEqual({ type: 'LoadMachine', machineId: 1, count: 6 });
  });

  it('sends a Washer errand with item 0, exactly as it always did', () => {
    const v = withItem(
      withMachine(standingOn(1, 1), 14, 14, MachineKind.Washer),
      ItemId.RussetPotato,
      6,
    );
    const direct = primaryCommand(v, { tileX: 14, tileY: 14 }, ToolMode.Hand, 0 as never)!;
    expect(reachAdjusted(v, { tileX: 14, tileY: 14 }, direct)).toMatchObject({
      action: IntentAction.Load,
      item: 0,
      count: 6,
    });
  });

  it('has nothing extra to say about a Washer on hover', () => {
    const v = withMachine(standingOn(4, 4), 4, 5, MachineKind.Washer);
    expect(machineTell(v, { tileX: 4, tileY: 5 })).toBeNull();
  });
});
