import type { AssetEntry } from '../manifest.js';

/**
 * What a provider can do. Post-processing stages read these rather than branching on
 * the provider's name — that is the whole point of the seam. `nativePixelOutput: true`
 * makes grid-snap assert instead of downsample; `supportsPaletteInput: true` makes the
 * palette stage measure instead of remap. See plan §15.
 */
export interface ProviderCapabilities {
  /** Emits true pixel art at the requested size — no grid detection needed. */
  nativePixelOutput: boolean;
  /** Accepts a master palette as a server-side constraint. */
  supportsPaletteInput: boolean;
  supportsTransparency: boolean;
  supportsAnimation: boolean;
  supportsSeed: boolean;
  supportsRefImages: boolean;
  /** Hard ceiling on requested width/height, in pixels. */
  maxDimension: number;
}

export interface GenerateRequest {
  entry: AssetEntry;
  /** Master palette as hex strings, or null when none is configured. */
  palette: readonly string[] | null;
  /** Maps to `check_cost: true` — the request is priced, nothing is spent, no image returns. */
  dryRun: boolean;
  /**
   * Overrides both the manifest's seed and the adapter's default random one.
   *
   * This is what `--reroll` is made of, and it exists because **generation is
   * byte-deterministic on seed** (measured, work item 048): same prompt + style + seed +
   * size returns the identical PNG. So re-running `gen --force` on an unchanged entry pays
   * full price to receive a file it already has, and "give me a different take" is
   * expressible *only* as a different seed.
   */
  seed?: number;
  /**
   * Transport attempts, including the first. Only transport failures are retried — an HTTP
   * error is a deterministic answer and repeating it just costs more.
   */
  attempts?: number;
}

export interface GenerateResult {
  /** PNG buffers. Empty on a dry run. */
  images: Buffer[];
  /** What this call cost, in USD. Zero on a dry run. */
  cost: number;
  /** Account balance after the call, in USD, when the provider reports one. */
  remainingBalance: number | null;
  /** The exact model that produced these pixels — the field that matters the day the vendor dies. */
  model: string;
  /**
   * Pixel size actually requested upstream, which is not always the declared native size —
   * a provider may have a generation floor it has to be scaled past. Recorded in the sidecar
   * so the committed original's dimensions are explained rather than mysterious.
   */
  requested: { width: number; height: number };
  seed: number | null;
  /** The exact prompt sent, after any adapter-side composition. */
  prompt: string;
  promptStyle: string | null;
}

export interface ProviderAdapter {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  generate(request: GenerateRequest): Promise<GenerateResult>;
}

/**
 * Shared dimension guard. Every adapter calls this before building a request body:
 * a 512² request is invalid at every provider we use and, at Retro Diffusion, is
 * quoted happily by `check_cost` before failing at generation time — so the refusal
 * has to happen here.
 */
export function assertNativeSize(entry: AssetEntry, capabilities: ProviderCapabilities): void {
  const { width, height, id } = entry;
  if (width === 512 || height === 512) {
    throw new Error(
      `Asset "${id}" requests ${width}x${height}. 512 is never correct: it exceeds every ` +
        `provider's cap, costs 3-10x more (pricing is by pixel area), and inflates a committed ` +
        `original from ~1 KB to ~300 KB. Declare native sizes — 16, 32, or 48.`,
    );
  }
  const max = capabilities.maxDimension;
  if (width > max || height > max) {
    throw new Error(
      `Asset "${id}" requests ${width}x${height}, above this provider's ${max}px cap. ` +
        `Declare native sizes — 16, 32, or 48.`,
    );
  }
}
