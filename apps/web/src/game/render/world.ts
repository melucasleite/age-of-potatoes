// The scene: layers under a world root, the terrain bake, the sprite pools, and one
// day/night colour matrix.
//
// `./pixel` first — see the comment block there.
import { dayPhase, TILE_PX } from './pixel';

import { ColorMatrixFilter, Container, Rectangle, RenderTexture, Sprite, Texture } from 'pixi.js';
import type { Application, Renderer } from 'pixi.js';

import {
  FIELD_ORIGIN_Y,
  FIELD_TILES_HIGH,
  FIELD_TILES_WIDE,
  WORLD_TILES_HIGH,
  WORLD_TILES_WIDE,
  worldTileKey,
} from '@snack/sim';

import { beltItemAtTile, BeltItemLayer, buildItemPage } from './belt-items';
import type { ItemPage } from './belt-items';
import { ArtSheet, artSheetRequested } from './artsheet';
import { BeltStructureLayer } from './belt-structure';
import { BotLayer } from './bots';
import { TruckLayer } from './trucks';
import type { Camera } from './camera';
import { Ceremony } from './ceremony';
import { FarmFx } from './farm-fx';
import { FieldTiles } from './field-tiles';
import { installUiFont } from './font';
import { GrabberLayer } from './grabbers';
import { MachineMotion } from './machine-motion';
import { Hud } from './hud';
import { LandOverlay } from './land';
import { createLayers, destroyLayers, LAYER_ORDER } from './layers';
import type { Layers } from './layers';
import { DevOverlay } from './overlay';
import { PipeLayer } from './pipes';
import { SHORE_FRAME, SHORE_VARIANTS } from './shore';
import { TerrainBaker } from './terrain';
import type { TerrainSource } from './terrain';
import { ART } from './textures';
import type { ArtSet } from './textures';
import { ZoneOverlay } from './zones';

export const WORLD_WIDTH_PX = WORLD_TILES_WIDE * TILE_PX;
export const WORLD_HEIGHT_PX = WORLD_TILES_HIGH * TILE_PX;
const FIELD_TILE_COUNT = FIELD_TILES_WIDE * FIELD_TILES_HIGH;
const DROPLET_POOL = 64;

/**
 * Everything drawn for one machine.
 *
 * Seven small sprites rather than one big one, because the alternative is an art frame per
 * combination of state — and the chip line has five machines × seven lamp states × four
 * upgrade levels. Composited in code it is one grey box plus decals, and §15's Grade C for
 * machine work-loop animation stops mattering.
 */
export interface MachineVisual {
  body: Sprite;
  lamp: Sprite;
  wrench: Sprite;
  /** Work progress, as a bar along the machine's base. */
  progress: Sprite;
  /** Input buffer fill, as a column up the machine's left edge. */
  hopper: Sprite;
  /** What is waiting in the output buffer, so a blocked machine says WHAT is blocked. */
  outputPip: Sprite;
  /**
   * The upgrade decals: at most one per dial, grown on demand and hidden when a dial is at 0.
   *
   * Composited exactly as the status lamp is (§13's "one sprite tinted in code" argument,
   * applied to paint instead of colour): nine 32×32 frames cover three dials × three levels
   * on every machine in the game, because each one is a full overlay in the MACHINE'S OWN
   * coordinate space and stretches onto its footprint the same way the body does. There is
   * no offset table and no per-machine anchor, and there must never be one — the moment a
   * decal needs to know which machine it is on, this has become §15's per-machine sprite
   * variants wearing a different hat.
   *
   * An array rather than three fields because most machines have no upgrades: a fresh
   * factory allocates nothing here, and a maxed Fryer allocates three.
   */
  decals: Sprite[];
  /**
   * Pipe collars, one per typed fluid port, grown on demand and never past `MAX_PORTS`.
   *
   * Only machines with a pipe port have any (`MachineSpec.liquid`), which is why they are a
   * lazily-grown array rather than a fixed field: the chip line's five machines allocate
   * nothing at all, and the Syrup Mixer — §5's "one machine where the two layers visibly
   * cooperate" — is the one that grows the most.
   */
  ports: Sprite[];
  /** The level inside a tank, drawn over the sprite's window from `tankPermille`. */
  tankFill: Sprite;
}

