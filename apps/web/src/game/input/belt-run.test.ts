// What a bent belt run actually does, asked of the sim rather than of a comment.
//
// ────────────────────────────────────────────────────────────────────────────────────
//  THIS FILE EXISTS TO ANSWER ONE QUESTION AND IT ANSWERED IT: **an item already travels
//  around a corner**, and did before [[059]] touched anything. Two belts, one facing east
//  and one facing south, laid so that the second begins on the first's exit tile — a potato
//  put on the first arrives on the second, unaided, in a bit over two hundred ticks.
//
//  That answer is what kept the feature out of the simulation's physics. `belts.ts` hands a
//  head item onto "whatever belt starts where its own ends", which is a corner by
//  construction, so nothing in `handOffFromHead`, `advanceBelt` or `beltInsert` needed to
//  change. What was missing was a GESTURE that could ask for a bend and a COMMAND that could
//  carry one, both of which are input-layer problems wearing a sim-shaped hat.
//
//  The second test is the reason the first one is not the whole story. Which leg owns the
//  elbow tile is the entire difference between a working corner and goods that pile up on a
//  belt for no visible reason, and both arrangements build, cost the same, and look identical
//  from three tiles up. It is pinned here so that a future refactor of `elbowBetween` cannot
//  quietly swap them.
// ────────────────────────────────────────────────────────────────────────────────────
//
// Lives in `apps/web` rather than in the sim's own suite because it is testing a claim the
// INPUT LAYER makes about the sim — that the shape it emits carries goods — and because the
// gesture it checks that shape against is two files away. Nothing here is browser-bound.

import { describe, expect, it } from 'vitest';
import {
  Direction,
  ItemId,
  TechId,
  beltAt,
  beltInsert,
  createWorld,
  isFieldTile,
  isOwnedTile,
  step,
} from '@snack/sim';
import type { Command, WorldState } from '@snack/sim';

import { beltCommandFor, elbowBetween } from './gesture';

/** A world with belts researched and money to burn, so refusals are about geometry only. */
function world(): WorldState {
  const state = createWorld(4242);
  state.moneyCents = 10_000_000;
  state.unlocked = [TechId.Belts];
  return state;
}

function run(state: WorldState, commands: Command[]): void {
  step(state, { tick: state.tick, commands });
}

/**
 * The top-left corner of a clear L-shaped strip of buildable ground.
 *
 * Searched for rather than hard-coded: the lot's field and its starting machines move
 * between releases, and a fixture that hard-codes (0,0) is a test that starts failing for a
 * reason that has nothing to do with belts.
 */
function clearCorner(state: WorldState, span: number): { x: number; y: number } {
  for (let y = 0; y + span < 16; y++) {
    for (let x = 0; x + span < 16; x++) {
      let ok = true;
      for (let i = 0; i <= span; i++) {
        if (!isOwnedTile(state, x + i, y) || isFieldTile(x + i, y)) ok = false;
        if (!isOwnedTile(state, x + span, y + i) || isFieldTile(x + span, y + i)) ok = false;
      }
      if (ok) return { x, y };
    }
  }
  throw new Error('no clear corner on the starting lot');
}

