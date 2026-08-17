// The pause menu's state, published across the input→HUD seam ([[126]]).
//
// ────────────────────────────────────────────────────────────────────────────────────
//  `debug-panel.ts`'s pattern verbatim, for `debug-panel.ts`'s reason. The SURFACE is the
//  HUD's (React renders the window, the farmer picker and the three buttons; this module
//  never learns what a component is), but the KEY that opens it is `keyboard.ts`'s and the
//  modality — the world stops, and every game key but Escape goes inert — belongs to the
//  input layer. So `InputSystem` owns open/closed and this module is the window React
//  watches it through: a frozen snapshot store with a subscription, plus a registered hook
//  as the door back in.
// ────────────────────────────────────────────────────────────────────────────────────
//
// PAUSE IS A CLIENT CONCERN AND THIS MODULE IS AS CLOSE AS IT GETS TO THE WORLD. Nothing
// here is sim state (§12): the pause is never a `Command`, never traced, never hashed and
// never saved, and there is no flag in `WorldState` — the sim replays twenty golden
// fixtures to pinned hashes, and a UI flag in the world would make every one of those
// goldens a statement about menus. The loop simply stops calling `step()` while `open` is
// true (`GameHost.frame`), which is the only mechanism that can pause a deterministic sim
// without lying to it.

export interface PauseMenuSnapshot {
  readonly version: number;
  /** The menu is up and the world is stopped. Escape opens it and Escape closes it. */
  readonly open: boolean;
}

const ZERO: PauseMenuSnapshot = Object.freeze({ version: 0, open: false });

let snapshot: PauseMenuSnapshot = ZERO;
const listeners = new Set<() => void>();

export function pauseMenuSnapshot(): PauseMenuSnapshot {
  return snapshot;
}

/** The server render and the pre-attach client render: closed, forever, cheaply. */
export function pauseMenuServerSnapshot(): PauseMenuSnapshot {
  return ZERO;
}

/**
 * A plain boolean read, for the HUD's own key listeners.
 *
 * `HudRoot` binds T, G, I, Z and `[` on window listeners of its own, and a modal that only
 * silenced the INPUT layer's keys would still let a player open the bag behind the scrim —
 * so those effects ask this. A boolean rather than the snapshot because they are inside a
 * keydown handler and want one comparison, not an object.
 */
export function pauseMenuOpen(): boolean {
  return snapshot.open;
}

export function subscribePauseMenu(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Called by `InputSystem` on every open and close edge, and by nothing else. */
export function publishPauseMenu(open: boolean): void {
  if (snapshot.open === open) return;
  snapshot = Object.freeze({ version: snapshot.version + 1, open });
  for (const listener of listeners) listener();
}

// --- the door back in ------------------------------------------------------------------
//
// One hook, because the menu has one thing to ask the input layer for: shut. Resume is that
// door; the ESC button in the panel head is that door; Save & Exit does not use it at all —
// it asks `hud/exit.ts` for the ordered save-and-teardown ([[078]]), and the host's
// `input.detach()` closes this on the way out. Before a host exists (tests, the server, the
// seconds before mount) the door is a no-op, which is correct because the menu cannot be up.

export interface PauseMenuHooks {
  close(): void;
}

let hooks: PauseMenuHooks | null = null;

/** Returns the unregister. A stale host unregistering after its successor is a no-op. */
export function registerPauseMenuHooks(next: PauseMenuHooks): () => void {
  hooks = next;
  return () => {
    if (hooks === next) hooks = null;
  };
}

export function pauseMenuClose(): void {
  hooks?.close();
}
