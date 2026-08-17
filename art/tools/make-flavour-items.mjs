// Authors the nine item icons for the flavoured chip lines ([[111]]) into art/local/.
//
// WHY THESE ARE HAND-AUTHORED WHEN EVERY OTHER ITEM ICON WAS BOUGHT
//
// make-factory-parts.mjs sets the test this file has to pass: Retro Diffusion is genuinely
// good at chunky *objects* — every item icon in the atlas is one of its takes — and the only
// reason to draw one by hand is a GUARANTEE A DIFFUSION MODEL CANNOT MAKE. Cost is not the
// argument (nine takes is $0.153 at the $0.017 this account pays). These are the guarantees:
//
//   * THE GOLD LINE MUST BE THE PLAIN LINE, SHIFTED. Item 111 prices it that way on purpose —
//     "the whole gold line is the plain line shifted by one flat $6.00 at every rung" — and a
//     player can only read that off the pictures if the rungs share a silhouette and differ in
//     hue. Ask a model for a premium potato and you get a *different potato*. Two unrelated
//     ovals say "two unrelated items", which is the one thing this tier must not say.
//   * FOUR BAGS MUST BE TELLABLE APART AT 16px, WITHOUT COLOUR. Plain, gold, chili and
//     sweetcorn now sit in the same inventory grid, and §42's colourblind rule is not
//     satisfied by four hues — chili red and premium amber are near-identical under
//     deuteranopia, which is the same trap make-status-lamp.mjs found on a 4x4 dot. So each
//     flavour carries a MARK, a shape, and the greyscale separation is asserted at the bottom
//     of this file over every pair rather than eyeballed once.
//   * ONE VOCABULARY ACROSS TWO RUNGS. The mark a bag wears is the same 5x5 glyph the loose
//     chips wear, so a player learns "crown = gold, pepper = chili, cob = sweetcorn" once and
//     reads it on the belt, in the hopper and in the bag. Two sprites drawn from one glyph is
//     an identity; two sprites drawn from two prompts is a coincidence.
//
// THE SILHOUETTES ARE THIS FAMILY'S, MEASURED OFF IT, NOT INVENTED. The committed cooked
// icons turn out to be pure ramps — `item_chip_bag` is FOUR colours and 104 opaque pixels, the
// whole red ramp and nothing else; `item_plain_chips` is five. That is why a flavoured bag is
// a recolour job rather than a drawing job, and why the ramps below are named after the
// master palette's own ramps instead of being mixed. Nothing here reads art/cooked/ at run
// time: cooked/ is gitignored build output, and a source that depends on a build product is a
// source that cannot be rebuilt from a fresh clone. The proportions were traced by hand and
// live here as arithmetic.

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

// --- ramps ---------------------------------------------------------------------------
//
// Four rungs each: rim, body, lit, spec. Every sprite below is drawn once in glyphs and
// resolved through one of these, which is the whole "the gold line is the plain line
// shifted" mechanism — the same grid, a different lookup.
//
// The chili bag deliberately sits one rung DOWN its own ramp from the plain bag: plain is
// red_bright-bodied, chili is red_mid-bodied. That is a value difference, not a hue
// difference, and it is what keeps the two red bags apart in greyscale.
//
// THE CORN BAG IS leaf_LIGHT-BODIED FOR THE SAME REASON, AND THE ASSERTION IS WHY. The first
// cut of this file gave it leaf_mid, the palette's most-used green, and the check at the
// bottom failed on the first run: leaf_mid and red_mid are 22 lumas apart, so the chili bag
// and the sweetcorn bag differed on SIXTEEN of 256 pixels once colour was thrown away. Red
// and green, the oldest mistake there is, caught by arithmetic in about a second. Moving the
// corn body one rung UP its ramp puts 59 lumas between the two bodies and takes the pair to
// 72 — re-measured against the shipped sprites by putting leaf_mid back, not remembered from
// the run that first failed.

const RAMPS = {
  gold: { rim: 'tater_dark', body: 'lamp_starved', lit: 'chip_gold', spec: 'paper' },
  fried: { rim: 'lamp_starved', body: 'chip_gold', lit: 'paper', spec: 'paper' },
  chili: { rim: 'red_deep', body: 'red_mid', lit: 'red_bright', spec: 'red_pale' },
  hotChip: { rim: 'red_mid', body: 'red_bright', lit: 'red_pale', spec: 'red_pale' },
  corn: { rim: 'leaf_dark', body: 'leaf_light', lit: 'leaf_pale', spec: 'leaf_pale' },
  sweetcorn: { rim: 'tater_dark', body: 'lamp_starved', lit: 'chip_gold', spec: 'paper' },
};

