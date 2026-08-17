// Cheap structural gates for the maintenance card ([[129]]).
//
// The card is loud when it is wrong in the obvious ways — a button that does nothing is visible
// in one click. These are the parts that are NOT, and every one of them is a way for repair to
// go quietly missing right after the mouse button that used to do it was taken away:
//
//   · IF THE SUBJECT RULE ONLY TOOK BENCH MACHINES, the Sprinkler and the Maintenance Station
//     would have no manual repair route AT ALL — they wear, and neither the upgrade bench
//     (`acceptsUpgrades`) nor the dock card would ever adopt one. Nothing throws. The player
//     simply watches a sprinkler grind down with no way to touch it, having previously had one.
//   · IF THE DOCK CLAUSE WENT, a shed full of worn Agri-Bots would show no card, because a dock's
//     own `wearPerOperation` is 0. That is item 090's owner bug arriving a second time through a
//     different door.
//   · IF THE JAM BRANCH INVERTED, the button would send `RepairMachine` at a jammed machine — a
//     command the reducer takes and which does not clear the jam. A live control, a real command,
//     and a machine that stays stopped.
//   · IF THE KIT TILE WERE THE ORIGIN CORNER, the $8.00 button would quote a tile out of hand
//     reach on a 2×2 machine and be refused on arrival, silently.
//
// Nothing here renders. Whether the card looks right on screen is not something this file can
// know — the browser pass on item 129 is where that was checked.

import { describe, expect, it } from 'vitest';
import {
  CONDITION_MAX,
  HAND_REACH_SUBTILES,
  ItemId,
  LampState,
  MachineKind,
  REPAIR_KIT_RADIUS_TILES,
  SUBTILE,
  itemSpec,
} from '@snack/sim';
import type { WorldView } from '@snack/sim';

// Relative rather than the `@/` alias, exactly as every other test in this directory: vitest runs
// with no config in this repo, so the alias is not resolvable from a test.
import {
  KIT_RADIUS_TILES,
  createServiceFields,
  deriveService,
  serviceCommand,
  serviceable,
} from './derive-service';

const TILE = 6;
/** Subtile centre of a 1×1 machine standing at `TILE`. */
const CENTRE_SUB = TILE * SUBTILE + SUBTILE / 2;

interface Options {
  kind: number;
  tilesWide: number;
  tilesHigh: number;
  lamp: number;
  conditionPermille: number;
  wrenchDue: number;
  playerXSub: number;
  playerYSub: number;
  bots: { dockId: number; condition: number }[];
  kits: number;
}

function serviceView(options: Partial<Options> = {}): WorldView {
  return {
    player: {
      xSub: options.playerXSub ?? CENTRE_SUB,
      ySub: options.playerYSub ?? CENTRE_SUB,
    },
    machines: [
      {
        id: 7,
        kind: options.kind ?? MachineKind.Sprinkler,
        tileX: TILE,
        tileY: TILE,
        tilesWide: options.tilesWide ?? 1,
        tilesHigh: options.tilesHigh ?? 1,
        lamp: options.lamp ?? LampState.Off,
        conditionPermille: options.conditionPermille ?? 800,
        wrenchDue: options.wrenchDue ?? 0,
      },
    ],
    bots: (options.bots ?? []).map((bot, i) => ({ id: i + 1, ...bot })),
    inventory: options.kits === undefined ? [] : [{ item: ItemId.RepairKit, count: options.kits }],
  } as unknown as WorldView;
}

function serviceFor(options: Partial<Options> = {}) {
  return deriveService(serviceView(options), createServiceFields());
}

describe('whose card it is', () => {
  it('adopts a machine that wears, within arm’s reach', () => {
    const service = serviceFor();
    expect(service.machineId).toBe(7);
    expect(service.label).toBe('Sprinkler');
  });

  it('has no subject when the player has walked away', () => {
    const service = serviceFor({ playerXSub: CENTRE_SUB + HAND_REACH_SUBTILES * 4 });
    expect(service.machineId).toBe(0);
    expect(service.kitPriceCents).toBe(0);
  });

  /*
    THE TWO MACHINES THIS CARD EXISTS FOR. Neither accepts upgrades, so neither has ever had an
    upgrade bench; neither is a bot dock, so neither has a dock card. Both wear. Before this item
    they were repaired by right-click and by nothing else, and right-click now tears down.
  */
  it('takes the Sprinkler and the Maintenance Station, which have no other card', () => {
    expect(serviceFor({ kind: MachineKind.Sprinkler }).machineId).toBe(7);
    expect(serviceFor({ kind: MachineKind.MaintenanceStation }).machineId).toBe(7);
  });

  it('leaves a Tank alone — it cannot wear, so there is nothing to offer', () => {
    expect(serviceFor({ kind: MachineKind.Tank }).machineId).toBe(0);
    expect(serviceFor({ kind: MachineKind.SellBin }).machineId).toBe(0);
    expect(serviceFor({ kind: MachineKind.BeltJunction }).machineId).toBe(0);
  });

  it('takes a DOCK once its robots want a wrench, and not before ([[090]])', () => {
    // A dock's own wear is 0, so the only thing that can put this card on one is the sim's
    // `wrenchDue`, which folds in the shed's sleeping bots.
    expect(serviceFor({ kind: MachineKind.HarvesterDock, wrenchDue: 0 }).machineId).toBe(0);

    const wanted = serviceFor({
      kind: MachineKind.HarvesterDock,
      wrenchDue: 1,
      bots: [
        { dockId: 7, condition: CONDITION_MAX / 2 },
        { dockId: 7, condition: CONDITION_MAX },
        { dockId: 99, condition: 1 },
      ],
    });
    expect(wanted.machineId).toBe(7);
    // Only the worn bot in THIS shed. A full one and somebody else's are not this card's business.
    expect(wanted.botsWanting).toBe(1);
  });

  it('`serviceable` is the sim’s two facts and nothing else', () => {
    const wears = serviceView().machines[0]!;
    expect(serviceable(wears)).toBe(true);
    const tank = serviceView({ kind: MachineKind.Tank }).machines[0]!;
    expect(serviceable(tank)).toBe(false);
    expect(serviceable({ ...tank, wrenchDue: 1 })).toBe(true);
  });
});

