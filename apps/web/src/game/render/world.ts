// The scene: layers under a world root, the terrain bake, the sprite pools, and one
// day/night colour matrix.
//
// `./pixel` first — see the comment block there.
import { dayPhase, TILE_PX } from './pixel';

import { ColorMatrixFilter, Container, Rectangle, Sprite } from 'pixi.js';
import type { Application } from 'pixi.js';

import {
  FIELD_ORIGIN_X,
  FIELD_ORIGIN_Y,
  FIELD_TILES_HIGH,
  FIELD_TILES_WIDE,
  WORLD_TILES_HIGH,
  WORLD_TILES_WIDE,
} from '@snack/sim';

import { BeltItemLayer, buildItemPage } from './belt-items';
import type { ItemPage } from './belt-items';
import { ArtSheet, artSheetRequested } from './artsheet';
import { BeltStructureLayer } from './belt-structure';
import type { Camera } from './camera';
import { Ceremony } from './ceremony';
import { FarmFx } from './farm-fx';
import { GrabberLayer } from './grabbers';
import { Hud } from './hud';
import { createLayers, destroyLayers, LAYER_ORDER } from './layers';
import type { Layers } from './layers';
import { DevOverlay } from './overlay';
import { PipeLayer } from './pipes';
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
  /** Total upgrade level, as a short chrome strip. Bolt-on shine for a tuned machine. */
  dials: Sprite;
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

  /** One per field tile, in the field's row-major order. */
  readonly soil: Sprite[];
  readonly crops: Sprite[];
  readonly readyMarks: Sprite[];
  readonly compost: Sprite[];
  readonly machines: Map<number, MachineVisual>;
  readonly player: Sprite;
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
  readonly zoneOverlay: ZoneOverlay;
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
  /** Last frame's moisture, to notice the sprinkler pouring and spray a few droplets. */
  readonly lastMoisture: number[];
  /** True until the first projection has been folded in. */
  primed: boolean;
  /** Whether the day/night filter is currently attached. */
  filterOn: boolean;
}

/** The static ground layout of the v0.1 lot. Baked once; never changes in v0.1. */
function groundNameAt(tileX: number, tileY: number): string {
  const inField =
    tileX >= FIELD_ORIGIN_X &&
    tileY >= FIELD_ORIGIN_Y &&
    tileX < FIELD_ORIGIN_X + FIELD_TILES_WIDE &&
    tileY < FIELD_ORIGIN_Y + FIELD_TILES_HIGH;
  if (inField) return ART.groundField;

  // The yard: a dirt strip south of the field where the stand sits and where machines
  // can legally be placed (the sim refuses to build on field tiles).
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

  const source: TerrainSource = {
    ground: (tileX, tileY) => art.get(groundNameAt(tileX, tileY)),
    overlay: (tileX, tileY) => zoneOverlay.paints(tileX, tileY),
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

  const soil: Sprite[] = [];
  const crops: Sprite[] = [];
  const readyMarks: Sprite[] = [];
  const compost: Sprite[] = [];
  const wetTexture = art.get(ART.soilWet);
  const compostTexture = art.get(ART.uiCompost);

  for (let i = 0; i < FIELD_TILE_COUNT; i++) {
    const tileX = FIELD_ORIGIN_X + (i % FIELD_TILES_WIDE);
    const tileY = FIELD_ORIGIN_Y + Math.floor(i / FIELD_TILES_WIDE);

    // Moisture is an ALPHA RAMP on a pre-darkened soil sprite, not a tint and not a
    // re-bake: the ground bake must stay static or the whole chunk design is pointless.
    const wet = new Sprite(wetTexture);
    wet.position.set(tileX * TILE_PX, tileY * TILE_PX);
    wet.alpha = 0;
    contentRoot.addChild(wet);
    layers.groundEntities.attach(wet);
    soil.push(wet);

    // ANCHORED AT ITS BASE, not its top-left. The drink-bounce is a squash-stretch, and a
    // squash about a sprite's corner slides the plant sideways out of its own tile; about
    // its middle it shrinks like a deflating balloon. About the base it presses into the
    // soil and springs back, which is the only one of the three that reads as drinking.
    // The rect drawn at rest is identical to the top-left version — this moves nothing
    // until something scales it.
    const crop = new Sprite(art.get(ART.cropStage(1, 1)));
    crop.anchor.set(0.5, 1);
    crop.position.set(tileX * TILE_PX + TILE_PX / 2, tileY * TILE_PX + TILE_PX);
    crop.visible = false;
    contentRoot.addChild(crop);
    layers.groundEntities.attach(crop);
    crops.push(crop);

    // Compost sits UNDER the crop layer's ready marks and over the soil: it is litter on
    // the ground, not a plant, and plan §4's "nothing ever vanishes" only reads if you can
    // see the thing that did not vanish.
    const heap = new Sprite(compostTexture);
    heap.position.set(tileX * TILE_PX, tileY * TILE_PX);
    heap.visible = false;
    contentRoot.addChild(heap);
    layers.groundEntities.attach(heap);
    compost.push(heap);

    const mark = new Sprite(art.get(ART.uiReady));
    mark.anchor.set(0.5, 1);
    mark.position.set(tileX * TILE_PX + TILE_PX / 2, tileY * TILE_PX);
    mark.visible = false;
    contentRoot.addChild(mark);
    layers.worldUi.attach(mark);
    readyMarks.push(mark);
  }

  const player = new Sprite(art.get(ART.playerSouth));
  player.anchor.set(0.5, 1);
  contentRoot.addChild(player);
  layers.player.attach(player);

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

  const pipes = new PipeLayer(app.renderer, art, (sprite) => {
    contentRoot.addChild(sprite);
    layers.pipes.attach(sprite);
  });

  const beltStructures = new BeltStructureLayer(app.renderer, art, (sprite) => {
    contentRoot.addChild(sprite);
    layers.beltStructures.attach(sprite);
  });

  const beltItems = new BeltItemLayer(itemPage, WORLD_WIDTH_PX, WORLD_HEIGHT_PX);
  contentRoot.addChild(beltItems.container);
  layers.beltItems.attach(beltItems.container);

  const grabbers = new GrabberLayer(art, itemPage, (visual) => {
    contentRoot.addChild(visual.base, visual.hand, visual.cargo);
    layers.machines.attach(visual.base);
    layers.player.attach(visual.hand);
    layers.player.attach(visual.cargo);
  });

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
    soil,
    crops,
    readyMarks,
    compost,
    machines: new Map(),
    player,
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
    zoneOverlay,
    pipes,
    prevXSub: 0,
    prevYSub: 0,
    currXSub: 0,
    currYSub: 0,
    lastMoisture: new Array<number>(FIELD_TILE_COUNT).fill(0),
    primed: false,
    filterOn: false,
  };
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
  // The particle container before the item page: the page owns the shared texture source
  // every particle points at, and freeing it first hands the container dead frames.
  scene.beltItems.destroy();
  scene.beltStructures.destroy();
  scene.pipes.destroy();
  scene.grabbers.destroy();
  scene.itemPage.destroy();
  scene.terrain.destroy();
  destroyLayers(scene.layers);
  scene.dayNight.destroy();
  scene.worldRoot.destroy({ children: true });
  scene.screenRoot.destroy({ children: true });
  scene.machines.clear();
}
