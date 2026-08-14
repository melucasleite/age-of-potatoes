// Cheap structural gates for the withering readout and the Welcome Back card.
//
// AGENTS.md keeps verification light on purpose, so this pins only the places where being
// wrong is INVISIBLE — and for these two features that is almost all of them, because both
// are defined by a delay. Neither can be checked by looking at the screen without first
// waiting out the delay, which is exactly the condition under which a bug ships:
//
//   · IF THE SIXTY SECONDS IS NOT ENFORCED, the alert fires the instant one plant droops.
//     That reads as a working feature — there IS an alert, and it IS true — right up until
//     the player learns the corner is noisy and stops reading it, taking every future alert
//     with it. Plan §5 makes the delay the requirement, not the alert.
//   · IF THE ARMING NEVER RESETS, a field the player has just rescued keeps accusing them.
//   · IF THE AT-RISK CENTS ARE WRONG, the alert is a number the player can check against the
//     sale price, and one they catch being wrong makes every other figure in the HUD
//     suspect. `reports/idle.ts` documents this failure at length; this pins the arithmetic
//     against the real prices rather than restating the formula.
//   · IF `deservesWelcome` IS WRONG, the card either never appears (invisible for six hours)
//     or greets somebody who never left. Both are silent.
//   · IF `formatTimeAway` ROUNDS UP, the card overstates an absence — small, but it is the
//     first sentence a returning player reads and it is checkable against their own memory.
//
// Nothing here fakes IndexedDB. The parts that genuinely need a browser — a real presence
// clock across a real page teardown, and the card actually on screen — were not exercised;
// see the agent logs on work items 021 and 040 for what was and was not checked for real.

import { describe, expect, it } from 'vitest';
import { WILT_GRACE_TICKS, WILT_WINDOW_TICKS } from '@snack/sim';
import type { WorldView } from '@snack/sim';

import { BLEED_THRESHOLD_TICKS, RiskWatch, createLotFields, deriveLot } from './derive-lot';
// Relative rather than the `@/` alias: that path is a tsconfig/Next resolution and vitest
// runs with no config at all here, exactly as `storage/hardening.test.ts` does.
import { deservesWelcome, formatTimeAway } from '../storage/session';

// The real balance numbers, spelled out so a change to them fails here loudly rather than
// silently re-pricing the alert: a russet lists at $2.00 and Day-Olds at $1.00, compost at
// $0.20, one compost per collapsed crop.
const WILTING_RISK_CENTS = 100; // 200 list − 100 Day-Old
const WILTED_RISK_CENTS = 80; // 100 Day-Old − 20 compost

const RUSSET = 1;
const FRESH = 0;
const WILTING = 1;
const WILTED = 2;

/**
 * Each stage's default crop-clock reading: freshly matured, JUST drooped (a full five-minute
 * window from turning — deliberately outside the deadline phrasing), and just turned. Tests
 * that care about the deadline pass explicit ages instead.
 */
function defaultAgeFor(stage: number): number {
  if (stage === WILTING) return WILT_GRACE_TICKS;
  if (stage === WILTED) return WILT_GRACE_TICKS + WILT_WINDOW_TICKS;
  return 0;
}

/** A field of `stages.length` planted russets, one tile each, no zones unless given. */
function viewWith(
  stages: number[],
  options: {
    tick?: number;
    zone?: number[];
    zones?: WorldView['zones'];
    readyAge?: number[];
  } = {},
): WorldView {
  return {
    tick: options.tick ?? 0,
    field: {
      crop: stages.map(() => RUSSET),
      wilt: stages,
      readyAge: options.readyAge ?? stages.map(defaultAgeFor),
      fertility: stages.map(() => 1),
      compost: stages.map(() => 0),
      zone: options.zone ?? stages.map(() => 0),
    },
    zones: options.zones ?? [],
    machines: [],
  } as unknown as WorldView;
}

describe('at-risk pricing', () => {
  it('prices a drooping crop at the discount it is about to eat', () => {
    const lot = deriveLot(viewWith([WILTING]), new RiskWatch(), createLotFields());
    expect(lot.wilting).toBe(1);
    expect(lot.wilted).toBe(0);
    expect(lot.atRiskCents).toBe(WILTING_RISK_CENTS);
  });

  it('prices a turned crop at Day-Old minus what the compost is worth', () => {
    const lot = deriveLot(viewWith([WILTED]), new RiskWatch(), createLotFields());
    expect(lot.wilted).toBe(1);
    expect(lot.atRiskCents).toBe(WILTED_RISK_CENTS);
  });

  it('charges nothing for a fresh field', () => {
    const lot = deriveLot(viewWith([FRESH, FRESH, FRESH]), new RiskWatch(), createLotFields());
    expect(lot.atRiskCents).toBe(0);
    expect(lot.alert).toBeNull();
  });

  it('never counts a crop as destroyed — the figure is the difference, not the value', () => {
    // The whole-crop value is 200; the risk must be strictly less, because plan §4 says
    // nothing ever vanishes and the player always gets *something* for it.
    const lot = deriveLot(viewWith([WILTING]), new RiskWatch(), createLotFields());
    expect(lot.atRiskCents).toBeLessThan(200);
  });
});

