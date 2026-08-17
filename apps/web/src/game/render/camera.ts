// The camera: integer zoom, pixel-snapped translation, and the exact inverse of both.
//
// Camera state is RENDERER state. Plan §12: camera pan and camera zoom are not
// `Command`s, are never recorded in the trace, and never touch the world. A replay that
// depended on where somebody was looking would not be a replay.
//
// Two rules from §13, and the reason each is not a preference:
//
//   INTEGER ZOOM ONLY. A 2.4× zoom on 32px tiles shimmers, and the problem is
//   arithmetic rather than filtering: fractional scaling maps source pixels onto
//   non-integer device pixels, so some source pixels get two device pixels and their
//   neighbours get three. No filter mode saves that. `ZOOM_LEVELS` is the whole
//   permitted set, `ZoomLevel` makes a fractional zoom a type error, and `apply()`
//   re-checks at runtime because a number can always arrive from somewhere untyped.
//
//   SNAP THE TRANSLATION. §13 calls this the one-line fix for "why does my pixel art
//   jitter when I walk". Snapping happens twice below, on purpose, and the difference
//   matters:
//     1. the camera centre is snapped to whole SOURCE pixels — `Math.round(x*z)/z` —
//        so the world does not slide by a third of a texel while the player walks;
//     2. the offset actually written to `worldRoot.position` is then snapped to whole
//        DEVICE pixels, because with `autoDensity` a CSS pixel is `resolution` device
//        pixels and on a fractional-DPR display an integer CSS px is still a fractional
//        device px.
//
// `transform` exposes THE NUMBERS THAT WERE ACTUALLY APPLIED. Picking inverts those and
// never recomputes them from camera state — see `input/picking.ts`. Inverting an
// idealized un-snapped transform puts the cursor up to a tile off near the viewport
// edges, and the error drifts as you walk, which is a miserable bug to chase.

import type { Container } from 'pixi.js';

/**
 * Every zoom this game will ever have. Plan §13; v0.1 ships fixed at the default rung (§16.3).
 *
 * HALVED WHEN `TILE_PX` WENT 16 → 32, because a rung is only meaningful as the product
 * `TILE_PX * zoom` — the CSS pixels one tile actually occupies. The old ladder at 32px source
 * would have topped out at 6 × 32 = 192 CSS px per tile, which is four tiles across a laptop.
 *
 * The new rungs reproduce the old ladder's 2×, 4× and 6× views EXACTLY (32, 64 and 96 CSS px
 * per tile), and add a closer one on top. What is lost is the old 3× — 48 CSS px per tile —
 * and it cannot be recovered: 48 / 32 is 1.5, and a fractional zoom is the one thing this
 * ladder exists to forbid. See `DEFAULT_ZOOM_INDEX` for where that leaves the default view.
 */
export const ZOOM_LEVELS = [1, 2, 3, 4] as const;

export type ZoomLevel = (typeof ZOOM_LEVELS)[number];

/**
 * §16.3 pins v0.1 here. The ladder exists; the level does not move in v0.1.
 *
 * STILL INDEX 1, and the index rather than the factor is the load-bearing part — `input/lod.ts`
 * seeds `viewLod` from `ZOOM_LEVELS[1]` independently, so a default that moved off 1 would have
 * to move in two files or the renderer's first frame would disagree with the camera's.
 *
 * Index 1 is now 2×, i.e. 64 CSS px per tile against the old default's 48. The old 3× rung is
 * gone (see above) and 2× is the nearer survivor: on a 1920×1080 viewport the view goes from
 * 40 × 22.5 tiles to 30 × 16.9 — a third closer in, where index 0 would have been half again
 * further out. Closer is also the safer miss of the two, since it is the direction that keeps
 * the newly doubled art legible.
 */
export const DEFAULT_ZOOM_INDEX = 1;

/** The transform that reached the display this frame. The only thing picking may invert. */
export interface AppliedTransform {
  /** Integer scale factor applied to the world root. */
  readonly zoom: number;
  /** World-root position in CSS px, already snapped to whole device pixels. */
  readonly offsetX: number;
  readonly offsetY: number;
  /** Viewport in CSS px. */
  readonly viewWidth: number;
  readonly viewHeight: number;
  /** Device pixels per CSS pixel. */
  readonly resolution: number;
}

export interface WorldRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class Camera {
  /** Camera centre in world pixels. May be fractional; what reaches the screen is not. */
  centerX = 0;
  centerY = 0;

  private zoomIndex = DEFAULT_ZOOM_INDEX;
  private viewWidth = 1;
  private viewHeight = 1;
  private resolution = 1;

