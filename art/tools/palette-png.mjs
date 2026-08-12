// Renders art/palette/master.json to art/palette/master.png as a grid of swatches.
//
// It exists as a script rather than a one-off export so the PNG cannot drift from the JSON:
// `node art/tools/verify-palette.mjs` re-renders in memory and fails if the committed PNG
// disagrees. A reference image that quietly stops matching the palette it documents is
// worse than no reference image.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ART_DIR = resolve(HERE, '..');
export const MASTER_JSON = resolve(ART_DIR, 'palette/master.json');
export const MASTER_PNG = resolve(ART_DIR, 'palette/master.png');

const SWATCH = 16;
const COLUMNS = 8;

/** Loads the master palette, validating the shape work item 005 promises downstream code. */
export function loadMaster(path = MASTER_JSON) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const { colors, swatches } = parsed;

  if (!Array.isArray(colors)) throw new Error(`${path}: "colors" must be an array.`);
  if (colors.length < 32 || colors.length > 48) {
    throw new Error(`${path}: has ${colors.length} colours; the master palette must hold 32-48.`);
  }
  colors.forEach((hex, i) => {
    if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/.test(hex)) {
      throw new Error(`${path}: colors[${i}] is ${JSON.stringify(hex)}, not a lowercase #rrggbb.`);
    }
  });

  const duplicates = colors.filter((hex, i) => colors.indexOf(hex) !== i);
  if (duplicates.length > 0) {
    throw new Error(`${path}: duplicate colour(s) ${[...new Set(duplicates)].join(', ')}.`);
  }

  // Every colour must carry a name and a role note — prompts and code refer to them by name,
  // and an unnamed swatch is one nobody can deliberately reach for.
  if (!Array.isArray(swatches) || swatches.length !== colors.length) {
    throw new Error(`${path}: "swatches" must describe all ${colors.length} colours.`);
  }
  swatches.forEach((swatch, i) => {
    if (swatch?.hex !== colors[i]) {
      throw new Error(`${path}: swatches[${i}].hex is ${swatch?.hex}, expected ${colors[i]}.`);
    }
    if (!swatch.name || !swatch.role) {
      throw new Error(`${path}: swatches[${i}] (${swatch.hex}) is missing a name or a role note.`);
    }
  });

  return { colors, swatches, name: parsed.name };
}

/** One opaque swatch per colour, row-major. No text: bitmap fonts are a runtime concern. */
export async function renderPalettePng(colors) {
  const rows = Math.ceil(colors.length / COLUMNS);
  const width = COLUMNS * SWATCH;
  const height = rows * SWATCH;
  const raw = Buffer.alloc(width * height * 4);

  colors.forEach((hex, i) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const originX = (i % COLUMNS) * SWATCH;
    const originY = Math.floor(i / COLUMNS) * SWATCH;
    for (let y = 0; y < SWATCH; y++) {
      for (let x = 0; x < SWATCH; x++) {
        const at = ((originY + y) * width + originX + x) * 4;
        raw[at] = r;
        raw[at + 1] = g;
        raw[at + 2] = b;
        raw[at + 3] = 255;
      }
    }
  });

  // palette: false everywhere, per the pipeline's standing rule — libimagequant would pick
  // its own colours and hand back near-misses of the exact palette this file documents.
  return sharp(raw, { raw: { width, height, channels: 4 } })
    .png({ palette: false, compressionLevel: 9 })
    .toBuffer();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { colors, name } = loadMaster();
  const png = await renderPalettePng(colors);
  writeFileSync(MASTER_PNG, png);
  console.log(`Wrote art/palette/master.png — ${colors.length} colours of "${name}".`);
}
