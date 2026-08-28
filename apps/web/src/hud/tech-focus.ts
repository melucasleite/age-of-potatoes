// WHICH NODE THE RESEARCH PANEL SHOULD ARRIVE ON ([[148]]).
//
// A module-scope contract with a subscription, exactly like `zone-focus.ts` beside it — and
// for the same two reasons. First, THE SETTER LIVES IN ANOTHER TREE ENTIRELY: the build
// menu's locked cells are the input layer's, and their click reaches the HUD through the
// `panels.ts` request seam, which `HudRoot` answers by calling `openResearchPanel` here. A
// `useState` inside the panel could not be reached from that handler without threading it
// through `HudRoot`'s props. Second, vitest here runs with no DOM, so a module is testable
// and a hook is not.
//
// A PENDING REQUEST, NOT A STANDING SELECTION — the one deliberate difference from
// `zone-focus.ts`. The zones panel is a list with a detail pane and "which zone" is a fact
// worth keeping; the research panel already owns its selection and seeds it from the
// frontier, which is the right opening for every T press. This module holds only the
// override: "the player clicked a row locked behind THIS node, land on it". It is consumed
// once, so the next plain T opens on the frontier again rather than on a lock the player
// resolved twenty minutes ago.
//
// NOT SIM STATE (§12). Which node a panel opens on is never a `Command`, never traced,
// never hashed, never saved. A replay must not depend on it.

import { openPanel } from './panel-state';

/** `''` means "nothing requested" — the panel falls back to its frontier seed. */
let pending = '';
const listeners = new Set<() => void>();

/**
 * Ask the panel to land on a node, without opening anything. Notifies so an ALREADY-OPEN
 * panel adopts the request too; a closed one finds it waiting on mount via the consume.
 */
export function focusTech(techId: string): void {
  if (pending === techId) return;
  pending = techId;
  for (const listener of listeners) listener();
}

/**
 * Take the pending request, leaving none. The panel calls this on mount and on every
 * notify; returning `''` for "nothing waiting" keeps the common path allocation-free.
 * No notify on the way out — consuming is the panel acting, not news for anyone else.
 */
export function consumeFocusedTech(): string {
  const id = pending;
  pending = '';
  return id;
}

export function subscribeTechFocus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The locked build cell's verb: show me the node in my way.
 *
 * OPEN, NEVER TOGGLE — the ruling `openPanel` already carries: clicking a second locked row
 * while the manual is up means "show me that one instead", and a toggle would shut the
 * manual in the face of a player who clicked two locks in a row.
 */
export function openResearchPanel(techId: string): void {
  focusTech(techId);
  openPanel('research');
}
