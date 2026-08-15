// The belt surface: a tile layer animated by SCROLLING UVs.
//
// Not by moving sprites. Plan §13 calls this "a shader trick that costs nothing", and the
// distinction is the whole point: a conveyor drawn as a row of marching sprites is N
// transforms a frame plus a wrap-around bug at each end, while a conveyor drawn as one
// quad with an animated texture offset is a single number per belt and cannot desynchronise
// from itself.
//
// ONE QUAD PER SEGMENT, and the quad never moves. `tilePosition.x` advances along the
// belt's own local +x, which is "forward" for every direction once the sprite is rotated —
// so a north-running belt and an east-running belt are the same code and the same texture.
//
// ────────────────────────────────────────────────────────────────────────────────────
//  WHY THE BELT TEXTURE IS COPIED OUT OF THE ATLAS INSTEAD OF USED FROM IT.
//
//  Pixi v8 batches a `TilingSprite` only when `texture.textureMatrix.isSimple` — that is,
//  when the texture is a whole standalone source rather than a sub-rectangle of an atlas.
//  An atlas frame therefore costs a draw call per belt.
//
//  Worse, and this is the part that would take a day to find: the batched path sets
//  `addressMode = 'repeat'` ON THE TEXTURE SOURCE. Handing it an atlas frame would flip
//  the shared atlas to wrapping — which does not break the belt, it breaks some unrelated
//  sprite on the far side of the page, later, once.
//
//  So each tier's tile is blitted once into its own 16×16 render texture at load. One
//  extra texture per tier, and belts batch together into the same draw call.
// ────────────────────────────────────────────────────────────────────────────────────

// `./pixel` first — this module creates render textures. See the block there.
import { TILE_PX } from './pixel';

import { Container, RenderTexture, Sprite, TilingSprite } from 'pixi.js';
import type { Renderer, Texture } from 'pixi.js';
import {
  BELT_ITEM_SPACING_SUBTILES,
  BELT_SPECS,
  Direction,
  LampState,
  SUBTILE,
  TICKS_PER_SECOND,
} from '@snack/sim';
import type { WorldView } from '@snack/sim';

import { beltLoadPermille } from '../input/lod';
import type { WorldRect } from './camera';
import { beltSubtilesPerTick, stepX as dirStepX, stepY as dirStepY } from './directions';
import { LAMP_TINT } from './lamps';
import { ART } from './textures';
import type { ArtSet } from './textures';

/** Quarter turns per compass direction, so the segment's local +x runs downstream. */
const TURN: Record<number, number> = {
  [Direction.East]: 0,
  [Direction.South]: Math.PI / 2,
  [Direction.West]: Math.PI,
  [Direction.North]: -Math.PI / 2,
};

/** No tint. What a belt looks like at every zoom where the goods on it are drawn. */
const NO_TINT = 0xffffff;

// ────────────────────────────────────────────────────────────────────────────────────
//  THE FLOW COLOURS ARE THE LAMP'S COLOURS, TAKEN FROM THE LAMP.
//
//  Plan §5's status grammar is the same grammar on every object in the game, so the far
//  view does not get a second vocabulary: a belt with goods moving on it is RUNNING and
//  reads the lamps' green, a belt with nothing on it is off and reads the lamps' grey.
//  Imported rather than copied, because a second pair of hexes here is a second pair that
//  can drift from the ones on the machines standing at either end of the belt.
// ────────────────────────────────────────────────────────────────────────────────────
const FLOW_TINT_IDLE = LAMP_TINT[LampState.Off]!;
const FLOW_TINT_BUSY = LAMP_TINT[LampState.Running]!;

export class BeltStructureLayer {
  private readonly tierTextures = new Map<number, Texture>();
  private readonly sprites = new Map<number, TilingSprite>();
  private readonly owned: RenderTexture[] = [];

  /**
   * How far each belt's flow tint has scrolled, in source px, kept modulo one tile.
   *
   * Flow scroll has to be INTEGRATED rather than computed from the clock, because its rate
   * changes with the belt's load — a belt that empties would otherwise jump backwards to
   * wherever a slower constant rate says it should have been. One number per belt, dropped
   * with the sprite when the belt is removed.
   */
  private readonly flowPhase = new Map<number, number>();

  /** `view.tick + alpha` at the previous frame; -1 before the first. See `simDelta`. */
  private lastSimTime = -1;

  constructor(
    private readonly renderer: Renderer,
    private readonly art: ArtSet,
    private readonly attach: (sprite: TilingSprite) => void,
  ) {
    for (const spec of BELT_SPECS) {
      this.tierTextures.set(spec.tier, this.bakeTier(spec.tier));
    }
  }

