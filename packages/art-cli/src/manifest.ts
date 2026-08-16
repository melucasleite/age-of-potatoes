import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ART_DIR, MANIFEST_PATH } from './paths.js';

export type Anchor = 'bottom-center' | 'center' | 'top-left';
export type ProviderName = 'retro-diffusion' | 'local';

export interface AssetEntry {
  id: string;
  provider: ProviderName;
  /** Native pixel width. 16/32/48 — never 512. See plan §15. */
  width: number;
  /** Native pixel height. */
  height: number;
  prompt: string;
  promptStyle?: string;
  seed?: number;
  anchor: Anchor;
  atlasGroup: string;
  tileX?: boolean;
  tileY?: boolean;
  /** Provider-side background removal. Defaults to true; the point of skipping the magenta sentinel. */
  removeBg?: boolean;
  /**
   * The colours this asset is allowed to be made of — swatch names, or `"ramp:<name>"` for
   * a whole ramp. Omitted means the whole master palette, which is right for most sprites.
   *
   * It is NOT right for ground. Nearest-colour matching has no idea that `lamp_running` is
   * reserved for status lamps or that `ink` is reserved for outlines, so the first grass
   * tile quantised 46% into the status green and the first tilled soil 35% into pure ink —
   * both on-palette, both wrong. See `resolvePaletteSubset` for the full argument.
   */
  paletteSubset?: string[];
  /**
   * Trim to opaque bounds and re-pad by anchor. Defaults to true, which is right for a lone
   * sprite and *wrong* for a multi-frame strip: trimming a 4-stage crop strip to its overall
   * bounding box slides every stage off its 16px cell, which is precisely the incoherence
   * generating the strip in one call was meant to avoid. Set false on any strip.
   */
  trim?: boolean;
  /** `provider: "local"` only — path to a hand-authored PNG, relative to art/. */
  source?: string;
  /**
   * Ship this asset as a STANDALONE PNG in `apps/web/public/art/<id>.png` instead of packing
   * it into the atlas ([[092]]).
   *
   * Everything the game draws through Pixi belongs in the one atlas page, and that is still
   * the default — the single-page rule exists because belt items batch through a
   * `ParticleContainer` and every particle must share one `TextureSource` (plan §13). But the
   * front door is DOM, not canvas: it wants a `background-image` URL, which a packed frame
   * cannot be. And a 384x216 backdrop packed alongside 16px sprites would blow the page
   * budget on a texture Pixi never binds.
   *
   * So an unpacked entry travels the IDENTICAL generate + cook path — same `input_palette`,
   * same grid verification, same palette snap, same committed original and sidecar — and only
   * the final emit differs. It contributes nothing to the atlas layout, which is what keeps
   * adding one from churning the atlas content hash.
   *
   * `atlasGroup` is still required and still records which family the asset belongs to; it
   * simply names no page.
   */
  unpacked?: boolean;
  /**
   * Opt-in to Retro Diffusion's ANIMATION endpoint: the strip's native cell count. The plain
   * endpoint cannot draw N plants on an N-cell pitch at strip resolution (measured, wave 8:
   * 26 paid takes, one success — it draws at its own ~45-55px pitch whatever you ask), so
   * strips that need exact cells generate as fixed-count animations instead, one frame per
   * cell, returned as a PNG spritesheet.
   *
   * Requires: a `promptStyle` from `ANIMATION_FRAME_SIZES` (frame pixel sizes are fixed per
   * style), `width === frames * height` (a strip is one row of square cells), and
   * `trim: false` (the reason every strip needs it). RD only sells 4/6/8/10/12/16 frames;
   * when `frames` is not one of those, the request over-asks to the next count and the strip
   * deterministically keeps the first `frames - 1` frames plus the LAST one — the animation's
   * end state is what the final cell is for. See `post/frames.ts`.
   *
   * Absent on an entry, nothing changes: the plain single-sprite path is untouched.
   */
  frames?: number;
  /**
   * Sheet-harvest mode, for styles that SUBSTITUTE their own animation format. Measured
   * (items 063/065): `rd_animation__small_sprites` ignores `frames_duration` and always
   * returns a twenty-cell RPG character sheet — useless for a crop strip, exactly right for
   * a character walk cycle. With `sheetCells`, that substitution is the point: the entry
   * keeps exactly these row-major cell indices from whatever grid the style returns, in
   * order, as its strip cells.
   *
   * The cell choice is a COOK-TIME selection from the committed raw sheet: `gen` gates only
   * that the take is a real sheet on the style's frame grid (a wrong index is fixed by
   * editing this array and re-cooking — no re-buy), while `cook` slices the named cells and
   * runs the full cell-geometry gate on the result, every pack. Requires `frames`, and the
   * array's length must equal it.
   */
  sheetCells?: readonly number[];
}

export interface ArtManifest {
  /** Path relative to art/ of the palette JSON passed as `input_palette` on every call. */
  palette?: string;
  assets: AssetEntry[];
}

const ANCHORS: readonly Anchor[] = ['bottom-center', 'center', 'top-left'];
const PROVIDERS: readonly ProviderName[] = ['retro-diffusion', 'local'];

