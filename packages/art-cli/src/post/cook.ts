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
  // A strip opts out: by this point the image is already exactly the declared size, and
  // trimming it to its overall opaque bounds would re-centre the whole strip, sliding every
  // frame off its cell boundary. Anchoring is per-sprite and a strip is not one sprite.
  if (entry.trim !== false) {
    image = trimAndPad(image, entry.width, entry.height, entry.anchor, entry.id);
  }

  // The remap runs whenever a palette is configured, whatever the provider claims.
  //
  // This used to be gated on `!capabilities.supportsPaletteInput`, on the assumption that RD
  // applying `input_palette` server-side made the result exact. Measured on the first real
  // generation run (2026-08-12): it does not. Every one of 1312 drifted pixels across ten
  // assets was exactly -1 in the red channel — RD lands within 1/255 of the palette and
  // stops there. Near-misses that look fine and fail an exact-match gate are the precise
  // hazard this pipeline already refuses to tolerate from pngquant; arriving from the
  // provider instead does not make them acceptable.
  //
  // So `supportsPaletteInput` now means what it says — whether the palette is worth *sending*
  // upstream to guide generation — and not whether the output may skip being snapped to it.
  // On RD the snap is a 1-level move and visually a no-op; it is what makes the gate binary.
  if (palette) {
    image = quantizeToPalette(image, palette);
  }
  const paletteReport = measureConformance(image, palette);

  return { image, png: await encode(image), grid, palette: paletteReport };
}
