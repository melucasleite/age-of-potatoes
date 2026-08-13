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
import { CropId, IntentAction, ItemId, MachineKind, SUBTILE, createWorldView } from '@snack/sim';
import type { Command, WorldView } from '@snack/sim';

import { reachAdjusted } from './pointer';

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
function withMachine(view: WorldView, tileX: number, tileY: number, kind: number): WorldView {
  view.machines.push({
    id: 1,
    kind,
    tileX,
    tileY,
    tilesWide: 1,
    tilesHigh: 1,
  } as WorldView['machines'][number]);
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
