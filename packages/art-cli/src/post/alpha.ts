import type { RawImage } from './raw.js';

/**
 * Alpha is binary or it is nothing. A semi-transparent fringe is precisely what makes an
 * AI sprite read as "AI" — and at 16px a single soft edge pixel is 6% of the sprite.
 * Fully-transparent pixels also get their RGB zeroed so trimming and palette measurement
 * never see colour that nobody can look at.
 */
export function binarizeAlpha(image: RawImage, threshold = 128): RawImage {
  const data = Buffer.from(image.data);
  for (let i = 0; i < data.length; i += 4) {
    const opaque = (data[i + 3] ?? 0) >= threshold;
    data[i + 3] = opaque ? 255 : 0;
    if (!opaque) {
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
    }
  }
  return { ...image, data };
}
