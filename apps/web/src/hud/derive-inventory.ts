// WorldView → the bag.
//
// THE ONE RULE THIS FILE EXISTS TO KEEP: no price in here is computed. A boxed machine's scrap
// value arrives on the view as `scrapCents`, already floored by the same arithmetic
// `applySellBoxedMachine` pays out, and this file copies it across without touching it. The
// forty-percent ratio is NOT restated here, is not imported here, and must never be — the
// tombstone at the bottom of `derive-tech.ts` records what happened the last time this HUD kept
// its own copy of one of the sim's prices: it quoted Efficiency at two thirds of what the
// reducer charged, kept compiling, and was found by a player rather than by a test.
//
// AND THE MATCHING TRAP, which is new and specific to this feature: every boxed row has
// `listPriceCents: 0`, deliberately, so that `computeNetWorthCents` does not add a list price on
// top of the per-box invoice. A panel that priced a box the way it prices a russet would print
// "$0" beside a maxed Fryer. So the value of an ordinary row comes off the spec and the value of
// a boxed row comes off its boxes, and the two are never the same line of code.
//
// WHAT IS DECIDED ON THIS SIDE, and it is only ever presentation:
//
//   WHICH TOOL PUTS A BOX BACK DOWN. `PlaceMachine` is the sim's verb, but arming a cursor is
//   UI state that never enters the world (§12), so the panel needs a `ToolMode`. It is found by
//   ASKING `toolMachineKind` rather than by a second table — a build tool added for the Pump
//   tomorrow lights up the Pump's boxes here with no edit, and a kind with no tool yet reports
//   -1 honestly instead of arming the wrong cursor.
//
//   COPY. `itemName` (see `item-copy.ts`), for the same reason `derive-shop.ts` owns the stand's
//   labels: `ItemSpec` carries a slug, not a name.

import { CONDITION_MAX, ItemId, itemSpec, permille } from '@snack/sim';
import type { WorldView } from '@snack/sim';

// Relative rather than the `@/` alias, unlike its neighbours: that path is a tsconfig/Next
// resolution and vitest runs with no config at all in this repo, so a test that imports this
// module could not follow it (`shop.test.ts` makes the same note from the other side). One
// import written the long way is cheaper than a module that cannot be tested.
import { toolForMachineKind } from '../game/input/tools';
import type { MachineKind } from '@snack/sim';

import { itemName } from './item-copy';
import type { InventoryBox, InventoryRow } from './types';

/** The mutable scratch the store fills each publish, mirroring `InventorySlice` minus version. */
export interface InventoryFields {
  rows: InventoryRow[];
  boxCount: number;
  scrapCents: number;
}

export function createInventoryFields(): InventoryFields {
  return { rows: [], boxCount: 0, scrapCents: 0 };
}

/**
 * The cursor that puts this machine kind down, or -1 when nothing in the UI builds one yet.
 *
 * `toolForMachineKind` is the input lane's own inverse of `toolMachineKind`, written for this
 * panel and scanning the same table the forward direction uses. Asking it rather than keeping a
 * kind→tool map here is the whole point: two switches disagreeing means a boxed Fryer whose
 * place button arms the Seasoner, which is silent, expensive, and entirely plausible.
 */
function placeToolFor(kind: number): number {
  return toolForMachineKind(kind as MachineKind) ?? -1;
}

export function deriveInventory(view: WorldView, out: InventoryFields): InventoryFields {
  const rows: InventoryRow[] = [];
  let boxCount = 0;
  let scrapCents = 0;

  for (const slot of view.inventory) {
    // A zero-count slot is not a thing the player is carrying. The sim prunes them, but a row
    // that reads "0 russets" would be a bug the panel could show rather than swallow.
    if (slot.count <= 0) continue;

    const boxed = slot.boxedMachineKind !== 0;
    const spec = itemSpec(slot.item as ItemId);
    const unitPriceCents = spec === null ? 0 : spec.listPriceCents;

    // COPIED OUT, NEVER HELD. `slot.boxes` is one of the view's pooled buffers and is refilled
    // in place on the next publish; a slice holding that array would silently start describing
    // somebody else's machine (§12, and the note beside `projectInventory`).
    const boxes: InventoryBox[] = [];
    let rowScrapCents = 0;
    for (let i = 0; i < slot.boxes.length; i++) {
      const box = slot.boxes[i]!;
      boxes.push({
        index: i,
        speedLevel: box.speedLevel,
        efficiencyLevel: box.efficiencyLevel,
        capacityLevel: box.capacityLevel,
        // `condition` is 0..CONDITION_MAX; permille is what every bar in this HUD draws from,
        // and converting through the sim's own helper is what keeps the two from drifting if
        // condition is ever rescaled (`UpgradeBench.tsx` makes the same point about its bar).
        conditionPermille: permille(box.condition, CONDITION_MAX),
        investedCents: box.investedCents,
        scrapCents: box.scrapCents,
      });
      rowScrapCents += box.scrapCents;
    }
    boxCount += boxes.length;
    scrapCents += rowScrapCents;

    rows.push({
      id: slot.item,
      name: itemName(slot.item),
      count: slot.count,
      sellable: slot.sellable,
      boxedKind: slot.boxedMachineKind,
      unitPriceCents,
      // Two prices, two sources, and the branch is the whole point — see the header.
      stackValueCents: boxed ? 0 : unitPriceCents * slot.count,
      scrapCents: rowScrapCents,
      placeTool: boxed ? placeToolFor(slot.boxedMachineKind) : -1,
      boxes,
    });
  }

  out.rows = rows;
  out.boxCount = boxCount;
  out.scrapCents = scrapCents;
  return out;
}
