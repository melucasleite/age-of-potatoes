// The art set: atlas frames where they exist, generated grey-box placeholders where they
// do not.
//
// `./pixel` FIRST — it sets `scaleMode = 'nearest'` at module scope and this module is the
// one that causes textures to exist. See the comment block there.
import { TILE_PX } from './pixel';

import { Assets, Graphics, Rectangle, Texture } from 'pixi.js';
import type { Renderer, Spritesheet } from 'pixi.js';

import { BeltTier, CROP_SPECS, ITEM_SPECS, LampState, MACHINE_SPECS } from '@snack/sim';

import { ATLAS_FRAMES, ATLAS_JSON_URL } from '@/art/manifest.generated';

import { LAMP_FRAME, LAMP_PX, lampFrame } from './lamps';
import { stripCells, stripHasWiltCell } from './strips';

/** Frame ids are the sim's own slugs with dashes swapped for underscores. One vocabulary. */
function frameSlug(slug: string): string {
  return slug.split('-').join('_');
}

const ITEM_SLUG = new Map<number, string>(
  ITEM_SPECS.map((spec) => [spec.id as number, frameSlug(spec.slug)]),
);
const CROP_SLUG = new Map<number, string>(
  CROP_SPECS.map((spec) => [spec.id as number, frameSlug(spec.slug)]),
);
const MACHINE_SLUG = new Map<number, string>(
  MACHINE_SPECS.map((spec) => [spec.kind as number, frameSlug(spec.slug)]),
);

const BELT_SLUG: Record<number, string> = {
  [BeltTier.Basic]: 'basic',
  [BeltTier.Fast]: 'fast',
  [BeltTier.Express]: 'express',
};

/** The three per-machine dials, spelled the way the atlas spells them. */
export type DecalDial = 'speed' | 'efficiency' | 'capacity';

/**
 * The frame names the renderer asks for. Art slots in by NAME: when the pipeline emits a
 * frame with one of these ids, it replaces the placeholder with no code change here.
 *
 * Keeping this as one table is also the single-atlas contract of §13 in practice — every
 * name is resolved from the one loaded spritesheet, never from an ad-hoc texture load.
 *
 * The `machine`/`item`/`cropStage` entries are FUNCTIONS OF THE SIM'S OWN SLUGS rather than
 * hand-written literals, so a new machine or item in `data.ts` arrives here already named.
 * The failure mode that buys: nobody has to remember to add `machine_seasoner` twice.
 */
export const ART = {
  groundGrassA: 'ground_grass_a',
  groundGrassB: 'ground_grass_b',
  groundGrassC: 'ground_grass_c',
  groundLot: 'ground_lot',
  groundField: 'ground_field',
  groundWater: 'terrain_water',
  soilWet: 'soil_wet',
  cropStage: (crop: number, stage: number) =>
    `crop_${CROP_SLUG.get(crop) ?? 'russet_potato'}_${stage}`,
  machine: (kind: number) => `machine_${MACHINE_SLUG.get(kind) ?? 'sell_bin'}`,
  machineSellBin: 'machine_sell_bin',
  machineChipKitchen: 'machine_chip_kitchen',
  machineSprinkler: 'machine_sprinkler',
  /** One 8px cell per belt-rideable good. Every one of these lands on the item page. */
  item: (id: number) => `item_${ITEM_SLUG.get(id) ?? 'russet_potato'}`,
  /** The belt surface, one seamless tile scrolled by UV offset — never by moving sprites. */
  beltSurface: (tier: number) => `belt_${BELT_SLUG[tier] ?? 'basic'}`,
  /**
   * The conveyor tee a `BeltJunction` wears: the run west to east, a branch leaving south.
   *
   * ONE FRAME AND FOUR TURNS, chosen from the belts around it by `junction.ts` — the same
   * auto-tiling the pipe layer does, because a junction has no facing of its own and the belts
   * the player ran into it are the only thing that knows which way it points. It rides the belt
   * page rather than the machine page for the reason it is drawn at all: a junction dropped
   * into a run must not read as a boxed machine parked across the line.
   */
  beltJunction: 'belt_junction',
  /**
   * The six pipe frames, in the canonical east-first orientation `pipe-shape.ts` defines.
   *
   * Drawn near-white on purpose, exactly like the status lamp: a pipe is MULTIPLIED by its
   * liquid's colour at draw time, so art baked amber would make water a muddy teal. The one
   * frame that ships coloured is the shadow under the run, and it is dark rather than hued.
   */
  pipeFrame: (frame: string) => `pipe_${frame}`,
  /** The collar drawn where a real pipe meets a machine. Tinted by what is in that pipe. */
  uiPipeNub: 'ui_pipe_nub',
  grabberBase: 'grabber_base',
  grabberHand: 'grabber_hand',
  playerNorth: 'player_north',
  playerEast: 'player_east',
  playerSouth: 'player_south',
  playerWest: 'player_west',
  /**
   * The farmer, by pose and by which foot is forward — the player's own walk cycle ([[065]]),
   * built exactly as the bots' names are: strip cells registered in `STRIPS`, suffix is the
   * step. THREE POSES, NOT FOUR — one side pose mirrored at draw time (`index.ts`). NOTE THE
   * CONVENTION IS THE PLAYER'S OWN: `player_walk_side` is authored FACING RIGHT (east — the
   * manifest prompt says so), so WEST is the mirrored facing here, where the bots' side
   * strips face left and mirror for east. `north` asks for `player_walk_up` FIRST and falls
   * back to the side strip while the art lane's run is pending; the moment the atlas
   * carries the up strip it wins by candidate order with no code change.
   */
  playerWalk: (pose: 'north' | 'south' | 'side', step: number) => `player_walk_${pose}_${step}`,
  /**
   * An Agri-Bot, by kind, by facing, and by which foot is forward ([[038]]).
   *
   * THE NAME IS BUILT TO MEET THE ART THAT ALREADY EXISTS. The pipeline generated
   * `bot_harvester_walk_down` and `bot_harvester_walk_side` (and the planter's pair) as 32×16
   * two-cell strips, the same shape and the same two poses as `player_walk_down` — so these
   * names are strip cells, registered in `STRIPS` below, and the suffix is the step.
   *
   * THREE FACINGS, NOT FOUR. `east` is `west` mirrored at draw time (`bots.ts`), which is what
   * a side pose is for. And there is no `up` pose anywhere in this pipeline — not for the bots
   * and not for the player — so a bot walking away is mapped to its side view: uninformative,
   * but never a robot marching backwards while looking at you. See the note on `STRIPS`.
   */
  bot: (kind: string, facing: string, step: number) => `bot_${kind}_${facing}_${step}`,
  /**
   * The repair drone ([[039]]): ONE 16×16 frame, not a walk strip, because it flies. No
   * facing variants and no footfall — `bots.ts` mirrors it for east and bobs it on the wall
   * clock instead, which is what a hovering machine does that a walking one does not.
   */
  botRepairDrone: 'bot_repair_drone',
  /**
   * ONE SHAPE PER LAMP STATE, still tinted in code.
   *
   * §13's "one sprite, tinted" bought thirty machines' worth of state animation for the cost
   * of one frame, and every part of that survives here: seven 7×7 frames share the same atlas
   * page as everything else, the tint is still applied at draw time, and the draw is still one
   * ordinary sprite per machine. What it could not buy was a lamp a colourblind player can
   * read, which §16 lists as a known gap and specifies the fix for. See `lamps.ts`.
   */
  lamp: (state: number) => lampFrame(state),
  /**
   * The bitmap font's glyph grid: one 192×40 frame carrying 104 monospaced cells.
   *
   * Never fetched as a sprite. `font.ts` hands it to `BitmapFont` as a page and the glyph
   * rects are arithmetic on top of it, which is what lets the font ride the shared atlas
   * instead of needing a texture of its own.
   */
  uiFont: 'ui_font',
  /**
   * The upgrade decals: nine frames, `decal_<dial>_<level>` with level 1–3.
   *
   * THE SAME TRICK AS THE LAMP, one step further. Each is a full 32×32 overlay drawn in the
   * machine's own coordinate space, so it composites at the machine's position with no offset
   * table and no per-machine anchor — which is what keeps three dials × three levels × every
   * machine in the game down to nine frames instead of §15's per-machine sprite variants.
   *
   * Level 0 has no frame by design. A machine with a dial at zero draws nothing for it.
   */
  decal: (dial: DecalDial, level: number) => `decal_${dial}_${level}`,
  uiHover: 'ui_hover',
  /** Where a walk-to errand is headed. Corner brackets, so it never reads as the hover box. */
  uiTarget: 'ui_target',
  uiWrench: 'ui_wrench',
  uiDroplet: 'ui_droplet',
  uiReady: 'ui_ready',
  uiCompost: 'ui_compost',
  /** A 1×1 white pixel. Bars, pips, and zone fills are this tinted and stretched. */
  uiPixel: 'ui_pixel',
  uiZoneFill: 'ui_zone_fill',
  uiZoneEdgeN: 'ui_zone_edge_n',
  uiZoneEdgeE: 'ui_zone_edge_e',
  uiZoneEdgeS: 'ui_zone_edge_s',
  uiZoneEdgeW: 'ui_zone_edge_w',
} as const;

/**
 * Frames the art pipeline shipped under an older id.
 *
 * Checked only when the requested name is absent from the atlas, so a correctly-named frame
 * always wins. This is how the naming rule above can be adopted without a re-generation
 * run — and how a rename in `data.ts` degrades to "old art, right slot" instead of "grey box".
 */
const ALIASES: Record<string, string> = {
  item_russet_potato: 'item_potato',
  item_bagged_chips: 'item_chip_bag',
  ground_grass_a: 'terrain_grass',
  ground_grass_b: 'terrain_grass',
  ground_grass_c: 'terrain_grass',
  ground_field: 'terrain_soil_tilled',
  ground_lot: 'terrain_soil',
  // One belt tile serves all three tiers until the pipeline draws a fast and an express
  // one. They are still visibly different on screen, because tier changes the SPEED — and
  // speed is what the player is actually reading off a belt.
  belt_basic: 'belt_straight',
  belt_fast: 'belt_straight',
  belt_express: 'belt_straight',
  grabber_base: 'grabber_arm',
  ui_zone_fill: 'zone_overlay',
};

/**
 * Growth strips: one wide frame holding several square ones.
 *
 * The art CLI generates a crop's whole life as a single horizontal sheet — one call, so the
 * four frames come back stylistically coherent instead of as four unrelated plants (§15, and
 * the reason wide strips are free is in PRICING.md: cost tracks area, never aspect ratio).
 *
 * Slicing happens HERE rather than in the packer, because the sub-frames must stay on the
 * atlas's own `TextureSource` — carving them out at pack time would put each one somewhere
 * else on the page and buy nothing.
 *
 * ── CANDIDATES, NOT ONE NAME, AND THE GOLD POTATO IS WHY ────────────────────────────────
 *
 * Each entry is a LIST, tried in order, first one the atlas actually has wins. That is not
 * generality for its own sake: the short-name rule below ("potato's strip is `crop_potato_strip`,
 * not `crop_russet_potato_strip`") takes the last word of the slug, and the moment a second
 * potato existed — `gold-potato`, §5's premium crop — it produced the same short name as the
 * first. Every Gold Potato in the game would have grown Russet art, on a crop whose entire
 * design job is to look more valuable than the one beside it, and nothing would have thrown.
 *
 * So the full slug is asked for FIRST and the short name is the fallback. `crop_gold_potato_strip`
 * exists and wins; `crop_russet_potato_strip` does not exist and falls through to
 * `crop_potato_strip`, which is the name the pipeline has always used. Both crops get their own
 * plant and neither needed the art renamed.
 */
