// Zoom, and the belt-flow level of detail.
//
// ────────────────────────────────────────────────────────────────────────────────────
//  THIS FILE IS THE CONTRACT BETWEEN INPUT AND THE RENDERER.
//
//  Input owns the zoom level, because zoom is driven by the mouse wheel and the +/-
//  keys. The renderer owns every pixel. Neither reaches into the other: input calls
//  `camera.setZoomIndex()` (already public, already integer-clamped) and publishes what
//  it did into `viewLod` below; the renderer reads `viewLod` — or better, calls
//  `beltItemsVisibleAt(scene.camera.zoom)` directly and needs nothing from here but a
//  threshold.
// ────────────────────────────────────────────────────────────────────────────────────
//
// WHY THE LOD IS A DESIGN ANSWER AND NOT AN OPTIMISATION. Plan §13 is explicit that the
// failure mode is not "1000 items at 3× zoom" — it is "the player zooms out to see the
// whole factory and every item in the world becomes eligible to draw". The instinctive
// fix is to draw them faster. The right fix is to stop: below a threshold an individual
// item on a belt is a couple of pixels of ambiguous colour, so it costs a draw call to
// communicate nothing. Draw the belt's *flow* instead — a scrolling tint whose speed
// encodes throughput — and the zoomed-out view becomes a circulatory system you can read
// at a glance. Fewer draw calls AND a better instrument. If a version of this ever costs
// more than drawing the items did, it is not a LOD and must not ship.
//
// WHERE THE THRESHOLD COMES FROM, arithmetically rather than by taste. Belt items sit
// `BELT_ITEM_SPACING_SUBTILES` (64) apart, which is a quarter of a 16 px tile — FOUR
// SOURCE PIXELS between one item and the next. At 2× that is eight CSS px of centre
// spacing for a sprite wider than eight px, so the items overlap into a smear that reads
// as a texture rather than as goods. At 3× the spacing is twelve px and a bag is a bag.
// So the boundary sits between 2 and 3, and the ladder has no rung in between — which is
// the whole point of the ladder.

import { ZOOM_LEVELS } from '../render/camera';
import type { ZoomLevel } from '../render/camera';

/**
 * The lowest zoom at which individual belt items are still drawn.
 *
 * With `ZOOM_LEVELS = [2, 3, 4, 6]` this means flow-only at 2×, items at 3× and up — and
 * 3× is where v0.1 shipped and where the game is normally played, so the common case is
 * unchanged and zooming out is the thing that switches instruments.
 */
export const BELT_ITEM_LOD_MIN_ZOOM = 3;

/** True when the item `ParticleContainer` should be populated at all. */
export function beltItemsVisibleAt(zoom: number): boolean {
  return zoom >= BELT_ITEM_LOD_MIN_ZOOM;
}

/**
 * What the renderer needs to know about the camera, published once per frame by the input
 * layer.
 *
 * A module-scope singleton rather than a field on the host, deliberately: it is pure
 * presentation, it is written by exactly one live host, and threading it through
 * `RenderUiState` would make every renderer signature depend on input's release schedule.
 * Under React StrictMode two hosts exist for a few milliseconds and both write here —
 * they write the same numbers, and nothing downstream is stateful, so last-writer-wins is
 * not merely tolerable, it is correct.
 *
 * NOTHING HERE IS SIM STATE. It is never hashed, never saved, never a `Command`, and
 * never read back into the world (§12).
 */
export interface ViewLod {
  /** The integer scale currently applied to the world root. */
  zoom: number;
  /** Index into `ZOOM_LEVELS`. */
  zoomIndex: number;
  /**
   * The flag the renderer branches on. `true` → populate the item container as usual;
   * `false` → leave it empty and draw belt flow instead.
   */
  beltItemsVisible: boolean;
}

export const viewLod: ViewLod = {
  zoom: ZOOM_LEVELS[1]!,
  zoomIndex: 1,
  beltItemsVisible: true,
};

/** Called by the input layer whenever the zoom changes, and once per frame besides. */
export function publishLod(zoomIndex: number): void {
  const clamped = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, Math.trunc(zoomIndex)));
  const zoom = ZOOM_LEVELS[clamped]!;
  viewLod.zoomIndex = clamped;
  viewLod.zoom = zoom;
  viewLod.beltItemsVisible = beltItemsVisibleAt(zoom);
}

/**
 * How fast a belt's flow tint should scroll, in SOURCE pixels per second.
 *
 * Handed to the renderer as a pure function so the scroll rate is derived in one place
 * and the two halves cannot drift apart. Two properties are load-bearing:
 *
 *   - AN EMPTY BELT DOES NOT SCROLL. A stalled line reading as "moving, just invisibly"
 *     is worse than no LOD at all — the whole point of the far view is spotting the
 *     segment that stopped.
 *   - A FULL FAST BELT SCROLLS FASTER THAN A FULL BASIC ONE, because the rate is the
 *     belt's own speed scaled by how loaded it is. Throughput, not velocity: a fast belt
 *     carrying four items an hour is not a busy belt.
 *
 * `speedSubtilesPer100Ticks` and the tile capacity both come from the sim's balance data;
 * nothing here invents a number. When `packages/sim` grows a real per-segment throughput
 * field in `view()` (work item 026, instruction 4), swap the occupancy estimate below for
 * it and delete the estimate — the signature does not change.
 */
export function beltFlowScrollPxPerSecond(
  speedSubtilesPer100Ticks: number,
  itemCount: number,
  lengthTiles: number,
  ticksPerSecond: number,
  subtilesPerTile: number,
  tilePx: number,
  itemSpacingSubtiles: number,
): number {
  if (itemCount <= 0 || lengthTiles <= 0) return 0;

  const capacity = Math.max(1, Math.floor((lengthTiles * subtilesPerTile) / itemSpacingSubtiles));
  const loadPermille = Math.min(1000, Math.round((itemCount * 1000) / capacity));

  const subtilesPerSecond = (speedSubtilesPer100Ticks * ticksPerSecond) / 100;
  const pxPerSecond = (subtilesPerSecond / subtilesPerTile) * tilePx;
  return (pxPerSecond * loadPermille) / 1000;
}

/** Zoom in one rung. Returns the new index; the ladder is the only permitted set. */
export function zoomInIndex(index: number): number {
  return Math.min(ZOOM_LEVELS.length - 1, index + 1);
}

/** Zoom out one rung. */
export function zoomOutIndex(index: number): number {
  return Math.max(0, index - 1);
}

export function zoomLevelAt(index: number): ZoomLevel {
  const clamped = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, Math.trunc(index)));
  return ZOOM_LEVELS[clamped]!;
}
