// The art set: atlas frames where they exist, generated grey-box placeholders where they
// do not.
//
// `./pixel` FIRST — it sets `scaleMode = 'nearest'` at module scope and this module is the
// one that causes textures to exist. See the comment block there.
import { TILE_PX } from './pixel';

import { Assets, Graphics, Rectangle, Texture } from 'pixi.js';
import type { Renderer, Spritesheet } from 'pixi.js';

import { BeltTier, CROP_SPECS, ITEM_SPECS, MACHINE_SPECS } from '@snack/sim';

import { ATLAS_FRAMES, ATLAS_JSON_URL } from '@/art/manifest.generated';

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
  grabberBase: 'grabber_base',
  grabberHand: 'grabber_hand',
  playerNorth: 'player_north',
  playerEast: 'player_east',
  playerSouth: 'player_south',
  playerWest: 'player_west',
  /**
   * ONE lamp sprite, tinted in code (§13, and [[012]]'s "30 machines' worth of state
   * animation for the cost of one sprite"). There is deliberately no `lamp_running` frame:
   * a sprite per state is six chances for the art to disagree with itself about what amber
   * means, and it would put the lamps on their own atlas page for no gain.
   */
  lamp: 'status_lamp',
  uiHover: 'ui_hover',
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
 */
const STRIPS: Record<string, { source: string; cells: number }> = {};
for (const spec of CROP_SPECS) {
  // The pipeline names potato's strip `crop_potato_strip`, not `crop_russet_potato_strip`:
  // the last word of the slug is the one the art vocabulary uses.
  const parts = frameSlug(spec.slug).split('_');
  const short = parts[parts.length - 1]!;
  for (let stage = 1; stage < spec.stageCount; stage++) {
    STRIPS[ART.cropStage(spec.id as number, stage)] = {
      source: `crop_${short}_strip`,
      cells: spec.stageCount - 1,
    };
  }
}

export interface ArtSet {
  /** The texture for a frame name, or a magenta "missing" square. Never throws. */
  get(name: string): Texture;
  /** True when the frame came from the real atlas rather than a placeholder. */
  isReal(name: string): boolean;
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

