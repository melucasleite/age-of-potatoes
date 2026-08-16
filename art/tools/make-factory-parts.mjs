// Authors art/local/belt_straight.png, belt_corner.png and grabber_arm.png.
//
// WHY THESE THREE ARE HAND-AUTHORED AND THE MACHINES ARE NOT
//
// Two paid takes each went to Retro Diffusion first, so this is a measured call rather than
// a preference. The pattern in what came back is consistent and worth writing down: RD is
// genuinely good at chunky *objects* — the 32px machines, the items, the crop strips all
// landed — and reliably bad at 16px *technical geometry* seen from directly above. The belt
// came back as a featureless dark rectangle with the run pointing the wrong way; the corner
// came back as a brown scribble on a background that quantised to violet; the grabber came
// back as an inkblot with no claw. That is the same conclusion make-status-lamp.mjs reached
// about a 4x4 dot, arriving one order of magnitude larger.
//
// The deciding argument is not quality though — it is that these three carry *guarantees a
// diffusion model cannot make*:
//
//   * A belt tile must repeat along its run with NO SEAM. A run is a straight line of
//     identical tiles, so any mismatch at the tile edge repeats every 16px in a row, which
//     is the single most visible artefact a tiling texture can have. `tile_x: true` is a
//     best effort; the arithmetic below is exact.
//   * A grabber arm is ROTATED 90 degrees per direction by the renderer, so it has to be
//     centred and symmetric about its own axis or it wobbles as it turns.
//   * All three have to align to the 16px tile grid rather than merely sit inside it.
//
// Everything is drawn as a character grid for the same reason the status lamp is: it is
// auditable, it is reproducible the next time the style moves, and a pixel placed by
// arithmetic is on the master palette by construction.

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { loadMaster } from './palette-png.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SIZE = 16;

const ROLES = {
  K: 'ink',
  D: 'metal_dark',
  M: 'metal_mid',
  L: 'metal_light',
  P: 'metal_pale',
  // Tier liveries (work item 082). Three hues, each as rail / rail-shade / chevron:
  // yellow for Basic, red for Fast, blue for Express — and because colour is never the
  // only signal (042's colourblind rule), the CHEVRON COUNT is baked in too: 1 / 2 / 3.
  Y: 'tater_light',
  T: 'tater_mid',
  G: 'chip_gold',
  R: 'red_bright',
  E: 'red_mid',
  O: 'red_pale',
  B: 'water_bright',
  W: 'water_mid',
  Q: 'water_pale',
};

const { swatches } = loadMaster();
const hexOf = (name) => {
  const found = swatches.find((swatch) => swatch.name === name);
  if (!found) throw new Error(`Master palette has no colour named "${name}".`);
  return found.hex;
};

// --- the belt band -------------------------------------------------------------------
//
// Four horizontal bands: rail, belt, rail. The chevrons repeat with period 8, which divides
// 16, and no chevron pixel touches column 0 or column 15 — that is the whole seamlessness
// proof, and it is why the arrows are placed by modulus rather than by eye.

const RAIL_THICKNESS = 3;
const CHEVRON_PERIOD = 8;
const CHEVRON_WIDTH = 4;
const BAND_TOP = RAIL_THICKNESS;
const BAND_BOTTOM = SIZE - RAIL_THICKNESS - 1;
const BAND_MID = (BAND_TOP + BAND_BOTTOM) >> 1;

if (SIZE % CHEVRON_PERIOD !== 0) {
  throw new Error(`Chevron period ${CHEVRON_PERIOD} does not divide ${SIZE} — the belt seams.`);
}

/** A fat right-pointing triangle: 4 columns wide, tapering to a point. */
function chevronCells(x0) {
  const cells = [];
  for (let dx = 0; dx < CHEVRON_WIDTH; dx++) {
    for (let y = BAND_MID - 3 + dx; y <= BAND_MID + 3 - dx; y++) {
      cells.push([x0 + dx, y]);
    }
  }
  return cells;
}

