import { existsSync, readFileSync } from 'node:fs';
import { hexOf } from './raw.js';
import { nearestColor, preparePalette } from './quantize.js';
import type { RawImage } from './raw.js';
import type { AssetEntry } from '../manifest.js';

export interface OffPaletteColor {
  hex: string;
  pixels: number;
  /** Closest master-palette colour, so a report reads as an edit rather than a complaint. */
  nearest: string;
}

export interface PaletteReport {
  /** False when no palette is configured — measurement was skipped, not passed. */
  measured: boolean;
  offPalette: OffPaletteColor[];
  totalOffPixels: number;
}

/**
 * Measure mode. RD applies the palette server-side, so all that remains locally is to
 * report drift — and only to report it. Turning a non-empty report into a failed build is
 * work item 005's CI gate; building it here too would mean two gates disagreeing.
 */
export function measureConformance(
  image: RawImage,
  colors: readonly string[] | null,
): PaletteReport {
  if (!colors || colors.length === 0) {
    return { measured: false, offPalette: [], totalOffPixels: 0 };
  }

  const allowed = new Set(colors.map((hex) => hex.toLowerCase()));
  const palette = preparePalette(colors);
  const counts = new Map<string, number>();

  for (let i = 0; i < image.data.length; i += 4) {
    if ((image.data[i + 3] ?? 0) === 0) continue;
    const hex = hexOf(image.data[i] ?? 0, image.data[i + 1] ?? 0, image.data[i + 2] ?? 0);
    if (allowed.has(hex)) continue;
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }

  const offPalette: OffPaletteColor[] = [...counts.entries()]
    .map(([hex, pixels]) => {
      const [r, g, b] = [
        parseInt(hex.slice(1, 3), 16),
        parseInt(hex.slice(3, 5), 16),
        parseInt(hex.slice(5, 7), 16),
      ];
      return { hex, pixels, nearest: nearestColor(r, g, b, palette).hex };
    })
    .sort((a, b) => b.pixels - a.pixels);

  return {
    measured: true,
    offPalette,
    totalOffPixels: offPalette.reduce((sum, entry) => sum + entry.pixels, 0),
  };
}

/** Loads a palette file: `{ "colors": ["#rrggbb", ...] }` or a bare array of hex strings. */
export function loadPalette(path: string): string[] {
  if (!existsSync(path)) {
    throw new Error(`Palette file not found at ${path} (referenced by art/manifest.json).`);
  }
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const raw = Array.isArray(parsed) ? parsed : (parsed as { colors?: unknown }).colors;
  if (!Array.isArray(raw)) {
    throw new Error(`Palette ${path} must be an array of hex colours or { "colors": [...] }.`);
  }
  return raw.map((entry, i) => {
    if (typeof entry !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(entry)) {
      throw new Error(`Palette ${path} entry ${i} is not a "#rrggbb" hex colour.`);
    }
    return entry.toLowerCase();
  });
}

export interface Swatch {
  hex: string;
  name: string;
  ramp: string;
}

/**
 * The named swatches, when the palette file carries them. A bare array of hexes has none,
 * and that is not an error — it only means `paletteSubset` cannot be used against it.
 */
export function loadSwatches(path: string): Swatch[] {
  if (!existsSync(path)) return [];
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (Array.isArray(parsed)) return [];
  const raw = (parsed as { swatches?: unknown }).swatches;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const swatch = entry as Record<string, unknown>;
    if (typeof swatch.hex !== 'string' || typeof swatch.name !== 'string') return [];
    return [
      {
        hex: swatch.hex.toLowerCase(),
        name: swatch.name,
        ramp: typeof swatch.ramp === 'string' ? swatch.ramp : '',
      },
    ];
  });
}

