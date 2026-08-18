// The truck run, pinned — because every failure here is a thing you have to WATCH to see.
//
// A truck in the wrong place still looks like a truck. The acceptance criterion for item 132
// is "it arrives home as the run completes, not before or after", and the only way to check
// that by eye is to sit through a forty-five-second round trip and judge a moment. These are
// the same claims, as arithmetic, in under a millisecond.

import { describe, expect, it } from 'vitest';

import { chooseLane, runElapsed, truckAt } from './truck-route';

// The real numbers: a depot's base round trip is 45 seconds at 20Hz, and the truck cruises at
// six tiles a second on a 32px tile — 9.6 world px per tick.
const RUN_TICKS = 900;
const SPEED = 9.6;

describe('runElapsed', () => {
  it('reads 0 at the top of the run and 1 at the bottom', () => {
    expect(runElapsed(RUN_TICKS, RUN_TICKS, 0)).toBe(0);
    expect(runElapsed(0, RUN_TICKS, 0)).toBe(1);
  });

  it('advances smoothly INSIDE a tick, so a fast truck does not step at 60Hz', () => {
    // `ticksRemaining` is an integer that drops 20 times a second. Without the frame's alpha
    // the truck would hold still for three frames and then jump nine pixels.
    const a = runElapsed(450, RUN_TICKS, 0);
    const b = runElapsed(450, RUN_TICKS, 0.5);
    expect(b).toBeGreaterThan(a);
    expect(b - a).toBeCloseTo(0.5 / RUN_TICKS, 10);
  });

  it('clamps rather than overshooting on a frame after the last tick', () => {
    // The projection is read on frames the sim has not stepped. Unclamped, the final frame of
    // a run would drive the truck PAST home.
    expect(runElapsed(0, RUN_TICKS, 0.9)).toBe(1);
    expect(runElapsed(RUN_TICKS, RUN_TICKS, -0.2)).toBe(0);
  });

  it('survives a depot that publishes a zero clock', () => {
    expect(runElapsed(0, 0, 0)).toBe(1);
  });
});

describe('truckAt', () => {
  // A depot ten tiles from the road: 320px of lot to clear at 9.6px a tick is 33 ticks, a
  // small fraction of a 900-tick run — so it drives off, waits, and drives back.
  const TRAVEL = 320;

  it('is parked at the depot at both ends of the run', () => {
    expect(truckAt(0, RUN_TICKS, TRAVEL, SPEED).away).toBe(0);
    // THE ACCEPTANCE CRITERION, as one number: home exactly as the run completes.
    expect(truckAt(1, RUN_TICKS, TRAVEL, SPEED).away).toBe(0);
  });

  it('is fully off the lot for the middle of the run', () => {
    expect(truckAt(0.25, RUN_TICKS, TRAVEL, SPEED).away).toBe(1);
    expect(truckAt(0.5, RUN_TICKS, TRAVEL, SPEED).away).toBe(1);
    expect(truckAt(0.75, RUN_TICKS, TRAVEL, SPEED).away).toBe(1);
  });

  it('leaves and returns at the same speed, and monotonically', () => {
    let last = -1;
    for (let i = 0; i <= 100; i++) {
      const away = truckAt(i / 200, RUN_TICKS, TRAVEL, SPEED).away;
      expect(away).toBeGreaterThanOrEqual(last);
      last = away;
    }
    // Mirrored: a quarter of the way out is a quarter of the way home.
    for (let i = 0; i <= 20; i++) {
      const t = i / 100;
      expect(truckAt(t, RUN_TICKS, TRAVEL, SPEED).away).toBeCloseTo(
        truckAt(1 - t, RUN_TICKS, TRAVEL, SPEED).away,
        10,
      );
    }
  });

  it('NEVER flips its facing while it is on screen, at any depot this lot can hold', () => {
    // The sprite mirrors when `heading` changes, and a lorry that spun round in the middle of
    // a field would be the most visible bug this feature could ship. The flip is at elapsed
    // 0.5, and the truck is fully off the lot well before then — so the turn happens where
    // nobody can see it.
    //
    // "At any depot this lot can hold" is the load-bearing half. The world is 64 tiles wide,
    // so the longest possible drive is 2,048px; a 900-tick run at 9.6px a tick covers 8,640,
    // and half of that is 4,320. The leg is never anywhere near its cap on a real lot, which
    // is WHY `away` is pinned at exactly 1 across the flip rather than merely close to it.
    const LONGEST_DRIVE_PX = 64 * 32;
    for (const travel of [64, 320, 1024, LONGEST_DRIVE_PX]) {
      for (const t of [0.499, 0.4999, 0.5, 0.5001, 0.501]) {
        expect(truckAt(t, RUN_TICKS, travel, SPEED).away).toBe(1);
      }
    }
  });

  it('heads out for the first half and home for the second', () => {
    expect(truckAt(0.1, RUN_TICKS, TRAVEL, SPEED).heading).toBe(1);
    expect(truckAt(0.9, RUN_TICKS, TRAVEL, SPEED).heading).toBe(-1);
  });

  it('degrades to a plain linear out-and-back for a depot it cannot outrun', () => {
    // Far enough west that clearing the lot takes longer than half the run: the leg caps at
    // the half and the two readings meet instead of fighting. 900 ticks × 9.6 is 8,640px of
    // travel in a whole run, so 20,000px cannot be cleared in half of one.
    const far = 20_000;
    expect(truckAt(0.25, RUN_TICKS, far, SPEED).away).toBeCloseTo(0.5, 6);
    expect(truckAt(0.5, RUN_TICKS, far, SPEED).away).toBeCloseTo(1, 6);
    expect(truckAt(1, RUN_TICKS, far, SPEED).away).toBe(0);
  });

  it('parks rather than dividing by zero when the depot publishes nothing', () => {
    // A shed deconstructed mid-run publishes zeroes. Every degenerate input has to leave the
    // truck AT THE DEPOT — "sat in the yard" is a failure a player can read, and "teleported
    // off the west edge and never came back" is not.
    expect(truckAt(runElapsed(0, 0, 0), 0, 0, SPEED).away).toBe(0);
    expect(truckAt(0.25, 0, 320, SPEED).away).toBe(0);
    expect(truckAt(0.75, 0, 320, SPEED).away).toBe(0);
    expect(truckAt(0.25, RUN_TICKS, 320, 0).away).toBe(0);
    expect(truckAt(0.25, RUN_TICKS, 0, SPEED).away).toBe(0);
  });
});

