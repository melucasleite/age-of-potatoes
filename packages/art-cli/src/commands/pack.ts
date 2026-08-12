import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import sharp from 'sharp';
import { numberOption } from '../args.js';
import { loadManifest, resolveArtPath } from '../manifest.js';
import { AtlasSpillError, packAtlas } from '../pack/atlas.js';
import { buildAtlasJson, buildTypedManifest } from '../pack/emit-manifest.js';
import { cook } from '../post/cook.js';
import { loadPalette } from '../post/palette.js';
import { getAdapter } from '../providers/index.js';
import { COOKED_DIR, ORIGINALS_DIR, WEB_GENERATED_MANIFEST, WEB_PUBLIC_ART_DIR } from '../paths.js';
import type { Args } from '../args.js';
import type { PackInput } from '../pack/atlas.js';
import type { FrameMeta } from '../pack/emit-manifest.js';

/** Page ceiling. Lower it on the command line to prove the spill assertion actually fires. */
const DEFAULT_MAX_PAGE = 1024;

export async function pack(args: Args): Promise<number> {
  const maxPage = numberOption(args, 'max-page', DEFAULT_MAX_PAGE);
  const manifest = loadManifest();
  const palette = manifest.palette ? loadPalette(resolveArtPath(manifest.palette)) : null;

  mkdirSync(COOKED_DIR, { recursive: true });
  mkdirSync(WEB_PUBLIC_ART_DIR, { recursive: true });
  mkdirSync(dirname(WEB_GENERATED_MANIFEST), { recursive: true });

  const inputs: PackInput[] = [];
  const meta = new Map<string, FrameMeta>();
  const cooked = new Map<string, Buffer>();
  let offPaletteTotal = 0;

  for (const entry of manifest.assets) {
    const original = resolve(ORIGINALS_DIR, `${entry.id}.png`);
    if (!existsSync(original)) {
      console.log(
        `  skip  ${entry.id.padEnd(24)} no committed original — run \`yarn art gen\` first`,
      );
      continue;
    }

    const capabilities = getAdapter(entry.provider).capabilities;
    const result = await cook(readFileSync(original), entry, capabilities, palette);
    writeFileSync(resolve(COOKED_DIR, `${entry.id}.png`), result.png);

    cooked.set(entry.id, result.png);
    inputs.push({
      id: entry.id,
      group: entry.atlasGroup,
      width: entry.width,
      height: entry.height,
    });
    meta.set(entry.id, {
      anchor: entry.anchor,
      sourceWidth: entry.width,
      sourceHeight: entry.height,
    });

    offPaletteTotal += result.palette.totalOffPixels;
    const drift = result.palette.measured
      ? result.palette.offPalette.length === 0
        ? 'palette clean'
        : `${result.palette.offPalette.length} off-palette colour(s), ${result.palette.totalOffPixels}px`
      : 'palette not measured (none configured)';
    console.log(`  cook  ${entry.id.padEnd(24)} ${result.grid.message}; ${drift}`);
  }

  if (inputs.length === 0) {
    console.error('\nNothing to pack: no committed originals found in art/originals/.');
    return 1;
  }

  let layout;
  try {
    layout = packAtlas(inputs, maxPage);
  } catch (error) {
    if (error instanceof AtlasSpillError) {
      console.error(`\nATLAS SPILL — build failed.\n\n${error.message}`);
      return 1;
    }
    throw error;
  }

  const page = sharp({
    create: {
      width: layout.width,
      height: layout.height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  });
  const composited = await page
    .composite(
      layout.frames.map((frame) => {
        const input = cooked.get(frame.id);
        if (!input) throw new Error(`Internal: no cooked buffer for "${frame.id}".`);
        return { input, left: frame.x, top: frame.y };
      }),
    )
    .png({ palette: false, compressionLevel: 9 })
    .toBuffer();

  writeFileSync(resolve(WEB_PUBLIC_ART_DIR, 'atlas.png'), composited);
  writeFileSync(
    resolve(WEB_PUBLIC_ART_DIR, 'atlas.json'),
    buildAtlasJson(layout, meta, 'atlas.png'),
  );
  writeFileSync(WEB_GENERATED_MANIFEST, buildTypedManifest(layout, meta));

  console.log(
    `\n  atlas ${layout.width}x${layout.height}, one page, ${layout.frames.length} frame(s) in ` +
      `${layout.groups.length} group(s): ${layout.groups.map((g) => `${g.group}(${g.count})`).join(', ')}`,
  );
  console.log(`  ${(composited.length / 1024).toFixed(1)} KB atlas.png`);
  if (palette) console.log(`  ${offPaletteTotal} off-palette pixel(s) across all assets`);
  return 0;
}
