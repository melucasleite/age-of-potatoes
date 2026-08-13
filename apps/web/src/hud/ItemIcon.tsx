'use client';

// One item, drawn as itself.
//
// The only sprite in the HUD, and every surface that lists a thing uses this one component:
// the bag's grid, the bag's detail pane, the stand's rows, the pouch's chips. That is the point
// of it existing rather than four `background-position` calculations — see `item-art.ts` for
// where the geometry comes from and why it is never written down.
//
// WHAT IT DOES WHEN THERE IS NO PICTURE. It draws a chip carrying the item's first letter, and
// it does that OFTEN — the atlas has fourteen item frames against fifty-odd items, and new items
// land in `data.ts` weeks before art lands in the atlas. So the missing case is the ordinary
// case, not the exception, and it is styled as a quiet, deliberate-looking slug rather than as
// the renderer's magenta "this build is broken" square ([[037]]).
//
// IT IS NEVER THE ACCESSIBLE NAME. The icon is `aria-hidden` and the thing that owns it — a slot
// button, a shop row, a pouch chip — carries the words. A picture of a potato with `alt="Russet
// Potato"` on it would read the name twice everywhere the name is already on screen.

import { itemName } from './item-copy';
import { paintIcon, resolveItemIcon } from './item-art';
import { cx, s } from './styles';

export interface ItemIconProps {
  /** `ItemId`. A boxed machine resolves to the machine inside it — see `resolveItemIcon`. */
  readonly item: number;
  /** Side of the square box, in CSS pixels. The sprite is scaled to fit it, never past it. */
  readonly size: number;
  /** Extra positioning class from the caller. The icon owns its paint, never its place. */
  readonly className?: string;
}

export function ItemIcon({ item, size, className }: ItemIconProps) {
  const source = resolveItemIcon(item);

  if (source === null) {
    // The first letter of the name the rest of the UI uses, so the chip and the label agree
    // even for an item this build has never heard of ("Unknown item" → "U").
    const initial = itemName(item).charAt(0).toUpperCase();
    return (
      <span
        className={cx(s.icon, s.iconBlank, className)}
        style={{ width: size, height: size }}
        aria-hidden="true"
      >
        {initial}
      </span>
    );
  }

  const paint = paintIcon(source, size);

  return (
    <span
      className={cx(s.icon, className)}
      style={{
        width: size,
        height: size,
        backgroundImage: paint.backgroundImage,
        backgroundPosition: paint.backgroundPosition,
        backgroundSize: paint.backgroundSize,
      }}
      aria-hidden="true"
    />
  );
}
