// Authors art/local/pipe_straight.png, pipe_corner.png and pipe_junction.png.
//
// WHY THESE ARE ARITHMETIC AND NOT PROMPTS
//
// The same argument make-factory-parts.mjs makes for belts, and it is stronger here. A pipe
// network is the one thing in this game where the art has to satisfy a *joinery* contract,
// not merely look right:
//
//   * A straight pipe repeats along its run. Any mismatch between column 0 and column 15
//     repeats every 16px in a row — the most visible artefact a tiling texture can have.
//   * A corner has to MEET a straight. The cross-section where the corner's arm leaves the
//     tile must be identical, pixel for pixel, to the straight's cross-section, or every
//     bend in the network shows a visible jog.
//   * All three are rotated 90 degrees by the renderer to get the other orientations, so
//     the horizontal cross-section and the vertical cross-section have to be the same
//     sequence of colours, or a pipe changes shading as it turns a corner.
//
// None of those are things a diffusion model can be asked for. They are, however, four
// lines of assertion each, run every time this file does. The measured evidence is already
// in the repo: two paid takes at the belt corner came back as "a brown scribble on a
// background that quantised to violet".
//
// Unlike a belt, a pipe is NOT drawn on a solid plate. A belt is a machine you walk items
// along; a pipe is a tube lying on the ground, and the ground should show around it.
//
// The cross-section is top-lit: dark rim, pale highlight, mid body, dark rim. Rotated 90
// degrees that puts the highlight on the left, which is the same light doing the same thing.

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

/**
 * The cross-section, outermost first, and the single source of truth for every tile here.
 * Four pixels thick and centred on 16, so rows 6..9 and columns 6..9 — symmetric about the
 * tile centre, which is what lets a 90-degree rotation land back on the grid exactly.
 */
const SECTION = ['metal_dark', 'metal_pale', 'metal_mid', 'metal_dark'];
const THICKNESS = SECTION.length;
const LOW = (SIZE - THICKNESS) >> 1;
const HIGH = LOW + THICKNESS - 1;

if ((SIZE - THICKNESS) % 2 !== 0) {
  throw new Error(`A ${THICKNESS}px section cannot be centred in ${SIZE}px without a half pixel.`);
}

function blank() {
  return Array.from({ length: SIZE }, () => new Array(SIZE).fill(null));
}

/** The horizontal run, full width. Row `LOW + i` takes `SECTION[i]`. */
function drawHorizontal(grid, fromX, toX) {
  for (let i = 0; i < THICKNESS; i++) {
    for (let x = fromX; x <= toX; x++) grid[LOW + i][x] = SECTION[i];
  }
}

/**
 * The vertical run. Column `LOW + i` takes `SECTION[i]` — the same sequence read left to
 * right that the horizontal reads top to bottom, which is exactly what makes the 90-degree
 * rotation a no-op on the shading.
 */
function drawVertical(grid, fromY, toY) {
  for (let i = 0; i < THICKNESS; i++) {
    for (let y = fromY; y <= toY; y++) grid[y][LOW + i] = SECTION[i];
  }
}

/**
 * The elbow. Where the two runs overlap, the vertical is drawn second and would leave the
 * horizontal's dark bottom rim cutting across the inside of the bend; painting the overlap
 * as body with a rim only on the two outer edges is what makes a bend read as one tube
 * rather than two tubes crossing.
 */
function roundElbow(grid) {
  for (let y = LOW; y <= HIGH; y++) {
    for (let x = LOW; x <= HIGH; x++) {
      const outerEdge = y === LOW || x === LOW;
      grid[y][x] = outerEdge ? 'metal_dark' : 'metal_mid';
    }
  }
  grid[LOW + 1][LOW + 1] = 'metal_pale';
}

function pipeStraight() {
  const grid = blank();
  drawHorizontal(grid, 0, SIZE - 1);
  return grid;
}

/** In from the left edge, out through the bottom edge. The renderer rotates and mirrors. */
function pipeCorner() {
  const grid = blank();
  drawHorizontal(grid, 0, HIGH);
  drawVertical(grid, LOW, SIZE - 1);
  roundElbow(grid);
  return grid;
}

