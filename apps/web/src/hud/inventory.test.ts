// Cheap structural gates for the bag.
//
// AGENTS.md keeps verification light, so this pins only the places where being wrong is
// INVISIBLE — and for an inventory panel that is every number on it, because a wrong figure
// beside a boxed machine looks exactly like a right one until the player presses Scrap:
//
//   · IF THE SCRAP PRICE IS COMPUTED HERE rather than read, it will disagree with the reducer
//     the day the payout ratio is re-balanced, and the player finds out by subtraction. This is
//     not hypothetical: the bench shipped with a local copy of the upgrade-cost formula, quoted
//     Efficiency at two thirds of the real price, and kept compiling (see the tombstone at the
//     end of `derive-tech.ts`). So the assertion is against the sim's own arithmetic, and a
//     re-balance moves both or fails here.
//   · IF A BOX WERE PRICED OFF `listPriceCents` it would read "$0" — every boxed row carries a
//     deliberate zero there so `computeNetWorthCents` does not double-count the invoice.
//   · IF THE PLACE CURSOR RESOLVED BY ARITHMETIC on the kind, a box would arm the wrong build
//     tool and put down a machine the player did not ask for. It is asked of `toolMachineKind`,
//     and a kind with no cursor yet reports -1 rather than guessing.
//   · IF THE VIEW'S POOLED BOX BUFFER WERE HELD RATHER THAN COPIED, a row would quietly start
//     describing somebody else's machine one publish later. That is the single nastiest bug
//     available in this file and it is invisible in every screenshot.
//   · IF THE BENCH'S BOXABLE MIRROR READ BACKWARDS, the one button that can create a box either
//     sits dead on a machine the sim would happily box, or offers itself on a jammed one.
//
// Nothing here renders. Whether the panel looks right on screen is not something this file can
// know — see the agent log on work item 054 for what was and was not checked in a running build.

import { describe, expect, it } from 'vitest';
import { ITEM_SPECS, ItemId, LampState, MachineKind, boxedMachineScrapCents } from '@snack/sim';
import type { WorldView } from '@snack/sim';

// Relative rather than the `@/` alias, exactly as `shop.test.ts` and `lot.test.ts` do: vitest
// runs with no config in this repo, so the alias is not resolvable from a test.
import { createInventoryFields, deriveInventory } from './derive-inventory';
import { createBenchFields, deriveBench } from './derive-tech';
import { ToolMode, toolMachineKind } from '../game/input/tools';

interface FakeBox {
  speedLevel: number;
  efficiencyLevel: number;
  capacityLevel: number;
  condition: number;
  investedCents: number;
  scrapCents: number;
}

function box(investedCents: number, levels: Partial<FakeBox> = {}): FakeBox {
  return {
    speedLevel: 0,
    efficiencyLevel: 0,
    capacityLevel: 0,
    condition: 1000,
    investedCents,
    // The sim computes this in `projectInventory`; the fixture computes it the sim's way rather
    // than typing a number, so the test cannot drift from the reducer either.
    scrapCents: boxedMachineScrapCents(investedCents),
    ...levels,
  };
}

interface FakeSlot {
  item: number;
  count: number;
  sellable: number;
  boxedMachineKind: number;
  boxes: FakeBox[];
}

function slot(item: number, count: number, options: Partial<FakeSlot> = {}): FakeSlot {
  return {
    item,
    count,
    sellable: 1,
    boxedMachineKind: 0,
    boxes: [],
    ...options,
  };
}

function viewWith(inventory: FakeSlot[]): WorldView {
  return { inventory } as unknown as WorldView;
}

function rows(inventory: FakeSlot[]) {
  return deriveInventory(viewWith(inventory), createInventoryFields()).rows;
}

