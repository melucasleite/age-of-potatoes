// Cheap structural gates for the roadside stand's board.
//
// AGENTS.md keeps verification light, so this pins only the places where being wrong is
// INVISIBLE — and for a shop that is most of them, because a wrong board looks exactly like a
// right one until money changes hands:
//
//   · IF A PRICE DRIFTS FROM `ITEM_SPECS`, the board advertises one number and the till
//     charges another. Nothing throws. The player finds out by subtraction, and from then on
//     every figure in this HUD is suspect. So the prices are asserted against the sim's own
//     table rather than against literals — a re-balance moves both or fails here.
//   · IF THE FILTER IS WRONG IN EITHER DIRECTION, the board either offers russets (a command
//     `applyBuyItem` refuses on `purchasable`, i.e. a dead button) or silently drops a seed
//     the sim was willing to sell. Work item 051's acceptance criterion is that a newly
//     purchasable item appears with no code change, which is a property, so it is tested as one.
//   · IF THE REACH MIRROR IS WRONG, every button on the board is enabled across the whole lot
//     and every click is refused in silence — the exact papercut this panel was built to end.
//   · IF THE TECH GATE READS BACKWARDS, the stand either hides seeds the player can plant or
//     sells them ones they cannot, and (once seeds are unsellable) that second one is money
//     the player cannot get back.
//
// Nothing here renders. The panel on screen, the walk to the stand, and the money actually
// leaving the wallet were checked in the running build — see the agent log on work item 051
// for what was and was not verified for real.

import { describe, expect, it } from 'vitest';
import { HAND_REACH_SUBTILES, ITEM_SPECS, ItemId, MachineKind, TechId } from '@snack/sim';
import type { WorldView } from '@snack/sim';

// Relative rather than the `@/` alias: that path is a tsconfig/Next resolution and vitest runs
// with no config at all here, exactly as `lot.test.ts` does.
import { createShopFields, deriveShop } from './derive-shop';

const BIN_TILE = 4;
/** Subtile centre of a 1×1 machine standing on `BIN_TILE`. */
const BIN_CENTRE_SUB = 4 * 256 + 128;

function viewWith(
  options: {
    playerXSub?: number;
    playerYSub?: number;
    inventory?: { item: number; count: number }[];
    unlocked?: string[];
    bin?: boolean;
  } = {},
): WorldView {
  const bin = options.bin ?? true;
  return {
    player: {
      xSub: options.playerXSub ?? BIN_CENTRE_SUB,
      ySub: options.playerYSub ?? BIN_CENTRE_SUB,
    },
    inventory: options.inventory ?? [],
    unlocked: options.unlocked ?? [],
    machines: bin
      ? [
          {
            id: 1,
            kind: MachineKind.SellBin,
            tileX: BIN_TILE,
            tileY: BIN_TILE,
            tilesWide: 1,
            tilesHigh: 1,
          },
        ]
      : [],
  } as unknown as WorldView;
}

function rowFor(view: WorldView, item: number) {
  return deriveShop(view, createShopFields()).rows.find((row) => row.id === item) ?? null;
}