describe('the sixty-second delay', () => {
  it('says nothing for the first minute of bleeding', () => {
    const watch = new RiskWatch();
    const fields = createLotFields();

    expect(deriveLot(viewWith([WILTING], { tick: 0 }), watch, fields).alert).toBeNull();
    expect(deriveLot(viewWith([WILTING], { tick: 600 }), watch, fields).alert).toBeNull();
    // One tick short. The boundary is the requirement, so it is asserted at the boundary.
    expect(
      deriveLot(viewWith([WILTING], { tick: BLEED_THRESHOLD_TICKS - 1 }), watch, fields).alert,
    ).toBeNull();
  });

  it('speaks once the minute is up, in cash', () => {
    const watch = new RiskWatch();
    const fields = createLotFields();

    deriveLot(viewWith([WILTING], { tick: 0 }), watch, fields);
    const lot = deriveLot(viewWith([WILTING], { tick: BLEED_THRESHOLD_TICKS }), watch, fields);

    expect(lot.alert).not.toBeNull();
    expect(lot.alert!.costCents).toBe(WILTING_RISK_CENTS);
    // Cash-phrased per plan §5 — the money is in the sentence, not just in the payload.
    expect(lot.alert!.text).toContain('at risk');
    expect(lot.alert!.text).toContain('$1');
  });

  it('forgets the run the moment the field is rescued', () => {
    const watch = new RiskWatch();
    const fields = createLotFields();

    deriveLot(viewWith([WILTING], { tick: 0 }), watch, fields);
    // Harvested. Nothing at risk, so the clock is not merely paused, it is discarded.
    deriveLot(viewWith([FRESH], { tick: 900 }), watch, fields);
    // A new crop droops. It must serve its own minute, not inherit the last one's.
    const lot = deriveLot(viewWith([WILTING], { tick: 1_000 }), watch, fields);
    expect(lot.alert).toBeNull();
  });

  it('does not inherit a bleed across a world reload', () => {
    const watch = new RiskWatch();
    const fields = createLotFields();

    deriveLot(viewWith([WILTING], { tick: 50_000 }), watch, fields);
    // Time ran backwards: a save was loaded. The old run described a different field.
    const lot = deriveLot(viewWith([WILTING], { tick: 10 }), watch, fields);
    expect(lot.alert).toBeNull();
  });
});

