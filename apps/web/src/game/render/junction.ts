// Belt junctions: which way the conveyor tee is turned.
//
// ── THE SPLITTER AND THE MERGER ARE THE SAME TILE, SO THE PICTURE COMES FROM THE BELTS ──
//
// `MachineKind.BeltJunction` has no facing and no cursor the projection publishes — the sim's
// own note is that "the device does not know which it is and does not need to, because the
// answer is the belts the player ran into it and those are on screen". That is a statement
// about the renderer as much as about the sim: if the junction drew a fixed sprite, the one
// object in the middle of the run would be the one object that did not point anywhere.
//
// So the tile is auto-tiled off its neighbours, exactly as `pipe-shape.ts` auto-tiles a pipe,
// and for the same reason: a junction that LOOKS connected on a face where no belt runs is a
// lie told to a player debugging a dead line, and it is invisible in code review. Hence a pure
// module with no Pixi, no scene and no textures — this file can be tested headless, and it is.
//
// ── ONE FRAME, FOUR TURNS, AND THE FACE IT LEAVES OUT ───────────────────────────────────
//
// The art is a single tee (`belt_junction`): the run passes west to east and a branch leaves
// through the south. Four rotations reach every tee a square grid can contain, and each turn
// opens three faces and closes exactly one. Choosing a rotation is therefore choosing WHICH
// FACE TO CLOSE, and the right answer is any face with no belt on it.
//
// A four-way junction has no such face. It gets the canonical turn and one arm of belt meets a
// closed edge — which is a cosmetic seam on a legal build, and the honest alternative (invent a
// cross frame the atlas does not have) would draw a magenta box on a working factory.

import type { BeltView } from '@snack/sim';

import { stepX, stepY } from './directions';
import { PipeSide } from './pipe-shape';

// The neighbour bits are the PIPE layer's, imported rather than redeclared. Two auto-tilers in
// one renderer that each decide privately which bit means north is two auto-tilers that agree
// until somebody edits one of them. The name is about where the convention was written down
// first, not about what it may be used for.
export { PipeSide as JunctionSide };

/**
 * The face each quarter turn CLOSES.
 *
 * The tee is drawn open west/east/south, so at rest it closes the north. A clockwise quarter
 * turn carries that closed face N→E→S→W, which is this array read left to right.
 */
const CLOSED_FACE: readonly number[] = [
  PipeSide.North,
  PipeSide.East,
  PipeSide.South,
  PipeSide.West,
];

/** The four faces, in the order the mask's bits are numbered. */
const FACES: readonly { side: number; dx: number; dy: number }[] = [
  { side: PipeSide.North, dx: 0, dy: -1 },
  { side: PipeSide.East, dx: 1, dy: 0 },
  { side: PipeSide.South, dx: 0, dy: 1 },
  { side: PipeSide.West, dx: -1, dy: 0 },
];

/**
 * Quarter turns clockwise for a neighbour mask, 0..3. Total over all sixteen masks.
 *
 * Takes the FIRST turn whose closed face is free, so the result is stable frame to frame: a
 * junction with two open faces has two valid answers and must not flicker between them while
 * the player watches. Deterministic by iteration order rather than by tie-break rule.
 */
export function junctionQuarterTurns(mask: number): number {
  for (let turns = 0; turns < 4; turns++) {
    if ((mask & CLOSED_FACE[turns]!) === 0) return turns;
  }
  // All four faces carry belt. See the header: the canonical turn, and one visible seam.
  return 0;
}

/**
 * Which faces of a tile have a belt against them.
 *
 * WHETHER THE BELT FEEDS IN OR LEADS AWAY IS DELIBERATELY NOT ASKED. The sim decides that from
 * the belt's own exit tile and it can change without the tile moving, but the tee is a piece of
 * ironwork: which way the goods run is carried by the belts themselves — they scroll, and they
 * green up as they fill. A junction that re-cut its own silhouette every time a line reversed
 * would be animating the one part of the picture that is bolted down.
 *
 * Scans the belt list once per junction rather than building a tile index. Junctions are a
 * handful and belts are hundreds, so this is thousands of integer compares a frame with no
 * allocation — and the index would have to be rebuilt every frame anyway, because `view.belts`
 * is a reused buffer whose contents change under it.
 */
export function junctionMask(belts: readonly BeltView[], tileX: number, tileY: number): number {
  let mask = 0;
  for (let i = 0; i < belts.length; i++) {
    const belt = belts[i]!;
    for (let f = 0; f < FACES.length; f++) {
      const face = FACES[f]!;
      if ((mask & face.side) !== 0) continue;
      if (beltCovers(belt, tileX + face.dx, tileY + face.dy)) mask |= face.side;
    }
  }
  return mask;
}

/**
 * Whether a belt segment runs over a tile.
 *
 * Analytic rather than a walk down the segment: a belt is a straight run of `lengthTiles` from
 * its origin along one compass direction, so membership is one multiply and two compares no
 * matter how long the belt is. An express belt across the whole 64-tile lot costs the same as a
 * one-tile stub, which is what keeps the scan above honest about its own cost.
 */
function beltCovers(belt: BeltView, tileX: number, tileY: number): boolean {
  const dx = stepX(belt.dir);
  const dy = stepY(belt.dir);

  if (dx !== 0) {
    if (tileY !== belt.tileY) return false;
    const along = (tileX - belt.tileX) * dx;
    return along >= 0 && along < belt.lengthTiles;
  }
  if (dy !== 0) {
    if (tileX !== belt.tileX) return false;
    const along = (tileY - belt.tileY) * dy;
    return along >= 0 && along < belt.lengthTiles;
  }
  // A direction this build has never heard of — a save from a newer sim. One tile, facing
  // nowhere, rather than an exception thrown at the player. Same rule as `directions.ts`.
  return belt.tileX === tileX && belt.tileY === tileY;
}
