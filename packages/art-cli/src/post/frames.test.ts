import { describe, expect, it } from 'vitest';
import { planAnimation, reassembleStrip } from './frames.js';
import type { AnimationPlan } from './frames.js';
import type { RawImage } from './raw.js';
import type { AssetEntry } from '../manifest.js';

function stripEntry(overrides: Partial<AssetEntry> = {}): AssetEntry {
  return {
    id: 'crop_test_strip',
    provider: 'retro-diffusion',
    width: 80,
    height: 16,
    prompt: 'a plant that grows and dies',
    promptStyle: 'rd_animation__small_sprites',
    anchor: 'top-left',
    atlasGroup: 'crops',
    trim: false,
    frames: 5,
    ...overrides,
  };
}

/** A sheet whose every frame is flood-filled with its own frame index in the red channel. */
function numberedSheet(cols: number, rows: number, frameSize: number): RawImage {
  const width = cols * frameSize;
  const height = rows * frameSize;
  const image: RawImage = { data: Buffer.alloc(width * height * 4), width, height };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const frame = Math.floor(y / frameSize) * cols + Math.floor(x / frameSize);
      const i = (y * width + x) * 4;
      image.data[i] = frame;
      image.data[i + 3] = 255;
    }
  }
  return image;
}

function frameIndexAtCell(strip: RawImage, cellIndex: number, frameSize: number): number {
  return strip.data[(frameSize / 2) * strip.width * 4 + (cellIndex * frameSize + 2) * 4] ?? -1;
}

describe('planAnimation', () => {
  it('over-asks to the nearest allowed count and keeps first four plus the last', () => {
    const plan = planAnimation(stripEntry());
    expect(plan.framesRequested).toBe(6);
    expect(plan.frameSize).toBe(32);
    expect(plan.factor).toBe(2);
    expect(plan.keep).toEqual([0, 1, 2, 3, 5]);
  });

  it('keeps everything when the wanted count is one RD sells', () => {
    const plan = planAnimation(stripEntry({ frames: 4, width: 64 }));
    expect(plan.framesRequested).toBe(4);
    expect(plan.keep).toEqual([0, 1, 2, 3]);
  });

  it('refuses a width that is not frames x cell', () => {
    expect(() => planAnimation(stripEntry({ width: 64 }))).toThrow(/width must be 80/);
  });

  it('refuses a non-animation promptStyle', () => {
    expect(() => planAnimation(stripEntry({ promptStyle: 'rd_fast__default' }))).toThrow(
      /not an animation style/,
    );
  });

  it('refuses more frames than RD tops out at', () => {
    expect(() => planAnimation(stripEntry({ frames: 17, width: 17 * 16 }))).toThrow(/tops out/);
  });
});

describe('reassembleStrip — the deterministic discard rule', () => {
  const plan: AnimationPlan = {
    frames: 5,
    framesRequested: 6,
    frameSize: 32,
    cell: 16,
    factor: 2,
    keep: [0, 1, 2, 3, 5],
  };

  it('slices a single-row sheet and drops the interior surplus frame', () => {
    const sheet = numberedSheet(6, 1, 32);
    const strip = reassembleStrip(sheet, plan, 'crop_test_strip');
    expect(strip.width).toBe(160);
    expect(strip.height).toBe(32);
    expect([0, 1, 2, 3, 4].map((c) => frameIndexAtCell(strip, c, 32))).toEqual([0, 1, 2, 3, 5]);
  });

  it('reads a grid sheet row-major, so the layout RD picks does not matter', () => {
    const sheet = numberedSheet(3, 2, 32);
    const strip = reassembleStrip(sheet, plan, 'crop_test_strip');
    expect([0, 1, 2, 3, 4].map((c) => frameIndexAtCell(strip, c, 32))).toEqual([0, 1, 2, 3, 5]);
  });

  it('refuses a sheet that is not a multiple of the frame size', () => {
    const sheet: RawImage = { data: Buffer.alloc(100 * 32 * 4), width: 100, height: 32 };
    expect(() => reassembleStrip(sheet, plan, 'crop_test_strip')).toThrow(/not a multiple/);
  });

  it('refuses a sheet with fewer cells than frames requested', () => {
    const sheet = numberedSheet(4, 1, 32);
    expect(() => reassembleStrip(sheet, plan, 'crop_test_strip')).toThrow(/6 frame/);
  });

  it('refuses the measured small_sprites disease: a 5x4 character sheet for a 6-frame ask', () => {
    // rd_animation__small_sprites ignores frames_duration and returns twenty cells of an
    // RPG character — walk cycles and a death pose — whatever the prompt says. Slicing the
    // first six cells of that ships four walk frames and a wave, so surplus cells reject.
    const sheet = numberedSheet(5, 4, 32);
    expect(() => reassembleStrip(sheet, plan, 'crop_test_strip')).toThrow(
      /substituted its own animation format/,
    );
  });
});
