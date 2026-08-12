import { existsSync, readFileSync } from 'node:fs';
import { hexOf } from './raw.js';
import { nearestColor, preparePalette } from './quantize.js';
import type { RawImage } from './raw.js';

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
