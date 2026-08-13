// Receipt formatting. Percentages, volumes, durations — the units a ledger needs and the
// Ticker does not.
//
// Money formatting is NOT reimplemented here. `hud/format.ts` already owns cents → dollars
// and it is imported below rather than copied, because two money formatters in one app is
// how "$1,234.56" and "$1234.56" end up on the same screen. That file is a leaf module with
// no React in it, so importing it costs nothing and drags nothing along.
//
// Nothing in this file rounds a sim quantity before it is displayed. Rounding is a
// presentation decision and it happens here, at the last possible moment, exactly once.

import { TICKS_PER_SECOND } from '@snack/sim';

export { formatCents, formatCentsWhole, formatEta, countWord, plural } from '@/hud/format';

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
  const negative = centsPerHour < 0;
  const dollars = Math.floor(Math.abs(centsPerHour) / 100);
  return `${negative ? '−' : ''}$${group(dollars)}/hr`;
}

/** Thousands separators, without `toLocaleString` and without a locale changing a receipt. */
function group(whole: number): string {
  const digits = String(whole);
  if (digits.length <= 3) return digits;
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    const fromEnd = digits.length - i;
    out += digits[i];
    if (fromEnd > 1 && fromEnd % 3 === 1) out += ',';
  }
  return out;
}
