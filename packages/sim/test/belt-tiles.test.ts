// Item 084: belts place by drag but live as individual tiles.
//
// The owner's ruling, verbatim: "I want belts to be treated individually. I like the idea of
// placing them by the way of them [the drag], but I want to be able to tear down and rotate
// individually." The storage model did not change — a belt is still a straight segment with a
// sorted `(dist, item)` list — so what these tests pin is the SURGERY: `splitBeltAtTile`
// redistributes goods by physical position, `RotateBelt` turns one tile, `RemoveBeltTile`
// cuts one out, and a run chopped into 1-tile segments still delivers at the rate of the
// long segment it was cut from. That last one is what lets the sim skip a merge primitive:
// chains are already how corners work, so fragments are ordinary, not degraded.
//
// These tests also carry the golden-coverage exemption for the two new commands (see
// `GOLDEN_COVERAGE_EXEMPT` in `goldens.ts`): the determinism claim a fixture would make is
// made here instead, directly.

import { describe, expect, it } from 'vitest';

import {
  type Belt,
  type Command,
  type WorldState,
  BeltTier,
  Direction,
  ItemId,
  SUBTILE,
  beltAt,
  beltEndDist,
  beltInsert,
  createWorld,
  hashState,
  itemCount,
  spawnBelt,
  splitBeltAtTile,
  step,
} from '../src/index';

function run(state: WorldState, commands: Command[]): void {
  step(state, { tick: state.tick, commands });
}

/**
 * How far a Basic belt drifts its goods in the one tick `run` advances after applying the
 * command: floor(320 / 100). Assertions on exact `dist` add it, because a command is applied
 * at the tick boundary and the world then moves.
 */
const DRIFT = 3;

/** Put the player on a tile so the reach-gated rotate is in reach. Position is not a command. */
function standOn(state: WorldState, tileX: number, tileY: number): void {
  state.player.xSub = tileX * SUBTILE + SUBTILE / 2;
  state.player.ySub = tileY * SUBTILE + SUBTILE / 2;
}

/** The world tile and within-tile offset an item is riding, read off its belt. */
function worldPositionsOf(state: WorldState): Map<number, { x: number; y: number; off: number }[]> {
  const out = new Map<number, { x: number; y: number; off: number }[]>();
  for (const belt of state.belts) {
    for (const entry of belt.items) {
      const index = Math.floor(entry.dist / SUBTILE);
      const x =
        belt.tileX +
        (belt.dir === Direction.East ? index : belt.dir === Direction.West ? -index : 0);
      const y =
        belt.tileY +
        (belt.dir === Direction.South ? index : belt.dir === Direction.North ? -index : 0);
      const list = out.get(entry.item) ?? [];
      list.push({ x, y, off: entry.dist - index * SUBTILE });
      out.set(entry.item, list);
    }
  }
  return out;
}

function totalOnBelts(state: WorldState): number {
  let n = 0;
  for (const belt of state.belts) n += belt.items.length;
  return n;
}

// --- rotating one tile --------------------------------------------------------------

