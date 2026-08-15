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
  TillMode,
  createWorldView,
} from '@snack/sim';
import type { Command, WorldView } from '@snack/sim';

import {
  bestSellable,
  counterPanelFor,
  createHold,
  dragCommands,
  holdCommand,
  primaryCommand,
  reachAdjusted,
  tillConverts,
  tillModeFor,
  walkFallback,
} from './pointer';
import type { HoldState } from './pointer';
import { ToolMode, gestureFor } from './tools';

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

// The teardown tool is a RECT gesture as of [[060]], so it no longer passes through
// `primaryCommand` at all — a click reaches it as a one-tile drag. What is worth pinning here
// is the seam that change could have broken silently: a click on a machine used to walk, and
// a gesture change that quietly turned that into a refused command would read as a dead click
// on the far side of the lot. `teardown.test.ts` covers what the tool finds; this covers what
// a click DOES with it.
describe('the teardown tool', () => {
  function drag(view: WorldView, tileX: number, tileY: number) {
    const at = { tileX, tileY };
    return dragCommands(
      view,
      { pointerId: 1, anchor: at, cursor: at, tool: ToolMode.Deconstruct, flipped: false },
      CropId.RussetPotato,
    );
  }

  it('boxes a machine in reach where it stands', () => {
    const view = withMachine(standingOn(4, 4), 4, 4, MachineKind.Fryer, 7);
    expect(drag(view, 4, 4)).toEqual([{ type: 'DeconstructMachine', machineId: 7 }]);
  });

  it('still walks to a machine across the lot, rather than sending a refused command', () => {
    const view = withMachine(standingOn(1, 1), FAR.tileX, FAR.tileY, MachineKind.Fryer, 7);
    expect(drag(view, FAR.tileX, FAR.tileY)).toEqual([
      {
        type: 'WalkAndAct',
        action: IntentAction.Deconstruct,
        tileX: 14,
        tileY: 14,
        item: 0,
        count: 0,
      },
    ]);
  });

  it('emits nothing on bare ground', () => {
    expect(drag(standingOn(4, 4), 4, 4)).toEqual([]);
  });

  // The one thing the walk must NOT do: a drag over several objects has no single errand to
  // become, and the sim holds one errand at a time.
  it('does not walk for a drag that holds more than one thing', () => {
    const view = withMachine(standingOn(1, 1), 14, 14, MachineKind.Fryer, 7);
    view.grabbers.push({ id: 5, tileX: 16, tileY: 14, dir: Direction.East, tier: 1 } as never);
    const commands = dragCommands(
      view,
      {
        pointerId: 1,
        anchor: { tileX: 14, tileY: 14 },
        cursor: { tileX: 16, tileY: 14 },
        tool: ToolMode.Deconstruct,
        flipped: false,
      },
      CropId.RussetPotato,
    );
    expect(commands).toEqual([
      { type: 'DeconstructMachine', machineId: 7 },
      { type: 'RemoveGrabber', grabberId: 5 },
    ]);
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

describe('the watering can refills on the Water tool ([[009]])', () => {
  /** A pond. Only the rect matters to the input layer; the levels are the sim's business. */
  function withPond(
    view: WorldView,
    tileX: number,
    tileY: number,
    tilesWide = 2,
    tilesHigh = 2,
  ): WorldView {
    view.reservoirs.push({
      id: 1,
      tileX,
      tileY,
      tilesWide,
      tilesHigh,
      levelMl: 0,
      capacityMl: 1,
      levelPermille: 0,
      throttle: 0,
    } as WorldView['reservoirs'][number]);
    return view;
  }

  it('a Water click on open water is a dip, not a pour', () => {
    const view = withPond(standingOn(4, 4), 4, 5);
    expect(primaryCommand(view, { tileX: 4, tileY: 5 }, ToolMode.Water, Direction.None)).toEqual({
      type: 'RefillCan',
    });
  });

  it('a Water click on the bank still waters the dirt — the bank is soil, not shore', () => {
    const view = withPond(standingOn(4, 4), 6, 6);
    expect(primaryCommand(view, { tileX: 5, tileY: 6 }, ToolMode.Water, Direction.None)).toEqual({
      type: 'WaterTile',
      tileX: 5,
      tileY: 6,
    });
  });

  it('an in-reach dip goes direct', () => {
    const view = withPond(standingOn(4, 4), 4, 5);
    const direct = primaryCommand(view, { tileX: 4, tileY: 5 }, ToolMode.Water, Direction.None)!;
    expect(reachAdjusted(view, { tileX: 4, tileY: 5 }, direct)).toBe(direct);
  });

  it('an out-of-reach dip walks — a RefillCan errand aimed at the clicked water tile', () => {
    const view = withPond(standingOn(1, 1), FAR.tileX, FAR.tileY);
    const direct = primaryCommand(view, FAR, ToolMode.Water, Direction.None)!;
    expect(direct.type).toBe('RefillCan');
    expect(reachAdjusted(view, FAR, direct)).toEqual({
      type: 'WalkAndAct',
      action: IntentAction.RefillCan,
      tileX: FAR.tileX,
      tileY: FAR.tileY,
      item: 0,
      count: 0,
    });
  });

  it('a pondless world dips on the pour click once the can is empty, from anywhere', () => {
    const view = standingOn(1, 1);
    view.player.canCharges = 0;
    const direct = primaryCommand(view, FAR, ToolMode.Water, Direction.None)!;
    expect(direct.type).toBe('RefillCan');
    // No shoreline to walk to, and the sim accepts the dip from anywhere — direct, never an
    // errand that would die aiming at water that does not exist.
    expect(reachAdjusted(view, FAR, direct)).toBe(direct);
  });

  it('a pondless world with pours left keeps pouring', () => {
    const view = standingOn(1, 1);
    view.player.canCharges = 3;
    expect(primaryCommand(view, { tileX: 2, tileY: 1 }, ToolMode.Water, Direction.None)).toEqual({
      type: 'WaterTile',
      tileX: 2,
      tileY: 1,
    });
  });
});

/** Own the parcel a tile sits on, so standability stops refusing on ownership. */
function owning(view: WorldView, parcel = 0): WorldView {
  view.land.owned.push(parcel);
  return view;
}

/**
 * A view whose farmland is exactly `tiles`, in the sim's row-major world order — the shape
 * `fieldIndexAtView` binary-searches (see `picking.test.ts`).
 */
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

describe('click-to-walk, the dead-click fallback ([[070]])', () => {
  // The dispatch ORDER is the contract: `onPointerDown` asks `primaryCommand`, then
  // `counterPanelFor`, and only a click both declined reaches `walkFallback`. The cases
  // below pin the fallback's own refusals, so even a future re-ordering cannot make it
  // shadow a live click — it says null wherever a click could mean anything else.

  it('walks to empty owned ground out of reach, with the Walk action and empty payload', () => {
    const view = owning(standingOn(1, 1));
    expect(walkFallback(view, FAR)).toEqual({
      type: 'WalkAndAct',
      action: IntentAction.Walk,
      tileX: FAR.tileX,
      tileY: FAR.tileY,
      item: 0,
      count: 0,
    });
  });

  it('emits nothing within arm’s reach — the errand would complete on the spot', () => {
    const view = owning(standingOn(4, 4));
    expect(walkFallback(view, { tileX: 4, tileY: 5 })).toBeNull();
  });

  it('never walks onto a machine tile — the Hand declining it is not an invitation', () => {
    const view = owning(withMachine(standingOn(1, 1), FAR.tileX, FAR.tileY, MachineKind.Fryer));
    expect(walkFallback(view, FAR)).toBeNull();
  });

  it('never walks at a crop tile', () => {
    const view = owning(withFieldTiles(standingOn(1, 1), [[FAR.tileX, FAR.tileY]]));
    view.field.crop[0] = CropId.RussetPotato;
    expect(walkFallback(view, FAR)).toBeNull();
  });

  it('refuses water and unowned land, exactly as the sim’s standability does', () => {
    const unowned = standingOn(1, 1);
    expect(walkFallback(unowned, FAR)).toBeNull();

    const view = owning(standingOn(1, 1));
    view.reservoirs.push({
      id: 1,
      tileX: FAR.tileX,
      tileY: FAR.tileY,
      tilesWide: 1,
      tilesHigh: 1,
    } as WorldView['reservoirs'][number]);
    expect(walkFallback(view, FAR)).toBeNull();
  });

  it('walks to an EMPTY farm tile — dirt is a place too', () => {
    const view = owning(withFieldTiles(standingOn(1, 1), [[FAR.tileX, FAR.tileY]]));
    expect(walkFallback(view, FAR)).toMatchObject({ action: IntentAction.Walk });
  });
});

describe('the till tool ([[066]])', () => {
  function tillDrag(view: WorldView, anchor: [number, number], cursor: [number, number]) {
    return dragCommands(
      view,
      {
        pointerId: 1,
        anchor: { tileX: anchor[0], tileY: anchor[1] },
        cursor: { tileX: cursor[0], tileY: cursor[1] },
        tool: ToolMode.Till,
        flipped: false,
      },
      CropId.RussetPotato,
    );
  }

  it('the anchor decides the mode: grass tills, farmland un-tills', () => {
    const view = owning(withFieldTiles(createWorldView(), [[4, 4]]));
    expect(tillModeFor(view, { tileX: 10, tileY: 10 })).toBe(TillMode.Till);
    expect(tillModeFor(view, { tileX: 4, tileY: 4 })).toBe(TillMode.Untill);
  });

  it('one drag is ONE TillTile carrying the whole rect', () => {
    const view = owning(createWorldView());
    expect(tillDrag(view, [10, 10], [12, 11])).toEqual([
      {
        type: 'TillTile',
        rect: { x: 10, y: 10, w: 3, h: 2 },
        mode: TillMode.Till,
      },
    ]);
  });

  it('a click is a 1×1 drag, and an anchor on dirt asks for grass back', () => {
    const view = owning(withFieldTiles(createWorldView(), [[4, 4]]));
    expect(tillDrag(view, [4, 4], [4, 4])).toEqual([
      { type: 'TillTile', rect: { x: 4, y: 4, w: 1, h: 1 }, mode: TillMode.Untill },
    ]);
  });

  it('the ghost mirrors the reducer’s skips: occupied, unowned, water, already-converted', () => {
    const view = owning(withFieldTiles(createWorldView(), [[4, 4]]));
    withMachine(view, 10, 10, MachineKind.Fryer);
    view.reservoirs.push({
      id: 1,
      tileX: 12,
      tileY: 12,
      tilesWide: 1,
      tilesHigh: 1,
    } as WorldView['reservoirs'][number]);

    expect(tillConverts(view, 9, 9, TillMode.Till)).toBe(true); // owned grass
    expect(tillConverts(view, 10, 10, TillMode.Till)).toBe(false); // machine
    expect(tillConverts(view, 12, 12, TillMode.Till)).toBe(false); // water
    expect(tillConverts(view, 40, 40, TillMode.Till)).toBe(false); // unowned parcel
    expect(tillConverts(view, 4, 4, TillMode.Till)).toBe(false); // already farmland
  });

  it('un-till converts only EMPTY farmland — a planted or compost tile keeps its floor', () => {
    const view = owning(
      withFieldTiles(createWorldView(), [
        [4, 4],
        [5, 4],
        [6, 4],
      ]),
    );
    view.field.crop[1] = CropId.RussetPotato; // (5,4)
    view.field.compost[2] = 1; // (6,4)

    expect(tillConverts(view, 4, 4, TillMode.Untill)).toBe(true);
    expect(tillConverts(view, 5, 4, TillMode.Untill)).toBe(false);
    expect(tillConverts(view, 6, 4, TillMode.Untill)).toBe(false);
    expect(tillConverts(view, 9, 9, TillMode.Untill)).toBe(false); // grass already
  });
});

// Hold-to-paint ([[072]]): the left button held on a paint tool repeats the verb, once per
// NEW tile, direct commands only. The brain is `createHold` + `holdCommand`, both pure, so a
// whole drag is a sequence of calls here — no DOM, no camera, no pointer events. What these
// pin is exactly the silent failures: a double-fire on a re-crossed tile, a walk errand
// leaking out of a hold (which would thrash the single-errand model), and a dry can ringing
// its refusal once per tile instead of once.
describe('hold-to-paint ([[072]])', () => {
  /** The press edge, as `onPointerDown` performs it: the click's command, then the hold. */
  function pressHold(view: WorldView, tileX: number, tileY: number, tool: ToolMode): HoldState {
    const at = { tileX, tileY };
    const pressed = primaryCommand(view, at, tool, Direction.None)!;
    return createHold(1, 0, 0, view, at, tool, pressed);
  }

  it('the three hand verbs are paint; clicks, rects and lines all keep their grammar', () => {
    expect(gestureFor(ToolMode.Plant)).toBe('paint');
    expect(gestureFor(ToolMode.Water)).toBe('paint');
    expect(gestureFor(ToolMode.Harvest)).toBe('paint');
    // NOT the Hand, and NOT a placement — a held drag placing eight sprinklers is a
    // financial incident, not a convenience.
    expect(gestureFor(ToolMode.Hand)).toBe('click');
    expect(gestureFor(ToolMode.PlaceSprinkler)).toBe('click');
    expect(gestureFor(ToolMode.UseRepairKit)).toBe('click');
    // The drag grammars are untouched: their dispatch never sees a hold.
    expect(gestureFor(ToolMode.Till)).toBe('rect');
    expect(gestureFor(ToolMode.PaintZone)).toBe('rect');
    expect(gestureFor(ToolMode.Deconstruct)).toBe('rect');
    expect(gestureFor(ToolMode.PlaceBeltBasic)).toBe('line');
  });

  it('sows each crossed tile once — and never the anchor, which the press already got', () => {
    const view = standingOn(4, 4);
    const hold = pressHold(view, 4, 4, ToolMode.Plant);

    expect(holdCommand(view, hold, { tileX: 4, tileY: 5 })).toEqual({
      type: 'PlantTile',
      tileX: 4,
      tileY: 5,
      crop: CropId.RussetPotato,
    });
    expect(holdCommand(view, hold, { tileX: 5, tileY: 4 })).toMatchObject({ type: 'PlantTile' });
    // Re-crossing a tile is silence, not a second plant.
    expect(holdCommand(view, hold, { tileX: 4, tileY: 5 })).toBeNull();
    // The anchor was the click; the hold never repeats it.
    expect(holdCommand(view, hold, { tileX: 4, tileY: 4 })).toBeNull();
  });

  it('skips an out-of-reach tile — never a walk errand — then fires it when reach arrives', () => {
    const view = standingOn(4, 4);
    const hold = pressHold(view, 4, 4, ToolMode.Plant);

    // Two tiles south is past arm's length. Skipped: no command, and above all no WalkAndAct.
    expect(holdCommand(view, hold, { tileX: 4, tileY: 6 })).toBeNull();

    // The farmer walks one tile south while the button stays down; the same tile under the
    // same cursor is now in reach, and fires — the long-row loop.
    view.player.ySub += SUBTILE;
    expect(holdCommand(view, hold, { tileX: 4, tileY: 6 })).toMatchObject({
      type: 'PlantTile',
      tileX: 4,
      tileY: 6,
    });
  });

  it('harvest repeats the same way', () => {
    const view = standingOn(4, 4);
    const hold = pressHold(view, 4, 4, ToolMode.Harvest);
    expect(holdCommand(view, hold, { tileX: 4, tileY: 5 })).toEqual({
      type: 'HarvestTile',
      tileX: 4,
      tileY: 5,
    });
  });

  it('water budgets the can within a tick, and the dry-can tell rings once, not per tile', () => {
    const view = standingOn(4, 4);
    view.player.canCharges = 2;
    // The press poured one (in reach, direct), so the hold starts owing one charge.
    const hold = pressHold(view, 4, 4, ToolMode.Water);

    // Second pour: the last charge the can actually has.
    expect(holdCommand(view, hold, { tileX: 4, tileY: 5 })).toMatchObject({ type: 'WaterTile' });
    // Third tile: dry. ONE more command goes through so the sim's refusal tell rings…
    expect(holdCommand(view, hold, { tileX: 5, tileY: 4 })).toMatchObject({
      type: 'WaterTile',
      tileX: 5,
      tileY: 4,
    });
    // …and then silence, however many more tiles the drag crosses.
    expect(holdCommand(view, hold, { tileX: 5, tileY: 5 })).toBeNull();
    expect(holdCommand(view, hold, { tileX: 3, tileY: 4 })).toBeNull();

    // The view advances a tick — every queued pour is now reflected in `canCharges`, which
    // the sim has at zero. Still silent, and still no second tell.
    view.tick = 1;
    view.player.canCharges = 0;
    expect(holdCommand(view, hold, { tileX: 3, tileY: 5 })).toBeNull();
  });

  it('a hold that begins with a dry can says nothing more — the press was the tell', () => {
    const view = standingOn(4, 4);
    view.player.canCharges = 0;
    // A pond far away, so the pondless-world special case stays out of the way and the
    // press is an ordinary (refused, audible) pour.
    view.reservoirs.push({
      id: 1,
      tileX: 14,
      tileY: 14,
      tilesWide: 1,
      tilesHigh: 1,
    } as WorldView['reservoirs'][number]);
    const hold = pressHold(view, 4, 4, ToolMode.Water);

    expect(holdCommand(view, hold, { tileX: 4, tileY: 5 })).toBeNull();
    expect(holdCommand(view, hold, { tileX: 5, tileY: 4 })).toBeNull();
  });

  it('a drag that clips the pond does not dip the can mid-row', () => {
    const view = standingOn(4, 4);
    view.player.canCharges = 5;
    view.reservoirs.push({
      id: 1,
      tileX: 4,
      tileY: 5,
      tilesWide: 1,
      tilesHigh: 1,
    } as WorldView['reservoirs'][number]);
    const hold = pressHold(view, 4, 4, ToolMode.Water);

    // Open water under the held cursor means `RefillCan` to a click; the hold filters it.
    expect(holdCommand(view, hold, { tileX: 4, tileY: 5 })).toBeNull();
    // And the row continues on the far side of the clip.
    expect(holdCommand(view, hold, { tileX: 5, tileY: 4 })).toMatchObject({ type: 'WaterTile' });
  });
});

describe('the repair kit cursor ([[009]] tool wiring)', () => {
  it('one click is one UseRepairKit at the tile — a spot, never a machine id', () => {
    const view = standingOn(4, 4);
    expect(
      primaryCommand(view, { tileX: 5, tileY: 4 }, ToolMode.UseRepairKit, Direction.None),
    ).toEqual({ type: 'UseRepairKit', tileX: 5, tileY: 4 });
  });

  it('does not walk out of reach — the sim has no errand for it, so the command goes as-is', () => {
    const view = standingOn(1, 1);
    const direct = primaryCommand(view, FAR, ToolMode.UseRepairKit, Direction.None)!;
    expect(reachAdjusted(view, FAR, direct)).toBe(direct);
  });
});
