import { createHash } from 'node:crypto';
import type { Anchor } from '../manifest.js';
import type { AtlasLayout } from './atlas.js';

export interface FrameMeta {
  anchor: Anchor;
  sourceWidth: number;
  sourceHeight: number;
}

/** The two filenames a pack emits into `apps/web/public/art/`, both carrying the same hash. */
export interface AtlasNames {
  image: string;
  json: string;
}

/**
 * Stand-in image name used *only* while hashing. The emitted JSON names the hashed PNG, but
 * the hash cannot depend on its own value — so the bytes we digest reference this fixed name
 * instead. Content in, name out; never the other way round.
 */
const HASH_PLACEHOLDER_IMAGE = 'atlas.png';

/** How many hex chars of the digest end up in the filename. 8 is ~4 billion; collisions here
 * would need two different atlases in the same directory, which never outlives one pack. */
const HASH_LENGTH = 8;

/**
 * Content address for a packed atlas: the PNG bytes plus the layout/metadata JSON that
 * describes them. Stable across runs when nothing changed, different when anything did —
 * which is the whole point, since the filename is what busts the browser cache.
 */
export function atlasContentHash(
  image: Buffer,
  layout: AtlasLayout,
  meta: Map<string, FrameMeta>,
): string {
  return createHash('sha256')
    .update(image)
    .update(buildAtlasJson(layout, meta, HASH_PLACEHOLDER_IMAGE))
    .digest('hex')
    .slice(0, HASH_LENGTH);
}

/** `atlas.a3f91c2b.png` / `atlas.a3f91c2b.json`. */
export function atlasNames(hash: string): AtlasNames {
  return { image: `atlas.${hash}.png`, json: `atlas.${hash}.json` };
}

/**
 * Matches every atlas file this command has ever written — hashed or the pre-hash plain
 * names — so stale ones can be swept without touching anything else in `public/art/`.
 */
export const ATLAS_FILE_PATTERN = /^atlas(?:\.[0-9a-f]+)?\.(?:png|json)$/;

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

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Emit strings the way prettier would, so `yarn art pack && yarn format:check` agree without
 * an intervening `yarn format`. Single quotes, matching .prettierrc.
 */
function tsString(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\');
  return escaped.includes("'") && !escaped.includes('"')
    ? `"${escaped}"`
    : `'${escaped.replace(/'/g, "\\'")}'`;
}

/** Same deal for object keys: prettier's `quoteProps: as-needed` strips quotes it can. */
function tsKey(value: string): string {
  return IDENTIFIER.test(value) ? value : tsString(value);
}

/** The typed manifest the game imports — the contract between this pipeline and the renderer. */
export function buildTypedManifest(
  layout: AtlasLayout,
  meta: Map<string, FrameMeta>,
  names: AtlasNames,
): string {
  const entries = layout.frames
    .map((frame) => {
      const info = meta.get(frame.id);
      return (
        `  ${tsKey(frame.id)}: {\n` +
        `    x: ${frame.x},\n` +
        `    y: ${frame.y},\n` +
        `    width: ${frame.width},\n` +
        `    height: ${frame.height},\n` +
        `    anchor: ${tsString(info?.anchor ?? 'center')},\n` +
        `    group: ${tsString(frame.group)},\n` +
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

// Content-addressed: a regenerated atlas is a different URL, so no browser, CDN, or service
// worker can serve the previous one. Both names carry the same hash of the packed bytes.
export const ATLAS_IMAGE_URL = ${tsString(`/art/${names.image}`)};
export const ATLAS_JSON_URL = ${tsString(`/art/${names.json}`)};

export const ATLAS_SIZE = { width: ${layout.width}, height: ${layout.height} } as const;

export const ATLAS_FRAMES = {
${entries}
} as const satisfies Record<string, AtlasFrame>;

export type AssetId = keyof typeof ATLAS_FRAMES;

export const ASSET_IDS = Object.keys(ATLAS_FRAMES) as AssetId[];
`;
}
