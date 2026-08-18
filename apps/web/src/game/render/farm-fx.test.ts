// The cheap structural gate for the field's juice.
//
// Both things pinned here are invisible in a screenshot, which is the same reason
// `pipes.test.ts` exists. A drink-bounce lasts about four hundred milliseconds and a harvest
// pop about six hundred — by the time you have taken a screenshot they are over, and the
// only way to see either one go wrong is to already know what it should have looked like.
//
// What actually breaks:
//
//   A bounce that never returns to rest leaves the whole field permanently squashed, and it
//   looks enough like art that it gets blamed on the atlas.
//
//   A harvest diff that fires on the wrong transition throws a potato out of a crop that
//   ROTTED. Item 009's spec is a pop "with an item-magnet pulling the potato to the player",
//   and a world where compost also launches one is quietly telling the player they were paid
//   for something they were not.
//
//   And a first frame that emits rather than primes means loading a save full of ripe crops
//   opens the game with the entire field convulsing.
//
// Pixi is stubbed rather than run: `FarmFx` owns sprites, but everything asserted below is
// arithmetic over the projection, and `Texture.EMPTY` needs no GPU.

import { describe, expect, it } from 'vitest';
import { Texture } from 'pixi.js';

import type { FieldView } from '@snack/sim';

import { FarmFx } from './farm-fx';
import type { ItemPage } from './belt-items';

const WIDE = 2;
const HIGH = 2;
const COUNT = WIDE * HIGH;

/** An item page that hands out the same blank texture for everything. */
const PAGE: ItemPage = {
  texture: () => Texture.EMPTY,
  destroy: () => undefined,
};

function field(overrides: Partial<FieldView> = {}): FieldView {
  return {
    originX: 0,
    originY: 0,
    tilesWide: WIDE,
    tilesHigh: HIGH,
    count: COUNT,
    tileX: new Array<number>(COUNT).fill(0),
    tileY: new Array<number>(COUNT).fill(0),
    crop: new Array<number>(COUNT).fill(0),
    stage: new Array<number>(COUNT).fill(0),
    moisturePermille: new Array<number>(COUNT).fill(0),
    ready: new Array<number>(COUNT).fill(0),
    dry: new Array<number>(COUNT).fill(0),
    soil: new Array<number>(COUNT).fill(1),
    zone: new Array<number>(COUNT).fill(0),
    lastPouredTick: new Array<number>(COUNT).fill(0),
    ...overrides,
  };
}

function makeFx(): FarmFx {
  return new FarmFx(PAGE, COUNT, () => undefined);
}

/** Run the clock forward in frame-sized steps, the way the render loop does. */
function advance(fx: FarmFx, ms: number): void {
  for (let elapsed = 0; elapsed < ms; elapsed += 16) fx.update(16, 0, 0);
}

