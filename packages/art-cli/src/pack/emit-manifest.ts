import type { Anchor } from '../manifest.js';
import type { AtlasLayout } from './atlas.js';

export interface FrameMeta {
  anchor: Anchor;
  sourceWidth: number;
  sourceHeight: number;
}

/**
 * TexturePacker-style hash format, which PixiJS 8 loads directly via `Assets.load`.
 * `meta.scale` is a string because Pixi's parser expects one.
 */
export function buildAtlasJson(
  layout: AtlasLayout,
  meta: Map<string, FrameMeta>,
  imageName: string,
): string {
  const frames: Record<string, unknown> = {};
  for (const frame of layout.frames) {
    const info = meta.get(frame.id);
    frames[frame.id] = {
      frame: { x: frame.x, y: frame.y, w: frame.width, h: frame.height },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: frame.width, h: frame.height },
      sourceSize: { w: frame.width, h: frame.height },
      anchorMode: info?.anchor ?? 'center',
      group: frame.group,
    };
  }

  return `${JSON.stringify(
    {
      frames,
      meta: {
        app: '@snack/art-cli',
        image: imageName,
        format: 'RGBA8888',
        size: { w: layout.width, h: layout.height },
        scale: '1',
        groups: layout.groups.map(({ group, x, y, width, height, count }) => ({
          group,
          x,
          y,
          width,
          height,
          count,
        })),
      },
    },
    null,
    2,
  )}\n`;
}

const HEADER = `// GENERATED FILE — do not edit by hand.
// Written by \`yarn art pack\` (@snack/art-cli) from art/manifest.json.
// Every frame below lives on a single atlas page; see plan §13 for why that is a
// build-time contract rather than an optimisation.
`;

/** The typed manifest the game imports — the contract between this pipeline and the renderer. */
export function buildTypedManifest(layout: AtlasLayout, meta: Map<string, FrameMeta>): string {
  const entries = layout.frames
    .map((frame) => {
      const info = meta.get(frame.id);
      return (
        `  ${JSON.stringify(frame.id)}: {\n` +
        `    x: ${frame.x},\n` +
        `    y: ${frame.y},\n` +
        `    width: ${frame.width},\n` +
        `    height: ${frame.height},\n` +
        `    anchor: ${JSON.stringify(info?.anchor ?? 'center')},\n` +
        `    group: ${JSON.stringify(frame.group)},\n` +
        `  },`
      );
    })
    .join('\n');

  return `${HEADER}
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

export const ATLAS_SIZE = { width: ${layout.width}, height: ${layout.height} } as const;

export const ATLAS_FRAMES = {
${entries}
} as const satisfies Record<string, AtlasFrame>;

export type AssetId = keyof typeof ATLAS_FRAMES;

export const ASSET_IDS = Object.keys(ATLAS_FRAMES) as AssetId[];
`;
}
