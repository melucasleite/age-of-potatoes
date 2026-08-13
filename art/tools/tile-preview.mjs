// Renders a tiling asset the only way it can honestly be judged: as a field.
//
// A 16px ground tile viewed alone is a thumbnail, and thumbnails lie. Every artefact that
// matters in a terrain texture is a *repetition* artefact — a bright clod becomes a
// polka-dot lattice, a dark edge becomes a grid of seams, and a lively speckle becomes
// static — and none of them are visible until the tile sits next to seven copies of
// itself. So this writes a 4x4 repeat at an integer nearest-neighbour zoom, plus the
// numbers that predict how a field will read before you look at it:
//
//   * luma sd    — internal contrast. Stardew ground sits low; noisy ground sits high.
//   * distinct   — how many values the tile actually uses. Few values read as calm.
//   * top share  — what fraction the dominant colour holds. A high share is a quiet field.
//
// Usage: node art/tools/tile-preview.mjs [ids,comma,separated] [--dir=art/cooked] [--out=art/review]

import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const HERE = dirname(fileURLToPath(import.meta.url));
const ART = resolve(HERE, '..');

const args = process.argv.slice(2);
const options = new Map(
  args.filter((a) => a.startsWith('--')).map((a) => a.replace(/^--/, '').split('=')),
);
const ids = (args.find((a) => !a.startsWith('--')) ?? 'terrain_grass,terrain_soil,terrain_soil_tilled')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const srcDir = resolve(ART, options.get('dir') ?? 'cooked');
const outDir = resolve(ART, options.get('out') ?? 'review');
const repeat = Number(options.get('repeat') ?? 4);
const zoom = Number(options.get('zoom') ?? 8);

mkdirSync(outDir, { recursive: true });

for (const id of ids) {
  const src = resolve(srcDir, `${id}.png`);
  if (!existsSync(src)) {
    console.log(`  skip  ${id.padEnd(24)} no PNG at ${src}`);
    continue;
  }

  const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H } = info;

  const lums = [];
  const colors = new Map();
  for (let i = 0; i < W * H; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    lums.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
    const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    colors.set(hex, (colors.get(hex) ?? 0) + 1);
  }
  const mean = lums.reduce((a, b) => a + b, 0) / lums.length;
  const sd = Math.sqrt(lums.reduce((a, b) => a + (b - mean) ** 2, 0) / lums.length);
  const ranked = [...colors.entries()].sort((a, b) => b[1] - a[1]);
  const topShare = (ranked[0][1] / (W * H)) * 100;

  // Banding: how far the most extreme row or column strays from the tile mean. This is the
  // one that decides takes. A tile can be calm on every other number and still hold a
  // single dark row — which, tiled, is not a row but a hard stripe every 16px forever.
  let banding = 0;
  for (let y = 0; y < H; y++) {
    let sum = 0;
    for (let x = 0; x < W; x++) sum += lums[y * W + x];
    banding = Math.max(banding, Math.abs(sum / W - mean));
  }
  for (let x = 0; x < W; x++) {
    let sum = 0;
    for (let y = 0; y < H; y++) sum += lums[y * W + x];
    banding = Math.max(banding, Math.abs(sum / H - mean));
  }

  console.log(`\n${id}  ${W}x${H}`);
  console.log(
    `  luma mean ${mean.toFixed(1)}  sd ${sd.toFixed(1)}  ` +
      `range ${Math.min(...lums).toFixed(0)}-${Math.max(...lums).toFixed(0)}  ` +
      `distinct ${colors.size}  top ${ranked[0][0]} ${topShare.toFixed(0)}%  ` +
      `banding ${banding.toFixed(1)}`,
  );
  console.log(`  ${ranked.map(([h, c]) => `${h}:${c}`).join(' ')}`);

  const tiled = Buffer.alloc(W * repeat * H * repeat * 4);
  for (let y = 0; y < H * repeat; y++) {
    for (let x = 0; x < W * repeat; x++) {
      const s = ((y % H) * W + (x % W)) * 4;
      const d = (y * W * repeat + x) * 4;
      tiled[d] = data[s];
      tiled[d + 1] = data[s + 1];
      tiled[d + 2] = data[s + 2];
      tiled[d + 3] = data[s + 3];
    }
  }

  const out = resolve(outDir, `tiled_${id}.png`);
  await sharp(tiled, { raw: { width: W * repeat, height: H * repeat, channels: 4 } })
    .resize(W * repeat * zoom, H * repeat * zoom, { kernel: 'nearest' })
    .png()
    .toFile(out);
  console.log(`  wrote ${out}`);
}
