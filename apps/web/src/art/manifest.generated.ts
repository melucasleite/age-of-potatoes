// GENERATED FILE — do not edit by hand.
// Written by `yarn art pack` (@snack/art-cli) from art/manifest.json.
// Every frame below lives on a single atlas page; see plan §13 for why that is a
// build-time contract rather than an optimisation.

export type AtlasAnchor = 'bottom-center' | 'center' | 'top-left';

export interface AtlasFrame {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly anchor: AtlasAnchor;
  readonly group: string;
}

export const ATLAS_IMAGE_URL = '/art/atlas.png';
export const ATLAS_JSON_URL = '/art/atlas.json';

export const ATLAS_SIZE = { width: 128, height: 128 } as const;

export const ATLAS_FRAMES = {
  crop_potato_strip: {
    x: 0,
    y: 0,
    width: 64,
    height: 16,
    anchor: 'top-left',
    group: 'crops',
  },
  item_chip_bag: {
    x: 0,
    y: 17,
    width: 16,
    height: 16,
    anchor: 'center',
    group: 'items',
  },
  item_potato: {
    x: 17,
    y: 17,
    width: 16,
    height: 16,
    anchor: 'center',
    group: 'items',
  },
  machine_chip_kitchen: {
    x: 0,
    y: 34,
    width: 32,
    height: 32,
    anchor: 'bottom-center',
    group: 'machines',
  },
  machine_sprinkler: {
    x: 33,
    y: 34,
    width: 16,
    height: 16,
    anchor: 'bottom-center',
    group: 'machines',
  },
  player_walk_down: {
    x: 0,
    y: 67,
    width: 32,
    height: 16,
    anchor: 'top-left',
    group: 'player',
  },
  player_walk_side: {
    x: 33,
    y: 67,
    width: 32,
    height: 16,
    anchor: 'top-left',
    group: 'player',
  },
  status_lamp: {
    x: 0,
    y: 84,
    width: 4,
    height: 4,
    anchor: 'center',
    group: 'status',
  },
  terrain_grass: {
    x: 0,
    y: 89,
    width: 16,
    height: 16,
    anchor: 'top-left',
    group: 'terrain',
  },
  terrain_soil: {
    x: 17,
    y: 89,
    width: 16,
    height: 16,
    anchor: 'top-left',
    group: 'terrain',
  },
  terrain_soil_tilled: {
    x: 34,
    y: 89,
    width: 16,
    height: 16,
    anchor: 'top-left',
    group: 'terrain',
  },
} as const satisfies Record<string, AtlasFrame>;

export type AssetId = keyof typeof ATLAS_FRAMES;

export const ASSET_IDS = Object.keys(ATLAS_FRAMES) as AssetId[];
