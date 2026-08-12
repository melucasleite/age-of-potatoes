import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadManifest, resolveArtPath } from '../manifest.js';
import { cook } from '../post/cook.js';
import { loadPalette } from '../post/palette.js';
import { getAdapter } from '../providers/index.js';
import { buildContactSheet } from '../review/contact-sheet.js';
import { ORIGINALS_DIR, REVIEW_DIR } from '../paths.js';
import type { SheetAsset } from '../review/contact-sheet.js';

interface Sidecar {
  seed?: number | null;
  model?: string;
}

function readSidecar(id: string): Sidecar {
  const path = resolve(ORIGINALS_DIR, `${id}.json`);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Sidecar;
  } catch {
    return {};
  }
}

/**
 * Cooks in memory rather than reading art/cooked/, so `review` works before `pack` has
 * ever run — which is the order you actually want when judging a fresh generation.
 */
export async function review(): Promise<number> {
  const manifest = loadManifest();
  const palette = manifest.palette ? loadPalette(resolveArtPath(manifest.palette)) : null;
  mkdirSync(REVIEW_DIR, { recursive: true });

  const assets: SheetAsset[] = [];
  for (const entry of manifest.assets) {
    const original = resolve(ORIGINALS_DIR, `${entry.id}.png`);
    if (!existsSync(original)) {
      console.log(`  skip  ${entry.id.padEnd(24)} no committed original`);
      continue;
    }

    const capabilities = getAdapter(entry.provider).capabilities;
    const result = await cook(readFileSync(original), entry, capabilities, palette);
    const sidecar = readSidecar(entry.id);

    assets.push({
      entry,
      dataUri: `data:image/png;base64,${result.png.toString('base64')}`,
      seed: sidecar.seed ?? null,
      model: sidecar.model ?? 'unknown model',
      bytes: result.png.length,
      palette: result.palette,
    });
    console.log(`  sheet ${entry.id.padEnd(24)} ${result.grid.message}`);
  }

  if (assets.length === 0) {
    console.error('\nNothing to review: no committed originals found in art/originals/.');
    return 1;
  }

  const out = resolve(REVIEW_DIR, 'index.html');
  writeFileSync(out, buildContactSheet(assets));
  console.log(`\n  wrote ${out} (${assets.length} asset(s), fully self-contained)`);
  return 0;
}