// --- the flavour marks ---------------------------------------------------------------
//
// Three 5x5 glyphs, one per flavour, chosen for SHAPE contrast first: a jagged top edge, an
// upright tapering hook, and a leaning ear. Those three survive the loss of colour, which is
// the point; the assertion at the bottom is what stops that claim from being a nice sentence.
// `X` is the mark colour, `k` its second value, and `s` the always-leaf_mid green — the
// chili's single stem pixel, which is what stops the pepper reading as a flame, and the
// cob's two husk leaves.

const MARKS = {
  crown: ['X.X.X', 'XXXXX', 'XXXXX', '.XXX.', '.....'],
  pepper: ['...s.', '..XX.', '.XXX.', '.XX..', '..X..'],
  cob: ['..XXk', '.XXXk', '.XXX.', 'sXX..', 'ss...'],
};

// THE COB TOOK FIVE GOES AND THE LESSON GENERALISES, so it is written down rather than quietly
// fixed. §15 puts letterforms in sprites on the NEVER list — the game carries a bitmap font
// precisely so that no sprite has to hold text — and a mark a player READS as a letter is text
// whether or not it was drawn as one. The HUD magnifies item icons 2-3x into their boxes, so
// "it is only five pixels" is not a defence. Each of these was drawn, rendered, looked at, and
// thrown away:
//
//   1. A lattice, solid rows alternating with pierced rows — rendered as a capital A.
//   2. A zigzag column, 3 wide then 2 wide then 3 — rendered as a 5.
//   3. A notched capsule made MIRROR-SYMMETRIC, on the theory that letters are not — rendered
//      as an 8, which is symmetric, as are 0, O, H, I and X. The theory was simply wrong.
//   4. A capsule with a second-colour seam, on the theory that type is monochrome so a
//      two-tone mark cannot be a glyph — rendered as a 0 with a bar. Also wrong, and for an
//      instructive reason: the eye reads the SILHOUETTE first and colours it in afterwards, so
//      an outline that encloses a counter is a letter no matter what is inside it.
//
// What actually settles it is the axis. Latin and Arabic glyphs are upright and vertically
// bounded; nothing in either is drawn on a diagonal. So the cob leans, with two husk leaves at
// its foot — and a leaning object with something growing off it is not a shape any alphabet
// contains. That is a structural argument rather than a fifth guess, which is why it is the
// one that stuck.

// --- grid helpers --------------------------------------------------------------------

function blankGrid() {
  return Array.from({ length: SIZE }, () => new Array(SIZE).fill('.'));
}

function rect(grid, x0, y0, width, height, glyph) {
  for (let y = y0; y < y0 + height; y++) {
    for (let x = x0; x < x0 + width; x++) {
      if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) continue;
      grid[y][x] = glyph;
    }
  }
}

/**
 * A filled ellipse with a one-pixel rim of its own darker value.
 *
 * Ellipses rather than traced blobs because a crisp is a disc seen at an angle, and because
 * an ellipse is the only shape that can be moved a pixel without being redrawn — the three
 * crisps in a pile were positioned by moving centres, not by editing pixels.
 */
function ellipse(grid, cx, cy, rx, ry, fill, rim) {
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      const d = dx * dx + dy * dy;
      if (d > 1) continue;
      grid[y][x] = d > 0.55 ? rim : fill;
    }
  }
}

/**
 * Stamps a 5x5 mark with its top-left at (x0, y0). Transparent cells of the mark pass through.
 *
 * Three ink glyphs, and the count is the point (see the cob note above): `X` is the mark
 * colour, `k` its second value, and `s` the one always-green stem pixel that stops the pepper
 * reading as a flame.
 */
function stampMark(grid, mark, x0, y0, glyph) {
  MARKS[mark].forEach((row, dy) => {
    [...row].forEach((cell, dx) => {
      if (cell === '.') return;
      const x = x0 + dx;
      const y = y0 + dy;
      if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
      grid[y][x] = cell === 's' ? 'S' : cell === 'k' ? 'k' : glyph;
    });
  });
}

// --- the bag -------------------------------------------------------------------------
//
// A pinched foil pouch: crimped seal at the top, a fat body lit down one edge, a dark base
// band. Twelve columns and thirteen rows, which is the proportion the family's plain bag
// already has — a flavoured bag that were a different SHAPE would read as a different
// product rather than as the same product in a different flavour.
//
// The mark sits at x=6..10, y=5..9, which is dead centre of the body with a one-pixel
// margin on every side. That margin is why the marks can be as loud as they are.

