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
    crop: new Array<number>(COUNT).fill(0),
    stage: new Array<number>(COUNT).fill(0),
    moisturePermille: new Array<number>(COUNT).fill(0),
    ready: new Array<number>(COUNT).fill(0),
    dry: new Array<number>(COUNT).fill(0),
    fertility: new Array<number>(COUNT).fill(0),
    soil: new Array<number>(COUNT).fill(1),
    wilt: new Array<number>(COUNT).fill(0),
    readyAge: new Array<number>(COUNT).fill(0),
    compost: new Array<number>(COUNT).fill(0),
    zone: new Array<number>(COUNT).fill(0),
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

  it('only counts a real rise as a pour', () => {
    // The threshold exists so that a tile drying out one permille at a time never reads as
    // somebody watering it.
    expect(FarmFx.isPour(1000, 0)).toBe(true);
    expect(FarmFx.isPour(41, 0)).toBe(true);
    expect(FarmFx.isPour(40, 0)).toBe(false);
    expect(FarmFx.isPour(500, 500)).toBe(false);
    expect(FarmFx.isPour(499, 500)).toBe(false);
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

  it('does not fire when a crop collapses into compost', () => {
    const fx = makeFx();
    fx.observe(field({ crop: [1, 0, 0, 0], ready: [1, 0, 0, 0] }));

    // Same "was ripe, is gone" shape as a harvest — the compost heap that appeared on the
    // tile is the only thing that tells them apart. Nobody picked this one.
    fx.observe(field({ crop: [0, 0, 0, 0], ready: [0, 0, 0, 0], compost: [1, 0, 0, 0] }));

    expect(fx.flying).toBe(0);
  });

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
