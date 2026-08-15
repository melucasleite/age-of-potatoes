// The first-run guide signs (item 040, instruction 2).
//
// Everything here fails quietly in production: a sign that never appears teaches nobody,
// and a sign that never leaves nags forever — neither throws. So the tests pin the gates,
// which are all facts the save already carries:
//
//   · a world with untouched hands points at the field, and stops on the first touch;
//   · a hand harvest that has never been sold points at the stand;
//   · a dry can before the first sale points at the pond;
//   · the first sale ends the whole first run, forever — including after a reload,
//     because `itemsSold` is world state and not a renderer flag.
//
// The digit resolver is injected so the tests do not depend on the hotbar singleton's
// layout (which persists in localStorage and belongs to the player).

import { describe, expect, it } from 'vitest';
import { MachineKind, createWorldView } from '@snack/sim';
import type { WorldView } from '@snack/sim';

import { firstRunSigns } from './first-run';
import { ToolMode } from './tools';

const digits = (tool: ToolMode): string =>
  tool === ToolMode.Plant ? '3' : tool === ToolMode.Water ? '2' : '';

/** A view with a sell bin standing at (20, 12). */
function withBin(view: WorldView): WorldView {
  view.machines.push({
    id: 1,
    kind: MachineKind.SellBin,
    tileX: 20,
    tileY: 12,
    tilesWide: 1,
    tilesHigh: 1,
  } as WorldView['machines'][number]);
  return view;
}

function withPond(view: WorldView): WorldView {
  view.reservoirs.push({
    tileX: 2,
    tileY: 2,
    tilesWide: 3,
    tilesHigh: 3,
  } as WorldView['reservoirs'][number]);
  return view;
}

describe('firstRunSigns', () => {
  it('points a fresh world at the field, with the plant digit', () => {
    const view = createWorldView();
    const signs = firstRunSigns(view, digits);
    expect(signs).toHaveLength(1);
    expect(signs[0]!.title).toBe('YOUR FIELD');
    expect(signs[0]!.body).toContain('press 3');
    // Hung below the field, arrow up — everything above the field's lower edge hides
    // behind the HUD's left rail at the spawn camera (see first-run.ts).
    expect(signs[0]!.tileX).toBe(view.field.originX + view.field.tilesWide / 2);
    expect(signs[0]!.tileY).toBe(view.field.originY + view.field.tilesHigh + 0.5);
    expect(signs[0]!.below).toBe(true);
  });

  it('drops the digit clause when the tool is somehow off the bar', () => {
    const signs = firstRunSigns(createWorldView(), () => '');
    expect(signs).toHaveLength(1);
    expect(signs[0]!.body).not.toContain('press');
  });

  it('retires the field sign on the first manual touch', () => {
    const view = createWorldView();
    view.stats.totalManualTouches = 1;
    view.player.canCharges = 8;
    expect(firstRunSigns(view, digits)).toHaveLength(0);
  });

  it('says nothing mid-loop — fewer than one sign is legal', () => {
    // Touched, nothing harvested, can not empty: the world speaks for itself.
    const view = withPond(withBin(createWorldView()));
    view.stats.totalManualTouches = 5;
    view.player.canCharges = 3;
    expect(firstRunSigns(view, digits)).toHaveLength(0);
  });

  it('points an unsold harvest at the stand', () => {
    const view = withBin(createWorldView());
    view.stats.totalManualTouches = 12;
    view.stats.itemsHarvestedByHand = 4;
    view.player.canCharges = 8;
    const signs = firstRunSigns(view, digits);
    expect(signs).toHaveLength(1);
    expect(signs[0]!.title).toBe('THE STAND');
    expect(signs[0]!.tileX).toBe(20.5);
    expect(signs[0]!.tileY).toBe(12);
  });

  it('the stand outranks the pond when both apply', () => {
    const view = withPond(withBin(createWorldView()));
    view.stats.totalManualTouches = 12;
    view.stats.itemsHarvestedByHand = 4;
    view.player.canCharges = 0;
    const signs = firstRunSigns(view, digits);
    expect(signs).toHaveLength(1);
    expect(signs[0]!.title).toBe('THE STAND');
  });

  it('points a dry can at the pond, with the water digit', () => {
    const view = withPond(createWorldView());
    view.stats.totalManualTouches = 3;
    view.player.canCharges = 0;
    const signs = firstRunSigns(view, digits);
    expect(signs).toHaveLength(1);
    expect(signs[0]!.title).toBe('THE POND');
    expect(signs[0]!.body).toContain('press 2');
  });

  it('a world with no pond never points at one', () => {
    const view = createWorldView();
    view.stats.totalManualTouches = 3;
    view.player.canCharges = 0;
    expect(firstRunSigns(view, digits)).toHaveLength(0);
  });

  it('the first sale ends the first run, whatever else is true', () => {
    const view = withPond(withBin(createWorldView()));
    view.stats.itemsSold = 1;
    // Every other gate armed at once: untouched hands, harvest in hand, dry can.
    view.stats.totalManualTouches = 0;
    view.stats.itemsHarvestedByHand = 4;
    view.player.canCharges = 0;
    expect(firstRunSigns(view, digits)).toHaveLength(0);
  });

  it('a null view yields nothing', () => {
    expect(firstRunSigns(null, digits)).toHaveLength(0);
  });
});
