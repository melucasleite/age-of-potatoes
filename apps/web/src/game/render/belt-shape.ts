// Belt auto-tiling: which shape a belt tile actually is, from the flow of the belts around it.
//
// ── WHY A BELT NEEDS THIS AT ALL ────────────────────────────────────────────────────────
//
// A belt segment is a straight run, so the layer that draws it draws straight track — one
// scrolling quad per segment ([[belt-structure.ts]]). But a *line* is not a segment: where a
// run turns, two segments meet at right angles, and where one line feeds another, a segment
// ends against the flank of a second. On those tiles the goods visibly turn a corner that the
// artwork does not, which is the bug item 095 was filed for. Item 082 authored the corner
// frames and said so in its own report: they had no world consumer, because nothing detected
// the elbow.
//
// This module is that detection, and it is a PURE FUNCTION OF THE FLOW, not of geometry.
// "Which of my neighbours feed me, and which way do I feed" is the whole input. That matters
// because the art carries CHEVRONS: a bend drawn from geometry alone has a 50% chance of
// pointing its arrows upstream, and an arrow pointing the wrong way down a working line is a
// worse lie than a missing bend.
//
// Written as `shore.ts` is (item 077) rather than as `junction.ts` is: a total mask→variant
// function returning the frame AND how it is turned, exhaustively test-pinned, with no Pixi,
// no scene and no textures anywhere near it.
//
// ── FOUR SHAPES, AND WHY MIRRORING IS ONE OF THE ANSWERS ────────────────────────────────
//
//   straight  — the tier's own tile, authored running WEST → EAST. Drawn by the tiling layer;
//               this module names it only so the function is total.
//   corner    — authored in from the WEST, out through the SOUTH. Four quarter turns reach
//               all four RIGHT turns. The four LEFT turns are the same picture MIRRORED about
//               its horizontal midline — travelling east and leaving north is the flip of
//               travelling east and leaving south, and a vertical flip leaves the entering
//               chevrons pointing east while carrying the departing one from the bottom edge
//               to the top. So eight bends come out of one authored frame, exactly as the
//               bots get east out of a west-facing strip.
//   tee       — the SIDE FEED: a through-run WEST → EAST with a second line joining from the
//               south. Turns and mirrors the same way, eight configurations from one frame.
//   teeMerge  — the HEAD-ON MERGE: goods arriving from BOTH the west and the east, leaving
//               through the south. Four turns, no mirror — the frame is symmetric left to
//               right because its two feeding arms are interchangeable.
//
// A SPLIT IS NOT IN THIS VOCABULARY, and that is a fact about the sim rather than an omission
// here: a belt segment has ONE direction, so a belt tile hands goods to exactly one neighbour.
// Two lines can merge onto a belt; a belt can never fork. Forking is what `MachineKind.
// BeltJunction` is for, and it is a machine — a grey casting with a status lamp, drawn on the
// machine layer, clickable, and never wearing a tier's livery. So on screen the two are told
// apart by colour and by furniture: a drawn tee is the line's own hue (yellow / red / blue,
// with the tier's chevron count), a junction is grey ironwork with a lamp on it.

import { worldKeyTileX, worldKeyTileY, worldTileKey } from '@snack/sim';
import type { BeltView } from '@snack/sim';

import { stepX, stepY } from './directions';
import { PipeSide } from './pipe-shape';

// The neighbour bits are the pipe layer's, imported rather than redeclared — the same
// single-convention rule `junction.ts` and `shore.ts` follow, and for the same reason: two
// auto-tilers that each privately decide which bit means north agree until somebody edits one.
export { PipeSide as BeltSide };

export type BeltShapeKind = 'straight' | 'corner' | 'tee' | 'teeMerge';

