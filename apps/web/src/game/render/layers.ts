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
 * - `beltShapes` is the bends and tees drawn OVER those runs ([[095]]). It is its own slot
 *   rather than a few more sprites in `beltStructures` for a mechanical reason: a
 *   `RenderLayer` draws what is attached to it in attach order, and belt segments are
 *   attached as the player builds them — so an elbow sharing the belt slot would be drawn
 *   over by the next belt laid anywhere on the map. A separate slot makes "the shape wins on
 *   its own tile" a property of the z-order table instead of a property of build order.
 * - `beltItems` becomes a single `ParticleContainer` on one shared `TextureSource`
 *   ([[012]]). Particles support no interactivity — picking there is a sim-side tile
 *   lookup, never a hit test.
 * - `groundEntities` is crops, moisture, and dropped items.
 * - `pipeShade` is the drop shadow every pipe tile casts on whatever it is passing over, and
 *   it is what makes a crossing read as a crossing rather than as a cut belt ([[120]]).
 *   It is its OWN slot rather than a few more sprites in `pipes`, for exactly item 095's
 *   mechanical reason: a `RenderLayer` draws what is attached to it in ATTACH order, and both
 *   pools grow as the player lays pipe, so a shade sharing the pipe slot would be drawn over
 *   by the next pipe tile built anywhere on the map. Being a slot also states the rule the
 *   shadow depends on — it falls ON the belt and UNDER the plumbing — in the one table that
 *   settles z-order, instead of in a sprite's construction order.
 * - `pipes` is the fluid layer, and it runs OVERHEAD ([[120]]) — above the belts, above the
 *   goods riding them, and above the crops. It used to sit under the belts on the reading
 *   that a pipe was ground plumbing and a belt a structure standing on it, which was a fair
 *   tie-break back when the sim refused to let the two share a tile at all. Item 120 made
 *   that sharing legal, so the slot is no longer settling a tie at a seam: it is answering
 *   "which of these two objects is nearer the camera" on a tile that genuinely holds both,
 *   and the answer the sim now gives is the pipe.
 * - `machines` is ordinary interactive sprites — hundreds, not thousands. Pipes stay BELOW
 *   it: a pipe may never share a machine's footprint ([[120]]'s surviving refusal), so this
 *   is still only a seam tie, and a run should read as tucking into the collar rather than
 *   as passing over the roof. `player` is above for a blunter reason — the avatar is the one
 *   sprite a player must never lose, and plumbing is not allowed to swallow it.
 * - `player` is the player and, later, other pawns.
 * - `worldUi` is the hover highlight, status lamps, and world-space droplets.
 */
export const LAYER_ORDER = [
  'groundBake',
  'zonePaint',
  'beltStructures',
  'beltShapes',
  'beltItems',
  'groundEntities',
  'pipeShade',
  'pipes',
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
