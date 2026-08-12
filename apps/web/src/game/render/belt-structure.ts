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
import { BELT_SPECS, Direction, SUBTILE } from '@snack/sim';
import type { WorldView } from '@snack/sim';

import type { WorldRect } from './camera';
import { beltSubtilesPerTick, stepX as dirStepX, stepY as dirStepY } from './directions';
import { ART } from './textures';
import type { ArtSet } from './textures';

/** Quarter turns per compass direction, so the segment's local +x runs downstream. */
const TURN: Record<number, number> = {
  [Direction.East]: 0,
  [Direction.South]: Math.PI / 2,
  [Direction.West]: Math.PI,
  [Direction.North]: -Math.PI / 2,
};

export class BeltStructureLayer {
  private readonly tierTextures = new Map<number, Texture>();
  private readonly sprites = new Map<number, TilingSprite>();
  private readonly owned: RenderTexture[] = [];

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
   */
  update(view: WorldView, alpha: number, rect: WorldRect): void {
    const seen = new Set<number>();

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

      const pxPerTick = (beltSubtilesPerTick(belt.tier) * TILE_PX) / SUBTILE;
      // Modulo one tile so the phase stays small forever. At 20 Hz a raw tick counter
      // reaches float-precision territory in about a fortnight of play; this never does.
      sprite.tilePosition.x = ((view.tick + alpha) * pxPerTick) % TILE_PX;

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
    }
  }

  destroy(): void {
    for (const sprite of this.sprites.values()) sprite.destroy();
    this.sprites.clear();
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