const STRIPS: Record<string, readonly string[]> = {};
for (const spec of CROP_SPECS) {
  // The pipeline names potato's strip `crop_potato_strip`, not `crop_russet_potato_strip`:
  // the last word of the slug is the one the art vocabulary uses.
  const full = frameSlug(spec.slug);
  const parts = full.split('_');
  const short = parts[parts.length - 1]!;
  // `<=` rather than `<`: ONE SPARE NAME past the sim's last growth stage. `view()` publishes
  // at most `stageCount - 1`, so nothing asks for the spare today — it is registered so that
  // when a strip arrives carrying a wilted frame, the cell is addressable without a second
  // edit here. On today's four-cell strips the spare clamps to the last growth cell, which is
  // exactly what a wilted crop already draws.
  for (let stage = 1; stage <= spec.stageCount; stage++) {
    STRIPS[ART.cropStage(spec.id as number, stage)] = [`crop_${full}_strip`, `crop_${short}_strip`];
  }
}

/**
 * The bots' walk strips, and the one gap in them, written down rather than left to be noticed.
 *
 * `bot_<kind>_walk_down` and `bot_<kind>_walk_side` are 32×16 — two 16×16 cells, the two feet.
 * THERE IS NO `walk_up` IN THIS PIPELINE, for the bots or for the player, so `north` is pointed
 * at the SIDE strip. That is the least-wrong of the three available answers: the front pose
 * would have a robot walking away from the camera while looking straight at it, and no mapping
 * at all would drop back to a grey placeholder for one facing out of four while the other three
 * were real art.
 *
 * HANDOFF (art lane): generate `bot_harvester_walk_up`, `bot_planter_walk_up` and
 * `player_walk_up`, and the `north` line below becomes its own strip. The procedural fallback
 * in `PLACEHOLDERS` already draws a real back, so a grey-box build is currently the MORE
 * informative of the two — which is a state of affairs worth ending.
 */
const BOT_KINDS = ['harvester', 'planter'] as const;
const BOT_STEPS = 2;
for (const kind of BOT_KINDS) {
  for (let step = 1; step <= BOT_STEPS; step++) {
    STRIPS[ART.bot(kind, 'south', step)] = [`bot_${kind}_walk_down`];
    STRIPS[ART.bot(kind, 'west', step)] = [`bot_${kind}_walk_side`];
    STRIPS[ART.bot(kind, 'north', step)] = [`bot_${kind}_walk_side`];
  }
}

/**
 * The player's walk strips ([[065]]) — the same two-cell shape the bots use, from the frames
 * the atlas has carried unsliced since v0.1. `north` lists `player_walk_up` FIRST: the strip
 * does not exist yet (the art lane's handoff above), so today the side strip answers, and the
 * day the up strip lands in the atlas it wins by candidate order with no edit here.
 */
for (let step = 1; step <= 2; step++) {
  STRIPS[ART.playerWalk('south', step)] = ['player_walk_down'];
  STRIPS[ART.playerWalk('side', step)] = ['player_walk_side'];
  STRIPS[ART.playerWalk('north', step)] = ['player_walk_up', 'player_walk_side'];
}

/**
 * Stage count by crop id, for the wilted-frame question below. Read once from the same
 * specs the STRIPS table was built from, so the two cannot disagree about what a crop is.
 */
const CROP_STAGE_COUNT = new Map<number, number>(
  CROP_SPECS.map((spec) => [spec.id as number, spec.stageCount]),
);

export interface ArtSet {
  /** The texture for a frame name, or a magenta "missing" square. Never throws. */
  get(name: string): Texture;
  /** True when the frame came from the real atlas rather than a placeholder. */
  isReal(name: string): boolean;
  /**
   * The crop's REAL wilted frame, or `null` when its strip does not carry one.
   *
   * `null` rather than a clamped cell, deliberately: `get(cropStage(id, stageCount))` on a
   * four-cell strip answers with the mature plant — a real texture, the wrong picture — so
   * the caller could never tell art from clamp. This is the renderer's one honest way to
   * ask "did the pipeline ever generate the dying plant?", and the field keeps its
   * tint-and-sag fallback (item 021) exactly as long as the answer is no.
   */
  cropWiltFrame(crop: number): Texture | null;
  /** How many requested frames fell back to placeholders. Reported by the dev overlay. */
  readonly placeholderCount: number;
  destroy(): void;
}

type Paint = (g: Graphics) => void;

/**
 * Build the art set.
 *
 * The atlas load is best-effort on purpose: a playable grey-box build beats a beautiful
 * one that does not run, and the art pipeline is a separate work item landing on its own
 * schedule. A missing or malformed atlas costs a console warning, not a black screen.
 */
export async function loadArt(renderer: Renderer): Promise<ArtSet> {
  let sheet: Spritesheet | null = null;
  try {
    const loaded: unknown = await Assets.load(ATLAS_JSON_URL);
    if (loaded !== null && typeof loaded === 'object' && 'textures' in loaded) {
      sheet = loaded as Spritesheet;
    }
  } catch (error) {
    console.warn('[snack] atlas unavailable, using placeholder art:', error);
  }

  const atlasNames = new Set(Object.keys(ATLAS_FRAMES));
  const generated = new Map<string, Texture>();
  const owned: Texture[] = [];
  let placeholderCount = 0;

  function bake(paint: Paint, width: number, height: number): Texture {
    const g = new Graphics();
    // A full-bounds transparent base so the generated frame is exactly the size asked
    // for, whatever the paint routine happens to cover.
    g.rect(0, 0, width, height).fill({ color: 0x000000, alpha: 0 });
    paint(g);
    const texture = renderer.generateTexture({
      target: g,
      resolution: 1,
      antialias: false,
      frame: new Rectangle(0, 0, width, height),
    });
    g.destroy();
    owned.push(texture);
    return texture;
  }

  function placeholder(name: string): Texture {
    const spec = PLACEHOLDERS[name];
    if (spec === undefined) {
      return bake((g) => g.rect(0, 0, TILE_PX, TILE_PX).fill(0xff00ff), TILE_PX, TILE_PX);
    }
    return bake(spec.paint, spec.width ?? TILE_PX, spec.height ?? TILE_PX);
  }

  // Strip cells are views onto the atlas source, so they are destroyed WITHOUT it. Putting
  // them in `owned` would hand the next host a destroyed spritesheet.
  const sliced = new Map<string, Texture>();

  /**
   * The whole strip a cell name slices from, or `null`. Split out of `fromStrip` so
   * `cropWiltFrame` can inspect the picture's cell count WITHOUT taking a clamped cell —
   * the clamp is exactly the behaviour it exists to see past.
   */
  function stripSource(name: string): Texture | null {
    const candidates = STRIPS[name];
    if (candidates === undefined || sheet === null) return null;
    // First candidate the atlas actually carries. See the note on `STRIPS`: the specific name
    // is asked for before the generic one, so a Gold Potato cannot silently grow Russet art.
    for (const source of candidates) {
      if (!atlasNames.has(source)) continue;
      const base = sheet.textures[source];
      if (base !== undefined) return base;
    }
    return null;
  }

  function fromStrip(name: string): Texture | null {
    const cached = sliced.get(name);
    if (cached !== undefined) return cached;

    const base = stripSource(name);
    if (base === null) return null;

    // `crop_corn_3` → cell 2. The stage number is the frame name's own suffix, so a crop
    // that grows a fifth stage needs no table anywhere.
    const suffix = Number(name.slice(name.lastIndexOf('_') + 1));
    if (!Number.isFinite(suffix) || suffix < 1) return null;

    // The clamp is what makes a longer strip free: ask for a stage the art does not have and
    // you get its last cell, ask for one it does and you get that cell.
    const cells = stripCells(base.frame.width, base.frame.height);
    if (cells <= 0) return null;
    const index = Math.min(cells - 1, suffix - 1);

    const cellWidth = Math.floor(base.frame.width / cells);
    if (cellWidth <= 0) return null;
    const cell = new Texture({
      source: base.source,
      frame: new Rectangle(
        base.frame.x + index * cellWidth,
        base.frame.y,
        cellWidth,
        base.frame.height,
      ),
    });
    sliced.set(name, cell);
    return cell;
  }

  function fromAtlas(name: string): Texture | null {
    if (sheet === null) return null;
    if (atlasNames.has(name)) {
      const found = sheet.textures[name];
      if (found !== undefined) return found;
    }
    const strip = fromStrip(name);
    if (strip !== null) return strip;
    const alias = ALIASES[name];
    if (alias !== undefined && atlasNames.has(alias)) {
      const found = sheet.textures[alias];
      if (found !== undefined) return found;
    }
    return null;
  }

  const art: ArtSet = {
    get(name: string): Texture {
      const real = fromAtlas(name);
      if (real !== null) return real;
      const cached = generated.get(name);
      if (cached !== undefined) return cached;
      const made = placeholder(name);
      generated.set(name, made);
      placeholderCount += 1;
      return made;
    },
    cropWiltFrame(crop: number): Texture | null {
      const stages = CROP_STAGE_COUNT.get(crop);
      if (stages === undefined) return null;
      // The spare name STRIPS registered one past the growth run — see the `<=` note there.
      const name = ART.cropStage(crop, stages);
      const base = stripSource(name);
      if (base === null) return null;
      // Only a strip that truly carries the extra cell answers; a four-cell strip would
      // clamp to its mature frame, and "mature" is the one thing a wilted crop must not be.
      if (!stripHasWiltCell(stripCells(base.frame.width, base.frame.height), stages)) {
        return null;
      }
      return fromStrip(name);
    },
    isReal(name: string): boolean {
      return fromAtlas(name) !== null;
    },
    get placeholderCount(): number {
      return placeholderCount;
    },
    destroy(): void {
      // Only the textures this host generated. The atlas is owned by the `Assets` cache
      // and is deliberately left alone: StrictMode remounts a second host immediately,
      // and destroying a cached spritesheet hands the next host dead textures.
      for (const texture of owned) texture.destroy(true);
      owned.length = 0;
      generated.clear();
      // `false`: these are windows onto the atlas source, which this host does not own.
      for (const texture of sliced.values()) texture.destroy(false);
      sliced.clear();
    },
  };

  return art;
}

// --- placeholder painting ----------------------------------------------------------
//
// Flat-ish coloured rectangles with just enough shape to read at a glance. Cosmetic
// randomness is legal here and nowhere near a sim RNG stream (§12) — but these use a
// positional hash rather than `Math.random` so a re-bake of the same chunk looks
// identical to the bake it replaced.

const PALETTE = {
  grass: 0x4e7a3a,
  grassDark: 0x3f6630,
  grassLight: 0x5c8b44,
  lot: 0x8a7a5c,
  lotDark: 0x74654b,
  soil: 0x7a5c3c,
  soilDark: 0x5e452c,
  soilWet: 0x33241a,
  leaf: 0x59a83f,
  leafDark: 0x3f8a2c,
  potato: 0xc09456,
  metal: 0xa8b0bc,
  metalDark: 0x7c8593,
  metalLight: 0xd9dee6,
  wood: 0xb07a3c,
  woodDark: 0x8a5c28,
  water: 0x6fc0e8,
  skin: 0xf0cfa0,
  shirt: 0xd2493f,
  trouser: 0x33436b,
  hair: 0x4a3320,
  white: 0xffffff,
  black: 0x1a1410,
} as const;

interface PlaceholderSpec {
  paint: Paint;
  width?: number;
  height?: number;
}

