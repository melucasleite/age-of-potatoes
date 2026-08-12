import { binarizeAlpha } from './alpha.js';
import { modalDownsample, verifyNativeGrid } from './downsample.js';
import { measureConformance } from './palette.js';
import { quantizeToPalette } from './quantize.js';
import { decode, encode } from './raw.js';
import { trimAndPad } from './trim.js';
import type { GridReport } from './downsample.js';
import type { PaletteReport } from './palette.js';
import type { RawImage } from './raw.js';
import type { AssetEntry } from '../manifest.js';
import type { ProviderCapabilities } from '../providers/types.js';

export interface CookResult {
  image: RawImage;
  png: Buffer;
  grid: GridReport;
  palette: PaletteReport;
}

/**
 * The single post-processing path every original travels, whatever produced it.
 *
 * Both branch points read capability flags rather than the provider's name — that is the
 * entire reason for the adapter seam. On Retro Diffusion both stages collapse to assertions;
 * on a provider that returns smooth high-res art they do real work, with no change here.
 */
export async function cook(
  original: Buffer,
  entry: AssetEntry,
  capabilities: ProviderCapabilities,
  palette: readonly string[] | null,
): Promise<CookResult> {
  let image = await decode(original);

  let grid: GridReport;
  if (capabilities.nativePixelOutput) {
    grid = verifyNativeGrid(image, entry.width, entry.height);
    if (!grid.ok) {
      throw new Error(
        `Asset "${entry.id}": the provider claims native pixel output but ${grid.message}. ` +
          `The original is still on disk — reroll it or fix the declared size rather than ` +
          `resampling here.`,
      );
    }
    // An exact integer factor makes this a block decimation, not a resample: every target
    // pixel is one aligned block, and the modal vote inside it is exact when the block is
    // uniform. Committed originals stay at the provider's full output for that reason —
    // improving this step later must not require re-buying the art.
    if (grid.factor > 1) image = modalDownsample(image, entry.width, entry.height);
  } else {
    image = modalDownsample(image, entry.width, entry.height);
    grid = {
      ok: true,
      factor: 0,
      suspicious: false,
      message: `modal-downsampled to ${entry.width}x${entry.height}`,
    };
  }

  image = binarizeAlpha(image);
  image = trimAndPad(image, entry.width, entry.height, entry.anchor, entry.id);

  if (!capabilities.supportsPaletteInput && palette) {
    image = quantizeToPalette(image, palette);
  }
  const paletteReport = measureConformance(image, palette);

  return { image, png: await encode(image), grid, palette: paletteReport };
}
