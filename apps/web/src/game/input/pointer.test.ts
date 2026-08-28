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

import { beforeEach, describe, expect, it } from 'vitest';
import {
  CropId,
  Direction,
  GrabberTier,
  IntentAction,
  ItemId,
  LiquidId,
  MachineKind,
  SUBTILE,
  TillMode,
  createWorldView,
  machineHoppers,
  machineSpec,
} from '@snack/sim';
import type { Command, WorldView } from '@snack/sim';

import {
  PointerInput,
  bestSellable,
  counterPanelFor,
  createHold,
  createWorkQueue,
  dragBand,
  dragCommands,
  holdCommand,
  machineTell,
  primaryCommand,
  pumpWorkQueue,
  reachAdjusted,
  tileSaturated,
  tillConverts,
  tillModeFor,
  walkFallback,
  walkKeyInterruptsQueue,
  workQueueDone,
  workQueueRemaining,
} from './pointer';
import type { HoldState, WorkQueueState } from './pointer';
import { CommandQueue } from './commands';
import { grabberPanelSnapshot, publishGrabberPanel, resetGrabberPanel } from './grabber-panel';
import type { InputHost } from './context';
import type { InputSystem } from './system';
import type { Camera } from '../render/camera';
import { TILE_PX } from '../render/pixel';
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
/**
 * A machine on the lot, with **the hoppers the projection would actually publish for it**.
 *
 * `recipe` used to be left off this literal, along with everything else the case under test
 * did not read, and the cast made that legal. It stopped being harmless when the hand verb
 * started reading hoppers instead of a hard-coded table of machine kinds (item 111): a
 * fixture with no `recipe` is not a machine with no hoppers, it is a `MachineView` the sim
 * could never produce, and it fails with a TypeError rather than with an answer. So the
 * hoppers are derived here exactly as `projectRecipe` derives them, empty and in order —
 * which is also what makes the drone-bay case below mean something, since the bay's emptiness
 * is now the thing being asserted rather than a gap in a switch.
 */
