// Cheap structural gates for the Agri-Bot dock card.
//
// The card exists because `SetDockZone` had no surface at all ([[038]]), so most of what could go
// wrong here is loud — a button that does nothing is visible in one click. These are the parts
// that are NOT:
//
//   · IF THE UNKNOWN BINDING WERE FOLDED INTO "UNBOUND", the card would print "No zone. Its bot
//     has nothing to do" over a dock whose robot is visibly crossing the field. `MachineView` does
//     not publish `Machine.boundZone` on this build (see `dockZoneOf`), and the whole design of
//     the read is that a missing field reports a THIRD state rather than the wrong one of two.
//   · IF THE READ BROKE WHEN THE FIELD LANDS, the handoff would be a silent regression instead of
//     a feature switching on: the same function has to keep working when `boundZone` is published.
//   · IF THE REACH TEST DRIFTED from the bench's, a card would offer a command the sim refuses, or
//     fail to appear on a dock the player is plainly standing on.
//   · IF `regrows` WERE A LIST OF CROP IDS kept on this side, §5's whole pacing argument would be
//     wrong the first time a crop was added — the harvester's one-shot warning is read off
//     `CropSpec.regrowTicks` or it is a lie waiting to happen.
//   · IF THE ZONE SWATCH DISAGREED with the overlay's, the button would point at the wrong
//     rectangle. The palette is copied from `render/zones.ts` (that module cannot be imported here
//     — it pulls Pixi), so the rule it is copied from is pinned instead.
//
// Nothing here renders. Whether the card looks right on screen is not something this file can
// know — see the agent log on 038.

import { describe, expect, it } from 'vitest';
import { CropId, HAND_REACH_SUBTILES, MachineKind, SUBTILE } from '@snack/sim';
import type { WorldView } from '@snack/sim';

// Relative rather than the `@/` alias, exactly as every other test in this directory: vitest runs
// with no config in this repo, so the alias is not resolvable from a test.
import { ZONE_UNKNOWN, createDockFields, deriveDock, zoneSwatch } from './derive-dock';

const DOCK_TILE = 6;
/** Subtile centre of the 2×2 dock standing at `DOCK_TILE`. */
const DOCK_CENTRE_SUB = DOCK_TILE * SUBTILE + SUBTILE;

interface FakeZone {
  id: number;
  name: string;
  crop: number;
  tiles: number;
  planted: number;
  mature: number;
}

function zone(id: number, options: Partial<FakeZone> = {}): FakeZone {
  return {
    id,
    name: `Zone ${String(id)}`,
    crop: CropId.RussetPotato,
    tiles: 12,
    planted: 8,
    mature: 3,
    ...options,
  };
}

interface DockOptions {
  kind: number;
  /** Omitted entirely on the current build — `MachineView` has no such field. */
  boundZone?: number;
  playerSub: number;
  zones: FakeZone[];
  bots: { id: number; dockId: number; phase: number; conditionPermille: number }[];
}

function dockView(options: Partial<DockOptions> = {}): WorldView {
  const machine: Record<string, number> = {
    id: 11,
    kind: options.kind ?? MachineKind.HarvesterDock,
    tileX: DOCK_TILE,
    tileY: DOCK_TILE,
    tilesWide: 2,
    tilesHigh: 2,
  };
  if (options.boundZone !== undefined) machine.boundZone = options.boundZone;

  const at = options.playerSub ?? DOCK_CENTRE_SUB;
  return {
    player: { xSub: at, ySub: DOCK_CENTRE_SUB },
    machines: [machine],
    zones: options.zones ?? [],
    bots: options.bots ?? [],
  } as unknown as WorldView;
}

function dockFor(options: Partial<DockOptions> = {}) {
  return deriveDock(dockView(options), createDockFields());
}

