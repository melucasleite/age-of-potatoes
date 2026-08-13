// The cheap structural gate for the reach fallback.
//
// Verification here is deliberately light (AGENTS.md: "if it works, it works"), so this pins
// only the things that fail QUIETLY — the ones where the game keeps running and nobody sees
// a stack trace:
//
//   · AN IN-REACH CLICK STILL EMITS THE DIRECT COMMAND. A regression to always-walk throws
//     nothing and breaks nothing; it just makes every single click in the game arrive a tick
//     late through the errand loop, which reads as input lag and gets blamed on the browser.
//   · AN OUT-OF-REACH CLICK CARRIES THE RIGHT VERB AND PAYLOAD. A wrong `IntentAction` is the
//     worst case in the file: the farmer dutifully walks the whole way over and then does
//     something else entirely. A dropped `crop` plants nothing; a dropped `count` sells one
//     potato instead of nine. All three are silent.
//
// `reachAdjusted` is pure and takes the projection as an argument, so the player's position
// is just a field to assign. No DOM, no camera, no Pixi, nothing mocked.

import { describe, expect, it } from 'vitest';
import {
  CropId,
  Direction,
  IntentAction,
  ItemId,
  MachineKind,
  SUBTILE,
  createWorldView,
} from '@snack/sim';
import type { Command, WorldView } from '@snack/sim';

import { bestSellable, counterPanelFor, primaryCommand, reachAdjusted } from './pointer';
import { ToolMode } from './tools';

/** Stand the farmer on the centre of a tile. Reach is measured from tile centres. */
function standingOn(tileX: number, tileY: number): WorldView {
  const view = createWorldView();
  view.player.xSub = tileX * SUBTILE + SUBTILE / 2;
  view.player.ySub = tileY * SUBTILE + SUBTILE / 2;
  return view;
}

/**
 * A machine occupying one tile. `reachAdjusted` finds it the same way a click does — by
 * asking `tileAtView` what covers the clicked tile — so it only has to be in `view.machines`.
 */
function withMachine(
  view: WorldView,
  tileX: number,
  tileY: number,
  kind: number,
  id = 1,
): WorldView {
  view.machines.push({
    id,
    kind,
    tileX,
    tileY,
    tilesWide: 1,
    tilesHigh: 1,
  } as WorldView['machines'][number]);
  return view;
}

/** One inventory row. `sellable` is the only field the bin's hand verb reads. */
function withItem(view: WorldView, item: number, count: number, sellable: number): WorldView {
  view.inventory.push({
    item,
    count,
    sellable,
    boxedMachineKind: 0,
    boxes: [],
    ticksToSpoil: -1,
    spoilingCount: 0,
  } as WorldView['inventory'][number]);
  return view;
}

const FAR = { tileX: 14, tileY: 14 };

describe('reachAdjusted — in reach', () => {
  it('leaves a tile verb exactly as it was, rather than walking a zero-length errand', () => {
    const view = standingOn(4, 4);
    const direct: Command = { type: 'WaterTile', tileX: 4, tileY: 4 };
    expect(reachAdjusted(view, { tileX: 4, tileY: 4 }, direct)).toBe(direct);
  });

  it('leaves a machine verb as it was', () => {
    const view = withMachine(standingOn(4, 4), 4, 4, MachineKind.Sprinkler);
    const direct: Command = { type: 'RefillHopper', machineId: 1 };
    expect(reachAdjusted(view, { tileX: 4, tileY: 4 }, direct)).toBe(direct);
  });
});

