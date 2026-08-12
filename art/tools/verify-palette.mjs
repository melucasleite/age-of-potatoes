// The palette gate. An off-palette pixel is a type error with a nicer error message.
//
// Work item 005 owns this file; the CLI in packages/art-cli only *measures* drift and prints
// it. Splitting it that way is deliberate — two gates that can disagree about whether the
// build passes is worse than one gate that can be read in a single sitting.
//
//   node art/tools/verify-palette.mjs      (or: yarn art:verify)
//
// Checks, in order:
//   1. art/palette/master.json is well-formed — 32-48 unique named colours with role notes.
//   2. art/manifest.json actually points at it. A gate on a palette nothing uses is theatre.
//   3. art/palette/master.png matches the JSON it documents.
//   4. Every opaque pixel in art/cooked/ is one of those colours.
//
// art/cooked/ is gitignored and produced by `yarn art pack`, so this runs after packing.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { ART_DIR, MASTER_PNG, loadMaster, renderPalettePng } from './palette-png.mjs';

const COOKED_DIR = resolve(ART_DIR, 'cooked');
const MANIFEST = resolve(ART_DIR, 'manifest.json');

const problems = [];
const hex2 = (value) => value.toString(16).padStart(2, '0');

const { colors, name } = loadMaster();
const allowed = new Set(colors);
console.log(`Palette "${name}": ${colors.length} colours.`);

// 2 — the manifest must actually pass it.
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
if (manifest.palette !== 'palette/master.json') {
  problems.push(
    `art/manifest.json declares palette ${JSON.stringify(manifest.palette ?? null)}, not ` +
      `"palette/master.json". Every generation must be constrained by the master palette.`,
  );
}

// 3 — the reference PNG must match the JSON.
const expectedPng = await renderPalettePng(colors);
if (!existsSync(MASTER_PNG)) {
  problems.push('art/palette/master.png is missing. Run: node art/tools/palette-png.mjs');
} else if (!readFileSync(MASTER_PNG).equals(expectedPng)) {
  problems.push(
    'art/palette/master.png is stale — it no longer matches master.json. ' +
      'Run: node art/tools/palette-png.mjs',
  );
}

// 4 — the actual gate.
if (!existsSync(COOKED_DIR)) {
  problems.push('art/cooked/ does not exist. Run `yarn art pack` before verifying.');
} else {
  const files = readdirSync(COOKED_DIR).filter((file) => file.endsWith('.png'));
  if (files.length === 0) {
    problems.push('art/cooked/ holds no PNGs. Run `yarn art pack` before verifying.');
  }

  for (const file of files) {
    const { data, info } = await sharp(resolve(COOKED_DIR, file))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const counts = new Map();
    for (let i = 0; i < data.length; i += info.channels) {
      if (data[i + 3] === 0) continue; // fully transparent pixels carry no colour
      const hex = `#${hex2(data[i])}${hex2(data[i + 1])}${hex2(data[i + 2])}`;
      if (allowed.has(hex)) continue;
      counts.set(hex, (counts.get(hex) ?? 0) + 1);
    }

    if (counts.size === 0) {
      console.log(`  ok    ${file.padEnd(28)} palette clean`);
      continue;
    }
    const detail = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([hex, pixels]) => `${hex} x${pixels}`)
      .join(', ');
    problems.push(`${file}: ${counts.size} off-palette colour(s) — ${detail}`);
    console.log(`  FAIL  ${file.padEnd(28)} ${counts.size} off-palette colour(s)`);
  }
}

if (problems.length > 0) {
  console.error(`\nPALETTE GATE FAILED — ${problems.length} problem(s):\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    `\nFix the prompt, the palette or a post-processing stage — never the PNG by hand ` +
      `(plan §10.4: a hand-touched sprite is unreproducible the next time the style moves).`,
  );
  process.exit(1);
}

console.log('\nPalette gate passed. Every cooked pixel is on the master palette.');
