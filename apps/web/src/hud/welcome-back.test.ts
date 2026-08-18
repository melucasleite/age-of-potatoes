// Cheap structural gates for the Welcome Back card ([[040]]).
//
// AGENTS.md keeps verification light on purpose, so this pins only the places where being
// wrong is INVISIBLE — and for this feature that is almost all of them, because it is defined
// by a delay. It cannot be checked by looking at the screen without first waiting out the
// delay, which is exactly the condition under which a bug ships:
//
//   · IF `deservesWelcome` IS WRONG, the card either never appears (invisible for six hours)
//     or greets somebody who never left. Both are silent.
//   · IF `formatTimeAway` ROUNDS UP, the card overstates an absence — small, but it is the
//     first sentence a returning player reads and it is checkable against their own memory.
//
// ⚠️ THIS FILE WAS `lot.test.ts` AND TWO THIRDS OF IT WERE DELETED BY [[124]]. Sixteen of its
// twenty-four tests pinned the wilt alert: the at-risk pricing (list − Day-Old for a drooping
// crop, Day-Old − compost for a turned one), the sixty-second arming, the arming's reset on
// rescue and on world reload, the two-tense deadline copy, and the worst-zone selection. All
// of it measured a bleed that cannot happen now, so it went with `RiskWatch`. The name went
// too — a file called `lot.test.ts` that tests only the Welcome Back card is the same kind of
// stale label this item exists to stamp out.
//
// `deriveLot`'s surviving half — zone rows, the crop picker's gate, the machine census — is
// covered by `zone-panel.test.ts`, which drives it off real world state rather than a stub.
//
// Nothing here fakes IndexedDB. The parts that genuinely need a browser — a real presence
// clock across a real page teardown, and the card actually on screen — were not exercised;
// see the agent log on work item 040 for what was and was not checked for real.

import { describe, expect, it } from 'vitest';

// Relative rather than the `@/` alias: that path is a tsconfig/Next resolution and vitest
// runs with no config at all here, exactly as `storage/hardening.test.ts` does.
import { deservesWelcome, formatTimeAway } from '../storage/session';

describe('deservesWelcome', () => {
  const HOUR = 3_600_000;
  const played = (at: number) => ({ at, tick: 100_000 });

  it('greets nobody on their first visit', () => {
    expect(deservesWelcome(null, Date.now())).toBe(false);
  });

  it('stays quiet for a lunch break', () => {
    const now = Date.now();
    expect(deservesWelcome(played(now - HOUR), now)).toBe(false);
  });

  it('greets a genuinely long absence', () => {
    const now = Date.now();
    expect(deservesWelcome(played(now - 30 * 24 * HOUR), now)).toBe(true);
  });

  it('does not greet somebody who never built anything', () => {
    // Opened the game a month ago, did nothing, closed it. "Your factory is exactly where
    // you left it" is a hollow sentence when there is no factory.
    const now = Date.now();
    expect(deservesWelcome({ at: now - 30 * 24 * HOUR, tick: 40 }, now)).toBe(false);
  });

  it('treats a backwards clock as no evidence of an absence', () => {
    const now = Date.now();
    expect(deservesWelcome(played(now + 5 * HOUR), now)).toBe(false);
  });
});

describe('formatTimeAway', () => {
  it('rounds down, so the card never overstates the absence', () => {
    const DAY = 86_400_000;
    expect(formatTimeAway(2.9 * DAY)).toBe('2 days');
    expect(formatTimeAway(23.9 * 3_600_000)).toBe('23 hours');
  });

  it('reads as English rather than as a duration', () => {
    expect(formatTimeAway(3_600_000)).toBe('an hour');
    expect(formatTimeAway(86_400_000)).toBe('a day');
    expect(formatTimeAway(31 * 86_400_000)).toBe('a month');
  });

  it('never says "0 minutes"', () => {
    expect(formatTimeAway(1_000)).toBe('1 minutes');
  });
});
