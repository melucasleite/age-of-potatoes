// The one number the HUD and the canvas agree on: how wide the docked sidebar is — and,
// since [[096]], whether it is showing at all.
//
// LEAF MODULE, LIKE `cadence.ts` AND `exit.ts` — `GameCanvas` imports this to offset the canvas
// container, and importing the `@/hud` barrel from the game chunk would drag the whole
// React tree along to obtain one integer. Nothing below imports React; the collapsed flag is
// a module-scope store with a subscription, exactly the shape `panel-state.ts` and
// `hotbar.ts` already use, so `useSyncExternalStore` can read it from either side of the
// seam without either side owning the other.
//
// WHY 440, MEASURED RATHER THAN GUESSED ([[069]]). The number was sized around the bag's
// 6-column grid (390px + padding + scrollbar) when the bag was a dock section. Item 089
// floated the bag out of the dock, but the width DOES NOT move with it: the canvas is
// `calc(100vw - this)` and the renderer's pixel-snap discipline ([[026]]) depends on the
// width never breathing — resizing the dock because a panel left it would resize the whole
// stage. Everything still in the dock reflows comfortably below 440: the tech tree drops
// to two branch columns, the shop's rows wrap, the field card stretches to fit.
//
// ─────────────────────────────────────────────────────────────────────────────────────
//  THE COLLAPSE ([[096]]), AND WHY IT DOES NOT BREAK THE RULE ABOVE.
//
//  "Constant, never responsive" was never about the number being immortal — it was about
//  the width never BREATHING: never tracking the viewport, never animating, never handing
//  the renderer a different stage on consecutive frames. A collapse is a DISCRETE,
//  PLAYER-ASKED change between two fixed values, which is the same species of event as the
//  browser window being resized, and the renderer has always handled that: `GameHost`'s
//  ResizeObserver reads the settled container rect and calls `camera.setViewport` once.
//
//  So the contract is: TWO WIDTHS, ONE FUNCTION, AND NO CSS TRANSITION ON THE WIDTH. The
//  third clause is the load-bearing one. An animated collapse would fire the ResizeObserver
//  on every frame of the animation, and each one would re-snap the camera against a
//  different viewport — item 026's double pixel snap would be doing its arithmetic against
//  a moving target and the world would judder for the length of the transition. The panel
//  snaps between the two widths in one layout pass; anything that fades, fades the
//  CONTENTS, never the column.
//
//  WHY THE COLLAPSED WIDTH IS NOT ZERO. A player who folds the panel away has to be able to
//  find it again, so what is left is the handle rail itself — still docked, still opaque,
//  still to the LEFT of where the canvas starts. Item 069's rule that nothing ever covers
//  the lot survives a collapse intact, which a handle floating over the canvas would not
//  have managed.
//
//  WHY THE FLAG IS GLOBAL RATHER THAN PER-WORLD. The hotbar persists per world id ([[061]])
//  because its contents ARE world-shaped — an item shortcut points at something in that
//  world's bag. How much screen the player wants the chrome to take is a property of the
//  player's monitor, not of their farm, and a collapse that quietly came back on the next
//  lot would read as the setting not having worked. Same side of the line either way:
//  never a `Command`, never in `WorldState`, `SavePayload`, `hashState()`, or the hash —
//  a replay must not depend on which panels were showing (§12).
// ─────────────────────────────────────────────────────────────────────────────────────

/** The docked sidebar, open. Unchanged since [[069]]; see the header for the measurement. */
export const SIDEBAR_WIDTH_PX = 440;

/**
 * The sidebar, folded: the handle rail and nothing else.
 *
 * Wide enough to be an honest click target and to carry a chevron at the HUD's smallest
 * type size, narrow enough that the answer to "what did I get for collapsing it" is
 * "essentially the whole column". The rail is present in BOTH states — expanded it is the
 * right-hand 24px of the 440, which is why collapsing does not move the canvas edge by
 * `SIDEBAR_WIDTH_PX` but by the difference between these two numbers.
 */
export const SIDEBAR_HANDLE_PX = 24;

/**
 * `[`, and it is chrome-shaped on purpose.
 *
 * CHECKED AGAINST THE WHOLE GRAMMAR, exhaustively, because a collision here is silent: the
 * walk keys WASD and the arrows, `Space` (drag-to-pan), `Digit0`–`Digit9` (the hotbar,
 * [[061]]), `KeyB` (build), `KeyR` (rotate), `KeyC` (cycle crop), `KeyT`/`KeyG`/`KeyI` (the
 * three panel rows), `KeyP` (the reports layer), `Escape` (the four-step cascade),
 * `Backquote` (the debug panel), `F3` (perf), `Equal`/`Minus` and their numpad twins (the
 * zoom ladder), `Enter`/`NumpadEnter` (build the focused cell). `BracketLeft` is in none of
 * them and the browser does nothing with a bare `[`, so there is no `preventDefault()` here
 * either — a layer that swallows keys is one bug from swallowing a key the game needed.
 *
 * A LETTER WOULD HAVE BEEN THE WRONG SHAPE. T for tree, G for goods, I for inventory, B for
 * build: the letters are mnemonics for things the player OPENS. The sidebar is not a thing
 * you open, it is the chrome you fold, and it belongs with the other chrome keys — backtick,
 * F3, plus and minus — which are all punctuation. The bracket also points at the edge it
 * folds toward, and `]` is deliberately left unbound as its mirror if a right-hand panel
 * ever wants one.
 */
