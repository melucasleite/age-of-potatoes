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
  isMachineRetired,
  machineSpec,
  techSatisfied,
} from '@snack/sim';
import type { WorldView } from '@snack/sim';

import { resolveFrameIcon } from '../../hud/item-art';

import {
  BUILD_CATALOGUE,
  BUILD_GRID_COLS,
  armVerdict,
  buildRows,
  gridPlaces,
  moveGridCursor,
} from './build-menu';
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

describe('the maintenance rows ([[039]], [[090]], [[145]])', () => {
  // Presence is the one thing the generic gates above cannot check: a row that was never
  // added passes every per-row assertion by not being there. Down to one row: item 090
  // retired the Parts Bench, item 145 cut the Maintenance Station, so the Drone Bay is the
  // whole group and its gate is pinned against the sim's own spec.
  it('sells the bay, behind its node, and no station beside it', () => {
    const rows = new Map(BUILD_CATALOGUE.map((entry) => [entry.tool, entry]));
    const bay = rows.get(ToolMode.PlaceDroneBay);

    expect(bay?.requiresTech).toBe(machineSpec(MachineKind.DroneBay)?.requiresTech);
    expect(bay?.group).toBe('Maintenance');
    expect(rows.has(ToolMode.PlaceMaintenanceStation)).toBe(false);
    expect(toolMachineKind(ToolMode.PlaceMaintenanceStation)).toBe(null);
  });

  it('offers no row for a retired machine, and none at all for the Parts Bench', () => {
    // ABSENCE IS THE ASSERTION ([[090]]). The bench was the third row here until drones started
    // fixing machines for free; a catalogue that still listed it would be selling $800 of
    // scenery, and `applyPlaceMachine` would refuse the click anyway.
    for (const entry of BUILD_CATALOGUE) {
      const kind = toolMachineKind(entry.tool);
      if (kind === null) continue;
      expect(isMachineRetired(kind), `${TOOL_INFO[entry.tool].label} is retired`).toBe(false);
    }
    expect(BUILD_CATALOGUE.some((entry) => entry.tool === ToolMode.PlacePartsBench)).toBe(false);
    expect(toolMachineKind(ToolMode.PlacePartsBench)).toBe(null);
  });
});

// --- the coverage invariant ([[100]]) ------------------------------------------------------
//
// ────────────────────────────────────────────────────────────────────────────────────
//  THE TEST THAT WOULD HAVE CAUGHT FIFTEEN MACHINES AT ONCE, AND CAUGHT NONE OF THEM.
//
//  Every assertion above this line is PER ROW, and this file says so in its own words further
//  up: "a row that was never added passes every per-row assertion by not being there." That is
//  exactly what happened. `MachineKind` had 35 members and `toolMachineKind` had 18 cases; the
//  owner found it by playing — "there are a lot of items that exist in the research, but they
//  are not available to build" — and a sweep then proved the sim placed 34 of the 35 kinds
//  quite happily. The whole loss was in the input layer, and it was invisible here because
//  nothing in this file ever counted.
//
//  SO THE ASSERTION IS COVERAGE, AND THE ALLOWLIST IS THE FEATURE. Absence is only ever legal
//  when somebody has written down why, and the entry carries the reason in the same line the
//  test reads — which turns a silent hole into an enumerated debt with an item number on it.
//  Pinned in BOTH directions, exactly as `KNOWN_FRAMELESS` is: a kind that gains a row while
//  still on this list fails too, and that failure is the reminder to shorten the list rather
//  than a bug. When the list is down to the two permanent entries, every machine in the game
//  is buildable.
//
//  IT IS DOWN TO THE TWO PERMANENT ENTRIES. [[100]] wrote this list with twelve names on it and
//  [[101]] deleted ten of them in the same wave by giving the pipe a build verb. Both survivors
//  are rules rather than debts — one machine the world gives away and one the game stopped
//  selling — so a third name appearing here is news, and the comment beside it had better say
//  which item is going to remove it again.
// ────────────────────────────────────────────────────────────────────────────────────

interface Exemption {
  readonly kind: MachineKind;
  /** Why this machine has no build row. Read aloud in the failure message. */
  readonly why: string;
}

