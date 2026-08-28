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
// STILL ONE NAME, NEVER A FLAG PER PANEL. Four things can be open — research, shop and bag,
// plus build, whose truth stays in the INPUT layer (`build-panel.ts`) because B, the arrows
// and the walk-stop are modal there ([[071]]). SINCE [[093]] ALL FOUR ARE THE SAME FLOATING
// WINDOW, by the owner's consolidation ruling, which changes nothing here and is worth
// saying anyway: this module never knew where a panel rendered, only that no two of them
// could be up at once, and that is precisely why moving research and the shop out of the
// sidebar was a presentation change rather than a state-machine rewrite.
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

/**
 * Everything this module owns directly. `SlotPanel` is gone ([[093]]): it named research and
 * the shop as "the two occupants of the sidebar's contextual slot", and there is no slot any
 * more — all four panels are the same centred floating window, so the only distinction left
 * is which LAYER holds the truth, not which part of the screen it lands in.
 *
 * FIVE SINCE [[102]]. `PanelFrame.tsx` set the test for a new panel in as many words — "a fifth
 * row must be a `PanelRow` and nothing else" — and the zones panel is it: one name added to
 * this union, one row, one window, no new machinery. It is a FLOAT rather than a sidebar card
 * for a reason that is not taste: [[096]] unmounts the sidebar's body when the dock is folded,
 * so anything living in `.sideContext` or `.sidePapers` vanishes with it, and the four zone
 * verbs would have shipped unreachable for every player who ever pressed `[`. The float lives
 * in `.stage`, and its key is bound outside the fold — so the panel opens folded or not.
 *
 * SIX WITH THE ACCOUNT PANEL. It is meta rather than gameplay — sign-in, the leaderboard
 * name — so it gets no `PanelRow` and no hotkey: its opener is a chrome button beside "exit
 * game", which shares that button's known limitation of folding away with the dock. It joins
 * THIS union all the same, because a window over the canvas obeys the one-open invariant no
 * matter what kind of thing it is.
 */
export type LocalPanel = 'research' | 'shop' | 'bag' | 'zones' | 'account';
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
// a singleton exactly as the seam it watches is. B pressed while the stand, the tree or the
// bag is open: the menu opens in the input layer and the local panel must yield, as a real
// state change rather than a render-time preference.
subscribeBuildMenu(() => {
  if (buildMenuSnapshot().open) setLocal(null);
});