describe('reachAdjusted — out of reach', () => {
  it('turns a water click into a Water errand aimed at the clicked tile', () => {
    const view = standingOn(1, 1);
    const direct: Command = { type: 'WaterTile', tileX: FAR.tileX, tileY: FAR.tileY };
    expect(reachAdjusted(view, FAR, direct)).toEqual({
      type: 'WalkAndAct',
      action: IntentAction.Water,
      tileX: 14,
      tileY: 14,
      item: 0,
      count: 0,
    });
  });

  it('carries the crop through as `item`, or the errand arrives and plants nothing', () => {
    const view = standingOn(1, 1);
    const direct: Command = {
      type: 'PlantTile',
      tileX: FAR.tileX,
      tileY: FAR.tileY,
      crop: CropId.RussetPotato,
    };
    expect(reachAdjusted(view, FAR, direct)).toEqual({
      type: 'WalkAndAct',
      action: IntentAction.Plant,
      tileX: 14,
      tileY: 14,
      item: CropId.RussetPotato,
      count: 0,
    });
  });

  it('carries the stack size through as `count` on an unload', () => {
    const view = withMachine(standingOn(1, 1), FAR.tileX, FAR.tileY, MachineKind.Fryer);
    const direct: Command = { type: 'UnloadMachine', machineId: 1, count: 9 };
    expect(reachAdjusted(view, FAR, direct)).toEqual({
      type: 'WalkAndAct',
      action: IntentAction.Unload,
      tileX: 14,
      tileY: 14,
      item: 0,
      count: 9,
    });
  });

  it('sends a sell to the bin tile, since SellItem names no machine of its own', () => {
    const view = withMachine(standingOn(1, 1), FAR.tileX, FAR.tileY, MachineKind.SellBin);
    const direct: Command = { type: 'SellItem', item: ItemId.RussetPotato, count: 3 };
    expect(reachAdjusted(view, FAR, direct)).toEqual({
      type: 'WalkAndAct',
      action: IntentAction.Sell,
      tileX: 14,
      tileY: 14,
      item: ItemId.RussetPotato,
      count: 3,
    });
  });
});

describe('reachAdjusted — the two verbs 054 added', () => {
  // Same wiring as Repair, which is what the sim's `IntentAction.Deconstruct` was modelled on.
  // A wrong action here walks the farmer across the lot to whack a machine he meant to box.
  it('walks to a distant machine to box it', () => {
    const view = withMachine(standingOn(1, 1), FAR.tileX, FAR.tileY, MachineKind.Fryer);
    const direct: Command = { type: 'DeconstructMachine', machineId: 1 };
    expect(reachAdjusted(view, FAR, direct)).toEqual({
      type: 'WalkAndAct',
      action: IntentAction.Deconstruct,
      tileX: 14,
      tileY: 14,
      item: 0,
      count: 0,
    });
  });

  it('boxes it where it stands when the machine is already in reach', () => {
    const view = withMachine(standingOn(4, 4), 4, 4, MachineKind.Fryer);
    const direct: Command = { type: 'DeconstructMachine', machineId: 1 };
    expect(reachAdjusted(view, { tileX: 4, tileY: 4 }, direct)).toBe(direct);
  });

  // A buy carries no tile of its own — the board is a panel, not a click on the world — so the
  // errand has to find the counter. Aiming at the clicked tile instead would send the farmer to
  // wherever the cursor happened to be, and `intentTargetSubtiles` would refuse it on arrival.
  it('finds the stand itself and walks there to buy', () => {
    const view = withMachine(standingOn(1, 1), FAR.tileX, FAR.tileY, MachineKind.SellBin);
    const direct: Command = { type: 'BuyItem', item: ItemId.PotatoSeed, count: 10 };
    expect(reachAdjusted(view, { tileX: 0, tileY: 0 }, direct)).toEqual({
      type: 'WalkAndAct',
      action: IntentAction.Buy,
      tileX: 14,
      tileY: 14,
      item: ItemId.PotatoSeed,
      count: 10,
    });
  });

  it('buys on the spot when the farmer is already at the counter', () => {
    const view = withMachine(standingOn(4, 4), 4, 4, MachineKind.SellBin);
    const direct: Command = { type: 'BuyItem', item: ItemId.PotatoSeed, count: 10 };
    expect(reachAdjusted(view, { tileX: 4, tileY: 4 }, direct)).toBe(direct);
  });

  it('walks to the nearest stand rather than the lowest id', () => {
    const view = standingOn(1, 1);
    withMachine(view, 14, 14, MachineKind.SellBin, 1);
    withMachine(view, 4, 4, MachineKind.SellBin, 2);
    const direct: Command = { type: 'BuyItem', item: ItemId.PotatoSeed, count: 1 };
    const walk = reachAdjusted(view, { tileX: 0, tileY: 0 }, direct);
    expect(walk).toMatchObject({ type: 'WalkAndAct', tileX: 4, tileY: 4 });
  });
});

