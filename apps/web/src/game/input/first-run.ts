// In-world first-run affordances (item 040, instruction 2).
//
// A person who has never seen Snack Mogul should be farming within thirty seconds without
// reading anything — and the plan's answer is level design, not a tutorial system. What this
// module adds is the last inch of that: a gentle sign standing over the one thing worth
// looking at next. Nothing modal, nothing blocking, nothing to dismiss — the signs live in
// the pointer-events:none chrome layer, and they retire THEMSELVES by reading world state.
//
// ONE SIGN AT A TIME, and often none. §2's choreography is "always exactly one next thing",
// so two simultaneous pointers would be the tutorial arguing with itself — and the 040
// ruling's spirit applies here too: truth over quota. When the player is mid-loop and the
// world speaks for itself, the correct number of signs is zero.
//
// EVERY GATE IS DERIVED FROM `view()`, NEVER FROM TUTORIAL STATE. There is no "seen" flag
// anywhere — not in the sim (a tutorial bit in the hash would desync replays), and not in
// localStorage either (renderer flags forget, per the ceremony's history). The gates are
// facts the save already carries: a player who planted before reloading has
// `totalManualTouches > 0` in their stats, so the plant sign stays gone. The first sale ends
// the whole first-run phase forever, by the same arithmetic.
//
// THE DIGITS ARE READ OFF THE LIVE HOTBAR, not typed here. The bar is the player's layout
// ([[061]]); a hint that says "press 3" while the player has moved Plant to slot 7 would be
// the game lying about its own keyboard. `hotbarDigit` resolves the tool's current digit at
// read time, and a tool somehow off the bar (impossible for mandatory tools, but cheap to
// honour) drops the digit clause rather than inventing one.

import type { WorldView } from '@snack/sim';
import { MachineKind } from '@snack/sim';

import { hotbar, slotIndexToDigit } from './hotbar';
import { ToolMode } from './tools';

/** One world-anchored pointer. `tileX`/`tileY` may be fractional — the sign floats there. */
export interface GuideSign {
  readonly tileX: number;
  readonly tileY: number;
  readonly title: string;
  readonly body: string;
  /** True to hang the sign BELOW its anchor with an upward arrow; default floats above. */
  readonly below?: boolean;
}

const NO_SIGNS: readonly GuideSign[] = [];

/** The digit that arms `tool` on the player's current bar, as a string, or '' if none. */
export function hotbarDigit(tool: ToolMode): string {
  const slots = hotbar.slots;
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (slot !== null && slot !== undefined && slot.kind === 'tool' && slot.tool === tool) {
      return String(slotIndexToDigit(i));
    }
  }
  return '';
}

/**
 * The first-run signs for this frame. Pure: reads the view and the digit resolver, holds
 * nothing. Called once per frame from `InputSystem.update()`.
 *
 * The sequence, in the order a first session actually unfolds:
 *
 *   1. Hands that have never touched anything → the field, with the plant key.
 *   2. A harvest in hand that has never been sold → the stand.
 *   3. A can run dry before the first sale → the pond, with the water key.
 *
 * The stand outranks the pond when both apply, because selling is the payoff beat and the
 * next water can wait the length of one ka-ching.
 */
export function firstRunSigns(
  view: WorldView | null,
  digitOf: (tool: ToolMode) => string = hotbarDigit,
): readonly GuideSign[] {
  if (view === null) return NO_SIGNS;
  const stats = view.stats;

  // The first sale is the end of the first run, permanently. It is in the save, so it
  // survives every reload — a returning player never sees these again.
  if (stats.itemsSold > 0) return NO_SIGNS;

  // 1. Nothing ever done by hand: point at the field. `totalManualTouches` counts every
  // hand verb, so the sign retires on the first pour or planting — whichever teaches first.
  if (stats.totalManualTouches === 0) {
    const f = view.field;
    const digit = digitOf(ToolMode.Plant);
    // BELOW the field, arrow up. Placed by trying it against the running game at the spawn
    // camera on a 1280×720 viewport: the field's top row sits just above the viewport, and
    // everything from its centre up hides behind the HUD's left rail of cards. The strip
    // just south of the field is the one nearby ground that is reliably visible at the one
    // moment this sign matters, so the sign stands there and points up at the dirt.
    return [
      {
        tileX: f.originX + f.tilesWide / 2,
        tileY: f.originY + f.tilesHigh + 0.5,
        below: true,
        title: 'YOUR FIELD',
        body:
          digit === ''
            ? 'click the dirt to plant a potato'
            : `press ${digit}, click the dirt — potatoes`,
      },
    ];
  }

  // 2. Harvested by hand, never sold anything: point at the stand.
  if (stats.itemsHarvestedByHand > 0) {
    const bin = firstSellBin(view);
    if (bin !== null) {
      return [
        {
          tileX: bin.tileX + bin.tilesWide / 2,
          tileY: bin.tileY,
          title: 'THE STAND',
          body: 'click it — your harvest sells here',
        },
      ];
    }
  }

  // 3. The can is dry and the player has never sold: point at the pond. Just-in-time — it
  // appears the first time the can actually runs out, which is exactly when it is the answer.
  if (view.player.canCharges === 0 && view.reservoirs.length > 0) {
    const pond = view.reservoirs[0]!;
    const digit = digitOf(ToolMode.Water);
    return [
      {
        tileX: pond.tileX + pond.tilesWide / 2,
        tileY: pond.tileY,
        title: 'THE POND',
        body:
          digit === ''
            ? 'click the water — the can refills'
            : `press ${digit}, click the water — the can refills`,
      },
    ];
  }

  return NO_SIGNS;
}

function firstSellBin(view: WorldView): { tileX: number; tileY: number; tilesWide: number } | null {
  for (let i = 0; i < view.machines.length; i++) {
    const machine = view.machines[i]!;
    if (machine.kind === MachineKind.SellBin) return machine;
  }
  return null;
}