describe('the two verbs, and the price on the button', () => {
  it('quotes the stand’s own list price for a kit, never a second copy of it', () => {
    const service = serviceFor({ kits: 2 });
    expect(service.kitPriceCents).toBe(itemSpec(ItemId.RepairKit)?.listPriceCents);
    expect(service.kitPriceCents).toBeGreaterThan(0);
    expect(service.kitsHeld).toBe(2);
  });

  it('counts an empty bag as an empty bag', () => {
    expect(serviceFor().kitsHeld).toBe(0);
  });

  it('says what the kit reaches, from the sim’s own radius', () => {
    expect(KIT_RADIUS_TILES).toBe(REPAIR_KIT_RADIUS_TILES);
  });

  /*
    THE BRANCH THAT MOVED HERE FROM THE MOUSE BUTTON, unchanged: `maintenanceCommand` whacked a
    jam before it tightened anything, and so does this. Inverting it produces a live button, an
    accepted command, and a machine that stays stopped.
  */
  it('whacks a jam before it tightens anything', () => {
    expect(serviceCommand(7, true)).toEqual({ type: 'WhackJam', machineId: 7 });
    expect(serviceCommand(7, false)).toEqual({ type: 'RepairMachine', machineId: 7 });
  });

  it('reads the jam off the lamp, which is where the projection puts it', () => {
    expect(serviceFor({ lamp: LampState.Jammed }).jammed).toBe(1);
    expect(serviceFor({ lamp: LampState.Running }).jammed).toBe(0);
  });

  it('goes quiet on the free button only when the reducer would refuse it', () => {
    // Worn: there is something to tighten.
    expect(serviceFor({ conditionPermille: 800 }).handUseful).toBe(1);
    // Full condition, nothing docked: `applyRepairMachine` returns false, so the button greys.
    expect(serviceFor({ conditionPermille: 1000 }).handUseful).toBe(0);
    // Full condition but a worn bot asleep inside: the reducer DOES accept that one.
    expect(
      serviceFor({
        kind: MachineKind.HarvesterDock,
        wrenchDue: 1,
        conditionPermille: 1000,
        bots: [{ dockId: 7, condition: 1 }],
      }).handUseful,
    ).toBe(1);
    // And a jam always has something to whack, however healthy the machine is.
    expect(serviceFor({ conditionPermille: 1000, lamp: LampState.Jammed }).handUseful).toBe(1);
  });
});

describe('where the kit gets spent', () => {
  it('is the machine’s own tile for a 1×1', () => {
    const service = serviceFor();
    expect(service.kitTileX).toBe(TILE);
    expect(service.kitTileY).toBe(TILE);
  });

  /*
    THE 2×2 TRAP. `applyUseRepairKit` reach-gates the TILE, and a 2×2 footprint is wider than a
    hand: standing at the far corner of a Fryer puts its ORIGIN tile past arm's length, so a
    button quoting the origin would be refused on arrival with no message at all. The nearest
    footprint tile is inside reach whenever the machine is, which is the condition this card
    already exists under.
  */
  it('is the corner NEAREST the player on a 2×2, not the origin', () => {
    const far = serviceFor({
      kind: MachineKind.Fryer,
      tilesWide: 2,
      tilesHigh: 2,
      // Standing off the machine's bottom-right corner.
      playerXSub: (TILE + 2) * SUBTILE,
      playerYSub: (TILE + 2) * SUBTILE,
    });
    expect(far.machineId).toBe(7);
    expect(far.kitTileX).toBe(TILE + 1);
    expect(far.kitTileY).toBe(TILE + 1);

    const near = serviceFor({
      kind: MachineKind.Fryer,
      tilesWide: 2,
      tilesHigh: 2,
      playerXSub: TILE * SUBTILE,
      playerYSub: TILE * SUBTILE,
    });
    expect(near.kitTileX).toBe(TILE);
    expect(near.kitTileY).toBe(TILE);
  });
});
