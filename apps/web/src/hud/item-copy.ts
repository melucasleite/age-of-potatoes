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
 * "day-old-potato" title-cases to "Day Old Potato", and the compound adjective wants its
 * hyphen — it is the difference between produce that is a day old and a variety called Day Old.
 */
const NAME_OVERRIDES: Readonly<Record<number, string>> = {
  [ItemId.DayOldPotato]: 'Day-Old Potato',
  [ItemId.DayOldCane]: 'Day-Old Cane',
  [ItemId.DayOldCorn]: 'Day-Old Corn',
  [ItemId.DayOldChili]: 'Day-Old Chili',
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
