// Cheap structural gates for the one piece of arithmetic in the HUD nobody can see is wrong.
//
// AGENTS.md keeps verification light, so this pins only what is INVISIBLE — and a background
// offset is the definition of invisible. Every failure available here draws a picture:
//
//   · IF THE OFFSET IS OUT BY THE ATLAS SCALE, the icon shows the frame NEXT to the right one.
//     A belt where a potato should be is a bug report; a slightly-wrong potato is a shrug. The
//     atlas is a shared page, so being wrong means drawing somebody else's art, never nothing.
//   · IF `backgroundSize` IS EVER A LITERAL, the day the packer needs a 1024px page every icon
//     in the game silently halves and slides. The atlas repacks on every art build ([[022]]) —
//     this is not a hypothetical, it is a scheduled event.
//   · IF A NON-SQUARE FRAME IS STRETCHED rather than letterboxed, the Bottler is squashed by a
//     third on one axis and looks like the art came back wrong.
//   · IF A CROP STRIP IS SLICED PAST ITS OWN EDGE, an icon shows half a plant and half of
//     whatever the packer put beside it on the page.
//   · IF A MISSING FRAME RESOLVED TO SOMETHING ANYWAY, the bag would draw a confident wrong
//     picture for every item the atlas has not got to yet — which is most of them.
//
// Nothing here renders. Whether the grid looks right on screen is not something this file can
// know; see the agent log on work item 058 for what was and was not checked in a running build.

import { describe, expect, it } from 'vitest';
import { CROP_SPECS, ITEM_SPECS, ItemId, MachineKind } from '@snack/sim';

// Relative rather than the `@/` alias, exactly as the other HUD tests do: vitest runs with no
// config in this repo, so the alias is not resolvable from a test.
import { ATLAS_FRAMES, ATLAS_IMAGE_URL, ATLAS_SIZE } from '../art/manifest.generated';
import { paintIcon, resolveItemIcon, resolveMachineIcon } from './item-art';
import type { IconSource } from './item-art';

const FRAMES: Readonly<Record<string, { x: number; y: number; width: number; height: number }>> =
  ATLAS_FRAMES;

/** 3, 2, 1, ½, ¼ — yes. 1.5, ⅓, 0 — no. */
function isWholeOrHalving(scale: number): boolean {
  if (scale >= 1) return Number.isInteger(scale);
  return scale > 0 && Number.isInteger(1 / scale) && Number.isInteger(Math.log2(1 / scale));
}

/** "-33px 12px" → [-33, 12]. */
function offsets(position: string): [number, number] {
  const parts = position.split(' ').map((part) => Number(part.replace('px', '')));
  return [parts[0] ?? NaN, parts[1] ?? NaN];
}

