// Receipt formatting. Percentages, volumes, durations — the units a ledger needs and the
// Ticker does not.
//
// Money formatting is NOT reimplemented here. `format/money.ts` owns cents → dollars and is
// imported below rather than copied, because two money formatters in one app is how
// "$1,234.56" and "$1234.56" end up on the same screen. It is a leaf module with no React in
// it, so importing it costs nothing and drags nothing along.
//
// That header was already true of `formatCents` and quietly false of the separator rule: this
// file used to keep its OWN byte-identical `group()`, which `formatPerHour` reimplemented the
// sign convention around — one edit away from being the thing the paragraph above warns about.
// `formatPerHour` is now the shared whole-dollar rendering with "/hr" on the end, and renders
// exactly what it did before.
//
// Nothing in this file rounds a sim quantity before it is displayed. Rounding is a
// presentation decision and it happens here, at the last possible moment, exactly once.

import { TICKS_PER_SECOND } from '@snack/sim';

import { formatCentsWhole } from '../format/money';

export { formatCents, formatCentsWhole } from '../format/money';
export { formatEta, countWord, plural } from '../hud/format';

/**
 * Permille → "4.2%". Permille in, because the sim's integer world measures fractions in
 * thousandths and converting earlier would mean carrying a float through the store.
 */
export function formatPermille(permille: number): string {
  const whole = Math.floor(Math.abs(permille) / 10);
  const tenth = Math.abs(permille) % 10;
  return `${permille < 0 ? '−' : ''}${whole}.${tenth}%`;
}

/**
 * Millilitres → "12.4 kL", or litres below a kilolitre.
 *
 * Dry County is scored per kilolitre (plan §6), so the Shift Report quotes the same unit
 * the board does. A player comparing the two should not have to move a decimal point.
 */
export function formatWater(ml: number): string {
  if (ml <= 0) return '0 L';
  if (ml < 1_000_000) {
    const litres = Math.floor(ml / 1000);
    return litres < 1 ? `${ml} mL` : `${litres} L`;
  }
  const kilolitres = Math.floor(ml / 1_000_000);
  const tenth = Math.floor((ml % 1_000_000) / 100_000);
  return `${kilolitres}.${tenth} kL`;
}

/**
 * Ticks → "6 min", "1 hr 20 min", "45 sec". Active time, never wall-clock time — the two
 * are the same substance in this game (plan §6: no offline progress, ever) but the label
 * matters when a player has had the tab open and unfocused.
 */
export function formatTicks(ticks: number): string {
  const seconds = Math.floor(ticks / TICKS_PER_SECOND);
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

/** Hundredths of an active hour → "6.25 h". The leaderboard clock, as the boards quote it. */
export function formatCentiHours(centiHours: number): string {
  const whole = Math.floor(centiHours / 100);
  const part = centiHours % 100;
  return `${whole}.${String(part).padStart(2, '0')} h`;
}

/**
 * Cents per hour → "$372/hr". Whole dollars deliberately: the pennies on an hourly rate are
 * noise, and a rate that changes in its last digit every publish invites the player to watch
 * the number instead of the lot.
 */
export function formatPerHour(centsPerHour: number): string {
  return `${formatCentsWhole(centsPerHour)}/hr`;
}
