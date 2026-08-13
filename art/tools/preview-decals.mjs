// Renders art/review/decals.png — every upgrade decal composited onto a real machine.
//
// A decal judged on its own is meaningless: it is transparent everywhere that matters, and
// the only question worth asking is whether an upgraded machine reads as upgraded from
// across the field. So this stamps each of the nine overlays onto an actual cooked machine
// sprite and lays them out as a grid — one row per dial, columns bare / L1 / L2 / L3 — at
// an integer nearest-neighbour zoom.
//
// It caught the first version of the efficiency trim, which was wider than the chassis and
// therefore read as a green rug the machine was standing on rather than paint applied to it.
//
// Usage: node art/tools/preview-decals.mjs [machine_id]

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const HERE = dirname(fileURLToPath(import.meta.url));
const ART = resolve(HERE, '..');
const machineId = process.argv[2] ?? 'machine_fryer';
const machine = resolve(ART, 'cooked', `${machineId}.png`);

if (!existsSync(machine)) {
  throw new Error(`No cooked sprite at ${machine} — run \`yarn art pack\` first.`);
}

const DIALS = ['speed', 'capacity', 'efficiency'];
const LEVELS = [1, 2, 3];
const ZOOM = 6;
const PAD = 8;
const SIZE = 32;
const cell = SIZE * ZOOM + PAD;

const composites = [];
for (let row = 0; row < DIALS.length; row++) {
  for (let col = 0; col <= LEVELS.length; col++) {
    let framed;
    if (col === 0) {
      framed = await sharp(machine)
        .resize(SIZE * ZOOM, SIZE * ZOOM, { kernel: 'nearest' })
        .png()
        .toBuffer();
    } else {
      const decal = resolve(ART, 'local', `decal_${DIALS[row]}_${LEVELS[col - 1]}.png`);
      const merged = await sharp(machine)
        .composite([{ input: await sharp(decal).toBuffer() }])
        .toBuffer();
      framed = await sharp(merged)
        .resize(SIZE * ZOOM, SIZE * ZOOM, { kernel: 'nearest' })
        .png()
        .toBuffer();
    }
    composites.push({ input: framed, left: PAD + col * cell, top: PAD + row * cell });
  }
}

const out = resolve(ART, 'review', 'decals.png');
await sharp({
  create: {
    width: (LEVELS.length + 1) * cell + PAD,
    height: DIALS.length * cell + PAD,
    channels: 4,
    background: { r: 24, g: 22, b: 19, alpha: 1 },
  },
})
  .composite(composites)
  .png()
  .toFile(out);

console.log(
  `Wrote ${out} — rows ${DIALS.join(' / ')}, columns bare / L1 / L2 / L3, on ${machineId}.`,
);
