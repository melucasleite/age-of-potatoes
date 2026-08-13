// GENERATED FILE — do not edit by hand.
// Written by `node art/tools/make-ui-font.mjs`, which also writes art/local/ui_font.png.
//
// The font is MONOSPACED, so there are no per-glyph metrics: a character's cell is
// `index % columns` across and `index / columns` down the frame, every advance is
// `cellWidth`, and `chars` below is the index order. That is the entire shared contract
// between the generator and `render/font.ts`.

export const UI_FONT = {
  /** The family name `BitmapText` styles ask for. */
  family: 'snack',
  cellWidth: 6,
  cellHeight: 10,
  columns: 32,
  /** Baseline-to-baseline. One row of leading over the cell. */
  lineHeight: 11,
  /** The size at which one font pixel is one screen pixel. Multiply by an integer to zoom. */
  fontSize: 10,
  /** Every character the font can draw, in cell order. Anything else draws nothing. */
  chars:
    ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~·—–×−↑↓←→',
} as const;
