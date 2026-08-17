// Pipes: a single-line tile layer, auto-tiled by neighbour mask and tinted by liquid.
//
// ────────────────────────────────────────────────────────────────────────────────────
//  THE READABILITY LAW THIS LAYER EXISTS TO ENFORCE (plan §5).
//
//    "Solids ride belts (double-line), liquids ride pipes (single-line), and they meet
//     only inside machines with typed ports — readability first."
//
//  So a pipe is NOT a belt with different art. A belt fills its tile: a bed, two rails,
//  chevrons, goods riding on top. A pipe is a thin line down the middle of its tile with
//  nothing on it, ever. That contrast is the entire reason a mature base reads as two
//  districts — the chip line a belt cathedral, the soda line a pipe organ — and it is
//  worth more than any amount of detail inside either one.
//
//    "pipes auto-tint by liquid and render gray when empty"
//
//  Grey is the instrument. A player who cannot find why their Bottler is starving looks
//  at the yard, sees one grey run among four coloured ones, and walks to the pump. That
//  works only if grey never means anything else — which is why an UNKNOWN liquid also
//  draws grey (see `liquids.ts`) rather than magenta.
// ────────────────────────────────────────────────────────────────────────────────────
//
// WHAT THE PROJECTION HANDS OVER. A `PipeView` is ONE TILE — `{ tileX, tileY, liquid,
// network, flowPermille }` — and there is deliberately no fill level, because §5's model is
// flow and not pressure. `flowPermille` is how much of the network's demand is actually
// being met, so it carries both facts this layer needs:
//
//   * `flowPermille === 0` → nothing is reaching this run. Draw it GREY, whatever liquid
//     the network is nominally assigned. That is the diagnostic.
//   * `0 < flowPermille < 1000` → the network is throttling round-robin (§5's amber). The
//     run pulses, so the amber reaches the PIPES and not only the starved machine.
//
// Throttle is read per frame off `view.networks` rather than per tile, because it is a
// property of the network and it flaps: baking it into the tile cache would rebuild the
// whole layout every tick that a pump was oversubscribed.

// `./pixel` first — this module builds a render texture at load. See the block there.
import { TILE_PX } from './pixel';

import { Container, Rectangle, RenderTexture, Sprite, Texture } from 'pixi.js';
import type { Renderer } from 'pixi.js';
import type { NetworkView, PipeView, WorldView } from '@snack/sim';

import type { WorldRect } from './camera';
import { liquidTint } from './liquids';
import { PIPE_FRAMES, PipeSide, pipeShape } from './pipe-shape';
import type { PipeFrame } from './pipe-shape';
import { ART } from './textures';
import type { ArtSet } from './textures';

/**
 * The pipe covering a tile, straight off the projection.
 *
 * A view scan rather than a query against the layer's own index, for the same reason
 * `beltItemAtTile` is: the status ribbon must give the same answer whoever asks it, and the
 * renderer's tile index is a frame-local cache that a caller outside the render pass has no
 * business depending on.
 */
export function pipeAtTile(view: WorldView, tileX: number, tileY: number): PipeView | null {
  const pipes = view.pipes;
  for (let i = 0; i < pipes.length; i++) {
    const pipe = pipes[i]!;
    if (pipe.tileX === tileX && pipe.tileY === tileY) return pipe;
  }
  return null;
}

/**
 * Network ids that could not deliver what was asked of them last tick.
 *
 * A Set built once per frame rather than a lookup per tile: a base with four networks and
 * four hundred pipe tiles would otherwise run four hundred linear scans a frame for a fact
 * that is identical for every tile on the same network.
 */
function throttledNetworks(networks: readonly NetworkView[]): Set<number> {
  const throttled = new Set<number>();
  for (let i = 0; i < networks.length; i++) {
    const network = networks[i]!;
    if (network.demandMl > 0 && network.flowPermille < 1000) throttled.add(network.id);
  }
  return throttled;
}

/** Transparent gutter between frames, so nearest sampling at a rotated quad cannot bleed. */
const PAGE_PAD = 1;
const PAGE_CELL = TILE_PX + PAGE_PAD * 2;

/** The pool never grows past this. A viewport with this many pipe tiles is a bug. */
const MAX_SPRITES = 8_192;

/** Quarter turn in radians, screen space (y down), so a clockwise turn is positive. */
const QUARTER = Math.PI / 2;