function blankGrid() {
  return Array.from({ length: SIZE }, () => new Array(SIZE).fill('.'));
}

function beltStraight() {
  const grid = blankGrid();
  for (let y = 0; y < SIZE; y++) {
    const rail = y < BAND_TOP || y > BAND_BOTTOM;
    for (let x = 0; x < SIZE; x++) grid[y][x] = rail ? 'L' : 'D';
  }
  for (let x0 = 2; x0 < SIZE; x0 += CHEVRON_PERIOD) {
    for (const [x, y] of chevronCells(x0)) {
      if (x < SIZE) grid[y][x] = 'P';
    }
  }
  return grid;
}

// --- the corner ----------------------------------------------------------------------
//
// An L: in from the left edge, out through the bottom edge. The plate behind it is solid
// rather than transparent, matching the straight tile — a belt corner is a piece of
// machinery sitting on the ground, not a decal floating over it. One arrow on each leg, so
// the direction of travel through the bend is unambiguous.

const ARM_LOW = 3;
const ARM_HIGH = SIZE - ARM_LOW - 1;

function beltCorner() {
  const grid = blankGrid();
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const horizontal = y >= ARM_LOW && y <= ARM_HIGH && x <= ARM_HIGH;
      const vertical = x >= ARM_LOW && x <= ARM_HIGH && y >= ARM_LOW;
      grid[y][x] = horizontal || vertical ? 'D' : 'L';
    }
  }
  // Entering arrow, pointing right, on the horizontal leg.
  for (const [x, y] of chevronCells(0)) grid[y][x] = 'P';
  // Leaving arrow, pointing down, on the vertical leg — the same triangle transposed.
  for (let dy = 0; dy < CHEVRON_WIDTH; dy++) {
    for (let x = BAND_MID - 3 + dy; x <= BAND_MID + 3 - dy; x++) {
      grid[SIZE - CHEVRON_WIDTH - 1 + dy][x] = 'P';
    }
  }
  return grid;
}

// --- the junction ---------------------------------------------------------------------
//
// A tee: the run passes straight through west to east, and a branch leaves through the
// south. One sprite covers both halves of a belt network's branching vocabulary — a
// merger is a splitter with the arrows read the other way, and the renderer already
// rotates, so four rotations of this tile reach every tee a grid can contain.
//
// It shares the corner's plate and the straight's band arithmetic on purpose. The through
// run is the straight tile untouched, which is what guarantees a junction dropped into the
// middle of a run does not show a seam at either end of itself.

function beltJunction() {
  const grid = blankGrid();
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const through = y >= ARM_LOW && y <= ARM_HIGH;
      const branch = x >= ARM_LOW && x <= ARM_HIGH && y >= ARM_LOW;
      grid[y][x] = through || branch ? 'D' : 'L';
    }
  }
  // The through run keeps the straight tile's chevrons exactly, phase and all.
  for (let x0 = 2; x0 < SIZE; x0 += CHEVRON_PERIOD) {
    for (const [x, y] of chevronCells(x0)) {
      if (x < SIZE) grid[y][x] = 'P';
    }
  }
  // One departing arrow on the branch, pointing down, so a tee is never ambiguous about
  // which of its three arms is the odd one out.
  for (let dy = 0; dy < CHEVRON_WIDTH; dy++) {
    for (let x = BAND_MID - 3 + dy; x <= BAND_MID + 3 - dy; x++) {
      grid[SIZE - CHEVRON_WIDTH - 1 + dy][x] = 'P';
    }
  }
  return grid;
}

// --- the tier liveries (work item 082) ------------------------------------------------
//
// Owner ruling 2026-08-15: "yellow for the slow, red for the fast, blue for the fastest of
// all", and every tier tellable without colour — so the chevron count is the second cue,
// 1 / 2 / 3 per tile, which is also why these are per-tier FRAMES rather than one
// tint-neutral frame: a runtime tint can change hue but can never change how many arrows
// are on the belt. Same band arithmetic as the neutral tile, same seam proof.

