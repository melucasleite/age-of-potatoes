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
const SIZE = 32;

/**
 * Pixels per 16px-era pixel.
 *
 * Every shape in this file is still authored in the original 16px vocabulary and multiplied
 * up at the point of use, which is deliberate: the geometry below is a set of PROOFS (seam
 * matching, mirror symmetry, edge cross-sections) that were reasoned out at 16px and are
 * known to hold there. Scaling the inputs rather than re-deriving the outputs means the
 * proofs come along unchanged, and the next resolution bump is this one line.
 */
const SCALE = SIZE / 16;

/** Authored-at-16px coordinates, in tile pixels. */
const scaled = (...xs) => xs.map((x) => x * SCALE);

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

const RAIL_THICKNESS = 3 * SCALE;
/**
 * THE PERIOD SCALES WITH THE TILE, AND THAT IS A DESIGN RULING RATHER THAN AN OVERSIGHT.
 *
 * The tempting move at higher resolution is to hold the period and get twice as many arrows
 * — more detail for free. Here that would be a bug, because on this belt the ARROW COUNT IS
 * LOAD-BEARING. Work item 082 makes it the colourblind signal: one arrow Basic, two Fast,
 * three Express, so a player who cannot separate the yellow, red and blue liveries counts
 * instead. Holding the period would put FOUR arrows on the neutral tile while a Basic belt
 * still showed one — the plainest belt in the game reading as faster than Express.
 *
 * So chevrons stay locked to the tile and are drawn twice as large. Density per TILE is the
 * invariant; density per pixel is not.
 */
const CHEVRON_PERIOD = 8 * SCALE;
const CHEVRON_WIDTH = 4 * SCALE;
const BAND_TOP = RAIL_THICKNESS;
const BAND_BOTTOM = SIZE - RAIL_THICKNESS - 1;
const BAND_MID = (BAND_TOP + BAND_BOTTOM) >> 1;

if (SIZE % CHEVRON_PERIOD !== 0) {
  throw new Error(`Chevron period ${CHEVRON_PERIOD} does not divide ${SIZE} — the belt seams.`);
}

/**
 * How far a triangle has narrowed by column `d`.
 *
 * The taper holds one step per SCALE columns, so the silhouette is the 16px triangle's
 * silhouette exactly rather than a steeper one. Tapering every column instead would run a
 * 4*SCALE-wide arrow to a point in four columns and leave the rest of it empty.
 */
const taperAt = (d) => SCALE * Math.floor(d / SCALE);

/** Half-height of a chevron's base, above and below BAND_MID. */
const CHEVRON_UP = 3 * SCALE;
const CHEVRON_DOWN = 3 * SCALE + (SCALE - 1);

/** A fat right-pointing triangle: 4*SCALE columns wide, tapering to a point. */
function chevronCells(x0) {
  const cells = [];
  for (let dx = 0; dx < CHEVRON_WIDTH; dx++) {
    const taper = taperAt(dx);
    for (let y = BAND_MID - CHEVRON_UP + taper; y <= BAND_MID + CHEVRON_DOWN - taper; y++) {
      cells.push([x0 + dx, y]);
    }
  }
  return cells;
}

/**
 * The same triangle turned to point SOUTH, with its top-left at row `y0`. Three frames drew
 * this by hand from the same four numbers; at two resolutions that is three places to get the
 * taper wrong, so it is one function now.
 */
function chevronCellsDown(y0) {
  const cells = [];
  for (let dy = 0; dy < CHEVRON_WIDTH; dy++) {
    const taper = taperAt(dy);
    for (let x = BAND_MID - CHEVRON_UP + taper; x <= BAND_MID + CHEVRON_DOWN - taper; x++) {
      cells.push([x, y0 + dy]);
    }
  }
  return cells;
}

/**
 * Where a departing arrow starts, so it clears the tile's south edge by SCALE pixels — the
 * seam proof restated: an arrow touching the edge repeats down every vertical run.
 */
const DEPARTING_Y = SIZE - CHEVRON_WIDTH - SCALE;

