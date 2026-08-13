// Belt items, as a query result.
//
// ────────────────────────────────────────────────────────────────────────────────────
//  A RENDERED BELT ITEM IS NOT AN OBJECT. IT IS A QUERY RESULT. (Plan §13, [[012]].)
//
//  There is no particle per sim item. There is no map from item to sprite, no creation
//  hook on insert, no destruction hook on consume, and no resync pass — because there is
//  nothing to keep in sync. Every frame this module walks the VISIBLE belt segments in
//  the projection and writes screen positions into a pooled buffer. An item that leaves
//  the screen stops being written; an item that arrives starts being written; nothing
//  is allocated or freed either way.
//
//  If a bug here is ever fixed by "resyncing particles with sim items", the model has
//  been abandoned and the 5,000-item case has been quietly lost. The fix is always to
//  the derivation, never to bookkeeping that should not exist.
// ────────────────────────────────────────────────────────────────────────────────────
//
// The `ParticleContainer` constraints that shape everything below, each of which fails
// SILENTLY rather than throwing:
//
//   * Particles support no interactivity, no children, no filters, no masks. Survivable
//     only because picking is `beltItemAtTile()` — a sim-side lookup on plain view data,
//     never a hit test. That function exists and is correct before anything calls it.
//   * ALL PARTICLES MUST SHARE ONE `TextureSource`. Not "should": the batch silently
//     draws the wrong frames otherwise. `buildItemPage()` below makes that true BY
//     CONSTRUCTION — every item chip is blitted into one render texture at load, so the
//     rule holds whether the art pipeline shipped an atlas, half an atlas, or nothing.
//   * `dynamicProperties` stays at `position` only. Everything else is static, and a
//     static property changed without `container.update()` simply does not appear.
//     Frame (uv) changes and count changes are static, so both raise `staticDirty`.
//   * Culling is opt-in in v8. It is done here analytically, from the camera rect, by
//     never writing an off-screen item at all — cheaper than any culler and it is what
//     "a pool sized to the viewport, not to the world" actually means.
//
// Interpolation is WRITE-ONLY (§12). Item positions are extrapolated from the belt's own
// tier speed and the frame `alpha`, which needs no history and touches nothing: no
// previous-frame array, nothing read back into the sim, nothing persisted, nothing hashed.

// `./pixel` first — this module builds a render texture at load. See the block there.
import { TILE_PX } from './pixel';

import {
  Container,
  Particle,
  ParticleContainer,
  Rectangle,
  RenderTexture,
  Sprite,
  Texture,
} from 'pixi.js';
import type { Renderer } from 'pixi.js';
import { BELT_ITEM_SPACING_SUBTILES, ITEM_SPECS, SUBTILE } from '@snack/sim';
import type { BeltView, WorldView } from '@snack/sim';

import type { WorldRect } from './camera';
import { beltSubtilesPerTick, stepX as dirStepX, stepY as dirStepY } from './directions';
import { ART, ITEM_CHIP_PX } from './textures';
import type { ArtSet } from './textures';

/** Transparent gutter between chips, so nearest sampling at a quad edge cannot bleed. */
const PAGE_PAD = 1;
const PAGE_CELL = ITEM_CHIP_PX + PAGE_PAD * 2;

/** Subtiles per world pixel. Belt distances are subtiles; the screen is pixels. */
const SUB_PER_PX = SUBTILE / TILE_PX;

/**
 * How far past the camera rect an item is still written, in world px. One chip width, so
 * a bag straddling the viewport edge is drawn rather than popping in when its centre
 * crosses.
 */
const CULL_MARGIN_PX = ITEM_CHIP_PX;

/** The pool never grows past this. A viewport this full is a bug, not a factory. */
const MAX_PARTICLES = 16_384;

/**
 * One texture source, every belt-rideable good.
 *
 * Built by blitting each item's art — real frame or grey-box placeholder — into a single
 * strip render texture. That is the whole enforcement of the single-page rule at runtime:
 * it cannot be violated by an art build, because the art never reaches the particle batch
 * directly.
 */
