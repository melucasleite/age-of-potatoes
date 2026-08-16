// The five pickable farmers, as the front door sees them ([[079]]).
//
// The RENDERER'S half of the avatar contract lives in `game/render/avatar.ts` (id range,
// walk-frame names, the boot-time publish seam). This module is the DOOR'S half: a portrait
// per avatar for the new-game picker, cut from the same atlas the world will dress the
// farmer from — so the face on the button is, pixel for pixel, the farmer who walks out of
// the boot. The portrait is the down strip's first cell, per the art lane's contract.
//
// Pure and Pixi-free, like everything the door touches: the atlas geometry comes through
// `item-art.ts`'s manifest read, and a missing frame degrades to null — the picker draws a
// neutral numbered chip, never magenta ([[037]]).

// Relative rather than the `@/` alias — the house rule `item-art.ts` states: `@/*` is a
// tsconfig path that Next resolves and vitest does not, and this file has a test.
import { AVATAR_COUNT } from '../game/render/avatar';

import { type IconSource, resolveFrameIcon } from './item-art';

export { AVATAR_COUNT };

/** The avatar id a brand-new game starts with when the player just presses Enter through. */
export const DEFAULT_AVATAR = 1;

/**
 * The picker portrait for an avatar id: the first square cell of `avatar<N>_walk_down` —
 * the farmer facing the player, standing still. Null when the id is out of range or the
 * atlas predates the avatar sheets.
 */
export function avatarPortrait(avatarId: number): IconSource | null {
  if (!Number.isInteger(avatarId) || avatarId < 1 || avatarId > AVATAR_COUNT) return null;
  const strip = resolveFrameIcon(`avatar${avatarId}_walk_down`);
  if (strip === null) return null;
  // The first square cell: strips are N square cells wide, and cells are square by
  // construction, so the height IS the cell width (`item-art.ts` makes the same read).
  return {
    frame: strip.frame,
    x: strip.x,
    y: strip.y,
    width: strip.height,
    height: strip.height,
  };
}