function blankGrid() {
  return Array.from({ length: SIZE }, () => new Array(SIZE).fill('.'));
}

function beltStraight() {
  const grid = blankGrid();
  for (let y = 0; y < SIZE; y++) {
    const rail = y < BAND_TOP || y > BAND_BOTTOM;
    for (let x = 0; x < SIZE; x++) grid[y][x] = rail ? 'L' : 'D';
  }
  for (let x0 = 2 * SCALE; x0 < SIZE; x0 += CHEVRON_PERIOD) {
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

const ARM_LOW = 3 * SCALE;
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
  for (const [x, y] of chevronCellsDown(DEPARTING_Y)) grid[y][x] = 'P';
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
  for (let x0 = 2 * SCALE; x0 < SIZE; x0 += CHEVRON_PERIOD) {
    for (const [x, y] of chevronCells(x0)) {
      if (x < SIZE) grid[y][x] = 'P';
    }
  }
  // One departing arrow on the branch, pointing down, so a tee is never ambiguous about
  // which of its three arms is the odd one out.
  for (const [x, y] of chevronCellsDown(DEPARTING_Y)) grid[y][x] = 'P';
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
  basic: { rail: 'Y', railDark: 'T', chev: 'G', chevronXs: scaled(6) },
  fast: { rail: 'R', railDark: 'E', chev: 'O', chevronXs: scaled(2, 10) },
  express: { rail: 'B', railDark: 'W', chev: 'Q', chevronXs: scaled(1, 6, 11) },
};

// No chevron column may come within SCALE of a tile edge — the seam proof, checked not
// assumed. The margin scales because "one pixel clear" at 16px means "one 16px-era pixel
// clear", not "one of however many pixels the tile now has".
for (const [tier, livery] of Object.entries(LIVERIES)) {
  for (const x0 of livery.chevronXs) {
    if (x0 < SCALE || x0 + CHEVRON_WIDTH - 1 > SIZE - 1 - SCALE) {
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

// The entering-arrow phases the tier corner puts on its horizontal leg, keyed by the tier's
// chevron count: none for Basic, one for Fast, two for Express. Never at x=0 — an arrow
// touching the entry edge would break the edge-match assertions below (the neutral corner
// predates that check and keeps its edge-hugging arrow). Shared with the tee further down,
// so the two frames' through runs are literally the same arrows rather than two lists that
// have to be kept in step by hand.
const ENTERING_XS = { 1: [], 2: scaled(1), 3: scaled(1, 6) };

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
  // Entering arrows (pointing right) on the horizontal leg — the departing arrow below
  // completes the 1 / 2 / 3 count.
  for (const x0 of ENTERING_XS[livery.chevronXs.length]) {
    for (const [x, y] of chevronCells(x0)) {
      if (x < SIZE) grid[y][x] = livery.chev;
    }
  }
  // The departing arrow, pointing down the vertical leg — every tier has this one.
  for (const [x, y] of chevronCellsDown(DEPARTING_Y)) grid[y][x] = livery.chev;
  return grid;
}

// --- the tier tees (work item 095) -----------------------------------------------------
//
// A belt network branches two ways, and the neutral junction only draws one of them. Two
// more frames per tier, and the arrows are the whole difference between them:
//
//   belt_<tier>_tee        THE SIDE FEED — goods run west to east straight through the
//                          tile, and a second line JOINS from the south.
//   belt_<tier>_tee_merge  THE HEAD-ON MERGE — goods arrive from BOTH west and east and
//                          leave together through the south.
//
// Both take the neutral junction's plate exactly: the through band is open WEST<->EAST
// (rows ARM_LOW..ARM_HIGH), the branch arm is open SOUTH (cols ARM_LOW..ARM_HIGH from
// ARM_LOW down), and NORTH is closed plate — so four rotations of these two tiles reach
// every three-armed tee a grid can contain. The plate is coloured the way beltTierCorner
// colours it, livery.rail with a one-pixel livery.railDark ring wherever plate meets band,
// which is what makes a tee sit beside a corner and a straight as the same object rather
// than a cousin of one. It is also what makes the edge assertions below pass.
//
// The chevron count is still the tier count, 1 / 2 / 3 (082's colourblind rule, house law),
// and the two frames spend it differently on purpose:
//
//   * The TEE spends it the way the corner does: the corner's entering arrows on the
//     through run, plus EXACTLY ONE arrow on the south arm pointing NORTH — up, into the
//     run. A side feed's whole meaning is "this arm joins; it does not leave", and an arrow
//     pointing the other way would make it a splitter.
//   * The MERGE stacks the whole count DOWN the south stem pointing out, and leaves both
//     the west and the east arm deliberately bare. They are interchangeable feeders, and an
//     arrow on one of them would read as the preferred one; the precedent for a bare arm is
//     the basic corner, which carries no entering arrow either. Bare arms are also what let
//     this tile be asserted MIRROR-SYMMETRIC LEFT-TO-RIGHT below, which is that argument
//     restated as something the build can fail on.
//
// WHY THE STEM ARROW HAS AN EIGHT-PIXEL BASE WHERE THE CORNER'S HAS SEVEN: the corner's
// departing arrow is chevronCells transposed, so it inherits the horizontal chevron's ODD
// width and sits centred on BAND_MID, column 7. A 16px tile mirrors about 7.5, so an
// odd-width arrow is mirror-symmetric at no width at all and the merge's symmetry assertion
// would be unsatisfiable by construction. The stem arrow is therefore the same triangle
// widened by one pixel to an even base. It costs nothing — cols 4..11 still clear the arm
// walls at cols 3 and 12 by a pixel each side — and it keeps the corner's ROWS exactly, so
// Basic's single merge arrow lands on the same four rows the corner's departing arrow
// occupies. Rows are the part the eye reads as "same family"; the half-pixel is not.

// Stem arrow row offsets, top to bottom. A tier takes the LAST n of these, so every tier's
// bottom-most arrow sits on the corner's departing rows and the extras stack upward.
// Derived from DEPARTING_Y rather than written out, so the bottom-most stem arrow lands on
// the corner's departing rows BY CONSTRUCTION at any resolution. The old literals happened to
// agree at 16px; two hand-kept lists that must agree is one list too many.
const STEM_CHEVRON_YS = [DEPARTING_Y - 2 * CHEVRON_WIDTH, DEPARTING_Y - CHEVRON_WIDTH, DEPARTING_Y];

/**
 * The stem arrow: a fat triangle CHEVRON_WIDTH rows tall on an 8-wide base, centred on the
 * tile's mirror axis. `pointing` is 'south' (apex at the bottom, goods leaving) or 'north'
 * (apex at the top, goods joining).
 */
function stemChevronCells(y0, pointing) {
  const cells = [];
  for (let dy = 0; dy < CHEVRON_WIDTH; dy++) {
    const step = taperAt(dy);
    const taper = pointing === 'south' ? step : CHEVRON_WIDTH - SCALE - step;
    for (let x = BAND_MID - CHEVRON_DOWN + taper; x <= BAND_MID + 4 * SCALE - taper; x++) {
      cells.push([x, y0 + dy]);
    }
  }
  return cells;
}

/** The plate both tees share: band through west<->east, arm out south, north closed. */
function beltTierTeePlate(livery) {
  const grid = blankGrid();
  const inArms = (x, y) => {
    const through = y >= ARM_LOW && y <= ARM_HIGH;
    const branch = x >= ARM_LOW && x <= ARM_HIGH && y >= ARM_LOW;
    return through || branch;
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
  return grid;
}

/** The side feed: the corner's through-run arrows, plus one arrow joining from the south. */
function beltTierTee(livery) {
  const grid = beltTierTeePlate(livery);
  // The through run carries the corner's entering arrows, phase and all, so a tee and a
  // bend fed by the same belt agree about where the arrows fall.
  for (const x0 of ENTERING_XS[livery.chevronXs.length]) {
    for (const [x, y] of chevronCells(x0)) {
      if (x < SIZE) grid[y][x] = livery.chev;
    }
  }
  // One arrow on the south arm pointing NORTH — the corner's departing arrow transposed and
  // reversed, on the same rows. Through arrows + this one = the tier count, 1 / 2 / 3.
  for (const [x, y] of stemChevronCells(STEM_CHEVRON_YS[STEM_CHEVRON_YS.length - 1], 'north')) {
    grid[y][x] = livery.chev;
  }
  return grid;
}

/** The head-on merge: bare feeding arms, the whole tier count stacked down the south stem. */
function beltTierTeeMerge(livery) {
  const grid = beltTierTeePlate(livery);
  for (const y0 of STEM_CHEVRON_YS.slice(-livery.chevronXs.length)) {
    for (const [x, y] of stemChevronCells(y0, 'south')) grid[y][x] = livery.chev;
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

/**
 * Blow a character grid up by SCALE, one source cell to a SCALE x SCALE block.
 *
 * Used ONLY for the legacy `grabber_arm` below, and worth being honest about: this is nearest-
 * neighbour, so it gains no detail. The frame is superseded by the three tier grabbers
 * (082) and is kept only so an older save asking for it by name still finds a picture.
 * Redrawing a retired sprite at 32px is work spent where nobody is looking.
 */
function upscaleRows(rows) {
  return rows.flatMap((row) => {
    const wide = [...row].flatMap((glyph) => new Array(SCALE).fill(glyph)).join('');
    return new Array(SCALE).fill(wide);
  });
}

// prettier-ignore
const GRABBER_16 = [
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

const GRABBER = upscaleRows(GRABBER_16);

// --- the grabber redesign (work item 082, redrawn at native 32px by work item 135) -----
//
// Owner ruling 2026-08-15: "also reskin the grabbers. I don't like how they look." Owner
// ruling 2026-08-17: "the arms are looking a little low-res, even though the animation is
// perfect. I just want them to look higher resolution." The first ruling built the body
// below; the second is why it is now drawn at 32px instead of at 16px and doubled.
//
// ANSWERING THE SECOND ONE NEEDED A FACT ABOUT THE RENDERER, NOT ABOUT THE ART.
//
// `grabbers.ts` draws the shaft by assigning `visual.upper.width = pose.upperLength` to a
// plain Sprite, and uses the same 8px `link` slice for both the upper arm and the forearm.
// The shaft is therefore STRETCHED along its length — roughly 2x for Mk1 and Mk2 and 4x for
// the Long arm, on top of whatever the zoom is doing. Its other axis is only ever multiplied
// by `heft`, which is an exact integer.
//
// So detail authored across the shaft's COLUMNS is destroyed downstream of this file, and
// detail authored down its ROWS survives pixel-crisp. That is the whole design rule for the
// bar, and it is why "draw it richer" was the wrong instinct: a busier shaft would have been
// smeared exactly as hard as a plain one. The shaft is instead COLUMN-UNIFORM — all eight of
// its columns are identical, asserted at the foot of this file — so the stretch has no
// information left to destroy, and the bar reads as a machined tube at any extension rather
// than as a stripe. Every pixel of its budget is spent on a rounded cross-section: ink edge,
// tier piping, mid body, pale crown, four tones where there were two.
//
// THE TIER SIGNAL MOVED, AND FIXING IT FIXED A BUG.
//
// [[082]] put the tier's TICK COUNT on the shaft (1 / 2 / 3 — the belts' chevron rule in
// grabber vocabulary, so that colour is never the only signal, per [[042]]). Two things were
// wrong with that. The stretch smeared the ticks into stripes, which is what made the Long
// arm read as a ruler. And the Long's third tick was authored at 16px x=11, which lands in
// columns 22-23 — inside the CLAW slice, not the shaft — where the wrist was then drawn over
// the top of it. Counted in the shipped PNGs rather than inferred: Mk1 showed 1 tick, Mk2
// showed 2, and Long showed 2. The colourblind-safe signal could not separate the top two
// tiers at all.
//
// The count is now a stack of 1 / 2 / 3 studs on the housing rim, which is drawn 1:1 and
// never stretched, and the tier's hue additionally runs the FULL LENGTH of the bar as piping
// — a stronger colour signal than a tick was, and a count that survives to the screen.
//
// The two original guarantees are untouched: authored pointing EAST, centred, and mirror-
// symmetric about the horizontal midline, so the renderer's quarter-turns stay wobble-free.
// Symmetry is now structural rather than a property to be checked afterwards — `sym` draws
// every shape together with its own reflection — and the assertion still runs regardless.
//
// The partition `grabber-swing.ts` cuts is preserved exactly, and asserted below: housing in
// columns 0-13 spanning rows 8-23, shaft in 14-21 spanning rows 12-19, claw in 22-31
// spanning rows 8-23. `ARM_SLICE` is a partition of the tile, so a redraw that let a shape
// wander one column into its neighbour would slice the arm apart rather than fail loudly.

function grabberGrid(accent, accentDark, tierCount, hooks) {
  const grid = blankGrid();
  // NATIVE 32px coordinates, unlike everything above. The belts stay in the 16px vocabulary
  // because their seam proofs were derived there and scaling the inputs carries the proofs
  // along; the grabber's only proof is the mirror symmetry, and `sym` makes that structural
  // at any resolution. So this shape is free to spend the full 32px grid, which is the whole
  // point of the redraw: `SCALE`-multiplied art cannot contain a detail finer than SCALE.
  const px = (x, y, w, h, glyph) => {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) grid[yy][xx] = glyph;
    }
  };
  /** Draw a shape and its reflection in the horizontal midline together, as one act. */
  const sym = (x, y, w, h, glyph) => {
    px(x, y, w, h, glyph);
    px(x, SIZE - y - h, w, h, glyph);
  };

  // --- housing: columns 0-13, rows 8-23 ------------------------------------------------
  // A chamfered plate with a bevelled inner lip, a domed pivot boss in the tier's hue, and
  // the tier count as studs on the outer rim. All of it is drawn 1:1 by the renderer, so
  // detail spent here arrives on the screen intact.
  sym(0, 8, 14, 8, 'D'); // plate
  sym(0, 8, 2, 2, '.'); // chamfer the four corners, so the silhouette reads round-ish
  sym(12, 8, 2, 2, '.');
  sym(1, 9, 12, 1, 'L'); // a lit bevel just inside the rim
  sym(2, 10, 10, 6, 'M'); // plate face
  sym(3, 11, 8, 5, 'K'); // the boss is seated in an ink ring rather than sitting on paint
  sym(4, 12, 6, 4, accentDark);
  sym(5, 13, 4, 3, accent);
  sym(6, 15, 2, 1, 'P'); // and crowned, so it reads domed rather than flat
  sym(12, 12, 2, 4, 'D'); // shoulder, meeting the shaft — and stopping at column 13

  // The tier count, as studs on the rim: one centred, two flanking, three being both. Read
  // at 1:1 in any of the four quarter-turns, and symmetric, so the stack never re-orders.
  if (tierCount === 1 || tierCount === 3) sym(0, 15, 2, 1, accent);
  if (tierCount >= 2) sym(0, 11, 2, 2, accent);

  // --- shaft: columns 14-21, rows 12-19 -----------------------------------------------
  // Eight identical columns. See the header: this slice is stretched along its length, so a
  // cross-section is the only thing that survives, and it is given the whole budget.
  // The body is the TIER'S OWN HUE rather than grey, and that is the tier signal doing more
  // work than it used to, not less: the boom is the longest thing a grabber puts on screen,
  // so colouring all of it beats one tick that the stretch turned into a smear. The value
  // still ramps dark -> bright -> pale about the midline, so it reads as a round bar and not
  // as a flat coloured band. Housing and claw stay metal, so the machine still reads as one.
  sym(14, 12, 8, 1, 'K'); // ink edge
  sym(14, 13, 8, 1, accentDark); // shaded flank
  sym(14, 14, 8, 1, accent); // lit flank
  sym(14, 15, 8, 1, 'P'); // crown

  // --- claw: columns 22-31, rows 8-23 -------------------------------------------------
  // Cut in half at row 16 by the renderer into two jaws that open and close, so every shape
  // here is drawn as a pair either side of that line. Also 1:1, so it pays in full too. The
  // open gap between the finger tips is the point: a grabber's sprite must say "reaches into
  // the next tile".
  sym(22, 10, 4, 6, 'K'); // wrist collar
  sym(23, 11, 3, 5, 'D');
  sym(24, 12, 2, 4, 'M');
  sym(26, 8, 6, 4, 'K'); // jaw: ink outer edge
  sym(26, 9, 5, 3, 'D'); //      body
  sym(27, 10, 4, 2, 'M'); //      lit flank
  sym(26, 12, 2, 4, 'P'); // the gripping faces, meeting on the midline
  if (hooks) sym(30, 12, 2, 2, 'K'); // the Long arm hooks its tips inward: two tiles of reach

  return grid;
}

const GRABBER_SPEC = {
  grabber_mk1: { accent: 'G', accentDark: 'T', ticks: 1, hooks: false },
  grabber_mk2: { accent: 'R', accentDark: 'E', ticks: 2, hooks: false },
  grabber_long: { accent: 'B', accentDark: 'W', ticks: 3, hooks: true },
};

const GRABBER_TIERS = Object.fromEntries(
  Object.entries(GRABBER_SPEC).map(([name, spec]) => [
    name,
    grabberGrid(spec.accent, spec.accentDark, spec.ticks, spec.hooks),
  ]),
);

/**
 * The partition `ARM_SLICE` in `apps/web/src/game/render/grabber-swing.ts` cuts, restated
 * here as the numbers this file has to keep producing. Widths sum to SIZE by construction;
 * the row spans are what that module's comment claims when it says the housing is 16 rows
 * tall, the shaft 8 and the claw 16, and it reads them off the atlas rather than from here.
 */
const ARM_SLICES = [
  { name: 'housing', x: 0, w: 14, top: 8, bottom: 23 },
  { name: 'shaft', x: 14, w: 8, top: 12, bottom: 19 },
  { name: 'claw', x: 22, w: 10, top: 8, bottom: 23 },
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

  // The two tees (095) carry the corner's guarantees and one more. A corner only ever meets
  // a run on ONE side, so it only has to match on the left; a tee is dropped into the MIDDLE
  // of a horizontal run, so BOTH its edges have to match or every side feed shows a seam on
  // the side nobody checked.
  const tierTees = {
    [`belt_${tier}_tee`]: beltTierTee(livery),
    [`belt_${tier}_tee_merge`]: beltTierTeeMerge(livery),
  };
  for (const [frame, grid] of Object.entries(tierTees)) {
    for (let y = 0; y < SIZE; y++) {
      if (grid[y][0] !== tierStraight[y][0]) {
        throw new Error(`${frame} does not meet a straight belt on the west at row ${y}.`);
      }
      if (grid[y][SIZE - 1] !== tierStraight[y][0]) {
        throw new Error(`${frame} does not meet a straight belt on the east at row ${y}.`);
      }
    }
    // The south arm meets a vertical run, read x-for-y exactly as the corner's exit is.
    for (let x = 0; x < SIZE; x++) {
      if (grid[SIZE - 1][x] !== tierStraight[x][0]) {
        throw new Error(`${frame} does not meet a vertical belt at column ${x}.`);
      }
    }
    // North is closed plate, so row 0 may not contain a band glyph of any kind. This is the
    // difference between a tee and a cross, and it should not depend on anyone squinting.
    for (let x = 0; x < SIZE; x++) {
      if (grid[0][x] === 'D' || grid[0][x] === livery.chev) {
        throw new Error(`${frame} has band at ${x},0 — its north face is meant to be closed.`);
      }
    }
    // No arrow may touch an edge this tile tiles against: the seam proof, in chevron form.
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        if (grid[y][x] !== livery.chev) continue;
        if (x === 0 || x === SIZE - 1 || y === SIZE - 1) {
          throw new Error(`${frame}: chevron pixel at ${x},${y} touches a tile edge.`);
        }
      }
    }
  }

  // The merge's west and east arms are interchangeable feeders, so the tile has to be
  // mirror-symmetric left-to-right. Anything asymmetric — a stray pixel, an odd-width stem
  // arrow — would make one of the two feeding arms look like the preferred one.
  const tierMerge = tierTees[`belt_${tier}_tee_merge`];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE / 2; x++) {
      if (tierMerge[y][x] !== tierMerge[y][SIZE - 1 - x]) {
        throw new Error(
          `belt_${tier}_tee_merge is not mirror-symmetric at ${x},${y} — one feeding arm would look preferred.`,
        );
      }
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

// The three proofs work item 135 added, all of them things that were quietly untrue before.
for (const [name, grid] of Object.entries(GRABBER_TIERS)) {
  const spec = GRABBER_SPEC[name];

  // 1. THE SLICE PARTITION. `ARM_SLICE` cuts this tile into three column bands and each one
  //    becomes its own Sprite, so a shape that strays a column into its neighbour does not
  //    look slightly wrong — it is sliced in half and the halves are moved apart by the
  //    swing. The row spans are asserted too, because `grabber-swing.ts` anchors each piece
  //    on row 16 and states the heights as fact in its own comment.
  for (const slice of ARM_SLICES) {
    let top = SIZE;
    let bottom = -1;
    for (let y = 0; y < SIZE; y++) {
      for (let x = slice.x; x < slice.x + slice.w; x++) {
        if (grid[y][x] === '.') continue;
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
    if (top !== slice.top || bottom !== slice.bottom) {
      throw new Error(
        `${name}: the ${slice.name} slice (columns ${slice.x}-${slice.x + slice.w - 1}) covers ` +
          `rows ${top}-${bottom}, not ${slice.top}-${slice.bottom} — ARM_SLICE would cut it wrong.`,
      );
    }
  }

  // 2. THE SHAFT IS COLUMN-UNIFORM. The renderer stretches this slice along its length, so
  //    any difference between its columns is smeared across the whole arm — which is exactly
  //    how the Long arm came to read as a striped ruler. Uniform columns cannot smear.
  const shaft = ARM_SLICES[1];
  const column = (x) => Array.from({ length: SIZE }, (_, y) => grid[y][x]).join('');
  const reference = column(shaft.x);
  for (let x = shaft.x + 1; x < shaft.x + shaft.w; x++) {
    if (column(x) !== reference) {
      throw new Error(
        `${name}: shaft column ${x} differs from column ${shaft.x} — the renderer stretches ` +
          `this slice, so the difference would smear along the whole arm.`,
      );
    }
  }

  // 3. THE TIER COUNT IS ACTUALLY VISIBLE. [[082]] made the count the colourblind-safe
  //    signal and then lost one: the Long arm's third tick was drawn into the claw's columns
  //    and painted over, so Mk2 and Long both shipped showing two. Counting the studs that
  //    survive to the PNG is the only version of that promise worth having.
  let studs = 0;
  let inside = false;
  for (let y = 0; y < SIZE; y++) {
    const lit = grid[y][0] === spec.accent;
    if (lit && !inside) studs++;
    inside = lit;
  }
  if (studs !== spec.ticks) {
    throw new Error(
      `${name}: ${studs} tier stud(s) visible on the rim, expected ${spec.ticks} — the tiers ` +
        `would not be tellable apart without colour.`,
    );
  }
}

await write('belt_straight', straight);
await write('belt_corner', beltCorner());
await write('belt_junction', junction);
await write('grabber_arm', GRABBER);
for (const [tier, livery] of Object.entries(LIVERIES)) {
  await write(`belt_${tier}`, beltTierStraight(livery));
  await write(`belt_${tier}_corner`, beltTierCorner(livery));
  await write(`belt_${tier}_tee`, beltTierTee(livery));
  await write(`belt_${tier}_tee_merge`, beltTierTeeMerge(livery));
}
for (const [name, grid] of Object.entries(GRABBER_TIERS)) {
  await write(name, grid);
}
