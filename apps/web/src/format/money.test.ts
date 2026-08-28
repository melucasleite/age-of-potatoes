// The money formatter's edge cases, pinned.
//
// These are not tests that the formatter works — a glance at it does that. They are tests that
// the CONVENTIONS survive, because the bug this module was extracted to fix was never a wrong
// function. It was five right-looking functions that disagreed about a minus sign, a comma and
// a rounding direction, in a codebase where almost every price is a whole number of dollars
// and the disagreement therefore only surfaced on one item and one screen.
//
// So: the sign is U+2212 and not a hyphen, separators are ours and not ICU's, and whole-dollar
// rendering truncates rather than rounds. Each of those is a fact some call site used to get
// wrong, and each is now asserted somewhere that fails loudly instead of quietly.

import { describe, expect, it } from 'vitest';

import {
  BELT_SPECS,
  DEED_PRICE_CENTS_BY_PURCHASE,
  MACHINE_SPECS,
  listPriceCents,
  ItemId,
} from '@snack/sim';

import {
  formatCents,
  formatCentsWhole,
  formatCompactRatePerHour,
  formatRate,
  groupDigits,
} from './money';

describe('formatCents', () => {
  it('renders dollars and pennies with separators', () => {
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(5)).toBe('$0.05');
    expect(formatCents(50)).toBe('$0.50');
    expect(formatCents(100)).toBe('$1.00');
    expect(formatCents(123_456)).toBe('$1,234.56');
    expect(formatCents(100_000_000)).toBe('$1,000,000.00');
  });

  it('pads a single-digit remainder rather than printing "$1.5"', () => {
    expect(formatCents(105)).toBe('$1.05');
    expect(formatCents(150)).toBe('$1.50');
  });

  it('puts the comma in at exactly a thousand dollars and not before', () => {
    expect(formatCents(99_999)).toBe('$999.99');
    expect(formatCents(100_000)).toBe('$1,000.00');
  });

  it('signs a negative with U+2212 MINUS, never an ASCII hyphen', () => {
    // The in-canvas HUD used a hyphen and the React HUD used a minus, on the same balance.
    expect(formatCents(-500)).toBe('−$5.00');
    expect(formatCents(-500)).not.toContain('-');
    expect(formatCents(-1)).toBe('−$0.01');
    expect(formatCents(-123_456)).toBe('−$1,234.56');
  });

  it('has no sentinel: a negative is a negative, not an em dash', () => {
    // `deedPriceCents` returns -1 for "there is no next deed" and the HUD renders absent values
    // as "—", but the branch belongs to the caller. A formatter that swallowed one particular
    // negative would make callers that must check look like callers that need not.
    expect(formatCents(-1)).not.toContain('—');
    expect(formatCentsWhole(-1)).not.toContain('—');
  });

  it('does not distinguish negative zero from zero', () => {
    expect(formatCents(-0)).toBe('$0.00');
    expect(formatCentsWhole(-0)).toBe('$0');
  });
});

describe('formatCentsWhole', () => {
  it('drops the pennies and keeps the separators', () => {
    expect(formatCentsWhole(0)).toBe('$0');
    expect(formatCentsWhole(100)).toBe('$1');
    expect(formatCentsWhole(123_456)).toBe('$1,234');
    expect(formatCentsWhole(327_680_000)).toBe('$3,276,800');
  });

  it('TRUNCATES toward zero — a price never reads higher than it is', () => {
    // The build menu used to `Math.round` here, which made a $1.50 belt advertise "$2/tile"
    // while the toolbelt's `formatCentsWhole` called the same belt "$1".
    expect(formatCentsWhole(199)).toBe('$1');
    expect(formatCentsWhole(150)).toBe('$1');
    expect(formatCentsWhole(-199)).toBe('−$1');
  });

  it('reads "$0" under a dollar, which is why sub-dollar prices use formatCents', () => {
    // Not a bug — a documented cost of the rendering, asserted so it stays a decision. A
    // fifty-cent seed is priced with `formatCents` in `hud/Shop.tsx` for exactly this reason.
    expect(formatCentsWhole(50)).toBe('$0');
    expect(formatCents(50)).toBe('$0.50');
  });
});

describe('formatRate', () => {
  it('wears its sign in both directions, and neither at zero', () => {
    expect(formatRate(0)).toBe('$0.00');
    expect(formatRate(3_620)).toBe('+$36.20');
    expect(formatRate(-3_620)).toBe('−$36.20');
  });
});