// ────────────────────────────────────────────────────────────────────────────────────
//  THE SHADOW A PIPE CASTS, AND WHY IT IS A SECOND SPRITE ([[120]]).
//
//  Item 120 put plumbing OVERHEAD: a run may now cross a belt, the goods riding it, and a
//  planted tile. Occlusion alone does not say which of two things is nearer — a light grey
//  bar lying across a belt reads just as easily as a gap CUT into the belt, and over pale
//  dirt it reads as paint on the ground. A drop shadow is what turns "drawn after" into
//  "above", and it has to survive `image-rendering: pixelated` at every rung of an integer
//  zoom ladder, so it is measured in ART pixels and never in fractions of one.
//
//  TWO THINGS RULE OUT BAKING IT INTO THE SIX FRAMES, and either one alone would be fatal:
//
//    * THE FRAMES ROTATE. `pipe-shape.ts` draws each frame once facing EAST and turns it in
//      quarter turns, which is the whole reason `PIPE` is a concentric palette rather than a
//      top-lit one. A drop shadow baked into the texture would rotate with it — down-right on
//      a horizontal run, down-LEFT on the vertical one below it. A shadow that changes
//      direction with the plumbing is worse than no shadow, because it reads as lighting and
//      then lies about it.
//    * THE SPRITE IS TINTED. The pipe layer multiplies its frames by the liquid's colour, so
//      a baked shadow would be multiplied too and a syrup line would cast an amber shadow.
//
//  A separate sprite fixes both at once: it carries its own tint, and its offset is applied to
//  its WORLD POSITION rather than to its texture, so the shadow falls the same way on every
//  tile no matter which way that tile's frame is turned. It costs one more sprite per visible
//  pipe tile and exactly one more draw call, because the shade layer shares the pipe page's
//  single texture source.
// ────────────────────────────────────────────────────────────────────────────────────

/**
 * How far the shadow falls, in ART pixels — two, in each axis.
 *
 * AN INTEGER, AND IT MUST STAY ONE: the whole world is drawn at an integer zoom (1/2/3/4) onto
 * a pixel-snapped camera, so an integer art offset lands on an exact 1, 2, 3 or 4 device pixels
 * and never shimmers. A half-pixel offset would sample between texels at every rung and undo
 * the reason `scaleMode` is `nearest` in the first place.
 *
 * TWO RATHER THAN ONE SINCE `TILE_PX` WENT 16 → 32, which is the same ratio this always had
 * rather than a new opinion: the rule was "a shadow no more than a sixth of the arm's
 * thickness", the arm was 6px thick and is now 12, and a 2px shadow on a 12px bar reads as
 * height where a 4px one would read as a second, darker pipe running alongside.
 */
const SHADE_OFFSET_PX = 2;

/** Shadow strength. Dark enough to separate on pale dirt, light enough not to fake an outline. */
const SHADE_ALPHA = 0.38;

/** Pure black, so the shadow darkens whatever is under it rather than tinting it. */
const SHADE_TINT = 0x000000;

/**
 * One texture source for every pipe frame.
 *
 * Same trick as the belt-item page and for the same reason: six separate generated textures
 * would be up to six batch breaks in the middle of the ground layers, and pipes are the one
 * structure that runs across the whole base. Blitted into one page, the entire fluid layout
 * is one draw call no matter how many liquids it carries — tint is a vertex attribute in
 * v8, so colour costs nothing.
 */
interface PipePage {
  texture(frame: PipeFrame): Texture;
  destroy(): void;
}

function buildPipePage(renderer: Renderer, art: ArtSet): PipePage {
  const page = RenderTexture.create({
    width: PIPE_FRAMES.length * PAGE_CELL,
    height: PAGE_CELL,
    resolution: 1,
    antialias: false,
    scaleMode: 'nearest',
  });

  const scratch = new Container();
  for (let i = 0; i < PIPE_FRAMES.length; i++) {
    const source = art.get(ART.pipeFrame(PIPE_FRAMES[i]!));
    const sprite = new Sprite(source);
    const w = source.width > 0 ? source.width : TILE_PX;
    const h = source.height > 0 ? source.height : TILE_PX;
    sprite.scale.set(TILE_PX / w, TILE_PX / h);
    sprite.position.set(i * PAGE_CELL + PAGE_PAD, PAGE_PAD);
    scratch.addChild(sprite);
  }
  renderer.render({ container: scratch, target: page, clear: true });
  scratch.destroy({ children: true });

  const frames = new Map<PipeFrame, Texture>();
  for (let i = 0; i < PIPE_FRAMES.length; i++) {
    frames.set(
      PIPE_FRAMES[i]!,
      new Texture({
        source: page.source,
        frame: new Rectangle(i * PAGE_CELL + PAGE_PAD, PAGE_PAD, TILE_PX, TILE_PX),
      }),
    );
  }
  const fallback = frames.get('stub') ?? Texture.EMPTY;

  return {
    texture(frame: PipeFrame): Texture {
      return frames.get(frame) ?? fallback;
    },
    destroy(): void {
      for (const texture of frames.values()) texture.destroy(false);
      frames.clear();
      page.destroy(true);
    },
  };
}

