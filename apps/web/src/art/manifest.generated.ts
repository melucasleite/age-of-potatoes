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

export const ATLAS_SIZE = { width: 16, height: 64 } as const;

export const ATLAS_FRAMES = {
  "placeholder_item_potato": {
    x: 0,
    y: 0,
    width: 16,
    height: 16,
    anchor: "center",
    group: "items",
  },
  "placeholder_local_crate": {
    x: 0,
    y: 17,
    width: 16,
    height: 16,
    anchor: "bottom-center",
    group: "world",
  },
} as const satisfies Record<string, AtlasFrame>;

export type AssetId = keyof typeof ATLAS_FRAMES;

export const ASSET_IDS = Object.keys(ATLAS_FRAMES) as AssetId[];