/** Deterministic per-position speckle, so a re-bake is pixel-identical to the last one. */
function speckle(g: Graphics, base: number, accent: number, seed: number): void {
  g.rect(0, 0, TILE_PX, TILE_PX).fill(base);
  let h = (seed * 2654435761) >>> 0;
  for (let i = 0; i < 5; i++) {
    h = (h ^ (h >>> 15)) >>> 0;
    h = (h * 2246822519) >>> 0;
    const x = h % TILE_PX;
    const y = (h >>> 8) % TILE_PX;
    g.rect(x, y, 1, 1).fill(accent);
  }
}

function grassTile(seed: number): Paint {
  return (g) => {
    speckle(g, PALETTE.grass, PALETTE.grassDark, seed);
    let h = (seed * 40503) >>> 0;
    for (let i = 0; i < 3; i++) {
      h = (h * 2246822519 + 12345) >>> 0;
      g.rect(h % TILE_PX, (h >>> 9) % TILE_PX, 1, 2).fill(PALETTE.grassLight);
    }
  };
}

const PLACEHOLDERS: Record<string, PlaceholderSpec> = {
  [ART.groundGrassA]: { paint: grassTile(1) },
  [ART.groundGrassB]: { paint: grassTile(7) },
  [ART.groundGrassC]: { paint: grassTile(19) },

  [ART.groundLot]: { paint: (g) => speckle(g, PALETTE.lot, PALETTE.lotDark, 3) },
  // The pond's no-atlas fallback. The real `terrain_water` frame ships in the packed atlas,
  // so this paint only ever shows on a build with no art at all — same rule as the pawns.
  [ART.groundWater]: { paint: (g) => speckle(g, PALETTE.water, 0x4fa3d1, 11) },

  [ART.groundField]: {
    paint: (g) => {
      g.rect(0, 0, TILE_PX, TILE_PX).fill(PALETTE.soil);
      // Furrows, so tilled soil reads as tilled and not just as brown.
      for (let y = 2; y < TILE_PX; y += 4) {
        g.rect(1, y, TILE_PX - 2, 1).fill(PALETTE.soilDark);
      }
    },
  },

  // Drawn at full opacity and faded by sprite alpha, so "wet" is a cheap alpha ramp
  // rather than a per-tile tint that would break the batch.
  [ART.soilWet]: { paint: (g) => g.rect(0, 0, TILE_PX, TILE_PX).fill(PALETTE.soilWet) },

  // Crop stages are registered per crop id at the bottom of this file — four crops ship,
  // and hand-writing sixteen near-identical plants is how three of them end up wrong.

  // Machines are registered at the bottom of this file, keyed by the sim's own slug and
  // sized from the sim's own footprint. See `registerMachinePlaceholders`.

  // --- pipes -----------------------------------------------------------------------
  //
  // Plan §5: "solids ride belts (double-line), liquids ride pipes (single-line)". So a
  // pipe is a THIN LINE down the middle of an otherwise empty tile — the opposite of a
  // belt, which fills its tile with a bed, two rails and goods. That contrast is what
  // makes a mature base read as a belt cathedral next to a pipe organ, and it is worth
  // more than any amount of detail inside either one.
  //
  // Near-white, because the pipe layer MULTIPLIES these by the liquid's colour.

  [ART.pipeFrame('stub')]: { paint: pipeTile([]) },
  [ART.pipeFrame('cap')]: { paint: pipeTile(['e']) },
  [ART.pipeFrame('straight')]: { paint: pipeTile(['e', 'w']) },
  [ART.pipeFrame('corner')]: { paint: pipeTile(['e', 's']) },
  [ART.pipeFrame('tee')]: { paint: pipeTile(['e', 's', 'w']) },
  [ART.pipeFrame('cross')]: { paint: pipeTile(['n', 'e', 's', 'w']) },

  /**
   * The collar where a real pipe meets a machine — SIX pixels, not five, and concentric.
   *
   * It has to be the run's own cross-section or it is not a collar. A pipe arm is 6px thick
   * (`pipeTile`'s spans: shadow, body, core, core, body, shadow) and both the arm and this are
   * centred on the same tile centre, so a 5px collar sat half a pixel off and one shade short at
   * every port — visible as a nick in the line exactly where the plumbing is supposed to read as
   * continuous. Written out as three concentric rings rather than as a top-lit box, for the same
   * reason `PIPE` is: the collar is drawn once and lands on all four faces unrotated.
   */
  [ART.uiPipeNub]: {
    width: 6,
    height: 6,
    paint: (g) => {
      g.rect(0, 0, 6, 6).fill(PIPE.shadow);
      g.rect(1, 1, 4, 4).fill(PIPE.body);
      g.rect(2, 2, 2, 2).fill(PIPE.shine);
    },
  },

  // --- belt surfaces ---------------------------------------------------------------
  //
  // Seamless top-to-bottom AND left-to-right, because one tile is scrolled by UV offset
  // in both a horizontal and a vertical belt. The chevrons point along +x in local space,
  // which is "forward" for every belt after the segment is rotated into its direction.

  [ART.beltSurface(1)]: { paint: beltTile(0x5a5f68, 0x8f96a2, 0x2f333a) },
  [ART.beltSurface(2)]: { paint: beltTile(0x5b5340, 0xd8b34a, 0x322d22) },
  [ART.beltSurface(3)]: { paint: beltTile(0x40505b, 0x62d6e0, 0x222c33) },
  // Painted in the BASIC tier's colours, because a junction has no tier of its own — it is one
  // $8 casting that any belt can be run into, and tinting it after whichever belt happens to
  // touch it first would make an express line's junction change colour when a basic belt was
  // laid on its far side.
  [ART.beltJunction]: { paint: beltJunctionTile(0x5a5f68, 0x8f96a2, 0x2f333a) },

  [ART.playerSouth]: { paint: pawn('south') },
  [ART.playerNorth]: { paint: pawn('north') },
  [ART.playerEast]: { paint: pawn('east') },
  [ART.playerWest]: { paint: pawn('west') },

  // The walk-cycle cells ([[065]]), for a build with no atlas at all. With the atlas loaded
  // every one of these is shadowed by a real strip — north included, which currently answers
  // with the SIDE strip via its candidate list (the bots' precedent: real art at the wrong
  // angle beats a procedural pawn among real frames). These grey-box cells keep the walk
  // cycle alive when the atlas itself is missing, back view and alternating feet intact.
  // The side cells face EAST, matching the authored strip's own convention above.
  [ART.playerWalk('south', 1)]: { paint: pawnWalk('south', 1) },
  [ART.playerWalk('south', 2)]: { paint: pawnWalk('south', 2) },
  [ART.playerWalk('side', 1)]: { paint: pawnWalk('east', 1) },
  [ART.playerWalk('side', 2)]: { paint: pawnWalk('east', 2) },
  [ART.playerWalk('north', 1)]: { paint: pawnWalk('north', 1) },
  [ART.playerWalk('north', 2)]: { paint: pawnWalk('north', 2) },

  // The bots are registered below with the machines and the crops — two kinds × three facings
  // × two steps is a loop, not twelve hand-written entries. See `registerBotPlaceholders`.

  // --- tool icons ([[065]]) ----------------------------------------------------------
  //
  // One 16px icon per hand tool, named by INPUT'S `toolIconFrame` table (`input/tools.ts`)
  // — which names are in turn the art pipeline's own ids (`art/manifest.json` already
  // declares every `tool_*` frame; the generation run is pending). Same consumption deal
  // as machine art: when the packed atlas ships a frame under the same name it wins with
  // no edit here. Drawn in the item-icon vocabulary (the bag's seeds/bottles/kits are the
  // reference set) so the bar and the hand read as one family the day the real set lands.
  // The repair-kit cursor is deliberately absent: it draws as its ITEM (`item_repair_kit`),
  // which the atlas already carries for real.

  tool_hand: {
    paint: (g) => {
      // The work glove — the slot art for the default verb. Never held: empty hands ARE
      // the hand tool, which is `toolHeldFrame`'s one divergence from the slot table.
      g.rect(5, 2, 6, 8).fill(PALETTE.skin);
      g.rect(4, 3, 2, 5).fill(PALETTE.skin);
      g.rect(10, 3, 2, 5).fill(PALETTE.skin);
      g.rect(5, 10, 6, 4).fill(PALETTE.shirt);
      g.rect(5, 10, 6, 1).fill(0xf07a6e);
    },
  },

  tool_water: {
    paint: (g) => {
      // The can: a squat metal body, a high handle, a spout with a drip coming off it.
      g.rect(3, 6, 8, 7).fill(PALETTE.metal);
      g.rect(3, 6, 8, 2).fill(PALETTE.metalLight);
      g.rect(3, 11, 8, 2).fill(PALETTE.metalDark);
      g.rect(5, 3, 4, 3).fill(PALETTE.metalDark);
      g.rect(10, 7, 4, 2).fill(PALETTE.metalDark);
      g.rect(13, 6, 2, 2).fill(PALETTE.metal);
      g.rect(14, 9, 1, 2).fill(PALETTE.water);
      g.rect(13, 12, 2, 2).fill(PALETTE.water);
    },
  },

  tool_plant: {
    paint: (g) => {
      // A tied sack spilling seed — the potato-seed chip's browns, at pouch size.
      g.rect(4, 6, 8, 8).fill(0x8a6b3a);
      g.rect(4, 6, 8, 2).fill(0xa5834a);
      g.rect(6, 3, 4, 3).fill(0x5c451f);
      g.rect(5, 5, 6, 1).fill(PALETTE.woodDark);
      g.rect(12, 12, 2, 2).fill(0x5c451f);
      g.rect(13, 10, 1, 1).fill(0x5c451f);
      g.rect(2, 13, 1, 1).fill(0x5c451f);
    },
  },

  tool_harvest: {
    paint: (g) => {
      // The gathering basket, with the payoff showing over the rim.
      g.rect(2, 8, 12, 6).fill(PALETTE.wood);
      g.rect(2, 8, 12, 2).fill(PALETTE.woodDark);
      g.rect(4, 10, 2, 3).fill(PALETTE.woodDark);
      g.rect(8, 10, 2, 3).fill(PALETTE.woodDark);
      g.circle(6, 7, 2).fill(PALETTE.potato);
      g.circle(10, 6, 2).fill(PALETTE.potato);
    },
  },

  tool_deconstruct: {
    paint: (g) => {
      // The teardown bar: a long diagonal with a hooked claw, red like the tool's errand.
      g.rect(3, 11, 3, 2).fill(PALETTE.metalDark);
      g.rect(5, 9, 3, 2).fill(PALETTE.metal);
      g.rect(7, 7, 3, 2).fill(PALETTE.metal);
      g.rect(9, 5, 3, 2).fill(PALETTE.metal);
      g.rect(11, 3, 3, 2).fill(PALETTE.shirt);
      g.rect(12, 2, 2, 2).fill(PALETTE.shirt);
    },
  },

  tool_till: {
    paint: (g) => {
      // The hoe ([[066]]): a long handle over a dark blade biting a strip of turned soil.
      g.rect(9, 1, 2, 10).fill(PALETTE.wood);
      g.rect(10, 0, 2, 3).fill(PALETTE.woodDark);
      g.rect(6, 10, 5, 3).fill(PALETTE.metalDark);
      g.rect(6, 10, 5, 1).fill(PALETTE.metal);
      g.rect(2, 13, 12, 2).fill(PALETTE.soil);
      g.rect(3, 14, 3, 1).fill(PALETTE.soilDark);
      g.rect(9, 14, 3, 1).fill(PALETTE.soilDark);
    },
  },

  // The seven lamp shapes are registered below, next to the masks they are drawn from.

  [ART.uiPixel]: { width: 1, height: 1, paint: (g) => g.rect(0, 0, 1, 1).fill(PALETTE.white) },

  [ART.uiCompost]: {
    paint: (g) => {
      // A low heap that sits on the soil rather than standing on it.
      g.rect(3, 11, 10, 4).fill(0x4a3a24);
      g.rect(5, 9, 6, 2).fill(0x5c4a2e);
      g.rect(6, 12, 2, 1).fill(0x6f7a3a);
      g.rect(10, 10, 2, 1).fill(0x6f7a3a);
    },
  },

  [ART.uiZoneFill]: { paint: (g) => g.rect(0, 0, TILE_PX, TILE_PX).fill(PALETTE.white) },
  [ART.uiZoneEdgeN]: { paint: (g) => g.rect(0, 0, TILE_PX, 1).fill(PALETTE.white) },
  [ART.uiZoneEdgeS]: { paint: (g) => g.rect(0, TILE_PX - 1, TILE_PX, 1).fill(PALETTE.white) },
  [ART.uiZoneEdgeW]: { paint: (g) => g.rect(0, 0, 1, TILE_PX).fill(PALETTE.white) },
  [ART.uiZoneEdgeE]: { paint: (g) => g.rect(TILE_PX - 1, 0, 1, TILE_PX).fill(PALETTE.white) },

  [ART.grabberBase]: {
    paint: (g) => {
      // Bottom-heavy pedestal with a bright pivot, so the arm has something to swing from.
      g.rect(4, 9, 8, 6).fill(PALETTE.metalDark);
      g.rect(5, 10, 6, 2).fill(PALETTE.metal);
      g.rect(6, 6, 4, 4).fill(PALETTE.metal);
      g.rect(7, 7, 2, 2).fill(0xf0c93d);
    },
  },

  [ART.grabberHand]: {
    width: 6,
    height: 6,
    paint: (g) => {
      g.rect(0, 1, 6, 2).fill(PALETTE.metal);
      g.rect(0, 0, 2, 5).fill(PALETTE.metalDark);
      g.rect(4, 0, 2, 5).fill(PALETTE.metalDark);
    },
  },

  [ART.uiHover]: {
    paint: (g) => {
      g.rect(0, 0, TILE_PX, 1).fill(PALETTE.white);
      g.rect(0, TILE_PX - 1, TILE_PX, 1).fill(PALETTE.white);
      g.rect(0, 0, 1, TILE_PX).fill(PALETTE.white);
      g.rect(TILE_PX - 1, 0, 1, TILE_PX).fill(PALETTE.white);
    },
  },

  /**
   * FOUR CORNER BRACKETS, NOT A BOX — and the difference is the whole point of the frame.
   * The destination marker and the hover outline are routinely on screen at the same time
   * (you click a far tile, then keep moving the mouse), and two identical rectangles in two
   * colours is a puzzle. Brackets read as "going there" at a glance, at any zoom rung.
   *
   * WHITE, like `ART.lamp` and `ART.uiHover`, because it is tinted at draw time — a frame
   * baked blue would multiply the tint toward black instead of showing it.
   */
  [ART.uiTarget]: {
    paint: (g) => {
      const arm = 4;
      const far = TILE_PX - arm;
      g.rect(0, 0, arm, 1).fill(PALETTE.white);
      g.rect(0, 0, 1, arm).fill(PALETTE.white);
      g.rect(far, 0, arm, 1).fill(PALETTE.white);
      g.rect(TILE_PX - 1, 0, 1, arm).fill(PALETTE.white);
      g.rect(0, TILE_PX - 1, arm, 1).fill(PALETTE.white);
      g.rect(0, far, 1, arm).fill(PALETTE.white);
      g.rect(far, TILE_PX - 1, arm, 1).fill(PALETTE.white);
      g.rect(TILE_PX - 1, far, 1, arm).fill(PALETTE.white);
    },
  },

  [ART.uiWrench]: {
    width: 6,
    height: 6,
    paint: (g) => {
      g.rect(0, 0, 6, 6).fill(0xf0c93d);
      g.rect(2, 1, 2, 4).fill(PALETTE.black);
    },
  },

  [ART.uiDroplet]: {
    width: 3,
    height: 4,
    paint: (g) => {
      g.rect(1, 0, 1, 1).fill(PALETTE.water);
      g.rect(0, 1, 3, 3).fill(PALETTE.water);
    },
  },

  [ART.uiReady]: {
    width: 5,
    height: 5,
    paint: (g) => {
      g.rect(1, 0, 3, 5).fill(0xffe86b);
      g.rect(0, 1, 5, 3).fill(0xffe86b);
    },
  },
};