/** One drawn pipe tile, resolved. Rebuilt only when the layout, a liquid, or dryness changes. */
interface PipeTile {
  tileX: number;
  tileY: number;
  /** Neighbour bitmask, for `pipeShape`. */
  mask: number;
  /** What to tint with: the liquid, or 0 for "nothing is reaching this run". */
  liquid: number;
  /** Owning network, so throttling is looked up per FRAME rather than baked in per rebuild. */
  network: number;
}

export class PipeLayer {
  private readonly page: PipePage;
  private readonly sprites: Sprite[] = [];
  private readonly shades: Sprite[] = [];
  private readonly attach: (sprite: Sprite) => void;
  private readonly attachShade: (sprite: Sprite) => void;

  /** Resolved tiles, in projection order. Rebuilt on change, walked every frame. */
  private tiles: PipeTile[] = [];
  /** tileKey → liquid id. The adjacency index, and what machine collars query. */
  private readonly byTile = new Map<number, number>();
  /** Cheap change detector — see `signatureOf`. */
  private signature = -1;
  private worldTilesWide = 0;

  constructor(
    renderer: Renderer,
    art: ArtSet,
    attach: (sprite: Sprite) => void,
    attachShade: (sprite: Sprite) => void,
  ) {
    this.page = buildPipePage(renderer, art);
    this.attach = attach;
    this.attachShade = attachShade;
  }

  /**
   * Place and tint every visible pipe tile.
   *
   * Two passes with very different costs. The REBUILD walks the pipes and recomputes every
   * neighbour mask — O(pipe tiles), but only when the layout changed or a run went wet or
   * dry. The DRAW walks the resolved tiles and writes sprites: O(pipe tiles) of integer
   * compares, the same arithmetic cull the belts use, because a bounds-traversal culler for
   * a grid is strictly more work than the grid.
   */
  update(view: WorldView, rect: WorldRect, now: number): void {
    const signature = signatureOf(view.pipes);
    if (signature !== this.signature || this.worldTilesWide !== view.worldTilesWide) {
      this.worldTilesWide = view.worldTilesWide;
      this.signature = signature;
      this.rebuild(view.pipes);
    }

    // A throttled network pulses. Cosmetic, renderer-local, and legal here (§12) — a sine on
    // wall time never touches a sim RNG stream and is never read back. It is also the one
    // place §5's amber grammar reaches the PIPES: a player who can see which run is short
    // does not have to guess which machine to click.
    const throttled = throttledNetworks(view.networks);
    const pulse = 0.68 + 0.32 * Math.abs(Math.sin(now / 420));

    let used = 0;
    for (let i = 0; i < this.tiles.length; i++) {
      const tile = this.tiles[i]!;
      const x = tile.tileX * TILE_PX;
      const y = tile.tileY * TILE_PX;
      if (x + TILE_PX <= rect.x || x >= rect.x + rect.width) continue;
      if (y + TILE_PX <= rect.y || y >= rect.y + rect.height) continue;
      if (used >= MAX_SPRITES) break;

      const sprite = this.spriteAt(used);
      const shade = this.shadeAt(used);
      used += 1;

      const shape = pipeShape(tile.mask);
      const texture = this.page.texture(shape.frame);
      const rotation = shape.quarterTurns * QUARTER;
      const alpha = throttled.has(tile.network) ? pulse : 1;

      sprite.texture = texture;
      // Anchored at the centre so a quarter turn pivots in place; the position carries the
      // half-tile offset rather than the anchor carrying the rotation.
      sprite.position.set(x + TILE_PX / 2, y + TILE_PX / 2);
      sprite.rotation = rotation;
      sprite.tint = liquidTint(tile.liquid);
      sprite.alpha = alpha;
      sprite.visible = true;

      // Same frame, same turn, offset in WORLD space — see the block above `SHADE_OFFSET_PX`.
      // Offsetting the position rather than the texture is what keeps the shadow falling
      // down-right on a vertical run as well as a horizontal one.
      shade.texture = texture;
      shade.position.set(x + TILE_PX / 2 + SHADE_OFFSET_PX, y + TILE_PX / 2 + SHADE_OFFSET_PX);
      shade.rotation = rotation;
      // The shadow fades WITH the run it belongs to. A throttled network pulses (§5's amber),
      // and a shadow that held still while its pipe faded would be a shadow with nothing above
      // it — the one thing a drop shadow may never look like.
      shade.alpha = SHADE_ALPHA * alpha;
      shade.visible = true;
    }

    // The tail is contiguous: every frame fills from slot zero upward, so the first hidden
    // slot is the start of everything hidden. Both pools are filled in lockstep from the same
    // `used` counter, so one loop bound is honest for both.
    for (let i = used; i < this.sprites.length; i++) {
      const sprite = this.sprites[i]!;
      if (!sprite.visible) break;
      sprite.visible = false;
      this.shades[i]!.visible = false;
    }
  }

