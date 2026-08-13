// THE ONE $/HOUR FUNCTION. There is not a second one anywhere.
//
// Work item 033's constraint reads "every $/hour figure in the game comes from one
// function", and it is a real constraint rather than tidiness: the Shift Report's rolling
// best, the Peak Flow board, and the personal-best board all quote a rate, and a player who
// sees three different numbers for the same hour stops believing any of them. The receipts
// only teach the sloppiness tax (plan §4) if they agree with each other.
//
// HOW THIS RELATES TO `hud/rate.ts`. That file answers a different question and is not a
// competing definition: it reports NET-WORTH gain per active minute, which is what the
// Ticker's countdown needs, because cash falls when you buy a machine and a Ticker reading
// "−$4,000/min" the instant you invest is worse than useless. This file converts a gain
// over a span of ticks into cents per ACTIVE HOUR, and the callers decide which gain they
// are talking about. Same arithmetic, one implementation, stated units.
//
// Integer in, integer out. `packages/sim` never divides by 100 and neither does this — the
// result is cents per hour and formatting it is `format.ts`'s job.

import { TICKS_PER_ACTIVE_HOUR } from '@snack/sim';

/**
 * Cents per active hour, from a gain and the ticks it took.
 *
 * Returns 0 for a non-positive span rather than dividing by zero: the first publish of a
 * fresh world has no span at all, and an `Infinity` reaching a DOM node renders as the word
 * "Infinity" in the middle of a receipt.
 */
export function centsPerActiveHour(gainCents: number, ticks: number): number {
  if (ticks <= 0) return 0;
  return Math.round((gainCents * TICKS_PER_ACTIVE_HOUR) / ticks);
}

/**
 * The span below which a rate is noise rather than a reading.
 *
 * Six active minutes. One good harvest divided by twenty seconds extrapolates to a
 * five-figure hourly rate, and a report that opens by claiming the player is earning
 * $40,000/hr has spent its credibility before its first true sentence.
 */
export const MIN_RATE_SPAN_TICKS = Math.floor(TICKS_PER_ACTIVE_HOUR / 10);

/** 1 when a span is wide enough to quote a rate from. The panels show an em dash until then. */
export function rateIsSettled(ticks: number): boolean {
  return ticks >= MIN_RATE_SPAN_TICKS;
}
