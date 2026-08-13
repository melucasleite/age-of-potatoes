// Authors the game's own bitmap font: art/local/ui_font.png plus its metrics.
//
// ── WHY A FONT IS AUTHORED HERE AND NOT BOUGHT, DOWNLOADED, OR PROMPTED ──────────────────
//
// §15 puts "text in sprites" on the NEVER list and names a bitmap font at runtime as the only
// sanctioned way to draw text. It also says, in the same breath, not to ask an image model for
// letterforms — a diffusion model cannot be asked for "the same stroke weight ninety-six
// times", which is the entire content of a font.
//
// Nor is a third-party pixel font free of cost: it arrives as a licence to track, a file to
// vendor, and a set of metrics somebody has to trust. Ninety-six 5x7 glyphs is an afternoon of
// typing and the repo then owns the result outright — which is what art/styles/README.md
// records. The letterforms below are authored in this file and are under the repo's own
// licence. Nothing was copied from a released typeface.
//
// ── WHY MONOSPACE ───────────────────────────────────────────────────────────────────────
//
// Every text site being replaced asked the browser for `ui-monospace, SF Mono, Menlo,
// monospace` — the HUD, the dev overlay, the art sheet and the ceremony plaque all wanted a
// fixed advance, because they print numbers in columns and a proportional font makes a money
// readout jitter as its digits change.
//
// It also removes the only thing this file would otherwise have to publish: per-glyph advance
// widths. A monospaced grid has NO per-glyph metrics at all. A character's cell is
// `index(ch) % COLUMNS` across and `index(ch) / COLUMNS` down, and that arithmetic is the same
// arithmetic on both sides. The generated metrics module below carries the character ORDER and
// four integers, and there is nothing else that the tool and the renderer could disagree about.
//
// ── WHY PIXEL-CRISPNESS IS A PROPERTY OF THE CELL, NOT OF THE RENDERER ──────────────────
//
// The cell is 6x10 and the ink box is 5x9 — column 5 and row 9 are always empty. That gutter
// is what makes the font safe at every integer zoom: nearest-neighbour sampling on a texture
// rect can pick up a neighbouring pixel at the seam when a transform lands a hair off, and
// with a gutter the pixel it picks up is transparent. Without one, the letter to the right of
// every letter would occasionally grow a stray column, which reads as a rendering bug and gets
// chased in the wrong file.
//
// The one deliberate exception is the em dash, which uses all six columns because an em dash
// is SUPPOSED to reach its full advance and touch its neighbours. It is asserted as the only
// glyph allowed to.
//
// ── COVERAGE ────────────────────────────────────────────────────────────────────────────
//
// Printable ASCII, 0x20 to 0x7E, in code-point order — 95 glyphs — plus nine characters the
// renderer's own format strings actually print and ASCII does not have: the middle dot in
// "wasd to walk · click far away", the em and en dashes in "need $12.00 — you have $3.40",
// the multiplication sign in "3× zoom", the true minus in "− 4 tiles from zone 2", and the
// four arrows `pointer.ts` uses to say which way a grabber faces. Anything outside this set
// draws nothing, so the set is the contract: a format string that reaches for a character not
// listed here has to add it here first.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { loadMaster } from './palette-png.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PNG_OUT = resolve(HERE, '../local/ui_font.png');
const METRICS_OUT = resolve(HERE, '../../apps/web/src/art/ui-font.generated.ts');

/** The family name `BitmapText` asks for. Short, and not a system font's name. */
const FAMILY = 'snack';

const CELL_WIDTH = 6;
const CELL_HEIGHT = 10;
const INK_WIDTH = 5;
const INK_HEIGHT = 9;
const COLUMNS = 32;

/**
 * Rows 0-6 are the body and the baseline sits just under row 6; rows 7-8 are the descender.
 * Caps and ascenders fill the body, lowercase x-height starts at row 2.
 */
const DESCENDER_TOP = 7;

