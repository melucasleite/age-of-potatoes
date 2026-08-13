// Authors art/local/decal_<dial>_<level>.png — nine 32x32 overlays, three per upgrade dial.
//
// WHAT THESE ARE FOR
//
// Plan §3 asks that upgrades be *physically visible*: a maxed Fryer must look maxed from
// across the field, without a tooltip and without reading a number. That is the whole
// design argument for the dials existing at a machine rather than in a menu, so a dial the
// player cannot see is a dial that only half works.
//
// WHY 32x32 OVERLAYS RATHER THAN LITTLE BADGES
//
// Each decal is the same size as the machine sprite it sits on, mostly transparent, drawn
// in the machine's own coordinate space. That is a deliberate trade of a few hundred bytes
// of atlas for the removal of an entire class of bug: the renderer composites a decal at
// exactly the machine's position with no offset table, no per-machine anchor, and no
// negotiation about where a given machine's roofline is. A 16x16 badge would be smaller
// and would need every one of those.
//
// Three dials, three levels, nine sprites, all generated from one shape each so the set
// escalates consistently — L2 is visibly more than L1 and L3 visibly more than L2 without
// anyone eyeballing nine separate drawings.
//
// WHY HAND-AUTHORED
//
// The same reason the belts and pipes are. A decal has to register to a specific region of
// a 32px sprite, keep a transparent surround, and read as the *same* motif three times at
// three sizes. Diffusion gives none of those; arithmetic gives all three for free, and
// every pixel is on the master palette by construction.

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { loadMaster } from './palette-png.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SIZE = 32;
const LEVELS = [1, 2, 3];

const { swatches } = loadMaster();
const hexOf = (name) => {
  const found = swatches.find((swatch) => swatch.name === name);
  if (!found) throw new Error(`Master palette has no colour named "${name}".`);
  return found.hex;
};

function blank() {
  return Array.from({ length: SIZE }, () => new Array(SIZE).fill(null));
}

function fill(grid, x0, y0, x1, y1, role) {
  for (let y = Math.max(0, y0); y <= Math.min(SIZE - 1, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(SIZE - 1, x1); x++) grid[y][x] = role;
  }
}

/** A filled box with a dark rim and a highlight down its lit edge. Every decal is these. */
function box(grid, x0, y0, x1, y1, { body, rim, lit }) {
  fill(grid, x0, y0, x1, y1, body);
  fill(grid, x0, y0, x1, y0, rim);
  fill(grid, x0, y1, x1, y1, rim);
  fill(grid, x0, y0, x0, y1, rim);
  fill(grid, x1, y0, x1, y1, rim);
  if (lit && x1 - x0 >= 2 && y1 - y0 >= 2) fill(grid, x0 + 1, y0 + 1, x0 + 1, y1 - 1, lit);
}

// --- Speed: chrome exhaust --------------------------------------------------------------
//
// Stacks on the machine's roof, top-right so they clear the hopper the Capacity dial grows
// in the middle. Level buys height first and then a second stack, because a taller pipe
// reads at a glance and a second one reads even at a distance.

const CHROME = { body: 'metal_pale', rim: 'metal_dark', lit: 'paper' };

function speed(level) {
  const grid = blank();
  const height = level === 1 ? 6 : 9;
  const top = 14 - height;
  const stacks = level === 3 ? [18, 24] : [22];
  for (const x of stacks) {
    box(grid, x, top, x + 4, 15, CHROME);
    // The flared cap, one pixel proud on each side — what makes it an exhaust and not a post.
    fill(grid, x - 1, top, x + 5, top, 'metal_dark');
    fill(grid, x, top + 1, x + 4, top + 1, 'metal_pale');
  }
  return grid;
}

// --- Capacity: a bigger hopper -----------------------------------------------------------
//
// A funnel on the roof whose MOUTH widens with level while its throat stays put. Widening
// the mouth rather than scaling the whole shape is what makes the three read as one hopper
// growing rather than three different hoppers.

const HOPPER = { body: 'metal_light', rim: 'metal_dark', lit: 'metal_pale' };

function capacity(level) {
  const grid = blank();
  const mouth = 6 + level * 4; // half-width of the opening: 10, 14, 18
  const throat = 4;
  const top = 12 - level * 2;
  const rows = 15 - top;

  for (let i = 0; i <= rows; i++) {
    const t = i / rows;
    const half = Math.round(mouth / 2 + (throat / 2 - mouth / 2) * t);
    const y = top + i;
    const x0 = 16 - half;
    const x1 = 15 + half;
    fill(grid, x0, y, x1, y, HOPPER.body);
    grid[y][x0] = HOPPER.rim;
    grid[y][x1] = HOPPER.rim;
    if (x1 - x0 >= 3) grid[y][x0 + 1] = HOPPER.lit;
  }
  fill(grid, 16 - Math.round(mouth / 2), top, 15 + Math.round(mouth / 2), top, HOPPER.rim);
  return grid;
}

// --- Efficiency: green trim ---------------------------------------------------------------
//
// A painted band along the machine's skirt. Green because the palette has exactly one green
// that is not spoken for by a status lamp — `lamp_running` is reserved so a lamp never reads
// as foliage, and by the same token trim must never read as a lamp. Level buys length, then
// a second stripe.

const TRIM = { body: 'leaf_light', rim: 'leaf_deep', lit: 'leaf_pale' };

function efficiency(level) {
  const grid = blank();
  // Kept inside the machine's own silhouette rather than run to the sprite's full width:
  // a band wider than the chassis stops reading as paint on the machine and starts reading
  // as a rug underneath it. Machine bodies here are ~26px across at their widest, so the
  // top level stops at 20 and the skirt still shows on both sides.
  const half = 4 + level * 2; // 6, 8, 10 -> bands 12, 16, 20 wide
  box(grid, 16 - half, 24, 15 + half, 26, TRIM);
  if (level === 3) box(grid, 16 - 6, 20, 15 + 6, 21, TRIM);
  return grid;
}

// --- emit ----------------------------------------------------------------------------

const DIALS = { speed, capacity, efficiency };

async function write(name, grid) {
  let opaque = 0;
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
      opaque++;
    });
  });

  const png = await sharp(raw, { raw: { width: SIZE, height: SIZE, channels: 4 } })
    .png({ palette: false, compressionLevel: 9 })
    .toBuffer();
  writeFileSync(resolve(HERE, `../local/${name}.png`), png);
  console.log(`Wrote art/local/${name}.png — ${SIZE}x${SIZE}, ${opaque}px opaque, ${png.length} bytes.`);
  return opaque;
}

for (const [dial, draw] of Object.entries(DIALS)) {
  let previous = 0;
  for (const level of LEVELS) {
    const opaque = await write(`decal_${dial}_${level}`, draw(level));
    // The design claim is "an upgraded machine looks upgraded". If a higher level did not
    // put MORE paint on the sprite, it does not, and no amount of intent fixes that.
    if (opaque <= previous) {
      throw new Error(
        `decal_${dial}_${level} is not visibly more than level ${level - 1} ` +
          `(${opaque}px vs ${previous}px opaque). A dial the player cannot see is a dial ` +
          `that only half works.`,
      );
    }
    previous = opaque;
  }
}
