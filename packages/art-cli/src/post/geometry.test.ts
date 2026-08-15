import { describe, expect, it } from 'vitest';
import { checkStripGeometry } from './geometry.js';
import type { RawImage } from './raw.js';

/** A transparent strip with opaque blobs painted at the given column ranges. */
function strip(width: number, height: number, blobs: [number, number][]): RawImage {
  const image: RawImage = { data: Buffer.alloc(width * height * 4), width, height };
  for (const [x0, x1] of blobs) {
    for (let x = x0; x <= x1; x++) {
      for (let y = 2; y < height - 2; y++) {
        const i = (y * width + x) * 4;
        image.data[i] = 40;
        image.data[i + 1] = 120;
        image.data[i + 2] = 40;
        image.data[i + 3] = 255;
      }
    }
  }
  return image;
}

describe('checkStripGeometry — the wave-8 transparent-gap cluster gate', () => {
  it('passes a strip with one centred plant per cell', () => {
    // Five 16px cells, plants at columns 4-11 of each cell.
    const image = strip(80, 16, [
      [4, 11],
      [20, 27],
      [36, 43],
      [52, 59],
      [68, 75],
    ]);
    const report = checkStripGeometry(image, 5);
    expect(report.ok).toBe(true);
    expect(report.clusters).toHaveLength(5);
  });

  it('rejects the recorded wave-8 failure shape: plants at the provider pitch, not the cell pitch', () => {
    // The measured disease scaled to strip resolution: asked for five plants on a 16px
    // pitch, the provider drew four on its own ~22px pitch. The third one straddles a
    // cell boundary, which is where a wrong pitch always gets caught.
    const image = strip(80, 16, [
      [2, 12],
      [24, 34],
      [46, 56],
      [68, 78],
    ]);
    const report = checkStripGeometry(image, 5);
    expect(report.ok).toBe(false);
    expect(report.message).toContain('expected 5');
  });

  it('rejects a straddling cluster even when the count is right', () => {
    const image = strip(80, 16, [
      [4, 11],
      [20, 27],
      [36, 43],
      [52, 59],
      [62, 70], // right count, but this one crosses the 64px boundary
    ]);
    const report = checkStripGeometry(image, 5);
    expect(report.ok).toBe(false);
    expect(report.message).toContain('straddles');
  });

  it('rejects an empty cell paired with a doubled one', () => {
    const image = strip(80, 16, [
      [2, 5],
      [9, 13], // two clusters in cell 0
      [20, 27],
      [36, 43],
      [52, 59], // cell 4 empty
    ]);
    const report = checkStripGeometry(image, 5);
    expect(report.ok).toBe(false);
  });

  it('rejects a fully transparent strip', () => {
    const report = checkStripGeometry(strip(80, 16, []), 5);
    expect(report.ok).toBe(false);
    expect(report.message).toContain('fully transparent');
  });

  it('rejects a width that does not divide into the asked cells', () => {
    const report = checkStripGeometry(strip(70, 16, [[4, 11]]), 5);
    expect(report.ok).toBe(false);
  });
});
