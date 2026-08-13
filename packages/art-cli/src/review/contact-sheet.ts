import type { PaletteReport } from '../post/palette.js';
import type { RawImage } from '../post/raw.js';
import type { AssetEntry } from '../manifest.js';

export interface SheetAsset {
  entry: AssetEntry;
  /** Cooked PNG, inlined as a data URI. No file on this page may be an external request. */
  dataUri: string;
  seed: number | null;
  model: string;
  bytes: number;
  palette: PaletteReport;
  /** Present only for tiling assets — the numbers that predict how a field reads. */
  field: FieldStats | null;
}

export interface FieldStats {
  /** Standard deviation of luma. Internal contrast; Stardew-calm ground sits low. */
  lumaSd: number;
  /** How many distinct colours the tile actually uses. Few values read as calm. */
  distinct: number;
  /** Share of the tile held by its single most common colour, 0-100. */
  dominantShare: number;
  dominantHex: string;
  /**
   * How far the most extreme row or column strays from the tile's own mean luma.
   *
   * This is the number the other three miss, and it is the defect that actually keeps
   * killing terrain takes. A tile can be beautifully calm on contrast, values and dominance
   * and still contain one dark row — and a dark row in a tile that repeats is not a row,
   * it is corduroy across the entire field, a hard stripe every 16 pixels forever. Three
   * separate rerolls passed every other check and failed on exactly this, which is why it
   * is worth its own measurement rather than an instruction to squint.
   */
  banding: number;
}

/** How many tiles across the repeat preview runs. Four is the smallest honest field. */
const REPEAT = 4;
/** Integer zoom for the repeat. Nearest-neighbour, because everything here depends on it. */
const REPEAT_ZOOM = 4;

/**
 * Three numbers that predict how a tile will read once it is a field, computed on the
 * cooked pixels. Luma is the Rec.709 weighting — perceptual enough for "is this noisy",
 * and it is a hint for the eye rather than a gate, so nothing here needs Oklab.
 */
