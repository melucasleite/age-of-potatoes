// The grabber card's reading half, and the seam that holds one open.
//
// Verification here is deliberately narrow (AGENTS.md: "if it works, it works"), so this pins
// only what fails QUIETLY — the cases where the panel renders, nobody sees a stack trace, and
// the player is simply given the wrong choices:
//
//   · WHICH TILE THE ARM READS. `-dir × reachTiles` is one line and a quarter-turn of drift
//     would offer the player the contents of the DESTINATION as things to pick up, which is
//     both plausible-looking and exactly backwards. Walked over all four facings and both
//     reaches.
//   · THE Mk1 GATE. `filterable` false is what makes the card explain itself instead of
//     drawing a grid; get it wrong and the card dispatches a command the reducer throws away,
//     which looks to the player like a button that does nothing.
//   · THE HARVESTER DOCK'S TWO SHELVES, because a dock's `outputItem` is 0 and the naive read
//     offers nothing at the one machine where the whole feature matters.
//   · THE GRID NOT MOVING UNDER THE CURSOR. `mergeCandidates` is what stops a belt emptying
//     mid-aim from reshuffling every cell.

import { beforeEach, describe, expect, it } from 'vitest';
import { Direction, GrabberTier, ItemId, MachineKind, createWorldView } from '@snack/sim';
import type { WorldView } from '@snack/sim';

import {
  ArmSource,
  grabberCard,
  grabberCardTarget,
  lotItems,
  mergeCandidates,
} from './grabber-card';
import {
  grabberClicked,
  grabberPanelClose,
  grabberPanelSnapshot,
  publishGrabberPanel,
  resetGrabberPanel,
} from './grabber-panel';
import { ToolMode } from './tools';

/** One arm on a tile. `dir` is the way goods FLOW: it takes from `-dir`. */
function withArm(
  view: WorldView,
  tileX: number,
  tileY: number,
  dir: number,
  tier: number,
  filter = 0,
  id = 1,
): WorldView {
  view.grabbers.push({
    id,
    tileX,
    tileY,
    dir,
    tier,
    filter,
    held: 0,
    swingPermille: 0,
    opCount: 0,
    lamp: 0,
  } as WorldView['grabbers'][number]);
  return view;
}

/** A one-tile machine. Only the fields the candidate read touches are set. */
function withMachine(
  view: WorldView,
  tileX: number,
  tileY: number,
  kind: number,
  fields: Partial<WorldView['machines'][number]> = {},
): WorldView {
  view.machines.push({
    id: view.machines.length + 1,
    kind,
    tileX,
    tileY,
    tilesWide: 1,
    tilesHigh: 1,
    outputItem: 0,
    overcookedItem: 0,
    cargoItem: 0,
    seedShelfItem: 0,
    ...fields,
  } as WorldView['machines'][number]);
  return view;
}

/** A straight belt segment carrying `items`, in the order they ride. */
function withBelt(
  view: WorldView,
  tileX: number,
  tileY: number,
  dir: number,
  lengthTiles: number,
  items: number[],
): WorldView {
  view.belts.push({
    id: view.belts.length + 1,
    tileX,
    tileY,
    dir,
    lengthTiles,
    tier: 1,
    itemCount: items.length,
    itemDist: items.map((_, i) => i),
    itemType: items.slice(),
    throughputSubtilesPer100Ticks: 0,
  } as WorldView['belts'][number]);
  return view;
}