function withMachine(
  view: WorldView,
  tileX: number,
  tileY: number,
  kind: number,
  id = 1,
): WorldView {
  const spec = machineSpec(kind as MachineKind);
  view.machines.push({
    id,
    kind,
    tileX,
    tileY,
    tilesWide: 1,
    tilesHigh: 1,
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

describe('hoppers answer the door', () => {
  // Both found by the owner in one play session: the Water tool over a barrel sprinkler
  // watered the dirt while the barrel stood empty, and a Hand click on the planter dock
  // fell through `machineInputItem`'s chip-line switch to nothing — the sim's
  // `applyRefillHopper` door existed for both and no click ever knocked.
  it('a Water click on a barrel sprinkler fills the barrel, not the dirt under it', () => {
    const view = withMachine(standingOn(4, 4), 4, 5, MachineKind.Sprinkler, 7);
    expect(primaryCommand(view, { tileX: 4, tileY: 5 }, ToolMode.Water, Direction.None)).toEqual({
      type: 'RefillHopper',
      machineId: 7,
    });
  });

  it('a Hand click on the planter dock offers its seed hopper', () => {
    const view = withMachine(standingOn(4, 4), 4, 5, MachineKind.PlanterDock, 9);
    expect(primaryCommand(view, { tileX: 4, tileY: 5 }, ToolMode.Hand, Direction.East)).toEqual({
      type: 'RefillHopper',
      machineId: 9,
    });
  });

  it('a Hand click on the drone bay offers nothing — it has no hopper ([[090]])', () => {
    // The inverse of the test above, and it used to be its twin: a bay took parts by hand the
    // way a planter takes seeds. Repair drones fix machines for free now, so the sim's door is
    // gone and a click that still offered `RefillHopper` would knock on a wall.
    const view = withMachine(standingOn(4, 4), 4, 5, MachineKind.DroneBay, 11);
    expect(primaryCommand(view, { tileX: 4, tileY: 5 }, ToolMode.Hand, Direction.East)).toBe(null);
  });

  // Item 111, and the third instance of this same door being shut — re-pinned on the Washer
  // since [[145]] cut the flavour tier: the used bottle is not the Washer's spec input, so a
  // kind-keyed switch would answer `RussetPotato`, the player holding only empties had none,
  // and the click produced nothing. The load branch reads the machine's hoppers instead.
  it('a Hand click on a Washer takes the empties in your arms ([[111]])', () => {
    const view = withItem(
      withMachine(standingOn(4, 4), 4, 5, MachineKind.Washer, 12),
      ItemId.UsedBottle,
      4,
      1,
    );
    expect(primaryCommand(view, { tileX: 4, tileY: 5 }, ToolMode.Hand, Direction.East)).toEqual({
      type: 'LoadMachine',
      machineId: 12,
      count: 4,
    });
  });

  // The potato hopper is the Washer's first, so a full one used to be the end of the story.
  // `applyLoadMachine` skips a hopper with no room and moves down the list; this side has to
  // agree with it, or the click is refused on arrival after a walk across the lot.
  it('offers the next hopper when the first one is full', () => {
    const view = withItem(
      withItem(
        withMachine(standingOn(4, 4), 4, 5, MachineKind.Washer, 12),
        ItemId.RussetPotato,
        9,
        1,
      ),
      ItemId.UsedBottle,
      4,
      1,
    );
    const washer = view.machines[0]!;
    washer.recipe[0]!.count = washer.inputCapacity;

    expect(primaryCommand(view, { tileX: 4, tileY: 5 }, ToolMode.Hand, Direction.East)).toEqual({
      type: 'LoadMachine',
      machineId: 12,
      count: 4,
    });
  });

  // The whole soda line was in this hole too and nobody had noticed: the switch listed the
  // five chip machines and returned null for everything else, so a Grinder with kola nuts in
  // your arms ignored the click exactly as the planter dock had.
  it('a Hand click on a Grinder takes the kola nuts, which it never used to ([[111]])', () => {
    const view = withItem(
      withMachine(standingOn(4, 4), 4, 5, MachineKind.Grinder, 13),
      ItemId.KolaNut,
      7,
      1,
    );
    expect(primaryCommand(view, { tileX: 4, tileY: 5 }, ToolMode.Hand, Direction.East)).toEqual({
      type: 'LoadMachine',
      machineId: 13,
      count: 7,
    });
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

  /** The till's band, through the real drag path rather than the private `tillBand`. */
  function tillBandFor(view: WorldView, anchor: [number, number], cursor: [number, number]) {
    return dragBand(
      view,
      {
        pointerId: 1,
        anchor: { tileX: anchor[0], tileY: anchor[1] },
        cursor: { tileX: cursor[0], tileY: cursor[1] },
        tool: ToolMode.Till,
        flipped: false,
      },
      CropId.RussetPotato,
      LiquidId.None,
    );
  }

  /**
   * Three farm tiles at y=4: (4,4) bare, (5,4) planted, (6,4) bare.
   *
   * ⚠️ (6,4) HELD A COMPOST HEAP UNTIL [[124]] and was the fixture's third state — laden with
   * no crop in it. "Laden" is now exactly "has a crop", so the tile is a second BARE one; it
   * is kept rather than dropped because the partition assertion below wants more than one tile
   * on the un-till side of the line.
   */
  function ladder(): WorldView {
    const view = owning(
      withFieldTiles(createWorldView(), [
        [4, 4],
        [5, 4],
        [6, 4],
      ]),
    );
    view.field.crop[1] = CropId.RussetPotato; // (5,4)
    return view;
  }

  it('the anchor decides the mode: grass tills, a laden tile lifts, bare dirt un-tills', () => {
    const view = ladder();
    expect(tillModeFor(view, { tileX: 10, tileY: 10 })).toBe(TillMode.Till);
    expect(tillModeFor(view, { tileX: 4, tileY: 4 })).toBe(TillMode.Untill);
    expect(tillModeFor(view, { tileX: 5, tileY: 4 })).toBe(TillMode.Unplant);
    expect(tillModeFor(view, { tileX: 6, tileY: 4 })).toBe(TillMode.Untill);
  });

  it('un-plant takes exactly the LADEN farm tiles, which is un-till’s complement', () => {
    const view = ladder();
    expect(tillConverts(view, 5, 4, TillMode.Unplant)).toBe(true); // crop
    expect(tillConverts(view, 6, 4, TillMode.Unplant)).toBe(false); // bare farmland
    expect(tillConverts(view, 4, 4, TillMode.Unplant)).toBe(false); // bare farmland
    expect(tillConverts(view, 9, 9, TillMode.Unplant)).toBe(false); // grass

    // The partition, stated as such: no farm tile answers to both, and none to neither.
    for (const [x, y] of [
      [4, 4],
      [5, 4],
      [6, 4],
    ] as const) {
      const unplant = tillConverts(view, x, y, TillMode.Unplant);
      const untill = tillConverts(view, x, y, TillMode.Untill);
      expect(unplant).not.toBe(untill);
    }
  });

  it('the band SAYS WHICH OF THE THREE it is about to do, before the button comes up', () => {
    const view = ladder();

    const till = tillBandFor(view, [9, 9], [10, 9]);
    expect(till.tone).toBe('zone');
    expect(till.label).toBe('till 2 tiles');

    const untill = tillBandFor(view, [4, 4], [4, 4]);
    expect(untill.tone).toBe('erase');
    expect(untill.label).toBe('1 tile → grass');

    // `box` blue, borrowed from teardown: the ground stays, the crop goes in your bag.
    const unplant = tillBandFor(view, [5, 4], [5, 4]);
    expect(unplant.tone).toBe('box');
    expect(unplant.label).toContain('lift 1 tile');
  });

  it('the un-plant band NAMES WHAT COMES BACK, off the sim’s own slugs ([[121]]’s phrase)', () => {
    const view = ladder();
    view.field.ready[1] = 1; // (5,4) is ripe, so the produce is named too

    // Anchored on the crop and dragged across a BARE tile: the drag is two cells wide and only
    // one of them converts, which is the point — the phrase counts tiles the reducer will
    // actually lift, not tiles the pointer waved over. (It read "lift 2 tiles · … + 3 compost"
    // until [[124]], when the second tile stopped being laden.)
    const band = tillBandFor(view, [5, 4], [6, 4]);
    expect(band.label).toBe('lift 1 tile · returns russet potato + 1 potato seed');
  });

  it('a rect that converts nothing says so IN THE MODE IT IS IN, all three of them', () => {
    // Unowned land is the one place all three rungs go quiet on the same lot: the anchor still
    // reads the tile and picks a mode, and every cell is refused for ownership.
    const view = withFieldTiles(createWorldView(), [
      [40, 40],
      [41, 40],
    ]);
    view.field.crop[0] = CropId.RussetPotato; // (40,40) laden → `Unplant`
    // (41,40) bare → `Untill`; (45,45) is unowned grass → `Till`.

    expect(tillBandFor(view, [45, 45], [45, 45]).label).toBe('nothing here to till');
    expect(tillBandFor(view, [40, 40], [40, 40]).label).toBe('nothing here to lift');
    expect(tillBandFor(view, [41, 40], [41, 40]).label).toBe('nothing to return to grass');
    // A blocked band carries no promise and no cells, in any of the three.
    for (const at of [
      [45, 45],
      [40, 40],
      [41, 40],
    ] as const) {
      const band = tillBandFor(view, [at[0], at[1]], [at[0], at[1]]);
      expect(band.tone).toBe('blocked');
      expect(band.label).not.toContain('returns');
      expect(band.cells).toBeUndefined();
    }
  });

  // ────────────────────────────────────────────────────────────────────────────────────
  //  THE TRAP ITEM 121 FELL INTO, AND THE ONE THIS BAND MUST NOT.
  //
  //  Commit `23fc429` fixed a placement ghost that went on advertising *"returns 1 potato
  //  seed"* over a click the reducer refused: the tell was built from the BOUNDS and gated on
  //  a legality flag assembled somewhere else, so a mute refusal (`footprintClear`) let the
  //  two disagree. A drag makes that failure bigger, not smaller — the rectangle is whatever
  //  the player waved over, and most of it is usually ground the till will not touch.
  //
  //  Here the phrase is computed from the CONVERTING CELLS, so a tile the sim will skip cannot
  //  put a noun in it. These pin that: a machine standing on a planted tile contributes
  //  nothing, and neither does a tile outside the owned lot.
  // ────────────────────────────────────────────────────────────────────────────────────
  it('never promises goods off a tile the reducer will skip', () => {
    const view = owning(
      withFieldTiles(createWorldView(), [
        [4, 4],
        [5, 4],
      ]),
    );
    view.field.crop[0] = CropId.RussetPotato; // (4,4) — a clear lift
    view.field.crop[1] = CropId.RussetPotato; // (5,4) — under a machine, so skipped
    withMachine(view, 5, 4, MachineKind.Sprinkler);

    const band = tillBandFor(view, [4, 4], [5, 4]);
    // One tile lifted, ONE seed promised — not two.
    expect(band.label).toBe('lift 1 tile · returns 1 potato seed');
    expect(band.cells).toHaveLength(1);
  });

  it('promises nothing at all off unowned land', () => {
    // Farmland outside the owned parcel: laden to the view, refused by the sim's ownership
    // test, so it may neither fill a cell nor name a seed.
    const view = withFieldTiles(createWorldView(), [[40, 40]]);
    view.field.crop[0] = CropId.RussetPotato;
    expect(tillConverts(view, 40, 40, TillMode.Unplant)).toBe(false);
    expect(tillBandFor(view, [40, 40], [40, 40]).label).toBe('nothing here to lift');
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

  it('un-till converts only EMPTY farmland — a planted tile keeps its floor', () => {
    const view = owning(
      withFieldTiles(createWorldView(), [
        [4, 4],
        [5, 4],
        [6, 4],
      ]),
    );
    view.field.crop[1] = CropId.RussetPotato; // (5,4)

    expect(tillConverts(view, 4, 4, TillMode.Untill)).toBe(true);
    expect(tillConverts(view, 5, 4, TillMode.Untill)).toBe(false); // a crop is in it
    expect(tillConverts(view, 6, 4, TillMode.Untill)).toBe(true);
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

// The soaked filter ([[081]]): the sim refuses a pour on a tile at its moisture ceiling, so
// the paint gesture stops offering one — no charge risked, no silent command, one readable
// flag per gesture for the tell. What is pinned is the silent failure pair: a wet tile that
// still fires (charge-count drift against the sim's refusal) and a soaked flag that rings
// per tile instead of once.
describe('the soaked filter ([[081]])', () => {
  /** Farmland at (x,y) whose moisture the test sets, in the field's keyed arrays. */
  function withMoisture(
    view: WorldView,
    tiles: readonly (readonly [number, number, number])[],
  ): WorldView {
    withFieldTiles(
      view,
      tiles.map(([x, y]) => [x, y] as const),
    );
    const sorted = [...tiles].sort(
      (a, b) => a[1] * view.worldTilesWide + a[0] - (b[1] * view.worldTilesWide + b[0]),
    );
    sorted.forEach(([, , permille], i) => {
      view.field.moisturePermille[i] = permille;
    });
    return view;
  }

  it('saturated means literally full — 999 permille still pours', () => {
    const view = withMoisture(standingOn(4, 4), [
      [4, 5, 1000],
      [5, 4, 999],
    ]);
    expect(tileSaturated(view, 4, 5)).toBe(true);
    expect(tileSaturated(view, 5, 4)).toBe(false);
    // Grass has no moisture to be full of.
    expect(tileSaturated(view, 6, 6)).toBe(false);
  });

  it('a held Water skips the wet tiles, waters the dry ones, and flags soaked once', () => {
    const view = withMoisture(standingOn(4, 4), [
      [4, 5, 1000],
      [5, 4, 1000],
      [5, 5, 200],
    ]);
    view.player.canCharges = 10;
    const pressed = primaryCommand(view, { tileX: 4, tileY: 4 }, ToolMode.Water, Direction.None)!;
    const hold = createHold(1, 0, 0, view, { tileX: 4, tileY: 4 }, ToolMode.Water, pressed);
    const queue = createWorkQueue(view, ToolMode.Water, pressed);

    // Two wet tiles: both silent, ONE flag — the tell surface reads it once per gesture.
    expect(holdCommand(view, hold, { tileX: 4, tileY: 5 }, queue)).toBeNull();
    expect(queue.soakedTold).toBe(true);
    expect(holdCommand(view, hold, { tileX: 5, tileY: 4 }, queue)).toBeNull();
    // The dry tile still fires, and no charge was burned on the wet ones: the press (1)
    // plus this pour (1) is the whole spend.
    expect(holdCommand(view, hold, { tileX: 5, tileY: 5 }, queue)).toMatchObject({
      type: 'WaterTile',
      tileX: 5,
      tileY: 5,
    });
    expect(hold.watersEmitted).toBe(2);
    // Not marked fired: fast-draining soil may legitimately want the verb again mid-hold.
    expect(hold.fired.has('4,5')).toBe(false);
  });

  it('a wet tile that drains mid-hold becomes pourable again', () => {
    const view = withMoisture(standingOn(4, 4), [[4, 5, 1000]]);
    view.player.canCharges = 10;
    const pressed = primaryCommand(view, { tileX: 4, tileY: 4 }, ToolMode.Water, Direction.None)!;
    const hold = createHold(1, 0, 0, view, { tileX: 4, tileY: 4 }, ToolMode.Water, pressed);

    expect(holdCommand(view, hold, { tileX: 4, tileY: 5 })).toBeNull();
    view.field.moisturePermille[0] = 400;
    expect(holdCommand(view, hold, { tileX: 4, tileY: 5 })).toMatchObject({ type: 'WaterTile' });
  });

  it('an out-of-reach wet tile is not queued either — no walk to a refusal', () => {
    const view = withMoisture(standingOn(1, 1), [[14, 14, 1000]]);
    view.player.canCharges = 10;
    const pressed = primaryCommand(view, { tileX: 1, tileY: 2 }, ToolMode.Water, Direction.None)!;
    const hold = createHold(1, 0, 0, view, { tileX: 1, tileY: 2 }, ToolMode.Water, pressed);
    const queue = createWorkQueue(view, ToolMode.Water, pressed);

    expect(holdCommand(view, hold, { tileX: 14, tileY: 14 }, queue)).toBeNull();
    expect(queue.tiles).toEqual([]);
    expect(queue.soakedTold).toBe(true);
  });
});

// The out-of-reach work queue ([[074]]): a held paint crosses tiles beyond arm's length,
// the queue collects them in crossing order, and the pump walks the farmer to each in turn
// — one WalkAndAct outstanding at a time, resolution read off the view's own errand fields
// (`player.intentAction`/`intentTileX`/`intentTileY`), never a per-frame respawn.
describe('the work queue ([[074]])', () => {
  /** The press edge as `onPointerDown` performs it, returning all three artifacts. */
  function press(
    view: WorldView,
    anchor: readonly [number, number],
    tool: ToolMode,
  ): { hold: HoldState; queue: WorkQueueState; dispatched: Command } {
    const at = { tileX: anchor[0], tileY: anchor[1] };
    const pressed = primaryCommand(view, at, tool, Direction.None)!;
    const dispatched = reachAdjusted(view, at, pressed);
    const hold = createHold(1, 0, 0, view, at, tool, pressed);
    const queue = createWorkQueue(view, tool, dispatched);
    return { hold, queue, dispatched };
  }

  /** One frame of pumping, with the emitted commands collected. */
  function pump(
    view: WorldView,
    queue: WorkQueueState,
    fired: Set<string> | null = null,
    walkHeld = false,
    tool: ToolMode = queue.tool,
  ): { commands: Command[]; alive: boolean } {
    const commands: Command[] = [];
    const alive = pumpWorkQueue(view, queue, tool, fired, walkHeld, (c) => commands.push(c));
    return { commands, alive };
  }

  /** The sim resolved (or refused) the errand: the view advances with the intent cleared. */
  function resolve(view: WorldView): void {
    view.tick += 1;
    view.player.intentAction = 0;
    view.player.intentTileX = 0;
    view.player.intentTileY = 0;
  }

  /** The sim took the errand: the view advances showing it live. */
  function walking(view: WorldView, action: number, tileX: number, tileY: number): void {
    view.tick += 1;
    view.player.intentAction = action;
    view.player.intentTileX = tileX;
    view.player.intentTileY = tileY;
  }

  it('queues far crossed tiles in order and pumps them one errand at a time', () => {
    const view = standingOn(2, 2);
    const { hold, queue } = press(view, [2, 3], ToolMode.Plant);

    // The hold skips both far tiles — no direct fire, and above all no WalkAndAct from the
    // hold itself — and queues them in crossing order.
    expect(holdCommand(view, hold, { tileX: 2, tileY: 8 }, queue)).toBeNull();
    expect(holdCommand(view, hold, { tileX: 2, tileY: 12 }, queue)).toBeNull();
    expect(queue.tiles).toEqual([
      { tileX: 2, tileY: 8 },
      { tileX: 2, tileY: 12 },
    ]);

    // Frame 1: exactly ONE errand goes out, for the head tile.
    const first = pump(view, queue, hold.fired);
    expect(first.commands).toEqual([
      {
        type: 'WalkAndAct',
        action: IntentAction.Plant,
        tileX: 2,
        tileY: 8,
        item: CropId.RussetPotato,
        count: 0,
      },
    ]);
    expect(workQueueRemaining(queue)).toBe(2);

    // Frames while the sim walks: the pump is silent — no respawning, no second errand.
    walking(view, IntentAction.Plant, 2, 8);
    expect(pump(view, queue, hold.fired).commands).toEqual([]);
    expect(pump(view, queue, hold.fired).commands).toEqual([]);

    // The errand resolves; the NEXT tile is dispatched, and only then.
    resolve(view);
    const second = pump(view, queue, hold.fired);
    expect(second.commands).toEqual([
      {
        type: 'WalkAndAct',
        action: IntentAction.Plant,
        tileX: 2,
        tileY: 12,
        item: CropId.RussetPotato,
        count: 0,
      },
    ]);

    resolve(view);
    expect(pump(view, queue, hold.fired).commands).toEqual([]);
    expect(workQueueDone(queue)).toBe(true);
  });

  it('seeds the press-edge errand as outstanding, so the anchor is never replaced unworked', () => {
    const view = standingOn(2, 2);
    const { hold, queue, dispatched } = press(view, [2, 9], ToolMode.Plant);
    expect(dispatched).toMatchObject({ type: 'WalkAndAct', tileX: 2, tileY: 9 });
    expect(queue.outstanding).toMatchObject({ tileX: 2, tileY: 9 });

    // A tile queued mid-hold waits its turn behind the anchor's own errand.
    holdCommand(view, hold, { tileX: 2, tileY: 12 }, queue);
    expect(pump(view, queue, hold.fired).commands).toEqual([]);

    resolve(view);
    expect(pump(view, queue, hold.fired).commands).toMatchObject([
      { type: 'WalkAndAct', tileX: 2, tileY: 12 },
    ]);
  });

  it('a blocked or refused errand is dequeued once and never retried', () => {
    const view = standingOn(2, 2);
    const { hold, queue } = press(view, [2, 3], ToolMode.Plant);
    holdCommand(view, hold, { tileX: 2, tileY: 8 }, queue);
    holdCommand(view, hold, { tileX: 2, tileY: 12 }, queue);

    const all: Command[] = [];
    all.push(...pump(view, queue, hold.fired).commands);
    // The sim REFUSES the errand (say the tile is behind the pond, [[080]]): the intent
    // never appears. The pump reads that as resolved and moves on.
    resolve(view);
    all.push(...pump(view, queue, hold.fired).commands);
    resolve(view);
    all.push(...pump(view, queue, hold.fired).commands);

    const to8 = all.filter((c) => c.type === 'WalkAndAct' && c.tileY === 8);
    expect(to8).toHaveLength(1);
    expect(workQueueDone(queue)).toBe(true);
  });

  it('a queued tile that comes into reach fires directly and leaves the queue', () => {
    const view = standingOn(2, 2);
    const { hold, queue } = press(view, [2, 3], ToolMode.Plant);
    holdCommand(view, hold, { tileX: 2, tileY: 8 }, queue);

    // WASD (or the walk) carries the farmer down the row before the pump's errand exists.
    view.player.ySub = 7 * SUBTILE + SUBTILE / 2;
    const { commands } = pump(view, queue, hold.fired, true);
    expect(commands).toEqual([
      { type: 'PlantTile', tileX: 2, tileY: 8, crop: CropId.RussetPotato },
    ]);
    // Marked into the hold's fired set, so the hold cannot fire it a second time.
    expect(hold.fired.has('2,8')).toBe(true);
    expect(workQueueDone(queue)).toBe(true);
  });

  it('release keeps pumping — the queue outlives the button, which is the point', () => {
    const view = standingOn(2, 2);
    const { hold, queue } = press(view, [2, 3], ToolMode.Plant);
    holdCommand(view, hold, { tileX: 2, tileY: 8 }, queue);
    queue.holdDown = false; // the release edge

    expect(pump(view, queue, null).commands).toMatchObject([
      { type: 'WalkAndAct', tileX: 2, tileY: 8 },
    ]);
  });

  it('dispatches nothing while a direction key is held — the sim would refuse it anyway', () => {
    const view = standingOn(2, 2);
    const { hold, queue } = press(view, [2, 3], ToolMode.Plant);
    holdCommand(view, hold, { tileX: 2, tileY: 8 }, queue);

    expect(pump(view, queue, hold.fired, true).commands).toEqual([]);
    expect(queue.tiles).toHaveLength(1);
    // Key released: the row resumes.
    expect(pump(view, queue, hold.fired, false).commands).toMatchObject([
      { type: 'WalkAndAct', tileX: 2, tileY: 8 },
    ]);
  });

  it('arming another tool cancels the pump (matrix row: tool switch)', () => {
    const view = standingOn(2, 2);
    const { hold, queue } = press(view, [2, 3], ToolMode.Plant);
    holdCommand(view, hold, { tileX: 2, tileY: 8 }, queue);
    const { commands, alive } = pump(view, queue, hold.fired, false, ToolMode.Harvest);
    expect(alive).toBe(false);
    expect(commands).toEqual([]);
  });

  it('a WASD keypress after release cancels; mid-hold it reclaims the errand in flight', () => {
    const view = standingOn(2, 2);
    const { hold, queue } = press(view, [2, 3], ToolMode.Plant);
    holdCommand(view, hold, { tileX: 2, tileY: 8 }, queue);
    pump(view, queue, hold.fired);
    walking(view, IntentAction.Plant, 2, 8);

    // Mid-hold: legal, and the errand the keystroke is about to kill goes back to the head.
    expect(walkKeyInterruptsQueue(queue, view)).toBe(true);
    expect(queue.outstanding).toBeNull();
    expect(queue.tiles[0]).toEqual({ tileX: 2, tileY: 8 });

    // After release: the same keypress is a cancellation.
    queue.holdDown = false;
    expect(walkKeyInterruptsQueue(queue, view)).toBe(false);
  });

  it('mid-hold WASD does not resurrect an errand the view already shows finished', () => {
    const view = standingOn(2, 2);
    const { hold, queue } = press(view, [2, 3], ToolMode.Plant);
    holdCommand(view, hold, { tileX: 2, tileY: 8 }, queue);
    pump(view, queue, hold.fired);
    resolve(view); // worked before the keystroke landed

    expect(walkKeyInterruptsQueue(queue, view)).toBe(true);
    expect(queue.tiles).toEqual([]);
    expect(queue.outstanding).toBeNull();
  });

  it('the dry can PAUSES the water queue and a refill resumes it (the documented choice)', () => {
    const view = standingOn(2, 2);
    view.player.canCharges = 0;
    view.reservoirs.push({
      id: 1,
      tileX: 30,
      tileY: 30,
      tilesWide: 1,
      tilesHigh: 1,
    } as WorldView['reservoirs'][number]);
    const queue = createWorkQueue(view, ToolMode.Water, {
      type: 'WaterTile',
      tileX: 2,
      tileY: 3,
    });
    queue.keys.add('2,9');
    queue.tiles.push({ tileX: 2, tileY: 9 });

    // Dry: nothing dispatched — above all not a walk across the lot to a refused pour —
    // and the paused flag drives the tell.
    expect(pump(view, queue, null).commands).toEqual([]);
    expect(queue.dryPaused).toBe(true);
    expect(workQueueRemaining(queue)).toBe(1);

    // The refill lands (RefillCan on the same tool, [[009]]): the row resumes untouched.
    view.player.canCharges = 20;
    expect(pump(view, queue, null).commands).toMatchObject([
      { type: 'WalkAndAct', action: IntentAction.Water, tileX: 2, tileY: 9 },
    ]);
    expect(queue.dryPaused).toBe(false);
  });

  it('skips a queued tile that saturated before its turn, raising the soaked flag', () => {
    const view = standingOn(2, 2);
    view.player.canCharges = 10;
    // Two far farm tiles; a sprinkler soaks the first one mid-walk.
    withFieldTiles(view, [
      [2, 9],
      [2, 12],
    ]);
    view.field.moisturePermille[0] = 1000; // (2,9) in row-major order
    const queue = createWorkQueue(view, ToolMode.Water, {
      type: 'WaterTile',
      tileX: 2,
      tileY: 3,
    });
    queue.keys.add('2,9').add('2,12');
    queue.tiles.push({ tileX: 2, tileY: 9 }, { tileX: 2, tileY: 12 });

    const { commands } = pump(view, queue, null);
    expect(queue.soakedTold).toBe(true);
    // The wet tile cost nothing and the dry one behind it got the errand the same frame.
    expect(commands).toMatchObject([
      { type: 'WalkAndAct', action: IntentAction.Water, tileX: 2, tileY: 12 },
    ]);
  });
});

/**
 * A `PointerInput` on a stub host — the constructor takes capabilities, not a browser — with
 * synthetic pointer events. Hoisted to module scope because the click LADDER has two tenants
 * now: the work queue's cancellation wiring below, and item 099's arm-card rung, which can
 * only be checked by driving a real press through `onPointerDown` in its real order.
 */
function harness(view: WorldView, tool: ToolMode) {
  const canvasListeners = new Map<string, (event: unknown) => void>();
  const canvas = {
    addEventListener: (name: string, fn: (event: unknown) => void) => {
      canvasListeners.set(name, fn);
    },
    removeEventListener: () => {},
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 640 }),
  } as unknown as HTMLCanvasElement;
  const camera = {
    transform: { viewWidth: 640, viewHeight: 640, zoom: 1 },
    screenToWorld: (x: number, y: number) => ({ x, y }),
    worldToScreen: (x: number, y: number) => ({ x, y }),
  } as unknown as Camera;
  const queue = new CommandQueue();
  let armed = tool;
  const host = {
    canvas,
    camera,
    queue,
    overlayRoot: undefined as unknown as HTMLElement,
    latestView: () => view,
    getTool: () => armed,
    setTool: (t: ToolMode) => {
      armed = t;
    },
    setHover: () => {},
    toggleOverlay: () => {},
  } as unknown as InputHost;
  const system = {
    spaceHeld: false,
    placeDir: Direction.East,
    armedCrop: CropId.RussetPotato,
    manualWalkHeld: false,
  } as unknown as InputSystem;
  const pointer = new PointerInput(host, system);
  pointer.attach();
  const fire = (name: string, event: Record<string, unknown>) => {
    canvasListeners.get(name)!({ preventDefault: () => {}, pointerId: 1, ...event });
  };
  const pressAt = (tileX: number, tileY: number, button = 0) => {
    fire('pointerdown', {
      button,
      clientX: tileX * TILE_PX + TILE_PX / 2,
      clientY: tileY * TILE_PX + TILE_PX / 2,
    });
  };
  const releaseAt = (tileX: number, tileY: number, button = 0) => {
    fire('pointerup', {
      button,
      clientX: tileX * TILE_PX + TILE_PX / 2,
      clientY: tileY * TILE_PX + TILE_PX / 2,
    });
  };
  return { pointer, queue, pressAt, releaseAt, arm: (t: ToolMode) => host.setTool(t) };
}

// The cancellation wiring the pure pump cannot see: Esc, right-click, and a new gesture all
// pass through `PointerInput` itself.
describe('the work queue’s cancellation wiring ([[074]])', () => {
  /** Press a far tile with Plant: the press walks, the queue holds its errand, release. */
  function workingQueue(view: WorldView) {
    const h = harness(view, ToolMode.Plant);
    h.pressAt(2, 12);
    h.releaseAt(2, 12);
    expect(h.queue.drain()).toMatchObject([{ type: 'WalkAndAct', tileX: 2, tileY: 12 }]);
    expect(h.pointer.dragging).toBe(true); // the queue counts as the live gesture
    return h;
  }

  it('Esc cancels a working queue (matrix row: Esc)', () => {
    const h = workingQueue(standingOn(2, 2));
    h.pointer.cancelDrag();
    expect(h.pointer.dragging).toBe(false);
    h.pointer.update();
    expect(h.queue.drain()).toEqual([]);
  });

  it('right-click cancels it and does NOT fall through to maintenance', () => {
    const h = workingQueue(standingOn(2, 2));
    h.pressAt(2, 12, 2);
    expect(h.pointer.dragging).toBe(false);
    expect(h.queue.drain()).toEqual([]);
  });

  it('a new manual click replaces it — a new gesture means new intent', () => {
    const h = workingQueue(standingOn(2, 2));
    // A fresh press on an in-reach tile: its own click dispatches, the OLD queue is gone.
    h.pressAt(2, 3);
    h.releaseAt(2, 3);
    expect(h.queue.drain()).toMatchObject([{ type: 'PlantTile', tileX: 2, tileY: 3 }]);
    expect(h.pointer.dragging).toBe(false);
  });

  it('a WASD keypress after release cancels it', () => {
    const h = workingQueue(standingOn(2, 2));
    h.pointer.walkKeyPressed();
    expect(h.pointer.dragging).toBe(false);
  });

  it('arming a different tool cancels it on the next frame', () => {
    const h = workingQueue(standingOn(2, 2));
    h.arm(ToolMode.Harvest);
    h.pointer.update();
    expect(h.pointer.dragging).toBe(false);
  });

  it('the tell reads the queue while it works and clears when it is done', () => {
    const view = standingOn(2, 2);
    const h = workingQueue(view);
    expect(h.pointer.statusTell()).toBe('planting 1 more…');
    // The errand resolves and the pump retires the finished queue; the tell clears.
    view.tick += 1;
    h.pointer.update();
    h.pointer.update();
    expect(h.pointer.statusTell()).toBeNull();
  });
});

describe('the tell names a planter that wants no seed ([[098]])', () => {
  // **THE FAILURE THAT EXPLAINED ITSELF NOWHERE.** A planter dock with no zone wants no seed at
  // all, so every arm pointed at it declines to pick up (item 085) and every belt backs up —
  // and the entire visible evidence was one red lamp on the arm. This is what the player finds
  // when they follow that lamp downstream. The predicate mirrors `dockWantedSeed` off the two
  // fields the projection publishes; these pin the mirror, and the silence in the good cases,
  // which is the half a tell most easily gets wrong.

  function planter(boundZone: number, crop?: number): WorldView {
    const view = withMachine(standingOn(4, 4), 4, 5, MachineKind.PlanterDock, 9);
    view.machines[0]!.boundZone = boundZone;
    if (crop !== undefined) {
      view.zones.push({ id: boundZone, crop } as WorldView['zones'][number]);
    }
    return view;
  }

  const HOVER = { tileX: 4, tileY: 5 };

  it('says so when the dock has no zone at all', () => {
    expect(machineTell(planter(0), HOVER)).toBe('this planter has no zone — it wants no seed');
  });

  it('says so when the zone exists but nobody picked a crop', () => {
    expect(machineTell(planter(3, CropId.None), HOVER)).toBe(
      "this planter's zone has no crop — it wants no seed",
    );
  });

  it('says so when the bound zone is gone — a binding to nothing wants nothing', () => {
    expect(machineTell(planter(3), HOVER)).toBe(
      "this planter's zone has no crop — it wants no seed",
    );
  });

  it('is SILENT once the zone has a crop — a working planter is not a complaint', () => {
    expect(machineTell(planter(3, CropId.RussetPotato), HOVER)).toBeNull();
  });

  it('is silent about every other machine, and about bare ground', () => {
    const bay = withMachine(standingOn(4, 4), 4, 5, MachineKind.DroneBay, 11);
    expect(machineTell(bay, HOVER)).toBeNull();
    expect(machineTell(standingOn(4, 4), HOVER)).toBeNull();
    expect(machineTell(null, HOVER)).toBeNull();
    expect(machineTell(planter(0), null)).toBeNull();
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

// R's hover seam, now that belts answer it too ([[084]]). Driven through `PointerInput`
// with a stub host, exactly as the cancellation wiring above is: hover comes from a
// synthetic pointermove, and `rotateCommand` is the pure question the R key asks.
describe('what R acts on, with belts in the world ([[084]])', () => {
  function harness(view: WorldView) {
    const canvasListeners = new Map<string, (event: unknown) => void>();
    const canvas = {
      addEventListener: (name: string, fn: (event: unknown) => void) => {
        canvasListeners.set(name, fn);
      },
      removeEventListener: () => {},
      setPointerCapture: () => {},
      releasePointerCapture: () => {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 640 }),
    } as unknown as HTMLCanvasElement;
    const camera = {
      transform: { viewWidth: 640, viewHeight: 640, zoom: 1 },
      screenToWorld: (x: number, y: number) => ({ x, y }),
      worldToScreen: (x: number, y: number) => ({ x, y }),
    } as unknown as Camera;
    const host = {
      canvas,
      camera,
      queue: new CommandQueue(),
      overlayRoot: undefined as unknown as HTMLElement,
      latestView: () => view,
      getTool: () => ToolMode.Hand,
      setTool: () => {},
      setHover: () => {},
      toggleOverlay: () => {},
    } as unknown as InputHost;
    const system = {
      spaceHeld: false,
      placeDir: Direction.East,
      armedCrop: CropId.RussetPotato,
      manualWalkHeld: false,
    } as unknown as InputSystem;
    const pointer = new PointerInput(host, system);
    pointer.attach();
    const hoverAt = (tileX: number, tileY: number) => {
      canvasListeners.get('pointermove')!({
        preventDefault: () => {},
        pointerId: 1,
        clientX: tileX * TILE_PX + TILE_PX / 2,
        clientY: tileY * TILE_PX + TILE_PX / 2,
      });
    };
    return { pointer, hoverAt };
  }

  it('means RotateBelt over a placed belt tile, addressed by the hovered TILE', () => {
    const view = standingOn(2, 2);
    view.belts.push({ id: 3, tileX: 4, tileY: 2, dir: Direction.East, lengthTiles: 5 } as never);
    const h = harness(view);
    h.hoverAt(6, 2);
    expect(h.pointer.rotateCommand()).toEqual({ type: 'RotateBelt', tileX: 6, tileY: 2 });
  });

  it('still means RotateGrabber over an arm — the arm cannot share a tile with a belt', () => {
    const view = standingOn(2, 2);
    view.grabbers.push({ id: 5, tileX: 4, tileY: 2, dir: Direction.East } as never);
    const h = harness(view);
    h.hoverAt(4, 2);
    expect(h.pointer.rotateCommand()).toEqual({ type: 'RotateGrabber', grabberId: 5 });
  });

  // Item 120's picking rule, third surface. Until pipes went overhead this case could not
  // exist, and R's correctness here rested on a comment claiming a tile could hold only one
  // thing. It can hold two now, so the behaviour needs pinning as a DECISION: R acts on the
  // topmost thing that CAN turn, and a pipe is not one — there is no `RotatePipe`, because a
  // run is a set of tiles with no facing. Swallowing the key to honour "topmost" would be the
  // rule enforcing itself against the player for the sake of its own symmetry.
  it('is NOT intercepted by a pipe overhead: R turns the belt underneath ([[120]])', () => {
    const view = standingOn(2, 2);
    view.belts.push({ id: 3, tileX: 4, tileY: 2, dir: Direction.East, lengthTiles: 5 } as never);
    view.pipes.push({ id: 7, tileX: 6, tileY: 2, liquid: 1, network: 1 } as never);
    const h = harness(view);
    h.hoverAt(6, 2);
    expect(h.pointer.rotateCommand()).toEqual({ type: 'RotateBelt', tileX: 6, tileY: 2 });
  });

  it('still means the ghost over a junction: a machine, not a belt, and facing-less', () => {
    const view = standingOn(2, 2);
    view.machines.push({
      id: 9,
      kind: MachineKind.BeltJunction,
      tileX: 4,
      tileY: 2,
      tilesWide: 1,
      tilesHigh: 1,
    } as never);
    const h = harness(view);
    h.hoverAt(4, 2);
    expect(h.pointer.rotateCommand()).toBeNull();
  });

  it('still means the ghost over bare ground', () => {
    const h = harness(standingOn(2, 2));
    h.hoverAt(6, 6);
    expect(h.pointer.rotateCommand()).toBeNull();
  });
});

describe('the tell reads a barrel’s charges ([[097]])', () => {
  // The owner's second sentence on item 097: "this sprinkler should show how many charges they
  // have on hover on the bottom status bar." A charge is one ACTIVATION now — one whole 5×5
  // watered — so the count is a number a player can plan a walk around, which is exactly what
  // the millilitre ledger never was. What fails quietly here is the GATE: reading the count off
  // the kind rather than off `tankChargesMax` would print "0 of 0 charges" on every piped head
  // and the Irrigation Hub, which are ledger-fed and report 0 on purpose.

  function barrel(charges: number, max: number, kind: number = MachineKind.Sprinkler): WorldView {
    const view = withMachine(standingOn(4, 4), 4, 5, kind, 3);
    view.machines[0]!.tankCharges = charges;
    view.machines[0]!.tankChargesMax = max;
    return view;
  }

  const HOVER = { tileX: 4, tileY: 5 };

  it('says how many are left, over the ceiling the Capacity dial set', () => {
    expect(machineTell(barrel(9, 10), HOVER)).toBe('barrel — 9 of 10 charges');
    expect(machineTell(barrel(0, 10), HOVER)).toBe('barrel — 0 of 10 charges');
    expect(machineTell(barrel(14, 20), HOVER)).toBe('barrel — 14 of 20 charges');
  });

  it('is SILENT for a machine with no charges — the ledger-fed heads and the Hub', () => {
    expect(machineTell(barrel(0, 0, MachineKind.PipedSprinkler), HOVER)).toBeNull();
    expect(machineTell(barrel(0, 0, MachineKind.IrrigationHub), HOVER)).toBeNull();
    expect(machineTell(barrel(0, 0, MachineKind.Tank), HOVER)).toBeNull();
  });

  // These two are what make the gate provable. The three above happen to differ in KIND as
  // well as in `tankChargesMax`, so on their own they cannot tell a correct implementation
  // from one that switched on `MachineKind.Sprinkler` — a control run with the kind check
  // substituted left every one of them green. These do not: the flag is the flag, and the
  // whole point of the contract `view.ts` writes down is that it survives a second hand-filled
  // machine landing without this file being edited.
  it('is silent about a SPRINKLER that reports no charges — the flag outranks the kind', () => {
    expect(machineTell(barrel(0, 0, MachineKind.Sprinkler), HOVER)).toBeNull();
  });

  it('speaks for any machine that DOES report charges, whatever kind it is', () => {
    expect(machineTell(barrel(2, 4, MachineKind.Washer), HOVER)).toBe('barrel — 2 of 4 charges');
  });

  it('lets a complaint outrank a readout — nothing raises both today, and the order is fixed', () => {
    const planter = barrel(9, 10, MachineKind.PlanterDock);
    planter.machines[0]!.boundZone = 0;
    expect(machineTell(planter, HOVER)).toBe('this planter has no zone — it wants no seed');
  });
});

describe('clicking an arm opens its card ([[099]])', () => {
  // The rung item 099 added to the click ladder, checked in its real order by driving a real
  // press. What fails quietly: putting it BELOW `walkFallback` (the click would send the farmer
  // marching and never open the card), putting it ABOVE `primaryCommand` (every tool would stop
  // working over an arm's tile), or letting it fire on a tool that already had a verb there.

  function withArm(view: WorldView, tileX: number, tileY: number, id: number): WorldView {
    view.grabbers.push({
      id,
      tileX,
      tileY,
      dir: Direction.East,
      tier: GrabberTier.Mk2,
      filter: 0,
      held: 0,
    } as never);
    return view;
  }

  beforeEach(() => {
    resetGrabberPanel();
  });

  it('opens the card on the arm, and does not walk the farmer across the lot to it', () => {
    const view = withArm(owning(standingOn(2, 2)), 12, 12, 6);
    const h = harness(view, ToolMode.Hand);
    h.pressAt(12, 12);

    // Nothing queued: `SetGrabberFilter` is not reach-gated, so the trip buys nothing, and
    // the click that used to fall through to item 070's walk now has a meaning of its own.
    expect(h.queue.drain()).toEqual([]);
    publishGrabberPanel(view);
    expect(grabberPanelSnapshot().open).toBe(true);
    expect(grabberPanelSnapshot().grabberId).toBe(6);
  });

  it('leaves the ground beside it walking exactly as before', () => {
    const view = withArm(owning(standingOn(2, 2)), 12, 12, 6);
    const h = harness(view, ToolMode.Hand);
    h.pressAt(12, 11);

    expect(h.queue.drain()).toMatchObject([{ type: 'WalkAndAct', tileX: 12, tileY: 11 }]);
    publishGrabberPanel(view);
    expect(grabberPanelSnapshot().open).toBe(false);
  });

  it('does not fire for a tool that already has a verb over that tile', () => {
    const view = withArm(owning(standingOn(4, 4)), 4, 5, 6);
    const h = harness(view, ToolMode.Harvest);
    h.pressAt(4, 5);

    expect(h.queue.drain()).toMatchObject([{ type: 'HarvestTile', tileX: 4, tileY: 5 }]);
    publishGrabberPanel(view);
    expect(grabberPanelSnapshot().open).toBe(false);
  });

  it('leaves teardown a teardown: the rect gesture never reaches the click ladder', () => {
    const view = withArm(owning(standingOn(2, 2)), 4, 4, 6);
    const h = harness(view, ToolMode.Deconstruct);
    h.pressAt(4, 4);
    h.releaseAt(4, 4);

    expect(h.queue.drain()).toMatchObject([{ type: 'RemoveGrabber', grabberId: 6 }]);
    publishGrabberPanel(view);
    expect(grabberPanelSnapshot().open).toBe(false);
  });

  it('leaves R a rotate — the two verbs on an arm stay distinct', () => {
    const view = withArm(owning(standingOn(4, 4)), 4, 5, 6);
    const h = harness(view, ToolMode.Hand);
    h.pressAt(4, 5);
    expect(h.pointer.rotateCommand()).toEqual({ type: 'RotateGrabber', grabberId: 6 });
  });
});
