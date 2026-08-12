import { parseHex } from './raw.js';
import type { RawImage } from './raw.js';

/**
 * RUNS ON EVERY PROVIDER, including Retro Diffusion.
 *
 * This was documented as dormant on RD, on the theory that `input_palette` is applied
 * server-side and therefore exactly. The first real generation run disproved it: RD lands
 * within 1/255 of the palette — every drifted colour was exactly -1 in the red channel —
 * which is close enough to look correct and far enough to fail an exact-match gate. See the
 * note in cook.ts. It remains the transform-mode workhorse the OpenAI fallback adapter will
 * need on the day RD is deprecated, and is now load-bearing on the RD path as well.
 *
 * Nearest-colour matching happens in Oklab rather than RGB because RGB distance disagrees
 * with human vision badly enough to swap a sprite's shading ramp for its highlight.
 */
export interface Oklab {
  L: number;
  a: number;
  b: number;
}

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

export function rgbToOklab(r: number, g: number, b: number): Oklab {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);

  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);

  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

export interface PaletteLab {
  hex: string;
  rgb: [number, number, number];
  lab: Oklab;
}

export function preparePalette(colors: readonly string[]): PaletteLab[] {
  return colors.map((hex) => {
    const rgb = parseHex(hex);
    return { hex, rgb, lab: rgbToOklab(rgb[0], rgb[1], rgb[2]) };
  });
}

/** Nearest palette entry in Oklab. Used both to remap (here) and to explain drift (palette.ts). */
export function nearestColor(
  r: number,
  g: number,
  b: number,
  palette: readonly PaletteLab[],
): PaletteLab {
  const target = rgbToOklab(r, g, b);
  let best = palette[0];
  let bestDistance = Infinity;
  for (const candidate of palette) {
    const dL = target.L - candidate.lab.L;
    const da = target.a - candidate.lab.a;
    const db = target.b - candidate.lab.b;
    const distance = dL * dL + da * da + db * db;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  if (!best) throw new Error('Cannot quantize against an empty palette.');
  return best;
}

/** Transform mode: hard-maps every opaque pixel onto the master palette, on the raw buffer. */
export function quantizeToPalette(image: RawImage, colors: readonly string[]): RawImage {
  const palette = preparePalette(colors);
  const data = Buffer.from(image.data);
  const memo = new Map<number, [number, number, number]>();

  for (let i = 0; i < data.length; i += 4) {
    if ((data[i + 3] ?? 0) === 0) continue;
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const key = (r << 16) | (g << 8) | b;

    let mapped = memo.get(key);
    if (!mapped) {
      mapped = nearestColor(r, g, b, palette).rgb;
      memo.set(key, mapped);
    }
    data[i] = mapped[0];
    data[i + 1] = mapped[1];
    data[i + 2] = mapped[2];
  }
  return { ...image, data };
}
