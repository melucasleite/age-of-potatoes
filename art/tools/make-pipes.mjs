// Authors the six pipe frames the renderer asks for:
//   pipe_stub, pipe_cap, pipe_straight, pipe_corner, pipe_tee, pipe_cross.
//
// WHY THESE ARE ARITHMETIC AND NOT PROMPTS
//
// The same argument make-factory-parts.mjs makes for belts, and it is stronger here. A pipe
// network is the one thing in this game where the art has to satisfy a *joinery* contract,
// not merely look right:
//
//   * A straight pipe repeats along its run. Any mismatch between column 0 and column 15
//     repeats every 16px in a row — the most visible artefact a tiling texture can have.
//   * A corner has to MEET a straight. The cross-section where an arm leaves the tile must
//     be identical, pixel for pixel, on every frame that has an arm on that side, or every
//     bend and every tee in the network shows a visible jog.
//   * The renderer draws six frames and ROTATES them in quarter turns to cover all sixteen
//     neighbour masks (`apps/web/src/game/render/pipe-shape.ts`). So the art must be turnable:
//     a frame turned 90 degrees has to land exactly on the frame for the turned mask.
//
// None of those are things a diffusion model can be asked for. They are, however, assertions
// that run every time this file does — including the rotation law, which is checked over all
// sixteen masks below. The measured evidence for reaching for `provider: "local"` here is
// already in the repo: two paid takes at the belt corner came back as "a brown scribble on a
// background that quantised to violet".
//
// WHAT CHANGED, AND WHY THE OLD SET COULD NOT SHIP
//
// This file used to author three frames — straight, corner and `pipe_junction` — and none of
// the three could be packed as they were:
//
//   1. The renderer asks for SIX frames by name (`ART.pipeFrame`, and `PIPE_FRAMES` in
//      pipe-shape.ts): stub, cap, straight, corner, tee, cross. `pipe_junction` is not a name
//      it ever asks for, and stub/cap/cross had no art at all.
//   2. The renderer's canonical corner is EAST-to-SOUTH. The old corner was drawn WEST-to-
//      SOUTH — one quarter turn out — so every bend in the game would have been drawn facing
//      the wrong way while looking perfectly deliberate.
//   3. The old art was TOP-LIT (a pale highlight along the top of the run). A top-lit tile
//      turned three quarters is a bottom-lit tile, so the light would have swung around the
//      compass as pipes turned corners. The shading here is CONCENTRIC for that reason —
//      exactly the reasoning the renderer's own placeholder records — and concentric shading
//      is rotation-invariant by construction.
//
// The values are the placeholder's values on purpose: metal_dark rim, metal_pale body, paper
// core. The pipe layer MULTIPLIES the sprite by its liquid's colour, so the art must be
// near-neutral and bright — art baked amber would make water a muddy teal — and matching what
// is already on screen means the atlas landing is a promotion, not a redesign.
//
// A pipe is NOT drawn on a solid plate. A belt is a machine you walk items along and fills
// its tile; a pipe is a tube lying on the ground with the ground showing around it. That
// contrast is §5's "belt cathedral next to a pipe organ" and it is worth more than detail.

import { unlinkSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { loadMaster } from './palette-png.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SIZE = 16;

/**
 * Working canvas margin. Arms are drawn out past the tile edge and the result is cropped
 * back, so a pixel on the tile boundary sees the run CONTINUING rather than ending. Without
 * it the shading would put a dark rim across every tile seam — a bead every 16px down a
 * straight run, which is the artefact this whole file exists to prevent.
 */
const PAD = 4;
const CANVAS = SIZE + PAD * 2;

const { swatches } = loadMaster();
const hexOf = (name) => {
  const found = swatches.find((swatch) => swatch.name === name);
  if (!found) throw new Error(`Master palette has no colour named "${name}".`);
  return found.hex;
};

/**
 * Depth → colour, outermost first. Read off the renderer's placeholder (`PIPE` in
 * textures.ts) so the shipped frame and the fallback frame are the same picture.
 *
 * Concentric, never top-lit: see the header. Depth is capped at the last entry, so the
 * inside of a bend and the middle of a cross both read as the same lit core.
 */
const SHADE = ['metal_dark', 'metal_pale', 'paper'];

/** Half-width of the run: rows 5..10 of 16, symmetric about the tile centre. */
const THICKNESS = 6;
const LOW = (SIZE - THICKNESS) >> 1;
const HIGH = LOW + THICKNESS - 1;

if ((SIZE - THICKNESS) % 2 !== 0) {
  throw new Error(`A ${THICKNESS}px run cannot be centred in ${SIZE}px without a half pixel.`);
}

/** Neighbour bits, in the same order and with the same values pipe-shape.ts uses. */
const N = 1;
const E = 2;
const S = 4;
const W = 8;

/**
 * The canonical mask of each frame — the SAME table as `CANONICAL` in pipe-shape.ts, and it
 * has to stay that way. Everything points east first: a cap reaches east, a corner joins east
 * to south, a tee is the one missing its north arm.
 */
const FRAMES = [
  ['pipe_stub', 0],
  ['pipe_cap', E],
  ['pipe_straight', E | W],
  ['pipe_corner', E | S],
  ['pipe_tee', E | S | W],
  ['pipe_cross', N | E | S | W],
];

/** Turn a mask one quarter clockwise: N→E→S→W→N. Same arithmetic as the renderer's. */
function rotateMask(mask) {
  return ((mask << 1) | (mask >> 3)) & 0b1111;
}

/** Turn a grid one quarter clockwise. `out[r][c] = grid[n-1-c][r]` — top row becomes right column. */
function rotateGrid(grid) {
  const n = grid.length;
  return Array.from({ length: n }, (_, r) =>
    Array.from({ length: n }, (_, c) => grid[n - 1 - c][r]),
  );
}

/**
 * The solid shape of a mask on the padded canvas: a centre block, plus an arm out through
 * each connected side. Arms run past the canvas edge, which is what `PAD` is for.
 */
function shapeOf(mask) {
  const filled = Array.from({ length: CANVAS }, () => new Array(CANVAS).fill(false));
  const lo = PAD + LOW;
  const hi = PAD + HIGH;
  const box = (fromY, toY, fromX, toX) => {
    for (let y = fromY; y <= toY; y++) for (let x = fromX; x <= toX; x++) filled[y][x] = true;
  };

  // The hub is on EVERY frame, including the stub. An isolated pipe tile is a flange with no
  // run — which is exactly what a one-tile pipe is, and is what the renderer draws for mask 0.
  box(lo, hi, lo, hi);
  if (mask & N) box(0, hi, lo, hi);
  if (mask & E) box(lo, hi, lo, CANVAS - 1);
  if (mask & S) box(lo, CANVAS - 1, lo, hi);
  if (mask & W) box(lo, hi, 0, hi);
  return filled;
}

/**
 * How deep each pixel sits inside the shape, by 4-neighbour erosion, capped at the last
 * shade.
 *
 * Off-canvas counts as FILLED: an arm that leaves the canvas is a run that continues into the
 * next tile, not an end. That is the whole reason the straight tiles seamlessly, and it is
 * why the cap and the stub — whose ends are inside the tile — are the only frames that get a
 * rim across the run.
 */
function depthsOf(filled) {
  const depth = Array.from({ length: CANVAS }, () => new Array(CANVAS).fill(-1));
  let current = filled.map((row) => [...row]);

  for (let level = 0; level < SHADE.length; level++) {
    const next = current.map((row) => [...row]);
    for (let y = 0; y < CANVAS; y++) {
      for (let x = 0; x < CANVAS; x++) {
        if (!current[y][x]) continue;
        const last = level === SHADE.length - 1;
        const inside = (yy, xx) =>
          yy < 0 || xx < 0 || yy >= CANVAS || xx >= CANVAS ? true : current[yy][xx];
        const edge =
          !inside(y - 1, x) || !inside(y + 1, x) || !inside(y, x - 1) || !inside(y, x + 1);
        if (edge || last) {
          if (depth[y][x] === -1) depth[y][x] = level;
          if (!last) next[y][x] = false;
        }
      }
    }
    current = next;
  }
  return depth;
}

/** One frame, cropped back to the tile. `null` is transparent — the ground shows through. */
function render(mask) {
  const depth = depthsOf(shapeOf(mask));
  return Array.from({ length: SIZE }, (_, y) =>
    Array.from({ length: SIZE }, (_, x) => {
      const d = depth[y + PAD][x + PAD];
      return d === -1 ? null : SHADE[Math.min(d, SHADE.length - 1)];
    }),
  );
}

// --- the guarantees, asserted rather than eyeballed ------------------------------------

const drawn = new Map(FRAMES.map(([name, mask]) => [name, render(mask)]));
const straight = drawn.get('pipe_straight');

/**
 * THE ROTATION LAW, over all sixteen masks.
 *
 * The renderer covers sixteen neighbour masks with six frames by turning them in quarter
 * turns, so "the art for a turned mask" and "the art turned" have to be the same picture. A
 * violation here is the failure this file exists to make impossible: a pipe that LOOKS
 * connected and is not. Checking all sixteen rather than the six canonical ones is what
 * catches an asymmetric highlight, which is invisible on the frame it was drawn for.
 */
for (let mask = 0; mask < 16; mask++) {
  const turned = rotateGrid(render(mask));
  const expected = render(rotateMask(mask));
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (turned[y][x] !== expected[y][x]) {
        throw new Error(
          `Mask ${mask} turned one quarter clockwise does not match mask ${rotateMask(mask)} ` +
            `at ${x},${y}: "${turned[y][x]}" vs "${expected[y][x]}".`,
        );
      }
    }
  }
}