const LIVERIES = {
  basic: { rail: 'Y', railDark: 'T', chev: 'G', chevronXs: [6] },
  fast: { rail: 'R', railDark: 'E', chev: 'O', chevronXs: [2, 10] },
  express: { rail: 'B', railDark: 'W', chev: 'Q', chevronXs: [1, 6, 11] },
};

// No chevron column may touch column 0 or 15 — that is the seam proof, checked not assumed.
for (const [tier, livery] of Object.entries(LIVERIES)) {
  for (const x0 of livery.chevronXs) {
    if (x0 < 1 || x0 + CHEVRON_WIDTH - 1 > SIZE - 2) {
      throw new Error(`belt_${tier}: chevron at x=${x0} touches a tile edge — the belt seams.`);
    }
  }
}

/**
 * A tier straight: the neutral tile's geometry with the rails in the tier's hue (bright
 * outer rows, one shade row against the band) and the tier's chevron count on the band.
 */
function beltTierStraight(livery) {
  const grid = blankGrid();
  for (let y = 0; y < SIZE; y++) {
    const rail = y < BAND_TOP || y > BAND_BOTTOM;
    const shade = y === BAND_TOP - 1 || y === BAND_BOTTOM + 1;
    for (let x = 0; x < SIZE; x++) {
      grid[y][x] = rail ? (shade ? livery.railDark : livery.rail) : 'D';
    }
  }
  for (const x0 of livery.chevronXs) {
    for (const [x, y] of chevronCells(x0)) {
      if (x < SIZE) grid[y][x] = livery.chev;
    }
  }
  return grid;
}

/**
 * A tier corner: the neutral corner's arms, the plate in the tier's hue with a one-pixel
 * shade ring where plate meets band — which is exactly what makes this tile's entry edges
 * match the tier straight's edges, column for column (asserted below, per tier).
 *
 * The chevron count survives the bend: Basic keeps the one departing arrow, Fast adds the
 * entering arrow, Express carries two entering plus the departing one.
 */
function beltTierCorner(livery) {
  const grid = blankGrid();
  const inArms = (x, y) => {
    const horizontal = y >= ARM_LOW && y <= ARM_HIGH && x <= ARM_HIGH;
    const vertical = x >= ARM_LOW && x <= ARM_HIGH && y >= ARM_LOW;
    return horizontal || vertical;
  };
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (inArms(x, y)) {
        grid[y][x] = 'D';
        continue;
      }
      const borders =
        (x > 0 && inArms(x - 1, y)) ||
        (x < SIZE - 1 && inArms(x + 1, y)) ||
        (y > 0 && inArms(x, y - 1)) ||
        (y < SIZE - 1 && inArms(x, y + 1));
      grid[y][x] = borders ? livery.railDark : livery.rail;
    }
  }
  // Entering arrows (pointing right) on the horizontal leg: none for Basic, one for Fast,
  // two for Express — the departing arrow below completes the 1 / 2 / 3 count.
  // Never at x=0: an arrow touching the entry edge would break the edge-match assertion
  // below (the neutral corner predates that check and keeps its edge-hugging arrow).
  const entering = { 1: [], 2: [1], 3: [1, 6] }[livery.chevronXs.length];
  for (const x0 of entering) {
    for (const [x, y] of chevronCells(x0)) {
      if (x < SIZE) grid[y][x] = livery.chev;
    }
  }
  // The departing arrow, pointing down the vertical leg — every tier has this one.
  for (let dy = 0; dy < CHEVRON_WIDTH; dy++) {
    for (let x = BAND_MID - 3 + dy; x <= BAND_MID + 3 - dy; x++) {
      grid[SIZE - CHEVRON_WIDTH - 1 + dy][x] = livery.chev;
    }
  }
  return grid;
}