describe('the sim already turns corners', () => {
  it('carries an item from an east-facing belt onto the south-facing belt at its exit', () => {
    const state = world();
    const { x, y } = clearCorner(state, 3);

    // Laid the way the gesture lays it: the first leg stops SHORT of the corner, and the
    // second leg starts on it.
    run(state, [
      { type: 'PlaceBelt', tier: 1, tileX: x, tileY: y, dir: Direction.East, lengthTiles: 3 },
      { type: 'PlaceBelt', tier: 1, tileX: x + 3, tileY: y, dir: Direction.South, lengthTiles: 3 },
    ]);

    const first = beltAt(state, x, y)!;
    const second = beltAt(state, x + 3, y)!;
    expect(first.id).not.toBe(second.id);

    expect(beltInsert(first, 0, ItemId.RussetPotato)).toBe(true);
    for (let tick = 0; tick < 400; tick++) run(state, []);

    expect(first.items).toHaveLength(0);
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.item).toBe(ItemId.RussetPotato);
  });

  it('strands the item when the FIRST leg owns the elbow — the failure this shape avoids', () => {
    const state = world();
    const { x, y } = clearCorner(state, 3);

    // The plausible-looking arrangement: the first leg runs all the way to the corner and
    // the second starts below it. Both belts exist, both are legal, and the first one now
    // delivers into bare ground one tile east of the corner.
    run(state, [
      { type: 'PlaceBelt', tier: 1, tileX: x, tileY: y, dir: Direction.East, lengthTiles: 4 },
      {
        type: 'PlaceBelt',
        tier: 1,
        tileX: x + 3,
        tileY: y + 1,
        dir: Direction.South,
        lengthTiles: 2,
      },
    ]);

    const first = beltAt(state, x, y)!;
    const second = beltAt(state, x + 3, y + 1)!;
    beltInsert(first, 0, ItemId.RussetPotato);
    for (let tick = 0; tick < 400; tick++) run(state, []);

    expect(first.items).toHaveLength(1);
    expect(second.items).toHaveLength(0);
  });
});

describe('one bent drag is one command, refused whole', () => {
  it('lays both legs from a single PlaceBelt and joins them', () => {
    const state = world();
    const { x, y } = clearCorner(state, 3);

    const drag = elbowBetween({ tileX: x, tileY: y }, { tileX: x + 3, tileY: y + 2 }, false);
    run(state, [beltCommandFor(1, drag)]);

    expect(state.belts).toHaveLength(2);
    const first = beltAt(state, x, y)!;
    const second = beltAt(state, x + 3, y)!;
    expect(first.dir).toBe(Direction.East);
    expect(second.dir).toBe(Direction.South);

    beltInsert(first, 0, ItemId.RussetPotato);
    for (let tick = 0; tick < 400; tick++) run(state, []);
    expect(second.items).toHaveLength(1);
  });

  // The whole reason the bend rides on one command. Two `PlaceBelt`s would have laid the
  // first leg and refused the second, leaving a stub the player has to go and find.
  it('lays NOTHING when the far leg is illegal, not half a run', () => {
    const state = world();
    const { x, y } = clearCorner(state, 3);
    const moneyBefore = state.moneyCents;

    run(state, [
      {
        type: 'PlaceBelt',
        tier: 1,
        tileX: x,
        tileY: y,
        dir: Direction.East,
        lengthTiles: 3,
        // North off the top edge of the world. `clearCorner` never returns a row past 12, so
        // sixteen tiles of northward belt always leaves the map: legal first leg, impossible
        // second.
        turnDir: Direction.North,
        turnLengthTiles: 16,
      },
    ]);

    expect(state.belts).toHaveLength(0);
    expect(state.moneyCents).toBe(moneyBefore);
  });

  it('charges for both legs together', () => {
    const state = world();
    const { x, y } = clearCorner(state, 3);
    const moneyBefore = state.moneyCents;

    run(state, [
      {
        type: 'PlaceBelt',
        tier: 1,
        tileX: x,
        tileY: y,
        dir: Direction.East,
        lengthTiles: 3,
        turnDir: Direction.South,
        turnLengthTiles: 3,
      },
    ]);

    // Six tiles at the basic tier's per-tile price, in one charge.
    expect(moneyBefore - state.moneyCents).toBe(150 * 6);
  });

  // Parallel would be a straight run written in two pieces; anti-parallel would be a belt
  // folded back over itself. Both are refused rather than quietly normalised.
  it('refuses a second leg that is not perpendicular', () => {
    const state = world();
    const { x, y } = clearCorner(state, 3);

    run(state, [
      {
        type: 'PlaceBelt',
        tier: 1,
        tileX: x,
        tileY: y,
        dir: Direction.East,
        lengthTiles: 2,
        turnDir: Direction.East,
        turnLengthTiles: 2,
      },
    ]);
    expect(state.belts).toHaveLength(0);
  });
});