/**
 * A belt surface tile: dark bed, bright rails top and bottom, and two chevrons pointing
 * along +x. Seamless on both axes so the same 16px tile serves a belt running in any
 * direction once the segment sprite is rotated.
 */
function beltTile(bed: number, rail: number, shadow: number): Paint {
  return (g) => {
    g.rect(0, 0, TILE_PX, TILE_PX).fill(bed);
    g.rect(0, 0, TILE_PX, 2).fill(rail);
    g.rect(0, TILE_PX - 2, TILE_PX, 2).fill(rail);
    g.rect(0, 2, TILE_PX, 1).fill(shadow);
    g.rect(0, TILE_PX - 3, TILE_PX, 1).fill(shadow);
    // Two chevrons, each wrapping cleanly at the tile edge so the scroll has no seam.
    for (const ox of [1, 9]) {
      for (let i = 0; i < 4; i++) {
        g.rect(ox + i, 4 + i, 1, 1).fill(rail);
        g.rect(ox + i, 11 - i, 1, 1).fill(rail);
      }
    }
  };
}

/**
 * The junction placeholder: the belt tee, in its canonical turn.
 *
 * Its through-run edges are the straight tile's, deliberately — a tee dropped into the middle
 * of a run must show no seam at either end of itself, which is the property the real frame is
 * authored and asserted against. Only the south rail is cut, for the branch.
 *
 * NOT SCROLLED. The junction is a fixed sprite that the auto-tiler turns; the belts either side
 * carry the motion. A tee whose surface crawled would have to crawl in two directions at once.
 */
function beltJunctionTile(bed: number, rail: number, shadow: number): Paint {
  return (g) => {
    g.rect(0, 0, TILE_PX, TILE_PX).fill(bed);
    g.rect(0, 0, TILE_PX, 2).fill(rail);
    g.rect(0, 2, TILE_PX, 1).fill(shadow);
    // The south rail, broken either side of the branch mouth.
    g.rect(0, TILE_PX - 2, 5, 2).fill(rail);
    g.rect(TILE_PX - 5, TILE_PX - 2, 5, 2).fill(rail);
    g.rect(0, TILE_PX - 3, 5, 1).fill(shadow);
    g.rect(TILE_PX - 5, TILE_PX - 3, 5, 1).fill(shadow);
    // The branch's own cheeks, running down either side of the mouth at x = 5..10.
    g.rect(4, TILE_PX - 5, 1, 5).fill(shadow);
    g.rect(TILE_PX - 5, TILE_PX - 5, 1, 5).fill(shadow);
    // Chevrons: two along the run pointing east, one down the branch pointing south, so the
    // fork is legible at 16px and the two directions are told apart by shape rather than tone.
    for (let i = 0; i < 4; i++) {
      g.rect(2 + i, 4 + i, 1, 1).fill(rail);
      g.rect(2 + i, 11 - i, 1, 1).fill(rail);
      g.rect(11 + i, 4 + i, 1, 1).fill(rail);
      g.rect(11 + i, 11 - i, 1, 1).fill(rail);
    }
    for (let i = 0; i < 3; i++) {
      g.rect(6 + i, 9 + i, 1, 1).fill(rail);
      g.rect(10 - i, 9 + i, 1, 1).fill(rail);
    }
  };
}

/**
 * The pipe's own three values. Near-neutral, because the pipe layer multiplies them by the
 * liquid's colour — a pipe drawn amber would make water a muddy teal.
 *
 * Concentric rather than top-lit: shadow, body, bright core, all symmetric about the tile
 * centre. The frames are drawn ONCE facing east and rotated in quarter turns, so a highlight
 * along the top edge would end up along the bottom edge of every vertical run.
 */
const PIPE = {
  shadow: 0x35343f,
  body: 0xbcc0cc,
  shine: 0xefe2c6,
} as const;

type PipeSideKey = 'n' | 'e' | 's' | 'w';

/** One pipe tile: a hub, plus a 4px arm toward each connected side. Seamless at the edges. */
function pipeTile(sides: readonly PipeSideKey[]): Paint {
  const arms: Record<PipeSideKey, readonly [number, number, number, number][]> = {
    // [shadow, body, core] spans, in draw order.
    e: [
      [8, 5, 8, 6],
      [8, 6, 8, 4],
      [8, 7, 8, 2],
    ],
    w: [
      [0, 5, 8, 6],
      [0, 6, 8, 4],
      [0, 7, 8, 2],
    ],
    n: [
      [5, 0, 6, 8],
      [6, 0, 4, 8],
      [7, 0, 2, 8],
    ],
    s: [
      [5, 8, 6, 8],
      [6, 8, 4, 8],
      [7, 8, 2, 8],
    ],
  };
  return (g) => {
    // Read inside the closure, not at call time: `PLACEHOLDERS` is built at module load and
    // `PIPE` is declared below it. A colour read one line earlier is a temporal-dead-zone
    // crash on import, which is a spectacular way to lose an afternoon.
    const layers = [PIPE.shadow, PIPE.body, PIPE.shine];
    for (let layer = 0; layer < 3; layer++) {
      for (const side of sides) {
        const [x, y, w, h] = arms[side][layer]!;
        g.rect(x, y, w, h).fill(layers[layer]!);
      }
    }
    // The hub last, so a tee's three arms meet under one collar rather than showing the
    // seams where they overlap. An isolated tile is a hub alone: a flange with no run,
    // which is exactly what a one-tile pipe is.
    g.rect(4, 4, 8, 8).fill(PIPE.shadow);
    g.rect(5, 5, 6, 6).fill(PIPE.body);
    g.rect(7, 7, 2, 2).fill(PIPE.shine);
  };
}

// --- machines ------------------------------------------------------------------------
//
// ────────────────────────────────────────────────────────────────────────────────────
//  TWO DISTRICTS, TWO SILHOUETTE GRAMMARS. (Plan §5.)
//
//  "Chip line is a belt cathedral ... Soda line is a pipe organ ... A mature base reads as
//   two distinct districts."
//
//  That is a rendering requirement, and the way it is met is by giving the two lines
//  different GRAMMARS rather than different details:
//
//    chip line — cold grey steel, WIDE and horizontal, cues that cut and heat: a drum, a
//                blade wheel, a chimney, a cone, a chute. Things goods pass through.
//    soda line — warm brass and copper, TALL and vertical, cues that hold and pour:
//                rollers, a bellied kettle, a glass column, a pressure sphere, a gantry.
//                Things liquid sits inside.
//
//  Colour alone would not survive a colourblind player or a half-second glance, so the
//  split is carried by shape and by aspect first, with the brass as confirmation. §15 warns
//  that "making 30 machines distinguishable at a glance at 32–48px in one palette" is the
//  hard part of machine art; a grammar per district is how thirty stays readable.
// ────────────────────────────────────────────────────────────────────────────────────