export interface Droplet {
  sprite: Sprite;
  life: number;
  vx: number;
  vy: number;
}

export interface WorldScene {
  readonly app: Application;
  readonly art: ArtSet;
  readonly camera: Camera;
  readonly worldRoot: Container;
  readonly contentRoot: Container;
  readonly screenRoot: Container;
  readonly layers: Layers;
  readonly terrain: TerrainBaker;
  readonly dayNight: ColorMatrixFilter;

  /**
   * The farmland's sprite pools, one set per farm tile in the COLLECTION'S order ([[066]]).
   * `fieldTiles.sync` runs first thing every frame; the parallel arrays inside are valid
   * for exactly as long as the projection's own are — until the next till.
   */
  readonly fieldTiles: FieldTiles;
  /**
   * Every farm tile's world key, maintained by `fieldTiles.sync`, read by the ground bake.
   * Renderer-local and write-once-per-till; never a reference into the projection.
   */
  readonly farmland: Set<number>;
  /**
   * Every water tile's world key — the ponds. [[027]] built the reservoirs and the view has
   * carried their rectangles ever since, but no renderer ever consumed them: the pond was
   * invisible for as long as the infinite can made nobody go looking for it. The 8-pour can
   * ([[009]]) ended that, and the can chip now points at a shore the player deserves to see.
   * Synced from `view.reservoirs` in `render()`; reservoirs never move or resize, so the
   * sync fires when one appears (world load, in practice) and marks its tiles dirty.
   */
  readonly water: Set<number>;
  /**
   * The pond's banks ([[077]]): water tile key → index into the baked shore textures.
   * Rebuilt beside the water set at the reservoir sync — the classification is a static
   * fact about a world whose reservoirs never move, so it costs one pass per load. Tiles
   * absent from this map are pond centre and stay `terrain_water`.
   */
  readonly shore: Map<number, number>;
  /**
   * The twelve shore tiles, pre-turned: `SHORE_VARIANTS` order — three frames × four
   * quarter-turns, baked once at scene build. Baked rather than rotated at bake-pass time
   * so `TerrainBaker` keeps its one-sprite-per-tile contract with no rotation plumbing.
   */
  readonly shoreTextures: readonly RenderTexture[];
  /** How many reservoirs the water set was last built from. -1 forces the first sync. */
  reservoirStamp: number;
  readonly machines: Map<number, MachineVisual>;
  /**
   * Work-loop motion ([[091]]): the per-machine working detector, the kind→motion table's
   * runtime, and the shared speck pool. Renderer-local, write-only memory on the pour-signal
   * precedent — nothing in it is ever read back into the sim or hashed.
   */
  readonly machineMotion: MachineMotion;
  readonly player: Sprite;
  /**
   * The armed tool in the avatar's hands ([[065]]) — twice, and only ever one visible.
   * `heldToolFront` is attached AFTER the player and draws over him for south/east/west;
   * `heldToolBack` is attached BEFORE and draws behind him for the walking-up pose. Two
   * sprites instead of re-attaching one, because reordering a RenderLayer mid-frame to
   * move one icon would also reshuffle the player against every bot on the layer.
   */
  readonly heldToolBack: Sprite;
  readonly heldToolFront: Sprite;
  readonly hover: Sprite;
  /** Where a pending walk-to errand is headed. Hidden whenever there is no errand. */
  readonly destination: Sprite;
  readonly droplets: Droplet[];
  /** The drink-bounce and the harvest pop-and-magnet. Derived from the projection. */
  readonly farmFx: FarmFx;
  /** Plan §3's Hall of Hands: ~10 seconds of theatre, once per world, ever. */
  readonly ceremony: Ceremony;
  readonly hud: Hud;
  readonly overlay: DevOverlay;
  /** The `?artsheet` screen, or null when the URL did not ask for it. */
  readonly artSheet: ArtSheet | null;

