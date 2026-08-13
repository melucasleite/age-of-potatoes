// The two display thresholds, and the sentinel that must never be read as a number.
//
// This is the file that catches the freshness bugs that are INVISIBLE. A wedge in the wrong
// colour is caught by looking at the screen; the three below are not:
//
//   · IF `-1` WERE TREATED AS A COUNTDOWN, a bag of chips would be the most urgent thing the
//     player owns — smaller than every real countdown, so it would sort to the top of the
//     Clipboard's one spoilage note and paint every shelf-stable cell red. The sentinel exists in
//     the projection precisely so "never" and "a long time" cannot be confused (`view.ts`), and
//     this side has to honour it in three separate comparisons.
//   · IF THE CLOCK ROUNDED UP, a stack with 39.5 seconds left would print "0:40" — time the world
//     does not have, in the one band where the player is deciding whether they can make it.
//   · IF THE BANDS WERE ORDERED WRONG, the last minute of a stack's life would show amber instead
//     of red, which is the exact minute the whole feature exists for.
//
// The thresholds themselves are asserted against the sim's own tick rate rather than typed as
// literals: they are "one active minute" and "three active minutes", and if `TICKS_PER_SECOND`
// ever moves they must move with it rather than silently becoming three real minutes.

import { describe, expect, it } from 'vitest';
import { FRESHNESS_TICKS_BY_ITEM, ItemId, TICKS_PER_SECOND } from '@snack/sim';

import {
  GOING_TICKS,
  TURNING_TICKS,
  formatFreshness,
  freshnessBand,
  freshnessNote,
  isWarning,
} from './freshness';

describe('the display thresholds', () => {
  it("are stated in active minutes, off the sim's own tick rate", () => {
    expect(GOING_TICKS).toBe(60 * TICKS_PER_SECOND);
    expect(TURNING_TICKS).toBe(3 * 60 * TICKS_PER_SECOND);
  });

  // The claim `freshness.ts` makes about why three minutes is the right amber: it is half the
  // life of the shortest window in the game, so §4's "urgent" intermediates say so for half of
  // their existence. If a future rebalance shortened a slice below six minutes this would fail,
  // which is the point — the threshold would then be lying about which items it is calm about.
  it('leave a fresh slice amber for half its life and a loose potato quiet for most of its', () => {
    const window = (item: ItemId): number =>
      FRESHNESS_TICKS_BY_ITEM.find((row) => row.item === item)?.ticks ?? 0;

    expect(TURNING_TICKS * 2).toBe(window(ItemId.PotatoSlices));
    expect(TURNING_TICKS * 2).toBeLessThan(window(ItemId.RussetPotato));
  });
});

describe('which band a countdown falls in', () => {
  it('calls the sentinel "never" rather than "urgent"', () => {
    expect(freshnessBand(-1)).toBe('never');
    expect(isWarning(freshnessBand(-1))).toBe(false);
  });

  it('is red for the last minute and amber for the two before it', () => {
    expect(freshnessBand(0)).toBe('going');
    expect(freshnessBand(GOING_TICKS)).toBe('going');
    expect(freshnessBand(GOING_TICKS + 1)).toBe('turning');
    expect(freshnessBand(TURNING_TICKS)).toBe('turning');
    expect(freshnessBand(TURNING_TICKS + 1)).toBe('keeps');
  });

  it('draws nothing on a stack that is merely perishable', () => {
    // A potato pulled this second: 18,000 ticks, and the grid must stay calm about it.
    expect(freshnessBand(18_000)).toBe('keeps');
    expect(isWarning(freshnessBand(18_000))).toBe(false);
    expect(isWarning(freshnessBand(GOING_TICKS))).toBe(true);
    expect(isWarning(freshnessBand(TURNING_TICKS))).toBe(true);
  });
});

describe('the clock', () => {
  it('floors to whole seconds, so it never promises time the world has not got', () => {
    expect(formatFreshness(TICKS_PER_SECOND * 40 + 19)).toBe('0:40');
    expect(formatFreshness(TICKS_PER_SECOND * 41 - 1)).toBe('0:40');
  });

  it('pads the seconds, because a clock that jumps from 4:5 to 4:15 is not a clock', () => {
    expect(formatFreshness(TICKS_PER_SECOND * 245)).toBe('4:05');
    expect(formatFreshness(TICKS_PER_SECOND * 255)).toBe('4:15');
  });

  it('reads a crate as forty-five active minutes', () => {
    expect(formatFreshness(54_000)).toBe('45:00');
  });

  it('never goes negative, whatever the projection hands it', () => {
    expect(formatFreshness(0)).toBe('0:00');
    expect(formatFreshness(-5)).toBe('0:00');
  });
});

describe('the sentence in the detail pane', () => {
  it('says compost, not loss — nothing in this game ends at zero', () => {
    expect(freshnessNote(TICKS_PER_SECOND * 40, 6, 6)).toBe('Turns to compost in 0:40.');
  });

  it('names the heap when it is only part of the stack', () => {
    expect(freshnessNote(TICKS_PER_SECOND * 40, 3, 12)).toBe('3 of 12 turn to compost in 0:40.');
  });

  it('states the reward for building the line on anything shelf-stable', () => {
    expect(freshnessNote(-1, 0, 4)).toBe('Keeps indefinitely.');
  });
});