describe('grabberCard — which tile the arm reads', () => {
  // The arm sits at (5,5). Facing east it drops east and takes from (4,5); facing north it
  // drops north and takes from (5,6). A reversed sign would read the destination instead.
  const CASES: readonly { dir: number; sourceX: number; sourceY: number }[] = [
    { dir: Direction.East, sourceX: 4, sourceY: 5 },
    { dir: Direction.West, sourceX: 6, sourceY: 5 },
    { dir: Direction.North, sourceX: 5, sourceY: 6 },
    { dir: Direction.South, sourceX: 5, sourceY: 4 },
  ];

  // TRACER DYE, AND IT IS READ BY PRESENCE RATHER THAN BY EQUALITY (item 111). Each machine
  // below is given an `outputItem` its kind could never actually make, so a candidate list
  // that contains one names the tile it was read from. The lists stopped being singletons the
  // day a machine could make several things — a Fryer now offers plain AND gold chips —
  // which is real behaviour and not the claim these four cases are about. Asserting that the
  // near tile's dye is in and the far tile's dye is out says exactly the thing (a reversed
  // sign reads the destination) and says it without re-pinning the recipe graph here.
  for (const { dir, sourceX, sourceY } of CASES) {
    it(`takes from the -dir side, facing ${dir}`, () => {
      const view = withArm(createWorldView(), 5, 5, dir, GrabberTier.Mk2);
      withMachine(view, sourceX, sourceY, MachineKind.Fryer, { outputItem: ItemId.BaggedChips });
      // The far side holds something else entirely, so reading it would be visible.
      withMachine(view, 5 + (5 - sourceX), 5 + (5 - sourceY), MachineKind.Washer, {
        outputItem: ItemId.RussetPotato,
      });

      const candidates = grabberCard(view, 1)!.candidates;
      expect(candidates).toContain(ItemId.BaggedChips);
      expect(candidates).not.toContain(ItemId.RussetPotato);
    });
  }

  it('reaches two tiles on a Long arm, skipping the tile next to it', () => {
    const view = withArm(createWorldView(), 5, 5, Direction.East, GrabberTier.Long);
    withMachine(view, 4, 5, MachineKind.Fryer, { outputItem: ItemId.RussetPotato });
    withMachine(view, 3, 5, MachineKind.Washer, { outputItem: ItemId.BaggedChips });

    const candidates = grabberCard(view, 1)!.candidates;
    expect(candidates).toContain(ItemId.BaggedChips);
    expect(candidates).not.toContain(ItemId.RussetPotato);
  });

  // The reason the four cases above had to loosen, pinned on purpose so it is a decision
  // rather than a casualty: an arm at a Bagger between batches must still be tunable to a
  // flavour that machine has not made yet, because a filter is a standing instruction and a
  // player sets one up BEFORE the first chili is grown. `outputItem` alone is the basket, and
  // a basket is empty most of the time.
  it('offers every flavour a machine can make, not only the one in its basket ([[111]])', () => {
    const view = withArm(createWorldView(), 5, 5, Direction.East, GrabberTier.Mk2);
    withMachine(view, 4, 5, MachineKind.Bagger, { outputItem: ItemId.BaggedChips });

    const candidates = grabberCard(view, 1)!.candidates;
    expect(candidates).toContain(ItemId.BaggedChiliChips);
    expect(candidates).toContain(ItemId.BaggedSweetcornChips);
    expect(candidates).toContain(ItemId.BaggedGoldChips);
  });
});

describe('grabberCard — what the source offers', () => {
  it('offers every type riding the belt behind it, once each', () => {
    const view = withArm(createWorldView(), 5, 5, Direction.East, GrabberTier.Mk2);
    withBelt(view, 4, 5, Direction.East, 3, [
      ItemId.RussetPotato,
      ItemId.BaggedChips,
      ItemId.RussetPotato,
    ]);

    const card = grabberCard(view, 1);
    expect(card?.source).toBe(ArmSource.Belt);
    expect(card?.candidates).toEqual(
      [ItemId.RussetPotato, ItemId.BaggedChips].sort((a, b) => a - b),
    );
  });

  it("offers a machine's output and its overcooked twin, because the arm can be pointed at either", () => {
    const view = withArm(createWorldView(), 5, 5, Direction.East, GrabberTier.Mk2);
    withMachine(view, 4, 5, MachineKind.Fryer, {
      outputItem: ItemId.RussetPotato,
      overcookedItem: ItemId.RusticStyleChips,
    });

    const card = grabberCard(view, 1);
    expect(card?.source).toBe(ArmSource.Machine);
    expect(card?.sourceKind).toBe(MachineKind.Fryer);
    expect(card?.candidates).toContain(ItemId.RussetPotato);
    expect(card?.candidates).toContain(ItemId.RusticStyleChips);
  });

  // The reported bug's own machine: `outputItem` is 0 on a dock, so the shelves are the only
  // way this card offers anything at the place a filter is most worth setting.
  it('offers BOTH shelves of a harvester dock, which has no output item at all', () => {
    const view = withArm(createWorldView(), 5, 5, Direction.East, GrabberTier.Mk2);
    withMachine(view, 4, 5, MachineKind.HarvesterDock, {
      outputItem: 0,
      cargoItem: ItemId.RussetPotato,
      seedShelfItem: ItemId.PotatoSeed,
    });

    expect(grabberCard(view, 1)?.candidates).toEqual(
      [ItemId.RussetPotato, ItemId.PotatoSeed].sort((a, b) => a - b),
    );
  });

  it('says there is nothing behind it when the arm reaches into bare ground', () => {
    const view = withArm(createWorldView(), 5, 5, Direction.East, GrabberTier.Mk2);
    const card = grabberCard(view, 1);
    expect(card?.source).toBe(ArmSource.Nothing);
    expect(card?.candidates).toEqual([]);
  });

  it('keeps the arm’s own filter on the grid even when the source is not carrying it', () => {
    const view = withArm(
      createWorldView(),
      5,
      5,
      Direction.East,
      GrabberTier.Mk2,
      ItemId.PotatoSeed,
    );
    withBelt(view, 4, 5, Direction.East, 2, [ItemId.BaggedChips]);

    // `grabberCard` reports the momentary source; the seam is where the filter is guaranteed
    // a cell, via `mergeCandidates`. Both halves are pinned — this is the source half.
    expect(grabberCard(view, 1)?.candidates).toEqual([ItemId.BaggedChips]);
    expect(mergeCandidates([], [ItemId.BaggedChips], ItemId.PotatoSeed)).toContain(
      ItemId.PotatoSeed,
    );
  });
});