  // --- the factory ------------------------------------------------------------------
  /** One texture source for every belt-rideable good. See `belt-items.ts`. */
  readonly itemPage: ItemPage;
  readonly beltStructures: BeltStructureLayer;
  readonly beltItems: BeltItemLayer;
  readonly grabbers: GrabberLayer;
  /** The Agri-Bots. Empty on a lot that has never bought a dock — it costs one empty Map. */
  readonly bots: BotLayer;
  /** The delivery trucks ([[132]]). Empty until a route is signed — one empty Map. */
  readonly trucks: TruckLayer;
  readonly zoneOverlay: ZoneOverlay;
  /** Unowned parcels: the wash and the fence line, baked with the ground (§5's land deeds). */
  readonly landOverlay: LandOverlay;
  /** The fluid layer: single-line, auto-tiled, tinted by liquid, grey when empty (§5). */
  readonly pipes: PipeLayer;

  // --- renderer-local, WRITE-ONLY state (plan §12) --------------------------------
  // Interpolated positions live here, are never read back into the sim, never
  // persisted, and never hashed. A line that feeds any of these into a command is a bug
  // regardless of how convenient it looks.
  /** Player subtile position at the previous tick and at the current one. */
  prevXSub: number;
  prevYSub: number;
  currXSub: number;
  currYSub: number;
  /** True until the first projection has been folded in. */
  primed: boolean;
  /** Whether the day/night filter is currently attached. */
  filterOn: boolean;
}

/**
 * The ground at a world tile — LIVE, no longer a static layout ([[066]]).
 *
 * Farmland is wherever the player's till says it is, read off the `farmland` key set that
 * `fieldTiles.sync` maintains from the projection each frame; the tiles whose answer here
 * changed are marked dirty by the same sync, which is what makes a till rebake to dirt and
 * an un-till rebake to grass with no one polling. The yard strip and the grass speckle are
 * still fixed decoration, still deterministic per position, so a re-bake is pixel-identical
 * to the bake it replaced everywhere the dirt did not move.
 */
function groundNameAt(
  farmland: ReadonlySet<number>,
  water: ReadonlySet<number>,
  tileX: number,
  tileY: number,
): string {
  const tileKey = worldTileKey(tileX, tileY);
  // Water outranks everything: a pond tile is a pond tile even if a stale farmland key ever
  // pointed at it — the sim refuses to till open water, so a disagreement here means a bug
  // upstream, and drawing the water is the honest way to make that bug visible.
  if (water.has(tileKey)) return ART.groundWater;
  if (farmland.has(tileKey)) return ART.groundField;

  // The yard: a dirt strip south of the STARTING field where the stand sits. Cosmetic and
  // frozen — the constants name where the v0.1 lot put its furniture, not where farmland is.
  const yardTop = FIELD_ORIGIN_Y + FIELD_TILES_HIGH;
  if (tileY >= yardTop && tileY <= yardTop + 1) return ART.groundLot;
  if (tileX >= 1 && tileX <= 3 && tileY >= yardTop - 2) return ART.groundLot;

  const variant = (tileX * 73856093) ^ (tileY * 19349663);
  const pick = Math.abs(variant) % 3;
  return pick === 0 ? ART.groundGrassA : pick === 1 ? ART.groundGrassB : ART.groundGrassC;
}

/**
 * Build the scene.
 *
 * The camera is passed IN rather than created here: the input listeners hold one, and
 * picking must invert the exact transform the renderer applied. Two camera instances that
 * agree most of the time is the version of this bug that takes a day to find.
 */
