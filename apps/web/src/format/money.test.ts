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

import { formatCents, formatCentsWhole, formatRate, groupDigits } from './money';

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
