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

import { resolveFrameIcon } from '../../hud/item-art';

import { BUILD_CATALOGUE, BUILD_GRID_COLS, gridPlaces, moveGridCursor } from './build-menu';
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

describe('the maintenance chain rows ([[039]])', () => {
  // Presence is the one thing the generic gates above cannot check: a row that was never
  // added passes every per-row assertion by not being there. The three machines and their
  // tech gates are pinned against the sim's own specs — the generic tests then prove the
  // prices, footprints and gates are the sim's numbers and not typed twice.
  it('sells the station, the bay and the bench, behind their nodes', () => {
    const rows = new Map(BUILD_CATALOGUE.map((entry) => [entry.tool, entry]));
    const station = rows.get(ToolMode.PlaceMaintenanceStation);
    const bay = rows.get(ToolMode.PlaceDroneBay);
    const bench = rows.get(ToolMode.PlacePartsBench);

    expect(station?.requiresTech).toBe(machineSpec(MachineKind.MaintenanceStation)?.requiresTech);
    expect(bay?.requiresTech).toBe(machineSpec(MachineKind.DroneBay)?.requiresTech);
    expect(bench?.requiresTech).toBe(machineSpec(MachineKind.PartsBench)?.requiresTech);
    // One group, supply-chain order: station, bay, bench.
    expect(station?.group).toBe('Maintenance');
    expect(bay?.group).toBe('Maintenance');
    expect(bench?.group).toBe('Maintenance');
  });
});

/**
 * FIXTURE STORY: the two machines the art lane has not painted yet.
 *
 * The Drone Bay and the Parts Bench have no atlas frame AT ALL — the world itself draws them
 * procedurally (`render/textures.ts`, whose comment says "PLACEHOLDER: the art lane has
 * generated no `machine_drone_bay`"), so the menu cell falling back to the lettered chip is
 * the same honest degradation the bag already performs for them. They are PINNED here, both
 * ways: a NEW entry with no frame fails the test below (the "complete overall" criterion in
 * executable form), and the day the art lane ships these two frames, this list fails too —
 * which is the reminder to shorten it, not a bug.
 */
const KNOWN_FRAMELESS: readonly ToolMode[] = [ToolMode.PlaceDroneBay, ToolMode.PlacePartsBench];

describe('the build menu icons ([[071]])', () => {
  it('gives every entry a frame name, derived or declared', () => {
    for (const entry of BUILD_CATALOGUE) {
      expect(entry.frame, `${TOOL_INFO[entry.tool].label} names no frame`).not.toBe('');
    }
  });

  it('resolves every frame against the atlas, except the pinned art-lane gaps', () => {
    for (const entry of BUILD_CATALOGUE) {
      const label = TOOL_INFO[entry.tool].label;
      const source = resolveFrameIcon(entry.frame);
      if (KNOWN_FRAMELESS.includes(entry.tool)) {
        // Pinned in BOTH directions — see the fixture story above. `not.toBeNull` here would
        // pass silently forever; `toBeNull` makes the atlas landing the art tell us so.
        expect(source, `${label} has art now — remove it from KNOWN_FRAMELESS`).toBeNull();
      } else {
        expect(source, `${label} points at a frame the atlas does not have`).not.toBeNull();
      }
    }
  });

  it('derives machine frames from the spec slug, never from a hand-written table', () => {
    for (const entry of BUILD_CATALOGUE) {
      const kind = toolMachineKind(entry.tool);
      if (kind === null) continue;
      const slug = machineSpec(kind)!.slug.split('-').join('_');
      expect(entry.frame, `${TOOL_INFO[entry.tool].label} frame drifted from its slug`).toBe(
        `machine_${slug}`,
      );
    }
  });
});

describe('the build grid ([[071]])', () => {
  /** Three groups: five entries (a full row), then three, then seven (a row and a spill). */
  const rows = [
    ...Array.from({ length: 5 }, () => ({ group: 'A' })),
    ...Array.from({ length: 3 }, () => ({ group: 'B' })),
    ...Array.from({ length: 7 }, () => ({ group: 'C' })),
  ];

  it('starts every group at column zero, on its own row', () => {
    const places = gridPlaces(rows, 5);
    // Group A fills row 0 exactly; B must not share it even though A ended flush.
    expect(places[0]).toEqual({ row: 0, col: 0 });
    expect(places[4]).toEqual({ row: 0, col: 4 });
    expect(places[5]).toEqual({ row: 1, col: 0 }); // B
    expect(places[8]).toEqual({ row: 2, col: 0 }); // C, new row despite B's short row
    expect(places[12]).toEqual({ row: 2, col: 4 });
    expect(places[13]).toEqual({ row: 3, col: 0 }); // C spills
  });

  it('walks left and right through the whole catalogue in order, wrapping', () => {
    expect(moveGridCursor(rows, 5, 0, 'right')).toBe(1);
    expect(moveGridCursor(rows, 5, 14, 'right')).toBe(0);
    expect(moveGridCursor(rows, 5, 0, 'left')).toBe(14);
  });

  it('moves down to the nearest row, keeping the column where it can', () => {
    // From A's col 4 down to B, whose row only reaches col 2: caught, not refused.
    expect(moveGridCursor(rows, 5, 4, 'down')).toBe(7);
    // From B's col 1 down into C's full row: same column.
    expect(moveGridCursor(rows, 5, 6, 'down')).toBe(9);
    // Down off the bottom wraps to the top row, same column.
    expect(moveGridCursor(rows, 5, 14, 'up')).toBe(9);
    expect(moveGridCursor(rows, 5, 13, 'down')).toBe(0);
  });

  it('moves up off the top by wrapping to the bottom row', () => {
    // A col 0 up → C's spill row (the last row), which only has cols 0–1.
    expect(moveGridCursor(rows, 5, 0, 'up')).toBe(13);
    expect(moveGridCursor(rows, 5, 4, 'up')).toBe(14);
  });

  it('lays the real catalogue out inside the advertised columns', () => {
    const places = gridPlaces(BUILD_CATALOGUE, BUILD_GRID_COLS);
    expect(places.length).toBe(BUILD_CATALOGUE.length);
    for (const place of places) {
      expect(place.col).toBeGreaterThanOrEqual(0);
      expect(place.col).toBeLessThan(BUILD_GRID_COLS);
    }
    // Group boundaries in the real data start fresh rows, exactly as the synthetic ones do.
    for (let i = 1; i < BUILD_CATALOGUE.length; i++) {
      if (BUILD_CATALOGUE[i]!.group === BUILD_CATALOGUE[i - 1]!.group) continue;
      expect(places[i]!.col, `${BUILD_CATALOGUE[i]!.group} does not start its row`).toBe(0);
      expect(places[i]!.row).toBeGreaterThan(places[i - 1]!.row);
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