export function createWorldScene(app: Application, art: ArtSet, camera: Camera): WorldScene {
  const worldRoot = new Container();
  const contentRoot = new Container();
  const screenRoot = new Container();
  app.stage.addChild(worldRoot, screenRoot);

  // `contentRoot` goes in FIRST, below every layer. Everything below is attached to a
  // `RenderLayer`, so `contentRoot` draws nothing itself — but if an object is ever
  // forgotten, it appears at the bottom rather than vanishing, which is a much kinder
  // failure than an invisible sprite.
  worldRoot.addChild(contentRoot);

  const layers = createLayers();
  for (const name of LAYER_ORDER) {
    worldRoot.addChild(layers[name]);
  }

  // Day/night: ONE colour matrix on the world root (§13). Never per-object tinting —
  // tinting every sprite for time of day breaks every batch in the scene.
  const dayNight = new ColorMatrixFilter();
  // An explicit filter area, in the root's local space. Deriving it from bounds would
  // make the filter's cost — and its correctness — depend on a subtree traversal that
  // `RenderLayer` attachment complicates for no benefit.
  worldRoot.filterArea = new Rectangle(
    -TILE_PX,
    -TILE_PX,
    WORLD_WIDTH_PX + TILE_PX * 2,
    WORLD_HEIGHT_PX + TILE_PX * 2,
  );

  // The zone-paint pass, filled in at last: the seam existed for [[018]], and [[018]] is
  // now content rather than surgery, exactly as intended.
  const zoneOverlay = new ZoneOverlay(art);
  const landOverlay = new LandOverlay(art);

  // Owned by the scene, written by `fieldTiles.sync`, read by the ground bake below. Empty
  // until the first projection arrives — and the first bake only runs inside `render()`,
  // after the first sync, so the opening frame already knows where the dirt is.
  const farmland = new Set<number>();
  const water = new Set<number>();

  // The pond's banks ([[077]]). ONE map instance for the scene's whole life, closed over
  // here and refilled in place by the reservoir sync (`render/index.ts`) — replaced
  // wholesale it would strand this closure on the empty original.
  const shore = new Map<number, number>();
  const shoreTextures = bakeShoreTextures(app.renderer, art);

  const source: TerrainSource = {
    ground: (tileX, tileY) => {
      const tileKey = worldTileKey(tileX, tileY);
      if (water.has(tileKey)) {
        const variant = shore.get(tileKey);
        const baked = variant === undefined ? undefined : shoreTextures[variant];
        return baked ?? art.get(ART.groundWater);
      }
      return art.get(groundNameAt(farmland, water, tileX, tileY));
    },
    // LAND OUTRANKS ZONES, and the two can never actually meet: zone paint exists only on
    // field tiles and the field is inside the starting parcel, which every world owns. The
    // order is written down anyway, because "these two cannot collide" is exactly the kind of
    // claim that stops being true the day somebody moves the field.
    overlay: (tileX, tileY) => landOverlay.paints(tileX, tileY) ?? zoneOverlay.paints(tileX, tileY),
  };

  const terrain = new TerrainBaker(app.renderer, source, WORLD_TILES_WIDE, WORLD_TILES_HIGH);
  for (const sprite of terrain.groundSprites()) {
    contentRoot.addChild(sprite);
    layers.groundBake.attach(sprite);
  }
  for (const sprite of terrain.overlaySprites()) {
    contentRoot.addChild(sprite);
    layers.zonePaint.attach(sprite);
  }

  // The farmland pools, dressed to the projection's collection by `fieldTiles.sync` on the
  // first frame and re-dressed on every till. The long-standing anchor and layer decisions
  // (wet soil as an alpha ramp, base-anchored crops, ready marks on the world-UI layer)
  // moved into `field-tiles.ts` with the loop that applies them.
  const fieldTiles = new FieldTiles(art, {
    ground: (sprite) => {
      contentRoot.addChild(sprite);
      layers.groundEntities.attach(sprite);
    },
    crop: (sprite) => {
      contentRoot.addChild(sprite);
      layers.groundEntities.attach(sprite);
    },
    ui: (sprite) => {
      contentRoot.addChild(sprite);
      layers.worldUi.attach(sprite);
    },
  });

  // The held tool's BEHIND sprite goes on the player layer first, so the avatar draws over
  // it while walking up; the FRONT one right after the player. See `WorldScene`'s note.
  const heldToolBack = new Sprite(Texture.EMPTY);
  heldToolBack.anchor.set(0.5, 0.5);
  heldToolBack.visible = false;
  contentRoot.addChild(heldToolBack);
  layers.player.attach(heldToolBack);

  const player = new Sprite(art.get(ART.playerWalk('south', 1)));
  player.anchor.set(0.5, 1);
  contentRoot.addChild(player);
  layers.player.attach(player);

  const heldToolFront = new Sprite(Texture.EMPTY);
  heldToolFront.anchor.set(0.5, 0.5);
  heldToolFront.visible = false;
  contentRoot.addChild(heldToolFront);
  layers.player.attach(heldToolFront);

  const hover = new Sprite(art.get(ART.uiHover));
  hover.visible = false;
  contentRoot.addChild(hover);
  layers.worldUi.attach(hover);

  // Anchored at the top-left like `hover`, NOT centred like `readyMarks` — it is positioned
  // by the same `tileX * TILE_PX` arithmetic and a centred anchor would put it half a tile
  // up and to the left of the tile it names.
  const destination = new Sprite(art.get(ART.uiTarget));
  destination.visible = false;
  contentRoot.addChild(destination);
  layers.worldUi.attach(destination);

  const dropletTexture = art.get(ART.uiDroplet);
  const droplets: Droplet[] = [];
  for (let i = 0; i < DROPLET_POOL; i++) {
    const sprite = new Sprite(dropletTexture);
    sprite.visible = false;
    sprite.anchor.set(0.5, 0.5);
    contentRoot.addChild(sprite);
    layers.worldUi.attach(sprite);
    droplets.push({ sprite, life: 0, vx: 0, vy: 0 });
  }

  // The machine work-loop specks ([[091]]): one bounded pool for every boiling, fizzing,
  // sizzling machine, on `worldUi` with the droplets — a bubble passes in front of its vat.
  const machineMotion = new MachineMotion(
    art.get(ART.uiPixel),
    (sprite) => {
      contentRoot.addChild(sprite);
      layers.worldUi.attach(sprite);
    },
    // The junction's shunt probe, injected so `machine-motion.ts` stays loadable by a
    // test that has no art manifest — the `ceremony.ts` seam, again.
    (view, tileX, tileY) => beltItemAtTile(view, tileX, tileY) !== null,
  );

  // --- the factory ------------------------------------------------------------------
  //
  // Built here rather than lazily on the first belt, because the item page is a render
  // pass and the belt tier textures are three more: doing that mid-frame the first time a
  // player places a belt is a visible hitch at exactly the moment they are paying attention.

  const itemPage = buildItemPage(app.renderer, art);

  // The harvest magnet flies an ITEM, so it needs the item page — which is why this is built
  // here with the factory rather than up with the crop sprites it decorates.
  const farmFx = new FarmFx(itemPage, FIELD_TILE_COUNT, (sprite) => {
    contentRoot.addChild(sprite);
    // Above the player: a potato being sucked into somebody's pocket passes in front of
    // them, and one that vanishes behind the farmer reads as having been dropped.
    layers.worldUi.attach(sprite);
  });

  const pipes = new PipeLayer(
    app.renderer,
    art,
    (sprite) => {
      contentRoot.addChild(sprite);
      layers.pipes.attach(sprite);
    },
    (sprite) => {
      contentRoot.addChild(sprite);
      layers.pipeShade.attach(sprite);
    },
  );

  const beltStructures = new BeltStructureLayer(
    app.renderer,
    art,
    (sprite) => {
      contentRoot.addChild(sprite);
      layers.beltStructures.attach(sprite);
    },
    // Bends and tees ([[095]]) go on their own slot, above every run and below every good —
    // an elbow must cover the straight track it replaces, and the potato riding through it
    // must pass over the top of it, not under.
    (sprite) => {
      contentRoot.addChild(sprite);
      layers.beltShapes.attach(sprite);
    },
  );

  const beltItems = new BeltItemLayer(itemPage, WORLD_WIDTH_PX, WORLD_HEIGHT_PX);
  contentRoot.addChild(beltItems.container);
  layers.beltItems.attach(beltItems.container);

  const grabbers = new GrabberLayer(art, itemPage, (visual) => {
    // Added in the order they stack: the housing sits under the linkage, the linkage under
    // the claw, and the cargo on top of the jaws that are holding it ([[094]]).
    contentRoot.addChild(
      visual.mount,
      visual.upper,
      visual.fore,
      visual.clawUpper,
      visual.clawLower,
      visual.cargo,
      visual.lamp,
    );
    layers.machines.attach(visual.mount);
    layers.player.attach(visual.upper);
    layers.player.attach(visual.fore);
    layers.player.attach(visual.clawUpper);
    layers.player.attach(visual.clawLower);
    layers.player.attach(visual.cargo);
    // The lamp goes on `worldUi` with every other status light, ABOVE the arm's own hand.
    // A readout the machine can swing in front of is a readout you have to wait for.
    layers.worldUi.attach(visual.lamp);
  });

  // The bot rides the `player` layer, which the z-order table already reserved for "the player
  // and, later, other pawns" — this is later. Its cargo and its wrench go on `worldUi` with
  // every other readout in the game, so a chip being carried passes IN FRONT of the farmer
  // rather than disappearing behind him, exactly as the harvest magnet does.
  const bots = new BotLayer(art, itemPage, (visual) => {
    contentRoot.addChild(visual.body, visual.cargo, visual.wrench, visual.tool);
    layers.player.attach(visual.body);
    layers.worldUi.attach(visual.cargo);
    layers.worldUi.attach(visual.wrench);
    layers.worldUi.attach(visual.tool);
  });

  // The truck rides `player` beside the bots ([[132]]) — the slot the z-order table reserves
  // for "the player and, later, other pawns", which is where a thing that drives across the
  // lot belongs: over the ground and the belts it crosses, under the status lights. Its load
  // goes on `worldUi` with the bots' cargo and every other readout, so a crate being carried
  // passes IN FRONT of whatever the truck is driving past rather than behind it.
  const trucks = new TruckLayer(art, itemPage, (visual) => {
    contentRoot.addChild(visual.body, visual.cargo);
    layers.player.attach(visual.body);
    layers.worldUi.attach(visual.cargo);
  });

  // BEFORE anything that draws text. `BitmapText` resolves its font lazily, so a plaque built
  // first would still come out right — but it would come out right by accident, and the one
  // that does not is the ceremony firing in the same frame the scene is built.
  installUiFont(art);

  // The frame rather than the whole art set: `ceremony.ts` stays free of `textures.ts` so it
  // can be loaded by a test. See the note at the top of that file.
  const ceremony = new Ceremony(art.get(ART.uiHover), (sprite) => {
    contentRoot.addChild(sprite);
    layers.worldUi.attach(sprite);
  });

  const hud = new Hud();
  const overlay = new DevOverlay();
  // The ceremony's screen chrome goes in FIRST, so the HUD and the dev overlay draw over
  // it. Ten seconds of theatre that hides the money counter is ten seconds of theatre that
  // has started blocking the game, and the whole constraint on this feature is that it does
  // not — the sim keeps running and the player keeps playing straight through it.
  screenRoot.addChild(ceremony.screenRoot, hud.root, overlay.root);

  // `?artsheet` — the whole sprite set on one screen. Off by default, built only when asked
  // for, and it reads nothing but the art set. See `artsheet.ts` for why it earns its place.
  const artSheet = artSheetRequested() ? new ArtSheet(art) : null;
  if (artSheet !== null) screenRoot.addChild(artSheet.root);

  return {
    app,
    art,
    camera,
    worldRoot,
    contentRoot,
    screenRoot,
    layers,
    terrain,
    dayNight,
    fieldTiles,
    farmland,
    water,
    shore,
    shoreTextures,
    reservoirStamp: -1,
    machines: new Map(),
    machineMotion,
    player,
    heldToolBack,
    heldToolFront,
    hover,
    destination,
    droplets,
    farmFx,
    ceremony,
    hud,
    overlay,
    artSheet,
    itemPage,
    beltStructures,
    beltItems,
    grabbers,
    bots,
    trucks,
    zoneOverlay,
    landOverlay,
    pipes,
    prevXSub: 0,
    prevYSub: 0,
    currXSub: 0,
    currYSub: 0,
    primed: false,
    filterOn: false,
  };
}