/** One blank line's worth of leading over the cell. Reads better than a flush 10. */
const LINE_HEIGHT = CELL_HEIGHT + 1;

/**
 * A glyph is `[topRow, rows]`. Rows are `#` (ink) and `.` (nothing), authored 5 wide.
 * Everything not listed is absent from the font and draws nothing.
 */
const G = {
  ' ': [0, []],
  '!': [0, ['..#..', '..#..', '..#..', '..#..', '..#..', '.....', '..#..']],
  '"': [0, ['.#.#.', '.#.#.']],
  '#': [1, ['.#.#.', '#####', '.#.#.', '#####', '.#.#.']],
  $: [0, ['..#..', '.####', '#.#..', '.###.', '..#.#', '####.', '..#..']],
  '%': [0, ['##..#', '##.#.', '...#.', '..#..', '.#...', '.#.##', '#..##']],
  '&': [0, ['.##..', '#..#.', '#.#..', '.#...', '#.#.#', '#..#.', '.##.#']],
  "'": [0, ['..#..', '..#..']],
  '(': [0, ['...#.', '..#..', '.#...', '.#...', '.#...', '..#..', '...#.']],
  ')': [0, ['.#...', '..#..', '...#.', '...#.', '...#.', '..#..', '.#...']],
  '*': [0, ['..#..', '#.#.#', '.###.', '#.#.#', '..#..']],
  '+': [1, ['..#..', '..#..', '#####', '..#..', '..#..']],
  ',': [6, ['..#..', '.#...']],
  '-': [4, ['.###.']],
  '.': [6, ['..#..']],
  '/': [0, ['....#', '....#', '...#.', '..#..', '.#...', '#....', '#....']],

  0: [0, ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.']],
  1: [0, ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.']],
  2: [0, ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####']],
  3: [0, ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.']],
  4: [0, ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.']],
  5: [0, ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.']],
  6: [0, ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.']],
  7: [0, ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...']],
  8: [0, ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.']],
  9: [0, ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..']],

  ':': [3, ['..#..', '.....', '.....', '..#..']],
  ';': [3, ['..#..', '.....', '.....', '..#..', '.#...']],
  '<': [1, ['...#.', '..#..', '.#...', '..#..', '...#.']],
  '=': [2, ['#####', '.....', '#####']],
  '>': [1, ['.#...', '..#..', '...#.', '..#..', '.#...']],
  '?': [0, ['.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..']],
  '@': [0, ['.###.', '#...#', '#.###', '#.#.#', '#.###', '#....', '.###.']],

  A: [0, ['..#..', '.#.#.', '#...#', '#...#', '#####', '#...#', '#...#']],
  B: [0, ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.']],
  C: [0, ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.']],
  D: [0, ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.']],
  E: [0, ['#####', '#....', '#....', '####.', '#....', '#....', '#####']],
  F: [0, ['#####', '#....', '#....', '####.', '#....', '#....', '#....']],
  G: [0, ['.###.', '#...#', '#....', '#..##', '#...#', '#...#', '.###.']],
  H: [0, ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#']],
  I: [0, ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.']],
  J: [0, ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..']],
  K: [0, ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#']],
  L: [0, ['#....', '#....', '#....', '#....', '#....', '#....', '#####']],
  M: [0, ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#']],
  N: [0, ['#...#', '##..#', '##..#', '#.#.#', '#..##', '#..##', '#...#']],
  O: [0, ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.']],
  P: [0, ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....']],
  Q: [0, ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#']],
  R: [0, ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#']],
  S: [0, ['.###.', '#...#', '#....', '.###.', '....#', '#...#', '.###.']],
  T: [0, ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..']],
  U: [0, ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.']],
  V: [0, ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..']],
  W: [0, ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#']],
  X: [0, ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#']],
  Y: [0, ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..']],
  Z: [0, ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####']],

  '[': [0, ['.###.', '.#...', '.#...', '.#...', '.#...', '.#...', '.###.']],
  '\\': [0, ['#....', '#....', '.#...', '..#..', '...#.', '....#', '....#']],
  ']': [0, ['.###.', '...#.', '...#.', '...#.', '...#.', '...#.', '.###.']],
  '^': [0, ['..#..', '.#.#.', '#...#']],
  _: [8, ['#####']],
  '`': [0, ['.#...', '..#..']],

  a: [2, ['.###.', '....#', '.####', '#...#', '.####']],
  b: [0, ['#....', '#....', '####.', '#...#', '#...#', '#...#', '####.']],
  c: [2, ['.###.', '#....', '#....', '#....', '.###.']],
  d: [0, ['....#', '....#', '.####', '#...#', '#...#', '#...#', '.####']],
  e: [2, ['.###.', '#...#', '#####', '#....', '.###.']],
  f: [0, ['..##.', '.#...', '.#...', '###..', '.#...', '.#...', '.#...']],
  g: [2, ['.####', '#...#', '#...#', '#...#', '.####', '....#', '.###.']],
  h: [0, ['#....', '#....', '####.', '#...#', '#...#', '#...#', '#...#']],
  i: [0, ['..#..', '.....', '..#..', '..#..', '..#..', '..#..', '..#..']],
  j: [0, ['...#.', '.....', '...#.', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..']],
  k: [0, ['#....', '#....', '#..#.', '#.#..', '##...', '#.#..', '#..#.']],
  l: [0, ['.#...', '.#...', '.#...', '.#...', '.#...', '.#...', '..##.']],
  m: [2, ['#####', '#.#.#', '#.#.#', '#.#.#', '#.#.#']],
  n: [2, ['####.', '#...#', '#...#', '#...#', '#...#']],
  o: [2, ['.###.', '#...#', '#...#', '#...#', '.###.']],
  p: [2, ['####.', '#...#', '#...#', '#...#', '####.', '#....', '#....']],
  q: [2, ['.####', '#...#', '#...#', '#...#', '.####', '....#', '....#']],
  r: [2, ['#.##.', '##..#', '#....', '#....', '#....']],
  s: [2, ['.####', '#....', '.###.', '....#', '####.']],
  t: [0, ['.#...', '.#...', '####.', '.#...', '.#...', '.#...', '..##.']],
  u: [2, ['#...#', '#...#', '#...#', '#...#', '.####']],
  v: [2, ['#...#', '#...#', '#...#', '.#.#.', '..#..']],
  w: [2, ['#...#', '#...#', '#.#.#', '#.#.#', '.#.#.']],
  x: [2, ['#...#', '.#.#.', '..#..', '.#.#.', '#...#']],
  y: [2, ['#...#', '#...#', '.#.#.', '..#..', '..#..', '.#...', '##...']],
  z: [2, ['#####', '...#.', '..#..', '.#...', '#####']],

  '{': [0, ['...#.', '..#..', '..#..', '.#...', '..#..', '..#..', '...#.']],
  '|': [0, ['..#..', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..']],
  '}': [0, ['.#...', '..#..', '..#..', '...#.', '..#..', '..#..', '.#...']],
  '~': [2, ['.#..#', '#.#.#', '#..#.']],

  // The nine the format strings need and ASCII does not have.
  '·': [4, ['..#..']],
  '—': [4, ['######']],
  '–': [4, ['#####']],
  '×': [1, ['#...#', '.#.#.', '..#..', '.#.#.', '#...#']],
  '−': [3, ['#####']],
  '↑': [0, ['..#..', '.###.', '#.#.#', '..#..', '..#..', '..#..', '..#..']],
  '↓': [0, ['..#..', '..#..', '..#..', '..#..', '#.#.#', '.###.', '..#..']],
  '←': [1, ['..#..', '.#...', '#####', '.#...', '..#..']],
  '→': [1, ['..#..', '...#.', '#####', '...#.', '..#..']],
};

/** The em dash alone may reach into the advance gutter — see the header. */
const FULL_ADVANCE = '—';

// --- the character order, which is the whole shared contract -----------------------------

const ASCII = Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) => String.fromCharCode(0x20 + i));
const EXTRAS = ['·', '—', '–', '×', '−', '↑', '↓', '←', '→'];
const CHARS = [...ASCII, ...EXTRAS];

// --- the guarantees, asserted rather than eyeballed --------------------------------------

if (new Set(CHARS).size !== CHARS.length) {
  throw new Error('The character order lists a character twice.');
}
for (const ch of CHARS) {
  if (!(ch in G)) throw new Error(`No glyph authored for ${JSON.stringify(ch)}.`);
}
for (const ch of Object.keys(G)) {
  if (!CHARS.includes(ch)) {
    throw new Error(`Glyph ${JSON.stringify(ch)} is authored but not in the character order.`);
  }
}

/** A glyph as a flat boolean array over the full CELL_WIDTH x CELL_HEIGHT cell. */
function cellOf(ch) {
  const [top, rows] = G[ch];
  const cell = new Array(CELL_WIDTH * CELL_HEIGHT).fill(false);
  const width = ch === FULL_ADVANCE ? CELL_WIDTH : INK_WIDTH;

  rows.forEach((row, i) => {
    const y = top + i;
    if (row.length !== width) {
      throw new Error(
        `Glyph ${JSON.stringify(ch)} has a ${row.length}px row; it may be ${width}px wide.`,
      );
    }
    if (y >= INK_HEIGHT) {
      throw new Error(
        `Glyph ${JSON.stringify(ch)} reaches row ${y}; rows 0-${INK_HEIGHT - 1} are the ink box ` +
          `and row ${CELL_HEIGHT - 1} is the advance gutter.`,
      );
    }
    [...row].forEach((glyph, x) => {
      if (glyph !== '#' && glyph !== '.') {
        throw new Error(`Glyph ${JSON.stringify(ch)} uses "${glyph}"; only "#" and "." are ink.`);
      }
      if (glyph === '#') cell[y * CELL_WIDTH + x] = true;
    });
  });
  return cell;
}

const CELLS = new Map(CHARS.map((ch) => [ch, cellOf(ch)]));

/** The space is the only glyph allowed to be blank. Anything else blank is invisible text. */
for (const [ch, cell] of CELLS) {
  const inked = cell.some(Boolean);
  if (ch === ' ' && inked) throw new Error('The space glyph has ink in it.');
  if (ch !== ' ' && !inked) throw new Error(`Glyph ${JSON.stringify(ch)} is blank.`);
}

/**
 * NO TWO CHARACTERS MAY RENDER THE SAME BITMAP.
 *
 * The failure this catches is a copy-paste while authoring a hundred glyphs by hand, and its
 * symptom is not a crash: it is a HUD where two different characters are the same picture. The
 * pair that costs real money if it slips through is `0`/`O`, which is why the zero is slashed.
 */
const byBitmap = new Map();
for (const [ch, cell] of CELLS) {
  if (ch === ' ') continue;
  const key = cell.map((on) => (on ? 1 : 0)).join('');
  const clash = byBitmap.get(key);
  if (clash !== undefined) {
    throw new Error(
      `${JSON.stringify(ch)} and ${JSON.stringify(clash)} are the same bitmap — one of them was ` +
        `almost certainly pasted over the other.`,
    );
  }
  byBitmap.set(key, ch);
}

/**
 * The ten digits must differ by more than a pixel each.
 *
 * Letters can lean on the word around them; a digit in "$1,204.50" cannot, and a misread money
 * readout is the one legibility bug in this game that changes what the player decides to do.
 */
const DIGIT_MARGIN = 3;
const DIGITS = '0123456789';
for (let i = 0; i < DIGITS.length; i++) {
  for (let j = i + 1; j < DIGITS.length; j++) {
    const a = CELLS.get(DIGITS[i]);
    const b = CELLS.get(DIGITS[j]);
    let differ = 0;
    for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) differ += 1;
    if (differ < DIGIT_MARGIN) {
      throw new Error(
        `Digits "${DIGITS[i]}" and "${DIGITS[j]}" differ by only ${differ} pixel(s); a money ` +
          `readout needs at least ${DIGIT_MARGIN}.`,
      );
    }
  }
}

/** Descenders may only exist where a descender belongs. */
for (const [ch, cell] of CELLS) {
  let below = false;
  for (let y = DESCENDER_TOP; y < CELL_HEIGHT; y++) {
    for (let x = 0; x < CELL_WIDTH; x++) if (cell[y * CELL_WIDTH + x]) below = true;
  }
  if (below && !'gjpqy_,;|'.includes(ch)) {
    throw new Error(`Glyph ${JSON.stringify(ch)} paints below the baseline and should not.`);
  }
}

// --- emit ---------------------------------------------------------------------------------

const rows = Math.ceil(CHARS.length / COLUMNS);
const width = COLUMNS * CELL_WIDTH;
const height = rows * CELL_HEIGHT;

const { swatches } = loadMaster();
const paper = swatches.find((swatch) => swatch.name === 'paper');
if (!paper) throw new Error('Master palette has no colour named "paper".');
const [r, g, b] = [1, 3, 5].map((at) => parseInt(paper.hex.slice(at, at + 2), 16));

const raw = Buffer.alloc(width * height * 4);
CHARS.forEach((ch, index) => {
  const originX = (index % COLUMNS) * CELL_WIDTH;
  const originY = Math.floor(index / COLUMNS) * CELL_HEIGHT;
  const cell = CELLS.get(ch);
  for (let y = 0; y < CELL_HEIGHT; y++) {
    for (let x = 0; x < CELL_WIDTH; x++) {
      if (!cell[y * CELL_WIDTH + x]) continue;
      const at = ((originY + y) * width + (originX + x)) * 4;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
      raw[at + 3] = 255;
    }
  }
});

const png = await sharp(raw, { raw: { width, height, channels: 4 } })
  .png({ palette: false, compressionLevel: 9 })
  .toBuffer();
writeFileSync(PNG_OUT, png);
console.log(
  `Wrote art/local/ui_font.png — ${width}x${height}, ${CHARS.length} glyphs, ${png.length} bytes.`,
);

mkdirSync(dirname(METRICS_OUT), { recursive: true });
writeFileSync(
  METRICS_OUT,
  `// GENERATED FILE — do not edit by hand.
// Written by \`node art/tools/make-ui-font.mjs\`, which also writes art/local/ui_font.png.
//
// The font is MONOSPACED, so there are no per-glyph metrics: a character's cell is
// \`index % columns\` across and \`index / columns\` down the frame, every advance is
// \`cellWidth\`, and \`chars\` below is the index order. That is the entire shared contract
// between the generator and \`render/font.ts\`.

export const UI_FONT = {
  /** The family name \`BitmapText\` styles ask for. */
  family: ${JSON.stringify(FAMILY)},
  cellWidth: ${CELL_WIDTH},
  cellHeight: ${CELL_HEIGHT},
  columns: ${COLUMNS},
  /** Baseline-to-baseline. One row of leading over the cell. */
  lineHeight: ${LINE_HEIGHT},
  /** The size at which one font pixel is one screen pixel. Multiply by an integer to zoom. */
  fontSize: ${CELL_HEIGHT},
  /** Every character the font can draw, in cell order. Anything else draws nothing. */
  chars: ${JSON.stringify(CHARS.join(''))},
} as const;
`,
);
console.log(`Wrote apps/web/src/art/ui-font.generated.ts — ${rows} row(s) of ${COLUMNS}.`);
