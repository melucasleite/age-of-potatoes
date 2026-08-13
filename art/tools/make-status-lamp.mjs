// Authors the SEVEN status lamps — one SHAPE per `LampState`, still tinted per state in code.
//
// ── WHY THERE ARE SEVEN SPRITES NOW AND THERE USED TO BE ONE ────────────────────────────
//
// The old file emitted a single 4x4 bead, and §13's argument for that was sound as far as it
// went: one sprite multiplied by a lamp colour gives thirty machines' worth of state
// animation for the cost of one frame, and it keeps the lamps off the machine atlas page.
//
// What it cannot do is tell a colourblind player anything. §16 lists "colourblind-safe
// machine status (lamp SHAPE variation, not colour alone, on a deliberately warm limited
// palette)" as a known gap, and the palette makes it worse than average rather than better:
// starved amber (#f2a93b) and blocked red (#d94f36) are NEIGHBOURS, deliberately, because a
// warm limited palette is the look. Under deuteranopia they are close to the same colour.
// Under greyscale they are the same 4x4 bead at two luminances — literally zero bits.
//
// Seven sprites of 7x7 costs 343 pixels total. The batch is unchanged (one page, one
// TextureSource, ordinary sprites), the tint is unchanged, and the SHAPE now carries the
// state while the colour reinforces it. That is §16's requirement stated exactly.
//
// ── WHY THE SHAPES ARE THESE SHAPES ─────────────────────────────────────────────────────
//
// Silhouette first, mnemonic second, because silhouette is the part that survives greyscale:
//
//   off       one pixel      the smallest mark there is; a lamp that is not lit
//   running   a disc         round and smooth, the only fully round shape in the set
//   starved   a triangle up  points upstream, which is where §5 says to look
//   blocked   a bar          a barrier laid across the outlet; look downstream
//   utility   a droplet      the missing utility in v0.1 is water, and it points down
//   jammed    an X           struck through — right-click to whack it
//   halted    a hollow box   an empty frame; stopped dead at zero condition
//
// The MEANINGS are §5's and are not touched. Blocked and Jammed keep the same red on purpose
// (§5 says jammed IS the red blocked lamp plus an icon) — inventing an eighth hue to separate
// them would be solving a shape problem with colour, which is the exact mistake this file
// exists to undo. A bar and an X are not confusable in any simulation.
//
// ── THE ASSERTIONS ──────────────────────────────────────────────────────────────────────
//
// make-pipes.mjs asserts its geometric invariants because that class of bug was found twice
// by eye and never by review. The equivalent invariant here is DISTINGUISHABILITY, and it is
// checkable: two shapes are safely tellable apart in greyscale when their lit masks differ in
// enough pixels. That is asserted over all 21 pairs on every build, so "these two look a bit
// alike at 7px" fails the build rather than shipping.
//
// The core is `paper`, the palette's lightest value, so a multiply tint lands on the intended
// hue rather than a muddied one — and the renderer divides the target hue by `paper` so the
// pixel on screen is EXACTLY the palette's declared status colour (see render/tint.ts).
// The `ink` halo is what keeps a pale lamp legible on a pale machine.

import { writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { loadMaster } from './palette-png.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The lit shape is authored in a 5x5 box; the ink halo needs one pixel all round. */
const CORE = 5;
const SIZE = CORE + 2;

/**
 * The shapes, in `LampState` order. `#` is lit core, `.` is nothing.
 *
 * Keyed by the sim's own state names (`packages/sim/src/view.ts`) so the correspondence is
 * readable here; the renderer's `Record<LampState, string>` is what makes TypeScript fail the
 * build if a state ever arrives without a shape.
 */
const SHAPES = {
  off: ['.....', '.....', '..#..', '.....', '.....'],
  running: ['.###.', '#####', '#####', '#####', '.###.'],
  starved: ['..#..', '..#..', '.###.', '.###.', '#####'],
  blocked: ['.....', '.....', '#####', '#####', '.....'],
  utility: ['.###.', '#####', '.###.', '..#..', '..#..'],
  jammed: ['#...#', '.#.#.', '..#..', '.#.#.', '#...#'],
  halted: ['#####', '#...#', '#...#', '#...#', '#####'],
};

/**
 * How many pixels two lit shapes must differ by.
 *
 * Six of 25 is a quarter of the box. Below that the pair reads as "the same lamp, slightly
 * different" at 7px, which is worse than either a clear difference or none at all — a player
 * who is not sure whether two lamps differ has to go and check, and checking is the cost this
 * whole feature exists to remove.
 */
const MIN_DIFFERENCE = 6;

const NAMES = Object.keys(SHAPES);

const { swatches } = loadMaster();
const hexOf = (name) => {
  const found = swatches.find((swatch) => swatch.name === name);
  if (!found) throw new Error(`Master palette has no colour named "${name}".`);
  return found.hex;
};

// --- the guarantees, asserted rather than eyeballed --------------------------------------

if (NAMES.length !== 7) {
  throw new Error(`Expected seven lamp shapes, one per LampState; found ${NAMES.length}.`);
}

/** A shape as a flat boolean array over the 5x5 core box. */
function maskOf(name) {
  const rows = SHAPES[name];
  if (rows.length !== CORE) {
    throw new Error(`Lamp "${name}" has ${rows.length} rows; the core box is ${CORE}.`);
  }
  const mask = [];
  for (const row of rows) {
    if (row.length !== CORE) {
      throw new Error(`Lamp "${name}" has a ${row.length}px row; the core box is ${CORE}.`);
    }
    for (const glyph of row) {
      if (glyph !== '#' && glyph !== '.') {
        throw new Error(`Lamp "${name}" uses "${glyph}"; only "#" and "." are shape pixels.`);
      }
      mask.push(glyph === '#');
    }
  }
  return mask;
}

const MASKS = new Map(NAMES.map((name) => [name, maskOf(name)]));

/** Nothing may be invisible. A lamp drawn as no pixels is a state the player never sees. */
for (const [name, mask] of MASKS) {
  if (!mask.some(Boolean)) throw new Error(`Lamp "${name}" is empty — it would draw nothing.`);
}

/**
 * THE DISTINGUISHABILITY LAW, over all 21 pairs.
 *
 * This is the criterion of the work item made mechanical: "each of the seven LampState values
 * gets a distinct shape, distinguishable in greyscale". Greyscale erases the tint and leaves
 * exactly this mask, so the symmetric difference between two masks IS how much information
 * survives for a player who cannot use the colour.
 */
for (let i = 0; i < NAMES.length; i++) {
  for (let j = i + 1; j < NAMES.length; j++) {
    const a = MASKS.get(NAMES[i]);
    const b = MASKS.get(NAMES[j]);
    let differ = 0;
    for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) differ += 1;
    if (differ < MIN_DIFFERENCE) {
      throw new Error(
        `Lamps "${NAMES[i]}" and "${NAMES[j]}" differ by only ${differ} pixel(s) — under ` +
          `${MIN_DIFFERENCE} they read as the same lamp in greyscale, which is the whole ` +
          `point of having shapes at all.`,
      );
    }
  }
}

// --- emit ---------------------------------------------------------------------------------

/**
 * The 7x7 frame: the lit core in `paper`, and an `ink` halo on every pixel touching it.
 *
 * The halo is a full 8-neighbour dilation, so the negative space inside an X or a hollow box
 * fills with ink rather than showing the machine through it. That is deliberate and it makes
 * those two shapes MORE legible, not less: a bright figure on its own dark ground reads at
 * any zoom and over any machine, which a bright figure alone does not.
 */
function frameOf(name) {
  const mask = MASKS.get(name);
  const lit = (x, y) => x >= 0 && y >= 0 && x < CORE && y < CORE && mask[y * CORE + x];
  const grid = [];
  for (let y = 0; y < SIZE; y++) {
    const row = [];
    for (let x = 0; x < SIZE; x++) {
      const cx = x - 1;
      const cy = y - 1;
      if (lit(cx, cy)) {
        row.push('paper');
        continue;
      }
      let touching = false;
      for (let dy = -1; dy <= 1 && !touching; dy++) {
        for (let dx = -1; dx <= 1 && !touching; dx++) {
          if (lit(cx + dx, cy + dy)) touching = true;
        }
      }
      row.push(touching ? 'ink' : null);
    }
    grid.push(row);
  }
  return grid;
}

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
  const file = `lamp_${name}.png`;
  writeFileSync(resolve(HERE, `../local/${file}`), png);
  console.log(`Wrote art/local/${file} — ${SIZE}x${SIZE}, ${png.length} bytes.`);
}

for (const name of NAMES) await write(name, frameOf(name));

// The one-bead era. Leaving it on disk leaves a plausible-looking lamp for someone to pack by
// mistake, and the renderer no longer asks for the name.
const stale = resolve(HERE, '../local/status_lamp.png');
if (existsSync(stale)) {
  unlinkSync(stale);
  console.log('Removed art/local/status_lamp.png — superseded by the seven lamp shapes.');
}