/** A straight run must not seam: every column of it is the same column. */
for (let x = 0; x < SIZE; x++) {
  for (let y = 0; y < SIZE; y++) {
    if (straight[y][x] !== straight[y][0]) {
      throw new Error(`pipe_straight is not uniform along its run: column ${x}, row ${y}.`);
    }
  }
}

/**
 * Every arm that leaves a tile presents the straight's cross-section, and every side that has
 * no arm is empty to the tile edge. The first half is why bends do not jog; the second is why
 * a cap reads as an end rather than as a run that quietly stops.
 */
const SECTION = straight.map((row) => row[0]);
const edgeOf = {
  [N]: (grid) => [...grid[0]],
  [S]: (grid) => [...grid[SIZE - 1]],
  [W]: (grid) => grid.map((row) => row[0]),
  [E]: (grid) => grid.map((row) => row[SIZE - 1]),
};

for (const [name, mask] of FRAMES) {
  const grid = drawn.get(name);
  for (const side of [N, E, S, W]) {
    const edge = edgeOf[side](grid);
    const want = mask & side ? SECTION : new Array(SIZE).fill(null);
    if (edge.join('|') !== want.join('|')) {
      throw new Error(
        `${name} has the wrong cross-section on side ${side}: expected ` +
          `${mask & side ? 'the straight run' : 'nothing'}, got ${edge.join('|')}.`,
      );
    }
  }
}