  function fromStrip(name: string): Texture | null {
    const cached = sliced.get(name);
    if (cached !== undefined) return cached;

    const strip = STRIPS[name];
    if (strip === undefined || sheet === null || !atlasNames.has(strip.source)) return null;
    const base = sheet.textures[strip.source];
    if (base === undefined) return null;

    // `crop_corn_3` → cell 2. The stage number is the frame name's own suffix, so a crop
    // that grows a fifth stage needs no table anywhere.
    const suffix = Number(name.slice(name.lastIndexOf('_') + 1));
    if (!Number.isFinite(suffix) || suffix < 1) return null;
    const index = Math.min(strip.cells - 1, suffix - 1);

    const cellWidth = Math.floor(base.frame.width / strip.cells);
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

  [ART.machineSellBin]: {
    paint: (g) => {
      g.rect(1, 5, 14, 10).fill(PALETTE.wood);
      g.rect(1, 5, 14, 2).fill(PALETTE.woodDark);
      g.rect(0, 3, 16, 2).fill(PALETTE.shirt);
      g.rect(4, 9, 8, 4).fill(PALETTE.black);
    },
  },

  [ART.machineChipKitchen]: {
    width: TILE_PX * 2,
    height: TILE_PX * 2,
    paint: (g) => {
      g.rect(1, 6, 30, 25).fill(PALETTE.metal);
      g.rect(1, 6, 30, 3).fill(PALETTE.metalDark);
      g.rect(4, 12, 12, 12).fill(PALETTE.black);
      g.rect(6, 14, 8, 8).fill(0xe8a33d);
      g.rect(20, 12, 8, 14).fill(PALETTE.metalDark);
      g.rect(21, 14, 6, 4).fill(PALETTE.potato);
      // Chimney, so a 2×2 blob reads as a cooker from across the lot.
      g.rect(22, 0, 6, 7).fill(PALETTE.metalDark);
    },
  },

  [ART.machineSprinkler]: {
    paint: (g) => {
      g.rect(6, 8, 4, 7).fill(PALETTE.metalDark);
      g.rect(3, 13, 10, 2).fill(PALETTE.metal);
      g.rect(4, 3, 8, 5).fill(PALETTE.water);
      g.rect(5, 1, 6, 2).fill(PALETTE.metal);
    },
  },

  // --- the chip line ---------------------------------------------------------------
  //
  // Five 2×2 boxes in a row is exactly the situation §15 warns about: AI-generated
  // machines are hardest to tell apart, and a line the player cannot read is a line they
  // cannot debug. So each grey box gets ONE loud, unshared silhouette cue — a drum, a
  // blade, a chimney, a shaker cone, a bag chute — chosen so the machines differ at 32px
  // by SHAPE and not only by colour. That survives both a colourblind player and a
  // half-second glance across the yard.

  [ART.machine(4)]: {
    // Washer: a horizontal drum with a porthole, standing in a puddle.
    width: TILE_PX * 2,
    height: TILE_PX * 2,
    paint: (g) => {
      g.rect(2, 8, 28, 20).fill(PALETTE.metal);
      g.rect(2, 8, 28, 3).fill(PALETTE.metalDark);
      g.circle(16, 18, 8).fill(PALETTE.metalDark);
      g.circle(16, 18, 6).fill(PALETTE.water);
      g.circle(13, 15, 2).fill(0xbfe8f7);
      g.rect(2, 28, 28, 3).fill(0x3f7f9c);
    },
  },

  [ART.machine(5)]: {
    // Slicer: a blade wheel on a low bench. Teeth on the rim, so it reads as "cuts".
    width: TILE_PX * 2,
    height: TILE_PX * 2,
    paint: (g) => {
      g.rect(2, 16, 28, 14).fill(PALETTE.metalDark);
      g.rect(2, 16, 28, 2).fill(PALETTE.metal);
      g.circle(16, 14, 10).fill(0xd9dee6);
      g.circle(16, 14, 7).fill(PALETTE.metalDark);
      for (let i = 0; i < 8; i++) {
        const x = 6 + i * 3;
        g.rect(x, 3, 2, 3).fill(0xd9dee6);
      }
      g.rect(4, 24, 6, 3).fill(0xefe6cf);
      g.rect(12, 24, 6, 3).fill(0xefe6cf);
    },
  },

  [ART.machine(6)]: {
    // Fryer: the half-speed one, and the machine the player is meant to want a second of.
    // Loudest silhouette in the line — a tall chimney and a hot orange vat.
    width: TILE_PX * 2,
    height: TILE_PX * 2,
    paint: (g) => {
      g.rect(20, 0, 8, 12).fill(PALETTE.metalDark);
      g.rect(22, 0, 4, 3).fill(0x54606e);
      g.rect(1, 10, 30, 21).fill(PALETTE.metal);
      g.rect(1, 10, 30, 3).fill(PALETTE.metalDark);
      g.rect(4, 16, 16, 12).fill(PALETTE.black);
      g.rect(5, 18, 14, 9).fill(0xe8912d);
      g.rect(7, 20, 3, 2).fill(0xffd27a);
      g.rect(13, 22, 3, 2).fill(0xffd27a);
    },
  },

  [ART.machine(7)]: {
    // Seasoner: an inverted cone hopper dusting paprika. Only cone in the line.
    width: TILE_PX * 2,
    height: TILE_PX * 2,
    paint: (g) => {
      g.rect(2, 18, 28, 13).fill(PALETTE.metal);
      g.rect(2, 18, 28, 3).fill(PALETTE.metalDark);
      g.poly([8, 2, 24, 2, 18, 17, 14, 17]).fill(0xc2452f);
      g.poly([9, 3, 23, 3, 20, 10, 12, 10]).fill(0xe0674a);
      g.rect(14, 17, 4, 4).fill(PALETTE.metalDark);
      g.rect(11, 24, 10, 4).fill(0xe8a33d);
    },
  },

  [ART.machine(8)]: {
    // Bagger: a chute over a stack of finished bags. The only machine with a bag on it.
    width: TILE_PX * 2,
    height: TILE_PX * 2,
    paint: (g) => {
      g.rect(2, 6, 28, 18).fill(PALETTE.metal);
      g.rect(2, 6, 28, 3).fill(PALETTE.metalDark);
      g.poly([10, 9, 22, 9, 19, 20, 13, 20]).fill(PALETTE.metalDark);
      g.rect(4, 24, 10, 7).fill(PALETTE.shirt);
      g.rect(5, 25, 8, 2).fill(0xf07a6e);
      g.rect(17, 26, 10, 5).fill(PALETTE.shirt);
      g.rect(18, 27, 8, 1).fill(0xf07a6e);
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

  [ART.playerSouth]: { paint: pawn('south') },
  [ART.playerNorth]: { paint: pawn('north') },
  [ART.playerEast]: { paint: pawn('east') },
  [ART.playerWest]: { paint: pawn('west') },

  // WHITE, on purpose. The lamp is tinted at draw time, and a lamp baked green would
  // multiply every other state toward black — a bug that reads as "the amber lamp is
  // broken" rather than as "the sprite was the wrong colour".
  [ART.lamp]: {
    width: 4,
    height: 4,
    paint: (g) => {
      g.rect(0, 0, 4, 4).fill(PALETTE.black);
      g.rect(1, 1, 2, 2).fill(PALETTE.white);
    },
  },

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

/** Growth stage sprites for every crop the sim ships, keyed off its own accent colours. */
function registerCropPlaceholders(): void {
  const accents: Record<number, { leaf: number; leafDark: number; fruit: number }> = {
    1: { leaf: PALETTE.leaf, leafDark: PALETTE.leafDark, fruit: PALETTE.potato },
    2: { leaf: 0x7bbf5a, leafDark: 0x4f8a38, fruit: 0xc6e07a },
    3: { leaf: 0x8ac24a, leafDark: 0x5d8f2c, fruit: 0xf2cf4a },
    4: { leaf: 0x63a83f, leafDark: 0x417a28, fruit: 0xd8402f },
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

type ItemShape = 'round' | 'bag' | 'flake' | 'stick' | 'seed';

const ITEM_LOOK: Record<number, { body: number; accent: number; shape: ItemShape }> = {
  1: { body: 0x8a6b3a, accent: 0x5c451f, shape: 'seed' }, // potato seed
  2: { body: 0xc09456, accent: 0x8a6532, shape: 'round' }, // russet potato
  3: { body: 0xd2493f, accent: 0xf5d76a, shape: 'bag' }, // bagged chips
  4: { body: 0xdcb888, accent: 0xf3e0bd, shape: 'round' }, // washed potato
  5: { body: 0xf0dfae, accent: 0xd6bd82, shape: 'flake' }, // slices
  6: { body: 0xf2cf7a, accent: 0xd9a63a, shape: 'flake' }, // plain chips
  7: { body: 0xe89a35, accent: 0xb96a1c, shape: 'flake' }, // seasoned chips
  8: { body: 0x8c8060, accent: 0x5e553f, shape: 'round' }, // day-old potato
  9: { body: 0x4a3a24, accent: 0x6f7a3a, shape: 'round' }, // compost
  10: { body: 0x6f7a3a, accent: 0x4a5424, shape: 'seed' }, // cane seed
  11: { body: 0x8fc85c, accent: 0x5d8f2c, shape: 'stick' }, // sugar cane
  12: { body: 0x8a9070, accent: 0x5f6449, shape: 'stick' }, // day-old cane
  13: { body: 0xd8c46a, accent: 0x9a8a3c, shape: 'seed' }, // corn seed
  14: { body: 0xf2cf4a, accent: 0xb99a1c, shape: 'stick' }, // corn
  15: { body: 0xa79b6a, accent: 0x776d45, shape: 'stick' }, // day-old corn
  16: { body: 0x9c4a3a, accent: 0x6b2f22, shape: 'seed' }, // chili seed
  17: { body: 0xd8402f, accent: 0x8f2418, shape: 'stick' }, // chili
  18: { body: 0x93685f, accent: 0x64443c, shape: 'stick' }, // day-old chili
};

function itemChip(body: number, accent: number, shape: ItemShape): Paint {
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
      default:
        g.circle(4, 4, 3).fill(body);
        g.rect(2, 2, 2, 1).fill(accent);
    }
  };
}

function registerItemPlaceholders(): void {
  for (const spec of ITEM_SPECS) {
    const look = ITEM_LOOK[spec.id as number] ?? {
      body: 0xc09456,
      accent: 0x8a6532,
      shape: 'round' as const,
    };
    PLACEHOLDERS[ART.item(spec.id as number)] = {
      width: ITEM_CHIP_PX,
      height: ITEM_CHIP_PX,
      paint: itemChip(look.body, look.accent, look.shape),
    };
  }
}

registerCropPlaceholders();
registerItemPlaceholders();

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