/**
 * Narrows the master palette to the colours one asset is allowed to quantise into.
 *
 * WHY THIS EXISTS, which is the part worth reading before deleting it.
 *
 * `quantizeToPalette` finds the nearest colour in Oklab. Oklab knows about perception; it
 * knows nothing about *roles*. The master palette assigns roles in prose — `lamp_running`
 * is documented as "deliberately more saturated and lighter than every grass green so a
 * lamp never reads as foliage", and `ink` as the darkest value in the game, reserved for
 * sprite outlines — and the nearest-colour search cheerfully ignores every word of it.
 *
 * Measured, not theorised: the first grass tile came back **46% `lamp_running`**, because
 * that swatch is genuinely the closest match to a bright saturated green and nothing
 * stopped it winning. The first tilled-soil tile came back **35% `ink`**, so the ground
 * was built from the same value as the outlines that have to read against it, plus a
 * scatter of `red_deep` for good measure. Both tiles were on-palette. Both were wrong, and
 * the palette gate passed them, because "on the master palette" and "using the colours
 * this thing is supposed to be made of" are different claims.
 *
 * A subset makes the second claim checkable. Naming three swatches for the grass tile
 * bounds its contrast *by construction* rather than by hoping the prompt lands: the field
 * cannot be noisier than the values it is allowed to contain. That is also why the subset
 * is sent upstream as `input_palette` — guiding generation toward those colours is free
 * and strictly better than snapping to them after the fact.
 *
 * Accepts swatch names (`"leaf_mid"`) and whole ramps (`"ramp:grass"`). Names rather than
 * hexes so a manifest entry states its intent and an unknown name fails loudly.
 */
export function resolvePaletteSubset(
  spec: readonly string[],
  swatches: readonly Swatch[],
  assetId: string,
): string[] {
  if (swatches.length === 0) {
    throw new Error(
      `Asset "${assetId}" declares a paletteSubset, but the configured palette file has no ` +
        `named "swatches". Point art/manifest.json at a palette that names its colours.`,
    );
  }

  const byName = new Map(swatches.map((swatch) => [swatch.name, swatch.hex]));
  const resolved: string[] = [];

  for (const token of spec) {
    if (token.startsWith('ramp:')) {
      const ramp = token.slice('ramp:'.length);
      const hits = swatches.filter((swatch) => swatch.ramp === ramp).map((swatch) => swatch.hex);
      if (hits.length === 0) {
        const ramps = [...new Set(swatches.map((swatch) => swatch.ramp))].filter(Boolean);
        throw new Error(
          `Asset "${assetId}" asks for palette ramp "${ramp}", which the palette does not ` +
            `define. Known ramps: ${ramps.join(', ')}.`,
        );
      }
      resolved.push(...hits);
      continue;
    }
    const hex = byName.get(token);
    if (!hex) {
      throw new Error(
        `Asset "${assetId}" asks for palette colour "${token}", which the palette does not ` +
          `name. Use a swatch name from art/palette/master.json, or "ramp:<name>".`,
      );
    }
    resolved.push(hex);
  }

  const unique = [...new Set(resolved)];
  if (unique.length === 0) {
    throw new Error(`Asset "${assetId}" declares an empty paletteSubset.`);
  }
  return unique;
}

/**
 * The palette, its names, and the per-asset narrowing — loaded once and shared by `gen`,
 * `pack` and `review` so all three agree about what an asset is allowed to be made of.
 *
 * `gen` needs it too, and that is the point rather than an afterthought: sending the subset
 * upstream as `input_palette` steers generation toward those colours instead of merely
 * snapping to them afterwards, and steering costs nothing.
 */
export interface PaletteContext {
  /** The master palette. Conformance is always measured against this. */
  colors: string[] | null;
  swatches: Swatch[];
  /** The colours one asset may use, or null when it may use the whole master palette. */
  subsetFor(entry: AssetEntry): string[] | null;
}

export function loadPaletteContext(path: string | null): PaletteContext {
  const colors = path ? loadPalette(path) : null;
  const swatches = path ? loadSwatches(path) : [];
  const cache = new Map<string, string[]>();

  return {
    colors,
    swatches,
    subsetFor(entry: AssetEntry): string[] | null {
      if (!entry.paletteSubset || entry.paletteSubset.length === 0) return null;
      const hit = cache.get(entry.id);
      if (hit) return hit;
      const resolved = resolvePaletteSubset(entry.paletteSubset, swatches, entry.id);
      cache.set(entry.id, resolved);
      return resolved;
    },
  };
}