describe('RotateBelt', () => {
  it('turns a mid-run tile into its own segment and leaves the rest untouched', () => {
    const state = createWorld(7);
    const belt = spawnBelt(state, BeltTier.Basic, 0, 0, Direction.East, 5)!;
    // One item on tile 1, one on tile 3 — either side of the cut, neither on it.
    expect(beltInsert(belt, 1 * SUBTILE + 10, ItemId.RussetPotato)).toBe(true);
    expect(beltInsert(belt, 3 * SUBTILE + 20, ItemId.PlainChips)).toBe(true);

    standOn(state, 2, 1);
    run(state, [{ type: 'RotateBelt', tileX: 2, tileY: 0 }]);

    expect(state.belts).toHaveLength(3);
    const before = beltAt(state, 0, 0)!;
    const mid = beltAt(state, 2, 0)!;
    const after = beltAt(state, 3, 0)!;

    expect(before.dir).toBe(Direction.East);
    expect(before.lengthTiles).toBe(2);
    // East one step clockwise is South.
    expect(mid.dir).toBe(Direction.South);
    expect(mid.lengthTiles).toBe(1);
    expect(after.dir).toBe(Direction.East);
    expect(after.lengthTiles).toBe(2);

    // Goods redistributed by physical position: nothing teleported, nothing vanished.
    expect(before.items).toEqual([{ dist: 1 * SUBTILE + 10 + DRIFT, item: ItemId.RussetPotato }]);
    expect(mid.items).toEqual([]);
    expect(after.items).toEqual([{ dist: 20 + DRIFT, item: ItemId.PlainChips }]);
  });

  it('keeps an item on the rotated tile, re-anchored to its new axis', () => {
    const state = createWorld(7);
    const belt = spawnBelt(state, BeltTier.Basic, 0, 0, Direction.East, 3)!;
    expect(beltInsert(belt, 1 * SUBTILE + 30, ItemId.RussetPotato)).toBe(true);

    standOn(state, 1, 1);
    run(state, [{ type: 'RotateBelt', tileX: 1, tileY: 0 }]);

    const mid = beltAt(state, 1, 0)!;
    expect(mid.lengthTiles).toBe(1);
    expect(mid.dir).toBe(Direction.South);
    // Same tile, same offset along the (new) axis — the item swings with its floor.
    expect(mid.items).toEqual([{ dist: 30 + DRIFT, item: ItemId.RussetPotato }]);
  });

  it('splits into two segments when the tile is the head or the tail of the run', () => {
    const state = createWorld(7);
    spawnBelt(state, BeltTier.Basic, 0, 0, Direction.East, 4);
    standOn(state, 0, 1);
    run(state, [{ type: 'RotateBelt', tileX: 0, tileY: 0 }]);
    expect(state.belts).toHaveLength(2);
    expect(beltAt(state, 0, 0)!.lengthTiles).toBe(1);
    expect(beltAt(state, 1, 0)!.lengthTiles).toBe(3);

    const tail = createWorld(7);
    spawnBelt(tail, BeltTier.Basic, 0, 0, Direction.East, 4);
    standOn(tail, 3, 1);
    run(tail, [{ type: 'RotateBelt', tileX: 3, tileY: 0 }]);
    expect(tail.belts).toHaveLength(2);
    expect(beltAt(tail, 0, 0)!.lengthTiles).toBe(3);
    expect(beltAt(tail, 3, 0)!.lengthTiles).toBe(1);
  });

  it('cycles a 1-tile belt in place through all four directions, with no id churn', () => {
    const state = createWorld(7);
    const belt = spawnBelt(state, BeltTier.Basic, 4, 4, Direction.North, 1)!;
    const id = belt.id;
    standOn(state, 4, 4);

    const seen: Direction[] = [];
    for (let i = 0; i < 4; i++) {
      run(state, [{ type: 'RotateBelt', tileX: 4, tileY: 4 }]);
      seen.push(beltAt(state, 4, 4)!.dir);
    }
    expect(seen).toEqual([Direction.East, Direction.South, Direction.West, Direction.North]);
    expect(state.belts).toHaveLength(1);
    expect(beltAt(state, 4, 4)!.id).toBe(id);
  });

  it('is reach-gated exactly as RotateGrabber is, and refuses bare ground', () => {
    // A twin world steps the same ticks with no commands at all: a refused command must
    // leave the world — and the trace — indistinguishable from never having been sent.
    const build = (refusals: boolean): WorldState => {
      const state = createWorld(7);
      spawnBelt(state, BeltTier.Basic, 0, 0, Direction.East, 3);
      standOn(state, 40, 40);
      run(state, refusals ? [{ type: 'RotateBelt', tileX: 1, tileY: 0 }] : []); // out of reach
      run(state, refusals ? [{ type: 'RotateBelt', tileX: 39, tileY: 40 }] : []); // no belt
      return state;
    };

    const state = build(true);
    expect(state.belts).toHaveLength(1);
    expect(beltAt(state, 0, 0)!.dir).toBe(Direction.East);
    expect(hashState(state)).toBe(hashState(build(false)));
  });
});

// --- tearing down one tile ----------------------------------------------------------