const BAG_MARK_X = 6;
const BAG_MARK_Y = 5;

function bagGrid(mark) {
  const grid = blankGrid();

  // Crimped seal: alternating teeth over a solid bar. Narrower than the body — a chip bag
  // is pinched where it is heat-sealed, and that pinch is most of what says "bag" at 16px.
  for (let x = 4; x <= 11; x++) grid[1][x] = x % 2 === 0 ? 'r' : 'l';
  rect(grid, 4, 2, 8, 1, 'r');

  // Body. Both side columns take the rim value so the pouch reads as round, and column 4
  // takes the lit value — one lit edge just inside the shadow, which is the cheapest way to
  // make ten columns of flat colour look like a cylinder.
  rect(grid, 3, 3, 10, 10, 'b');
  rect(grid, 3, 3, 1, 10, 'r');
  rect(grid, 12, 3, 1, 10, 'r');
  rect(grid, 4, 4, 1, 8, 'l');

  // Base band: where the bag is sealed shut and sits on the shelf.
  rect(grid, 3, 13, 10, 1, 'r');

  stampMark(grid, mark, BAG_MARK_X, BAG_MARK_Y, 'm');
  return grid;
}

// --- the pile ------------------------------------------------------------------------
//
// A wide crisp lying flat with three smaller ones of different sizes standing in it — the
// same "heap of fat curved crisps" read as the family's plain and seasoned piles. The flavour
// pip lands in the top-right corner, and the four ellipse centres below are chosen so that
// corner stays empty: a mark drawn over a crisp is a mark nobody can see.

// Inset by one from the top-right corner, not flush to it: flush put the crown's first row on
// row 0 and its last column on column 15, and the edge assertion below caught both.
const PIP_X = 10;
const PIP_Y = 1;

/**
 * Seasoning, as a fixed list. Never random: a sprite that changes between runs is not a sprite.
 *
 * Twelve specks rather than a polite handful, and always in a value far from the crisp under
 * them. The plain line already draws this distinction as pale-gold-to-red-orange, so a
 * seasoned rung that only whispered would be the one rung of the flavour line a player could
 * not see had happened.
 */
const SEASONING = [
  [4, 8],
  [7, 7],
  [9, 11],
  [6, 12],
  [11, 9],
  [3, 11],
  [8, 9],
  [12, 11],
  [5, 5],
  [9, 6],
  [6, 10],
  [10, 12],
];

function pileGrid({ mark = null, seasoned = false } = {}) {
  const grid = blankGrid();
  // A wide base the heap sits on, then three crisps of DIFFERENT sizes standing in it. The
  // first cut used three equal ellipses in a triangle and rendered as three eggs: equal
  // shapes at equal spacing read as a pattern, and a pile is the opposite of a pattern. The
  // rim on each is what puts a visible edge between one crisp and the next.
  ellipse(grid, 7.5, 10.5, 6.5, 3, 'b', 'r');
  ellipse(grid, 4, 7.5, 3.2, 2.6, 'l', 'r');
  ellipse(grid, 7, 6, 3.6, 2.8, 'b', 'r');
  ellipse(grid, 10.5, 8, 3, 2.3, 'l', 'r');

  if (seasoned) {
    for (const [x, y] of SEASONING) {
      if (grid[y][x] !== '.') grid[y][x] = 'd';
    }
  }
  if (mark !== null) stampMark(grid, mark, PIP_X, PIP_Y, 'm');
  return grid;
}

// --- the tuber and the slices ---------------------------------------------------------
//
// The two rungs above the fryer. Both are deliberately the plain line's shapes: a washed
// potato is an oval with a wet patch, and slices are a stack of discs, and that is what
// makes the gold line legible AS the potato line.
//
// One shape change on purpose, in each. The gold tuber is drawn ROUNDER than the russet's
// oval and the gold slices as THREE fat discs against the russet's four thin ones, because
// a gold potato is the big premium tuber. That is the only discriminator between
// `item_potato_slices` and `item_gold_potato_slices` that does not depend on hue — the plain
// slices came back from the model already drawn in chip_gold, so saturation alone would have
// left the two nearly the same picture.

