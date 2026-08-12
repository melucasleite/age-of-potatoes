import sharp from 'sharp';
import { requireSecret } from '../env.js';
import { assertNativeSize } from './types.js';
import type {
  GenerateRequest,
  GenerateResult,
  ProviderAdapter,
  ProviderCapabilities,
} from './types.js';

const ENDPOINT = 'https://api.retrodiffusion.ai/v1/inferences';
const TOKEN_VAR = 'RETRODIFFUSION_API_KEY';
const DEFAULT_STYLE = 'rd_fast__default';

/**
 * RD Plus/Fast cap at 384px and Pro at 256px. 384 is the ceiling this adapter enforces;
 * every asset in this project is 16-48px anyway, so the cap only ever catches mistakes.
 */
const MAX_DIMENSION = 384;

/**
 * ...and a *floor* of 64, which is not in any plan and cost real money to find.
 *
 * Verified against the live API on 2026-08-12: `check_cost` prices 16, 24, 32 and 48px
 * requests happily and identically ($0.017, flat all the way up to 64px), but a real
 * inference at any of those sizes returns 400 `inference_failed`. Only 64px and above
 * actually generate. `check_cost` validates almost nothing — treat it as a price quote,
 * never as a request validator.
 *
 * The plan's cost argument is untouched by this: pricing is by pixel area and flat below
 * 64px, so 64 sits at exactly the same price floor 16 would have. What changes is the
 * mechanism — asking for a native 16px sprite is not a thing RD can do, so we ask for the
 * smallest exact integer multiple that clears the floor and let the grid stage decimate.
 */
const MIN_DIMENSION = 64;

export interface SizePlan {
  width: number;
  height: number;
  /** Integer oversampling factor the cook stage must undo. 1 when the request needs no scaling. */
  factor: number;
}

/**
 * Smallest integer multiple of the declared size that clears RD's generation floor.
 * 16 -> 64 (4x), 32 -> 64 (2x), 48 -> 96 (2x), 64 -> 64 (1x).
 *
 * An integer multiple, rather than simply "64", is what keeps the reduction exact: every
 * target pixel maps to one aligned block, so nothing has to guess where the grid is.
 */
export function planSize(width: number, height: number): SizePlan {
  let factor = 1;
  while (width * factor < MIN_DIMENSION || height * factor < MIN_DIMENSION) factor++;
  return { width: width * factor, height: height * factor, factor };
}

const CAPABILITIES: ProviderCapabilities = {
  nativePixelOutput: true,
  supportsPaletteInput: true,
  supportsTransparency: true,
  supportsAnimation: true,
  supportsSeed: true,
  supportsRefImages: true,
  maxDimension: MAX_DIMENSION,
};

interface RetroDiffusionResponse {
  base64_images?: string[];
  balance_cost?: number;
  remaining_balance?: number;
  model?: string;
}

/**
 * `input_palette` is sent as a base64 PNG, not a colour list: one pixel per colour in a
 * 1xN strip. Encoded losslessly with no palette quantisation, because a re-quantised
 * palette image would constrain generation to colours that are not quite the master set.
 */
async function encodePalette(colors: readonly string[]): Promise<string> {
  const raw = Buffer.alloc(colors.length * 3);
  colors.forEach((hex, i) => {
    const clean = hex.replace('#', '');
    raw[i * 3] = parseInt(clean.slice(0, 2), 16);
    raw[i * 3 + 1] = parseInt(clean.slice(2, 4), 16);
    raw[i * 3 + 2] = parseInt(clean.slice(4, 6), 16);
  });
  const png = await sharp(raw, { raw: { width: colors.length, height: 1, channels: 3 } })
    .png({ palette: false })
    .toBuffer();
  return png.toString('base64');
}

export function createRetroDiffusionAdapter(): ProviderAdapter {
  return {
    name: 'retro-diffusion',
    capabilities: CAPABILITIES,

    async generate(request: GenerateRequest): Promise<GenerateResult> {
      const { entry, palette, dryRun } = request;
      assertNativeSize(entry, CAPABILITIES);

      // Work item 005: a palette you can forget to pass is a palette that drifts. The whole
      // consistency strategy rests on `input_palette` going out on every call forever, so a
      // missing one is a hard refusal rather than a quietly unconstrained generation.
      if (!palette || palette.length === 0) {
        throw new Error(
          `Refusing to generate "${entry.id}" with no input_palette. Point "palette" in ` +
            `art/manifest.json at art/palette/master.json — generating without it produces ` +
            `off-palette art that the gate will reject anyway.`,
        );
      }

      const plan = planSize(entry.width, entry.height);
      if (plan.width > MAX_DIMENSION || plan.height > MAX_DIMENSION) {
        throw new Error(
          `Asset "${entry.id}" is ${entry.width}x${entry.height}, which has to be requested at ` +
            `${plan.width}x${plan.height} to clear Retro Diffusion's ${MIN_DIMENSION}px floor — ` +
            `above the ${MAX_DIMENSION}px cap. Declare a smaller native size.`,
        );
      }

      const token = requireSecret(TOKEN_VAR);
      const promptStyle = entry.promptStyle ?? DEFAULT_STYLE;
      // A seed is always recorded, even when the manifest declares none — without one,
      // "regenerate this one slightly warmer" is a coin flip rather than an edit.
      const seed = entry.seed ?? Math.floor(Math.random() * 2 ** 31);

      const body: Record<string, unknown> = {
        prompt: entry.prompt,
        prompt_style: promptStyle,
        width: plan.width,
        height: plan.height,
        num_images: 1,
        seed,
        remove_bg: entry.removeBg ?? true,
        tile_x: entry.tileX ?? false,
        tile_y: entry.tileY ?? false,
        return_spritesheet: false,
      };
      if (dryRun) body.check_cost = true;
      if (palette && palette.length > 0) body.input_palette = await encodePalette(palette);

      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'X-RD-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500);
        throw new Error(
          `Retro Diffusion returned ${response.status} for "${entry.id}" at ` +
            `${plan.width}x${plan.height}: ${detail}\n` +
            `(500 is usually an unknown prompt_style — "${promptStyle}". 400 inference_failed on ` +
            `a request check_cost priced happily is usually a size below the ${MIN_DIMENSION}px floor.)`,
        );
      }

      const payload = (await response.json()) as RetroDiffusionResponse;
      const images = (payload.base64_images ?? []).map((b64) => Buffer.from(b64, 'base64'));

      if (!dryRun && images.length === 0) {
        throw new Error(
          `Retro Diffusion returned no images for "${entry.id}" despite a 200. Nothing was written.`,
        );
      }

      return {
        images,
        // On a dry run this is the projected cost and nothing was spent; on a real run it
        // is what was actually charged. The caller knows which, and labels its output.
        cost: payload.balance_cost ?? 0,
        remainingBalance: payload.remaining_balance ?? null,
        model: payload.model ?? 'unknown',
        requested: { width: plan.width, height: plan.height },
        seed,
        prompt: entry.prompt,
        promptStyle,
      };
    },
  };
}
