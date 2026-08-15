// The farmland's sprite pools, keyed to the COLLECTION rather than to a rectangle.
//
// Item 066 made farmland player-made: `FieldView` publishes `count`/`tileX[]`/`tileY[]` as
// the addressing scheme, the old `originX + i % tilesWide` arithmetic is wrong the moment
// anyone tills, and the bounding-box fields survive for framing only. This class is the
// renderer's half of that contract: one wet-soil sprite, one crop sprite, one compost heap
// and one ready mark PER FARM TILE, parallel to the projection's current indexing, moved
// whenever the collection changes shape.
//
// ── WHY A SYNC AND NOT A REBUILD ─────────────────────────────────────────────────────
// Tilling is a hand gesture — it happens on the frame a drag lands and then not again for
// minutes. So the per-frame cost is one O(count) key comparison over ~64–100 tiles, and the
// change path (repositioning every sprite, growing the pools) runs only on the frame the
// dirt actually moved. Sprites are pooled and hidden rather than destroyed: an un-till
// followed by a re-till reuses the same four sprites rather than churning the display list.
//
// The same sync OWNS THE FARMLAND SET the terrain bake reads (`world.ts`'s ground source):
// tilled positions rebake to dirt, un-tilled positions rebake to grass, and the tiles whose
// ground changed are marked dirty here — one diff, both consumers, no second copy of the
// key comparison to disagree with this one.

import { TILE_PX } from './pixel';

import { Sprite } from 'pixi.js';
import { worldKeyTileX, worldKeyTileY, worldTileKey } from '@snack/sim';
import type { FieldView } from '@snack/sim';

import { ART } from './textures';
import type { ArtSet } from './textures';

/** Where each of the four per-tile sprites is attached. Ground under crops under marks. */
export interface FieldTileAttach {
  /** Wet-soil overlays and compost litter: the ground-entity layer. */
  ground(sprite: Sprite): void;
  /** Crop plants: the same layer, added after the ground pieces so they draw over them. */
  crop(sprite: Sprite): void;
  /** Ready marks: the world-UI layer, above machines, with every other status readout. */
  ui(sprite: Sprite): void;
}

export class FieldTiles {
  /** Parallel to the projection's CURRENT indexing. Valid until the next till, like it. */
  readonly soil: Sprite[] = [];
  readonly crops: Sprite[] = [];
  readonly compost: Sprite[] = [];
  readonly readyMarks: Sprite[] = [];

  /** Last frame's collection, for the change test. World tile keys, projection order. */
  private readonly keys: number[] = [];
  private active = 0;

  constructor(
    private readonly art: ArtSet,
    private readonly attach: FieldTileAttach,
  ) {}

  /** How many farm tiles the pools are currently dressed for. */
  get count(): number {
    return this.active;
  }