export interface ItemPage {
  texture(itemId: number): Texture;
  destroy(): void;
}

export function buildItemPage(renderer: Renderer, art: ArtSet): ItemPage {
  const ids = ITEM_SPECS.map((spec) => spec.id as number);
  const page = RenderTexture.create({
    width: Math.max(1, ids.length * PAGE_CELL),
    height: PAGE_CELL,
    resolution: 1,
    antialias: false,
    scaleMode: 'nearest',
  });

  const scratch = new Container();
  for (let i = 0; i < ids.length; i++) {
    const source = art.get(ART.item(ids[i]!));
    const sprite = new Sprite(source);
    // Art may arrive at 16px (an atlas frame) or already at 8px (a placeholder). Fit it
    // to the cell either way; a 16→8 halving is exact, which is why the cell is 8.
    const w = source.width > 0 ? source.width : ITEM_CHIP_PX;
    const h = source.height > 0 ? source.height : ITEM_CHIP_PX;
    sprite.scale.set(ITEM_CHIP_PX / w, ITEM_CHIP_PX / h);
    sprite.position.set(i * PAGE_CELL + PAGE_PAD, PAGE_PAD);
    scratch.addChild(sprite);
  }
  renderer.render({ container: scratch, target: page, clear: true });
  scratch.destroy({ children: true });

  const frames = new Map<number, Texture>();
  for (let i = 0; i < ids.length; i++) {
    frames.set(
      ids[i]!,
      new Texture({
        source: page.source,
        frame: new Rectangle(i * PAGE_CELL + PAGE_PAD, PAGE_PAD, ITEM_CHIP_PX, ITEM_CHIP_PX),
      }),
    );
  }
  const fallback = frames.get(ids[0]!) ?? Texture.EMPTY;

  return {
    texture(itemId: number): Texture {
      return frames.get(itemId) ?? fallback;
    },
    destroy(): void {
      for (const texture of frames.values()) texture.destroy(false);
      frames.clear();
      page.destroy(true);
    },
  };
}

export class BeltItemLayer {
  readonly container: ParticleContainer;

  private readonly page: ItemPage;
  /** Pre-allocated. Grown on demand, never shrunk, never freed per item. */
  private readonly pool: Particle[] = [];
  /** What frame each pool slot currently carries, so uv churn is detected, not assumed. */
  private readonly slotItem: number[] = [];

  /** The page is passed IN and owned by the scene: grabber cargo draws from it too. */
  constructor(page: ItemPage, worldWidthPx: number, worldHeightPx: number) {
    this.page = page;
    this.container = new ParticleContainer({
      // Position only. Anything wider costs per-frame upload bandwidth for a property
      // that does not change, which is the whole reason this container is fast.
      dynamicProperties: { position: true, vertex: false, rotation: false, color: false },
      texture: this.page.texture(ITEM_SPECS[0]!.id as number),
    });
    // Bounds are never computed for a ParticleContainer. Declaring the world rect keeps
    // any ancestor that asks for bounds from getting an empty box and culling us away.
    this.container.boundsArea = new Rectangle(0, 0, worldWidthPx, worldHeightPx);
  }

  /** Particles written last frame. The dev overlay's honest answer to "how many items?". */
  get liveCount(): number {
    return this.container.particleChildren.length;
  }

