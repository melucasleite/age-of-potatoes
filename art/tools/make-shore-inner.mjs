// Authors art/local/terrain_shore_inner.png — the pond's inner shore corner (item 077).
//
// WHY THIS ONE IS HAND-AUTHORED WHEN ITS TWO SIBLINGS ARE NOT
//
// `terrain_shore_edge` and `terrain_shore_outer` came from Retro Diffusion on the first
// take each and look great — organic waterlines are exactly what a diffusion model is for.
// The inner corner went to RD twice (2026-08-15, $0.034) and came back twice as a floating
// dirt ISLAND in open water — once small, once enormous — never as a wedge anchored into
// the tile corner. That is the measured 16px-technical-geometry failure mode all over again
// (see make-factory-parts.mjs), and the requirement here is genuinely geometric: the dirt
// must touch both the south and east edges all the way into the corner, at the same band
// depth as the edge tile, or the auto-tiled shoreline shows a gap at every concave bend.
// A quarter-arc with an exact radius is arithmetic; arithmetic gets authored.
//
// The vocabulary is the RD siblings': water in the pond's own two shades (water_deep base,
// water_mid grain), a soil_mid/soil_dry dirt wedge, a pale bone-and-sand rim along the
// waterline, two grey stones. All swatches are in the shore set's paletteSubset, so the
// cook stage's quantise is an identity here.
//
// GEOMETRY, for the render lane: the dirt wedge is the quarter disc centred on the tile's
// south-east corner. Dirt occupies radius <= 6, the wet-sand rim 6..8, water beyond —
// matching the edge tile's ~5-6px dirt band plus sand strip, so this tile meets a
// quarter-turned edge tile at both of its land edges. The waterline arc therefore lives at
// a KNOWN radius (8) the way the edge tile's waterline lives near a known row — the mud-ring
// future-proofing note on item 077.

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { loadMaster } from './palette-png.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SIZE = 16;

const { swatches } = loadMaster();
const hexOf = (name) => {
  const found = swatches.find((swatch) => swatch.name === name);
  if (!found) throw new Error(`Master palette has no colour named "${name}".`);
  return found.hex;
};

const DIRT_RADIUS = 6;
const SAND_RADIUS = 8;

/** Deterministic positional hash — cosmetic grain that re-bakes identically every run. */
function grain(x, y) {
  let h = (x * 374761393 + y * 668265263) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = (h * 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

const rows = [];
for (let y = 0; y < SIZE; y++) {
  const row = [];
  for (let x = 0; x < SIZE; x++) {
    const dx = SIZE - 1 - x;
    const dy = SIZE - 1 - y;
    const r = Math.sqrt(dx * dx + dy * dy);
    if (r <= DIRT_RADIUS) {
      // Dirt, in the edge tile's two soil shades.
      row.push(grain(x, y) % 5 === 0 ? 'soil_dry' : 'soil_mid');
    } else if (r <= SAND_RADIUS) {
      // The wet-sand rim: mostly pale, flecked so it is not a hard vector ring.
      row.push(grain(x, y) % 3 === 0 ? 'soil_dry' : 'bone');
    } else {
      // Pond water: the same two close shades terrain_water is made of.
      row.push(grain(x, y) % 7 === 0 ? 'water_mid' : 'water_deep');
    }
  }
  rows.push(row);
}

// Two stones on the dirt, placed by hand where the wedge is widest.
rows[13][13] = 'stone_mid';
rows[13][14] = 'stone_light';
rows[14][11] = 'stone_mid';

// The anchoring guarantee, checked rather than trusted: the corner pixel is dirt, and both
// land edges carry dirt for at least the wedge radius.
if (rows[15][15] === 'water_deep' || rows[15][15] === 'water_mid') {
  throw new Error('terrain_shore_inner: the corner pixel is water — the wedge is not anchored.');
}
for (let i = SIZE - DIRT_RADIUS; i < SIZE; i++) {
  const bottom = rows[15][i];
  const right = rows[i][15];
  for (const got of [bottom, right]) {
    if (got.startsWith('water')) {
      throw new Error(`terrain_shore_inner: land edge shows water at index ${i}.`);
    }
  }
}

const raw = Buffer.alloc(SIZE * SIZE * 4);
rows.forEach((row, y) => {
  row.forEach((name, x) => {
    const hex = hexOf(name);
    const at = (y * SIZE + x) * 4;
    raw[at] = parseInt(hex.slice(1, 3), 16);
    raw[at + 1] = parseInt(hex.slice(3, 5), 16);
    raw[at + 2] = parseInt(hex.slice(5, 7), 16);
    raw[at + 3] = 255;
  });
});

const png = await sharp(raw, { raw: { width: SIZE, height: SIZE, channels: 4 } })
  .png({ palette: false, compressionLevel: 9 })
  .toBuffer();
const out = resolve(HERE, '../local/terrain_shore_inner.png');
writeFileSync(out, png);
console.log(`Wrote art/local/terrain_shore_inner.png — ${SIZE}x${SIZE}, ${png.length} bytes.`);