describe('formatCompactRatePerHour ([[149]])', () => {
  // Inputs are cents per MINUTE — the slice's unit, kept — and the ×60 happens inside. The
  // fixtures pick per-hour dollar targets divisible by 3 so cents-per-minute stays a whole
  // number and no assertion leans on floating-point luck.
  it('multiplies by sixty and renders plain grouped dollars under $10,000/hr', () => {
    expect(formatCompactRatePerHour(100)).toBe('+$60'); // $1.00/min is $60/hr
    expect(formatCompactRatePerHour(7_200)).toBe('+$4,320');
    expect(formatCompactRatePerHour(16_665)).toBe('+$9,999');
  });

  it('switches to K at exactly $10,000/hr, with one decimal', () => {
    expect(formatCompactRatePerHour(16_665)).toBe('+$9,999');
    // 1,000,020 cents/hr → $10,000/hr, the first satisfying number.
    expect(formatCompactRatePerHour(16_667)).toBe('+$10.0K');
  });

  it('TRUNCATES the decimal toward zero — a rate never reads higher than it is', () => {
    // $12,459/hr: 12.459K reads "12.4K", never "12.5K".
    expect(formatCompactRatePerHour(20_765)).toBe('+$12.4K');
  });

  it('takes the largest suffix that fits: K, M, B, and T as the guard rail', () => {
    expect(formatCompactRatePerHour(1_666_665)).toBe('+$999.9K'); // $999,999/hr stays K
    expect(formatCompactRatePerHour(5_250_000)).toBe('+$3.1M'); // $3,150,000/hr
    expect(formatCompactRatePerHour(4_000_000_000)).toBe('+$2.4B'); // $2.4B/hr
    expect(formatCompactRatePerHour(2_500_000_000_000)).toBe('+$1.5T'); // off the top
  });

  it('keeps its sign in both directions: + on gains, U+2212 on losses', () => {
    expect(formatCompactRatePerHour(-7_200)).toBe('−$4,320');
    expect(formatCompactRatePerHour(-20_765)).toBe('−$12.4K');
    expect(formatCompactRatePerHour(-20_765)).not.toContain('-');
  });

  it('renders zero unsigned — the Ticker’s idle dash is the caller’s branch, as ever', () => {
    expect(formatCompactRatePerHour(0)).toBe('$0');
    expect(formatCompactRatePerHour(-0)).toBe('$0');
  });

  it('floors sub-dollar hours to $0 rather than inventing pennies', () => {
    // 1¢/min is 60¢/hr: below a dollar the whole-dollar rendering reads "$0", signed,
    // exactly as `formatCentsWhole` documents for its own sub-dollar case.
    expect(formatCompactRatePerHour(1)).toBe('+$0');
  });
});

describe('groupDigits', () => {
  it('agrees with toLocaleString("en-US"), the rule it replaced in two files', () => {
    // Pinned rather than delegated: `render/hud.ts` and `pointer.ts` grouped through ICU, which
    // agrees with us today and is an implementation detail rather than a promise.
    for (const n of [0, 7, 999, 1_000, 12_345, 999_999, 1_000_000, 3_276_800, 987_654_321]) {
      expect(groupDigits(n)).toBe(n.toLocaleString('en-US'));
    }
  });
});

describe('the prices the game actually has', () => {
  it('renders every deed price identically to the ICU grouping the band used to use', () => {
    for (const cents of DEED_PRICE_CENTS_BY_PURCHASE) {
      expect(formatCentsWhole(cents)).toBe(`$${(cents / 100).toLocaleString('en-US')}`);
    }
  });

  it('confirms the Basic Belt is the only sub-dollar price in the game', () => {
    // The load-bearing fact behind picking `formatCents` for per-tile rows and
    // `formatCentsWhole` for everything else. If a machine ever costs $12.50, this fails and
    // whoever priced it gets to decide which rendering its row deserves.
    const wholeDollar = (cents: number): boolean => cents % 100 === 0;

    for (const spec of MACHINE_SPECS) expect(wholeDollar(spec.priceCents)).toBe(true);
    for (const cents of DEED_PRICE_CENTS_BY_PURCHASE) expect(wholeDollar(cents)).toBe(true);

    const subDollarBelts = BELT_SPECS.filter((spec) => !wholeDollar(spec.priceCentsPerTile));
    expect(subDollarBelts.map((spec) => spec.priceCentsPerTile)).toEqual([150]);
  });

  it('prices a potato seed in pennies rather than in "$0"', () => {
    expect(formatCents(listPriceCents(ItemId.PotatoSeed))).toBe('$0.50');
  });
});