describe('what is on the board', () => {
  it('lists exactly what the simulation marks purchasable, in its own order', () => {
    const rows = deriveShop(viewWith(), createShopFields()).rows;
    expect(rows.map((row) => row.id)).toEqual(
      ITEM_SPECS.filter((spec) => spec.purchasable).map((spec) => spec.id),
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it('prices every row off `listPriceCents` rather than a table of its own', () => {
    for (const row of deriveShop(viewWith(), createShopFields()).rows) {
      const spec = ITEM_SPECS.find((candidate) => candidate.id === row.id);
      expect(spec).toBeDefined();
      expect(row.unitPriceCents).toBe(spec?.listPriceCents);
    }
  });

  it('does not offer to sell you what the till would refuse', () => {
    // Russets are grown and sold, never bought — `applyBuyItem` checks `purchasable` first.
    expect(rowFor(viewWith(), ItemId.RussetPotato)).toBeNull();
    expect(rowFor(viewWith(), ItemId.BaggedChips)).toBeNull();
  });

  it('counts what is already in the pouch', () => {
    const view = viewWith({ inventory: [{ item: ItemId.PotatoSeed, count: 7 }] });
    expect(rowFor(view, ItemId.PotatoSeed)?.owned).toBe(7);
    expect(rowFor(view, ItemId.CaneSeed)?.owned).toBe(0);
  });
});

describe('the counter', () => {
  it('is open when the farmer is standing at the bin', () => {
    const shop = deriveShop(viewWith(), createShopFields());
    expect(shop.standExists).toBe(1);
    expect(shop.atStand).toBe(1);
    expect(shop.heading).toBe('');
  });

  it('is shut from further away than a hand can reach, and says which way to walk', () => {
    const shop = deriveShop(
      viewWith({ playerXSub: BIN_CENTRE_SUB - HAND_REACH_SUBTILES * 4 }),
      createShopFields(),
    );
    expect(shop.atStand).toBe(0);
    expect(shop.heading).toBe('east');
  });

  it('reads north-west when the bin is up and to the left', () => {
    const away = HAND_REACH_SUBTILES * 4;
    const shop = deriveShop(
      viewWith({ playerXSub: BIN_CENTRE_SUB + away, playerYSub: BIN_CENTRE_SUB + away }),
      createShopFields(),
    );
    expect(shop.heading).toBe('north-west');
  });

  it('knows when the lot has no stand at all', () => {
    const shop = deriveShop(viewWith({ bin: false }), createShopFields());
    expect(shop.standExists).toBe(0);
    expect(shop.atStand).toBe(0);
  });

  /*
   * The tile is what the walk-and-buy errand aims at ([[054]]). If it were wrong the button
   * would send the farmer somewhere else on the lot and the purchase would never fire — a
   * failure with no error, no refusal, and nothing on screen except a farmer walking away.
   */
  it('publishes the tile a purchase from across the lot walks to', () => {
    const shop = deriveShop(viewWith({ playerXSub: 0 }), createShopFields());
    expect(shop.standTileX).toBe(BIN_TILE);
    expect(shop.standTileY).toBe(BIN_TILE);
  });

  it('has no tile to walk to when there is no stand, and says so with -1', () => {
    const shop = deriveShop(viewWith({ bin: false }), createShopFields());
    expect(shop.standTileX).toBe(-1);
    expect(shop.standTileY).toBe(-1);
  });
});

describe('seeds whose crop is still locked', () => {
  it('names the node that would let you plant them', () => {
    expect(rowFor(viewWith(), ItemId.CaneSeed)?.needsTech).not.toBe('');
  });

  it('stops warning once that node is researched', () => {
    const view = viewWith({ unlocked: [TechId.Cane] });
    expect(rowFor(view, ItemId.CaneSeed)?.needsTech).toBe('');
  });

  it('never gates the starter crop or a thing with no crop behind it', () => {
    expect(rowFor(viewWith(), ItemId.PotatoSeed)?.needsTech).toBe('');
    expect(rowFor(viewWith(), ItemId.RepairKit)?.needsTech).toBe('');
  });
});

describe('the copy table keeps up with the price table ([[103]])', () => {
  // FIVE PRICED ROWS STOOD ON THE BOARD WITH NOTHING TO SAY — kola nut, bottle, gold potato
  // seed, push scythe, crate — because the fallback is a slug-derived name and an EMPTY note,
  // which reads as a finished row rather than a missing one. That is invisible by construction,
  // so it is a property test rather than five assertions: adding a purchasable item to the sim
  // now fails here until somebody writes the one line that says what it is for.
  it('gives every purchasable item a name and a note', () => {
    const rows = deriveShop(viewWith(), createShopFields()).rows;
    const purchasable = ITEM_SPECS.filter((spec) => spec.purchasable).map((spec) => spec.id);
    expect(rows.map((row) => row.id).sort((a, b) => a - b)).toEqual(
      [...purchasable].sort((a, b) => a - b),
    );
    const mute = rows.filter((row) => row.note === '').map((row) => row.name);
    expect(mute).toEqual([]);
  });
});
