// WorldView → the roadside stand's board.
//
// THE ONE RULE THIS FILE EXISTS TO KEEP: the stand does not have a price list. It reads
// `ITEM_SPECS` — `purchasable` decides whether a row exists and `listPriceCents` is what it
// costs — which is the same table `applyBuyItem` charges against and the same one the pouch
// values a stack with. A second price table in the HUD is not a duplicated constant, it is a
// number that will disagree with the till on the day somebody re-balances seeds, and the
// player is the one who finds out. So the board is a *rendering* of the sim's own data, and
// adding a purchasable item to `data.ts` puts it on the board with no edit here.
//
// Two things are decided on this side of the seam, and both are presentation:
//
//   COPY. `ItemSpec` carries a slug, not a name — "potato-seed" is an id, not a label. Names
//   and one-line notes live below, with a slug-derived fallback so an item the copy table has
//   never heard of still shows up readably rather than as "stuff".
//
//   WHETHER TO WARN. The sim will happily sell cane seeds to a player who cannot plant cane:
//   `applyBuyItem` checks `purchasable` and nothing else, and it is `applyPlantTile` that
//   holds the tech gate. Buying is therefore legal and useless, and once seeds stop being
//   sellable it is legal, useless and irreversible — so a row whose crop is still locked says
//   which node opens it, the same courtesy the research panel does with a missing prereq.
//
// The reach test is a mirror of `nearSellBin` + `withinReachOfMachine`, both private to
// `tick.ts` and both taking a `Machine` that never crosses the view boundary. It uses the
// sim's own constant and its own integer helpers rather than re-deriving the geometry; if it
// ever disagrees, the board offers a button the till refuses, which shows up in one click.

import {
  CROP_SPECS,
  ITEM_SPECS,
  ItemId,
  MachineKind,
  distanceSquaredSubtiles,
  hasTech,
} from '@snack/sim';
import type { MachineView, WorldView } from '@snack/sim';

import { HAND_REACH_SQUARED, centreXSub, centreYSub } from './derive-tech';
import { nodeCopy } from './tech-copy';
import type { ShopRow } from './types';

interface ShopCopy {
  readonly name: string;
  readonly note: string;
}

/**
 * What the board calls things, and one line of why you would want one.
 *
 * Never a price and never a rate — those come off the spec, and copy that restates a number
 * is copy that goes stale silently. Notes describe the thing, in the register the Clipboard
 * uses: a fact about the item, then stop talking.
 */
const SHOP_COPY: Readonly<Record<number, ShopCopy>> = {
  [ItemId.PotatoSeed]: {
    name: 'Potato seeds',
    note: 'One tile each. Harvesting a potato hands the seed back, so a field pays for itself.',
  },
  [ItemId.CaneSeed]: {
    name: 'Cane seeds',
    note: 'Cuts and regrows without replanting. Thirsty enough to notice.',
  },
  [ItemId.CornSeed]: {
    name: 'Corn seeds',
    note: 'Slow in the ground. The oil press is downstream of it.',
  },
  [ItemId.ChiliSeed]: {
    name: 'Chili seeds',
    note: 'Regrows. Everything the seasoner does starts here.',
  },
  [ItemId.RepairKit]: {
    name: 'Repair kit',
    note: 'Services every machine standing near you at once. It buys the walk, not the repair.',
  },
};

/** The mutable scratch the store fills each publish, mirroring `ShopSlice` minus its version. */
export interface ShopFields {
  rows: ShopRow[];
  atStand: number;
  standExists: number;
  heading: string;
  standTileX: number;
  standTileY: number;
}

export function createShopFields(): ShopFields {
  return { rows: [], atStand: 0, standExists: 0, heading: '', standTileX: -1, standTileY: -1 };
}