  private applied: AppliedTransform = {
    zoom: ZOOM_LEVELS[DEFAULT_ZOOM_INDEX]!,
    offsetX: 0,
    offsetY: 0,
    viewWidth: 1,
    viewHeight: 1,
    resolution: 1,
  };

  get zoom(): number {
    return ZOOM_LEVELS[this.zoomIndex]!;
  }

  /** The transform that was last written to the world root. Picking inverts this. */
  get transform(): AppliedTransform {
    return this.applied;
  }

  setZoomIndex(index: number): void {
    this.zoomIndex = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, Math.trunc(index)));
  }

  get zoomIndex_(): number {
    return this.zoomIndex;
  }

  setViewport(widthCss: number, heightCss: number, resolution: number): void {
    this.viewWidth = Math.max(1, widthCss);
    this.viewHeight = Math.max(1, heightCss);
    this.resolution = resolution > 0 ? resolution : 1;
  }

  /** Point the camera at a world-pixel position. Cosmetic; nothing downstream is a command. */
  lookAt(worldX: number, worldY: number): void {
    this.centerX = worldX;
    this.centerY = worldY;
  }

  /**
   * Keep the world on screen: centre it on whichever axes it fits, clamp on the rest.
   *
   * The centring branch is a leftover kindness from the 16×16 lot, which fitted inside most
   * viewports whole. Land deeds took the world to 64×64 tiles — 2,048 world px at `TILE_PX` 32,
   * so 4,096 CSS px at the default zoom — so on any ordinary screen this now clamps on both axes
   * and the camera genuinely follows the player. The branch stays because it is still reachable,
   * though the doubled tile made it rarer: it needs the bottom rung (1×, where the lot is 2,048
   * CSS px) on a display wider than that, or a future scenario shipping a small lot.
   */
  clampToWorld(worldWidthPx: number, worldHeightPx: number): void {
    const zoom = this.zoom;
    const halfViewX = this.viewWidth / (2 * zoom);
    const halfViewY = this.viewHeight / (2 * zoom);

    this.centerX =
      worldWidthPx <= halfViewX * 2
        ? worldWidthPx / 2
        : Math.min(Math.max(this.centerX, halfViewX), worldWidthPx - halfViewX);
    this.centerY =
      worldHeightPx <= halfViewY * 2
        ? worldHeightPx / 2
        : Math.min(Math.max(this.centerY, halfViewY), worldHeightPx - halfViewY);
  }

  /**
   * Write scale and position onto the world root, and record what was written.
   *
   * Call this exactly once per frame, before anything reads `transform`.
   */
  apply(worldRoot: Container): void {
    const zoom = this.zoom;
    if (!Number.isInteger(zoom)) {
      // Unreachable through `ZoomLevel`, which is the point — but a number can always
      // arrive from JSON, a query string, or a future settings panel.
      throw new RangeError(`camera: zoom must be an integer, got ${zoom}`);
    }

    // 1. Snap the camera centre to whole source pixels (§13's `Math.round(x*z)/z`).
    const snappedCentreX = Math.round(this.centerX * zoom) / zoom;
    const snappedCentreY = Math.round(this.centerY * zoom) / zoom;

    // 2. Snap what actually reaches the display to whole device pixels.
    const rawOffsetX = this.viewWidth / 2 - snappedCentreX * zoom;
    const rawOffsetY = this.viewHeight / 2 - snappedCentreY * zoom;
    const res = this.resolution;
    const offsetX = Math.round(rawOffsetX * res) / res;
    const offsetY = Math.round(rawOffsetY * res) / res;

    worldRoot.scale.set(zoom, zoom);
    worldRoot.position.set(offsetX, offsetY);

    this.applied = {
      zoom,
      offsetX,
      offsetY,
      viewWidth: this.viewWidth,
      viewHeight: this.viewHeight,
      resolution: res,
    };
  }

  /** CSS px within the canvas → world pixels, through the transform actually applied. */
  screenToWorld(cssX: number, cssY: number): { x: number; y: number } {
    const t = this.applied;
    return { x: (cssX - t.offsetX) / t.zoom, y: (cssY - t.offsetY) / t.zoom };
  }

  /** World pixels → CSS px within the canvas. The exact inverse of `screenToWorld`. */
  worldToScreen(worldX: number, worldY: number): { x: number; y: number } {
    const t = this.applied;
    return { x: worldX * t.zoom + t.offsetX, y: worldY * t.zoom + t.offsetY };
  }

  /** The visible world rect, used for the analytic chunk cull and by picking. */
  cameraRect(): WorldRect {
    const t = this.applied;
    return {
      x: -t.offsetX / t.zoom,
      y: -t.offsetY / t.zoom,
      width: t.viewWidth / t.zoom,
      height: t.viewHeight / t.zoom,
    };
  }
}
