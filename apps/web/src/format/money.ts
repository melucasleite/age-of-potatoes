// THE ONE PLACE CENTS BECOME A STRING. There is no second one, and that is the entire point
// of this file existing rather than the four functions below living next to their callers.
//
// `packages/sim` deals in cents and never divides by 100 (§12: integer units, "cents for money,
// never dollars"). "$1,234.56" is a presentation decision — thousands separators, rounding
// policy, whether a negative wears a minus or parentheses — and presentation decisions that leak
// into a deterministic core are how a locale change desyncs a replay.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
//  WHY THIS FILE EXISTS AT ALL. Five copies of cents-to-string had accumulated — `hud/format`,
//  `reports/format`, `game/input/build-menu`, `game/input/pointer`, `game/render/hud` — and by
//  the time they were collected they no longer agreed. They disagreed ON SCREEN, in a shipping
//  build, in three separate ways:
//
//    · A BASIC BELT COSTS $1.50 A TILE. The React toolbelt printed "$1" (floor) and the build
//      menu printed "$2/tile" (`Math.round`). Two panels, one belt, two prices, neither of
//      them the price. Only per-tile belts have sub-dollar granularity, which is exactly why
//      nobody noticed: every other price in the game is a whole number of dollars and the two
//      rules agreed by luck everywhere else.
//    · THE FIFTEENTH LAND DEED COSTS $3,276,800. The placement band grouped it; the build menu
//      printed "$3276800", because its copy of the formatter never got thousands separators.
//    · THE MINUS SIGN. Four call sites used U+2212 MINUS; the in-canvas HUD used an ASCII
//      hyphen. Both render — the game's bitmap font ships both glyphs — so the disagreement was
//      invisible to every test and visible to anyone who put the two panels side by side.
//
//  This is the failure mode the tombstone in `derive-tech.ts` was written about: a second copy
//  of one rule keeps compiling after the rule changes, and lies quietly. A copy of a formatter
//  cannot go stale if there is only one.
// ─────────────────────────────────────────────────────────────────────────────────────────
//
// TWO RENDERINGS, NOT TWO IMPLEMENTATIONS. `formatCents` and `formatCentsWhole` are a real
// editorial choice — "$1,234.56" where the pennies are the point, "$1,234" where they are
// noise — sharing one sign convention and one separator rule. Adding a third rendering is a
// design decision and belongs in review, not in a call site.
//
// IMPORT THIS RELATIVELY, NOT AS `@/format/money`. The `@/*` alias is a tsconfig path that
// Next resolves and vitest does not — there is no vitest config in this repo to teach it — so
// an aliased import compiles, builds, runs in the browser, and throws "Cannot find package" the
// moment any test reaches the module transitively. That was survivable while the aliases sat in
// files no test imported; a module every surface depends on does not get to be one of those.
//
// NO SENTINELS IN HERE. The sim uses -1 for "there is no next deed" and the HUD renders absent
// values as an em dash, but nothing below knows that: `formatCents(-1)` is "−$0.01", honestly.
// A formatter that silently turned one particular negative into "—" would be a second rule
// hiding inside a first, and callers that must branch would look like callers that need not.

/** The sign a negative amount wears: U+2212 MINUS SIGN, not a hyphen. */
const MINUS = '−';

/**
 * Thousands separators, without `toLocaleString` and without a locale changing a receipt.
 *
 * Takes a NON-NEGATIVE whole number of dollars — the sign is applied by the caller, because a
 * separator rule that also owned the sign would have to know about `formatRate`'s leading "+".
 */
export function groupDigits(whole: number): string {
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

/** Cents → "$1,234.56". Exact: no float division, no `toFixed` rounding surprises. */
export function formatCents(cents: number): string {
  const value = Math.trunc(cents);
  const abs = Math.abs(value);
  const whole = Math.floor(abs / 100);
  const part = abs % 100;
  return `${value < 0 ? MINUS : ''}$${groupDigits(whole)}.${String(part).padStart(2, '0')}`;
}

/**
 * Cents → "$1,234" — no pennies, for figures where the pennies are visual noise.
 *
 * TRUNCATES TOWARD ZERO rather than rounding, so a price never reads higher than it is. The
 * cost of that choice is that anything under a dollar reads "$0", which is why a fifty-cent
 * potato seed is priced with `formatCents` instead (see `hud/Shop.tsx`) — picking between the
 * two functions is how a call site says whether its pennies matter.
 */
export function formatCentsWhole(cents: number): string {
  const value = Math.trunc(cents);
  return `${value < 0 ? MINUS : ''}$${groupDigits(Math.floor(Math.abs(value) / 100))}`;
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
 * The suffix ladder for the hourly rate, largest first. `T` is a guard rather than a goal:
 * nothing in the balance sheet reaches a trillion dollars an hour, but a formatter that fell
 * off the top of its own ladder would print "$1,500,000.0B", which is worse than wrong — it
 * is wrong AND long.
 */
const RATE_SUFFIXES: readonly {
  readonly floor: number;
  readonly divisor: number;
  readonly suffix: string;
}[] = [
  { floor: 1_000_000_000_000, divisor: 1_000_000_000_000, suffix: 'T' },
  { floor: 1_000_000_000, divisor: 1_000_000_000, suffix: 'B' },
  { floor: 1_000_000, divisor: 1_000_000, suffix: 'M' },
  // K starts at $10,000, not $1,000: "$9,999" reads fine and "$9.9K" hides two digits the
  // player still cares about at that scale. The suffix kicks in when it gets satisfying
  // ([[149]] — the big-number fantasy is the point of the game's late economy).
  { floor: 10_000, divisor: 1_000, suffix: 'K' },
];

/**
 * The Ticker's hourly rate ([[149]]): cents per minute in, "$4,320" / "+$12.4K" / "−$3.1M" out.
 *
 * THE SLICE STAYS IN CENTS PER MINUTE and the ×60 happens here, at format time — the research
 * ETA in `TechTree.tsx` divides by the same per-minute field and must keep doing so. Under
 * $10,000 an hour the rendering is plain grouped whole dollars; at and above it, the largest
 * suffix that fits, with ONE decimal, truncated toward zero like every other rendering in this
 * file — a rate never reads higher than it is. The sign follows `formatRate`'s convention: "+"
 * on a gain, U+2212 on a loss, nothing at zero (the Ticker's idle dash is the caller's branch,
 * exactly as the header's no-sentinels rule demands).
 */
export function formatCompactRatePerHour(centsPerMin: number): string {
  const perHourCents = centsPerMin * 60;
  const sign = perHourCents > 0 ? '+' : perHourCents < 0 ? MINUS : '';
  const dollars = Math.floor(Math.abs(perHourCents) / 100);

  for (const rung of RATE_SUFFIXES) {
    if (dollars < rung.floor) continue;
    const whole = Math.floor(dollars / rung.divisor);
    const tenth = Math.floor(((dollars % rung.divisor) * 10) / rung.divisor);
    return `${sign}$${groupDigits(whole)}.${String(tenth)}${rung.suffix}`;
  }
  return `${sign}$${groupDigits(dollars)}`;
}
