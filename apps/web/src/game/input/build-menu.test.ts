// The cheap structural gate for the build catalogue.
//
// EVERY FAILURE THIS FILE CATCHES IS A ROW THAT LOOKS FINE. The build menu is a table pointing
// at three other tables — `ToolMode` → `TOOL_INFO` → the sim's `MachineSpec` — and a row that
// has fallen out of step with any of them still renders a label, a price and a hint. It simply
// arms nothing, or quotes a number nobody is charged, or builds a command the reducer discards
// without a sound. Nothing throws. Nothing looks wrong in a screenshot.
//
// So the assertions below all have the same shape: THE MENU IS CHECKED AGAINST THE SIM, never
// against itself. Comparing the catalogue's price to `TOOL_INFO`'s price would pass happily
// while both were wrong; comparing both to `machineSpec()` is the check that this file's whole
// "nothing here types a number that also lives in packages/sim" claim is still true.
//
// Pure data, no DOM and no Pixi — the catalogue is built at module scope from the sim's own
// balance tables, so importing it is the entire fixture.

import { describe, expect, it } from 'vitest';
import {
  Direction,
  MachineKind,
  SUBTILE,
  createWorldView,
  machineSpec,
  techSatisfied,
} from '@snack/sim';
import type { WorldView } from '@snack/sim';

import { BUILD_CATALOGUE } from './build-menu';
import { primaryCommand } from './pointer';
import { TOOL_INFO, ToolMode, toolFootprint, toolForMachineKind, toolMachineKind } from './tools';

/** Stand the farmer somewhere. Placement is not reach-gated, so anywhere will do. */
function standingOn(tileX: number, tileY: number): WorldView {
  const view = createWorldView();
  view.player.xSub = tileX * SUBTILE + SUBTILE / 2;
  view.player.ySub = tileY * SUBTILE + SUBTILE / 2;
  return view;
}

/**
 * The build catalogue, checked against the sim rather than against itself.
 *
 * WHAT FAILS QUIETLY HERE is a row that exists and cannot work. Every failure below leaves a
 * perfectly ordinary-looking menu entry — a label, a price, a hint — that either arms nothing,
 * quotes a number nobody will be charged, or builds a command the reducer throws away. None of
 * them throws, and none of them is visible until somebody clicks the row and watches their
 * money not move. Nine rows landed at once ([[056]] and the storage/orchard/bot machines),
 * which is exactly the situation where one of them is silently wrong.
 */
describe('the build catalogue', () => {
  const machineRows = BUILD_CATALOGUE.filter((entry) => toolMachineKind(entry.tool) !== null);

  it('arms a real machine kind on every row that claims to place one', () => {
    // A tool whose `MachineKind` the sim has never heard of has no spec, so it has no price
    // and no footprint: the row would quote "free" and the ghost would draw nothing.
    for (const entry of machineRows) {
      const kind = toolMachineKind(entry.tool)!;
      expect(machineSpec(kind), `${TOOL_INFO[entry.tool].label} names no machine`).not.toBeNull();
    }
  });

  it('quotes the sim price and the sim footprint, never a typed number', () => {
    for (const entry of machineRows) {
      const spec = machineSpec(toolMachineKind(entry.tool)!)!;
      const label = TOOL_INFO[entry.tool].label;
      expect(entry.costCents, `${label} is priced twice`).toBe(spec.priceCents);
      expect(TOOL_INFO[entry.tool].costCents, `${label} is priced twice`).toBe(spec.priceCents);
      expect(toolFootprint(entry.tool), `${label} has no ghost`).toEqual({
        tilesWide: spec.tilesWide,
        tilesHigh: spec.tilesHigh,
      });
    }
  });

  it('round-trips every placement tool through the inventory panel', () => {
    // `toolForMachineKind` is what a boxed row's Place button calls. A kind missing from
    // `PLACEMENT_TOOLS` puts a machine in the bag that cannot be taken back out — and the
    // failure is a dead button, not an error.
    for (const entry of machineRows) {
      const kind = toolMachineKind(entry.tool)!;
      expect(toolForMachineKind(kind), `${TOOL_INFO[entry.tool].label} cannot be unboxed`).toBe(
        entry.tool,
      );
    }
  });

  it('names a tech gate the sim actually has, or none at all', () => {
    for (const entry of BUILD_CATALOGUE) {
      if (entry.requiresTech === null) continue;
      // `techSatisfied` against the full unlock list: a slug the tech tree does not contain
      // would leave the row locked forever with no node anywhere that opens it.
      expect(
        techSatisfied([entry.requiresTech], entry.requiresTech),
        `${TOOL_INFO[entry.tool].label} needs a node that does not exist`,
      ).toBe(true);
    }
  });
});

describe('the belt junction tool', () => {
  it('places a junction with no direction, the way the sim wants it ([[056]])', () => {
    const view = standingOn(4, 4);
    expect(
      primaryCommand(view, { tileX: 9, tileY: 2 }, ToolMode.PlaceBeltJunction, Direction.East),
    ).toEqual({ type: 'PlaceMachine', kind: MachineKind.BeltJunction, tileX: 9, tileY: 2 });
  });

  it('is one tile, so the ghost is one tile', () => {
    expect(toolFootprint(ToolMode.PlaceBeltJunction)).toEqual({ tilesWide: 1, tilesHigh: 1 });
  });
});
