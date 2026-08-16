// The watering can's three faces ([[073]]): full, half, empty, from the sim's charge count.
//
// ── ONE THRESHOLD, WRITTEN ONCE ─────────────────────────────────────────────────────────
//
// The owner's ruling gives the can three states and the item's constraint is that no
// surface computes its own version of "half": the HUD chip, the hotbar slot and the held
// sprite must flip on the same pour. This module is that single definition on the render
// side of the seam.
//
// RECONCILIATION NOTE (wave 11): the HUD lane owns the chip and the hotbar slot and had
// not landed when this was written. The item asks for ONE exported helper shared by HUD
// and render — this file is pure (no Pixi, no scene), importable from either side, and
// deliberately tiny so whichever module the HUD lane lands can either import it or be
// collapsed into it in one edit. If both exist after the wave, exactly one must survive.
//
// The thresholds, from the vault note verbatim:
//
//   full  = charges >  max/2
//   half  = 0 < charges <= max/2
//   empty = charges <= 0
//
// At the shipped max of 20 that is full for 11..20, half for 1..10, empty for 0 — "half"
// deliberately covers the whole running-low band, which is why the art lane's half frame
// reads as nearly drained rather than as half a can.

/** The three states the can can wear. Order is drainage order, for whoever sorts by it. */
export type CanFillState = 'full' | 'half' | 'empty';

/** The atlas frame per state. `tool_water` is input's own held/slot frame for the tool. */
export const CAN_STATE_FRAME: Readonly<Record<CanFillState, string>> = {
  full: 'tool_water',
  half: 'tool_water_half',
  empty: 'tool_water_empty',
};

/**
 * Which face the can shows for a charge count.
 *
 * Defensive about a nonsense max (0 or negative — a view a newer sim might publish) by
 * answering off the charges alone: something in the can draws the full can, nothing draws
 * the empty one. Never throws; this runs per frame in the held-tool overlay.
 */
export function canFillState(charges: number, chargesMax: number): CanFillState {
  if (charges <= 0) return 'empty';
  if (chargesMax > 0 && charges <= chargesMax / 2) return 'half';
  return 'full';
}

/** The frame for a charge count — the two lookups every consumer wants, composed. */
export function canFrame(charges: number, chargesMax: number): string {
  return CAN_STATE_FRAME[canFillState(charges, chargesMax)];
}