  /**
   * Place, size and scroll every belt segment.
   *
   * The scroll phase is derived from the SIM CLOCK — `tick + alpha` — not from wall time,
   * so the surface moves at exactly the speed the items on it move, and a paused sim shows
   * a stopped belt rather than a belt running with nothing on it.
   *
   * ────────────────────────────────────────────────────────────────────────────────────
   *  `flow` IS THE ZOOMED-OUT INSTRUMENT, NOT A DEGRADED PICTURE. (Plan §13, [[026]].)
   *
   *  With it false — 3× and up — every belt scrolls at its own tier speed, untinted, and
   *  the goods riding it are drawn individually by `belt-items.ts`. That is the normal game.
   *
   *  With it true — 2×, where an item is four source pixels apart from the next one and
   *  therefore a smear rather than a bag — the items stop being drawn entirely and the
   *  SURFACE carries the information instead: it scrolls at THROUGHPUT (the belt's speed
   *  scaled by how loaded it is) and greens up as it fills. A stalled line is then a grey
   *  belt standing still, visible across the whole factory without reading a single number,
   *  which is the thing the far view exists to show and the thing a smear of items hides.
   *
   *  Note what this does NOT do: it adds no sprite, no container and no pass. The tint and
   *  the phase are two numbers written to a `TilingSprite` that was already being drawn, so
   *  the far view can only ever cost less than the near one. §13 is explicit that a LOD
   *  costing more than the thing it replaces is not a LOD.
   * ────────────────────────────────────────────────────────────────────────────────────
   */
  update(view: WorldView, alpha: number, rect: WorldRect, flow: boolean): void {
    const seen = new Set<number>();
    const simDelta = this.simDelta(view.tick + alpha);

    for (let i = 0; i < view.belts.length; i++) {
      const belt = view.belts[i]!;
      seen.add(belt.id);

      let sprite = this.sprites.get(belt.id);
      if (sprite === undefined) {
        sprite = new TilingSprite({ texture: this.textureFor(belt.tier) });
        this.sprites.set(belt.id, sprite);
        this.attach(sprite);
      }

      sprite.texture = this.textureFor(belt.tier);
      sprite.width = belt.lengthTiles * TILE_PX;
      sprite.height = TILE_PX;
      sprite.rotation = TURN[belt.dir] ?? 0;

      // The anchor stays at the top-left corner and the POSITION absorbs the rotation, so
      // the quad lands on the tiles the sim says the belt covers for all four directions.
      const x = belt.tileX * TILE_PX;
      const y = belt.tileY * TILE_PX;
      if (belt.dir === Direction.East) sprite.position.set(x, y);
      else if (belt.dir === Direction.South) sprite.position.set(x + TILE_PX, y);
      else if (belt.dir === Direction.West) sprite.position.set(x + TILE_PX, y + TILE_PX);
      else sprite.position.set(x, y + TILE_PX);

      if (flow) {
        // Throughput, not velocity: a fast belt carrying four items an hour is not a busy
        // belt. THE SCROLL RATE NOW RIDES THE SIM'S OWN NUMBER — item 026 instruction 4
        // landed `BeltView.throughputSubtilesPer100Ticks`, tier speed scaled by occupancy,
        // computed beside the capacity rule it depends on and pinned at the source: an
        // empty belt reads exactly 0 (so a stalled line STANDS STILL, the property the far
        // view exists for) and a full belt exactly its tier speed. What is left here is
        // unit conversion, subtiles-per-100-ticks into source px/sec — a full basic belt
        // comes out at exactly the 4 px/sec `input/lod.test.ts` pins. The occupancy
        // ESTIMATE (`beltLoadPermille`) survives only for the tint below, where "how alive
        // does it look" is honestly a question about items present, not items moving.
        const pxPerSecond =
          (belt.throughputSubtilesPer100Ticks * TICKS_PER_SECOND * TILE_PX) / (100 * SUBTILE);
        const load = beltLoadPermille(
          belt.itemCount,
          belt.lengthTiles,
          SUBTILE,
          BELT_ITEM_SPACING_SUBTILES,
        );
        const phase =
          (this.flowPhase.get(belt.id) ?? 0) + (pxPerSecond / TICKS_PER_SECOND) * simDelta;
        // Modulo one tile, for the same reason the tick-derived phase below is: the number
        // must stay small forever, and this one is a running sum rather than a fresh product.
        const wrapped = phase % TILE_PX;
        this.flowPhase.set(belt.id, wrapped);
        sprite.tilePosition.x = wrapped;
        sprite.tint = mixTint(FLOW_TINT_IDLE, FLOW_TINT_BUSY, load);
      } else {
        const pxPerTick = (beltSubtilesPerTick(belt.tier) * TILE_PX) / SUBTILE;
        // Modulo one tile so the phase stays small forever. At 20 Hz a raw tick counter
        // reaches float-precision territory in about a fortnight of play; this never does.
        sprite.tilePosition.x = ((view.tick + alpha) * pxPerTick) % TILE_PX;
        // Zooming back in must leave NO trace of the far view. The tint is the one piece of
        // flow state that lives on the sprite rather than in the phase map, so it is the one
        // that would otherwise stick — a permanently green belt at 6×, from a frame at 2×.
        sprite.tint = NO_TINT;
      }

      // Culled from four numbers, not from a bounds traversal (§13: culling is opt-in in
      // v8, and for a grid the cheapest possible cull is arithmetic on the tile rect).
      const stepX = dirStepX(belt.dir);
      const stepY = dirStepY(belt.dir);
      const span = belt.lengthTiles * TILE_PX;
      const boxX = x + (stepX < 0 ? -(belt.lengthTiles - 1) * TILE_PX : 0);
      const boxY = y + (stepY < 0 ? -(belt.lengthTiles - 1) * TILE_PX : 0);
      sprite.visible = overlaps(
        boxX,
        boxY,
        stepX !== 0 ? span : TILE_PX,
        stepY !== 0 ? span : TILE_PX,
        rect,
      );
    }

    for (const [id, sprite] of this.sprites) {
      if (seen.has(id)) continue;
      sprite.destroy();
      this.sprites.delete(id);
      this.flowPhase.delete(id);
    }
  }