function fail(where: string, message: string): never {
  throw new Error(`art/manifest.json: ${where} ${message}`);
}

function requireString(entry: Record<string, unknown>, key: string, where: string): string {
  const value = entry[key];
  if (typeof value !== 'string' || value.length === 0) fail(where, `is missing a string "${key}"`);
  return value;
}

function requireDimension(entry: Record<string, unknown>, key: string, where: string): number {
  const value = entry[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    fail(where, `"${key}" must be a positive integer of native pixels (e.g. 16, 32, 48)`);
  }
  return value;
}

function parseEntry(raw: unknown, index: number): AssetEntry {
  if (typeof raw !== 'object' || raw === null) fail(`assets[${index}]`, 'is not an object');
  const entry = raw as Record<string, unknown>;
  const id = requireString(entry, 'id', `assets[${index}]`);
  const where = `asset "${id}"`;

  const provider = requireString(entry, 'provider', where) as ProviderName;
  if (!PROVIDERS.includes(provider)) {
    fail(where, `has unknown provider "${provider}" (expected one of ${PROVIDERS.join(', ')})`);
  }

  const anchor = requireString(entry, 'anchor', where) as Anchor;
  if (!ANCHORS.includes(anchor)) {
    fail(where, `has unknown anchor "${anchor}" (expected one of ${ANCHORS.join(', ')})`);
  }

  const parsed: AssetEntry = {
    id,
    provider,
    width: requireDimension(entry, 'width', where),
    height: requireDimension(entry, 'height', where),
    prompt: requireString(entry, 'prompt', where),
    anchor,
    atlasGroup: requireString(entry, 'atlasGroup', where),
  };

  if (typeof entry.promptStyle === 'string') parsed.promptStyle = entry.promptStyle;
  if (typeof entry.seed === 'number') parsed.seed = entry.seed;
  if (typeof entry.tileX === 'boolean') parsed.tileX = entry.tileX;
  if (typeof entry.tileY === 'boolean') parsed.tileY = entry.tileY;
  if (typeof entry.removeBg === 'boolean') parsed.removeBg = entry.removeBg;
  if (typeof entry.trim === 'boolean') parsed.trim = entry.trim;
  if (typeof entry.source === 'string') parsed.source = entry.source;
  if (typeof entry.unpacked === 'boolean') parsed.unpacked = entry.unpacked;

  if (entry.paletteSubset !== undefined) {
    if (
      !Array.isArray(entry.paletteSubset) ||
      entry.paletteSubset.some((name) => typeof name !== 'string')
    ) {
      fail(where, '"paletteSubset" must be an array of swatch names or "ramp:<name>" strings');
    }
    parsed.paletteSubset = entry.paletteSubset as string[];
  }

  if (provider === 'local' && !parsed.source) {
    fail(where, 'uses provider "local" but declares no "source" PNG path');
  }

  if (entry.frames !== undefined) {
    const frames = entry.frames;
    if (typeof frames !== 'number' || !Number.isInteger(frames) || frames < 2) {
      fail(where, '"frames" must be an integer cell count of at least 2');
    }
    if (provider !== 'retro-diffusion') {
      fail(where, '"frames" is the Retro Diffusion animation opt-in; it means nothing on local');
    }
    if (parsed.width !== frames * parsed.height) {
      fail(
        where,
        `declares frames: ${frames} at ${parsed.width}x${parsed.height} — a strip is one row ` +
          `of square cells, so width must be ${frames * parsed.height}`,
      );
    }
    if (parsed.trim !== false) {
      fail(where, 'declares "frames" without "trim": false — trimming slides cells off the grid');
    }
    parsed.frames = frames;
  }

  if (entry.sheetCells !== undefined) {
    const cells = entry.sheetCells;
    if (parsed.frames === undefined) {
      fail(where, '"sheetCells" requires "frames" — it names which sheet cells become strip cells');
    }
    if (
      !Array.isArray(cells) ||
      cells.length !== parsed.frames ||
      cells.some((cell) => typeof cell !== 'number' || !Number.isInteger(cell) || cell < 0)
    ) {
      fail(
        where,
        `"sheetCells" must be an array of exactly ${parsed.frames} non-negative integer ` +
          'cell indices (row-major into the returned sheet)',
      );
    }
    parsed.sheetCells = cells as number[];
  }

  return parsed;
}

export function loadManifest(path = MANIFEST_PATH): ArtManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read ${path}: ${(error as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null) throw new Error(`${path} is not an object`);
  const manifest = raw as Record<string, unknown>;
  if (!Array.isArray(manifest.assets)) throw new Error(`${path} has no "assets" array`);

  const assets = manifest.assets.map(parseEntry);
  const seen = new Set<string>();
  for (const asset of assets) {
    if (seen.has(asset.id)) fail(`asset "${asset.id}"`, 'is declared more than once');
    seen.add(asset.id);
  }

  const result: ArtManifest = { assets };
  if (typeof manifest.palette === 'string') result.palette = manifest.palette;
  return result;
}

/** Resolves a manifest-relative path (palette, local source) against art/. */
export function resolveArtPath(relative: string): string {
  return resolve(ART_DIR, relative);
}
