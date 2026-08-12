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

import type { Camera } from './camera';
import { Hud } from './hud';
import { createLayers, destroyLayers, LAYER_ORDER } from './layers';
import type { Layers } from './layers';
import { DevOverlay } from './overlay';
import { TerrainBaker } from './terrain';
import type { TerrainSource } from './terrain';
import { ART } from './textures';
import type { ArtSet } from './textures';

export const WORLD_WIDTH_PX = WORLD_TILES_WIDE * TILE_PX;
export const WORLD_HEIGHT_PX = WORLD_TILES_HIGH * TILE_PX;
const FIELD_TILE_COUNT = FIELD_TILES_WIDE * FIELD_TILES_HIGH;
const DROPLET_POOL = 64;

export interface MachineVisual {
  body: Sprite;
  lamp: Sprite;
  wrench: Sprite;
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
  readonly machines: Map<number, MachineVisual>;
  readonly player: Sprite;
  readonly hover: Sprite;
  readonly droplets: Droplet[];
  readonly hud: Hud;
  readonly overlay: DevOverlay;

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

  const source: TerrainSource = {
    ground: (tileX, tileY) => art.get(groundNameAt(tileX, tileY)),
    // The zone-paint pass. Empty in v0.1: the seam exists so [[018]] is content, not
    // surgery. Returning null everywhere costs one bake of a transparent texture.
    overlay: () => null,
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
  const wetTexture = art.get(ART.soilWet);

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

    const crop = new Sprite(art.get(ART.cropStage(1)));
    crop.position.set(tileX * TILE_PX, tileY * TILE_PX);
    crop.visible = false;
    contentRoot.addChild(crop);
    layers.groundEntities.attach(crop);
    crops.push(crop);

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

  const hud = new Hud();
  const overlay = new DevOverlay();
  screenRoot.addChild(hud.root, overlay.root);

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
    machines: new Map(),
    player,
    hover,
    droplets,
    hud,
    overlay,
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
  scene.terrain.destroy();
  destroyLayers(scene.layers);
  scene.dayNight.destroy();
  scene.worldRoot.destroy({ children: true });
  scene.screenRoot.destroy({ children: true });
  scene.machines.clear();
}