  /**
   * Fold this frame's farmland in.
   *
   * Returns true when the collection changed shape — a till or an un-till landed — having
   * already repositioned the pools, updated `farmland` (the set the ground bake consults),
   * and marked every tile whose ground flipped via `markTileDirty`. On the overwhelming
   * majority of frames this is one array comparison and false.
   */
  sync(
    field: FieldView,
    farmland: Set<number>,
    markTileDirty: (tileX: number, tileY: number) => void,
  ): boolean {
    const count = field.count;

    let same = count === this.active;
    if (same) {
      for (let i = 0; i < count; i++) {
        if (this.keys[i] !== worldTileKey(field.tileX[i] ?? 0, field.tileY[i] ?? 0)) {
          same = false;
          break;
        }
      }
    }
    if (same) return false;

    // The ground diff: newly-tilled tiles rebake to dirt, un-tilled tiles back to grass.
    // Dirt needs no edge pass — the field tile is authored to tile arbitrarily (066's
    // check), so only the flipped tiles themselves re-bake, not their neighbours.
    const incoming = new Set<number>();
    for (let i = 0; i < count; i++) {
      incoming.add(worldTileKey(field.tileX[i] ?? 0, field.tileY[i] ?? 0));
    }
    for (const key of farmland) {
      if (!incoming.has(key)) markTileDirty(worldKeyTileX(key), worldKeyTileY(key));
    }
    for (const key of incoming) {
      if (!farmland.has(key)) markTileDirty(worldKeyTileX(key), worldKeyTileY(key));
    }
    farmland.clear();
    for (const key of incoming) farmland.add(key);

    // Re-dress the pools to the new collection. Every sprite is repositioned — indexes
    // shifted under the survivors too — and per-frame state (visibility, alpha, tint) is
    // reset so a sprite that used to be tile 12 carries nothing of tile 12 to its new home.
    for (let i = 0; i < count; i++) {
      this.grow(i);
      const tileX = field.tileX[i] ?? 0;
      const tileY = field.tileY[i] ?? 0;
      const left = tileX * TILE_PX;
      const top = tileY * TILE_PX;

      const wet = this.soil[i]!;
      wet.position.set(left, top);
      wet.alpha = 0;

      const crop = this.crops[i]!;
      crop.position.set(left + TILE_PX / 2, top + TILE_PX);
      crop.visible = false;
      crop.scale.set(1, 1);
      crop.tint = 0xffffff;

      const heap = this.compost[i]!;
      heap.position.set(left, top);
      heap.visible = false;

      const mark = this.readyMarks[i]!;
      mark.position.set(left + TILE_PX / 2, top);
      mark.visible = false;

      this.keys[i] = worldTileKey(tileX, tileY);
    }

    // The pool's tail — tiles that no longer exist — goes dark rather than away.
    for (let i = count; i < this.soil.length; i++) {
      this.soil[i]!.alpha = 0;
      this.crops[i]!.visible = false;
      this.compost[i]!.visible = false;
      this.readyMarks[i]!.visible = false;
    }
    this.keys.length = count;
    this.active = count;
    return true;
  }

  destroy(): void {
    // `destroy()` with no argument leaves the TEXTURES alone — all four point at the shared
    // atlas, which is not this pool's to free. Same rule as every other layer.
    for (const sprite of this.soil) sprite.destroy();
    for (const sprite of this.crops) sprite.destroy();
    for (const sprite of this.compost) sprite.destroy();
    for (const sprite of this.readyMarks) sprite.destroy();
    this.soil.length = 0;
    this.crops.length = 0;
    this.compost.length = 0;
    this.readyMarks.length = 0;
    this.keys.length = 0;
    this.active = 0;
  }

  /** Ensure pool slot `i` exists. Anchors and layers exactly as `world.ts` always built them. */
  private grow(i: number): void {
    if (this.soil[i] !== undefined) return;

    // Moisture is an ALPHA RAMP on a pre-darkened soil sprite, not a tint and not a
    // re-bake: the ground bake must stay static or the whole chunk design is pointless.
    const wet = new Sprite(this.art.get(ART.soilWet));
    wet.alpha = 0;
    this.attach.ground(wet);
    this.soil[i] = wet;

    // Compost sits UNDER the crop and over the soil: litter on the ground, not a plant.
    const heap = new Sprite(this.art.get(ART.uiCompost));
    heap.visible = false;
    this.attach.ground(heap);
    this.compost[i] = heap;

    // ANCHORED AT ITS BASE — the drink-bounce squashes the plant into the soil rather than
    // sliding it out of its tile. See the long anchor note this inherits from `world.ts`.
    const crop = new Sprite(this.art.get(ART.cropStage(1, 1)));
    crop.anchor.set(0.5, 1);
    crop.visible = false;
    this.attach.crop(crop);
    this.crops[i] = crop;

    const mark = new Sprite(this.art.get(ART.uiReady));
    mark.anchor.set(0.5, 1);
    mark.visible = false;
    this.attach.ui(mark);
    this.readyMarks[i] = mark;
  }
}