describe('fitting an atlas frame into a box', () => {
  const potato = resolveItemIcon(ItemId.RussetPotato);

  it('scales a square item by a whole number and fills a box that is a multiple of it', () => {
    expect(potato).not.toBeNull();
    const source = potato as IconSource;

    // THE NUMBER HERE USED TO BE 3, for 16px art in a 48px box — a resolution assertion wearing
    // an arithmetic hat, and the tile bump is what exposed it: the same box now yields 1×.
    // Asserting the MULTIPLE rather than the magnification is the version that survives the next
    // one. Square frame, square box, no slack: nothing to letterbox.
    const paint = paintIcon(source, source.width * 2);
    expect(paint.scale).toBe(2);
    expect(paint.offsetX).toBe(0);
    expect(paint.offsetY).toBe(0);
  });

  it('slides the page by the frame origin times the scale, and nothing else', () => {
    const source = potato as IconSource;
    const paint = paintIcon(source, 48);
    const [x, y] = offsets(paint.backgroundPosition);
    // The rule stated as its own inverse: undo the slide and the frame's own origin comes back.
    expect((paint.offsetX - x) / paint.scale).toBe(source.x);
    expect((paint.offsetY - y) / paint.scale).toBe(source.y);
  });

  it('scales the whole page, read off the manifest rather than written down', () => {
    for (const box of [16, 32, 48, 64]) {
      const paint = paintIcon(potato as IconSource, box);
      expect(paint.backgroundSize).toBe(
        `${ATLAS_SIZE.width * paint.scale}px ${ATLAS_SIZE.height * paint.scale}px`,
      );
    }
  });

  it('points at the content-hashed URL from the manifest, never a copied string', () => {
    expect(paintIcon(potato as IconSource, 32).backgroundImage).toBe(`url(${ATLAS_IMAGE_URL})`);
  });

  it('halves an oversized frame into its box instead of cropping it, and never to nothing', () => {
    const bottler = resolveMachineIcon(MachineKind.Bottler) as IconSource;
    expect(bottler).not.toBeNull();

    // THIS TEST USED TO PIN THE OPPOSITE and the tile bump is why it flipped: it asserted that a
    // frame too big for its box keeps 1× and centre-crops, on the grounds that the case could not
    // arise. It arises on every machine now — the art is 32px-tile art and the boxes are CSS
    // pixels that did not move — so the widest frame in the game must survive the narrowest box
    // the HUD has, by shrinking on both axes and staying whole.
    const paint = paintIcon(bottler, 32);
    expect(paint.scale).toBeGreaterThan(0);
    expect(bottler.width * paint.scale).toBeLessThanOrEqual(32);
    expect(bottler.height * paint.scale).toBeLessThanOrEqual(32);
  });

  it('letterboxes a non-square frame instead of stretching it', () => {
    const bottler = resolveMachineIcon(MachineKind.Bottler) as IconSource;
    expect(bottler.width).not.toBe(bottler.height);

    const paint = paintIcon(bottler, 64);
    // Drawn size is the frame's own size times ONE scale on both axes — which is what "not
    // stretched" means arithmetically — and the leftover box is padding, split evenly.
    expect(64 - paint.offsetX * 2).toBe(bottler.width * paint.scale);
    expect(64 - paint.offsetY * 2).toBe(bottler.height * paint.scale);
    expect(paint.offsetY).toBeGreaterThan(paint.offsetX);
  });

  it('keeps every offset a whole pixel, so nothing is ever re-sampled', () => {
    for (const spec of ITEM_SPECS) {
      const source = resolveItemIcon(spec.id);
      if (source === null) continue;
      for (const box of [16, 24, 32, 48, 60, 64]) {
        const paint = paintIcon(source, box);
        const [x, y] = offsets(paint.backgroundPosition);
        expect(Number.isInteger(x)).toBe(true);
        expect(Number.isInteger(y)).toBe(true);
        // A whole magnification, or an exact halving. Those are the two ratios a nearest-neighbour
        // sampler maps one-to-one — every other one lands between source pixels, and a blurry
        // inventory icon in a pixel game is the failure this whole module is arranged to avoid.
        // The box list reaches below the smallest box the HUD actually uses (the pouch's 32) on
        // purpose: 16 and 24 are where the halving ladder gets exercised at all.
        expect(isWholeOrHalving(paint.scale)).toBe(true);
      }
    }
  });
});

describe('which picture an item is', () => {
  it('only ever names a frame the atlas actually has', () => {
    for (const spec of ITEM_SPECS) {
      const source = resolveItemIcon(spec.id);
      if (source === null) continue;
      expect(FRAMES[source.frame]).toBeDefined();
    }
  });

  it('stays inside the frame it came out of, cells and all', () => {
    for (const spec of ITEM_SPECS) {
      const source = resolveItemIcon(spec.id);
      if (source === null) continue;
      const frame = FRAMES[source.frame]!;
      expect(source.x).toBeGreaterThanOrEqual(frame.x);
      expect(source.y).toBeGreaterThanOrEqual(frame.y);
      expect(source.x + source.width).toBeLessThanOrEqual(frame.x + frame.width);
      expect(source.y + source.height).toBeLessThanOrEqual(frame.y + frame.height);
    }
  });

  it('draws a boxed machine as the machine inside it, not as an item', () => {
    const boxed = resolveItemIcon(ItemId.BoxedFryer);
    expect(boxed).toEqual(resolveMachineIcon(MachineKind.Fryer));
    expect(boxed?.frame).toBe('machine_fryer');
  });

  it('gives a seed and its harvest different cells of the same strip', () => {
    for (const crop of CROP_SPECS) {
      const seed = resolveItemIcon(crop.seedItem);
      const fruit = resolveItemIcon(crop.yieldItem);
      if (seed === null || fruit === null) continue;
      // Only meaningful where both fell through to the crop strip; an item with its own frame
      // (the russet has one) is already distinct by construction.
      if (seed.frame !== fruit.frame) continue;
      expect(seed.x).not.toBe(fruit.x);
      expect(seed.width).toBe(seed.height);
      expect(fruit.width).toBe(fruit.height);
    }
  });

  it('finds a picture for the seed a new player starts with', () => {
    // The whole feature, at the only moment it is guaranteed to be looked at. If this fails the
    // first bag ever opened is a blank chip and a number.
    expect(resolveItemIcon(ItemId.PotatoSeed)).not.toBeNull();
    expect(resolveItemIcon(ItemId.RussetPotato)).not.toBeNull();
  });

  it('answers "no picture" rather than guessing, for an item from the future', () => {
    // A save from a later build, or a sim agent halfway through adding a crop. Neither is an
    // error and neither may draw the renderer's magenta square ([[037]]) — the component turns
    // this null into a neutral chip.
    expect(resolveItemIcon(999_999)).toBeNull();
    expect(resolveMachineIcon(999_999)).toBeNull();
  });
});