describe('drink-bounce', () => {
  it('squashes and stretches on opposite axes', () => {
    const fx = makeFx();
    fx.pour(0);

    // Past the per-pour stagger, into the body of the curve.
    advance(fx, 140);
    const bounce = fx.bounceAt(0);

    // Wider means shorter and shorter means wider. A bounce that scaled both axes the same
    // way would be a plant growing and shrinking, not one being pressed into the soil.
    expect(bounce.scaleX).not.toBe(1);
    expect((bounce.scaleX - 1) * (bounce.scaleY - 1)).toBeLessThan(0);
  });

  it('returns exactly to rest and stays there', () => {
    const fx = makeFx();
    fx.pour(0);
    advance(fx, 1200);

    const bounce = fx.bounceAt(0);
    expect(bounce.scaleX).toBe(1);
    expect(bounce.scaleY).toBe(1);
  });

  it('leaves untouched tiles alone', () => {
    const fx = makeFx();
    fx.pour(0);
    advance(fx, 140);

    expect(fx.bounceAt(1).scaleX).toBe(1);
  });

  // ── THE POUR SIGNAL (item 064, amended by 081) ──────────────────────────────────────
  // The pour is read off `FieldView.lastPouredTick`, never inferred from moisture — the
  // signal is the SOLE trigger, in both directions. Signal moved → feedback, even when the
  // clamp hides it from moisture (a sprinkler's sloppiness tax still pours on soaked tiles
  // by design). Signal still → silence, even when the player just clicked (the hand can's
  // saturated pour is now a sim-side REFUSAL that marks nothing, item 081) or when
  // moisture rose without a pour. Plus the loaded-save priming rule.

  it('plays full feedback when the signal moves on an already-saturated tile', () => {
    // A MACHINE pour: the sprinkler deliberately spends on soaked tiles and the sim marks
    // the signal for it. Soaked before and after — the clamp means moisture cannot move.
    // Only the pour tick does, and that must be enough for the bounce AND the droplets.
    const fx = makeFx();
    const poured: number[] = [];

    fx.observe(field({ moisturePermille: [1000, 1000, 1000, 1000] }), (i) => poured.push(i));
    fx.observe(
      field({ moisturePermille: [1000, 1000, 1000, 1000], lastPouredTick: [50, 0, 0, 0] }),
      (i) => poured.push(i),
    );

    expect(poured).toEqual([0]);
    advance(fx, 140);
    expect(fx.bounceAt(0).scaleX).not.toBe(1);
  });

  it('stays fully silent on a refused hand pour ([[081]])', () => {
    // The sim's refusal marks NOTHING — no charge, no water, no `lastPouredTick` — so the
    // projection is frame-over-frame identical and this differ must produce no droplets
    // and no bounce. Feedback on nothing happening is the lie 064 fixed, inverted.
    const fx = makeFx();
    const poured: number[] = [];

    const soaked = () => field({ moisturePermille: [1000, 1000, 1000, 1000] });
    fx.observe(soaked(), (i) => poured.push(i));
    fx.observe(soaked(), (i) => poured.push(i));
    fx.observe(soaked(), (i) => poured.push(i));

    expect(poured).toEqual([]);
    advance(fx, 140);
    expect(fx.bounceAt(0).scaleX).toBe(1);
    expect(fx.bounceAt(0).scaleY).toBe(1);
  });

  it('does not treat a moisture rise without a pour signal as a pour', () => {
    // A rise the signal does not claim — this is the deleted inference, pinned dead.
    const fx = makeFx();
    const poured: number[] = [];

    fx.observe(field(), (i) => poured.push(i));
    fx.observe(field({ moisturePermille: [1000, 0, 0, 0] }), (i) => poured.push(i));

    expect(poured).toEqual([]);
    expect(fx.bounceAt(0).scaleX).toBe(1);
  });

  it('primes on the first frame instead of firing on old pour ticks', () => {
    // A renderer rebuilt against a running world sees non-zero ticks on its first frame.
    const fx = makeFx();
    const poured: number[] = [];

    fx.observe(field({ lastPouredTick: [40, 41, 42, 43] }), (i) => poured.push(i));
    expect(poured).toEqual([]);

    // The NEXT pour still lands.
    fx.observe(field({ lastPouredTick: [40, 90, 42, 43] }), (i) => poured.push(i));
    expect(poured).toEqual([1]);
  });
});

describe('harvest pop', () => {
  it('primes on the first frame instead of firing', () => {
    const fx = makeFx();

    // A save arriving mid-harvest: ripe on the first frame it is ever shown, gone on the
    // next. Only the second transition is real, and there is exactly one potato.
    const ripe = field({ crop: [1, 1, 1, 1], ready: [1, 1, 1, 1] });
    fx.observe(ripe);
    expect(fx.flying).toBe(0);

    fx.observe(field({ crop: [0, 1, 1, 1], ready: [0, 1, 1, 1] }));
    expect(fx.flying).toBe(1);
  });

  it('fires once per harvested tile', () => {
    const fx = makeFx();
    fx.observe(field({ crop: [1, 1, 0, 0], ready: [1, 1, 0, 0] }));
    fx.observe(field({ crop: [0, 0, 0, 0], ready: [0, 0, 0, 0] }));

    expect(fx.flying).toBe(2);
  });

  // ⚠️ A TEST STOOD HERE AND [[124]] DELETED THE CASE IT GUARDED. A ripe crop could collapse
  // into compost on its own, which from the differ's side looked exactly like a harvest — "was
  // ripe, is gone" — so `observe` also watched the compost heap and stayed silent when one
  // appeared. Crops do not collapse now, so "was ripe, is gone" IS a harvest and there is no
  // second case to tell apart. The pop is fired by the two tests either side of this note.

  it('does not fire when a crop is merely growing', () => {
    const fx = makeFx();
    fx.observe(field({ crop: [1, 0, 0, 0], stage: [1, 0, 0, 0] }));
    fx.observe(field({ crop: [1, 0, 0, 0], stage: [2, 0, 0, 0] }));

    expect(fx.flying).toBe(0);
  });

  it('lands the potato and frees its slot', () => {
    const fx = makeFx();
    fx.observe(field({ crop: [1, 0, 0, 0], ready: [1, 0, 0, 0] }));
    fx.observe(field({ crop: [0, 0, 0, 0], ready: [0, 0, 0, 0] }));
    expect(fx.flying).toBe(1);

    // Every pop must expire. One tween left running per harvest is the leak this pool
    // exists to prevent, and a ripe 8x8 field is sixty-four of them.
    advance(fx, 1200);
    expect(fx.flying).toBe(0);
  });
});

