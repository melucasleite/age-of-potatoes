// Shore auto-tiling: which frame a pond tile wears, from where the land around it is.
//
// ── THE WATER SIDE OWNS THE SHORE PIXELS ([[077]]) ──────────────────────────────────────
//
// The art lane's authoring convention, coded against verbatim: shore frames REPLACE WATER
// tiles — the pond's footprint is unchanged, and the land tiles around it are never
// touched. Three frames cover every bank a rectilinear pond can have, each authored in one
// base orientation and quarter-turned in code, exactly as `pipe-shape.ts` and `junction.ts`
// turn theirs:
//
//   terrain_shore_edge   — land due SOUTH (waterline horizontal, water up)
//   terrain_shore_outer  — land SOUTH and EAST (one smooth arc)
//   terrain_shore_inner  — land ONLY at the SOUTH-EAST diagonal (wedge into that corner)
//
// A tile with no land against it at all stays `terrain_water` — the centre of the pond is
// not this module's business.
//
// ── WHY THIS IS A PURE FUNCTION OF TWO MASKS ────────────────────────────────────────────
//
// Reservoirs never move and never resize, so a tile's shore variant is a static fact about
// the world, computed once at the reservoir sync (`render/index.ts`) and baked with the
// ground. The classification itself lives here with no Pixi, no scene and no textures, so
// the whole mask→frame table is testable headless — and it is, exhaustively: 16 cardinal
// masks × 16 diagonal masks, every one answered (`shore.test.ts`).
//
// The masks say where the LAND is (a set bit = a non-water neighbour). Tiles outside the
// world count as land: no reservoir reaches the world edge today, and a pond that someday
// does should visibly bank against the void rather than bleed water off the map.

import { worldTileKey } from '@snack/sim';

import { PipeSide } from './pipe-shape';

// The cardinal bits are the pipe layer's, re-exported under the name this module uses them
// by — the same single-convention rule `junction.ts` follows, and for the same reason: two
// auto-tilers that each privately decide which bit means north agree only until one is
// edited.
export { PipeSide as ShoreSide };

/** Diagonal land bits, numbered clockwise from north-east, disjoint from the cardinals. */
export const ShoreCorner = {
  NorthEast: 1,
  SouthEast: 2,
  SouthWest: 4,
  NorthWest: 8,
} as const;

/** The three shore frames plus the untouched centre, by atlas name. */
export const SHORE_FRAME = {
  water: 'terrain_water',
  edge: 'terrain_shore_edge',
  outer: 'terrain_shore_outer',
  inner: 'terrain_shore_inner',
} as const;

export type ShoreFrameKind = keyof typeof SHORE_FRAME;

export interface ShoreVariant {
  frame: ShoreFrameKind;
  /** Quarter turns CLOCKWISE from the frame's authored base orientation, 0..3. */
  quarterTurns: number;
}

/**
 * A clockwise quarter turn carries the authored land-south base S→W→N→E: rotating the
 * PICTURE 90° clockwise moves what was at the bottom edge to the left edge. These tables
 * read "turns needed for land at side X", derived from that one fact.
 */
const EDGE_TURNS: readonly (readonly [number, number])[] = [
  [PipeSide.South, 0],
  [PipeSide.West, 1],
  [PipeSide.North, 2],
  [PipeSide.East, 3],
];

/** The outer corner's base is land S+E; the pair walks S+E → S+W → N+W → N+E clockwise. */
const OUTER_TURNS: readonly (readonly [number, number])[] = [
  [PipeSide.South | PipeSide.East, 0],
  [PipeSide.South | PipeSide.West, 1],
  [PipeSide.North | PipeSide.West, 2],
  [PipeSide.North | PipeSide.East, 3],
];

/** The inner corner's base is land at SE only; the diagonal walks SE → SW → NW → NE. */
const INNER_TURNS: readonly (readonly [number, number])[] = [
  [ShoreCorner.SouthEast, 0],
  [ShoreCorner.SouthWest, 1],
  [ShoreCorner.NorthWest, 2],
  [ShoreCorner.NorthEast, 3],
];

/** How many of the four low bits are set. The masks are 4-bit, so this is the whole count. */
function bits(mask: number): number {
  let count = 0;
  for (let bit = 1; bit <= 8; bit <<= 1) if ((mask & bit) !== 0) count += 1;
  return count;
}

