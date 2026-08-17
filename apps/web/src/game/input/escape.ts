// WHAT ONE PRESS OF ESCAPE MEANS ([[126]]) — the whole cascade, as a pure function.
//
// ────────────────────────────────────────────────────────────────────────────────────
//  WHY IT LEFT `keyboard.ts`. The ladder was six lines of `else if` inside a DOM handler,
//  and item 126 adds a sixth rung whose one acceptance criterion — "one Escape press
//  advances exactly one rung, never two" — is a statement about the LADDER rather than
//  about the browser. There is no DOM in this workspace's test environment, so a cascade
//  that can only be reached through a `keydown` listener is a cascade nothing can pin.
//  The precedent is `nextCrop` and `nextLiquid` in `system.ts`: the decision is a pure
//  function of plain values, so a test drives every combination without a canvas, and the
//  handler is left holding only the part that genuinely needs a browser.
//
//  NOTHING HERE IS SIM STATE (§12). Which panel is open, what is armed, whether the world
//  is paused: none of it is a `Command`, none of it is traced, hashed or saved, and a
//  replay must not depend on any of it.
// ────────────────────────────────────────────────────────────────────────────────────
//
// ── THE ORDER, AND THE ARGUMENT FOR IT ──────────────────────────────────────────────
//
// Reading down, Escape closes the most specific thing that is open, and only reaches the
// next rung when the one above it has nothing to do. In order:
//
//   1. CLOSE THE PAUSE MENU. Top of the list precisely BECAUSE it is opened at the bottom
//      — see rung 6. A modal is the innermost thing on screen while it is up, so it is
//      the first thing Escape takes away; that it is also the LAST thing Escape reaches
//      for when nothing is open is not a contradiction, it is what "modal" means. The
//      menu can only open when every rung below it is idle, so this rung and the five
//      under it are mutually exclusive in practice, and putting it first makes the
//      round trip — open on one press, close on the next — true by construction.
//   2. CLOSE THE BUILD MENU ([[071]]).
//   3. CLOSE THE DEBUG PANEL ([[075]]). Esc typed INSIDE the cheat input never gets here:
//      the focus guard in `keyboard.ts` returns first and the HUD's own input closes the
//      panel through `debugPanelClose`.
//   4. ABANDON THE DRAG — a working queue counts ([[074]]).
//   5. CLOSE THE GRABBER CARD ([[099]]). It sits BELOW the drag and ABOVE the disarm
//      because it is the least urgent thing that is nonetheless OPEN, and it is a real
//      rung rather than a no-op for the common case: the card outlives the click that
//      opened it, so unlike a hover it needs dismissing.
//   6. PUT THE TOOL DOWN. What Esc means once nothing is open at all.
//   7. PAUSE. Nothing open, and the hand already empty.
//
// THE DISARM BECAME CONDITIONAL AND THAT IS THE WHOLE OF RUNG 7'S COST. It used to run
// unconditionally, which was harmless when it was the floor of the ladder and is not
// harmless with something underneath it: an unconditional disarm is a floor nothing can
// ever fall through, and the pause menu would have been unreachable. `toolArmed` is the
// caller's `tool !== ToolMode.Hand`.
//
// WHY THE PAUSE MENU IS THE FLOOR AND NOT THE CEILING. A half-drawn belt run is the thing
// a player wants back first, and a pause menu that ate the cancel press would destroy work
// instead of undoing it — the player pressed Escape to get their drag back and lost it to a
// menu. Every rung above 7 is somebody mid-thought; rung 7 is somebody who has finished.

/** The one thing a press of Escape does. Exactly one, ever. */
export type EscapeRung =
  | 'close-pause'
  | 'close-build-menu'
  | 'close-debug-panel'
  | 'cancel-drag'
  | 'close-grabber-card'
  | 'disarm'
  | 'open-pause';

/** Everything the decision depends on, as plain booleans the caller reads off its layers. */
export interface EscapeState {
  /** The pause menu is up and the world is stopped. */
  readonly paused: boolean;
  /** The build menu is up ([[071]]). */
  readonly menuOpen: boolean;
  /** The debug panel is up ([[075]]). */
  readonly debugPanelOpen: boolean;
  /** A pointer gesture is mid-flight — a belt run, a zone, a working queue ([[074]]). */
  readonly dragging: boolean;
  /** The grabber card is up ([[099]]). */
  readonly grabberCardOpen: boolean;
  /** Something other than the Hand is armed. `tool !== ToolMode.Hand`, at the call site. */
  readonly toolArmed: boolean;
}

/**
 * Which rung this press takes. Total, deterministic, and never more than one step.
 *
 * The `return` on every branch is the guarantee the acceptance criterion asks for: there is
 * no path through this function that performs two things, because it performs none — it
 * NAMES one, and the caller does it.
 */
export function escapeRung(state: EscapeState): EscapeRung {
  if (state.paused) return 'close-pause';
  if (state.menuOpen) return 'close-build-menu';
  if (state.debugPanelOpen) return 'close-debug-panel';
  if (state.dragging) return 'cancel-drag';
  if (state.grabberCardOpen) return 'close-grabber-card';
  if (state.toolArmed) return 'disarm';
  return 'open-pause';
}