describe('the sell bin is a counter with two sides', () => {
  // The old rule was a hard-coded `PotatoSeed` skip, which was right about one of the four
  // seeds in the game: cane, corn and chili seeds all have list prices and are all refused by
  // `applySellItem`, so a pouch holding only those built a command the sim threw away and the
  // click died silently. `sellable` is the fact itself.
  it('never offers to sell something the bin refuses', () => {
    const view = withItem(standingOn(4, 4), ItemId.CaneSeed, 9, 0);
    expect(bestSellable(view)).toBeNull();
  });

  it('picks the most valuable stack the bin will take', () => {
    const view = standingOn(4, 4);
    withItem(view, ItemId.PotatoSeed, 40, 0);
    withItem(view, ItemId.RussetPotato, 3, 1);
    expect(bestSellable(view)).toEqual({ item: ItemId.RussetPotato, count: 3 });
  });

  it('opens the board when a Hand click on the bin has nothing to sell', () => {
    const view = withMachine(standingOn(4, 4), 4, 4, MachineKind.SellBin);
    expect(primaryCommand(view, { tileX: 4, tileY: 4 }, ToolMode.Hand, Direction.East)).toBeNull();
    expect(counterPanelFor(view, { tileX: 4, tileY: 4 }, ToolMode.Hand)).toBe('shop');
  });

  it('sells rather than opening anything when the pouch has goods', () => {
    const view = withMachine(standingOn(4, 4), 4, 4, MachineKind.SellBin);
    withItem(view, ItemId.RussetPotato, 2, 1);
    expect(primaryCommand(view, { tileX: 4, tileY: 4 }, ToolMode.Hand, Direction.East)).toEqual({
      type: 'SellItem',
      item: ItemId.RussetPotato,
      count: 2,
    });
  });

  it('leaves every other machine alone — only the counter opens a panel', () => {
    const view = withMachine(standingOn(4, 4), 4, 4, MachineKind.Fryer);
    expect(counterPanelFor(view, { tileX: 4, tileY: 4 }, ToolMode.Hand)).toBeNull();
  });
});

describe('the Box Up tool', () => {
  it('names the machine under the cursor and lets the sim judge it', () => {
    const view = withMachine(standingOn(4, 4), 4, 4, MachineKind.Fryer, 7);
    expect(
      primaryCommand(view, { tileX: 4, tileY: 4 }, ToolMode.Deconstruct, Direction.East),
    ).toEqual({ type: 'DeconstructMachine', machineId: 7 });
  });

  it('does nothing on bare ground', () => {
    const view = standingOn(4, 4);
    expect(
      primaryCommand(view, { tileX: 4, tileY: 4 }, ToolMode.Deconstruct, Direction.East),
    ).toBeNull();
  });
});

describe('reachAdjusted — verbs that are not reach-gated', () => {
  // Placement is legal from across the lot in `tick.ts`, so walking there first would be a
  // new rule invented by the input layer rather than a fix to a silent refusal.
  it('never walks for a placement, however far away it is', () => {
    const view = standingOn(1, 1);
    const direct: Command = {
      type: 'PlaceMachine',
      kind: MachineKind.Sprinkler,
      tileX: FAR.tileX,
      tileY: FAR.tileY,
    };
    expect(reachAdjusted(view, FAR, direct)).toBe(direct);
  });
});