  /**
   * Derive this frame's particles from the projection.
   *
   * `rect` is the camera rect in world pixels — the transform that was actually applied,
   * not an idealised one.
   */
  update(view: WorldView, alpha: number, rect: WorldRect): void {
    const children = this.container.particleChildren;
    const minX = rect.x - CULL_MARGIN_PX;
    const minY = rect.y - CULL_MARGIN_PX;
    const maxX = rect.x + rect.width + CULL_MARGIN_PX;
    const maxY = rect.y + rect.height + CULL_MARGIN_PX;

    let n = 0;
    let staticDirty = false;

    for (let b = 0; b < view.belts.length; b++) {
      const belt = view.belts[b]!;
      if (belt.itemCount === 0) continue;

      const stepX = dirStepX(belt.dir);
      const stepY = dirStepY(belt.dir);
      const lengthPx = belt.lengthTiles * TILE_PX;

      // The belt's start CORNER: a west-running belt begins at the east edge of its first
      // tile, so `origin + step * along` walks the segment for every direction.
      const originX = belt.tileX * TILE_PX + (stepX === -1 ? TILE_PX : 0);
      const originY = belt.tileY * TILE_PX + (stepY === -1 ? TILE_PX : 0);

      // Reject on the perpendicular axis first — one comparison kills every belt on a
      // row the camera cannot see.
      if (stepX !== 0) {
        const top = belt.tileY * TILE_PX;
        if (top > maxY || top + TILE_PX < minY) continue;
      } else {
        const left = belt.tileX * TILE_PX;
        if (left > maxX || left + TILE_PX < minX) continue;
      }

      // Then clip along the belt, analytically. This is what sizes the pool to the
      // viewport: an off-screen half of a sixteen-tile belt is never even iterated.
      let alongLo: number;
      let alongHi: number;
      if (stepX !== 0) {
        const a = (minX - originX) * stepX;
        const c = (maxX - originX) * stepX;
        alongLo = a < c ? a : c;
        alongHi = a < c ? c : a;
      } else {
        const a = (minY - originY) * stepY;
        const c = (maxY - originY) * stepY;
        alongLo = a < c ? a : c;
        alongHi = a < c ? c : a;
      }
      if (alongHi < 0 || alongLo > lengthPx) continue;

      const distLo = alongLo * SUB_PER_PX;
      const distHi = alongHi * SUB_PER_PX;

      const lo = lowerBound(belt.itemDist, belt.itemCount, distLo);
      const hi = upperBound(belt.itemDist, belt.itemCount, distHi) - 1;
      if (hi < lo) continue;

      const advance = beltSubtilesPerTick(belt.tier) * alpha;
      const end = belt.lengthTiles * SUBTILE - 1;

      // Walk the visible run from its head backwards, exactly as the sim advances a belt,
      // so a compacted queue stays compacted and a blocked one visibly stops. Seeded from
      // the item just past the visible range where there is one: the seed can be off by at
      // most one tick of travel, and only for an item that is off-screen.
      let aheadRender =
        hi + 1 < belt.itemCount
          ? Math.min(belt.itemDist[hi + 1]! + advance, end)
          : Number.POSITIVE_INFINITY;

      for (let j = hi; j >= lo; j--) {
        const raw = belt.itemDist[j]!;
        const ceiling = Math.min(end, aheadRender - BELT_ITEM_SPACING_SUBTILES);
        const dist = Math.min(raw + advance, ceiling > raw ? ceiling : raw);
        aheadRender = dist;

        if (n >= MAX_PARTICLES) break;

        const along = dist / SUB_PER_PX;
        const x = originX + stepX * along + (stepX === 0 ? TILE_PX / 2 : 0);
        const y = originY + stepY * along + (stepY === 0 ? TILE_PX / 2 : 0);
        if (x < minX || x > maxX || y < minY || y > maxY) continue;

        const item = belt.itemType[j]!;
        const particle = this.slot(n);
        particle.x = x;
        particle.y = y;
        if (this.slotItem[n] !== item) {
          // A frame swap is a UV change, and UVs are static. Without the `update()` below
          // the particle keeps drawing whatever it drew last — a potato all the way into
          // the bagger, and nothing in the console to say why.
          particle.texture = this.page.texture(item);
          this.slotItem[n] = item;
          staticDirty = true;
        }
        n += 1;
      }
    }

    if (children.length !== n) {
      if (n < children.length) {
        children.length = n;
      } else {
        for (let i = children.length; i < n; i++) children.push(this.pool[i]!);
      }
      staticDirty = true;
    }
    if (staticDirty) this.container.update();
  }

