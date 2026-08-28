// The one thing the input layer is allowed to say to the React HUD: "open that panel".
//
// ────────────────────────────────────────────────────────────────────────────────────
//  WHY THIS EXISTS, AND WHY IT IS NOT THE HUD STORE.
//
//  `hudStore` runs the other way round. The host publishes world readings INTO it and the
//  HUD reads them out; its two doors back — `selectTool` and `dispatch` — are the HUD
//  reaching into the game, not the game reaching into the HUD. Nothing in it can carry a
//  one-shot event, and giving it one would be worse than a new file: every slice in that
//  store is compared field by field precisely so that publishing does not re-render, and an
//  "open the shop" flag would have to be set, consumed, and cleared through that machinery
//  to fire exactly once.
//
//  So this is a signal, not state. It is the same shape as `lod.ts` — a module-scope
//  contract between two layers that must not import each other's internals — and for the
//  same reason: threading it through `InputHost` would widen the narrowest interface in the
//  app for a callback that only one listener will ever want.
// ────────────────────────────────────────────────────────────────────────────────────
//
// WHICH PANEL IS OPEN REMAINS THE HUD'S BUSINESS. This says "the player asked for the
// stand"; the HUD decides what that means, whether something else is already up, and
// whether to toggle or replace. Nothing here remembers anything, so a listener that
// subscribes later hears nothing that happened before it — which is correct for a keypress
// and is why there is no "last request" field to go stale.
//
// NONE OF THIS IS SIM STATE (§12). A panel opening is not a `Command`, is never traced,
// never hashed, and never saved. A replay must not depend on which panel was showing.

/**
 * The panels the input layer knows how to ask for. The HUD owns the real list; these are
 * the names both sides have agreed on, so a typo is a type error rather than a dead click.
 */
export type PanelRequest = 'shop' | 'research' | 'inventory';

/**
 * What a request may carry beside the panel's name ([[148]]): a locked build row asks for
 * the research panel OPEN ON THE NODE THAT LOCKS IT, and the id rides the request rather
 * than a second seam. Still a signal, not state — nothing here remembers the id, and a
 * listener that subscribes late hears nothing, exactly as the header promises.
 */
export interface PanelRequestOptions {
  /** For `'research'`: the tech node the panel should arrive focused on. */
  readonly techId?: string;
}

export type PanelListener = (panel: PanelRequest, options?: PanelRequestOptions) => void;

const listeners = new Set<PanelListener>();

/**
 * Ask the HUD to open a panel. A no-op when nothing is listening, which is exactly what
 * should happen in a test, on the server, and in the seconds before the HUD mounts.
 */
export function requestPanel(panel: PanelRequest, options?: PanelRequestOptions): void {
  for (const listener of listeners) listener(panel, options);
}

/**
 * Listen for those requests. Returns the unsubscribe, so a React effect can be one line.
 *
 * StrictMode subscribes, unsubscribes and resubscribes; a `Set` makes all three idempotent
 * and makes a leaked listener impossible to double-fire.
 */
export function onPanelRequest(listener: PanelListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