export interface BeltShapeVariant {
  readonly kind: BeltShapeKind;
  /** Quarter turns CLOCKWISE from the authored base orientation, 0..3. */
  readonly quarterTurns: number;
  /**
   * Flip the authored frame about its HORIZONTAL midline before turning it.
   *
   * Before, not after: a sprite's local scale is applied inside its rotation, so
   * `scale.y = -1` with `rotation = k·90°` composes as "flip, then turn" — which is the order
   * the tables below are derived in.
   */
  readonly mirror: boolean;
}

/** The compass sides, in bit order, for the derivations and for the tests to iterate. */
export const BELT_SIDES: readonly number[] = [
  PipeSide.North,
  PipeSide.East,
  PipeSide.South,
  PipeSide.West,
];

/** One quarter turn clockwise: N→E→S→W→N. */
function rotateSide(side: number, turns: number): number {
  let out = side;
  for (let i = 0; i < ((turns % 4) + 4) % 4; i++) {
    out = ((out << 1) | (out >> 3)) & 0b1111;
  }
  return out;
}

/** A flip about the horizontal midline: north and south swap, east and west are unmoved. */
function flipSide(side: number): number {
  let out = side & (PipeSide.East | PipeSide.West);
  if ((side & PipeSide.North) !== 0) out |= PipeSide.South;
  if ((side & PipeSide.South) !== 0) out |= PipeSide.North;
  return out;
}

/** The side directly opposite. */
function opposite(side: number): number {
  return rotateSide(side, 2);
}

/** How many of the four low bits are set. */
function bits(mask: number): number {
  let count = 0;
  for (const side of BELT_SIDES) if ((mask & side) !== 0) count += 1;
  return count;
}

// ── THE ORIENTATION TABLES ARE DERIVED, NEVER WRITTEN OUT ───────────────────────────────
//
// Twenty entries hand-typed is how three of them end up wrong, and a wrong one here is a belt
// whose arrows run backwards on one rotation only — the kind of bug that survives a review and
// gets found by a player. So each authored frame is described ONCE by the sides it uses, and
// every orientation is generated by applying the flip and the turns to that description.
//
// `mirror: false` is enumerated first so that where an orientation is reachable both ways (the
// merge tee, which is symmetric), the unmirrored answer wins. Stability matters: two answers
// that both look right must still be the SAME answer frame to frame.

interface Orientation {
  readonly quarterTurns: number;
  readonly mirror: boolean;
}

const ORIENTATIONS: readonly Orientation[] = [
  ...[0, 1, 2, 3].map((quarterTurns) => ({ quarterTurns, mirror: false })),
  ...[0, 1, 2, 3].map((quarterTurns) => ({ quarterTurns, mirror: true })),
];

/** Carry one side through an orientation: flip in local space first, then turn. */
function orient(side: number, at: Orientation): number {
  return rotateSide(at.mirror ? flipSide(side) : side, at.quarterTurns);
}

function put(table: Map<number, Orientation>, key: number, at: Orientation): void {
  if (!table.has(key)) table.set(key, at);
}

/** `straight` is authored running west to east, so its key is simply the side it exits by. */
const STRAIGHT_BY_OUT = new Map<number, Orientation>();
/** `corner` is authored in from the WEST, out through the SOUTH. Keyed by that pair. */
const CORNER_BY_IN_OUT = new Map<number, Orientation>();
/** `tee` is authored running west to east with the branch joining from the SOUTH. */
const TEE_BY_OUT_BRANCH = new Map<number, Orientation>();
/** `teeMerge` is authored feeding in from west AND east, leaving through the SOUTH. */
const MERGE_BY_OUT = new Map<number, Orientation>();

for (const at of ORIENTATIONS) {
  put(STRAIGHT_BY_OUT, orient(PipeSide.East, at), at);
  put(CORNER_BY_IN_OUT, pairKey(orient(PipeSide.West, at), orient(PipeSide.South, at)), at);
  put(TEE_BY_OUT_BRANCH, pairKey(orient(PipeSide.East, at), orient(PipeSide.South, at)), at);
  put(MERGE_BY_OUT, orient(PipeSide.South, at), at);
}

/** Two sides packed into one key. Four bits each, so no collision. */
function pairKey(a: number, b: number): number {
  return (a << 4) | b;
}

