// The in-game day, without dragging Pixi into the React bundle.
//
// WHY THIS IS NOT AN IMPORT FROM `game/render/pixel.ts`. That module owns `TICKS_PER_DAY`
// and `dayPhase()` and is the right home for them — but its first statement is
// `import { TextureStyle } from 'pixi.js'`, because it exists to set the global scale mode
// before any texture is constructed. The reports render OUTSIDE the `ssr: false` boundary
// (see `app/play/play-client.tsx`), so importing it here would pull the whole of Pixi into
// the server render and into the main chunk to obtain one integer.
//
// So the constants are restated, and the drift that restating invites is converted into a
// test failure instead: `day.test.ts` imports BOTH modules and asserts they agree, tick by
// tick, across two whole days. If somebody retunes the day length in one place, the suite
// goes red rather than the Dawn Report quietly firing at 3pm.
//
// Everything here takes a tick and returns an integer. No wall clock, no `Date`, no
// `setTimeout` — dawn is a tick condition, exactly as it is in the sim (plan §2).

import { TICKS_PER_SECOND } from '@snack/sim';

/** Plan §2: the in-game day is eight real minutes. Purely cosmetic — no night mechanics. */
export const DAY_REAL_MINUTES = 8;

/** Ticks in one in-game day. Must equal `game/render/pixel.ts`'s `TICKS_PER_DAY`. */
export const TICKS_PER_DAY = DAY_REAL_MINUTES * 60 * TICKS_PER_SECOND;

/**
 * Where tick 0 sits in the day, as a fraction of it. A new world opens at 09:00 in full
 * daylight rather than at midnight. Restated from `pixel.ts`'s private `DAY_START_PHASE`.
 */
const START_HOUR = 9;
const HOURS_PER_DAY = 24;

/** Dawn is 06:00. Kept as an hour so the arithmetic below stays readable. */
const DAWN_HOUR = 6;

/**
 * Ticks from the start of a clock-day to that day's dawn.
 *
 * A clock-day begins at 09:00 and dawn is the 06:00 fifteen hours later, so dawn sits
 * exactly seven eighths of the way through — 8400 of 9600 ticks. Integer by construction:
 * 9600 × 21 / 24 divides exactly, and a comment saying "trust me, it divides" is worth less
 * than the assertion in `day.test.ts` that it does.
 */
export const DAWN_TICK_IN_DAY =
  (TICKS_PER_DAY * (HOURS_PER_DAY - START_HOUR + DAWN_HOUR)) / HOURS_PER_DAY;

/**
 * The day phase in [0, 1): 0 is midnight, 0.5 is midday.
 *
 * The one float in the reports layer, and it is safe to be one: it is renderer-side
 * presentation that nothing hashes, persists, or feeds back into the sim. It exists only so
 * `day.test.ts` can compare against `pixel.ts` on equal terms.
 */
export function dayPhase(tick: number): number {
  return ((((tick % TICKS_PER_DAY) / TICKS_PER_DAY + START_HOUR / HOURS_PER_DAY) % 1) + 1) % 1;
}

/**
 * The day number the on-screen clock is showing at `tick` — `render/hud.ts`'s `clock()`
 * formula, restated so the Dawn Report's heading can never contradict the clock beside it.
 */
export function dayNumber(tick: number): number {
  return Math.floor(tick / TICKS_PER_DAY) + 1;
}

/**
 * How many dawns this world has seen by `tick`. 0 before the first one.
 *
 * The Dawn Report fires on the CHANGE of this number rather than on an equality test
 * against a dawn tick, because the HUD hears about the world every third tick and would
 * miss the exact tick two times out of three. A monotone counter cannot be missed — at
 * worst the card is 150 ms late, which nobody can perceive and no test needs to tolerate.
 */
export function dawnCount(tick: number): number {
  return Math.floor((tick - DAWN_TICK_IN_DAY) / TICKS_PER_DAY) + 1;
}

/**
 * Ticks from `tick` until the next dawn. Used for nothing load-bearing — it is the "next
 * report in ~2 min" line on the Shift Report, which is there so the player knows the game
 * intends to tell them something rather than wondering whether it forgot.
 */
export function ticksUntilDawn(tick: number): number {
  const sinceDawn = (((tick - DAWN_TICK_IN_DAY) % TICKS_PER_DAY) + TICKS_PER_DAY) % TICKS_PER_DAY;
  return TICKS_PER_DAY - sinceDawn;
}
