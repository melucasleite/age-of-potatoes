import { readFileSync, existsSync } from 'node:fs';
import { resolveArtPath } from '../manifest.js';
import { assertNativeSize } from './types.js';
import type {
  GenerateRequest,
  GenerateResult,
  ProviderAdapter,
  ProviderCapabilities,
} from './types.js';

/**
 * A hand-authored PNG read off disk. First-class per plan §15, not a fallback: it flows
 * through the identical post-processing, packing, and typed-manifest path, which is what
 * makes hand-drawing one sprite a normal thing to do rather than an escape hatch.
 *
 * `supportsPaletteInput: false` is the interesting flag — it routes the palette stage
 * into remap mode, exercising the same code the OpenAI fallback adapter will need.
 */
const CAPABILITIES: ProviderCapabilities = {
  nativePixelOutput: true,
  supportsPaletteInput: false,
  supportsTransparency: true,
  supportsAnimation: false,
  supportsSeed: false,
  supportsRefImages: false,
  maxDimension: 4096,
};

export function createLocalAdapter(): ProviderAdapter {
  return {
    name: 'local',
    capabilities: CAPABILITIES,

    async generate(request: GenerateRequest): Promise<GenerateResult> {
      const { entry, dryRun } = request;
      assertNativeSize(entry, CAPABILITIES);

      if (!entry.source) {
        throw new Error(`Asset "${entry.id}" uses provider "local" but declares no "source".`);
      }
      const path = resolveArtPath(entry.source);
      if (!existsSync(path)) {
        throw new Error(
          `Asset "${entry.id}" declares source "${entry.source}", missing at ${path}`,
        );
      }

      return {
        images: dryRun ? [] : [readFileSync(path)],
        cost: 0,
        remainingBalance: null,
        model: `local:${entry.source}`,
        requested: { width: entry.width, height: entry.height },
        seed: null,
        prompt: entry.prompt,
        promptStyle: null,
      };
    },
  };
}
