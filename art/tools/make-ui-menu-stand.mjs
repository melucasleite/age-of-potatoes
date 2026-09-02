// Authors art/local/ui_menu_stand.png — the sidebar's "The Stand" icon.
//
// WHY THIS ONE MENU ICON IS HAND-AUTHORED AND THE OTHER FIVE ARE NOT
//
// The sidebar draws every `ui_menu_*` frame at a QUARTER of its 64px art — 16 device pixels
// (`ROW_ICON` in hud/PanelFrame.tsx). The five Retro Diffusion icons survive that because each
// is one bold object: a hammer, a bag, a truck, a book, a tile. The stand came back as a
// SCENE — awning, posts, counter, a heap of produce, a signboard — drawn at the model's own
// 64px detail, and a scene decimated 4:1 is a brown smudge with a red stripe on top. Two paid
// rerolls buy two more scenes; the prompt cannot make RD compose for a quarter-size read.
//
// So the geometry is authored on a 16x16 grid and scaled 4:1, which means the pixels the
// player actually sees ARE the pixels drawn here — nothing is decimated, nothing is voted.
// It is the same reasoning make-factory-parts.mjs and make-status-lamp.mjs already made
// for belts and lamps, one rung up: the sprite's correctness is "reads at 16px", and that is
// a property you can only guarantee by drawing at 16px.
//
// THE PICTURE. Three bands, top to bottom, each the simplest shape that still says "stand":
//
//   awning   seven 2px stripes, red / bone / red …, with a shaded bottom row and an ink
//            hem — the striped awning is the one feature every roadside stand shares
//   produce  three items sitting on the counter: red, gold, green. Three DIFFERENT
//            hues rather than a heap of one, so it reads as "goods for sale" and not as a
//            box. Each wears one highlight pixel on its top-left, the way RD's items do
//   counter  a wood plank front with a lit top edge and a shadow row, on two stubby legs
//
// The two wooden posts join the awning to the counter so the silhouette is one object, not
// three stacked ones — a menu row has no room for a picture that falls apart.

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { loadMaster } from './palette-png.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The atlas frame is 64px, like its five siblings; the drawing is 16px. */
const SIZE = 64;
const GRID = 16;
const SCALE = SIZE / GRID;

/** Glyph → master palette swatch name. `.` is transparent. */
const ROLES = {
  K: 'ink',
  R: 'red_bright',
  E: 'red_mid',
  p: 'red_pale',
  B: 'bone',
  b: 'stone_light',
  L: 'wood_light',
  W: 'wood_mid',
  D: 'wood_dark',
  G: 'tater_mid',
  g: 'chip_gold',
  F: 'leaf_mid',
  f: 'leaf_pale',
};

/**
 * The stand, 16 rows of 16 glyphs. Columns 0..15 left to right, row 0 at the top.
 *
 * The awning's stripe pitch is 2px across the 14 interior columns — seven stripes, red at
 * both ends, so the band is symmetric and the hem below it is one straight ink line. The
 * items occupy the 12 columns between the posts exactly and SHARE their outlines — one ink
 * column between neighbours, never two — which is what keeps the middle band from reading
 * as three dots in a cage. The gold one in the middle is the widest: it is the potato.
 */
const ROWS = [
  '.KKKKKKKKKKKKKK.', // 0  awning top
  'KRRBBRRBBRRBBRRK', // 1  stripes
  'KRRBBRRBBRRBBRRK', // 2  stripes
  'KEEbbEEbbEEbbEEK', // 3  stripes, shaded
  'KKKKKKKKKKKKKKKK', // 4  hem
  'KDKKK..KK..KKKDK', // 5  posts, and the rounded tops of the three items
  'KDKpRKKgGKKfFKDK', // 6  items, one highlight pixel each at top-left; the potato's shoulders
  'KDKRRKGGGGKFFKDK', // 7  items
  'KDKRRKGGGGKFFKDK', // 8  items
  'KKKKKKKKKKKKKKKK', // 9  counter top edge
  'KLLLLLLLLLLLLLLK', // 10 lit plank
  'KWWWWWWWWWWWWWWK', // 11 plank
  'KDDDDDDDDDDDDDDK', // 12 shadow under the lip
  'KKKKKKKKKKKKKKKK', // 13 counter bottom edge
  '.KDK........KDK.', // 14 legs
  '.KKK........KKK.', // 15 feet
];

const { swatches } = loadMaster();
const hexOf = (name) => {
  const found = swatches.find((swatch) => swatch.name === name);
  if (!found) throw new Error(`Master palette has no colour named "${name}".`);
  return found.hex;
};

// --- the guarantees, asserted rather than eyeballed --------------------------------------

if (ROWS.length !== GRID) throw new Error(`Expected ${GRID} rows, found ${ROWS.length}.`);
ROWS.forEach((row, y) => {
  if (row.length !== GRID) {
    throw new Error(`Row ${y} is ${row.length} glyphs wide; the grid is ${GRID}.`);
  }
  for (const glyph of row) {
    if (glyph !== '.' && !(glyph in ROLES)) {
      throw new Error(`Row ${y} uses "${glyph}", which names no palette role.`);
    }
  }
});

/**
 * Left-right symmetry of the SILHOUETTE. The icon sits centred in a 16px box; a lopsided
 * outline reads as a mistake at that size, and mirroring is a property arithmetic can check.
 * Only the opaque/transparent mask is mirrored — the stripes and items are coloured
 * asymmetrically on purpose.
 */
ROWS.forEach((row, y) => {
  for (let x = 0; x < GRID / 2; x++) {
    const left = row[x] === '.';
    const right = row[GRID - 1 - x] === '.';
    if (left !== right) {
      throw new Error(`Row ${y} silhouette is not mirror-symmetric at column ${x}.`);
    }
  }
});

/** Every opaque pixel that touches transparency is ink: the outline is closed. */
ROWS.forEach((row, y) => {
  for (let x = 0; x < GRID; x++) {
    if (row[x] === '.' || row[x] === 'K') continue;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = x + dx;
      const ny = y + dy;
      const outside = nx < 0 || ny < 0 || nx >= GRID || ny >= GRID;
      if (outside || ROWS[ny][nx] === '.') {
        throw new Error(`Pixel (${x}, ${y}) "${row[x]}" faces transparency with no ink outline.`);
      }
    }
  }
});

// --- emit ---------------------------------------------------------------------------------

const raw = Buffer.alloc(SIZE * SIZE * 4);
ROWS.forEach((row, gy) => {
  [...row].forEach((glyph, gx) => {
    if (glyph === '.') return;
    const hex = hexOf(ROLES[glyph]);
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    for (let dy = 0; dy < SCALE; dy++) {
      for (let dx = 0; dx < SCALE; dx++) {
        const at = ((gy * SCALE + dy) * SIZE + gx * SCALE + dx) * 4;
        raw[at] = r;
        raw[at + 1] = g;
        raw[at + 2] = b;
        raw[at + 3] = 255;
      }
    }
  });
});

const png = await sharp(raw, { raw: { width: SIZE, height: SIZE, channels: 4 } })
  .png({ palette: false, compressionLevel: 9 })
  .toBuffer();
const file = 'ui_menu_stand.png';
writeFileSync(resolve(HERE, `../local/${file}`), png);
console.log(`Wrote art/local/${file} — ${SIZE}x${SIZE}, ${png.length} bytes.`);
