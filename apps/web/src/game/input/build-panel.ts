// The build menu's state, published across the input→HUD seam ([[071]]).
//
// ────────────────────────────────────────────────────────────────────────────────────
//  WHY THIS EXISTS. Item 069 docked every panel into the sidebar's one contextual slot,
//  and item 071 makes the build menu a grid of sprites — which means the menu's SURFACE
//  is React now, rendered beside the canvas rather than over it. But the menu's BRAIN
//  cannot move: it is modal over the digits and the arrow keys, it stops the player
//  walking, and all of that lives in `keyboard.ts`/`system.ts` against `menuOpen`. So
//  ownership stays where the modality is — the input layer — and this module is the
//  window React watches it through.
//
//  It is `lod.ts`'s pattern with a subscription bolted on: a module-scope contract
//  between two layers that must not import each other's internals. `panels.ts` (the
//  one-shot "open that panel" signal) is deliberately not reused — a menu with a cursor
//  is STATE, not an event, and a listener that subscribes late must see the current
//  truth, which is exactly what `panels.ts`'s header promises never to provide.
// ────────────────────────────────────────────────────────────────────────────────────
//
// The store side follows `hud/store.ts`'s three rules at miniature scale: snapshots are
// frozen and reference-stable so `useSyncExternalStore` bails on `Object.is`; a publish
// that changes nothing notifies nobody; and the rows are compared field by field because
// they are re-derived a few times a second while the menu is open (`InputSystem.update`)
// and almost never actually differ.
//
// NONE OF THIS IS SIM STATE (§12). Which menu is open, where its cursor sits — never a
// `Command`, never traced, never hashed, never saved. A replay must not depend on it.

import type { BuildRow } from './build-menu';

export interface BuildMenuSnapshot {
  readonly version: number;
  readonly open: boolean;
  /** Index into `rows`. Meaningless while `open` is false. */
  readonly cursor: number;
  /** The armed `ToolMode`, for the "you already hold this" highlight. −1 for none. */
  readonly armedTool: number;
  readonly rows: readonly BuildRow[];
}

const ZERO: BuildMenuSnapshot = Object.freeze({
  version: 0,
  open: false,
  cursor: 0,
  armedTool: -1,
  rows: Object.freeze([]) as readonly BuildRow[],
});

let snapshot: BuildMenuSnapshot = ZERO;
const listeners = new Set<() => void>();

export function buildMenuSnapshot(): BuildMenuSnapshot {
  return snapshot;
}

/** The server render and the pre-attach client render: closed, forever, cheaply. */
export function buildMenuServerSnapshot(): BuildMenuSnapshot {
  return ZERO;
}

export function subscribeBuildMenu(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Called by `InputSystem` — on open, close, every cursor move, and the periodic row
 * refresh while the menu is up. Returns without notifying when nothing moved, which is
 * the common case for the refresh: prices only change when money does.
 */
export function publishBuildMenu(
  open: boolean,
  cursor: number,
  armedTool: number,
  rows: readonly BuildRow[],
): void {
  if (sameMenu(snapshot, open, cursor, armedTool, rows)) return;
  snapshot = Object.freeze({
    version: snapshot.version + 1,
    open,
    cursor,
    armedTool,
    rows: Object.freeze(rows.map((row) => Object.freeze({ ...row }))),
  });
  for (const listener of listeners) listener();
}

function sameMenu(
  current: BuildMenuSnapshot,
  open: boolean,
  cursor: number,
  armedTool: number,
  rows: readonly BuildRow[],
): boolean {
  if (current.open !== open || current.cursor !== cursor || current.armedTool !== armedTool) {
    return false;
  }
  if (current.rows.length !== rows.length) return false;
  for (let i = 0; i < rows.length; i++) {
    const a = current.rows[i]!;
    const b = rows[i]!;
    // `label`, `hint`, `group` and `frame` are functions of `tool` and never move within a
    // build; `price`, `locked`, `lockReason` and `affordable` are the live projection.
    if (
      a.tool !== b.tool ||
      a.price !== b.price ||
      a.locked !== b.locked ||
      a.lockReason !== b.lockReason ||
      a.affordable !== b.affordable
    ) {
      return false;
    }
  }
  return true;
}

// --- the doors back in ---------------------------------------------------------------------
//
// A click on a cell must do exactly what Enter does — one code path that can arm a tool, the
// same property the old in-canvas menu kept with its shared `armCursor()`. The system
// registers its handlers on attach; before a host exists (tests, the server, the seconds
// before mount) the doors are no-ops, which is correct because the menu cannot be open then.

export interface BuildMenuHooks {
  /** Move the cursor to `index` and arm it — the click path. Locked cells refuse inside. */
  armAt(index: number): void;
  close(): void;
}

let hooks: BuildMenuHooks | null = null;

/** Returns the unregister. A stale host unregistering after its successor is a no-op. */
export function registerBuildMenuHooks(next: BuildMenuHooks): () => void {
  hooks = next;
  return () => {
    if (hooks === next) hooks = null;
  };
}

export function buildMenuArmAt(index: number): void {
  hooks?.armAt(index);
}

/**
 * Also called by the HUD when another panel takes the contextual slot (T, G, the toggles):
 * one slot, one occupant, and the input layer must agree the menu is gone or B would need
 * pressing twice.
 */
export function buildMenuClose(): void {
  hooks?.close();
}
