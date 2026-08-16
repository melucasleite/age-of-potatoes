// The BUILD row's one verb: toggle the build menu from the sidebar ([[076]]).
//
// THE MENU'S BRAIN LIVES IN THE INPUT LAYER and must stay there — B, the arrows and the
// walk-stop are modal in `keyboard.ts`/`system.ts` against `menuOpen`, and item 071's seam
// (`build-panel.ts`) is a window onto that state, not a second owner of it. The seam exports
// a door for CLOSING (`buildMenuClose`, which the HUD already uses to keep the one-occupant
// invariant) but none for opening: nothing outside the input layer ever needed one before
// this row existed.
//
// SO OPENING GOES THROUGH B ITSELF. The row synthesises the exact keydown the player's
// finger would produce and lets `keyboard.ts` do what it always does — stop the walk, build
// the rows, publish the snapshot. One code path for key and click, which is the same
// property the menu's own cells keep via `buildMenuArmAt`. When the input lane lands a
// `buildMenuToggle()` on the seam, this dispatcher collapses to that one call.
//
// NONE OF THIS IS SIM STATE (§12): which panel is open is never a command, never traced,
// never hashed.

// Relative rather than the `@/` alias — the house rule `item-art.ts` states: `@/*` is a
// tsconfig path that Next resolves and vitest does not, and this file has a test.
import { buildMenuClose, buildMenuSnapshot } from '../game/input/build-panel';

/**
 * Toggle the build panel the way B does.
 *
 * `dispatchKey` is a test seam: vitest runs without a DOM, and the interesting half of this
 * function — close when open, ask the keyboard layer when shut — is pure enough to pin
 * without one.
 */
export function toggleBuildPanel(dispatchKey: (code: string) => void = dispatchKeydown): void {
  if (buildMenuSnapshot().open) {
    buildMenuClose();
    return;
  }
  dispatchKey('KeyB');
}

/** The real dispatcher: one synthetic keydown, exactly the event `keyboard.ts` switches on. */
function dispatchKeydown(code: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
}