function tuberGrid() {
  const grid = blankGrid();
  ellipse(grid, 8, 8, 6.5, 5.5, 'b', 'r');
  // Lit crown, upper-left, where the light in this game always comes from.
  ellipse(grid, 6, 6, 3, 2.2, 'l', 'l');
  // The wet patch: the plain line's own signal for "this has been through the Washer",
  // borrowed exactly rather than reinvented, because it is the difference between this and
  // the raw gold potato the player just harvested.
  rect(grid, 5, 4, 4, 1, 'w');
  rect(grid, 4, 5, 5, 1, 'w');
  rect(grid, 5, 6, 3, 1, 'v');
  return grid;
}

function slicesGrid() {
  const grid = blankGrid();
  // Three discs, stacked and offset, each with its own rim so the stack has edges to count.
  // The radii are 5.5 rather than the 6.5 they started at: the wider disc reached column 15
  // and the edge assertion below refused it, which is the assertion doing its job on the
  // author rather than on a later hand.
  ellipse(grid, 8, 4, 5.5, 2.4, 'b', 'r');
  ellipse(grid, 7, 8, 5.5, 2.6, 'l', 'r');
  ellipse(grid, 9, 12, 5.5, 2.4, 'b', 'r');
  return grid;
}

// --- the roster ----------------------------------------------------------------------
//
// Every frame is named for the sim's own slug with dashes swapped for underscores, which is
// the rule apps/web/src/hud/item-art.ts states and the renderer follows. A frame whose name
// does not match its slug is a frame the bag will never ask for.

const GLYPHS = (ramp, mark) => ({
  r: RAMPS[ramp].rim,
  b: RAMPS[ramp].body,
  l: RAMPS[ramp].lit,
  p: RAMPS[ramp].spec,
  d: mark.dust ?? RAMPS[ramp].rim,
  m: mark.colour ?? RAMPS[ramp].rim,
  k: mark.shade ?? mark.colour ?? RAMPS[ramp].rim,
  S: 'leaf_mid',
  w: 'water_pale',
  v: 'water_bright',
});

const SPRITES = {
  // The gold base line: washer, slicer, fryer, seasoner, bagger.
  item_washed_gold_potato: { grid: tuberGrid(), glyphs: GLYPHS('gold', {}) },
  item_gold_potato_slices: { grid: slicesGrid(), glyphs: GLYPHS('gold', {}) },
  item_gold_chips: { grid: pileGrid(), glyphs: GLYPHS('fried', {}) },
  item_seasoned_gold_chips: {
    grid: pileGrid({ mark: 'crown', seasoned: true }),
    glyphs: GLYPHS('fried', { colour: 'red_mid', dust: 'red_mid' }),
  },
  item_bagged_gold_chips: {
    grid: bagGrid('crown'),
    glyphs: GLYPHS('gold', { colour: 'red_mid' }),
  },

  // The two seasonings, which enter at the Seasoner and never reach the Washer.
  item_chili_chips: {
    grid: pileGrid({ mark: 'pepper', seasoned: true }),
    glyphs: GLYPHS('hotChip', { colour: 'red_deep', dust: 'red_deep' }),
  },
  item_bagged_chili_chips: {
    grid: bagGrid('pepper'),
    glyphs: GLYPHS('chili', { colour: 'chip_gold' }),
  },
  item_sweetcorn_chips: {
    grid: pileGrid({ mark: 'cob', seasoned: true }),
    glyphs: GLYPHS('sweetcorn', { colour: 'leaf_mid', shade: 'chip_gold', dust: 'tater_dark' }),
  },
  item_bagged_sweetcorn_chips: {
    grid: bagGrid('cob'),
    glyphs: GLYPHS('corn', { colour: 'chip_gold', shade: 'leaf_dark' }),
  },
};

// --- emit ----------------------------------------------------------------------------

function pixelsOf(name, { grid, glyphs }) {
  const pixels = new Array(SIZE * SIZE).fill(null);
  grid.forEach((row, y) => {
    if (row.length !== SIZE) throw new Error(`${name}: row ${y} is ${row.length} wide.`);
    row.forEach((glyph, x) => {
      if (glyph === '.') return;
      const role = glyphs[glyph];
      if (!role) throw new Error(`${name}: unknown glyph "${glyph}" at ${x},${y}.`);
      pixels[y * SIZE + x] = hexOf(role);
    });
  });
  return pixels;
}