// --- the collar, which is the same picture as the run ----------------------------------
//
// `ui_pipe_nub` is drawn where a real pipe touches a machine's edge, tinted with whatever
// that pipe is carrying (`updatePorts`, apps/web/src/game/render/index.ts). It is authored
// HERE rather than anywhere else because the only thing it must get right is the one thing
// this file already computes: the run's cross-section. A collar a pixel narrower than the
// pipe it collars puts a visible step at every port in the game, on every face.
//
// So it is not drawn at all — it IS the stub's hub, cropped to the run's width. Same shape
// function, same erosion, same three shades, so it cannot drift from the frames it butts
// against no matter how either of them changes later.
//
// The renderer draws it UNROTATED on all four faces from one texture, and centres it on the
// tile centre the run is centred on. Two things follow, both asserted rather than assumed:
// it must be its own quarter turn (concentric shading gives that, but a stray highlight
// would be invisible on the face it was drawn for and wrong on the other three), and it
// must be exactly THICKNESS across, or "centred" and "flush" stop meaning the same thing.
const nub = render(0)
  .slice(LOW, HIGH + 1)
  .map((row) => row.slice(LOW, HIGH + 1));

if (nub.length !== THICKNESS || nub.some((row) => row.length !== THICKNESS)) {
  throw new Error(`ui_pipe_nub must be ${THICKNESS}x${THICKNESS} to sit flush on the run.`);
}

/** A collar is solid. A hole in it would show the machine through the plumbing. */
for (let y = 0; y < THICKNESS; y++) {
  for (let x = 0; x < THICKNESS; x++) {
    if (nub[y][x] === null) throw new Error(`ui_pipe_nub has a transparent pixel at ${x},${y}.`);
  }
}

/**
 * The centre band, both ways, is the straight's own cross-section — which is what makes a
 * collar meet a pipe flush instead of nearly. `SECTION` is a whole 16px column, mostly empty
 * either side of the run, so the comparison is against the run itself. Both middle rows,
 * because a 6px run has two.
 */
const RUN_SECTION = SECTION.slice(LOW, HIGH + 1);
for (const offset of [THICKNESS / 2 - 1, THICKNESS / 2]) {
  const row = nub[offset];
  const column = nub.map((r) => r[offset]);
  if (row.join('|') !== RUN_SECTION.join('|') || column.join('|') !== RUN_SECTION.join('|')) {
    throw new Error(
      `ui_pipe_nub band ${offset} is not the pipe's cross-section: ` +
        `row ${row.join('|')}, column ${column.join('|')}, run ${RUN_SECTION.join('|')}.`,
    );
  }
}

/** One texture, four faces, no rotation at draw time — so the art has to be its own turn. */
const turnedNub = rotateGrid(nub);
for (let y = 0; y < THICKNESS; y++) {
  for (let x = 0; x < THICKNESS; x++) {
    if (turnedNub[y][x] !== nub[y][x]) {
      throw new Error(`ui_pipe_nub is not rotation-invariant at ${x},${y} — it would be lit
        differently on each face of a machine.`);
    }
  }
}

/** Nothing may be drawn off the master palette — every colour here is a swatch name. */
for (const grid of [...drawn.values(), nub]) {
  for (const row of grid) {
    for (const role of row) {
      if (role !== null) hexOf(role);
    }
  }
}

// --- emit -----------------------------------------------------------------------------

async function write(name, grid) {
  const height = grid.length;
  const width = grid[0].length;
  const raw = Buffer.alloc(width * height * 4);
  grid.forEach((row, y) => {
    row.forEach((role, x) => {
      if (!role) return;
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
  writeFileSync(resolve(HERE, `../local/${name}.png`), png);
  console.log(`Wrote art/local/${name}.png — ${width}x${height}, ${png.length} bytes.`);
}

for (const [name] of FRAMES) await write(name, drawn.get(name));
await write('ui_pipe_nub', nub);

// The old three-frame set had a name the renderer never asks for. Leaving it on disk would
// leave a plausible-looking pipe tile lying around for someone to pack by mistake.
const stale = resolve(HERE, '../local/pipe_junction.png');
if (existsSync(stale)) {
  unlinkSync(stale);
  console.log('Removed art/local/pipe_junction.png — superseded by pipe_tee.png.');
}
