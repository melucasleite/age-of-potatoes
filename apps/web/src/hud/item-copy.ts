// What the HUD calls the things in the player's bag.
//
// The sim carries a `slug` for the atlas and for save debugging, never a display string —
// capitalisation and hyphenation are presentation, and presentation does not belong in a
// deterministic core. Same rule `tech-copy.ts` states for machine names and `format.ts` for
// the dollar sign.
//
// THE DEFAULT IS THE SLUG, TITLE-CASED, AND THAT IS THE DESIGN rather than a stopgap. Twenty
// boxed-machine rows landed in `ITEM_SPECS` in a single commit ([[054]]); a hand-written table
// of every item would have answered "stuff" for all twenty until somebody noticed, which is
// exactly what the pouch did. A table of EXCEPTIONS is small and stays small — it only holds
// the names a slug cannot spell — while a table of everything goes stale the day an item is
// added, silently and in the one place the player is looking.
//
// A BOXED MACHINE IS NAMED BY ITS MACHINE. "Boxed Fryer" says the same thing twice: the panel
// already prints the word "boxed" beside the row, and the player thinks of it as the Fryer they
// picked up rather than as a new kind of object. So it is called a Fryer, from the one table
// that already names machines.

import { ItemId, itemSpec, machineKindForBoxedItem } from '@snack/sim';

import { machineLabel } from './tech-copy';

/**
 * The handful of names a hyphen-separated slug cannot spell.
 *
 * "rustic-style-chips" title-cases to "Rustic Style Chips", and the compound adjective wants
 * its hyphen.
 *
 * ⚠️ FIVE OF THE SEVEN ROWS WERE DAY-OLD GRADES AND [[124]] DELETED THEM WITH THE ITEMS. Worth
 * recording, because the reason they were here is the reason to keep this table small: the
 * reports lane once kept a RIVAL vocabulary — a hand-keyed table of item numbers — and merging
 * it into this one nearly regressed three names. One table of exceptions, and it earns each row.
 */
const NAME_OVERRIDES: Readonly<Record<number, string>> = {
  [ItemId.RusticStyleChips]: 'Rustic-Style Chips',
  [ItemId.SixPack]: 'Six-Pack',
};

/** "bagged-chips" → "Bagged Chips". */
function titleCase(slug: string): string {
  return slug
    .split('-')
    .map((word) => (word === '' ? '' : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ');
}

/**
 * The display name for any `ItemId`, including ones this file has never heard of.
 *
 * Never returns an empty string and never returns "stuff": an item with no spec at all is a
 * save from the future or a bug, and "Unknown item" says which of those the player is looking
 * at, where a blank row says nothing.
 */
export function itemName(item: number): string {
  const kind = machineKindForBoxedItem(item as ItemId);
  if (kind !== null) return machineLabel(kind);

  const override = NAME_OVERRIDES[item];
  if (override !== undefined) return override;

  const spec = itemSpec(item as ItemId);
  return spec === null ? 'Unknown item' : titleCase(spec.slug);
}