/** A tee: the run passes left to right, and a branch leaves through the bottom. */
function pipeJunction() {
  const grid = blank();
  drawHorizontal(grid, 0, SIZE - 1);
  drawVertical(grid, LOW, SIZE - 1);
  // The branch reads as leaving the run rather than crossing it, so the run's bottom rim
  // is opened where the branch departs and only the branch's own rims continue down.
  for (let x = LOW + 1; x <= HIGH - 1; x++) grid[HIGH][x] = 'metal_mid';
  return grid;
}

// --- the guarantees, asserted rather than eyeballed ------------------------------------

const straight = pipeStraight();
const corner = pipeCorner();
const junction = pipeJunction();

/** A straight run must not seam: its left edge column must equal its right edge column. */
for (let y = 0; y < SIZE; y++) {
  if (straight[y][0] !== straight[y][SIZE - 1]) {
    throw new Error(`pipe_straight seams at row ${y}.`);
  }
}

/**
 * Rotating the straight 90 degrees must land exactly on the vertical pipe this file would
 * have drawn by hand — same columns, same colour order, no half-pixel drift. That is the
 * claim the renderer relies on when it gets three of the four orientations for free, and
 * it holds only because the section is centred and the section order is read the same way
 * along both axes. Asserting the rotation equals *itself* would be the wrong test: a
 * horizontal pipe turned 90 degrees is a vertical pipe, and should be.
 */
const verticalByHand = blank();
drawVertical(verticalByHand, 0, SIZE - 1);
// The direction is counter-clockwise, and that is a real convention rather than an
// arbitrary one: read anticlockwise, the section's top-to-bottom order becomes its
// left-to-right order, so the top-lit highlight lands on the pipe's left. Rotating the
// other way puts the highlight on the right — which still tiles and still joins, because
// the joinery guarantees below are about edge cross-sections, not about which side is lit.
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    if (straight[y][x] !== verticalByHand[SIZE - 1 - x][y]) {
      throw new Error(
        `pipe_straight rotated 90 degrees anticlockwise does not match the vertical pipe at ` +
          `${x},${y}: "${straight[y][x]}" vs "${verticalByHand[SIZE - 1 - x][y]}".`,
      );
    }
  }
}

/** Every arm that leaves a tile must present the straight's cross-section, or bends jog. */
const westSection = (grid) => grid.map((row) => row[0]);
const southSection = (grid) => [...grid[SIZE - 1]];
const reference = westSection(straight);
const rotatedReference = Array.from({ length: SIZE }, (_, x) =>
  x >= LOW && x <= HIGH ? SECTION[x - LOW] : null,
);

for (const [name, grid, expectSouth] of [
  ['pipe_corner', corner, true],
  ['pipe_junction', junction, true],
]) {
  const west = westSection(grid);
  if (west.join('|') !== reference.join('|')) {
    throw new Error(`${name} does not meet a straight pipe on its west edge.`);
  }
  if (expectSouth) {
    const south = southSection(grid);
    if (south.join('|') !== rotatedReference.join('|')) {
      throw new Error(`${name} does not meet a straight pipe on its south edge.`);
    }
  }
}

const junctionEast = junction.map((row) => row[SIZE - 1]);
if (junctionEast.join('|') !== reference.join('|')) {
  throw new Error('pipe_junction does not meet a straight pipe on its east edge.');
}

// --- emit -----------------------------------------------------------------------------

async function write(name, grid) {
  const raw = Buffer.alloc(SIZE * SIZE * 4);
  grid.forEach((row, y) => {
    row.forEach((role, x) => {
      if (!role) return;
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
  writeFileSync(resolve(HERE, `../local/${name}.png`), png);
  console.log(`Wrote art/local/${name}.png — ${SIZE}x${SIZE}, ${png.length} bytes.`);
}

await write('pipe_straight', straight);
await write('pipe_corner', corner);
await write('pipe_junction', junction);
