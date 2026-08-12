// The art set: atlas frames where they exist, generated grey-box placeholders where they
// do not.
//
// `./pixel` FIRST — it sets `scaleMode = 'nearest'` at module scope and this module is the
// one that causes textures to exist. See the comment block there.
import { TILE_PX } from './pixel';

import { Assets, Graphics, Rectangle, Texture } from 'pixi.js';
import type { Renderer, Spritesheet } from 'pixi.js';

import { ATLAS_FRAMES, ATLAS_JSON_URL } from '@/art/manifest.generated';

/**
 * The frame names the renderer asks for. Art slots in by NAME: when the pipeline emits a
 * frame with one of these ids, it replaces the placeholder with no code change here.
 *
 * Keeping this as one table is also the single-atlas contract of §13 in practice — every
 * name is resolved from the one loaded spritesheet, never from an ad-hoc texture load.
 */
export const ART = {
  groundGrassA: 'ground_grass_a',
  groundGrassB: 'ground_grass_b',
  groundGrassC: 'ground_grass_c',
  groundLot: 'ground_lot',
  groundField: 'ground_field',
  soilWet: 'soil_wet',
  cropStage: (stage: number) => `crop_russet_potato_${stage}`,
  machineSellBin: 'machine_sell_bin',
  machineChipKitchen: 'machine_chip_kitchen',
  machineSprinkler: 'machine_sprinkler',
  playerNorth: 'player_north',
  playerEast: 'player_east',
  playerSouth: 'player_south',
  playerWest: 'player_west',
  lampRunning: 'lamp_running',
  lampStarved: 'lamp_starved',
  lampBlocked: 'lamp_blocked',
  lampUtility: 'lamp_utility',
  lampJammed: 'lamp_jammed',
  lampHalted: 'lamp_halted',
  uiHover: 'ui_hover',
  uiWrench: 'ui_wrench',
  uiDroplet: 'ui_droplet',
  uiReady: 'ui_ready',
} as const;

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

  const art: ArtSet = {
    get(name: string): Texture {
      if (sheet !== null && atlasNames.has(name)) {
        const found = sheet.textures[name];
        if (found !== undefined) return found;
      }
      const cached = generated.get(name);
      if (cached !== undefined) return cached;
      const made = placeholder(name);
      generated.set(name, made);
      placeholderCount += 1;
      return made;
    },
    isReal(name: string): boolean {
      return sheet !== null && atlasNames.has(name) && sheet.textures[name] !== undefined;
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

  [ART.cropStage(1)]: {
    paint: (g) => {
      g.rect(7, 11, 2, 4).fill(PALETTE.leafDark);
      g.rect(6, 10, 4, 1).fill(PALETTE.leaf);
    },
  },
  [ART.cropStage(2)]: {
    paint: (g) => {
      g.rect(7, 8, 2, 7).fill(PALETTE.leafDark);
      g.rect(4, 8, 8, 2).fill(PALETTE.leaf);
      g.rect(5, 6, 6, 2).fill(PALETTE.leaf);
    },
  },
  [ART.cropStage(3)]: {
    paint: (g) => {
      g.rect(7, 5, 2, 10).fill(PALETTE.leafDark);
      g.rect(3, 7, 10, 2).fill(PALETTE.leaf);
      g.rect(4, 4, 8, 3).fill(PALETTE.leaf);
      g.rect(5, 2, 6, 2).fill(PALETTE.leafDark);
    },
  },
  [ART.cropStage(4)]: {
    paint: (g) => {
      g.rect(7, 4, 2, 11).fill(PALETTE.leafDark);
      g.rect(2, 6, 12, 3).fill(PALETTE.leaf);
      g.rect(3, 3, 10, 3).fill(PALETTE.leaf);
      g.rect(4, 1, 8, 2).fill(PALETTE.leafDark);
      // The payoff: visible potatoes at the base, so "ready" reads without a HUD.
      g.rect(3, 12, 4, 3).fill(PALETTE.potato);
      g.rect(9, 12, 4, 3).fill(PALETTE.potato);
    },
  },

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

  [ART.playerSouth]: { paint: pawn('south') },
  [ART.playerNorth]: { paint: pawn('north') },
  [ART.playerEast]: { paint: pawn('east') },
  [ART.playerWest]: { paint: pawn('west') },

  [ART.lampRunning]: { paint: lamp(0x4bd25f), width: 4, height: 4 },
  [ART.lampStarved]: { paint: lamp(0xe8b53d), width: 4, height: 4 },
  [ART.lampBlocked]: { paint: lamp(0xe8503d), width: 4, height: 4 },
  [ART.lampUtility]: { paint: lamp(0x4bb6e8), width: 4, height: 4 },
  [ART.lampJammed]: { paint: lamp(0xe8503d), width: 4, height: 4 },
  [ART.lampHalted]: { paint: lamp(0x6b6b6b), width: 4, height: 4 },

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

function lamp(colour: number): Paint {
  return (g) => {
    g.rect(0, 0, 4, 4).fill(PALETTE.black);
    g.rect(1, 1, 2, 2).fill(colour);
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