export function deriveShop(view: WorldView, out: ShopFields): ShopFields {
  const stand = nearestStand(view);
  out.standExists = stand === null ? 0 : 1;
  out.atStand = stand !== null && withinReach(view, stand) ? 1 : 0;
  out.heading = stand === null || out.atStand === 1 ? '' : headingTo(view, stand);
  // The tile the errand walks to. `intentTargetSubtiles` resolves the machine from this tile on
  // every tick and aims at its footprint centre, so the origin tile of the stand is enough and
  // a stand that gets picked up and moved simply ends the errand rather than misdirecting it.
  out.standTileX = stand === null ? -1 : stand.tileX;
  out.standTileY = stand === null ? -1 : stand.tileY;

  const rows: ShopRow[] = [];
  for (let i = 0; i < ITEM_SPECS.length; i++) {
    const spec = ITEM_SPECS[i]!;
    if (!spec.purchasable) continue;
    const copy = SHOP_COPY[spec.id];
    rows.push({
      id: spec.id,
      name: copy?.name ?? nameFromSlug(spec.slug),
      note: copy?.note ?? '',
      unitPriceCents: spec.listPriceCents,
      owned: countOf(view, spec.id),
      needsTech: missingTechFor(view, spec.id),
    });
  }
  out.rows = rows;
  return out;
}

/**
 * The node that would make this seed plantable, by title, or '' when nothing is in the way.
 *
 * Driven off `CROP_SPECS.seedItem` rather than a list of seed ids, so a crop added to the sim
 * gates its own seed here without an edit. An item that is not any crop's seed — the repair
 * kit, and whatever consumables come later — is never gated, which is the correct answer for
 * a thing with no crop behind it rather than a special case for the kit.
 */
function missingTechFor(view: WorldView, item: number): string {
  for (let i = 0; i < CROP_SPECS.length; i++) {
    const crop = CROP_SPECS[i]!;
    if (crop.seedItem !== item) continue;
    if (crop.requiresTech === null) return '';
    return hasTech(view.unlocked, crop.requiresTech) ? '' : nodeCopy(crop.requiresTech).title;
  }
  return '';
}

function countOf(view: WorldView, item: number): number {
  for (const slot of view.inventory) {
    if (slot.item === item) return slot.count;
  }
  return 0;
}

/** "potato-seed" → "Potato seed". The last resort, for an item nobody has written copy for. */
function nameFromSlug(slug: string): string {
  const words = slug.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// --- where the stand is -------------------------------------------------------------

function nearestStand(view: WorldView): MachineView | null {
  let best: MachineView | null = null;
  let bestDistance = 0;
  for (const machine of view.machines) {
    if (machine.kind !== MachineKind.SellBin) continue;
    const distance = distanceSquaredSubtiles(
      view.player.xSub,
      view.player.ySub,
      centreXSub(machine),
      centreYSub(machine),
    );
    if (best === null || distance < bestDistance) {
      best = machine;
      bestDistance = distance;
    }
  }
  return best;
}

function withinReach(view: WorldView, machine: MachineView): boolean {
  return (
    distanceSquaredSubtiles(
      view.player.xSub,
      view.player.ySub,
      centreXSub(machine),
      centreYSub(machine),
    ) <= HAND_REACH_SQUARED
  );
}

/**
 * Which way to walk, to eight points.
 *
 * QUANTISED ON PURPOSE, and the coarseness is the feature rather than laziness. The player
 * is usually moving, so a bearing published at any finer grain would rebuild this slice on
 * every publish and re-render the board 6.7 times a second to redraw the same sentence —
 * exactly the churn `store.ts` compares field by field to prevent. Eight points change a
 * handful of times in a walk across the lot.
 *
 * `+y` is south: the world is drawn top-down and the field's rows run downward.
 */
function headingTo(view: WorldView, machine: MachineView): string {
  const dx = centreXSub(machine) - view.player.xSub;
  const dy = centreYSub(machine) - view.player.ySub;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const northSouth = dy < 0 ? 'north' : 'south';
  const eastWest = dx < 0 ? 'west' : 'east';
  if (ax > ay * 2) return eastWest;
  if (ay > ax * 2) return northSouth;
  return `${northSouth}-${eastWest}`;
}