describe('RemoveBeltTile', () => {
  it('cuts one mid-run tile out, refunds one tile, and hands its goods to the player', () => {
    const state = createWorld(7);
    const belt = spawnBelt(state, BeltTier.Basic, 0, 0, Direction.East, 5)!;
    expect(beltInsert(belt, 0 * SUBTILE + 5, ItemId.RussetPotato)).toBe(true);
    expect(beltInsert(belt, 2 * SUBTILE + 40, ItemId.PlainChips)).toBe(true);
    expect(beltInsert(belt, 4 * SUBTILE + 50, ItemId.BaggedChips)).toBe(true);
    const money = state.moneyCents;

    run(state, [{ type: 'RemoveBeltTile', tileX: 2, tileY: 0 }]);

    // One tile's refund, not five.
    expect(state.moneyCents).toBe(money + 150);
    // The cut tile's goods are in the player's hands (plan §4), the rest still riding.
    expect(itemCount(state, ItemId.PlainChips)).toBe(1);
    expect(state.belts).toHaveLength(2);
    expect(beltAt(state, 2, 0)).toBeNull();
    expect(beltAt(state, 0, 0)!.items).toEqual([{ dist: 5 + DRIFT, item: ItemId.RussetPotato }]);
    expect(beltAt(state, 3, 0)!.items).toEqual([
      { dist: SUBTILE + 50 + DRIFT, item: ItemId.BaggedChips },
    ]);
  });

  it('leaves both survivors working: goods still move on each half', () => {
    const state = createWorld(7);
    const belt = spawnBelt(state, BeltTier.Basic, 0, 0, Direction.East, 5)!;
    expect(beltInsert(belt, 10, ItemId.RussetPotato)).toBe(true);
    expect(beltInsert(belt, 3 * SUBTILE + 10, ItemId.PlainChips)).toBe(true);

    run(state, [{ type: 'RemoveBeltTile', tileX: 2, tileY: 0 }]);
    const beforePart = beltAt(state, 0, 0)!;
    const afterPart = beltAt(state, 3, 0)!;
    const a = beforePart.items[0]!.dist;
    const b = afterPart.items[0]!.dist;

    run(state, []);
    run(state, []);

    expect(beforePart.items[0]!.dist).toBeGreaterThan(a);
    expect(afterPart.items[0]!.dist).toBeGreaterThan(b);
  });

  it('takes a 1-tile belt out whole, goods and refund included', () => {
    const state = createWorld(7);
    const belt = spawnBelt(state, BeltTier.Basic, 3, 3, Direction.East, 1)!;
    expect(beltInsert(belt, 12, ItemId.RussetPotato)).toBe(true);
    const money = state.moneyCents;

    run(state, [{ type: 'RemoveBeltTile', tileX: 3, tileY: 3 }]);

    expect(state.belts).toHaveLength(0);
    expect(state.moneyCents).toBe(money + 150);
    expect(itemCount(state, ItemId.RussetPotato)).toBe(1);
  });

  it('is refused on bare ground and leaves the world as if never sent', () => {
    const state = createWorld(7);
    run(state, [{ type: 'RemoveBeltTile', tileX: 10, tileY: 10 }]);

    const twin = createWorld(7);
    run(twin, []);
    expect(hashState(state)).toBe(hashState(twin));
  });
});

// --- the redistribution property ----------------------------------------------------

describe('splitBeltAtTile', () => {
  it('preserves every item, by count and by world position, for every cut point', () => {
    // Every cut index of an 8-tile belt, with goods packed at the legal spacing so every
    // tile is carrying something — the densest world a split can meet.
    for (let cut = 0; cut < 8; cut++) {
      const state = createWorld(11);
      const belt = spawnBelt(state, BeltTier.Basic, 2, 3, Direction.South, 8)!;
      for (let d = 0; d + 64 <= beltEndDist(belt); d += 64) {
        expect(beltInsert(belt, d, ItemId.RussetPotato)).toBe(true);
      }
      const total = totalOnBelts(state);
      const posBefore = worldPositionsOf(state);
      const onCutTile = belt.items.filter((e) => Math.floor(e.dist / SUBTILE) === cut).length;

      const parts = splitBeltAtTile(state, belt, cut, null);

      expect(parts.freed).toHaveLength(onCutTile);
      expect(totalOnBelts(state)).toBe(total - onCutTile);
      // Every surviving item stands exactly where it stood, to the subtile.
      const posAfter = worldPositionsOf(state);
      const expected = (posBefore.get(ItemId.RussetPotato) ?? []).filter(
        (p) => !(p.x === 2 && p.y === 3 + cut),
      );
      expect(posAfter.get(ItemId.RussetPotato) ?? []).toEqual(expect.arrayContaining(expected));
      expect((posAfter.get(ItemId.RussetPotato) ?? []).length).toBe(expected.length);
    }
  });

  it('keeps every part sorted and legally spaced, so beltInsert still trusts the list', () => {
    const state = createWorld(11);
    const belt = spawnBelt(state, BeltTier.Basic, 0, 0, Direction.East, 6)!;
    for (let d = 32; d + 64 <= beltEndDist(belt); d += 96) {
      expect(beltInsert(belt, d, ItemId.PlainChips)).toBe(true);
    }
    splitBeltAtTile(state, belt, 3, Direction.South);
    for (const part of state.belts) {
      for (let i = 1; i < part.items.length; i++) {
        expect(part.items[i]!.dist - part.items[i - 1]!.dist).toBeGreaterThanOrEqual(64);
      }
      for (const entry of part.items) {
        expect(entry.dist).toBeGreaterThanOrEqual(0);
        expect(entry.dist).toBeLessThanOrEqual(beltEndDist(part));
      }
    }
  });
});