describe('what is in the bag', () => {
  it('lists every slot the sim publishes, in the order it publishes them', () => {
    const list = rows([slot(ItemId.PotatoSeed, 8, { sellable: 0 }), slot(ItemId.RussetPotato, 3)]);
    expect(list.map((row) => row.id)).toEqual([ItemId.PotatoSeed, ItemId.RussetPotato]);
    expect(list[0]?.count).toBe(8);
  });

  it('prices a stack of goods off `listPriceCents`, never a table of its own', () => {
    const spec = ITEM_SPECS.find((candidate) => candidate.id === ItemId.RussetPotato);
    expect(spec).toBeDefined();
    const row = rows([slot(ItemId.RussetPotato, 4)])[0];
    expect(row?.stackValueCents).toBe((spec?.listPriceCents ?? 0) * 4);
  });

  it('reads `sellable` from the sim rather than deciding it', () => {
    const list = rows([slot(ItemId.PotatoSeed, 2, { sellable: 0 }), slot(ItemId.RussetPotato, 2)]);
    expect(list[0]?.sellable).toBe(0);
    expect(list[1]?.sellable).toBe(1);
  });

  it('drops a slot the world has emptied rather than drawing "0 russets"', () => {
    expect(rows([slot(ItemId.RussetPotato, 0)])).toHaveLength(0);
  });
});

describe('a boxed machine', () => {
  const fryer = () =>
    slot(ItemId.BoxedFryer, 2, {
      sellable: 0,
      boxedMachineKind: MachineKind.Fryer,
      boxes: [box(20_000), box(50_000, { speedLevel: 2, capacityLevel: 1, condition: 853 })],
    });

  it('pays what the SIM says it pays, per box', () => {
    const row = rows([fryer()])[0];
    expect(row?.boxes[0]?.scrapCents).toBe(boxedMachineScrapCents(20_000));
    expect(row?.boxes[1]?.scrapCents).toBe(boxedMachineScrapCents(50_000));
    // And the row's total is those two summed, not a second calculation over the invoices.
    expect(row?.scrapCents).toBe(boxedMachineScrapCents(20_000) + boxedMachineScrapCents(50_000));
  });

  it('is never priced off `listPriceCents`, which is a deliberate zero on every boxed row', () => {
    const spec = ITEM_SPECS.find((candidate) => candidate.id === ItemId.BoxedFryer);
    expect(spec?.listPriceCents).toBe(0);
    expect(rows([fryer()])[0]?.stackValueCents).toBe(0);
  });

  it('carries the dials and the wear of each box separately', () => {
    const boxes = rows([fryer()])[0]?.boxes ?? [];
    expect(boxes[0]?.speedLevel).toBe(0);
    expect(boxes[1]?.speedLevel).toBe(2);
    expect(boxes[1]?.capacityLevel).toBe(1);
    // 853 of 1000 condition, expressed in the permille every bar in this HUD draws from.
    expect(boxes[1]?.conditionPermille).toBe(853);
  });

  it("keeps the sim's order, so index 0 is the box both verbs consume next", () => {
    const boxes = rows([fryer()])[0]?.boxes ?? [];
    expect(boxes.map((entry) => entry.index)).toEqual([0, 1]);
    expect(boxes[0]?.investedCents).toBeLessThan(boxes[1]?.investedCents ?? 0);
  });

  it("COPIES the view's pooled box buffer instead of holding it", () => {
    const source = fryer();
    const row = rows([source])[0];
    // The projection reuses these objects between frames; a slice that aliased them would
    // silently start describing the next machine to be boxed.
    source.boxes[0]!.investedCents = 999_999;
    source.boxes.length = 0;
    expect(row?.boxes).toHaveLength(2);
    expect(row?.boxes[0]?.investedCents).toBe(20_000);
  });

  it('is tagged by kind, which is what makes it a machine row and not a good', () => {
    expect(rows([fryer()])[0]?.boxedKind).toBe(MachineKind.Fryer);
    expect(rows([slot(ItemId.RussetPotato, 1)])[0]?.boxedKind).toBe(0);
  });
});

