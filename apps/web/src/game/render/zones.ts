// Painted Grow Zones, drawn as REGIONS rather than as tiles.
//
// The failure mode this file exists to avoid: colour every zoned tile and the field
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
// and marks the affected chunks. A hundred-odd integer comparisons a frame, against a
// re-bake loop that would otherwise be invisible because the picture would be correct the
// whole time.
//
// ── KEYED TO THE COLLECTION, NOT THE RECT ([[066]]) ──────────────────────────────────
// Farmland is a keyed collection now and zones ride farm tiles, so this copy is a map from
// WORLD TILE KEY to zone id rather than a rect-shaped array. The change test still walks
// the parallel arrays positionally (cheap), but the moment the collection's keys move — a
// till, an un-till — the diff is taken per POSITION against the map, which is what keeps a
// shifted index from repainting sixty tiles that did not change and, worse, from leaving a
// boundary standing on a tile that stopped being farmland.

import {
  WORLD_TILES_HIGH,
  WORLD_TILES_WIDE,
  worldKeyTileX,
  worldKeyTileY,
  worldTileKey,
} from '@snack/sim';
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
  /**
   * This renderer's copy of the zone paint, twice over — never a reference into the
   * projection (§12). The parallel arrays are the cheap per-frame change test; the map is
   * what `paints()` reads during a bake and what the change path diffs against, because a
   * bake asks by world position and so does a boundary.
   */
  private readonly keys: number[] = [];
  private readonly zones: number[] = [];
  private byKey = new Map<number, number>();

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
    const count = field.count;

    // The fast path: same tiles, same paint. One positional walk, no allocation.
    let same = count === this.keys.length;
    if (same) {
      for (let i = 0; i < count; i++) {
        if (
          this.keys[i] !== worldTileKey(field.tileX[i] ?? 0, field.tileY[i] ?? 0) ||
          this.zones[i] !== (field.zone[i] ?? 0)
        ) {
          same = false;
          break;
        }
      }
    }
    if (same) return false;

    // Something moved. Build the new picture, then diff BY POSITION: a position whose zone
    // id changed — painted, erased, or gone with its farmland — re-bakes itself and its four
    // neighbours, because an edge belongs to the tile that draws it and the tile next door
    // has to redraw its side of the fence too.
    const next = new Map<number, number>();
    for (let i = 0; i < count; i++) {
      const zone = field.zone[i] ?? 0;
      if (zone !== 0) next.set(worldTileKey(field.tileX[i] ?? 0, field.tileY[i] ?? 0), zone);
    }

    for (const [key, zone] of next) {
      if ((this.byKey.get(key) ?? 0) !== zone) {
        markAround(markTileDirty, worldKeyTileX(key), worldKeyTileY(key));
      }
    }
    for (const key of this.byKey.keys()) {
      if (!next.has(key)) {
        markAround(markTileDirty, worldKeyTileX(key), worldKeyTileY(key));
      }
    }

    this.byKey = next;
    this.keys.length = count;
    this.zones.length = count;
    for (let i = 0; i < count; i++) {
      this.keys[i] = worldTileKey(field.tileX[i] ?? 0, field.tileY[i] ?? 0);
      this.zones[i] = field.zone[i] ?? 0;
    }
    return true;
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

  /**
   * Zone id at a world tile, or 0 anywhere unzoned. Reads the copy, never the projection.
   *
   * The bounds guard is load-bearing, not politeness: `worldTileKey` is row-major
   * arithmetic, so an unguarded x = -1 would alias to the previous row's far edge and a
   * zone touching the world's west fence would paint the east fence one row up.
   */
  private zoneAt(tileX: number, tileY: number): number {
    if (tileX < 0 || tileY < 0 || tileX >= WORLD_TILES_WIDE || tileY >= WORLD_TILES_HIGH) {
      return 0;
    }
    return this.byKey.get(worldTileKey(tileX, tileY)) ?? 0;
  }
}

/** A changed tile re-bakes itself and its four neighbours — the edge ownership rule. */
function markAround(
  markTileDirty: (tileX: number, tileY: number) => void,
  tileX: number,
  tileY: number,
): void {
  markTileDirty(tileX, tileY);
  markTileDirty(tileX - 1, tileY);
  markTileDirty(tileX + 1, tileY);
  markTileDirty(tileX, tileY - 1);
  markTileDirty(tileX, tileY + 1);
}
