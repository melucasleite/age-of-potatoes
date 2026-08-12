// The z-order table, as `RenderLayer` instances.
//
// Plan §13: use v8's `RenderLayer` for z-ordering rather than reparenting objects
// between containers. Reparenting to reorder thrashes the batcher — a sprite that
// changes parent invalidates the batch it was in and the batch it joins. A `RenderLayer`
// leaves the sprite where it logically belongs (so its transform chain is unchanged) and
// only decides *when* it draws.
//
// Most of these slots are empty in v0.1. They exist anyway, in the documented order, so
// that belts and zone paint drop into an already-settled z-order instead of renegotiating
// it against whatever happened to look right on the day.

import { RenderLayer } from 'pixi.js';

/**
 * Bottom to top. Plan §13's layer table verbatim.
 *
 * - `groundBake` / `zonePaint` are chunked `RenderTexture` bakes, re-baked only on edit.
 * - `beltStructures` becomes a tile layer animated by scrolling UVs (v0.3).
 * - `beltItems` becomes a single `ParticleContainer` on one shared `TextureSource`
 *   ([[012]]). Particles support no interactivity — picking there is a sim-side tile
 *   lookup, never a hit test.
 * - `groundEntities` is crops, moisture, and dropped items.
 * - `machines` is ordinary interactive sprites — hundreds, not thousands.
 * - `player` is the player and, later, other pawns.
 * - `worldUi` is the hover highlight, status lamps, and world-space droplets.
 */
export const LAYER_ORDER = [
  'groundBake',
  'zonePaint',
  'beltStructures',
  'beltItems',
  'groundEntities',
  'machines',
  'player',
  'worldUi',
] as const;

export type LayerName = (typeof LAYER_ORDER)[number];

export type Layers = Readonly<Record<LayerName, RenderLayer>>;

/**
 * Build the layer set. The caller must add each layer to the scene graph in
 * `LAYER_ORDER`; the order they are added in *is* the draw order.
 */
export function createLayers(): Layers {
  const layers = {} as Record<LayerName, RenderLayer>;
  for (const name of LAYER_ORDER) {
    layers[name] = new RenderLayer();
  }
  return layers;
}

export function destroyLayers(layers: Layers): void {
  for (const name of LAYER_ORDER) {
    layers[name].destroy();
  }
}