describe('grabberCard — the tier rule is the sim’s', () => {
  it('reports the Mk1 as unfilterable, so the card explains instead of drawing a dead grid', () => {
    const view = withArm(createWorldView(), 5, 5, Direction.East, GrabberTier.Mk1);
    expect(grabberCard(view, 1)?.filterable).toBe(false);
  });

  it('reports the Mk2 and the Long arm as filterable', () => {
    const mk2 = withArm(createWorldView(), 5, 5, Direction.East, GrabberTier.Mk2);
    const long = withArm(createWorldView(), 5, 5, Direction.East, GrabberTier.Long);
    expect(grabberCard(mk2, 1)?.filterable).toBe(true);
    expect(grabberCard(long, 1)?.filterable).toBe(true);
  });

  it('has no card for an arm that is not there, which is how teardown closes it', () => {
    const view = withArm(createWorldView(), 5, 5, Direction.East, GrabberTier.Mk2, 0, 7);
    expect(grabberCard(view, 9)).toBeNull();
    expect(grabberCard(view, 0)).toBeNull();
    expect(grabberCard(null, 7)).toBeNull();
  });
});

describe('lotItems — the fallback when the source has nothing on it', () => {
  it('collects outputs, shelves and belt cargo across the lot, deduped and ascending', () => {
    const view = createWorldView();
    withMachine(view, 1, 1, MachineKind.Fryer, { outputItem: ItemId.BaggedChips });
    withMachine(view, 2, 2, MachineKind.HarvesterDock, {
      cargoItem: ItemId.RussetPotato,
      seedShelfItem: ItemId.PotatoSeed,
    });
    withBelt(view, 3, 3, Direction.East, 2, [ItemId.BaggedChips]);

    const items = lotItems(view);
    expect(items).toEqual([...items].sort((a, b) => a - b));
    expect(new Set(items).size).toBe(items.length);
    expect(items).toContain(ItemId.BaggedChips);
    expect(items).toContain(ItemId.RussetPotato);
    expect(items).toContain(ItemId.PotatoSeed);
  });

  it('is empty on a bare lot rather than the whole item table', () => {
    expect(lotItems(createWorldView())).toEqual([]);
    expect(lotItems(null)).toEqual([]);
  });
});

describe('mergeCandidates — the grid only grows', () => {
  it('keeps what the source has already offered when the belt empties', () => {
    const seen = mergeCandidates([], [ItemId.RussetPotato], 0);
    expect(mergeCandidates(seen, [], 0)).toEqual([ItemId.RussetPotato]);
  });

  it('adds a newcomer once, in id order', () => {
    const first = mergeCandidates([], [ItemId.BaggedChips], 0);
    const second = mergeCandidates(first, [ItemId.RussetPotato, ItemId.BaggedChips], 0);
    expect(second).toEqual([ItemId.RussetPotato, ItemId.BaggedChips].sort((a, b) => a - b));
  });

  it('never lets 0 in — "anything" is a verb, not a candidate', () => {
    expect(mergeCandidates([], [0], 0)).toEqual([]);
  });
});

describe('grabberCardTarget — which click opens a card', () => {
  const TILE = { tileX: 5, tileY: 5 };

  it('names the arm under the Hand', () => {
    const view = withArm(createWorldView(), 5, 5, Direction.East, GrabberTier.Mk2, 0, 4);
    expect(grabberCardTarget(view, TILE, ToolMode.Hand)).toBe(4);
  });

  it('declines every other tool, so a placement click keeps its meaning', () => {
    const view = withArm(createWorldView(), 5, 5, Direction.East, GrabberTier.Mk2, 0, 4);
    expect(grabberCardTarget(view, TILE, ToolMode.Water)).toBe(0);
    expect(grabberCardTarget(view, TILE, ToolMode.Deconstruct)).toBe(0);
    expect(grabberCardTarget(view, TILE, ToolMode.PlaceGrabberMk2)).toBe(0);
  });

  it('declines a tile with no arm on it', () => {
    expect(grabberCardTarget(createWorldView(), TILE, ToolMode.Hand)).toBe(0);
  });
});

