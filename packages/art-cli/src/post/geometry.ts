import type { RawImage } from './raw.js';

export interface StripCluster {
  /** First column containing an opaque pixel, inclusive. */
  start: number;
  /** Last column containing an opaque pixel, inclusive. */
  end: number;
}

export interface StripGeometryReport {
  ok: boolean;
  message: string;
  /** Maximal runs of columns with any opaque pixel, separated by fully transparent columns. */
  clusters: StripCluster[];
}

/**
 * The transparent-gap cluster check, ported from wave 8's strip post-mortem — the gate that
 * separated the one shippable crop strip from twenty-five paid failures.
 *
 * The measured failure mode it catches: at strip resolution, RD's plain endpoint draws
 * plants at its own ~45-55px pitch regardless of the asked count, so a "four plants in four
 * cells" request comes back as three plants straddling cell boundaries. Squinting at the
 * result cannot tell a near-miss from a hit; column arithmetic can.
 *
 * A strip passes when its opaque pixels form exactly one cluster per cell, each cluster
 * confined to its own cell — which is simultaneously the count check (no missing or extra
 * plants), the pitch check (a wrong pitch must straddle a boundary somewhere down the row),
 * and the emptiness check (a vacant cell has no cluster to contribute). Columns are counted
 * at any alpha > 0 so the check means the same thing before and after alpha binarisation.
 */
export function checkStripGeometry(image: RawImage, cells: number): StripGeometryReport {
  if (cells < 1 || image.width % cells !== 0) {
    return {
      ok: false,
      clusters: [],
      message: `strip is ${image.width}px wide, not divisible into ${cells} equal cells`,
    };
  }
  const cellW = image.width / cells;

  const columnOpaque: boolean[] = new Array(image.width).fill(false);
  for (let x = 0; x < image.width; x++) {
    for (let y = 0; y < image.height; y++) {
      if ((image.data[(y * image.width + x) * 4 + 3] ?? 0) > 0) {
        columnOpaque[x] = true;
        break;
      }
    }
  }

  const clusters: StripCluster[] = [];
  let start = -1;
  for (let x = 0; x <= image.width; x++) {
    const opaque = x < image.width && columnOpaque[x];
    if (opaque && start === -1) start = x;
    if (!opaque && start !== -1) {
      clusters.push({ start, end: x - 1 });
      start = -1;
    }
  }

  const describe = clusters
    .map((c) => `[${c.start}-${c.end}] (centre ${((c.start + c.end) / 2).toFixed(1)})`)
    .join(', ');

  if (clusters.length !== cells) {
    return {
      ok: false,
      clusters,
      message:
        `expected ${cells} opaque cluster(s) at a ${cellW}px pitch, found ${clusters.length}: ` +
        `${describe || '(strip is fully transparent)'}`,
    };
  }

  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i] as StripCluster;
    const cellOfStart = Math.floor(cluster.start / cellW);
    const cellOfEnd = Math.floor(cluster.end / cellW);
    if (cellOfStart !== cellOfEnd) {
      return {
        ok: false,
        clusters,
        message:
          `cluster ${i} [${cluster.start}-${cluster.end}] straddles the boundary between cells ` +
          `${cellOfStart} and ${cellOfEnd} — the provider drew at its own pitch, not ${cellW}px`,
      };
    }
    if (cellOfStart !== i) {
      return {
        ok: false,
        clusters,
        message:
          `cluster ${i} [${cluster.start}-${cluster.end}] sits in cell ${cellOfStart} — ` +
          `cell ${i} is empty and cell ${cellOfStart} holds two plants`,
      };
    }
  }

  return {
    ok: true,
    clusters,
    message: `${cells} cluster(s), one per ${cellW}px cell: ${describe}`,
  };
}