  /**
   * Sim time elapsed since the previous frame, in ticks.
   *
   * Measured off `tick + alpha` rather than wall time so the flow scroll obeys the same rule
   * the surface scroll already does: a paused sim shows a stopped belt. Clamped at zero
   * because a load or a rewind moves the tick backwards, and a belt that briefly ran in
   * reverse would read as the sim having done something it did not.
   */
  private simDelta(now: number): number {
    const previous = this.lastSimTime;
    this.lastSimTime = now;
    if (previous < 0) return 0;
    return now > previous ? now - previous : 0;
  }

  destroy(): void {
    for (const sprite of this.sprites.values()) sprite.destroy();
    this.sprites.clear();
    this.flowPhase.clear();
    for (const texture of this.owned) texture.destroy(true);
    this.owned.length = 0;
    this.tierTextures.clear();
  }

  private textureFor(tier: number): Texture {
    const found = this.tierTextures.get(tier);
    if (found !== undefined) return found;
    const made = this.bakeTier(tier);
    this.tierTextures.set(tier, made);
    return made;
  }

  private bakeTier(tier: number): Texture {
    const target = RenderTexture.create({
      width: TILE_PX,
      height: TILE_PX,
      resolution: 1,
      antialias: false,
      scaleMode: 'nearest',
    });
    const source = this.art.get(ART.beltSurface(tier));
    const sprite = new Sprite(source);
    const w = source.width > 0 ? source.width : TILE_PX;
    const h = source.height > 0 ? source.height : TILE_PX;
    sprite.scale.set(TILE_PX / w, TILE_PX / h);
    const scratch = new Container();
    scratch.addChild(sprite);
    this.renderer.render({ container: scratch, target, clear: true });
    scratch.destroy({ children: true });

    // Standalone source, so flipping it to wrapping is safe — see the header.
    target.source.style.addressMode = 'repeat';
    target.source.style.update();
    this.owned.push(target);
    return target;
  }
}

function overlaps(x: number, y: number, w: number, h: number, rect: WorldRect): boolean {
  return x < rect.x + rect.width && x + w > rect.x && y < rect.y + rect.height && y + h > rect.y;
}

/** Blend two packed RGB colours, `permille` of the way from `from` to `to`. Per channel. */
function mixTint(from: number, to: number, permille: number): number {
  const t = Math.max(0, Math.min(1000, permille));
  const r = (((from >> 16) & 0xff) * (1000 - t) + ((to >> 16) & 0xff) * t) / 1000;
  const g = (((from >> 8) & 0xff) * (1000 - t) + ((to >> 8) & 0xff) * t) / 1000;
  const b = ((from & 0xff) * (1000 - t) + (to & 0xff) * t) / 1000;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
}
