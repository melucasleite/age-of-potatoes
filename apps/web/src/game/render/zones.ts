// Painted Grow Zones, drawn as REGIONS rather than as tiles.
//
// The failure mode this file exists to avoid: colour every zoned tile and the 8×8 field
// becomes graph paper — sixty-four little boxes, no shape, and a player who cannot see at a
// glance where "the potato patch" begins and ends. A zone is a plan (§5), and a plan reads
// as an outline.
//
// So: a faint wash over the interior, and a hard line ONLY on tiles whose neighbour belongs
// to somebody else. Nine tiles in a square get one border, not nine.
//
// It bakes into the terrain baker's existing overlay pass, which means a zone costs nothing
// per frame — the chunk is re-baked when the paint changes and never again. Noticing the
// change is `sync()` below, which diffs the projection's `field.zone[]` against its own copy
// and marks the affected chunks. Sixty-four integer comparisons a frame, against a re-bake
// loop that would otherwise be invisible because the picture would be correct the whole time.

import type { WorldView } from '@snack/sim';

import type { OverlayPaint } from './terrain';
import { ART } from './textures';
import type { ArtSet } from './textures';

/**
 * Zone colours, by id.
 *
 * Chosen to stay apart in hue AND in lightness, so two adjacent zones are still two zones
 * on a monochrome display or to a red-green colourblind player. Cosmetic and renderer-local:
 * this never enters the sim, is never hashed, and never reaches a save.
 */
const ZONE_TINTS = [
  0x6fc0e8, // sky
  0xe8b53d, // amber
  0x8fd45a, // lime
  0xd2617f, // rose
  0xa98be8, // violet
  0x4bd2b0, // teal
  0xe8804b, // ember
  0xd8d8d8, // chalk
] as const;

const FILL_ALPHA = 0.16;
const EDGE_ALPHA = 0.85;

export function zoneTint(zoneId: number): number {
  if (zoneId <= 0) return 0xffffff;
  return ZONE_TINTS[(zoneId - 1) % ZONE_TINTS.length]!;
}

export class ZoneOverlay {
  /** This renderer's copy of `field.zone[]`. Never a reference into the projection (§12). */
  private readonly zones: number[] = [];
  private originX = 0;
  private originY = 0;
  private tilesWide = 0;
  private tilesHigh = 0;

  private readonly fill: OverlayPaint;
  private readonly edges: readonly OverlayPaint[];
  /** Rebuilt in place per query; the baker consumes it before the next call. */
  private readonly scratch: OverlayPaint[] = [];

  constructor(art: ArtSet) {
    this.fill = { texture: art.get(ART.uiZoneFill), tint: 0xffffff, alpha: FILL_ALPHA };
    this.edges = [
      { texture: art.get(ART.uiZoneEdgeN), tint: 0xffffff, alpha: EDGE_ALPHA },
      { texture: art.get(ART.uiZoneEdgeE), tint: 0xffffff, alpha: EDGE_ALPHA },
      { texture: art.get(ART.uiZoneEdgeS), tint: 0xffffff, alpha: EDGE_ALPHA },
      { texture: art.get(ART.uiZoneEdgeW), tint: 0xffffff, alpha: EDGE_ALPHA },
    ];
  }

  /**
   * Fold this frame's zone map in, marking any chunk whose paint changed.
   *
   * Returns true when something moved, so the caller can skip work on the overwhelming
   * majority of frames where nobody painted anything.
   */
  sync(view: WorldView, markTileDirty: (tileX: number, tileY: number) => void): boolean {
    const field = view.field;
    const count = field.zone.length;
    let changed = false;

    if (
      this.tilesWide !== field.tilesWide ||
      this.tilesHigh !== field.tilesHigh ||
      this.originX !== field.originX ||
      this.originY !== field.originY ||
      this.zones.length !== count
    ) {
      this.originX = field.originX;
      this.originY = field.originY;
      this.tilesWide = field.tilesWide;
      this.tilesHigh = field.tilesHigh;
      this.zones.length = count;
      for (let i = 0; i < count; i++) this.zones[i] = -1;
    }

    for (let i = 0; i < count; i++) {
      const next = field.zone[i] ?? 0;
      if (this.zones[i] === next) continue;
      this.zones[i] = next;
      changed = true;

      // A tile's own paint changed, and so did its neighbours' borders — an edge belongs to
      // the tile that draws it, so the tile next door has to be re-baked too or a boundary
      // is left hanging in mid-field.
      const tileX = this.originX + (i % this.tilesWide);
      const tileY = this.originY + Math.floor(i / this.tilesWide);
      markTileDirty(tileX, tileY);
      markTileDirty(tileX - 1, tileY);
      markTileDirty(tileX + 1, tileY);
      markTileDirty(tileX, tileY - 1);
      markTileDirty(tileX, tileY + 1);
    }

    return changed;
  }

  /** The overlay pass for one world tile. Called only during a chunk bake. */
  paints(tileX: number, tileY: number): readonly OverlayPaint[] | null {
    const zone = this.zoneAt(tileX, tileY);
    if (zone === 0) return null;

    const tint = zoneTint(zone);
    const out = this.scratch;
    out.length = 0;

    this.fill.tint = tint;
    out.push(this.fill);

    // North, east, south, west — in the order the edge textures were built.
    const neighbours = [
      this.zoneAt(tileX, tileY - 1),
      this.zoneAt(tileX + 1, tileY),
      this.zoneAt(tileX, tileY + 1),
      this.zoneAt(tileX - 1, tileY),
    ];
    for (let i = 0; i < 4; i++) {
      if (neighbours[i] === zone) continue;
      const edge = this.edges[i]!;
      edge.tint = tint;
      out.push(edge);
    }

    return out;
  }

  /** Zone id at a world tile, or 0 off the field. Reads the copy, never the projection. */
  private zoneAt(tileX: number, tileY: number): number {
    const x = tileX - this.originX;
    const y = tileY - this.originY;
    if (x < 0 || y < 0 || x >= this.tilesWide || y >= this.tilesHigh) return 0;
    return this.zones[y * this.tilesWide + x] ?? 0;
  }
}