/** Brass and copper, from `art/palette/master.json`. The soda district's whole identity. */
const BRASS = {
  dark: 0x8a6234,
  mid: 0xb58b4d,
  light: 0xd9b475,
  shine: 0xf5d382,
  copper: 0x855428,
} as const;

/** The liquids that show INSIDE soda machines. Same values the pipe layer tints with. */
const FLUID = {
  juice: 0x74a340,
  syrup: 0xd9ab6e,
  fizz: 0x9fdcef,
  cola: 0x9e2f27,
  water: 0x4fa3d1,
} as const;

/** A machine placeholder painter. `w`/`h` are the machine's footprint in pixels. */
type MachinePaint = (g: Graphics, w: number, h: number) => void;

/**
 * Machine looks, keyed by the SIM'S OWN SLUG.
 *
 * Keyed by slug and not by kind id on purpose: kind ids belong to `packages/sim`, and the
 * soda machines are being written by another agent this round. A look listed here appears
 * the moment a machine with that slug exists, with no edit in this file — which is the
 * whole "adding a machine kind is a data change" contract.
 */
const MACHINE_LOOKS: Record<string, MachinePaint> = {
  'sell-bin': (g) => {
    g.rect(1, 5, 14, 10).fill(PALETTE.wood);
    g.rect(1, 5, 14, 2).fill(PALETTE.woodDark);
    g.rect(0, 3, 16, 2).fill(PALETTE.shirt);
    g.rect(4, 9, 8, 4).fill(PALETTE.black);
  },

  'chip-kitchen': (g) => {
    g.rect(1, 6, 30, 25).fill(PALETTE.metal);
    g.rect(1, 6, 30, 3).fill(PALETTE.metalDark);
    g.rect(4, 12, 12, 12).fill(PALETTE.black);
    g.rect(6, 14, 8, 8).fill(0xe8a33d);
    g.rect(20, 12, 8, 14).fill(PALETTE.metalDark);
    g.rect(21, 14, 6, 4).fill(PALETTE.potato);
    // Chimney, so a 2×2 blob reads as a cooker from across the lot.
    g.rect(22, 0, 6, 7).fill(PALETTE.metalDark);
  },

  sprinkler: (g) => {
    g.rect(6, 8, 4, 7).fill(PALETTE.metalDark);
    g.rect(3, 13, 10, 2).fill(PALETTE.metal);
    g.rect(4, 3, 8, 5).fill(PALETTE.water);
    g.rect(5, 1, 6, 2).fill(PALETTE.metal);
  },

  // --- the chip line: cold steel, wide, one loud unshared cue each -------------------

  washer: (g) => {
    // A horizontal drum with a porthole, standing in a puddle.
    g.rect(2, 8, 28, 20).fill(PALETTE.metal);
    g.rect(2, 8, 28, 3).fill(PALETTE.metalDark);
    g.circle(16, 18, 8).fill(PALETTE.metalDark);
    g.circle(16, 18, 6).fill(PALETTE.water);
    g.circle(13, 15, 2).fill(0xbfe8f7);
    g.rect(2, 28, 28, 3).fill(0x3f7f9c);
  },

  slicer: (g) => {
    // A blade wheel on a low bench. Teeth on the rim, so it reads as "cuts".
    g.rect(2, 16, 28, 14).fill(PALETTE.metalDark);
    g.rect(2, 16, 28, 2).fill(PALETTE.metal);
    g.circle(16, 14, 10).fill(0xd9dee6);
    g.circle(16, 14, 7).fill(PALETTE.metalDark);
    for (let i = 0; i < 8; i++) {
      g.rect(6 + i * 3, 3, 2, 3).fill(0xd9dee6);
    }
    g.rect(4, 24, 6, 3).fill(0xefe6cf);
    g.rect(12, 24, 6, 3).fill(0xefe6cf);
  },

  fryer: (g) => {
    // The half-speed one, and the machine the player is meant to want a second of.
    // Loudest silhouette in the line — a tall chimney and a hot orange vat.
    g.rect(20, 0, 8, 12).fill(PALETTE.metalDark);
    g.rect(22, 0, 4, 3).fill(0x54606e);
    g.rect(1, 10, 30, 21).fill(PALETTE.metal);
    g.rect(1, 10, 30, 3).fill(PALETTE.metalDark);
    g.rect(4, 16, 16, 12).fill(PALETTE.black);
    g.rect(5, 18, 14, 9).fill(0xe8912d);
    g.rect(7, 20, 3, 2).fill(0xffd27a);
    g.rect(13, 22, 3, 2).fill(0xffd27a);
  },

  seasoner: (g) => {
    // An inverted cone hopper dusting paprika. Only cone in the line.
    g.rect(2, 18, 28, 13).fill(PALETTE.metal);
    g.rect(2, 18, 28, 3).fill(PALETTE.metalDark);
    g.poly([8, 2, 24, 2, 18, 17, 14, 17]).fill(0xc2452f);
    g.poly([9, 3, 23, 3, 20, 10, 12, 10]).fill(0xe0674a);
    g.rect(14, 17, 4, 4).fill(PALETTE.metalDark);
    g.rect(11, 24, 10, 4).fill(0xe8a33d);
  },

  bagger: (g) => {
    // A chute over a stack of finished bags. The only machine with a bag on it.
    g.rect(2, 6, 28, 18).fill(PALETTE.metal);
    g.rect(2, 6, 28, 3).fill(PALETTE.metalDark);
    g.poly([10, 9, 22, 9, 19, 20, 13, 20]).fill(PALETTE.metalDark);
    g.rect(4, 24, 10, 7).fill(PALETTE.shirt);
    g.rect(5, 25, 8, 2).fill(0xf07a6e);
    g.rect(17, 26, 10, 5).fill(PALETTE.shirt);
    g.rect(18, 27, 8, 1).fill(0xf07a6e);
  },

  // --- the soda line: warm brass, tall, things liquid sits inside --------------------

  'cane-press': canePress,
  juicer: canePress,
  press: canePress,

  kettle: (g) => {
    // A bellied copper pot on legs under a domed lid, with a steam pipe curling off it.
    // The only ROUND-BELLIED machine in the game — a kettle is unmistakable at 32px even
    // when the brass reads as "some warm colour".
    g.rect(7, 27, 4, 5).fill(BRASS.copper);
    g.rect(21, 27, 4, 5).fill(BRASS.copper);
    g.circle(16, 20, 11).fill(BRASS.copper);
    g.circle(16, 20, 9).fill(BRASS.mid);
    g.circle(13, 17, 3).fill(BRASS.light);
    g.rect(7, 8, 18, 4).fill(BRASS.dark);
    g.poly([9, 8, 23, 8, 20, 2, 12, 2]).fill(BRASS.light);
    g.rect(24, 0, 4, 11).fill(PALETTE.metalDark);
    g.rect(25, 0, 2, 3).fill(PALETTE.metal);
  },

  grinder: (g) => {
    // A tall narrow hopper narrowing into a squat mill, with a hand crank out on the flank
    // and a spill of dark red powder at the foot. The only machine with a wheel ON ITS SIDE
    // rather than on its face, and the narrowest waist in either district.
    g.rect(8, 0, 16, 11).fill(PALETTE.metal);
    g.rect(8, 0, 16, 2).fill(PALETTE.metalLight);
    g.poly([8, 11, 24, 11, 19, 20, 13, 20]).fill(PALETTE.metalDark);
    g.rect(13, 20, 6, 3).fill(PALETTE.black);
    g.rect(4, 23, 24, 9).fill(BRASS.dark);
    g.rect(4, 23, 24, 2).fill(BRASS.mid);
    g.circle(28, 27, 4).fill(BRASS.light);
    g.circle(28, 27, 1).fill(BRASS.dark);
    g.rect(25, 22, 2, 5).fill(BRASS.mid);
    g.rect(9, 28, 14, 4).fill(0x5e1c1a);
    g.rect(11, 28, 10, 1).fill(0x9e2f27);
  },

  'syrup-mixer': syrupMixer,
  mixer: syrupMixer,

  carbonator: (g) => {
    // A pressure sphere in a cradle, banded by two straps, with a gauge on the shoulder.
    // The ONLY SPHERE in the game. Nothing else in either district is round all the way.
    g.rect(4, 27, 24, 5).fill(PALETTE.metalDark);
    g.circle(16, 17, 13).fill(PALETTE.metalDark);
    g.circle(16, 17, 11).fill(FLUID.fizz);
    g.circle(12, 13, 3).fill(0xffffff);
    g.rect(3, 15, 26, 3).fill(BRASS.mid);
    g.rect(14, 5, 3, 25).fill(BRASS.mid);
    g.circle(23, 8, 3).fill(BRASS.shine);
    g.circle(23, 8, 1).fill(PALETTE.black);
  },

  bottler: (g, w) => {
    // The 3×2 flagship: a gantry beam on brass uprights, three filling heads in a row, and
    // a row of finished bottles on the deck. The only machine WIDER THAN IT IS TALL, and
    // the only one with a repeating rhythm across its face — which is what makes a factory
    // read as having a "far end" at all.
    const heads = 3;
    g.rect(0, 3, w, 4).fill(BRASS.dark);
    g.rect(0, 7, w, 7).fill(BRASS.mid);
    g.rect(0, 3, w, 2).fill(BRASS.light);
    g.rect(0, 3, 4, 29).fill(BRASS.dark);
    g.rect(w - 4, 3, 4, 29).fill(BRASS.dark);
    for (let i = 0; i < heads; i++) {
      const x = Math.round(((i + 0.5) * (w - 8)) / heads) + 2;
      g.rect(x, 14, 4, 6).fill(PALETTE.metalLight);
      g.rect(x + 1, 20, 2, 2).fill(FLUID.cola);
    }
    g.rect(4, 24, w - 8, 8).fill(PALETTE.metalDark);
    for (let i = 0; i < heads; i++) {
      const x = Math.round(((i + 0.5) * (w - 8)) / heads) + 1;
      g.rect(x, 25, 5, 7).fill(FLUID.cola);
      g.rect(x + 1, 25, 3, 2).fill(BRASS.light);
    }
  },

  // --- the fluid utilities ------------------------------------------------------------
  //
  // The pump and the tank belong to the pipe-network item, not to this one. Their looks
  // live here anyway, for the same reason the soda looks do: a slug that exists is a
  // machine that draws, and neither agent has to remember to come back.

  pump: (g, w, h) => {
    g.rect(1, h - 14, w - 2, 13).fill(PALETTE.metalDark);
    g.rect(1, h - 14, w - 2, 2).fill(PALETTE.metal);
    g.circle(w / 2, h - 16, 7).fill(BRASS.dark);
    g.circle(w / 2, h - 16, 5).fill(BRASS.mid);
    g.circle(w / 2, h - 16, 2).fill(BRASS.shine);
    g.rect(1, h - 6, w - 2, 5).fill(FLUID.water);
  },

  tank: (g, w, h) => {
    g.rect(2, 2, w - 4, h - 4).fill(PALETTE.metal);
    g.rect(2, 2, w - 4, 3).fill(PALETTE.metalLight);
    g.rect(2, h - 5, w - 4, 3).fill(PALETTE.metalDark);
    // The level window. The live fill is drawn over it in code from `tankPermille`, so the
    // sprite shows the glass and never a fixed level that would contradict the readout.
    g.rect(Math.round(w / 2) - 2, 5, 4, h - 10).fill(PALETTE.black);
    g.rect(4, 6, 3, h - 12).fill(BRASS.mid);
    g.rect(w - 7, 6, 3, h - 12).fill(BRASS.mid);
  },

  // --- the field's own machines: WOOD AND LEAF, NEVER STEEL --------------------------
  //
  // Everything above this line is a factory: cold metal or warm brass, boxy, with a topper.
  // Everything below it stands in a field, and the placeholders say so in the one language a
  // 32px sprite can — material. A player scanning the lot should be able to tell the district
  // apart before they can tell the machine apart, which is the same argument the chip line's
  // "one loud unshared cue each" makes one level up.

  'orange-tree': orchardTree(0xe08a2c, 0xf2a748),
  'lemon-tree': orchardTree(0xdcc63c, 0xf2e06a),
  // Darker canopy and a dark nut, because the kola is the expensive one and the tree the
  // player has to work for — and because a third yellow-orange ball would be a third of the
  // same tree.
  'kola-tree': orchardTree(0x6b4326, 0x8a5c33, 0x3f7a34, 0x2f5c24),

  'root-cellar': (g, w, h) => {
    // A turf mound with a timber door in it, sunk into the ground. Nothing here is a box on
    // legs: the whole promise of the Cellar is that it is UNDER something.
    g.rect(0, 6, w, h - 6).fill(PALETTE.grassDark);
    g.rect(0, 6, w, 3).fill(PALETTE.grass);
    g.rect(2, 9, w - 4, 2).fill(PALETTE.grassLight);
    const doorW = Math.round(w / 2);
    const doorX = Math.round((w - doorW) / 2);
    g.rect(doorX, h - 15, doorW, 14).fill(PALETTE.woodDark);
    g.rect(doorX + 1, h - 14, doorW - 2, 12).fill(PALETTE.wood);
    g.rect(doorX + 1, h - 9, doorW - 2, 1).fill(PALETTE.woodDark);
    g.rect(doorX + doorW - 4, h - 9, 2, 2).fill(PALETTE.metalDark);
  },

  'hand-cart': (g, w, h) => {
    // A barrow: one wheel, two handles, a tray. It is the only machine in the game with a
    // wheel bigger than its body, which is what keeps it from reading as a small crate.
    g.rect(2, h - 12, w - 6, 6).fill(PALETTE.wood);
    g.rect(2, h - 12, w - 6, 2).fill(PALETTE.woodDark);
    g.rect(w - 5, h - 13, 4, 2).fill(PALETTE.woodDark);
    g.circle(6, h - 4, 4).fill(PALETTE.metalDark);
    g.circle(6, h - 4, 2).fill(PALETTE.metal);
    g.rect(4, h - 16, w - 8, 4).fill(PALETTE.potato);
  },

  composter: (g, w, h) => {
    // Open slatted bin with the heap standing proud of the top, steaming. Deliberately the
    // only machine on the lot with something SPILLING out of it.
    g.rect(2, 8, w - 4, h - 10).fill(PALETTE.woodDark);
    for (let y = 11; y < h - 4; y += 4) {
      g.rect(3, y, w - 6, 2).fill(PALETTE.wood);
    }
    g.rect(5, 6, w - 10, 5).fill(0x4a3a24);
    g.rect(8, 4, w - 16, 3).fill(0x5c4a2e);
    g.rect(10, 3, 3, 2).fill(0x6f7a3a);
    g.rect(w - 14, 5, 3, 2).fill(0x6f7a3a);
  },

  // The two docks are one sprite with two doors, because they are one shed with two jobs —
  // and the thing that tells them apart is what is stacked outside: crates on the harvester,
  // seed sacks on the planter. The bot itself is drawn by `bots.ts` and is usually elsewhere.
  'harvester-dock': botDock(PALETTE.potato, 0xe8b53d),
  'planter-dock': botDock(0x6f7a3a, 0x7ed68e),

  // The drone bay is the third dock, and it wears the dock silhouette on purpose: same shed,
  // same open doorway, so "the thing that lives here is out working" reads before the player
  // has ever seen the drone. Brass parts stacked outside, a red charge light — the repair
  // drone's own capsule colour. PLACEHOLDER: the art lane has generated no `machine_drone_bay`
  // sprite yet (item 039's handoff); when one lands in the atlas it wins automatically.
  'drone-bay': botDock(0xb08d57, 0xe0674a),
};