const NO_BUILD_ROW: readonly Exemption[] = [
  // --- permanent, and neither of these is an oversight -------------------------------------
  {
    kind: MachineKind.SellBin,
    why: 'the world spawns it at creation — it is a gift, not a purchase',
  },
  {
    kind: MachineKind.PartsBench,
    why: 'retired by [[090]]; `applyPlaceMachine` refuses it and `isMachineRetired` says so',
  },

  // --- the pipe-dependent ten went here, and [[101]] took them out --------------------------
  //
  // The deferral was [[056]]'s and it was right: "Pipes/pump/tank/soda line stay unbuildable
  // pending a pipe-run drag gesture — a Pump you cannot plumb is worse than none." What made it
  // a bug rather than a plan is that the research tree kept selling all six HYDRAULICS nodes at
  // full price, $6,100 of them, under a footer reading EVERY NODE UNLOCKS SOMETHING YOU CAN DO.
  // `ToolMode.PlacePipe` is the gesture, so the condition the deferral named is met and the ten
  // names below it are gone. Leave this paragraph: it is the only record of why they were here.
];

describe('every machine the sim ships ([[100]])', () => {
  const kinds = Object.values(MachineKind) as MachineKind[];
  const rowFor = new Map<number, ToolMode>();
  for (const entry of BUILD_CATALOGUE) {
    const kind = toolMachineKind(entry.tool);
    if (kind !== null) rowFor.set(kind, entry.tool);
  }
  const exempt = new Map(NO_BUILD_ROW.map((item) => [item.kind as number, item.why]));

  it('has a build row, or an exemption that says why not', () => {
    const orphans: string[] = [];
    for (const kind of kinds) {
      if (rowFor.has(kind)) continue;
      if (exempt.has(kind)) continue;
      orphans.push(`${machineSpec(kind)?.slug ?? kind} (kind ${kind})`);
    }
    // ONE MESSAGE LISTING ALL OF THEM rather than a failure per kind: the thing that went
    // wrong here was a count, and a reader who sees eleven slugs in one line understands the
    // shape of the bug in a way eleven separate red lines do not.
    expect(orphans, `unbuildable with no exemption: ${orphans.join(', ')}`).toEqual([]);
  });

  it('keeps no exemption for a machine that has since become buildable', () => {
    for (const item of NO_BUILD_ROW) {
      const tool = rowFor.get(item.kind);
      expect(
        tool === undefined,
        `${machineSpec(item.kind)?.slug} is buildable now — drop its exemption ("${item.why}")`,
      ).toBe(true);
    }
  });

  it('exempts every retired kind, and exempts nothing else that the sim would refuse', () => {
    // The two halves of the list have different lifetimes and the difference matters: a RETIRED
    // kind can never come back (`applyPlaceMachine` reads `isMachineRetired`), while a deferred
    // one is waiting on work that has an item number. Anything the sim outright refuses must be
    // in here; anything else in here is a debt, not a rule.
    for (const kind of kinds) {
      if (!isMachineRetired(kind)) continue;
      expect(exempt.has(kind), `${machineSpec(kind)?.slug} is retired and must be exempt`).toBe(
        true,
      );
    }
  });

  it('gives every exemption a reason worth reading', () => {
    for (const item of NO_BUILD_ROW) {
      expect(
        item.why.length,
        `${machineSpec(item.kind)?.slug} is exempt for no stated reason`,
      ).toBeGreaterThan(20);
    }
  });
});

/**
 * FIXTURE STORY: the two machines the art lane has not painted yet.
 *
 * The Drone Bay has no atlas frame AT ALL — the world itself draws it procedurally
 * (`render/textures.ts`, whose comment says "PLACEHOLDER: the art lane has generated no
 * `machine_drone_bay`"), so the menu cell falling back to the lettered chip is the same honest
 * degradation the bag already performs for it. It is PINNED here, both ways: a NEW entry with
 * no frame fails the test below (the "complete overall" criterion in executable form), and the
 * day the art lane ships that frame, this list fails too — which is the reminder to shorten it,
 * not a bug.
 *
 * It was a list of two until [[090]] retired the Parts Bench off the menu entirely, which is
 * the other way an entry leaves this list.
 *
 * The two packers joined it in [[100]] and for a different reason from the bay's: nobody
 * decided to draw them procedurally, the art lane simply has no `machine_six_packer` or
 * `machine_combo_packer` in `art/manifest.json` yet. The WORLD is fine either way —
 * `registerMachinePlaceholders` synthesises a body for any kind — so what degrades is this
 * menu cell, to a lettered chip, because `resolveFrameIcon` is a bare manifest lookup. A
 * lettered chip on a machine you can buy beats a machine you cannot buy at all, which is the
 * trade [[100]] is making; the frames are an art-lane errand and this list is the reminder.
 */