describe('finding the dock you are standing at', () => {
  it('has no subject when the player is nowhere near one', () => {
    const dock = dockFor({ playerSub: DOCK_CENTRE_SUB + HAND_REACH_SUBTILES * 4 });
    expect(dock.machineId).toBe(0);
    // And it hands back an empty zone list, which is what keeps the slice from churning while
    // the player walks around a farm full of zones.
    expect(dock.zones).toHaveLength(0);
  });

  it("adopts a dock within arm's reach and names it", () => {
    const dock = dockFor();
    expect(dock.machineId).toBe(11);
    expect(dock.label).toBe('Harvester Dock');
  });

  it('knows the planter by its seed hopper rather than by its kind', () => {
    expect(dockFor({ kind: MachineKind.HarvesterDock }).planter).toBe(0);
    expect(dockFor({ kind: MachineKind.PlanterDock }).planter).toBe(1);
  });

  it('ignores a machine that is not a dock at all', () => {
    const view = {
      player: { xSub: DOCK_CENTRE_SUB, ySub: DOCK_CENTRE_SUB },
      machines: [
        {
          id: 4,
          kind: MachineKind.Fryer,
          tileX: DOCK_TILE,
          tileY: DOCK_TILE,
          tilesWide: 2,
          tilesHigh: 2,
        },
      ],
      zones: [],
      bots: [],
    } as unknown as WorldView;
    expect(deriveDock(view, createDockFields()).machineId).toBe(0);
  });
});

describe('what the dock has been told', () => {
  // THE HANDOFF, PINNED FROM BOTH SIDES. `MachineView` does not carry `Machine.boundZone` today.
  it('reports "the view did not say" rather than "no zone" when the field is absent', () => {
    expect(dockFor({ zones: [zone(1)] }).boundZone).toBe(ZONE_UNKNOWN);
    expect(ZONE_UNKNOWN).not.toBe(0);
  });

  it('reads the binding the moment the projection publishes one', () => {
    const dock = dockFor({ boundZone: 2, zones: [zone(1), zone(2, { name: 'North Field' })] });
    expect(dock.boundZone).toBe(2);
    expect(dock.boundName).toBe('North Field');
  });

  it('distinguishes a dock with no orders from a build that cannot tell', () => {
    const dock = dockFor({ boundZone: 0, zones: [zone(1)] });
    expect(dock.boundZone).toBe(0);
    expect(dock.boundName).toBe('');
  });

  it('leaves the name empty when the bound zone has been deleted out from under it', () => {
    const dock = dockFor({ boundZone: 9, zones: [zone(1)] });
    expect(dock.boundZone).toBe(9);
    expect(dock.boundName).toBe('');
  });
});

describe('the zones it can be pointed at', () => {
  it('offers every zone the world has, including one nobody has planted', () => {
    const dock = dockFor({
      zones: [zone(1), zone(2, { crop: CropId.None, planted: 0, mature: 0 })],
    });
    expect(dock.zones.map((option) => option.id)).toEqual([1, 2]);
    expect(dock.zones[1]?.cropName).toBe('');
    expect(dock.zones[1]?.planted).toBe(0);
  });

  it("names the crop off the sim's own spec", () => {
    expect(dockFor({ zones: [zone(1)] }).zones[0]?.cropName).toBe('Russet Potato');
  });

  // §5: "regrowing crops automate first; one-shots wait for the seed-hopper bot". This is that
  // sentence as an assertion, read off `regrowTicks` rather than a table of ids kept here.
  it('reads regrowth off the crop rather than listing which crops regrow', () => {
    const potato = dockFor({ zones: [zone(1, { crop: CropId.RussetPotato })] });
    expect(potato.zones[0]?.regrows).toBe(0);

    const regrowing = dockFor({ zones: [zone(1, { crop: CropId.ChiliPepper })] });
    expect(regrowing.zones[0]?.regrows).toBe(1);
  });
});

describe('the bot in the shed', () => {
  it('describes the robot belonging to THIS dock, not the first one on the lot', () => {
    const dock = dockFor({
      bots: [
        { id: 1, dockId: 99, phase: 2, conditionPermille: 400 },
        { id: 2, dockId: 11, phase: 1, conditionPermille: 910 },
      ],
    });
    expect(dock.botPhase).toBe(1);
    expect(dock.botConditionPermille).toBe(910);
  });

  it('says there is no bot rather than reporting a phase of zero, which means idle', () => {
    // Idle IS phase 0, so "no bot" cannot share that value — the card would call an absent robot
    // a parked one, which is the difference between "buy a dock" and "go and find it".
    expect(dockFor({ bots: [] }).botPhase).toBe(-1);
  });
});

describe('the zone swatch', () => {
  it('wraps by id the way the overlay does, so button and ground agree', () => {
    expect(zoneSwatch(1)).toBe(zoneSwatch(9));
    expect(zoneSwatch(2)).toBe(zoneSwatch(10));
    expect(zoneSwatch(1)).not.toBe(zoneSwatch(2));
  });

  it('has a colour for every zone id, however high', () => {
    for (let id = 1; id <= 40; id++) expect(zoneSwatch(id)).toMatch(/^#[0-9a-f]{6}$/);
  });
});