describe("the deadline tense ([[021]]'s copy)", () => {
  /** A drooping crop one minute from turning — exactly on the deadline fence. */
  const NEARLY_TURNED = WILT_GRACE_TICKS + WILT_WINDOW_TICKS - BLEED_THRESHOLD_TICKS;

  it('keeps the bleed phrasing while the turn is still minutes away', () => {
    const watch = new RiskWatch();
    const fields = createLotFields();
    deriveLot(viewWith([WILTING], { tick: 0 }), watch, fields);
    const lot = deriveLot(viewWith([WILTING], { tick: BLEED_THRESHOLD_TICKS }), watch, fields);

    expect(lot.imminentCents).toBe(0);
    expect(lot.alert!.text).toContain('at risk');
    expect(lot.alert!.text).not.toContain('about a minute');
  });

  it('switches to "$N of crops wilt in about a minute" inside the last minute', () => {
    const watch = new RiskWatch();
    const fields = createLotFields();
    const args = { readyAge: [NEARLY_TURNED] };
    deriveLot(viewWith([WILTING], { ...args, tick: 0 }), watch, fields);
    const lot = deriveLot(
      viewWith([WILTING], { ...args, tick: BLEED_THRESHOLD_TICKS }),
      watch,
      fields,
    );

    expect(lot.imminentCents).toBe(WILTING_RISK_CENTS);
    expect(lot.alert).not.toBeNull();
    expect(lot.alert!.text).toBe('$1 of crops wilt in about a minute');
    expect(lot.alert!.costCents).toBe(WILTING_RISK_CENTS);
  });

  it('cannot fire before the sixty-second arming — the deadline only rephrases', () => {
    const watch = new RiskWatch();
    const fields = createLotFields();
    // The crop is a minute from turning, but the bleed has only just been noticed.
    const lot = deriveLot(
      viewWith([WILTING], { readyAge: [NEARLY_TURNED], tick: 0 }),
      watch,
      fields,
    );
    expect(lot.imminentCents).toBe(WILTING_RISK_CENTS);
    expect(lot.alert).toBeNull();
  });

  it('prices the deadline at the imminent slice only, not the whole field', () => {
    const watch = new RiskWatch();
    const fields = createLotFields();
    // Two droopers: one a minute from turning, one with the full window ahead of it.
    const args = { readyAge: [NEARLY_TURNED, WILT_GRACE_TICKS] };
    deriveLot(viewWith([WILTING, WILTING], { ...args, tick: 0 }), watch, fields);
    const lot = deriveLot(
      viewWith([WILTING, WILTING], { ...args, tick: BLEED_THRESHOLD_TICKS }),
      watch,
      fields,
    );

    expect(lot.atRiskCents).toBe(WILTING_RISK_CENTS * 2);
    expect(lot.imminentCents).toBe(WILTING_RISK_CENTS);
    expect(lot.alert!.costCents).toBe(WILTING_RISK_CENTS);
  });

  it('a crop one tick outside the minute does not count as imminent', () => {
    const lot = deriveLot(
      viewWith([WILTING], { readyAge: [NEARLY_TURNED - 1] }),
      new RiskWatch(),
      createLotFields(),
    );
    expect(lot.imminentCents).toBe(0);
  });

  it('names the worst zone in the deadline tense too', () => {
    const watch = new RiskWatch();
    const fields = createLotFields();
    const zones = [
      {
        id: 1,
        name: 'North Field',
        tiles: 1,
        planted: 1,
        mature: 0,
        wilting: 1,
        wilted: 0,
        dry: 0,
        compost: 0,
      },
    ] as unknown as WorldView['zones'];
    const args = { zone: [1], zones, readyAge: [NEARLY_TURNED] };

    deriveLot(viewWith([WILTING], { ...args, tick: 0 }), watch, fields);
    const lot = deriveLot(
      viewWith([WILTING], { ...args, tick: BLEED_THRESHOLD_TICKS }),
      watch,
      fields,
    );

    expect(lot.alert).not.toBeNull();
    expect(lot.alert!.text).toBe('North Field: $1 of crops wilt in about a minute');
  });
});

describe('the alert names the worst zone', () => {
  it('falls back to the whole lot when nothing is zoned', () => {
    // This is every new player: `createWorld()` starts with no zones at all, so a
    // zone-only readout would be invisible to exactly the people who need it.
    const watch = new RiskWatch();
    const fields = createLotFields();
    deriveLot(viewWith([WILTED, WILTED], { tick: 0 }), watch, fields);
    const lot = deriveLot(
      viewWith([WILTED, WILTED], { tick: BLEED_THRESHOLD_TICKS }),
      watch,
      fields,
    );

    expect(lot.alert).not.toBeNull();
    expect(lot.alert!.id).toBe('wilt-lot');
    expect(lot.alert!.text).toContain('2 crops');
  });

  it('picks the zone with the most money in it, and names it', () => {
    const watch = new RiskWatch();
    const fields = createLotFields();
    // Zone 2 holds two turned crops; zone 1 holds one. Zone 2 should speak.
    const zone = [1, 2, 2];
    const zones = [
      {
        id: 1,
        name: 'North Field',
        tiles: 1,
        planted: 1,
        mature: 0,
        wilting: 0,
        wilted: 1,
        dry: 0,
        compost: 0,
      },
      {
        id: 2,
        name: 'South Field',
        tiles: 2,
        planted: 2,
        mature: 0,
        wilting: 0,
        wilted: 2,
        dry: 0,
        compost: 0,
      },
    ] as unknown as WorldView['zones'];

    const args = { tick: 0, zone, zones };
    deriveLot(viewWith([WILTED, WILTED, WILTED], args), watch, fields);
    const lot = deriveLot(
      viewWith([WILTED, WILTED, WILTED], { ...args, tick: BLEED_THRESHOLD_TICKS }),
      watch,
      fields,
    );

    expect(lot.alert).not.toBeNull();
    expect(lot.alert!.text).toContain('South Field');
    expect(lot.alert!.costCents).toBe(WILTED_RISK_CENTS * 2);
  });
});

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
