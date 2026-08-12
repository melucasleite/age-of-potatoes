import type { Anchor } from '../manifest.js';
import type { RawImage } from './raw.js';

interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Tight bounding box of non-transparent pixels, or null if the image is entirely empty. */
function opaqueBounds(image: RawImage): Bounds | null {
  let left = image.width;
  let top = image.height;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if ((image.data[(y * image.width + x) * 4 + 3] ?? 0) === 0) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  return right < 0 ? null : { left, top, right, bottom };
}

/**
 * Trims to content and re-pads to the declared size, positioned by the entry's anchor.
 * `bottom-center` is the one that matters for anything standing on ground: it keeps a
 * sprite's feet on the tile line regardless of how much headroom the generator left.
 */
export function trimAndPad(
  image: RawImage,
  targetWidth: number,
  targetHeight: number,
  anchor: Anchor,
  id: string,
): RawImage {
  const bounds = opaqueBounds(image);
  const out: RawImage = {
    data: Buffer.alloc(targetWidth * targetHeight * 4),
    width: targetWidth,
    height: targetHeight,
  };
  if (!bounds) return out;

  const contentWidth = bounds.right - bounds.left + 1;
  const contentHeight = bounds.bottom - bounds.top + 1;
  if (contentWidth > targetWidth || contentHeight > targetHeight) {
    throw new Error(
      `Asset "${id}" has ${contentWidth}x${contentHeight} of content but is declared ` +
        `${targetWidth}x${targetHeight}. Cropping would lose art — widen the declared size ` +
        `or reroll the generation.`,
    );
  }

  let offsetX: number;
  let offsetY: number;
  switch (anchor) {
    case 'top-left':
      offsetX = 0;
      offsetY = 0;
      break;
    case 'bottom-center':
      offsetX = Math.floor((targetWidth - contentWidth) / 2);
      offsetY = targetHeight - contentHeight;
      break;
    case 'center':
      offsetX = Math.floor((targetWidth - contentWidth) / 2);
      offsetY = Math.floor((targetHeight - contentHeight) / 2);
      break;
  }

  for (let y = 0; y < contentHeight; y++) {
    const src = ((bounds.top + y) * image.width + bounds.left) * 4;
    const dst = ((offsetY + y) * targetWidth + offsetX) * 4;
    image.data.copy(out.data, dst, src, src + contentWidth * 4);
  }
  return out;
}