describe('the seam: one card open at a time, closed by the same click that opened it', () => {
  beforeEach(() => {
    resetGrabberPanel();
  });

  function twoArms(): WorldView {
    const view = withArm(createWorldView(), 5, 5, Direction.East, GrabberTier.Mk2, 0, 1);
    withArm(view, 9, 9, Direction.East, GrabberTier.Mk1, 0, 2);
    withBelt(view, 4, 5, Direction.East, 2, [ItemId.RussetPotato]);
    return view;
  }

  it('opens on a click and carries the arm the player pointed at', () => {
    const view = twoArms();
    expect(grabberPanelSnapshot().open).toBe(false);

    grabberClicked(1);
    publishGrabberPanel(view);
    expect(grabberPanelSnapshot().open).toBe(true);
    expect(grabberPanelSnapshot().grabberId).toBe(1);
    expect(grabberPanelSnapshot().candidates).toEqual([ItemId.RussetPotato]);
  });

  it('closes on a second click on the same arm and re-aims on a click on another', () => {
    const view = twoArms();
    grabberClicked(1);
    publishGrabberPanel(view);

    grabberClicked(2);
    publishGrabberPanel(view);
    expect(grabberPanelSnapshot().grabberId).toBe(2);
    // The Mk1's card explains itself; the seam is what tells it to.
    expect(grabberPanelSnapshot().filterable).toBe(false);

    grabberClicked(2);
    expect(grabberPanelSnapshot().open).toBe(false);
  });

  it('holds the grid steady when the belt empties under the cursor', () => {
    const view = twoArms();
    grabberClicked(1);
    publishGrabberPanel(view);
    expect(grabberPanelSnapshot().candidates).toEqual([ItemId.RussetPotato]);

    view.belts[0]!.itemCount = 0;
    publishGrabberPanel(view);
    expect(grabberPanelSnapshot().candidates).toEqual([ItemId.RussetPotato]);
    expect(grabberPanelSnapshot().fromLot).toBe(false);
  });

  it('falls back to the lot when the source was empty on open, and says so', () => {
    const view = withArm(createWorldView(), 5, 5, Direction.East, GrabberTier.Mk2, 0, 1);
    withMachine(view, 1, 1, MachineKind.Fryer, { outputItem: ItemId.BaggedChips });

    grabberClicked(1);
    publishGrabberPanel(view);
    expect(grabberPanelSnapshot().fromLot).toBe(true);
    // Presence, not equality, for the reason the tile cases above give: the lot's fallback
    // list carries what the Fryer can make as well as what is in its basket.
    expect(grabberPanelSnapshot().candidates).toContain(ItemId.BaggedChips);
  });

  it('closes itself when the arm is torn down, and does not come back', () => {
    const view = twoArms();
    grabberClicked(1);
    publishGrabberPanel(view);
    expect(grabberPanelSnapshot().open).toBe(true);

    view.grabbers.splice(0, 1);
    publishGrabberPanel(view);
    expect(grabberPanelSnapshot().open).toBe(false);

    // The selection is gone, not merely hidden: a later publish must not resurrect it.
    view.grabbers.push({ ...twoArms().grabbers[0]! });
    publishGrabberPanel(view);
    expect(grabberPanelSnapshot().open).toBe(false);
  });

  it('publishes nothing when nothing moved', () => {
    const view = twoArms();
    grabberClicked(1);
    publishGrabberPanel(view);
    const first = grabberPanelSnapshot();

    publishGrabberPanel(view);
    // Reference equality is the contract `useSyncExternalStore` bails on. A new object per
    // frame would re-render the card sixty times a second for no reason at all.
    expect(grabberPanelSnapshot()).toBe(first);
  });

  it('is wiped by the reset a host swap runs, because arm ids are per-world', () => {
    grabberClicked(1);
    publishGrabberPanel(twoArms());
    resetGrabberPanel();
    expect(grabberPanelSnapshot().open).toBe(false);
  });

  it('closes on the Esc door without needing a world', () => {
    grabberClicked(1);
    publishGrabberPanel(twoArms());
    grabberPanelClose();
    expect(grabberPanelSnapshot().open).toBe(false);
  });
});
