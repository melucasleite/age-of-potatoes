// Authors art/local/status_lamp.png — the one status lamp, tinted per state in code.
//
// This is a script rather than a pixel-editor file on purpose. Plan §10.4 bans hand-touched
// sprites because they cannot be reproduced the next time the style moves; four pixels
// written by code are reproducible by definition, and cost nothing. Asking a diffusion model
// for a 4x4 dot would cost real money from a very small balance and get back a worse dot.
//
// Plan §13: ONE sprite multiplied by a lamp colour, not five coloured lamps. Thirty machines
// animate their state for the cost of a single frame. The core is `paper`, the palette's
// lightest value, so a multiply tint lands on the intended hue instead of a muddied one.

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { loadMaster } from './palette-png.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../local/status_lamp.png');

// A rounded 4x4 bead: ink rim, bright core, one shaded pixel low-right so it reads as a lens
// rather than a square. '.' is transparent.
const PIXELS = ['.oo.', 'oPPo', 'oPBo', '.oo.'];

const ROLES = { o: 'ink', P: 'paper', B: 'bone' };

const { swatches } = loadMaster();
const hexOf = (name) => {
  const found = swatches.find((swatch) => swatch.name === name);
  if (!found) throw new Error(`Master palette has no colour named "${name}".`);
  return found.hex;
};

const width = PIXELS[0].length;
const height = PIXELS.length;
const raw = Buffer.alloc(width * height * 4);

PIXELS.forEach((row, y) => {
  [...row].forEach((glyph, x) => {
    if (glyph === '.') return;
    const role = ROLES[glyph];
    if (!role) throw new Error(`Unknown glyph "${glyph}" in the lamp bitmap.`);
    const hex = hexOf(role);
    const at = (y * width + x) * 4;
    raw[at] = parseInt(hex.slice(1, 3), 16);
    raw[at + 1] = parseInt(hex.slice(3, 5), 16);
    raw[at + 2] = parseInt(hex.slice(5, 7), 16);
    raw[at + 3] = 255;
  });
});

const png = await sharp(raw, { raw: { width, height, channels: 4 } })
  .png({ palette: false, compressionLevel: 9 })
  .toBuffer();

writeFileSync(OUT, png);
console.log(`Wrote art/local/status_lamp.png — ${width}x${height}, ${png.length} bytes.`);