// --- the grabber ---------------------------------------------------------------------
//
// Drawn pointing EAST and centred on the sprite, so the renderer gets the other three
// directions from a 90-degree rotation about the middle. Three shapes only — a dark ring
// base, a pale arm, a dark gripper head — because at 16px a fourth shape is mush. The
// gripper head deliberately reaches the right edge: a Mk1 grabber's whole job is to reach
// into the next tile, and a sprite that stops politely at its own boundary lies about that.

// prettier-ignore
const GRABBER = [
  '................',
  '................',
  '................',
  '..DDDD..........',
  '.DDDDDD.....KK..',
  'DDDMMDDD....KK..',
  'DDMMMMDD...KKK..',
  'DDMMMMDPPPPPKKK.',
  'DDMMMMDPPPPPKKK.',
  'DDMMMMDD...KKK..',
  'DDDMMDDD....KK..',
  '.DDDDDD.....KK..',
  '..DDDD..........',
  '................',
  '................',
  '................',
];

// --- the grabber redesign (work item 082) ---------------------------------------------
//
// Owner ruling 2026-08-15: "also reskin the grabbers. I don't like how they look." The new
// body keeps the two guarantees the old one carried — authored pointing EAST, centred, and
// mirror-symmetric about the horizontal midline (asserted below), so the renderer's
// quarter-turns stay wobble-free — and adds what the old one lacked: an open two-finger
// claw that visibly grips eastward, a mounting plate with an inner housing, a pivot cap in
// the tier's hue, and the tier's TICK COUNT on the arm (1 / 2 / 3, the belts' chevron rule
// in grabber vocabulary, so colour is never the only signal). The Long arm additionally
// hooks its finger tips inward, marking the two-tile reach; Mk1 and Mk2 share the
// short-claw silhouette and differ by hue and tick count.

function grabberGrid(accent, accentDark, ticks, hooks) {
  const grid = blankGrid();
  const rect = (x, y, w, h, glyph) => {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) grid[yy][xx] = glyph;
    }
  };
  // The mounting plate, chamfered so the silhouette reads round-ish rather than boxy.
  rect(0, 4, 7, 8, 'D');
  rect(1, 5, 5, 6, 'M');
  grid[4][0] = '.';
  grid[11][0] = '.';
  grid[4][6] = '.';
  grid[11][6] = '.';
  // The pivot cap: tier-hue ring with a bright core, dead centre on the plate.
  rect(2, 6, 3, 4, accentDark);
  rect(3, 7, 1, 2, accent);
  // Shoulder, then the arm: dark outline rows, pale shaft, tier ticks riding the shaft.
  rect(6, 6, 2, 4, 'D');
  rect(7, 6, 5, 1, 'D');
  rect(7, 9, 5, 1, 'D');
  rect(7, 7, 5, 2, 'P');
  for (const x of ticks) rect(x, 7, 1, 2, accentDark);
  // Wrist, claw back, and the two fingers reaching the east edge — the open jaw between
  // them is the point: a grabber's sprite must say "reaches into the next tile".
  rect(11, 5, 2, 6, 'D');
  rect(12, 5, 2, 6, 'K');
  rect(13, 4, 3, 2, 'K');
  rect(13, 10, 3, 2, 'K');
  rect(13, 6, 1, 4, 'P');
  if (hooks) {
    grid[6][15] = 'K';
    grid[9][15] = 'K';
  }
  return grid;
}

const GRABBER_TIERS = {
  grabber_mk1: grabberGrid('G', 'T', [9], false),
  grabber_mk2: grabberGrid('R', 'E', [8, 10], false),
  grabber_long: grabberGrid('B', 'W', [7, 9, 11], true),
};

// --- emit ----------------------------------------------------------------------------