describe('the place affordance', () => {
  it('arms the cursor that builds exactly this kind', () => {
    const row = rows([
      slot(ItemId.BoxedFryer, 1, {
        sellable: 0,
        boxedMachineKind: MachineKind.Fryer,
        boxes: [box(20_000)],
      }),
    ])[0];
    expect(row?.placeTool).toBe(ToolMode.PlaceFryer);
    // Stated as a property rather than as a literal: whatever tool is chosen, it must be the
    // one the input layer says builds a Fryer.
    expect(toolMachineKind(row?.placeTool as ToolMode)).toBe(MachineKind.Fryer);
  });

  it('reports -1 for a kind nothing in the UI builds, rather than guessing', () => {
    // THE PUMP USED TO BE THE FIXTURE HERE, AND [[101]] TOOK IT AWAY by giving the pipe a build
    // verb: with `ToolMode.PlacePump` in existence, `toolForMachineKind` finds it and this row
    // grew a working Place button, which is the entire point of that item. Every machine the
    // sim ships is buildable now except two, so the retired Parts Bench is the ONLY remaining
    // instance of this case — and it is the better fixture anyway, because [[090]] deliberately
    // kept `ItemId.BoxedPartsBench` alive ("a player who ran the parts line well may be holding
    // a warehouse of these") while removing every way to put one back down. A box in the bag
    // with no cursor is exactly what -1 is for.
    const row = rows([
      slot(ItemId.BoxedPartsBench, 1, {
        sellable: 0,
        boxedMachineKind: MachineKind.PartsBench,
        boxes: [box(80_000)],
      }),
    ])[0];
    expect(row?.placeTool).toBe(-1);
  });

  it('is -1 on an ordinary good, which has no cursor and no business having one', () => {
    expect(rows([slot(ItemId.RussetPotato, 1)])[0]?.placeTool).toBe(-1);
  });
});

// --- the one button that can create a box ------------------------------------------------

const FRYER_TILE = 4;
/** Subtile centre of the 2×2 Fryer standing at `FRYER_TILE`. (The Chip Kitchen played this
 * part until item 145 cut it; any machine with a work cycle serves — the bench's own gate.) */
const FRYER_CENTRE_SUB = 4 * 256 + 256;

function benchView(lamp: number): WorldView {
  return {
    player: { xSub: FRYER_CENTRE_SUB, ySub: FRYER_CENTRE_SUB },
    moneyCents: 1_000_000,
    unlocked: [],
    inventory: [],
    machines: [
      {
        id: 7,
        kind: MachineKind.Fryer,
        tileX: FRYER_TILE,
        tileY: FRYER_TILE,
        tilesWide: 2,
        tilesHigh: 2,
        lamp,
        conditionPermille: 900,
        speedLevel: 0,
        efficiencyLevel: 0,
        capacityLevel: 0,
      },
    ],
  } as unknown as WorldView;
}

function benchFor(lamp: number) {
  return deriveBench(benchView(lamp), createBenchFields());
}

describe('boxing from the bench', () => {
  it('refuses a machine that is turning, and says how to stop it', () => {
    const bench = benchFor(LampState.Running);
    expect(bench.boxable).toBe(0);
    expect(bench.boxBlocked).not.toBe('');
  });

  it('refuses a jam, and names the fix', () => {
    const bench = benchFor(LampState.Jammed);
    expect(bench.boxable).toBe(0);
    expect(bench.boxBlocked).toMatch(/whack/i);
  });

  it('allows a machine that is merely stopped — starved, blocked, or worn out', () => {
    // These are the three states an upgraded machine spends most of its life in, and the sim
    // boxes all of them: `isMachineWorking` is "would advance work this tick", never
    // `progress > 0`, which is the idle state of every machine with a Speed dial on it.
    expect(benchFor(LampState.Starved).boxable).toBe(1);
    expect(benchFor(LampState.Blocked).boxable).toBe(1);
    expect(benchFor(LampState.Halted).boxable).toBe(1);
    expect(benchFor(LampState.Starved).boxBlocked).toBe('');
  });
});
