// Pipe auto-tiling: which of six frames a tile draws, and how far it is turned.
//
// Pure arithmetic on a four-bit neighbour mask. No Pixi, no scene, no view — so it is
// testable headless, which matters more here than anywhere else in the renderer: a wrong
// entry in this table is a pipe that LOOKS connected and is not, or looks broken and is
// fine. Both are lies told to a player who is debugging a dead syrup line, and both are
// invisible in code review.
//
// The whole table is DERIVED, not written out. Six canonical shapes are rotated through
// four quarter-turns each, which covers all sixteen masks exactly once. Hand-writing
// sixteen entries is how three of them end up wrong.

/** Neighbour bits. Same compass order the sim's `Direction` uses, but a bitmask, not an id. */
export const PipeSide = {
  North: 1,
  East: 2,
  South: 4,
  West: 8,
} as const;

export type PipeFrame = 'stub' | 'cap' | 'straight' | 'corner' | 'tee' | 'cross';

/** Every frame the pipe page bakes, in page order. */
export const PIPE_FRAMES: readonly PipeFrame[] = [
  'stub',
  'cap',
  'straight',
  'corner',
  'tee',
  'cross',
];

export interface PipeShape {
  readonly frame: PipeFrame;
  /** Quarter turns clockwise, 0..3. Screen space, so clockwise is North → East. */
  readonly quarterTurns: number;
}

/**
 * The canonical orientation of each frame, as the mask it is drawn for.
 *
 * Everything points EAST first: a cap is a stub reaching east, a corner joins east to
 * south, a tee is missing its north arm. One convention, applied six times, so "which way
 * is frame zero facing" has a single answer for anyone drawing new pipe art later.
 */
const CANONICAL: readonly (readonly [PipeFrame, number])[] = [
  ['stub', 0],
  ['cap', PipeSide.East],
  ['straight', PipeSide.East | PipeSide.West],
  ['corner', PipeSide.East | PipeSide.South],
  ['tee', PipeSide.East | PipeSide.South | PipeSide.West],
  ['cross', PipeSide.East | PipeSide.South | PipeSide.West | PipeSide.North],
];

/** Turn a mask one quarter clockwise: N→E→S→W→N. */
function rotateMask(mask: number): number {
  return ((mask << 1) | (mask >> 3)) & 0b1111;
}

const TABLE: PipeShape[] = (() => {
  const table = new Array<PipeShape | null>(16).fill(null);
  for (const [frame, baseMask] of CANONICAL) {
    let mask = baseMask;
    for (let quarterTurns = 0; quarterTurns < 4; quarterTurns++) {
      if (table[mask] === null) table[mask] = { frame, quarterTurns };
      mask = rotateMask(mask);
    }
  }
  // Every mask must be covered; a hole here would draw a magenta box on a real pipe run.
  // The fallback keeps that from being a crash, and the test keeps it from being reached.
  return table.map((entry) => entry ?? { frame: 'stub' as PipeFrame, quarterTurns: 0 });
})();

/** The frame and turn for a neighbour mask. Total over all sixteen masks. */
export function pipeShape(mask: number): PipeShape {
  return TABLE[mask & 0b1111]!;
}

/**
 * Which sides of `mask` are connected, as a readable list. Only used by the status ribbon
 * and the tests — the renderer works off the mask directly.
 */
export function pipeSides(mask: number): number {
  let count = 0;
  for (const side of [PipeSide.North, PipeSide.East, PipeSide.South, PipeSide.West]) {
    if ((mask & side) !== 0) count += 1;
  }
  return count;
}