/**
 * Bake the twelve shore tiles ([[077]]): `SHORE_VARIANTS` order, each frame drawn at its
 * quarter turn about the tile centre into its own 16×16 render texture.
 *
 * Baked ONCE at scene build rather than rotated per bake pass, for the belt layer's reason
 * inverted: `TerrainBaker`'s contract is one axis-aligned sprite per tile, and threading a
 * rotation through it for three frames would put rotation plumbing on every ground tile in
 * the game. Twelve 16×16 textures is the whole cost, and the chunk baker never learns
 * shores exist. The frames come through `art.get`, so a no-atlas build bakes the
 * procedural shore paints (`PLACEHOLDERS`) exactly as it bakes procedural water.
 */
function bakeShoreTextures(renderer: Renderer, art: ArtSet): RenderTexture[] {
  return SHORE_VARIANTS.map((variant) => {
    const target = RenderTexture.create({
      width: TILE_PX,
      height: TILE_PX,
      resolution: 1,
      antialias: false,
      scaleMode: 'nearest',
    });
    const sprite = new Sprite(art.get(SHORE_FRAME[variant.frame]));
    // Pinned to the tile footprint BEFORE the turn, so a frame the pipeline ships at an
    // unexpected size still lands on its tile — the machine-body rule, applied to ground.
    sprite.setSize(TILE_PX, TILE_PX);
    sprite.anchor.set(0.5, 0.5);
    sprite.position.set(TILE_PX / 2, TILE_PX / 2);
    sprite.rotation = (variant.quarterTurns * Math.PI) / 2;
    const scratch = new Container();
    scratch.addChild(sprite);
    renderer.render({ container: scratch, target, clear: true });
    scratch.destroy({ children: true });
    return target;
  });
}