/**
 * A 2×2 fruiting tree: trunk, canopy, and three pieces of fruit.
 *
 * ROUND AND TALLER THAN IT IS WIDE, against a district of squat rectangles — a tree has to
 * read as a plant from the zoom level where a machine reads as a box, and at 32px the only
 * reliable way to say "plant" is silhouette rather than detail. The three trees share this and
 * differ only in fruit colour and canopy tone, which is the same trade the lamps make: one
 * shape, several tints, and the one that is genuinely a different tree (the kola) gets a
 * darker canopy as well so it is not a third citrus.
 */
function orchardTree(
  fruit: number,
  fruitLight: number,
  leaf: number = PALETTE.leaf,
  leafDark: number = PALETTE.leafDark,
): MachinePaint {
  return (g, w, h) => {
    const cx = Math.round(w / 2);
    g.rect(cx - 2, h - 12, 4, 11).fill(PALETTE.woodDark);
    g.rect(cx - 2, h - 12, 2, 11).fill(PALETTE.wood);
    g.circle(cx, h - 19, 11).fill(leafDark);
    g.circle(cx - 3, h - 22, 7).fill(leaf);
    g.circle(cx + 5, h - 17, 6).fill(leaf);
    g.circle(cx - 6, h - 15, 3).fill(fruit);
    g.circle(cx + 4, h - 24, 3).fill(fruit);
    g.circle(cx + 7, h - 13, 3).fill(fruit);
    g.rect(cx - 7, h - 16, 2, 1).fill(fruitLight);
    g.rect(cx + 3, h - 25, 2, 1).fill(fruitLight);
  };
}

/**
 * A bot dock: a shed with a roller door, a charging light, and the day's work stacked outside.
 *
 * The door is drawn OPEN and empty on purpose. A dock whose bot is out is the normal state of
 * a working dock, and an empty doorway is the one cue that says the machine has something that
 * leaves — which is the whole difference between this and the Root Cellar next to it.
 */
function botDock(cargo: number, lamp: number): MachinePaint {
  return (g, w, h) => {
    g.rect(1, 6, w - 2, h - 7).fill(PALETTE.metal);
    g.rect(1, 6, w - 2, 3).fill(PALETTE.metalDark);
    // The roof overhang, so it is a shed rather than a cabinet.
    g.rect(0, 4, w, 3).fill(PALETTE.metalDark);
    g.rect(0, 4, w, 1).fill(PALETTE.metalLight);
    // The open bay.
    g.rect(4, 13, w - 14, h - 15).fill(PALETTE.black);
    g.rect(5, 14, w - 16, 2).fill(0x2a2f38);
    // Charge light, top right, in the kind's own colour.
    g.rect(w - 6, 8, 3, 3).fill(lamp);
    // What the dock is for, stacked beside the door.
    g.rect(w - 9, h - 9, 7, 7).fill(cargo);
    g.rect(w - 9, h - 9, 7, 2).fill(PALETTE.woodDark);
    g.rect(w - 8, h - 5, 5, 1).fill(PALETTE.woodDark);
  };
}

/**
 * The cane press / juicer: paired rollers under a full-width hopper, juice running out.
 *
 * The two rollers are the identifying cue — nothing else in either district is a PAIR of
 * circles — but two circles under a tapered hat is also, unavoidably, a face. So the hopper
 * runs the full width instead of tapering, and a heavy axle bar crosses both rollers at
 * their centres. Both changes exist purely to stop the machine looking back at the player.
 */
function canePress(g: Graphics): void {
  g.rect(0, 0, 32, 8).fill(BRASS.light);
  g.rect(0, 0, 32, 3).fill(BRASS.shine);
  g.rect(2, 8, 28, 22).fill(BRASS.dark);
  g.rect(2, 8, 28, 2).fill(BRASS.mid);
  g.circle(10, 19, 6).fill(PALETTE.metal);
  g.circle(22, 19, 6).fill(PALETTE.metal);
  g.circle(10, 19, 2).fill(BRASS.copper);
  g.circle(22, 19, 2).fill(BRASS.copper);
  // The axle, straight through both. This is the line that breaks the face.
  g.rect(1, 18, 30, 3).fill(BRASS.copper);
  g.rect(1, 18, 30, 1).fill(BRASS.light);
  // Juice, running out of the press and pooling under it.
  g.rect(14, 26, 4, 4).fill(FLUID.juice);
  g.rect(2, 29, 28, 3).fill(FLUID.juice);
}

/**
 * The Syrup Mixer — §5's "one machine where the two layers visibly cooperate".
 *
 * So it is the one sprite that wears both vocabularies at once: TWO pipe collars stacked on
 * its west flank, a BELT CHUTE on its north edge, and a glass column between them with a
 * paddle turning in amber. A player who has learned that collars mean liquid and chutes mean
 * goods can read the mixer's entire job off its silhouette before clicking it — which is
 * exactly what a puzzle centrepiece has to do.
 */
function syrupMixer(g: Graphics): void {
  g.rect(4, 5, 24, 26).fill(BRASS.dark);
  g.rect(4, 5, 24, 3).fill(BRASS.mid);
  // The glass column and its amber level.
  g.rect(9, 9, 14, 19).fill(PALETTE.black);
  g.rect(10, 16, 12, 11).fill(FLUID.syrup);
  g.rect(10, 16, 12, 1).fill(BRASS.shine);
  // The paddle, mid-turn.
  g.rect(15, 10, 2, 14).fill(PALETTE.metalLight);
  g.rect(11, 21, 10, 2).fill(PALETTE.metalLight);
  // Two pipe collars on the west flank — the inlets, stacked, unmistakably a pair. Drawn in
  // the brightest brass in the ramp, because at 32px this pair IS the machine's identity and
  // a subtle version of it is the same as not drawing it.
  g.rect(0, 9, 6, 6).fill(BRASS.copper);
  g.rect(0, 10, 5, 4).fill(BRASS.shine);
  g.rect(0, 20, 6, 6).fill(BRASS.copper);
  g.rect(0, 21, 5, 4).fill(BRASS.shine);
  // One outlet collar east.
  g.rect(26, 15, 6, 6).fill(BRASS.copper);
  g.rect(27, 16, 5, 4).fill(BRASS.shine);
  // The belt chute on the north edge: goods come DOWN into a machine full of liquid.
  g.rect(11, 0, 10, 6).fill(PALETTE.metalDark);
  g.rect(13, 1, 6, 4).fill(PALETTE.metalLight);
  g.rect(14, 5, 4, 2).fill(PALETTE.black);
}

/**
 * Machines this renderer is ready for that the simulation has not shipped yet.
 *
 * The list is the coordination seam with the sim agent, written down rather than assumed:
 * these are the slugs and footprints the soda line is drawn at. When `MACHINE_SPECS` grows
 * an entry with one of these slugs, the real footprint wins and this entry stops being used
 * — so a disagreement about size costs nothing, and a disagreement about the NAME costs one
 * line here.
 *
 * §5 fixes the sizes: "machines mostly 2×2 (Bottler 3×2 flagship)".
 */
const PENDING_MACHINES: Readonly<Record<string, readonly [number, number]>> = {
  'cane-press': [2, 2],
  juicer: [2, 2],
  kettle: [2, 2],
  grinder: [2, 2],
  'syrup-mixer': [2, 2],
  carbonator: [2, 2],
  bottler: [3, 2],
  pump: [1, 1],
  tank: [2, 2],
};

