import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** Repo root, resolved from this file rather than cwd so the CLI works from anywhere. */
export const REPO_ROOT = resolve(here, '../../..');

export const ART_DIR = resolve(REPO_ROOT, 'art');
export const MANIFEST_PATH = resolve(ART_DIR, 'manifest.json');
export const ORIGINALS_DIR = resolve(ART_DIR, 'originals');
export const COOKED_DIR = resolve(ART_DIR, 'cooked');
export const REVIEW_DIR = resolve(ART_DIR, 'review');
export const PALETTE_DIR = resolve(ART_DIR, 'palette');

export const WEB_PUBLIC_ART_DIR = resolve(REPO_ROOT, 'apps/web/public/art');
export const WEB_GENERATED_MANIFEST = resolve(REPO_ROOT, 'apps/web/src/art/manifest.generated.ts');

export const ENV_PATH = resolve(REPO_ROOT, '.env');
