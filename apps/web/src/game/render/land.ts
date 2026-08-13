// Land you do not own yet, drawn as ground rather than as an edge of the world.
//
// The whole point of the deed mechanic is that the rest of the lot is VISIBLY THERE and
// visibly for sale (plan §5). So unowned parcels are not culled, not blacked out, and not
// fenced off by an invisible wall the camera refuses to cross — they are the same grass,
// under a shadow, with a hard line along the boundary where somebody else's land begins.
//
// It bakes into the terrain baker's OVERLAY pass, exactly as `zones.ts` does, and for exactly
// the same reason: ownership changes on an edit — a deed bought — and never on a frame, so a
// re-bake is the right shape and the picture then costs nothing per frame. The two overlays
// cannot collide: zone paint only exists on field tiles, and the field is inside the starting
// parcel, which is owned by every world that has ever existed.
//
// The DARK WASH RATHER THAN A DIFFERENT GROUND TEXTURE is a deliberate art-pipeline decision.
// A "wild grass" tile set would be four more sprites in the atlas, a palette pass, and a
// second bake path — for a picture the player reads in one glance either way. Tint and alpha
// are already what the overlay pass carries.

import type { WorldView } from '@snack/sim';

import type { OverlayPaint } from './terrain';
import { ART } from './textures';
import type { ArtSet } from './textures';

/** Deep and desaturated: the land is in shadow, not in fog. */
const UNOWNED_TINT = 0x1d2418;
const FILL_ALPHA = 0.42;
/** The fence line. Brighter than the wash, because a boundary is a fact, not a mood. */
const EDGE_TINT = 0xd8c9a4;
const EDGE_ALPHA = 0.8;

export class LandOverlay {
  /** This renderer's copy of `view.land.owned`. Never a reference into the projection (§12). */
  private readonly owned: number[] = [];
  private parcelTiles = 16;
  private parcelsWide = 1;
  private parcelsHigh = 1;

  private readonly fill: OverlayPaint;
  private readonly edges: readonly OverlayPaint[];
  /** Rebuilt in place per query; the baker consumes it before the next call. */
  private readonly scratch: OverlayPaint[] = [];

  constructor(art: ArtSet) {
    this.fill = { texture: art.get(ART.uiZoneFill), tint: UNOWNED_TINT, alpha: FILL_ALPHA };
    this.edges = [
      { texture: art.get(ART.uiZoneEdgeN), tint: EDGE_TINT, alpha: EDGE_ALPHA },
      { texture: art.get(ART.uiZoneEdgeE), tint: EDGE_TINT, alpha: EDGE_ALPHA },
      { texture: art.get(ART.uiZoneEdgeS), tint: EDGE_TINT, alpha: EDGE_ALPHA },
      { texture: art.get(ART.uiZoneEdgeW), tint: EDGE_TINT, alpha: EDGE_ALPHA },
    ];
  }

  /**
   * Fold this frame's ownership in. Returns true when it changed — which happens on the tick a
   * deed is bought and on the frame a world is loaded, and on no other frame in the session.
   *
   * The caller re-bakes EVERY chunk on a true, rather than the chunks of the parcel that
   * changed. A parcel is sixteen tiles a side and its neighbours' fence lines move with it, so
   * "the chunks that changed" is most of the map anyway — and this runs once per purchase.
   */
  sync(view: WorldView): boolean {
    const land = view.land;
    let changed =
      this.parcelTiles !== land.parcelTiles ||
      this.parcelsWide !== land.parcelsWide ||
      this.parcelsHigh !== land.parcelsHigh ||
      this.owned.length !== land.owned.length;

    this.parcelTiles = land.parcelTiles;
    this.parcelsWide = land.parcelsWide;
    this.parcelsHigh = land.parcelsHigh;

    for (let i = 0; i < land.owned.length; i++) {
      if (this.owned[i] !== land.owned[i]) changed = true;
      this.owned[i] = land.owned[i]!;
    }
    this.owned.length = land.owned.length;

    return changed;
  }

  /** The overlay pass for one world tile. Called only during a chunk bake. */
  paints(tileX: number, tileY: number): readonly OverlayPaint[] | null {
    if (this.isOwned(tileX, tileY)) return null;

    const out = this.scratch;
    out.length = 0;
    out.push(this.fill);

    // North, east, south, west — the order the edge textures were built in. An edge is drawn
    // by the tile that owns it and only where the neighbour is on the other side of the fence,
    // so a whole parcel gets one outline rather than 256 little boxes.
    if (this.isOwned(tileX, tileY - 1)) out.push(this.edges[0]!);
    if (this.isOwned(tileX + 1, tileY)) out.push(this.edges[1]!);
    if (this.isOwned(tileX, tileY + 1)) out.push(this.edges[2]!);
    if (this.isOwned(tileX - 1, tileY)) out.push(this.edges[3]!);

    return out;
  }

  /**
   * Ownership at a world tile. Off the map counts as OWNED, which reads backwards and is not:
   * this is only ever asked about a neighbour, and the question it answers is "does a fence go
   * here". The world's outer edge is not a fence between two lots, and drawing one there would
   * put a bright line around the entire map.
   */
  private isOwned(tileX: number, tileY: number): boolean {
    const width = this.parcelsWide * this.parcelTiles;
    const height = this.parcelsHigh * this.parcelTiles;
    if (tileX < 0 || tileY < 0 || tileX >= width || tileY >= height) return true;

    const parcel =
      Math.floor(tileY / this.parcelTiles) * this.parcelsWide +
      Math.floor(tileX / this.parcelTiles);
    for (let i = 0; i < this.owned.length; i++) {
      if (this.owned[i] === parcel) return true;
    }
    return false;
  }
}
