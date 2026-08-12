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

export const ATLAS_SIZE = { width: 512, height: 256 } as const;

export const ATLAS_FRAMES = {
  belt_corner: {
    x: 0,
    y: 0,
    width: 16,
    height: 16,
    anchor: 'top-left',
    group: 'belts',
  },
  belt_straight: {
    x: 17,
    y: 0,
    width: 16,
    height: 16,
    anchor: 'top-left',
    group: 'belts',
  },
  crop_cane_strip: {
    x: 0,
    y: 17,
    width: 64,
    height: 16,
    anchor: 'top-left',
    group: 'crops',
  },
  crop_chili_strip: {
    x: 65,
    y: 17,
    width: 64,
    height: 16,
    anchor: 'top-left',
    group: 'crops',
  },
  crop_corn_strip: {
    x: 130,
    y: 17,
    width: 64,
    height: 16,
    anchor: 'top-left',
    group: 'crops',
  },
  crop_potato_strip: {
    x: 195,
    y: 17,
    width: 64,
    height: 16,
    anchor: 'top-left',
    group: 'crops',
  },
  grabber_arm: {
    x: 34,
    y: 0,
    width: 16,
    height: 16,
    anchor: 'center',
    group: 'belts',
  },
  item_chip_bag: {
    x: 0,
    y: 34,
    width: 16,
    height: 16,
    anchor: 'center',
    group: 'items',
  },
  item_plain_chips: {
    x: 17,
    y: 34,
    width: 16,
    height: 16,
    anchor: 'center',
    group: 'items',
  },
  item_potato: {
    x: 34,
    y: 34,
    width: 16,
    height: 16,
    anchor: 'center',
    group: 'items',
  },
  item_potato_slices: {
    x: 51,
    y: 34,
    width: 16,
    height: 16,
    anchor: 'center',
    group: 'items',
  },
  item_seasoned_chips: {
    x: 68,
    y: 34,
    width: 16,
    height: 16,
    anchor: 'center',
    group: 'items',
  },
  item_washed_potato: {
    x: 85,
    y: 34,
    width: 16,
    height: 16,
    anchor: 'center',
    group: 'items',
  },
  machine_bagger: {
    x: 0,
    y: 51,
    width: 32,
    height: 32,
    anchor: 'bottom-center',
    group: 'machines',
  },
  machine_chip_kitchen: {
    x: 33,
    y: 51,
    width: 32,
    height: 32,
    anchor: 'bottom-center',
    group: 'machines',
  },
  machine_fryer: {
    x: 66,
    y: 51,
    width: 32,
    height: 32,
    anchor: 'bottom-center',
    group: 'machines',
  },
  machine_seasoner: {
    x: 99,
    y: 51,
    width: 32,
    height: 32,
    anchor: 'bottom-center',
    group: 'machines',
  },
  machine_slicer: {
    x: 132,
    y: 51,
    width: 32,
    height: 32,
    anchor: 'bottom-center',
    group: 'machines',
  },
  machine_sprinkler: {
    x: 198,
    y: 51,
    width: 16,
    height: 16,
    anchor: 'bottom-center',
    group: 'machines',
  },
  machine_washer: {
    x: 165,
    y: 51,
    width: 32,
    height: 32,
    anchor: 'bottom-center',
    group: 'machines',
  },
  player_walk_down: {
    x: 0,
    y: 101,
    width: 32,
    height: 16,
    anchor: 'top-left',
    group: 'player',
  },
  player_walk_side: {
    x: 33,
    y: 101,
    width: 32,
    height: 16,
    anchor: 'top-left',
    group: 'player',
  },
  status_lamp: {
    x: 0,
    y: 118,
    width: 4,
    height: 4,
    anchor: 'center',
    group: 'status',
  },
  terrain_grass: {
    x: 0,
    y: 123,
    width: 16,
    height: 16,
    anchor: 'top-left',
    group: 'terrain',
  },
  terrain_soil: {
    x: 17,
    y: 123,
    width: 16,
    height: 16,
    anchor: 'top-left',
    group: 'terrain',
  },
  terrain_soil_tilled: {
    x: 34,
    y: 123,
    width: 16,
    height: 16,
    anchor: 'top-left',
    group: 'terrain',
  },
  zone_overlay: {
    x: 0,
    y: 84,
    width: 16,
    height: 16,
    anchor: 'top-left',
    group: 'overlay',
  },
} as const satisfies Record<string, AtlasFrame>;

export type AssetId = keyof typeof ATLAS_FRAMES;

export const ASSET_IDS = Object.keys(ATLAS_FRAMES) as AssetId[];
