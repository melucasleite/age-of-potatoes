// ONE PANEL ANYWHERE — the HUD's single-open invariant, as a module ([[089]]).
//
// ────────────────────────────────────────────────────────────────────────────────────
//  WHY THIS LEFT `HudRoot`. Item 089 floats the bag and the build menu over the canvas
//  ("Inventory and build should show as a floating window in the middle of the screen.
//  Don't let them overlap. If one is already open, close it and open the other one"),
//  and rules that the floats and the sidebar's contextual slot share ONE invariant:
//  one panel open anywhere, ever. That machine used to live inside `usePanels` as a
//  `useState` — unreachable from a test, because vitest here runs with no DOM. Moving
//  it to module scope keeps the exact shape `build-panel.ts` and `hotbar.ts` already
//  use — a module-scope contract with a subscription — and makes "I then B closes the
//  bag" a plain function call a test can pin.
// ────────────────────────────────────────────────────────────────────────────────────
//
// STILL ONE NAME, NEVER A FLAG PER PANEL. Four things can be open — research, shop
// (the slot), bag (a float) — plus build, whose truth stays in the INPUT layer
// (`build-panel.ts`) because B, the arrows and the walk-stop are modal there ([[071]]).
// This module holds the one local name and folds build in at read time: build simply
// wins while it is up. The invariant is kept at every door:
//
//   · every local opener calls `buildMenuClose()` first, so the input layer AGREES the
//     menu is gone rather than needing B pressed twice;
//   · the module subscribes to the build seam and evicts the local panel the moment the
//     menu opens — a real state change, so closing the menu later must not resurrect a
//     panel evicted weeks ago.
//
// NONE OF THIS IS SIM STATE (§12). Which panel is open is never a `Command`, never
// traced, never hashed, never saved. A replay must not depend on it.

// Relative rather than the `@/` alias — the house rule `item-art.ts` states: `@/*` is a
// tsconfig path that Next resolves and vitest does not, and this file has a test.
import { buildMenuClose, buildMenuSnapshot, subscribeBuildMenu } from '../game/input/build-panel';

/** The two occupants of the sidebar's contextual slot. */
export type SlotPanel = 'research' | 'shop';
/** Everything this module owns directly — the slot panels plus the floating bag. */
export type LocalPanel = SlotPanel | 'bag';
/** Everything `panelSnapshot` can answer — the build float's truth lives in the input layer. */
export type PanelName = LocalPanel | 'build';

let localOpen: LocalPanel | null = null;
const listeners = new Set<() => void>();

/** A primitive (string | null), so `useSyncExternalStore` bails on `Object.is` — the build
 * seam notifies on every cursor move, and none of those may re-render the HUD root. */
export function panelSnapshot(): PanelName | null {
  return buildMenuSnapshot().open ? 'build' : localOpen;
}

/** The server render and the pre-attach client render: everything closed, forever, cheaply. */
export function panelServerSnapshot(): PanelName | null {
  return null;
}

/** One subscription covering both doors: local panel changes AND the build seam's publishes. */
export function subscribePanels(listener: () => void): () => void {
  listeners.add(listener);
  const unsubscribeBuild = subscribeBuildMenu(listener);
  return () => {
    listeners.delete(listener);
    unsubscribeBuild();
  };
}

function setLocal(next: LocalPanel | null): void {
  if (localOpen === next) return;
  localOpen = next;
  for (const listener of listeners) listener();
}

/**
 * The toggle every row and key goes through: T, G, I, and their sidebar rows. Closing the
 * build menu first is not optional — it is half the invariant (the other half is the
 * eviction below), and it must go through the seam's own door so the input layer's modal
 * state agrees.
 */
export function togglePanel(panel: LocalPanel): void {
  buildMenuClose();
  setLocal(localOpen === panel ? null : panel);
}

/**
 * Open, never toggle — the input layer's panel REQUESTS come here (`input/panels.ts`): a
 * click on the sell bin means "open the stand", and toggling would shut the board in the
 * face of a player who clicked the bin twice.
 */
export function openPanel(panel: LocalPanel): void {
  buildMenuClose();
  setLocal(panel);
}

/** Esc and the close buttons. Build is not closed here — the input layer's Esc cascade
 * already closed the menu before any HUD listener fires. */
export function closeLocalPanel(): void {
  setLocal(null);
}

// THE EVICTION, registered once at module scope for the life of the page — this module is
// a singleton exactly as the seam it watches is. B pressed while the shop, the tree or the
// bag is open: the menu opens in the input layer and the local panel must yield, as a real
// state change rather than a render-time preference.
subscribeBuildMenu(() => {
  if (buildMenuSnapshot().open) setLocal(null);
});