async function write(name, pixels) {
  const raw = Buffer.alloc(SIZE * SIZE * 4);
  pixels.forEach((hex, i) => {
    if (hex === null) return;
    raw[i * 4] = parseInt(hex.slice(1, 3), 16);
    raw[i * 4 + 1] = parseInt(hex.slice(3, 5), 16);
    raw[i * 4 + 2] = parseInt(hex.slice(5, 7), 16);
    raw[i * 4 + 3] = 255;
  });

  const png = await sharp(raw, { raw: { width: SIZE, height: SIZE, channels: 4 } })
    .png({ palette: false, compressionLevel: 9 })
    .toBuffer();
  writeFileSync(resolve(HERE, `../local/${name}.png`), png);
  console.log(`Wrote art/local/${name}.png — ${SIZE}x${SIZE}, ${png.length} bytes.`);
}

// --- the assertions -------------------------------------------------------------------

const RENDERED = Object.fromEntries(
  Object.entries(SPRITES).map(([name, sprite]) => [name, pixelsOf(name, sprite)]),
);

const luma = (hex) =>
  hex === null
    ? -1
    : 0.299 * parseInt(hex.slice(1, 3), 16) +
      0.587 * parseInt(hex.slice(3, 5), 16) +
      0.114 * parseInt(hex.slice(5, 7), 16);

/**
 * THE GREYSCALE CRITERION, MADE MECHANICAL — the whole reason this file is not three prompts.
 *
 * §42 asks that nothing in this game be distinguishable by hue alone, and four chip bags in
 * one inventory grid is exactly where that bites. So every pair of the nine is compared with
 * the colour thrown away: a pixel "differs" if one is transparent and the other is not, or
 * if the two lumas are more than TOLERANCE apart. A pair must differ on at least FLOOR
 * pixels of the 256.
 *
 * The numbers are the same shape as make-status-lamp.mjs's six-of-twenty-five: chosen so the
 * set as authored passes with room, and so a later recolour that quietly collapses two
 * flavours into one silhouette fails the build instead of shipping.
 */
const TOLERANCE = 24;
const FLOOR = 24;

const names = Object.keys(RENDERED);
const scores = [];
for (let i = 0; i < names.length; i++) {
  for (let j = i + 1; j < names.length; j++) {
    const a = RENDERED[names[i]];
    const b = RENDERED[names[j]];
    let differing = 0;
    for (let k = 0; k < SIZE * SIZE; k++) {
      const la = luma(a[k]);
      const lb = luma(b[k]);
      if ((a[k] === null) !== (b[k] === null)) differing++;
      else if (Math.abs(la - lb) > TOLERANCE) differing++;
    }
    scores.push({ pair: `${names[i]} vs ${names[j]}`, differing });
  }
}
scores.sort((x, y) => x.differing - y.differing);
for (const { pair, differing } of scores.slice(0, 5)) {
  console.log(`  greyscale  ${String(differing).padStart(3)} px  ${pair}`);
}
const worst = scores[0];
if (worst.differing < FLOOR) {
  throw new Error(
    `${worst.pair} differ on only ${worst.differing} of 256 pixels in greyscale ` +
      `(floor ${FLOOR}) — they would be one picture to a colourblind player.`,
  );
}

// A mark that is not on the sprite is a vocabulary nobody can learn. Every flavour's mark
// must actually appear, in the mark colour, on BOTH the loose chips and the bag.
const WEARS_A_MARK = [
  'item_seasoned_gold_chips',
  'item_bagged_gold_chips',
  'item_chili_chips',
  'item_bagged_chili_chips',
  'item_sweetcorn_chips',
  'item_bagged_sweetcorn_chips',
];
for (const name of WEARS_A_MARK) {
  const wanted = hexOf(SPRITES[name].glyphs.m);
  const painted = RENDERED[name].filter((hex) => hex === wanted).length;
  if (painted < 8) {
    throw new Error(`${name} shows only ${painted}px of its flavour mark — it is not readable.`);
  }
}

// Nothing may leave the frame's edge: these are loose objects on a transparent field, and a
// sprite touching its own border reads as clipped once the atlas packs it against a neighbour.
for (const [name, pixels] of Object.entries(RENDERED)) {
  for (let i = 0; i < SIZE; i++) {
    const edges = [
      pixels[i],
      pixels[(SIZE - 1) * SIZE + i],
      pixels[i * SIZE],
      pixels[i * SIZE + SIZE - 1],
    ];
    if (edges.some((hex) => hex !== null)) {
      throw new Error(`${name} paints its own frame edge at index ${i} — it will look clipped.`);
    }
  }
}

for (const [name, pixels] of Object.entries(RENDERED)) await write(name, pixels);
