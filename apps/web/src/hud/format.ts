// Cents → dollars, ticks → English. All of it lives here and none of it lives in the sim.
//
// MONEY IS NO LONGER IMPLEMENTED HERE. It lives in `format/money.ts`, which the renderer can
// import as easily as React can — that was the whole reason four other copies of it existed.
// The re-export below is deliberate rather than lazy: fifteen HUD components import
// `formatCents` from this module, and pointing them all at a new path would have made a
// two-line consolidation look like a fifteen-file change. Import either path; they are the
// same function.

export {
  formatCents,
  formatCentsWhole,
  formatCompactRatePerHour,
  formatRate,
} from '../format/money';

/**
 * Seconds → "~4 min". Deliberately vague: an ETA precise to the second invites the player
 * to watch it rather than the lot, and it is a projection from a rolling average anyway —
 * false precision would be a lie with decimals on it.
 */
export function formatEta(seconds: number): string {
  if (seconds < 0) return '—';
  if (seconds < 10) return 'any second now';
  if (seconds < 90) return `~${Math.round(seconds / 5) * 5} sec`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `~${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `~${hours} hr` : `~${hours} hr ${rest} min`;
}

/** English numbers up to twelve, because "3 tiles are dry" reads like a spreadsheet. */
const WORDS = [
  'no',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
];

export function countWord(n: number): string {
  return WORDS[n] ?? String(n);
}

export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}