export function measureField(image: RawImage): FieldStats {
  const counts = new Map<string, number>();
  const lumas: number[] = [];
  const { width, height } = image;
  const grid = new Float64Array(width * height);

  for (let i = 0; i < image.data.length; i += 4) {
    const r = image.data[i] ?? 0;
    const g = image.data[i + 1] ?? 0;
    const b = image.data[i + 2] ?? 0;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    grid[i / 4] = luma;
    if ((image.data[i + 3] ?? 0) === 0) continue;
    lumas.push(luma);
    const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }

  if (lumas.length === 0) {
    return { lumaSd: 0, distinct: 0, dominantShare: 0, dominantHex: '—', banding: 0 };
  }
  const mean = lumas.reduce((sum, value) => sum + value, 0) / lumas.length;
  const lumaSd = Math.sqrt(
    lumas.reduce((sum, value) => sum + (value - mean) ** 2, 0) / lumas.length,
  );
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked[0] ?? ['—', 0];

  let banding = 0;
  for (let y = 0; y < height; y++) {
    let sum = 0;
    for (let x = 0; x < width; x++) sum += grid[y * width + x] ?? 0;
    banding = Math.max(banding, Math.abs(sum / width - mean));
  }
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = 0; y < height; y++) sum += grid[y * width + x] ?? 0;
    banding = Math.max(banding, Math.abs(sum / height - mean));
  }

  return {
    lumaSd,
    distinct: counts.size,
    dominantShare: (top[1] / lumas.length) * 100,
    dominantHex: top[0],
    banding,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px;
    background: #16130f; color: #e8ddc8;
    font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  h1 { font-size: 18px; margin: 0 0 4px; letter-spacing: 0.04em; }
  .sub { color: #8d8375; margin: 0 0 28px; }
  .grid { display: grid; gap: 20px; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); }
  .card { background: #201b16; border: 1px solid #362e25; border-radius: 6px; padding: 16px; }
  .id { font-weight: 700; color: #f2c879; margin-bottom: 2px; }
  .facts { color: #8d8375; font-size: 12px; margin-bottom: 12px; }
  .scales { display: flex; align-items: flex-end; gap: 18px; padding: 12px;
            background: #12100d; border-radius: 4px; min-height: 120px; }
  .scale { text-align: center; }
  .scale span { display: block; margin-top: 6px; color: #6f675b; font-size: 11px; }
  /* Integer scaling with no filtering — the whole aesthetic depends on this. */
  img { image-rendering: pixelated; display: block; }
  .drift { margin-top: 12px; font-size: 12px; }
  .clean { color: #7fae5a; }
  .none { color: #6f675b; }
  .bad { color: #e0794f; }
  .bad ul { margin: 6px 0 0; padding-left: 18px; }
  .swatch { display: inline-block; width: 10px; height: 10px; margin-right: 5px;
            border: 1px solid #4a4038; vertical-align: -1px; }
  .prompt { margin-top: 12px; color: #7d7466; font-size: 12px; word-break: break-word; }
  /* The repeat. A 16px ground tile judged alone is a thumbnail, and thumbnails lie —
     every artefact that matters in a terrain texture is a repetition artefact. */
  .field { margin-top: 14px; padding: 12px; background: #12100d; border-radius: 4px; }
  .field-label { color: #6f675b; font-size: 11px; margin-bottom: 8px; }
  .tiled { image-rendering: pixelated; border: 1px solid #2c261f; }
  .metrics { margin-top: 8px; font-size: 11px; color: #8d8375; }
  .metrics b { color: #cbb99b; font-weight: 600; }
  .calm { color: #7fae5a; }
  .noisy { color: #e0794f; }
`;

function driftHtml(report: PaletteReport): string {
  if (!report.measured) {
    return '<div class="drift none">palette not measured — none configured in art/manifest.json</div>';
  }
  if (report.offPalette.length === 0) {
    return '<div class="drift clean">palette clean</div>';
  }
  const items = report.offPalette
    .map(
      (color) =>
        `<li><span class="swatch" style="background:${escapeHtml(color.hex)}"></span>` +
        `${escapeHtml(color.hex)} — ${color.pixels}px, nearest ${escapeHtml(color.nearest)}</li>`,
    )
    .join('');
  return `<div class="drift bad">${report.offPalette.length} off-palette colour(s), ${report.totalOffPixels}px<ul>${items}</ul></div>`;
}

/**
 * The 4x4 repeat, drawn as a tiled CSS background rather than sixteen `<img>` tags.
 *
 * This is the panel the terrain pass exists for. A tile that looks lovely on its own can
 * read as static once sixty-four copies sit edge to edge: a bright clod becomes a
 * polka-dot lattice, a dark streak becomes a corduroy stripe, and a seam becomes a grid.
 * None of that is visible at 1x, 3x or 6x on a lone sprite, which is why those three
 * scales were never enough to judge ground by.
 *
 * The numbers underneath are the same judgement in a form you can compare across rerolls.
 * The thresholds are deliberately soft — a hint about where to look, never a gate.
 */
function fieldHtml(asset: SheetAsset): string {
  const { entry, field } = asset;
  if (!field) return '';

  const w = entry.width * REPEAT_ZOOM;
  const h = entry.height * REPEAT_ZOOM;
  const axis =
    entry.tileX && entry.tileY ? 'tiles both axes' : entry.tileX ? 'tiles in x' : 'tiles in y';
  const contrast = field.lumaSd <= 14 ? 'calm' : field.lumaSd <= 22 ? '' : 'noisy';
  const values = field.distinct <= 5 ? 'calm' : field.distinct <= 8 ? '' : 'noisy';
  // Banding is scored tighter than contrast because it is the one that ruins a field
  // outright: a stray row is a stripe across the whole world, not a slightly busier tile.
  const banding = field.banding <= 6 ? 'calm' : field.banding <= 12 ? '' : 'noisy';

  return `      <div class="field">
        <div class="field-label">${REPEAT}&times;${REPEAT} repeat at ${REPEAT_ZOOM}&times; &middot; ${axis} &middot; judge the field, not the sprite</div>
        <div class="tiled" style="width:${w * REPEAT}px;height:${h * REPEAT}px;background-image:url(${asset.dataUri});background-size:${w}px ${h}px;background-repeat:repeat"></div>
        <div class="metrics">
          contrast <b class="${contrast}">sd ${field.lumaSd.toFixed(1)}</b> &middot;
          <b class="${values}">${field.distinct} value(s)</b> &middot;
          dominant <b>${escapeHtml(field.dominantHex)} ${field.dominantShare.toFixed(0)}%</b> &middot;
          banding <b class="${banding}">${field.banding.toFixed(1)}</b>
        </div>
      </div>`;
}

function cardHtml(asset: SheetAsset): string {
  const { entry } = asset;
  const scales = [1, 3, 6]
    .map(
      (scale) =>
        `<div class="scale"><img src="${asset.dataUri}" width="${entry.width * scale}" ` +
        `height="${entry.height * scale}" alt="${escapeHtml(entry.id)} at ${scale}x"><span>${scale}&times;</span></div>`,
    )
    .join('');

  return `    <div class="card">
      <div class="id">${escapeHtml(entry.id)}</div>
      <div class="facts">${entry.width}&times;${entry.height} &middot; ${escapeHtml(entry.atlasGroup)} &middot; ${escapeHtml(entry.anchor)} &middot; seed ${asset.seed ?? '—'} &middot; ${(asset.bytes / 1024).toFixed(1)} KB</div>
      <div class="scales">${scales}</div>
${fieldHtml(asset)}
      ${driftHtml(asset.palette)}
      <div class="prompt">${escapeHtml(asset.model)}<br>${escapeHtml(entry.prompt)}</div>
    </div>`;
}

/**
 * One self-contained file: images inlined as data URIs, CSS inline, zero external requests.
 * It has to open from file:// with the network off, because that is when you look at art.
 */
export function buildContactSheet(assets: SheetAsset[]): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Snack Mogul — art contact sheet</title>
<style>${STYLE}</style>
</head>
<body>
<h1>Snack Mogul — art contact sheet</h1>
<p class="sub">${assets.length} asset(s) &middot; generated ${new Date().toISOString()} &middot; self-contained, no network required</p>
<div class="grid">
${assets.map(cardHtml).join('\n')}
</div>
</body>
</html>
`;
}
