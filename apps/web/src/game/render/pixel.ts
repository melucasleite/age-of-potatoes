// Pixel-perfect global setup. THIS MODULE IS IMPORTED FOR ITS SIDE EFFECT.
//
// ────────────────────────────────────────────────────────────────────────────────────
//  IMPORT ORDER HERE IS LOAD-BEARING. Do not move it, do not let a formatter sort it
//  above, and do not "tidy" it into a function.
//
//  `TextureStyle.defaultOptions.scaleMode` is NOT RETROACTIVE. It is read once, when a
//  TextureSource is constructed. Any texture that loads before this assignment keeps
//  linear filtering forever — and the symptom is a single blurry sprite among sharp
//  ones, which reads as an art bug and gets chased in the wrong file for an hour.
//
//  So: this assignment happens at module scope, and every module that can cause a
//  texture to exist (`textures.ts`, `terrain.ts`, `GameHost.ts`) imports this module
//  first. Plan §13.
// ────────────────────────────────────────────────────────────────────────────────────

import { TextureStyle } from 'pixi.js';

TextureStyle.defaultOptions.scaleMode = 'nearest';

/** Source pixels per tile. The whole art pipeline is built on 16px tiles. */
export const TILE_PX = 16;

/**
 * Tiles per chunk edge. 32×32 tiles = 512×512 source px per baked chunk texture.
 * v0.1's world is 16×16 tiles, so the whole lot is exactly one chunk — that is fine and
 * deliberate: the seam is what matters, not the count.
 */
export const CHUNK_TILES = 32;

/** Source pixels per chunk edge. */
export const CHUNK_PX = TILE_PX * CHUNK_TILES;

/** Ticks in one in-game day. Plan §2: the day is 8 real minutes at 20 Hz. */
export const TICKS_PER_DAY = 8 * 60 * 20;

/**
 * Where tick 0 sits in the day. A new world opens at 09:00 in full daylight rather than
 * at midnight, which is what an un-offset phase would give you and is a miserable first
 * five seconds for a game whose whole pitch is a sunny roadside lot.
 */
const DAY_START_PHASE = 9 / 24;

/**
 * The day phase in [0, 1): 0 is midnight, 0.5 is midday.
 *
 * Lives here, in the one module both the clock and the colour matrix import, because a
 * HUD that says 14:00 while the screen is dark is the kind of bug that gets noticed by a
 * player and not by a test.
 */
export function dayPhase(tick: number): number {
  return ((((tick % TICKS_PER_DAY) / TICKS_PER_DAY + DAY_START_PHASE) % 1) + 1) % 1;
}
