import { describe, expect, it } from 'vitest';
import {
  ATLAS_FILE_PATTERN,
  atlasContentHash,
  atlasNames,
  buildTypedManifest,
} from './emit-manifest.js';
import type { AtlasLayout } from './atlas.js';
import type { FrameMeta } from './emit-manifest.js';

const layout: AtlasLayout = {
  width: 32,
  height: 32,
  frames: [{ id: 'crop_wheat', group: 'crops', width: 16, height: 16, x: 0, y: 0 }],
  groups: [{ group: 'crops', x: 0, y: 0, width: 16, height: 16, count: 1 }],
};

const meta = new Map<string, FrameMeta>([
  ['crop_wheat', { anchor: 'bottom-center', sourceWidth: 16, sourceHeight: 16 }],
]);

describe('atlasContentHash', () => {
  it('is stable when nothing changed', () => {
    const image = Buffer.from('atlas bytes');
    expect(atlasContentHash(image, layout, meta)).toBe(atlasContentHash(image, layout, meta));
  });

  it('moves when the image bytes change', () => {
    const before = atlasContentHash(Buffer.from('atlas bytes'), layout, meta);
    const after = atlasContentHash(Buffer.from('atlas bytes!'), layout, meta);
    expect(after).not.toBe(before);
  });

  it('moves when only the layout changed', () => {
    const image = Buffer.from('atlas bytes');
    const moved: AtlasLayout = {
      ...layout,
      frames: [{ id: 'crop_wheat', group: 'crops', width: 16, height: 16, x: 8, y: 0 }],
    };
    expect(atlasContentHash(image, moved, meta)).not.toBe(atlasContentHash(image, layout, meta));
  });
});

describe('atlasNames', () => {
  it('pairs the image and JSON under one hash', () => {
    expect(atlasNames('a3f91c2b')).toEqual({
      image: 'atlas.a3f91c2b.png',
      json: 'atlas.a3f91c2b.json',
    });
  });
});

describe('ATLAS_FILE_PATTERN', () => {
  it('matches hashed and pre-hash atlas names, and nothing else', () => {
    for (const name of ['atlas.png', 'atlas.json', 'atlas.a3f91c2b.png', 'atlas.a3f91c2b.json']) {
      expect(ATLAS_FILE_PATTERN.test(name)).toBe(true);
    }
    for (const name of ['favicon.ico', 'atlas.png.bak', 'atlas-notes.md', 'terrain_grass.png']) {
      expect(ATLAS_FILE_PATTERN.test(name)).toBe(false);
    }
  });
});

describe('buildTypedManifest', () => {
  const source = buildTypedManifest(layout, meta, atlasNames('a3f91c2b'));

  it('points both URLs at the hashed files on disk', () => {
    expect(source).toContain("export const ATLAS_IMAGE_URL = '/art/atlas.a3f91c2b.png';");
    expect(source).toContain("export const ATLAS_JSON_URL = '/art/atlas.a3f91c2b.json';");
  });

  // The papercut this guards: emitting JSON-style double quotes made `yarn art pack` and
  // `yarn format:check` disagree until someone ran `yarn format` in between.
  it('emits prettier-shaped quoting so no reformat is needed after a pack', () => {
    expect(source).toContain('  crop_wheat: {');
    expect(source).toContain("    anchor: 'bottom-center',");
    expect(source).not.toContain('"');
  });
});
