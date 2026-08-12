// Cents → dollars, ticks → English. All of it lives here and none of it lives in the sim.
//
// `packages/sim` deals in cents and never divides by 100 (§12: integer units, "cents for
// money, never dollars"). "$1,234.56" is a presentation decision — thousands separators,
// rounding policy, whether a negative wears a minus or parentheses — and presentation
// decisions that leak into a deterministic core are how a locale change desyncs a replay.

/** Cents → "$1,234.56". Exact: no float division, no `toFixed` rounding surprises. */
export function formatCents(cents: number): string {
  const value = Math.trunc(cents);
  const negative = value < 0;
  const abs = Math.abs(value);
  const whole = Math.floor(abs / 100);
  const part = abs % 100;
  return `${negative ? '−' : ''}$${group(whole)}.${String(part).padStart(2, '0')}`;
}

/** Cents → "$1,234" — no pennies, for figures where the pennies are visual noise. */
export function formatCentsWhole(cents: number): string {
  const value = Math.trunc(cents);
  const negative = value < 0;
  return `${negative ? '−' : ''}$${group(Math.floor(Math.abs(value) / 100))}`;
}

/**
 * The rate, signed. A rate reads as a direction and wants its sign even when positive —
 * "+$36.20" is a claim about where you are heading; "$36.20" is just a number.
 */
export function formatRate(centsPerMin: number): string {
  if (centsPerMin === 0) return '$0.00';
  const sign = centsPerMin > 0 ? '+' : '';
  return `${sign}${formatCents(centsPerMin)}`;
}

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
