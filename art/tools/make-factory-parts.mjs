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
    throw new Error(`belt_straight seams at row ${y}: "${straight[y][0]}" vs "${straight[y][SIZE - 1]}".`);
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

await write('belt_straight', straight);
await write('belt_corner', beltCorner());
await write('belt_junction', junction);
await write('grabber_arm', GRABBER);