async function write(name, grid) {
  const rows = grid.map((row) => (Array.isArray(row) ? row.join('') : row));
  if (rows.length !== SIZE) throw new Error(`${name}: ${rows.length} rows, expected ${SIZE}.`);

  const raw = Buffer.alloc(SIZE * SIZE * 4);
  rows.forEach((row, y) => {
    if (row.length !== SIZE) throw new Error(`${name}: row ${y} is ${row.length} wide.`);
    [...row].forEach((glyph, x) => {
      if (glyph === '.') return;
      const role = ROLES[glyph];
      if (!role) throw new Error(`${name}: unknown glyph "${glyph}" at ${x},${y}.`);
      const hex = hexOf(role);
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
  const out = resolve(HERE, `../local/${name}.png`);
  writeFileSync(out, png);
  console.log(`Wrote art/local/${name}.png — ${SIZE}x${SIZE}, ${png.length} bytes.`);
}

// The seam check, run every time rather than reasoned about once: a belt tile's left edge
// must equal its right edge, column for column, or a straight run shows a stripe every tile.
const straight = beltStraight();
for (let y = 0; y < SIZE; y++) {
  if (straight[y][0] !== straight[y][SIZE - 1]) {
    throw new Error(
      `belt_straight seams at row ${y}: "${straight[y][0]}" vs "${straight[y][SIZE - 1]}".`,
    );
  }
}

// A junction is dropped into the middle of an existing run, so its through-run edges must
// match the straight tile's edges exactly or every tee shows two seams instead of none.
const junction = beltJunction();
for (let y = 0; y < SIZE; y++) {
  if (junction[y][0] !== straight[y][0] || junction[y][SIZE - 1] !== straight[y][SIZE - 1]) {
    throw new Error(`belt_junction does not meet a straight belt at row ${y}.`);
  }
}

// The tier tiles carry the same two guarantees, per tier: a straight's left edge equals
// its right edge, and a corner's entry edges equal the straight's edges — so a bend never
// shows a seam against the run feeding it.
for (const [tier, livery] of Object.entries(LIVERIES)) {
  const tierStraight = beltTierStraight(livery);
  for (let y = 0; y < SIZE; y++) {
    if (tierStraight[y][0] !== tierStraight[y][SIZE - 1]) {
      throw new Error(`belt_${tier} seams at row ${y}.`);
    }
  }
  const tierCorner = beltTierCorner(livery);
  for (let y = 0; y < SIZE; y++) {
    if (tierCorner[y][0] !== tierStraight[y][0]) {
      throw new Error(`belt_${tier}_corner does not meet a straight belt at row ${y}.`);
    }
  }
  // The corner's exit edge (bottom) must match a vertical run's edge — which is the same
  // profile as the straight's left edge, x-for-y, because rotation carries the edge with it.
  for (let x = 0; x < SIZE; x++) {
    if (tierCorner[SIZE - 1][x] !== tierStraight[x][0]) {
      throw new Error(`belt_${tier}_corner does not meet a vertical belt at column ${x}.`);
    }
  }
}

// A grabber is rotated in quarter-turns about its centre, so it must be mirror-symmetric
// about the horizontal midline or it visibly wobbles as it turns. Asserted, not eyeballed.
for (const [name, grid] of Object.entries(GRABBER_TIERS)) {
  for (let y = 0; y < SIZE / 2; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (grid[y][x] !== grid[SIZE - 1 - y][x]) {
        throw new Error(`${name} is not mirror-symmetric at ${x},${y} — it will wobble.`);
      }
    }
  }
}

await write('belt_straight', straight);
await write('belt_corner', beltCorner());
await write('belt_junction', junction);
await write('grabber_arm', GRABBER);
for (const [tier, livery] of Object.entries(LIVERIES)) {
  await write(`belt_${tier}`, beltTierStraight(livery));
  await write(`belt_${tier}_corner`, beltTierCorner(livery));
}
for (const [name, grid] of Object.entries(GRABBER_TIERS)) {
  await write(name, grid);
}