export const SIDEBAR_TOGGLE_CODE = 'BracketLeft';

/** What to print in help copy and on the handle's tooltip. `KeyboardEvent.code` is not it. */
export const SIDEBAR_TOGGLE_LABEL = '[';

/** Global, not per world — see the header. Namespaced so it cannot collide with a save key. */
export const SIDEBAR_STORAGE_KEY = 'snack.hud.sidebarCollapsed';

/**
 * THE ONE PLACE THE CANVAS EDGE IS DECIDED. `GameCanvas`'s `inset`, the sidebar's own
 * `width`, and the reports dock's `left` all come through here, so there is no second
 * constant to drift out of step with the first — the failure item 069 named and the reason
 * `ReportsLayer` computes its offset inline instead of typing 440 into a stylesheet.
 */
export function sidebarWidth(collapsed: boolean): number {
  return collapsed ? SIDEBAR_HANDLE_PX : SIDEBAR_WIDTH_PX;
}

/**
 * How wide the dock's CONTENTS are — the column minus the rail that outlives them.
 *
 * ONE READER, AND IT IS THE WHOLE REASON THIS EXISTS ([[106]]). Folded, the at-the-machine
 * cards do not vanish with the body any more: they float over the canvas, at exactly this
 * width. A card that changed shape depending on whether the dock beside it happened to be
 * open would be two cards, and the entire claim of the float is that it is the SAME card in a
 * different place — same dials, same grid, same line wraps, nothing to re-read.
 *
 * DERIVED, NEVER TYPED OUT, for the reason the function above exists at all: 416 written into
 * a stylesheet is the second constant item 069 warned about, and it would go stale silently —
 * the float would simply be a little wrong, on one state of one toggle, forever.
 */
export function sidebarBodyWidth(): number {
  return SIDEBAR_WIDTH_PX - SIDEBAR_HANDLE_PX;
}

/**
 * `null` until something asks, because this module is imported by components that render on
 * the SERVER and reading `localStorage` at module scope would throw there. The first
 * `sidebarCollapsed()` on the client resolves it once and caches: `useSyncExternalStore`
 * calls its snapshot on every render and compares with `Object.is`, so a getter that
 * re-read storage each time would be doing synchronous I/O in a render path.
 */
let collapsed: boolean | null = null;

const listeners = new Set<() => void>();

function defaultStorage(): Storage | null {
  // Guarded for SSR, the same way `hotbar.ts` guards: nothing touches storage until a
  // client render or an effect asks.
  return typeof window === 'undefined' ? null : window.localStorage;
}

let storageProvider: () => Storage | null = defaultStorage;

/** The client snapshot. Stable between changes, which is what `useSyncExternalStore` needs. */
export function sidebarCollapsed(): boolean {
  if (collapsed === null) {
    let stored: string | null = null;
    try {
      stored = storageProvider()?.getItem(SIDEBAR_STORAGE_KEY) ?? null;
    } catch {
      // Private browsing, or storage disabled entirely. The session starts open.
      stored = null;
    }
    collapsed = stored === '1';
  }
  return collapsed;
}

/**
 * The server render, and the client's hydration pass: OPEN, always.
 *
 * React uses this instead of the client snapshot while hydrating and re-renders with the
 * real value immediately after, which is exactly the behaviour wanted — the alternative is
 * a server HTML string that disagrees with `localStorage` and a hydration mismatch on every
 * load for a player who collapsed the panel.
 */
export function sidebarServerSnapshot(): boolean {
  return false;
}

export function subscribeSidebar(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setSidebarCollapsed(next: boolean): void {
  if (sidebarCollapsed() === next) return;
  collapsed = next;
  try {
    storageProvider()?.setItem(SIDEBAR_STORAGE_KEY, next ? '1' : '0');
  } catch {
    // Quota, private browsing: the session keeps the choice; the next one starts open.
  }
  for (const listener of listeners) listener();
}

/** The handle and the `[` key both come through here. */
export function toggleSidebar(): void {
  setSidebarCollapsed(!sidebarCollapsed());
}

/**
 * Test seam, and the only reason this module has one: vitest runs here with no DOM, so a
 * test cannot reach `window.localStorage` to prove the flag survives a reload. Takes the
 * storage the same way `hotbar.ts`'s `Hotbar` takes its own, and re-arms the lazy read so
 * the next `sidebarCollapsed()` goes back to the provider. Production never calls it.
 */
export function resetSidebarForTest(provider: () => Storage | null = defaultStorage): void {
  storageProvider = provider;
  collapsed = null;
}
