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
   * Trim to opaque bounds and re-pad by anchor. Defaults to true, which is right for a lone
   * sprite and *wrong* for a multi-frame strip: trimming a 4-stage crop strip to its overall
   * bounding box slides every stage off its 16px cell, which is precisely the incoherence
   * generating the strip in one call was meant to avoid. Set false on any strip.
   */
  trim?: boolean;
  /** `provider: "local"` only — path to a hand-authored PNG, relative to art/. */
  source?: string;
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

  if (provider === 'local' && !parsed.source) {
    fail(where, 'uses provider "local" but declares no "source" PNG path');
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
