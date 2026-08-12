// Chunked terrain baking.
//
// `./pixel` first: this module creates `RenderTexture`s and must not run before
// `scaleMode = 'nearest'` is set. See the comment block there.
import { CHUNK_PX, CHUNK_TILES, TILE_PX } from './pixel';

import { Container, RenderTexture, Sprite } from 'pixi.js';
import type { Renderer, Texture } from 'pixi.js';

import type { WorldRect } from './camera';

// Why this is hand-rolled: plan §11 rules out `@pixi/tilemap` explicitly. 5.0.2 is about
// a year stale against a Pixi core that shipped four minor versions in the same window,
// and the plan's judgement is that baking chunks yourself is *about the same amount of
// work* with no dependency risk. Do not "simplify" this by installing a tilemap package.
//
// The design in one line: a chunk's 1,024 ground tiles are drawn ONCE into a
// `RenderTexture` and then live as a single `Sprite`. Nothing re-bakes on a frame with no
// edits — that is the entire point, and "chunks baked this frame" on the dev overlay is
// how a re-bake loop gets noticed the day it appears rather than at the next profiling
// session.

/**
 * One tinted decal in the overlay pass.
 *
 * The overlay carries a tint and an alpha where the ground pass does not, because a zone's
 * colour is a property of the ZONE and not of the art: one white fill texture and one white
 * edge texture per side serve every zone the player ever paints, at any colour, and the
 * whole thing is still baked into the chunk once and then costs nothing.
 */
export interface OverlayPaint {
  texture: Texture;
  /** Multiplied into the decal. `0xffffff` leaves it alone. */
  tint: number;
  alpha: number;
}

/** What to draw at a world tile, per pass. `null` means "nothing on this pass". */
export interface TerrainSource {
  ground(tileX: number, tileY: number): Texture | null;
  /** The zone-paint pass: fill and boundary decals, or null on an unpainted tile. */
  overlay(tileX: number, tileY: number): readonly OverlayPaint[] | null;
}

interface Chunk {
  cx: number;
  cy: number;
  ground: Sprite;
  overlay: Sprite | null;
  groundTexture: RenderTexture;
  overlayTexture: RenderTexture | null;
}

export class TerrainBaker {
  private readonly chunks = new Map<string, Chunk>();
  private readonly dirty = new Set<string>();
  private readonly chunksWide: number;
  private readonly chunksHigh: number;

  /** Chunks baked during the last `drainDirty()`. The dev overlay reads this. */
  bakedLastFrame = 0;

  constructor(
    private readonly renderer: Renderer,
    private readonly source: TerrainSource,
    private readonly worldTilesWide: number,
    private readonly worldTilesHigh: number,
  ) {
    this.chunksWide = Math.max(1, Math.ceil(worldTilesWide / CHUNK_TILES));
    this.chunksHigh = Math.max(1, Math.ceil(worldTilesHigh / CHUNK_TILES));
    for (let cy = 0; cy < this.chunksHigh; cy++) {
      for (let cx = 0; cx < this.chunksWide; cx++) {
        this.createChunk(cx, cy);
        this.dirty.add(key(cx, cy));
      }
    }
  }

  /** Every chunk sprite, ground pass then overlay pass, for attaching to layers. */
  groundSprites(): Sprite[] {
    return [...this.chunks.values()].map((chunk) => chunk.ground);
  }

  overlaySprites(): Sprite[] {
    const out: Sprite[] = [];
    for (const chunk of this.chunks.values()) {
      if (chunk.overlay !== null) out.push(chunk.overlay);
    }
    return out;
  }

  markChunkDirty(cx: number, cy: number): void {
    if (cx < 0 || cy < 0 || cx >= this.chunksWide || cy >= this.chunksHigh) return;
    this.dirty.add(key(cx, cy));
  }

  /** The call an edit makes: it knows a tile, not a chunk. */
  markTileDirty(tileX: number, tileY: number): void {
    this.markChunkDirty(Math.floor(tileX / CHUNK_TILES), Math.floor(tileY / CHUNK_TILES));
  }

  markAllDirty(): void {
    for (const k of this.chunks.keys()) this.dirty.add(k);
  }

  /**
   * Re-bake queued chunks. Returns how many were baked — zero on a steady-state frame,
   * which is the invariant worth watching.
   */
  drainDirty(maxPerFrame = 4): number {
    let baked = 0;
    for (const k of this.dirty) {
      if (baked >= maxPerFrame) break;
      const chunk = this.chunks.get(k);
      this.dirty.delete(k);
      if (chunk === undefined) continue;
      this.bake(chunk);
      baked += 1;
    }
    this.bakedLastFrame = baked;
    return baked;
  }