  /** The liquid in the pipe on this tile, or 0 for "no pipe here, or nothing reaching it". */
  liquidAt(tileX: number, tileY: number): number {
    const found = this.byTile.get(this.key(tileX, tileY));
    return found === undefined ? 0 : found;
  }

  /** True when a pipe covers this tile, whatever it is carrying. */
  hasPipe(tileX: number, tileY: number): boolean {
    return this.byTile.has(this.key(tileX, tileY));
  }

  /** How many pipe tiles exist. */
  get tileCount(): number {
    return this.tiles.length;
  }

  destroy(): void {
    for (const sprite of this.sprites) sprite.destroy();
    for (const shade of this.shades) shade.destroy();
    this.sprites.length = 0;
    this.shades.length = 0;
    this.tiles.length = 0;
    this.byTile.clear();
    this.page.destroy();
  }

  private key(tileX: number, tileY: number): number {
    return tileY * this.worldTilesWide + tileX;
  }

  private spriteAt(index: number): Sprite {
    const existing = this.sprites[index];
    if (existing !== undefined) return existing;
    const sprite = new Sprite(this.page.texture('straight'));
    sprite.anchor.set(0.5, 0.5);
    this.sprites.push(sprite);
    this.attach(sprite);
    return sprite;
  }

  /**
   * The shade twin of `spriteAt`, at the same index.
   *
   * Its tint is written ONCE, here, rather than every frame beside the pipe's: the pipe's tint
   * changes when a network changes liquid, and the shadow's never does. Only `alpha` moves per
   * frame, and only because the run it belongs to pulses.
   */
  private shadeAt(index: number): Sprite {
    const existing = this.shades[index];
    if (existing !== undefined) return existing;
    const shade = new Sprite(this.page.texture('straight'));
    shade.anchor.set(0.5, 0.5);
    shade.tint = SHADE_TINT;
    this.shades.push(shade);
    this.attachShade(shade);
    return shade;
  }

  /**
   * Index the pipes, then compute each tile's neighbour mask.
   *
   * Two passes, because a tile's shape depends on tiles it has not seen yet — the first pass
   * fills the index, the second reads it. Doing it in one pass with back-patching is the
   * version of this function that has a bug in it.
   */
  private rebuild(pipes: readonly PipeView[]): void {
    this.tiles = [];
    this.byTile.clear();

    for (let i = 0; i < pipes.length; i++) {
      const pipe = pipes[i]!;
      // Nothing reaching it is GREY, and grey is a state, not a missing colour. The liquid
      // id is dropped here rather than at draw time so that a machine collar querying this
      // index gets the same answer the pipe is showing.
      const liquid = pipe.flowPermille > 0 ? pipe.liquid : 0;
      this.byTile.set(this.key(pipe.tileX, pipe.tileY), liquid);
      this.tiles.push({
        tileX: pipe.tileX,
        tileY: pipe.tileY,
        mask: 0,
        liquid,
        network: pipe.network,
      });
    }

    for (let i = 0; i < this.tiles.length; i++) {
      const tile = this.tiles[i]!;
      let mask = 0;
      if (this.byTile.has(this.key(tile.tileX, tile.tileY - 1))) mask |= PipeSide.North;
      if (this.byTile.has(this.key(tile.tileX + 1, tile.tileY))) mask |= PipeSide.East;
      if (this.byTile.has(this.key(tile.tileX, tile.tileY + 1))) mask |= PipeSide.South;
      if (this.byTile.has(this.key(tile.tileX - 1, tile.tileY))) mask |= PipeSide.West;
      tile.mask = mask;
    }
  }
}

/**
 * A cheap fingerprint of the pipe layout and of what is in it.
 *
 * Deliberately coarse on flow: it folds in whether a run is wet or dry, never by how much.
 * A throttled network's `flowPermille` moves every tick, and a signature that noticed would
 * rebuild the entire layout twenty times a second to draw the same picture. Integer
 * arithmetic only, and it never leaves the renderer — a change detector, not a hash anybody
 * trusts for correctness.
 */
function signatureOf(pipes: readonly PipeView[]): number {
  let h = pipes.length | 0;
  for (let i = 0; i < pipes.length; i++) {
    const pipe = pipes[i]!;
    h = (Math.imul(h, 31) + pipe.tileX * 97 + pipe.tileY) | 0;
    h = (Math.imul(h, 31) + pipe.liquid * 13 + pipe.network) | 0;
    h = (Math.imul(h, 31) + (pipe.flowPermille > 0 ? 1 : 0)) | 0;
  }
  return h;
}