/**
 * The day/night curve. Cosmetic only — plan §2 and §7.8 rule out night mechanics, so this
 * reads a tick-derived value and nothing else, and nothing reads it back.
 *
 * `Math.cos` is fine HERE. It is banned in `packages/sim` because transcendentals are
 * implementation-defined in the last bits and would desync replays; a renderer that tints
 * the screen a hair differently on two machines is not a correctness problem.
 */
export function dayNightMultipliers(tick: number): { r: number; g: number; b: number } {
  // Peak brightness at midday, trough at midnight. The gain overshoots so that the middle
  // of the day CLAMPS to 1.0 — a genuine plateau of untouched daylight, which is both the
  // right look and the window in which the filter is detached entirely.
  const light = 0.5 - 0.5 * Math.cos(dayPhase(tick) * Math.PI * 2);
  const level = Math.min(1, 0.6 + 0.62 * light);
  return { r: level, g: level * 0.985, b: Math.min(1, level * 1.06) };
}

export function applyDayNight(scene: WorldScene, tick: number): void {
  const { r, g, b } = dayNightMultipliers(tick);

  // Straight per-channel scale. Written out as a literal matrix rather than through the
  // preset helpers so the exact numbers are visible and cannot shift under a Pixi minor.
  scene.dayNight.matrix = [r, 0, 0, 0, 0, 0, g, 0, 0, 0, 0, 0, b, 0, 0, 0, 0, 0, 1, 0];

  // Full daylight needs no pass at all. Attaching the filter only when it changes
  // something keeps the common case free of a render-texture round trip, and it is still
  // one filter on the root — never a per-object tint.
  const wanted = r < 0.995;
  if (wanted !== scene.filterOn) {
    scene.filterOn = wanted;
    scene.worldRoot.filters = wanted ? [scene.dayNight] : [];
  }
}

export function destroyWorldScene(scene: WorldScene): void {
  scene.hud.destroy();
  scene.overlay.destroy();
  scene.artSheet?.destroy();
  // Before the roots are torn down: the ceremony holds window listeners for its skip, and a
  // torn-down scene that still answers keystrokes is a leak with a visible symptom.
  scene.ceremony.destroy();
  scene.farmFx.destroy();
  scene.machineMotion.destroy();
  scene.fieldTiles.destroy();
  // The particle container before the item page: the page owns the shared texture source
  // every particle points at, and freeing it first hands the container dead frames.
  scene.beltItems.destroy();
  scene.beltStructures.destroy();
  scene.pipes.destroy();
  scene.grabbers.destroy();
  scene.bots.destroy();
  scene.trucks.destroy();
  scene.itemPage.destroy();
  scene.terrain.destroy();
  // `true`: the shore bakes own their sources, unlike the atlas windows the art set holds.
  for (const texture of scene.shoreTextures) texture.destroy(true);
  destroyLayers(scene.layers);
  scene.dayNight.destroy();
  scene.worldRoot.destroy({ children: true });
  scene.screenRoot.destroy({ children: true });
  scene.machines.clear();
}