const STRAIGHT_EAST: Orientation = { quarterTurns: 0, mirror: false };

function variant(kind: BeltShapeKind, at: Orientation | undefined): BeltShapeVariant {
  const use = at ?? STRAIGHT_EAST;
  return { kind, quarterTurns: use.quarterTurns, mirror: use.mirror };
}

/**
 * The shape one belt tile wears, from the side it feeds and the sides that feed it.
 *
 * TOTAL over every (outSide, inMask) pair, because a partial table is a magenta tile on a
 * working factory. `outSide` is a single compass bit — the direction this tile's own belt
 * carries goods away. `inMask` is every side a belt delivers INTO this tile from, including
 * the tile's own upstream neighbour when the belt continues behind it.
 *
 *   arms = the out side, plus every in side. The tile's silhouette is exactly its arms.
 *
 *   1 arm            → straight. A stub with nothing feeding it looks like track, not a cap;
 *                      the sim has no dead-end frame and inventing one would draw a stopper
 *                      across a line that works.
 *   2 arms, opposite → straight. The ordinary middle of a run.
 *   2 arms, adjacent → corner, oriented in→out so the chevrons run downstream.
 *   3 arms, one of
 *     them opposite
 *     the out arm    → tee, the side feed: the through-run keeps the line, the odd arm is the
 *                      branch joining it.
 *   3 arms, both ins
 *     perpendicular  → teeMerge: two lines arriving head-on, leaving by the stem.
 *   4 arms           → teeMerge is impossible and no cross frame exists, so: the tee, keeping
 *                      the through-run, branching on the FIRST perpendicular feeder in N,E,S,W
 *                      order. The other feeder meets a closed plate — a cosmetic seam on a
 *                      legal build, which is exactly the concession `junction.ts` makes for a
 *                      four-way junction, taken for the same reason: the honest alternative is
 *                      a frame the atlas does not have.
 *
 * A belt pointing INTO the tile from the side this tile exits by (two belts nose to nose) is
 * dropped from the mask rather than counted as an arm. It is a deadlock the sim permits and
 * the player will see it as a jam; drawing a bend there would suggest the goods have somewhere
 * to go.
 */
export function beltShape(outSide: number, inMask: number): BeltShapeVariant {
  const out = outSide & 0b1111;
  if (bits(out) !== 1) {
    // A direction this build has never heard of — a save from a newer sim. Straight, facing
    // the way the tiling layer already drew it, rather than an exception thrown at the player.
    // Same rule as `directions.ts`.
    return variant('straight', STRAIGHT_EAST);
  }

  const ins = inMask & 0b1111 & ~out;
  const back = opposite(out);
  const arms = out | ins;
  const armCount = bits(arms);

  if (armCount <= 2 && (ins === 0 || ins === back)) {
    return variant('straight', STRAIGHT_BY_OUT.get(out));
  }

  if (armCount === 2) {
    return variant('corner', CORNER_BY_IN_OUT.get(pairKey(ins, out)));
  }

  if (armCount === 3) {
    if ((ins & back) !== 0) {
      const branch = ins & ~back;
      return variant('tee', TEE_BY_OUT_BRANCH.get(pairKey(out, branch)));
    }
    return variant('teeMerge', MERGE_BY_OUT.get(out));
  }

  // Four arms. See the header of this function: keep the through-run, branch on the first
  // perpendicular feeder, and let the other one meet the plate.
  for (const side of BELT_SIDES) {
    if (side === out || side === back) continue;
    if ((ins & side) !== 0) return variant('tee', TEE_BY_OUT_BRANCH.get(pairKey(out, side)));
  }
  return variant('straight', STRAIGHT_BY_OUT.get(out));
}

/** One tile that draws something other than plain track. */
export interface BeltShapeTile {
  readonly tileX: number;
  readonly tileY: number;
  readonly tier: number;
  /** The belt this tile belongs to, so the drawer can follow that belt's tint and culling. */
  readonly beltId: number;
  readonly shape: BeltShapeVariant;
}

