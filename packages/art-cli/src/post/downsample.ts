import { hexOf } from './raw.js';
import type { RawImage } from './raw.js';

/**
 * DORMANT ON RETRO DIFFUSION, and deliberately kept.
 *
 * RD emits true pixel art at the requested size, so `nativePixelOutput: true` routes the
 * grid stage into `verifyNativeGrid` below. This modal-vote downsampler is the transform-mode
 * counterpart for providers that return smooth high-resolution art which merely resembles
 * pixel art — the OpenAI fallback's requirement. Averaging would produce mud; a modal vote
 * per cell picks the colour that actually dominates it and keeps edges hard.
 */
export function modalDownsample(
  image: RawImage,
  targetWidth: number,
  targetHeight: number,
): RawImage {
  const cellW = image.width / targetWidth;
  const cellH = image.height / targetHeight;
  const out: RawImage = {
    data: Buffer.alloc(targetWidth * targetHeight * 4),
    width: targetWidth,
    height: targetHeight,
  };

  for (let ty = 0; ty < targetHeight; ty++) {
    for (let tx = 0; tx < targetWidth; tx++) {
      const votes = new Map<number, number>();
      let opaque = 0;
      let total = 0;

      const x0 = Math.floor(tx * cellW);
      const x1 = Math.max(x0 + 1, Math.floor((tx + 1) * cellW));
      const y0 = Math.floor(ty * cellH);
      const y1 = Math.max(y0 + 1, Math.floor((ty + 1) * cellH));

      for (let y = y0; y < Math.min(y1, image.height); y++) {
        for (let x = x0; x < Math.min(x1, image.width); x++) {
          const i = (y * image.width + x) * 4;
          total++;
          if ((image.data[i + 3] ?? 0) === 0) continue;
          opaque++;
          const key =
            ((image.data[i] ?? 0) << 16) |
            ((image.data[i + 1] ?? 0) << 8) |
            (image.data[i + 2] ?? 0);
          votes.set(key, (votes.get(key) ?? 0) + 1);
        }
      }

      const o = (ty * targetWidth + tx) * 4;
      // A cell that is mostly hole becomes a hole. Anything else votes on colour.
      if (opaque * 2 < total || votes.size === 0) continue;

      let winner = 0;
      let best = -1;
      for (const [key, count] of votes) {
        if (count > best) {
          best = count;
          winner = key;
        }
      }
      out.data[o] = (winner >> 16) & 0xff;
      out.data[o + 1] = (winner >> 8) & 0xff;
      out.data[o + 2] = winner & 0xff;
      out.data[o + 3] = 255;
    }
  }
  return out;
}

export interface GridReport {
  ok: boolean;
  message: string;
  /** Integer ratio of provider output to declared native size. 1 means nothing to reduce. */
  factor: number;
  /** Set when the pixel grid looks like a blurred upscale rather than real pixel art. */
  suspicious: boolean;
}

/**
 * Verify mode, used whenever the provider claims `nativePixelOutput`.
 *
 * "Grid-perfect" cannot mean "exactly the declared size", because Retro Diffusion refuses
 * to *generate* below 64px even though it happily prices 16px (see the adapter). So the
 * assertion is the one that actually matters: the output must be an exact, equal integer
 * multiple of the declared size on both axes. That makes the reduction pure arithmetic —
 * a block decimation — rather than the grid *detection* a non-pixel-art provider forces.
 * Anything else fails loudly.
 *
 * The colour-count heuristic is reported, not enforced: it is a guess about whether the
 * provider blurred, and a guess should not fail a build.
 */
export function verifyNativeGrid(
  image: RawImage,
  expectedW: number,
  expectedH: number,
): GridReport {
  const bad = (message: string): GridReport => ({
    ok: false,
    message,
    factor: 0,
    suspicious: true,
  });

  if (image.width % expectedW !== 0 || image.height % expectedH !== 0) {
    return bad(
      `provider returned ${image.width}x${image.height}, which is not an integer multiple of the ` +
        `declared ${expectedW}x${expectedH}`,
    );
  }
  const factorX = image.width / expectedW;
  const factorY = image.height / expectedH;
  if (factorX !== factorY) {
    return bad(
      `provider returned ${image.width}x${image.height} — ${factorX}x horizontally but ${factorY}x ` +
        `vertically against the declared ${expectedW}x${expectedH}. A non-square ratio would distort.`,
    );
  }

  const colors = new Set<string>();
  for (let i = 0; i < image.data.length; i += 4) {
    if ((image.data[i + 3] ?? 0) === 0) continue;
    colors.add(hexOf(image.data[i] ?? 0, image.data[i + 1] ?? 0, image.data[i + 2] ?? 0));
  }

  // A true pixel grid has at most one colour per *target* pixel, however far it was upscaled.
  const suspicious = colors.size > expectedW * expectedH;
  const scale = factorX === 1 ? 'native' : `${factorX}x oversampled`;
  return {
    ok: true,
    factor: factorX,
    suspicious,
    message:
      `${scale}, ${colors.size} distinct colours` +
      (suspicious ? ' (more than one per target pixel — check for blur)' : ''),
  };
}
