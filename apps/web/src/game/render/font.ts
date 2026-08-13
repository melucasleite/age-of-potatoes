// The game's own bitmap font, installed from the atlas.
//
// ── WHAT THIS REPLACES AND WHY IT HAD TO GO ─────────────────────────────────────────────
//
// Every text site in this renderer used to construct a Pixi `Text` asking for `ui-monospace,
// SFMono-Regular, Menlo, monospace`. Two things are wrong with that, and §15 names both:
//
//   1. It is the BROWSER'S font. Which face you get depends on the platform, so the HUD is a
//      different width on a Mac and a Windows box, and the plaque that fits at 360px on one
//      overflows on the other. Nothing in the repo can test that.
//   2. It is rasterised through a glyph atlas the browser builds at whatever size is asked
//      for, with hinting and antialiasing. Against 16px tiles drawn nearest-neighbour at
//      integer zoom, that is a shimmering off-palette smear sitting on top of pixel art —
//      the exact thing §13's pixel-perfect rules exist to prevent.
//
// The font itself is `art/tools/make-ui-font.mjs`, it flows through the normal pipeline as
// `provider: "local"`, and it lands on the atlas as one 192x40 frame in its own group. This
// module is the ten lines that turn that frame into something `BitmapText` will draw.
//
// ── WHY THE METRICS ARE ARITHMETIC AND NOT A FILE ───────────────────────────────────────
//
// The font is monospaced, so there is nothing to look up: a character's cell is `index %
// columns` across and `index / columns` down, every advance is one cell, and the only shared
// datum is the character ORDER. That comes out of the generator as `ui-font.generated.ts`, so
// the tool and this file cannot drift — there is no second copy to drift from.
//
// ── WHY NOTHING EVER UNINSTALLS IT ──────────────────────────────────────────────────────
//
// `BitmapFont.destroy()` calls `texture.destroy(true)` on each page — and this font's page IS
// the shared atlas. Destroying the font would take the atlas source with it and hand every
// sprite in the game a dead texture. `textures.ts` reaches the same conclusion about the
// spritesheet for the same reason ("the atlas is owned by the Assets cache and is deliberately
// left alone"), and React StrictMode remounting a second host immediately is what makes it
// bite. So: install once, idempotent, never destroy. It costs one cache entry.

import { BitmapFont, BitmapText, Cache } from 'pixi.js';
import type { TextStyleOptions } from 'pixi.js';

import { UI_FONT } from '@/art/ui-font.generated';

import { ART } from './textures';
import type { ArtSet } from './textures';

/** The family name to put in a `BitmapText` style. */
export const UI_FONT_FAMILY = UI_FONT.family;

/**
 * One font pixel per screen pixel. Multiply by an integer for larger text and it stays crisp;
 * anything else lands glyph edges on fractions and the whole point is lost.
 */
export const UI_FONT_SIZE = UI_FONT.fontSize;

/** The width of `n` characters at `size`, for laying panels out without measuring text. */
export function uiTextWidth(characters: number, size: number = UI_FONT_SIZE): number {
  return Math.round((characters * UI_FONT.cellWidth * size) / UI_FONT.fontSize);
}

/** Baseline-to-baseline at `size`. */
export function uiLineHeight(size: number = UI_FONT_SIZE): number {
  return Math.round((UI_FONT.lineHeight * size) / UI_FONT.fontSize);
}

/**
 * Install the font from the atlas frame. Safe to call on every scene build.
 *
 * Returns false when the atlas has not shipped `ui_font` — the grey-box build, where the whole
 * art set is generated placeholders. Text still draws there, through Pixi's dynamic fallback
 * and therefore through a browser font; that is the same bargain `textures.ts` already makes
 * ("a playable grey-box build beats a beautiful one that does not run") and it is the ONLY
 * path on which a browser font can appear.
 */
export function installUiFont(art: ArtSet): boolean {
  if (Cache.has(`${UI_FONT_FAMILY}-bitmap`)) return true;
  if (!art.isReal(ART.uiFont)) {
    console.warn(
      `[snack] the atlas has no "${ART.uiFont}" frame — falling back to a browser font. ` +
        `Run \`yarn art pack\`.`,
    );
    return false;
  }

  const page = art.get(ART.uiFont);
  const chars: Record<string, RawChar> = {};

  // `BitmapFont` resolves each char's rect against the page texture's own frame, so these
  // coordinates are cell offsets inside the frame and not atlas coordinates. That is what
  // lets the font ride the shared atlas instead of needing a page to itself.
  [...UI_FONT.chars].forEach((character, index) => {
    chars[character] = {
      id: character.codePointAt(0) ?? 0,
      page: 0,
      x: (index % UI_FONT.columns) * UI_FONT.cellWidth,
      y: Math.floor(index / UI_FONT.columns) * UI_FONT.cellHeight,
      width: UI_FONT.cellWidth,
      height: UI_FONT.cellHeight,
      xOffset: 0,
      yOffset: 0,
      xAdvance: UI_FONT.cellWidth,
      kerning: {},
      letter: character,
    };
  });

  const font = new BitmapFont({
    data: {
      pages: [{ id: 0, file: ART.uiFont }],
      chars,
      fontFamily: UI_FONT_FAMILY,
      fontSize: UI_FONT.fontSize,
      lineHeight: UI_FONT.lineHeight,
      // Zero, not a real baseline: every glyph quad is a whole cell with `yOffset: 0`, so the
      // text box starts at the cell top and a caller positioning a line at y=12 gets its
      // topmost ink at y=12. A non-zero baseline offset here would silently shift every
      // panel's text down by that many pixels relative to the box drawn behind it.
      baseLineOffset: 0,
    },
    textures: [page],
  });

  Cache.set(`${UI_FONT_FAMILY}-bitmap`, font);
  return true;
}

/**
 * A `BitmapText` in the game font.
 *
 * `fill` defaults to white, which multiplies the `paper`-drawn glyphs to exactly `paper` —
 * the palette's declared "UI text-on-dark" value. Pass a colour through `overPaper` if you
 * want a specific swatch on screen rather than that swatch multiplied by paper.
 */
export function uiText(text: string, style: Partial<TextStyleOptions> = {}): BitmapText {
  return new BitmapText({
    text,
    style: { fontFamily: UI_FONT_FAMILY, fontSize: UI_FONT_SIZE, fill: 0xffffff, ...style },
  });
}

interface RawChar {
  id: number;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  xOffset: number;
  yOffset: number;
  xAdvance: number;
  kerning: Record<string, number>;
  letter: string;
}