  /**
   * Which chunk indices the camera rect covers — arithmetic on four numbers, not a
   * bounds traversal. Plan §13: culling is opt-in in Pixi v8 (it moved out of the render
   * loop), so nothing is culled unless you cull it, and this is the cheapest possible
   * way to do it for a grid.
   */
  visibleChunks(rect: WorldRect): { minX: number; minY: number; maxX: number; maxY: number } {
    const minX = Math.max(0, Math.floor(rect.x / CHUNK_PX));
    const minY = Math.max(0, Math.floor(rect.y / CHUNK_PX));
    const maxX = Math.min(this.chunksWide - 1, Math.floor((rect.x + rect.width) / CHUNK_PX));
    const maxY = Math.min(this.chunksHigh - 1, Math.floor((rect.y + rect.height) / CHUNK_PX));
    return { minX, minY, maxX, maxY };
  }

  /** Set chunk-sprite visibility from the camera rect. Returns the visible count. */
  cull(rect: WorldRect): number {
    const box = this.visibleChunks(rect);
    let visible = 0;
    for (const chunk of this.chunks.values()) {
      const inside =
        chunk.cx >= box.minX &&
        chunk.cx <= box.maxX &&
        chunk.cy >= box.minY &&
        chunk.cy <= box.maxY;
      chunk.ground.visible = inside;
      if (chunk.overlay !== null) chunk.overlay.visible = inside;
      if (inside) visible += 1;
    }
    return visible;
  }

  destroy(): void {
    for (const chunk of this.chunks.values()) {
      chunk.ground.destroy();
      chunk.groundTexture.destroy(true);
      chunk.overlay?.destroy();
      chunk.overlayTexture?.destroy(true);
    }
    this.chunks.clear();
    this.dirty.clear();
  }

  // --- internals -------------------------------------------------------------------

  private createChunk(cx: number, cy: number): void {
    const groundTexture = newChunkTexture();
    const ground = new Sprite(groundTexture);
    ground.position.set(cx * CHUNK_PX, cy * CHUNK_PX);

    // The zone-paint pass gets its own texture and sprite up front so [[018]] is a
    // content change rather than a structural one. It stays transparent in v0.1.
    const overlayTexture = newChunkTexture();
    const overlay = new Sprite(overlayTexture);
    overlay.position.set(cx * CHUNK_PX, cy * CHUNK_PX);

    this.chunks.set(key(cx, cy), { cx, cy, ground, overlay, groundTexture, overlayTexture });
  }

  private bake(chunk: Chunk): void {
    this.bakePass(chunk, 'ground', chunk.groundTexture);
    if (chunk.overlayTexture !== null) this.bakePass(chunk, 'overlay', chunk.overlayTexture);
  }

  private bakePass(chunk: Chunk, pass: 'ground' | 'overlay', target: RenderTexture): void {
    // A throwaway container of tile sprites, rendered once and thrown away. Retaining
    // 1,024 sprites per chunk would defeat the whole exercise.
    const scratch = new Container();
    const baseX = chunk.cx * CHUNK_TILES;
    const baseY = chunk.cy * CHUNK_TILES;

    for (let ty = 0; ty < CHUNK_TILES; ty++) {
      const tileY = baseY + ty;
      if (tileY >= this.worldTilesHigh) break;
      for (let tx = 0; tx < CHUNK_TILES; tx++) {
        const tileX = baseX + tx;
        if (tileX >= this.worldTilesWide) break;
        if (pass === 'ground') {
          const texture = this.source.ground(tileX, tileY);
          if (texture === null) continue;
          const sprite = new Sprite(texture);
          sprite.position.set(tx * TILE_PX, ty * TILE_PX);
          scratch.addChild(sprite);
          continue;
        }

        const paints = this.source.overlay(tileX, tileY);
        if (paints === null) continue;
        for (let i = 0; i < paints.length; i++) {
          const paint = paints[i]!;
          const sprite = new Sprite(paint.texture);
          sprite.position.set(tx * TILE_PX, ty * TILE_PX);
          sprite.tint = paint.tint;
          sprite.alpha = paint.alpha;
          scratch.addChild(sprite);
        }
      }
    }

    this.renderer.render({ container: scratch, target, clear: true });
    scratch.destroy({ children: true });
  }
}

function newChunkTexture(): RenderTexture {
  return RenderTexture.create({
    width: CHUNK_PX,
    height: CHUNK_PX,
    // Resolution 1: the bake is in SOURCE pixels. The camera's integer zoom is what
    // scales it up, and a chunk baked at devicePixelRatio would be scaled twice.
    resolution: 1,
    antialias: false,
    scaleMode: 'nearest',
  });
}

function key(cx: number, cy: number): string {
  return `${cx},${cy}`;
}