/**
 * A machine nobody drew: a body, a topper, and a port band, all chosen by hashing the slug.
 *
 * Not a magenta box, and not one shared grey rectangle either. A new machine kind lands in
 * a build looking like SOMETHING, and — because the hash picks from four toppers and four
 * tones — looking different from the machine next to it. That is the difference between an
 * unfinished sprite and an unreadable factory.
 */
function genericMachine(slug: string): MachinePaint {
  let h = 2166136261;
  for (let i = 0; i < slug.length; i++) {
    h = Math.imul(h ^ slug.charCodeAt(i), 16777619) >>> 0;
  }
  const tones = [PALETTE.metal, BRASS.mid, PALETTE.metalDark, BRASS.dark];
  const body = tones[h % tones.length]!;
  const topper = (h >>> 4) % 4;

  return (g, w, hh) => {
    g.rect(1, 6, w - 2, hh - 7).fill(body);
    g.rect(1, 6, w - 2, 2).fill(PALETTE.metalLight);
    g.rect(1, hh - 4, w - 2, 3).fill(PALETTE.black);
    const cx = Math.round(w / 2);
    if (topper === 0) g.rect(cx - 3, 0, 6, 7).fill(PALETTE.metalDark);
    else if (topper === 1) g.circle(cx, 6, 5).fill(PALETTE.metalDark);
    else if (topper === 2) g.poly([cx - 6, 6, cx + 6, 6, cx + 2, 0, cx - 2, 0]).fill(BRASS.mid);
    else g.rect(2, 0, w - 4, 6).fill(PALETTE.metalDark);
  };
}

/**
 * Register a placeholder for every machine the sim ships AND every one it is about to.
 *
 * Sized from the sim's own footprint, so a 3×2 Bottler is drawn 48×32 without anybody
 * writing 48 anywhere. This is the function that makes "adding a machine kind is a data
 * change" true: the sim adds a spec, the renderer already knows the frame name, the size,
 * and — if the slug is in `MACHINE_LOOKS` — the picture.
 */
function registerMachinePlaceholders(): void {
  const register = (slug: string, tilesWide: number, tilesHigh: number): void => {
    const width = Math.max(1, tilesWide) * TILE_PX;
    const height = Math.max(1, tilesHigh) * TILE_PX;
    const paint = MACHINE_LOOKS[slug] ?? genericMachine(slug);
    PLACEHOLDERS[`machine_${frameSlug(slug)}`] = {
      width,
      height,
      paint: (g) => paint(g, width, height),
    };
  };

  for (const [slug, size] of Object.entries(PENDING_MACHINES)) {
    register(slug, size[0], size[1]);
  }
  // The sim's own specs go LAST so a real footprint always overwrites an assumed one.
  for (const spec of MACHINE_SPECS) {
    register(spec.slug, spec.tilesWide, spec.tilesHigh);
  }
}

/** Every machine frame that has a placeholder, for the art sheet. Sorted, so it is stable. */
export function placeholderMachineFrames(): string[] {
  const names = new Set<string>();
  for (const slug of Object.keys(PENDING_MACHINES)) names.add(`machine_${frameSlug(slug)}`);
  for (const spec of MACHINE_SPECS) names.add(`machine_${frameSlug(spec.slug)}`);
  return [...names].sort();
}

/** Growth stage sprites for every crop the sim ships, keyed off its own accent colours. */
function registerCropPlaceholders(): void {
  const accents: Record<number, { leaf: number; leafDark: number; fruit: number }> = {
    1: { leaf: PALETTE.leaf, leafDark: PALETTE.leafDark, fruit: PALETTE.potato },
    2: { leaf: 0x7bbf5a, leafDark: 0x4f8a38, fruit: 0xc6e07a },
    3: { leaf: 0x8ac24a, leafDark: 0x5d8f2c, fruit: 0xf2cf4a },
    4: { leaf: 0x63a83f, leafDark: 0x417a28, fruit: 0xd8402f },
    // The Gold Potato: the same plant as the Russet with a different thing under it, so the
    // leaves are a shade deeper and the produce is unmistakably gold. Without this row it fell
    // through to the Russet's colours and the premium crop looked exactly like the starter one
    // — which, in a field where both are planted, is the one comparison the sprite has to make.
    5: { leaf: 0x4f9a3a, leafDark: 0x357a26, fruit: 0xe8c04a },
  };

  for (const spec of CROP_SPECS) {
    const accent = accents[spec.id as number] ?? accents[1]!;
    const last = spec.stageCount - 1;
    for (let stage = 1; stage <= last; stage++) {
      // `t` runs 0..1 across the growing stages, so a crop with six stages gets a taller
      // plant per step rather than four hard-coded ones and two grey boxes.
      const t = last <= 1 ? 1 : (stage - 1) / (last - 1);
      const height = Math.round(4 + t * 11);
      const spread = Math.round(3 + t * 9);
      PLACEHOLDERS[ART.cropStage(spec.id as number, stage)] = {
        paint: (g) => {
          const top = TILE_PX - 1 - height;
          g.rect(7, top, 2, height).fill(accent.leafDark);
          g.rect(8 - Math.floor(spread / 2), top + 2, spread, 2).fill(accent.leaf);
          g.rect(8 - Math.floor(spread / 3), top, Math.max(2, spread - 3), 2).fill(accent.leaf);
          if (stage === last) {
            // The payoff: visible produce, so "ready" reads without looking at the HUD.
            g.rect(3, 12, 4, 3).fill(accent.fruit);
            g.rect(9, 12, 4, 3).fill(accent.fruit);
          }
        },
      };
    }
  }
}

/**
 * One 8×8 chip per item.
 *
 * Eight pixels because belt spacing is 64 subtiles — a quarter of a tile, four pixels at
 * 16px tiles. A 16px item sprite on a full belt would be four sprites deep in the same
 * four pixels; at 8px a packed belt reads as a dense line of goods, which is what it is.
 */
export const ITEM_CHIP_PX = 8;

type ItemShape = 'round' | 'bag' | 'flake' | 'stick' | 'seed' | 'bottle' | 'crate' | 'powder';

interface ItemLook {
  body: number;
  accent: number;
  shape: ItemShape;
}

/**
 * Item chips, keyed by the SIM'S OWN SLUG — same reasoning as the machine looks.
 *
 * The soda goods are listed here before `packages/sim` has them, so a bottle that appears on
 * a belt appears as a bottle rather than as a brown circle. A slug that never materialises
 * costs one dead entry; a slug that does costs no edit at all.
 */
const ITEM_LOOKS: Record<string, ItemLook> = {
  'potato-seed': { body: 0x8a6b3a, accent: 0x5c451f, shape: 'seed' },
  'russet-potato': { body: 0xc09456, accent: 0x8a6532, shape: 'round' },
  'bagged-chips': { body: 0xd2493f, accent: 0xf5d76a, shape: 'bag' },
  'washed-potato': { body: 0xdcb888, accent: 0xf3e0bd, shape: 'round' },
  'potato-slices': { body: 0xf0dfae, accent: 0xd6bd82, shape: 'flake' },
  'plain-chips': { body: 0xf2cf7a, accent: 0xd9a63a, shape: 'flake' },
  'seasoned-chips': { body: 0xe89a35, accent: 0xb96a1c, shape: 'flake' },
  'day-old-potato': { body: 0x8c8060, accent: 0x5e553f, shape: 'round' },
  compost: { body: 0x4a3a24, accent: 0x6f7a3a, shape: 'round' },
  'cane-seed': { body: 0x6f7a3a, accent: 0x4a5424, shape: 'seed' },
  'sugar-cane': { body: 0x8fc85c, accent: 0x5d8f2c, shape: 'stick' },
  'day-old-cane': { body: 0x8a9070, accent: 0x5f6449, shape: 'stick' },
  'corn-seed': { body: 0xd8c46a, accent: 0x9a8a3c, shape: 'seed' },
  corn: { body: 0xf2cf4a, accent: 0xb99a1c, shape: 'stick' },
  'day-old-corn': { body: 0xa79b6a, accent: 0x776d45, shape: 'stick' },
  'chili-seed': { body: 0x9c4a3a, accent: 0x6b2f22, shape: 'seed' },
  'chili-pepper': { body: 0xd8402f, accent: 0x8f2418, shape: 'stick' },
  'day-old-chili': { body: 0x93685f, accent: 0x64443c, shape: 'stick' },

  // --- the second farming era's goods ([[023]], [[030]], [[035]]) ----------------------
  //
  // The premium potato needs to be TELLABLE FROM THE RUSSET on a moving belt, which is eight
  // pixels of one colour — so it gets the brightest body in the item set and a pale highlight
  // rather than the Russet's darker outline. `guessItemLook` would have made both of them the
  // same brown circle, and a belt carrying two grades of potato would carry one.
  'gold-potato': { body: 0xe8c04a, accent: 0xfae7a2, shape: 'round' },
  'day-old-gold-potato': { body: 0xa89660, accent: 0x776a42, shape: 'round' },
  orange: { body: 0xe08a2c, accent: 0xf2a748, shape: 'round' },
  lemon: { body: 0xdcc63c, accent: 0xf2e06a, shape: 'round' },
  // Earth, not produce: a low dark mound, deliberately the drabbest chip on any belt.
  fertilizer: { body: 0x53412a, accent: 0x6f7a3a, shape: 'powder' },
  // Tools and containers are the two things here that are not food, and they say so by being
  // the only chips with a straight metal edge and a lid line respectively.
  'push-scythe': { body: 0xb9c0cc, accent: 0x8a5c28, shape: 'stick' },
  crate: { body: 0xb07a3c, accent: 0x8a5c28, shape: 'crate' },

  // --- the soda line's solids ---------------------------------------------------------
  //
  // §5: sweeteners are liquids, FLAVOURS ARE POWDERS. Powders ride belts, so they need a
  // chip that is unmistakably not a chip crisp — a low mound of grains rather than a flake.
  'kola-powder': { body: 0x5c3f28, accent: 0x855428, shape: 'powder' },
  'chili-powder': { body: 0x9e2f27, accent: 0xd94f36, shape: 'powder' },
  'seasoning-powder': { body: 0xb17f47, accent: 0xd9ab6e, shape: 'powder' },
  // Bottles start store-bought at a posted price (§4's consumable ladder). An empty bottle
  // is glass-pale; a full one is cola-dark, so a Bottler's in-tray and out-tray never read
  // as the same thing on the same belt.
  bottle: { body: 0x9fdcef, accent: 0xefe2c6, shape: 'bottle' },
  'empty-bottle': { body: 0x9fdcef, accent: 0xefe2c6, shape: 'bottle' },
  soda: { body: 0x9e2f27, accent: 0xef8f68, shape: 'bottle' },
  'soda-bottle': { body: 0x9e2f27, accent: 0xef8f68, shape: 'bottle' },
  'six-pack': { body: 0x9e2f27, accent: 0xf5d382, shape: 'crate' },
  'snack-combo': { body: 0xd94f36, accent: 0xf5d382, shape: 'crate' },
};

