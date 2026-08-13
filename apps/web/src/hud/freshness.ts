// When a stack is worth worrying about, and how long it has left in words.
//
// THE SIM OWNS THE CLOCK; THIS FILE OWNS ONLY WHEN A COLOUR CHANGES. `view()` publishes
// `inventory[].ticksToSpoil` — an already-subtracted countdown to the moment the soonest heap in
// a slot turns to Compost — and `spoilingCount`, how many units are in that heap. Both are the
// world's arithmetic. Nothing below recomputes either, and nothing below knows what tick it is.
//
// WHICH MAKES EVERY NUMBER IN THIS FILE A **DISPLAY THRESHOLD**, and they are named as one
// because the distinction is the whole reason the file exists. `FRESHNESS_TICKS_BY_ITEM`,
// `CRATE_FRESHNESS_TICKS` and `FRESHNESS_BUCKET_TICKS` live in `data.ts` and decide when food
// actually spoils. `TURNING_TICKS` and `GOING_TICKS` decide when a corner of a cell goes amber.
// Move one of the sim's and the game changes; move one of these and a colour arrives earlier.
// The bag prices nothing and computes nothing the sim already knows (see `Inventory.tsx`'s
// header) — freshness follows the same rule, and this is the seam where it is kept.
//
// WHY THERE IS NO PROGRESS BAR, which is the first thing anybody reaches for. A bar needs a
// fraction, a fraction needs the window this stack started with, and the view does not publish
// one — deliberately, because there isn't a single answer: the same potato keeps 18,000 ticks
// loose and 54,000 crated, and the Root Cellar stops the clock outright. A bar drawn against a
// guessed maximum would read past full for anything crated and would have to be clamped, i.e.
// would lie in exactly the situation the player spent money to reach. So freshness is shown as
// TIME LEFT and as a band, both of which are true no matter what the stack has been through.

import { TICKS_PER_SECOND } from '@snack/sim';

/**
 * How urgent a stack is, at a glance.
 *
 *   `never`   — nothing in it spoils. Seeds, Compost, and everything past the Fryer.
 *   `keeps`   — perishable, and not yet worth drawing attention to.
 *   `turning` — close enough that the player should be deciding what to do with it.
 *   `going`   — close enough that the decision has to be made now.
 */
export type FreshnessBand = 'never' | 'keeps' | 'turning' | 'going';

/**
 * Amber at three active minutes.
 *
 * Half the life of the shortest window in the game: §4 calls fresh slices "urgent" at ~6 active
 * minutes (7,200 ticks), so a slice stack spends half its existence saying so — which is the
 * intended lesson, *get the slices to the oil*, arriving as a colour rather than as a tutorial.
 * The same threshold leaves a loose potato (18,000) quiet for five sixths of its life, which is
 * the other half of the same argument: the panel should be calm about produce and impatient
 * about intermediates, and one number does both because the sim already made them different.
 */
export const TURNING_TICKS = 3 * 60 * TICKS_PER_SECOND;

/**
 * Red at one active minute.
 *
 * Chosen as *how long it takes to do something about it* rather than as a fraction of anything:
 * a minute is a walk to a machine, a Root Cellar, or a crate out of the bag. Under it there is
 * still one move available (a Crate is a consumable used from where you stand and buys 45
 * minutes flat) — which is the difference between a warning and an obituary.
 */
export const GOING_TICKS = 60 * TICKS_PER_SECOND;

/**
 * Which band a published countdown falls in.
 *
 * **-1 IS "NEVER", NOT "A LONG TIME"**, and the sentinel is load-bearing: the projection uses it
 * precisely so shelf-stable goods can never be confused with goods that have ages to go (see
 * `InventoryView.ticksToSpoil`). Reading it as a very large number would put a bag of chips one
 * comparison away from being called fresh, which is the wrong claim about the reward for
 * building the line.
 */
export function freshnessBand(ticksToSpoil: number): FreshnessBand {
  if (!Number.isFinite(ticksToSpoil) || ticksToSpoil < 0) return 'never';
  if (ticksToSpoil <= GOING_TICKS) return 'going';
  if (ticksToSpoil <= TURNING_TICKS) return 'turning';
  return 'keeps';
}

/** 1 when this band deserves a mark on a cell or a chip; 0 when the surface stays quiet. */
export function isWarning(band: FreshnessBand): boolean {
  return band === 'turning' || band === 'going';
}

/**
 * Ticks → "4:12". Precise, and deliberately unlike `formatEta`.
 *
 * The Ticker's ETA is vague on purpose — "~4 min" — because it is a projection off a rolling
 * average and decimals on a guess are a lie with decimals on it. This is the opposite kind of
 * number: an exact integer of ticks the world is counting down, describing something the player
 * is holding. Rounding it to "~4 min" would blur the one case that matters, where forty seconds
 * and ninety seconds are different decisions.
 *
 * Floored to whole seconds, so the figure never rounds UP into time the stack does not have.
 */
export function formatFreshness(ticksToSpoil: number): string {
  const seconds = Math.max(0, Math.floor(ticksToSpoil / TICKS_PER_SECOND));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${rest < 10 ? '0' : ''}${rest}`;
}

/**
 * The detail pane's one sentence about the clock.
 *
 * **IT SAYS "COMPOST" RATHER THAN "SPOILS", AND THAT IS THE TEACHING.** §4's anti-softlock
 * posture is that nothing in this game ever ends at zero, and a stack that quietly said "spoils"
 * would leave the player believing they are about to lose everything — so the sentence names
 * what they are about to be holding instead. That is also why it is worth printing on a shelf-
 * stable row: "keeps indefinitely" on a bag of chips is §4's *processing is preservation*, stated
 * once, in the place the player looks when they wonder why the line was worth building.
 *
 * `spoilingCount` is the soonest heap, not the slot. A bag holding twelve potatoes picked across
 * three minutes has three heaps with three deadlines, and saying "12 turn in 0:40" would be wrong
 * about nine of them — so the count is printed whenever it is less than the whole stack.
 */
export function freshnessNote(ticksToSpoil: number, spoilingCount: number, count: number): string {
  if (freshnessBand(ticksToSpoil) === 'never') return 'Keeps indefinitely.';

  const clock = formatFreshness(ticksToSpoil);
  if (spoilingCount > 0 && spoilingCount < count) {
    return `${spoilingCount} of ${count} turn to compost in ${clock}.`;
  }
  return `Turns to compost in ${clock}.`;
}