const KNOWN_FRAMELESS: readonly ToolMode[] = [
  // EMPTY, and the emptiness is the assertion: every row in the catalogue resolves against
  // the atlas. [[101]] left three names here; the art lane drew two ([[071]]'s degradation
  // working as designed), the Artesian Well retired with [[140]], and the last holdout — the
  // Recirculator, still unpainted — was cut outright by [[145]], taking its catalogue row and
  // its art-lane errand with it. A new name appearing here is news, and the comment beside it
  // had better say which item is going to remove it again.
];

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

// --- what a click on a locked cell does now ([[148]]) --------------------------------------
//
// WHAT FAILS QUIETLY HERE is the old behaviour coming back: `armMenuIndex` refusing a
// tech-locked cell in silence. That was never an error — it was a deliberate early return —
// so no assertion elsewhere would notice it returning, and the feature would degrade to
// exactly the dead click the owner reported. The decision is a pure function (`armVerdict`)
// for the same reason `escapeRung` is one, and these pin all three verdicts plus the slug
// threading the research verdict depends on.

describe('arming a locked cell opens the manual ([[148]])', () => {
  it('threads every catalogue entry’s tech slug into its row, untranslated', () => {
    // The verdict hands this slug to the tech panel as a NODE ID — a label ("needs Belts")
    // would send the panel hunting for a node called Belts, which does not exist.
    const rows = buildRows(null);
    for (let i = 0; i < BUILD_CATALOGUE.length; i++) {
      expect(rows[i]!.requiresTech).toBe(BUILD_CATALOGUE[i]!.requiresTech);
    }
  });

  it('sends a tech-locked row to research, carrying the node that locks it', () => {
    // A fresh world owns no tech, so every gated row is locked with its slug attached.
    const rows = buildRows(createWorldView());
    const locked = rows.filter((row) => row.locked && row.requiresTech !== null);
    expect(locked.length).toBeGreaterThan(0);
    for (const row of locked) {
      expect(armVerdict(row)).toEqual({ act: 'research', techId: row.requiresTech });
    }
  });

  it('arms an unlocked row exactly as before', () => {
    const rows = buildRows(createWorldView());
    const zones = rows.find((row) => row.tool === ToolMode.PaintZone);
    expect(zones?.locked).toBe(false);
    expect(armVerdict(zones)).toEqual({ act: 'arm' });

    // And a gated row whose node is OWNED arms too — the verdict reads the lock, never the
    // slug's mere presence.
    const view = createWorldView();
    const fryerTech = BUILD_CATALOGUE.find(
      (entry) => entry.tool === ToolMode.PlaceFryer,
    )!.requiresTech!;
    view.unlocked.push(fryerTech);
    const fryer = buildRows(view).find((row) => row.tool === ToolMode.PlaceFryer);
    expect(fryer?.locked).toBe(false);
    expect(armVerdict(fryer)).toEqual({ act: 'arm' });
  });

  it('keeps the sold-out deed a silent no-op — there is nothing to research about it', () => {
    const view = createWorldView();
    view.land.nextPriceCents = -1; // the world owns every parcel
    const deed = buildRows(view).find((row) => row.tool === ToolMode.BuyDeed);
    expect(deed?.locked).toBe(true);
    expect(deed?.lockReason).toBe('the whole lot is yours');
    expect(deed?.requiresTech).toBeNull();
    expect(armVerdict(deed)).toEqual({ act: 'refuse' });
  });

  it('refuses an index off the end of the menu', () => {
    expect(armVerdict(undefined)).toEqual({ act: 'refuse' });
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
