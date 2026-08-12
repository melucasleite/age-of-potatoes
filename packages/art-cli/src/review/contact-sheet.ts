import type { PaletteReport } from '../post/palette.js';
import type { AssetEntry } from '../manifest.js';

export interface SheetAsset {
  entry: AssetEntry;
  /** Cooked PNG, inlined as a data URI. No file on this page may be an external request. */
  dataUri: string;
  seed: number | null;
  model: string;
  bytes: number;
  palette: PaletteReport;
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