function itemChip(look: ItemLook): Paint {
  const { body, accent, shape } = look;
  return (g) => {
    switch (shape) {
      case 'bag':
        g.rect(1, 1, 6, 6).fill(body);
        g.rect(2, 2, 4, 1).fill(accent);
        break;
      case 'flake':
        g.rect(1, 2, 6, 3).fill(body);
        g.rect(0, 3, 8, 1).fill(accent);
        break;
      case 'stick':
        g.rect(3, 0, 2, 8).fill(body);
        g.rect(3, 2, 2, 1).fill(accent);
        break;
      case 'seed':
        g.rect(2, 3, 2, 2).fill(body);
        g.rect(4, 4, 2, 2).fill(accent);
        break;
      case 'bottle':
        // Neck, shoulder, body. Eight pixels is not much, but a two-pixel neck over a
        // four-pixel body is a bottle and nothing else in the item set is.
        g.rect(3, 0, 2, 2).fill(accent);
        g.rect(2, 2, 4, 6).fill(body);
        g.rect(2, 3, 4, 1).fill(accent);
        break;
      case 'crate':
        // A carrier: two rows of necks over a banded box. The bundle reads as several.
        g.rect(1, 0, 2, 2).fill(accent);
        g.rect(5, 0, 2, 2).fill(accent);
        g.rect(0, 2, 8, 6).fill(body);
        g.rect(0, 4, 8, 1).fill(accent);
        break;
      case 'powder':
        g.rect(1, 4, 6, 3).fill(body);
        g.rect(2, 3, 4, 1).fill(body);
        g.rect(2, 5, 1, 1).fill(accent);
        g.rect(5, 4, 1, 1).fill(accent);
        break;
      default:
        g.circle(4, 4, 3).fill(body);
        g.rect(2, 2, 2, 1).fill(accent);
    }
  };
}

/** Anything that ends in `-powder` is a powder, `-seed` a seed, and so on. */
function guessItemLook(slug: string): ItemLook {
  if (slug.endsWith('-powder')) return { body: 0x855428, accent: 0xb17f47, shape: 'powder' };
  if (slug.endsWith('-seed')) return { body: 0x8a6b3a, accent: 0x5c451f, shape: 'seed' };
  if (slug.includes('bottle') || slug.includes('soda')) {
    return { body: 0x9e2f27, accent: 0xef8f68, shape: 'bottle' };
  }
  if (slug.includes('pack') || slug.includes('combo')) {
    return { body: 0xd94f36, accent: 0xf5d382, shape: 'crate' };
  }
  return { body: 0xc09456, accent: 0x8a6532, shape: 'round' };
}

function registerItemPlaceholders(): void {
  for (const spec of ITEM_SPECS) {
    PLACEHOLDERS[ART.item(spec.id as number)] = {
      width: ITEM_CHIP_PX,
      height: ITEM_CHIP_PX,
      paint: itemChip(ITEM_LOOKS[spec.slug] ?? guessItemLook(spec.slug)),
    };
  }
}

/**
 * The seven lamp shapes as grey boxes — the same seven silhouettes `make-status-lamp.mjs`
 * bakes, drawn again here.
 *
 * A second copy of the drawing, deliberately, and for the reason `make-pipes.mjs` gives about
 * its own placeholder: "the shipped frame and the fallback frame are the same picture", so a
 * grey-box build is not quietly a less legible build. Colourblind-safe status is an
 * accessibility floor rather than a finish, and a floor that only exists once the art pipeline
 * has run is not a floor.
 *
 * WHITE core on ink, on purpose. The lamp is tinted at draw time, and a lamp baked green would
 * multiply every other state toward black — a bug that reads as "the amber lamp is broken"
 * rather than as "the sprite was the wrong colour".
 */
const LAMP_MASKS: Record<string, readonly string[]> = {
  [LAMP_FRAME[LampState.Off]]: ['.....', '.....', '..#..', '.....', '.....'],
  [LAMP_FRAME[LampState.Running]]: ['.###.', '#####', '#####', '#####', '.###.'],
  [LAMP_FRAME[LampState.Starved]]: ['..#..', '..#..', '.###.', '.###.', '#####'],
  [LAMP_FRAME[LampState.Blocked]]: ['.....', '.....', '#####', '#####', '.....'],
  [LAMP_FRAME[LampState.UtilityMissing]]: ['.###.', '#####', '.###.', '..#..', '..#..'],
  [LAMP_FRAME[LampState.Jammed]]: ['#...#', '.#.#.', '..#..', '.#.#.', '#...#'],
  [LAMP_FRAME[LampState.Halted]]: ['#####', '#...#', '#...#', '#...#', '#####'],
};

function registerLampPlaceholders(): void {
  for (const [name, rows] of Object.entries(LAMP_MASKS)) {
    PLACEHOLDERS[name] = {
      width: LAMP_PX,
      height: LAMP_PX,
      paint: (g) => {
        // The ink halo first, as one dilated pass, then the core over it. Same construction as
        // the generator's, so the negative space inside the saltire and the hollow box fills
        // with ink and the bright figure reads on any machine.
        const lit = (x: number, y: number): boolean =>
          y >= 0 && y < rows.length && x >= 0 && x < 5 && rows[y]![x] === '#';
        for (let y = 0; y < LAMP_PX; y++) {
          for (let x = 0; x < LAMP_PX; x++) {
            let touching = false;
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                if (lit(x - 1 + dx, y - 1 + dy)) touching = true;
              }
            }
            if (touching) g.rect(x, y, 1, 1).fill(PALETTE.black);
          }
        }
        for (let y = 0; y < LAMP_PX; y++) {
          for (let x = 0; x < LAMP_PX; x++) {
            if (lit(x - 1, y - 1)) g.rect(x, y, 1, 1).fill(PALETTE.white);
          }
        }
      },
    };
  }
}

registerCropPlaceholders();
registerItemPlaceholders();
registerMachinePlaceholders();
registerBotPlaceholders();
registerLampPlaceholders();

/**
 * "Spudnik": a squat two-legged robot, bottom-anchored like the farmer beside it.
 *
 * DRAWN TO THE SAME BRIEF THE REAL ART WAS GENERATED FROM, so the fallback and the shipped
 * frame are the same robot rather than two: a chunky grey box, one round glass eye on the
 * front, stubby arms, two thick legs that swap between the frames, a glowing eye in the
 * KIND'S colour (green harvester, blue planter), and the tool of its trade on its back — a
 * basket for the one that takes crops away, a funnel hopper for the one that brings seed.
 * That last detail is the only thing distinguishing the two at 16px, in the art and here.
 *
 * It is deliberately NOT a small farmer. The player is a bottom-heavy pawn with a head; this
 * is a wide box with no neck, so at full zoom-out the two silhouettes cannot be confused —
 * which matters most in the exact situation the feature is for, where the interesting question
 * is whether the thing moving in row four is you or not.
 *
 * `step` is 1 or 2 and swaps which leg is forward. One pixel of difference, which is all a
 * 16px walk cycle has ever been.
 */
function botChassis(
  facing: 'north' | 'south' | 'west',
  step: number,
  eye: number,
  pack: number,
): Paint {
  const lead = step === 1 ? 0 : 1;
  return (g) => {
    // Legs, feet at y = 15. The two frames differ only in which one is planted forward.
    g.rect(4, 12, 3, 4 - lead).fill(PALETTE.metalDark);
    g.rect(9, 12 + lead, 3, 4 - lead).fill(PALETTE.metalDark);

    // What it carries on its back, drawn FIRST so the body overlaps it — a pack is behind the
    // robot from the front, and peeks over the shoulders.
    if (facing === 'south') {
      g.rect(2, 4, 12, 3).fill(pack);
    } else {
      // From the side and from behind, the pack is the whole rear silhouette.
      g.rect(1, 5, 4, 6).fill(pack);
    }

    // Body.
    g.rect(3, 5, 10, 7).fill(PALETTE.metal);
    g.rect(3, 5, 10, 2).fill(PALETTE.metalLight);
    g.rect(3, 11, 10, 1).fill(PALETTE.metalDark);
    // Stubby arms.
    g.rect(2, 7, 1, 4).fill(PALETTE.metalDark);
    g.rect(13, 7, 1, 4).fill(PALETTE.metalDark);

    // Head, and the eye that says which robot this is.
    g.rect(5, 1, 6, 4).fill(PALETTE.metalDark);
    g.rect(5, 1, 6, 1).fill(PALETTE.metal);
    if (facing === 'south') {
      g.circle(8, 3, 2).fill(PALETTE.black);
      g.circle(8, 3, 1).fill(eye);
    } else if (facing === 'west') {
      g.circle(6, 3, 2).fill(PALETTE.black);
      g.circle(6, 3, 1).fill(eye);
    } else {
      // The back of the head: a vented plate and no eye at all, so a bot walking away is
      // unmistakably walking away. (The atlas has no `up` pose and substitutes the side view
      // — see `STRIPS`. This is the more informative of the two, which is the wrong way round.)
      g.rect(6, 2, 4, 2).fill(PALETTE.metalDark);
      g.rect(6, 3, 4, 1).fill(PALETTE.black);
    }
  };
}

/** The two chassis, in the two colours their docks and their eyes wear. */
function registerBotPlaceholders(): void {
  const looks: Readonly<Record<string, { eye: number; pack: number }>> = {
    harvester: { eye: 0x7ed68e, pack: 0xb07a3c },
    planter: { eye: 0x6fc0e8, pack: 0x6f7a3a },
  };
  for (const kind of BOT_KINDS) {
    const look = looks[kind]!;
    for (let step = 1; step <= BOT_STEPS; step++) {
      for (const facing of ['north', 'south', 'west'] as const) {
        PLACEHOLDERS[ART.bot(kind, facing, step)] = {
          paint: botChassis(facing, step, look.eye, look.pack),
        };
      }
    }
  }
}

/**
 * The pawn mid-stride, for the no-atlas walk cells: the same farmer as `pawn` below, with
 * the trouser block split into two legs that swap which one is planted — one pixel of
 * difference per step, which is all a 16px walk cycle has ever been (see `botChassis`).
 */
function pawnWalk(facing: 'north' | 'south' | 'east', step: number): Paint {
  const lead = step === 1 ? 0 : 1;
  return (g) => {
    // Legs, feet at y = 15, alternating exactly as the bots' do.
    g.rect(5, 10, 3, 5 - lead).fill(PALETTE.trouser);
    g.rect(8, 10 + lead, 3, 5 - lead).fill(PALETTE.trouser);
    g.rect(4, 5, 8, 6).fill(PALETTE.shirt);
    g.rect(5, 1, 6, 5).fill(facing === 'north' ? PALETTE.hair : PALETTE.skin);
    g.rect(5, 0, 6, 2).fill(PALETTE.hair);
    if (facing === 'south') {
      g.rect(6, 3, 1, 1).fill(PALETTE.black);
      g.rect(9, 3, 1, 1).fill(PALETTE.black);
    } else if (facing === 'east') {
      g.rect(9, 3, 1, 1).fill(PALETTE.black);
      g.rect(11, 6, 2, 4).fill(PALETTE.skin);
    }
  };
}

function pawn(facing: 'north' | 'east' | 'south' | 'west'): Paint {
  return (g) => {
    // Bottom-anchored: feet at y = 15, so the sprite plants on the tile it stands on.
    g.rect(5, 10, 6, 5).fill(PALETTE.trouser);
    g.rect(4, 5, 8, 6).fill(PALETTE.shirt);
    g.rect(5, 1, 6, 5).fill(facing === 'north' ? PALETTE.hair : PALETTE.skin);
    g.rect(5, 0, 6, 2).fill(PALETTE.hair);
    if (facing === 'south') {
      g.rect(6, 3, 1, 1).fill(PALETTE.black);
      g.rect(9, 3, 1, 1).fill(PALETTE.black);
    } else if (facing === 'east') {
      g.rect(9, 3, 1, 1).fill(PALETTE.black);
      g.rect(11, 6, 2, 4).fill(PALETTE.skin);
    } else if (facing === 'west') {
      g.rect(6, 3, 1, 1).fill(PALETTE.black);
      g.rect(3, 6, 2, 4).fill(PALETTE.skin);
    }
  };
}
