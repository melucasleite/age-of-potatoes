// Authors art/local/zone_overlay.png — the tileable hatch that paints a zone's area.
//
// A zone is a PLAN, NOT A MACHINE (plan §5), so its art has to read as an annotation drawn
// over the world rather than a thing standing in it. A 45-degree hatch is the oldest
// notation for "this region is spoken for", and it survives being tinted per zone.
//
// This is hand-authored rather than generated for two reasons, both of which are about
// guarantees rather than money:
//
//   1. IT MUST TILE EXACTLY. A zone is an arbitrary rect, so the overlay is stamped across
//      it and any seam repeats every 16px in a straight line where the eye is guaranteed to
//      find it. `remove_bg` plus `tile_x` is a best effort from a diffusion model; the
//      modulus below is arithmetic. `(x + y) % PERIOD` tiles perfectly in both axes as long
//      as PERIOD divides 16, which is checked at the bottom of this file.
//
//   2. IT MUST HAVE BINARY ALPHA. The cook stage binarises alpha, so a soft 30%-opacity
//      wash would come back fully opaque and cover the field it is annotating. The stripes
//      are therefore fully opaque and the *gaps* fully transparent, and the renderer fades
//      the whole sprite with `alpha` — exactly the trick `soil_wet` already uses.
//
// The stripe colour is `paper`, the palette's lightest value, for the same reason the status
// lamp's core is: a multiply tint lands on the intended hue instead of a muddied one, so one
// sprite serves every zone colour.

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { loadMaster } from './palette-png.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../local/zone_overlay.png');

const SIZE = 16;
/** Stripe pitch. Must divide SIZE or the tile seams. */
const PERIOD = 8;
/** Stripe thickness, in pixels along the diagonal. Three of eight: present, not a blanket. */
const THICKNESS = 3;

if (SIZE % PERIOD !== 0) {
  throw new Error(`Zone hatch period ${PERIOD} does not divide ${SIZE} — the tile would seam.`);
}

const { swatches } = loadMaster();
const stripe = swatches.find((swatch) => swatch.name === 'paper');
if (!stripe) throw new Error('Master palette has no colour named "paper".');

const r = parseInt(stripe.hex.slice(1, 3), 16);
const g = parseInt(stripe.hex.slice(3, 5), 16);
const b = parseInt(stripe.hex.slice(5, 7), 16);

const raw = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    if ((x + y) % PERIOD >= THICKNESS) continue;
    const at = (y * SIZE + x) * 4;
    raw[at] = r;
    raw[at + 1] = g;
    raw[at + 2] = b;
    raw[at + 3] = 255;
  }
}

const png = await sharp(raw, { raw: { width: SIZE, height: SIZE, channels: 4 } })
  .png({ palette: false, compressionLevel: 9 })
  .toBuffer();

writeFileSync(OUT, png);
console.log(`Wrote art/local/zone_overlay.png — ${SIZE}x${SIZE}, ${png.length} bytes.`);