  /**
   * Draw no items at all. The zoomed-out half of the flow LOD.
   *
   * ────────────────────────────────────────────────────────────────────────────────────
   *  THIS IS THE LOD ACTUALLY COSTING LESS, and it is worth being precise about why.
   *
   *  An empty `ParticleContainer` submits NO draw call — there is no batch to flush — so
   *  below the threshold the entire item path costs one comparison per frame instead of a
   *  buffer upload and a draw. The derivation is skipped too: `update()` is never entered,
   *  so no belt is walked and no binary search is run.
   *
   *  Nothing is freed. The pool keeps its particles and `slotItem` keeps its frames, so
   *  zooming back in repopulates from the pool with no allocation — which is what makes the
   *  switch survivable in both directions. A LOD that reallocated on every zoom change would
   *  hitch at exactly the moment the player is moving the camera.
   * ────────────────────────────────────────────────────────────────────────────────────
   */
  clear(): void {
    const children = this.container.particleChildren;
    if (children.length === 0) return;
    children.length = 0;
    // Count is a STATIC property. Without this the batch keeps drawing the particles it
    // uploaded last frame — items still on screen at a zoom that is supposed to have none.
    this.container.update();
  }

  /** Does NOT destroy the item page — the scene owns it and the grabbers still want it. */
  destroy(): void {
    this.container.particleChildren.length = 0;
    this.container.destroy();
    this.pool.length = 0;
    this.slotItem.length = 0;
  }

  /** Grow the pool to cover slot `index`. Allocation happens here and nowhere else. */
  private slot(index: number): Particle {
    let particle = this.pool[index];
    if (particle === undefined) {
      const item = ITEM_SPECS[0]!.id as number;
      particle = new Particle({
        texture: this.page.texture(item),
        anchorX: 0.5,
        anchorY: 0.5,
      });
      this.pool[index] = particle;
      this.slotItem[index] = item;
    }
    return particle;
  }
}

// --- picking -------------------------------------------------------------------------

export interface BeltItemPick {
  beltId: number;
  /** `ItemId` under the cursor. */
  item: number;
  /** Subtiles from the belt's start. */
  dist: number;
}

/**
 * What is riding the belt on a tile, if anything.
 *
 * SCREEN → TILE → SEGMENT → NEAREST ITEM BY DISTANCE, entirely on plain view data. This is
 * the function that makes "particles have no interactivity" a non-issue, and it is written
 * now — while the data model is fresh — precisely so that no future UI is ever tempted to
 * reach for a hit test that cannot exist.
 *
 * Furthest along wins, matching `beltTakeFromTile` in the sim: the front of the queue is
 * what a player pointing at a tile means.
 */
export function beltItemAtTile(view: WorldView, tileX: number, tileY: number): BeltItemPick | null {
  for (let b = 0; b < view.belts.length; b++) {
    const belt = view.belts[b]!;
    const index = beltTileIndex(belt, tileX, tileY);
    if (index < 0) continue;

    for (let j = belt.itemCount - 1; j >= 0; j--) {
      const dist = belt.itemDist[j]!;
      const tile = Math.min(belt.lengthTiles - 1, Math.max(0, Math.floor(dist / SUBTILE)));
      if (tile !== index) continue;
      return { beltId: belt.id, item: belt.itemType[j]!, dist };
    }
    return null;
  }
  return null;
}

/** Index of a world tile along a belt, or -1. The view-data twin of the sim's own helper. */
export function beltTileIndex(belt: BeltView, tileX: number, tileY: number): number {
  const stepX = dirStepX(belt.dir);
  const stepY = dirStepY(belt.dir);
  const offset = stepX !== 0 ? (tileX - belt.tileX) * stepX : (tileY - belt.tileY) * stepY;
  if (offset < 0 || offset >= belt.lengthTiles) return -1;
  // The other axis must match exactly, or a parallel belt one row over would answer.
  if (stepX !== 0 && tileY !== belt.tileY) return -1;
  if (stepY !== 0 && tileX !== belt.tileX) return -1;
  return offset;
}

// --- sorted-array search ---------------------------------------------------------------
// `itemDist` is ascending by construction (the sim keeps it so), which is what lets the
// visible run be found in log time instead of by scanning a belt that is mostly off-screen.

function lowerBound(values: number[], count: number, target: number): number {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(values: number[], count: number, target: number): number {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid]! <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