// ── THE COLLECTION MOVES ([[066]]) ─────────────────────────────────────────────────────
// Farmland is a keyed collection now and a till SHIFTS EVERY INDEX AFTER IT. The differ
// re-files its memory by world tile key on the frame the keys move; these pin the two ways
// a positional diff would have lied — a phantom pop out of shifted indexes, and a real
// harvest lost in the shuffle.
describe('re-keying on a till', () => {
  /** A field of distinct positions, so keys actually distinguish the tiles. */
  function keyedField(xs: number[], ys: number[], overrides: Partial<FieldView> = {}): FieldView {
    const n = xs.length;
    return field({
      count: n,
      tileX: xs,
      tileY: ys,
      crop: new Array<number>(n).fill(0),
      stage: new Array<number>(n).fill(0),
      moisturePermille: new Array<number>(n).fill(0),
      ready: new Array<number>(n).fill(0),
      dry: new Array<number>(n).fill(0),
      soil: new Array<number>(n).fill(1),
      zone: new Array<number>(n).fill(0),
      lastPouredTick: new Array<number>(n).fill(0),
      ...overrides,
    });
  }

  it('does not fire a phantom harvest when a till shifts every index', () => {
    const fx = makeFx();
    // A ripe crop on (5,5), and a bare tile on (6,5).
    fx.observe(keyedField([5, 6], [5, 5], { crop: [1, 0], ready: [1, 0] }));

    // A till at (4,5) inserts at index 0: the ripe crop moves to index 1, positionally the
    // slot that used to be bare. Diffed by index this is "ready vanished at 0" — a phantom
    // pop out of fresh dirt. Diffed by key it is nothing at all.
    fx.observe(keyedField([4, 5, 6], [5, 5, 5], { crop: [0, 1, 0], ready: [0, 1, 0] }));
    expect(fx.flying).toBe(0);
  });

  it('still sees a real harvest that lands on the same frame as the till', () => {
    const fx = makeFx();
    fx.observe(keyedField([5, 6], [5, 5], { crop: [1, 0], ready: [1, 0] }));

    // The same index shuffle, AND the crop on (5,5) genuinely harvested. One potato.
    fx.observe(keyedField([4, 5, 6], [5, 5, 5]));
    expect(fx.flying).toBe(1);
  });

  it('keeps pour memory with its tile across the shuffle', () => {
    const fx = makeFx();
    const poured: number[] = [];
    fx.observe(keyedField([5, 6], [5, 5], { lastPouredTick: [40, 0] }));

    // After the till, (5,5) sits at index 1 with the same old pour tick: silence. The NEXT
    // pour on it still lands, reported at its new index.
    fx.observe(keyedField([4, 5, 6], [5, 5, 5], { lastPouredTick: [0, 40, 0] }), (i) =>
      poured.push(i),
    );
    expect(poured).toEqual([]);

    fx.observe(keyedField([4, 5, 6], [5, 5, 5], { lastPouredTick: [0, 90, 0] }), (i) =>
      poured.push(i),
    );
    expect(poured).toEqual([1]);
  });

  it('treats an un-tilled position returning later as fresh dirt, not as memory', () => {
    const fx = makeFx();
    fx.observe(keyedField([5], [5], { crop: [1], ready: [1] }));

    // Un-till everything, then re-till the same spot bare. "Was ripe, is gone" spans the
    // gap positionally AND by key — but the memory left with the farmland, so no pop.
    fx.observe(keyedField([], []));
    fx.observe(keyedField([5], [5]));
    expect(fx.flying).toBe(0);
  });
});