describe('chooseLane', () => {
  const NONE: ReadonlySet<number> = new Set();
  /** A depot at row 10, two tiles high — the shape `machine_truck_depot` actually is. */
  const TILE_Y = 10;
  const HIGH = 2;

  it('takes the depot’s own top row when the yard is clear', () => {
    expect(chooseLane(TILE_Y, HIGH, () => 0, NONE)).toBe(TILE_Y);
  });

  it('takes the other footprint row rather than leaving the yard', () => {
    const blocked = (row: number) => (row === TILE_Y ? 3 : 0);
    expect(chooseLane(TILE_Y, HIGH, blocked, NONE)).toBe(TILE_Y + 1);
  });

  it('steps outside the footprint when both of its rows are walled in', () => {
    const blocked = (row: number) => (row >= TILE_Y && row < TILE_Y + HIGH ? 2 : 0);
    // The row above is offered before the row below, so it wins the tie at zero blockers.
    expect(chooseLane(TILE_Y, HIGH, blocked, NONE)).toBe(TILE_Y - 1);
  });

  it('finds the one clear row below when everything else is blocked', () => {
    const blocked = (row: number) => (row === TILE_Y + HIGH ? 0 : 5);
    expect(chooseLane(TILE_Y, HIGH, blocked, NONE)).toBe(TILE_Y + HIGH);
  });

  it('drives the least-blocked row rather than refusing to leave', () => {
    // No pathfinder, and no depot that cannot dispatch. A walled-in yard still sends its
    // truck out — through the thinnest wall.
    const blocked = (row: number) => (row === TILE_Y + 1 ? 1 : 9);
    expect(chooseLane(TILE_Y, HIGH, blocked, NONE)).toBe(TILE_Y + 1);
  });

  it('avoids a lane another truck is already using — but only as the last tiebreak', () => {
    const taken = new Set([TILE_Y]);
    // Both footprint rows clear: the second truck takes the free one.
    expect(chooseLane(TILE_Y, HIGH, () => 0, taken)).toBe(TILE_Y + 1);
    // The free row is blocked: two lorries sharing a row beats one driving through a machine.
    const blocked = (row: number) => (row === TILE_Y ? 0 : 4);
    expect(chooseLane(TILE_Y, HIGH, blocked, taken)).toBe(TILE_Y);
  });

  it('handles a one-tile depot without asking for row -1 of a two-row footprint', () => {
    expect(chooseLane(TILE_Y, 1, () => 0, NONE)).toBe(TILE_Y);
    expect(chooseLane(TILE_Y, 0, () => 0, NONE)).toBe(TILE_Y);
  });
});