/**
 * The shore variant for one water tile, from its land masks.
 *
 * TOTAL over all 256 mask pairs, because a partial table is a magenta tile in a shipped
 * pond. The genuinely rectilinear cases — the only ones today's axis-aligned reservoirs
 * can produce — map exactly; the degenerate ones (a one-tile channel, a dead-end nub, a
 * fully landlocked puddle) have no authored frame and take the nearest honest neighbour,
 * each pinned by test so the choice is a decision rather than an accident:
 *
 *   cardinal 0, diagonals 0   → water (pond centre)
 *   cardinal 0, diagonals >0  → inner, turned to the first land diagonal (SE-first order;
 *                               two diagonals at once is an L-shaped isthmus — one wedge
 *                               drawn, the other a soft seam, same shape of concession as
 *                               the junction's four-belt case)
 *   cardinal 1                → edge, land side down
 *   cardinal 2, adjacent      → outer, arc into the land corner
 *   cardinal 2, opposite      → edge toward the first land side (S,W,N,E) — a 1-wide
 *                               channel; one bank drawn, the other left soft
 *   cardinal 3                → outer, turned into the first fully-land corner — a nub's
 *                               least-wrong reading is "mostly bank"
 *   cardinal 4                → water: a landlocked one-tile puddle has no orientation to
 *                               give a directional frame, and plain water is the only
 *                               answer that lies about no particular direction
 */
export function shoreVariant(cardinalLand: number, diagonalLand: number): ShoreVariant {
  const cardinal = cardinalLand & 0xf;
  const diagonal = diagonalLand & 0xf;
  const landSides = bits(cardinal);

  if (landSides === 0) {
    if (diagonal === 0) return { frame: 'water', quarterTurns: 0 };
    for (const [corner, turns] of INNER_TURNS) {
      if ((diagonal & corner) !== 0) return { frame: 'inner', quarterTurns: turns };
    }
  }

  if (landSides === 1) {
    for (const [side, turns] of EDGE_TURNS) {
      if ((cardinal & side) !== 0) return { frame: 'edge', quarterTurns: turns };
    }
  }

  if (landSides === 2) {
    for (const [pair, turns] of OUTER_TURNS) {
      if ((cardinal & pair) === pair) return { frame: 'outer', quarterTurns: turns };
    }
    // Opposite pair — N+S or E+W. Fall through to the edge priority order below.
    for (const [side, turns] of EDGE_TURNS) {
      if ((cardinal & side) !== 0) return { frame: 'edge', quarterTurns: turns };
    }
  }

  if (landSides === 3) {
    for (const [pair, turns] of OUTER_TURNS) {
      if ((cardinal & pair) === pair) return { frame: 'outer', quarterTurns: turns };
    }
  }

  return { frame: 'water', quarterTurns: 0 };
}

/**
 * The twelve bakeable variants, enumerated for the texture pre-bake: every frame×turn pair
 * `shoreVariant` can answer with, except the untouched water centre. Order is the baked
 * texture array's index space — `variantIndex` below is the lookup the ground bake uses.
 */
export const SHORE_VARIANTS: readonly ShoreVariant[] = (
  ['edge', 'outer', 'inner'] as const
).flatMap((frame) => [0, 1, 2, 3].map((quarterTurns) => ({ frame, quarterTurns })));

/** The index into `SHORE_VARIANTS` for a non-water variant, or -1 for plain water. */
export function shoreVariantIndex(variant: ShoreVariant): number {
  if (variant.frame === 'water') return -1;
  const frameIndex = variant.frame === 'edge' ? 0 : variant.frame === 'outer' ? 1 : 2;
  return frameIndex * 4 + variant.quarterTurns;
}

/**
 * Classify every tile of a water set into the shore map the ground bake reads.
 *
 * `waterAt` rather than the set itself so the caller decides what water is — the renderer
 * hands in a closure over its own key set. Keys in the RESULT are `worldTileKey`s, the same
 * vocabulary the ground bake already reads the water set in. Answers ONLY the tiles that
 * need a shore frame; centre tiles are absent from the result, which is what keeps the
 * map's size the pond's perimeter rather than its area.
 */
export function classifyShore(
  tiles: Iterable<readonly [number, number]>,
  waterAt: (tileX: number, tileY: number) => boolean,
): Map<number, number> {
  const out = new Map<number, number>();
  for (const [tileX, tileY] of tiles) {
    let cardinal = 0;
    if (!waterAt(tileX, tileY - 1)) cardinal |= PipeSide.North;
    if (!waterAt(tileX + 1, tileY)) cardinal |= PipeSide.East;
    if (!waterAt(tileX, tileY + 1)) cardinal |= PipeSide.South;
    if (!waterAt(tileX - 1, tileY)) cardinal |= PipeSide.West;

    let diagonal = 0;
    if (!waterAt(tileX + 1, tileY - 1)) diagonal |= ShoreCorner.NorthEast;
    if (!waterAt(tileX + 1, tileY + 1)) diagonal |= ShoreCorner.SouthEast;
    if (!waterAt(tileX - 1, tileY + 1)) diagonal |= ShoreCorner.SouthWest;
    if (!waterAt(tileX - 1, tileY - 1)) diagonal |= ShoreCorner.NorthWest;

    const index = shoreVariantIndex(shoreVariant(cardinal, diagonal));
    if (index >= 0) out.set(worldTileKey(tileX, tileY), index);
  }
  return out;
}
