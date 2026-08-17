// WHICH ZONE THE ZONES PANEL IS DESCRIBING ([[102]]).
//
// A module-scope contract with a subscription, exactly like `panel-state.ts` and the input
// layer's seams — and for the same two reasons. First, TWO SURFACES SET IT: the panel's own
// list, and the field card down in the sidebar, whose zone rows became openers rather than
// spans. A `useState` inside the panel could not be reached from the card without threading it
// through `HudRoot`, and the card would have had to know the panel exists. Second, vitest here
// runs with no DOM, so a module is testable and a hook is not.
//
// HELD AS A ZONE ID, NEVER AN INDEX. The rows are rebuilt from the world several times a
// second and a zone can be absorbed or pruned out of the middle of them (`pruneEmptyZones`);
// an index would quietly re-point at whatever slid into that position, so the detail pane would
// change what it is describing while the player reads it. An id that no longer exists simply
// falls back to the first zone, which is the honest answer to "that rectangle is gone" — the
// same ruling `Inventory.tsx` makes about a stack that runs out.
//
// NOT SIM STATE (§12). Which zone a panel has selected is never a `Command`, never traced,
// never hashed, never saved. A replay must not depend on it.

import { openPanel } from './panel-state';

/** 0 means "nothing chosen yet" — the panel falls back to its first row. */
let focused = 0;
const listeners = new Set<() => void>();

export function zoneFocusSnapshot(): number {
  return focused;
}

/** The server render and the client's first render: nothing chosen, cheaply and stably. */
export function zoneFocusServerSnapshot(): number {
  return 0;
}

export function subscribeZoneFocus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Point the panel at a zone without opening anything — the panel's own list uses this. */
export function focusZone(zoneId: number): void {
  if (focused === zoneId) return;
  focused = zoneId;
  for (const listener of listeners) listener();
}

/**
 * The field card's verb: show me this rectangle.
 *
 * OPEN, NEVER TOGGLE, which is the ruling `openPanel` already carries for the input layer's
 * requests: clicking a second zone while the panel is up means "show me that one instead", and
 * a toggle would shut the panel in the face of a player who clicked two zones in a row.
 */
export function openZonePanel(zoneId: number): void {
  focusZone(zoneId);
  openPanel('zones');
}