/** The side of `tile` a belt travelling in direction `dir` arrives through. */
function arrivalSide(dir: number): number {
  const dx = stepX(dir);
  const dy = stepY(dir);
  if (dx > 0) return PipeSide.West;
  if (dx < 0) return PipeSide.East;
  if (dy > 0) return PipeSide.North;
  if (dy < 0) return PipeSide.South;
  return 0;
}

/** The side of a tile that a belt running in direction `dir` leaves by. */
function departureSide(dir: number): number {
  return opposite(arrivalSide(dir));
}

/**
 * Every belt tile in the world that is a bend or a tee, with the frame and turn it wants.
 *
 * ── THIS IS THE "ON CHANGE, NEVER PER FRAME" HALF OF ITEM 095'S BUDGET RULE ─────────────
 *
 * The 5,000-item ParticleContainer path must not gain work, and it does not: nothing here is
 * per item, and the caller runs it only when the belt topology actually moved. Even so it is
 * written to be cheap, because "only on change" means "every time the player drags out a run".
 *
 * The trick is that A TILE CANNOT BEND UNLESS SOMETHING FEEDS IT FROM THE SIDE, and the only
 * thing that feeds a belt tile is another belt's HEAD. So the candidate set is at most one
 * tile per belt — the exit tile — rather than one per belt tile. The index below is built over
 * every belt tile once (that is the cost of answering "who is standing here"), and then the
 * classification walks belts, not tiles.
 */
export function classifyBeltShapes(belts: readonly BeltView[]): BeltShapeTile[] {
  // tile → index into `belts`. Built fresh: `view.belts` is a reused buffer whose contents
  // change under any cache we might keep, so a stale index is worse than no index.
  const occupant = new Map<number, number>();
  for (let i = 0; i < belts.length; i++) {
    const belt = belts[i]!;
    const dx = stepX(belt.dir);
    const dy = stepY(belt.dir);
    for (let along = 0; along < belt.lengthTiles; along++) {
      occupant.set(worldTileKey(belt.tileX + dx * along, belt.tileY + dy * along), i);
    }
  }

  // tile → the sides other belts deliver into it from. Sparse: one entry per belt at most.
  const feeds = new Map<number, number>();
  for (let i = 0; i < belts.length; i++) {
    const belt = belts[i]!;
    const exitX = belt.tileX + stepX(belt.dir) * belt.lengthTiles;
    const exitY = belt.tileY + stepY(belt.dir) * belt.lengthTiles;
    const key = worldTileKey(exitX, exitY);
    const target = occupant.get(key);
    // Nothing there, or the belt has looped onto itself — the sim declines the hand-off in
    // both cases (`handOffFromHead`), so neither is an arm.
    if (target === undefined || belts[target]!.id === belt.id) continue;
    feeds.set(key, (feeds.get(key) ?? 0) | arrivalSide(belt.dir));
  }

  const out: BeltShapeTile[] = [];
  for (const [key, sideMask] of feeds) {
    const index = occupant.get(key)!;
    const belt = belts[index]!;
    const tileX = worldKeyTileX(key);
    const tileY = worldKeyTileY(key);

    // The belt's own upstream tile is an arm too, and it is not in `feeds` because no second
    // belt delivers there — the goods simply arrive along this segment. Present whenever the
    // tile behind this one belongs to the same belt.
    const behindX = tileX - stepX(belt.dir);
    const behindY = tileY - stepY(belt.dir);
    const behind = occupant.get(worldTileKey(behindX, behindY));
    const through = behind !== undefined && belts[behind]!.id === belt.id;

    const inMask = sideMask | (through ? arrivalSide(belt.dir) : 0);
    const shape = beltShape(departureSide(belt.dir), inMask);
    if (shape.kind === 'straight') continue;
    out.push({ tileX, tileY, tier: belt.tier, beltId: belt.id, shape });
  }
  return out;
}