// --- determinism (the claim a golden fixture would make) ----------------------------

describe('surgery determinism', () => {
  it('two worlds, same seed, same cuts on the same ticks, identical hashes', () => {
    const build = (): WorldState => {
      const state = createWorld(21);
      const belt = spawnBelt(state, BeltTier.Basic, 0, 0, Direction.East, 6)!;
      beltInsert(belt, 1 * SUBTILE, ItemId.RussetPotato);
      beltInsert(belt, 4 * SUBTILE, ItemId.PlainChips);
      standOn(state, 2, 1);
      run(state, [{ type: 'RotateBelt', tileX: 2, tileY: 0 }]);
      run(state, []);
      run(state, [{ type: 'RemoveBeltTile', tileX: 4, tileY: 0 }]);
      for (let i = 0; i < 50; i++) run(state, []);
      return state;
    };
    expect(hashState(build())).toBe(hashState(build()));
  });
});

// --- throughput parity --------------------------------------------------------------

/**
 * Feed a run greedily at its start tile and count what falls off its end tile, per tick.
 * The measurement the flow LOD's honesty rests on: a chain of 1-tile segments must deliver
 * at the long segment's rate, or fragmentation would quietly derate a line.
 */
function measureDeliveries(
  state: WorldState,
  startX: number,
  endX: number,
  warmupTicks: number,
  windowTicks: number,
): number {
  let delivered = 0;
  for (let t = 0; t < warmupTicks + windowTicks; t++) {
    const source = beltAt(state, startX, 0)!;
    beltInsert(source, 0, ItemId.RussetPotato);
    run(state, []);
    const sink = beltAt(state, endX, 0)!;
    const head = sink.items[sink.items.length - 1];
    if (head !== undefined && head.dist >= beltEndDist(sink)) {
      sink.items.pop();
      if (t >= warmupTicks) delivered += 1;
    }
  }
  return delivered;
}

describe('throughput parity', () => {
  it('a chain of 1-tile segments delivers at the same steady rate as one long segment', () => {
    const long = createWorld(31);
    spawnBelt(long, BeltTier.Basic, 0, 0, Direction.East, 6);
    const longRate = measureDeliveries(long, 0, 5, 500, 2000);

    // The chain, laid tile by tile in drag order: ids ascend downstream.
    const chain = createWorld(31);
    for (let x = 0; x < 6; x++) spawnBelt(chain, BeltTier.Basic, x, 0, Direction.East, 1);
    const chainRate = measureDeliveries(chain, 0, 5, 500, 2000);

    // A run fragmented BY surgery, ids scrambled by the cuts: rotate two tiles full circle,
    // so the line reads straight again but lives as four segments with shuffled ids.
    const cut = createWorld(31);
    spawnBelt(cut, BeltTier.Basic, 0, 0, Direction.East, 6);
    standOn(cut, 2, 1);
    for (let i = 0; i < 4; i++) run(cut, [{ type: 'RotateBelt', tileX: 2, tileY: 0 }]);
    standOn(cut, 4, 1);
    for (let i = 0; i < 4; i++) run(cut, [{ type: 'RotateBelt', tileX: 4, tileY: 0 }]);
    expect(cut.belts.length).toBeGreaterThan(1);
    for (const belt of cut.belts) expect(belt.dir).toBe(Direction.East);
    const cutRate = measureDeliveries(cut, 0, 5, 500, 2000);

    // Both are flowing hard (max rate is speed/spacing = one item per 20 ticks), and the
    // rates agree to within one item of phase over a 2,000-tick window.
    expect(longRate).toBeGreaterThan(90);
    expect(Math.abs(chainRate - longRate)).toBeLessThanOrEqual(1);
    expect(Math.abs(cutRate - longRate)).toBeLessThanOrEqual(1);
  });
});

// --- the clock crossings this file owns (item 119) --------------------------------------------
//
