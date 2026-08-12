import sharp from 'sharp';

/** An RGBA pixel buffer. Every colour stage in this pipeline operates on one of these. */
export interface RawImage {
  data: Buffer;
  width: number;
  height: number;
}

export async function decode(png: Buffer): Promise<RawImage> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/**
 * Encodes RGBA back to PNG.
 *
 * `palette: false` is load-bearing and not a default worth trusting to memory. sharp's
 * `png({ palette: true })` runs libimagequant, which picks its *own* palette and offers
 * no API to supply a fixed one — it would silently re-quantise every pixel this pipeline
 * just mapped, producing near-miss colours that look fine and fail the palette gate.
 * For the same reason pngquant must never run anywhere in this pipeline.
 */
export function encode(image: RawImage): Promise<Buffer> {
  return sharp(image.data, {
    raw: { width: image.width, height: image.height, channels: 4 },
  })
    .png({ palette: false, compressionLevel: 9 })
    .toBuffer();
}

export function pixelAt(image: RawImage, x: number, y: number): [number, number, number, number] {
  const i = (y * image.width + x) * 4;
  return [
    image.data[i] ?? 0,
    image.data[i + 1] ?? 0,
    image.data[i + 2] ?? 0,
    image.data[i + 3] ?? 0,
  ];
}

export function hexOf(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

export function parseHex(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}
