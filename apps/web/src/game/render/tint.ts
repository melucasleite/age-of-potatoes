// The arithmetic every white-art sprite in this renderer depends on and nobody had written down.
//
// A pile of frames in this game are drawn near-white on purpose and MULTIPLIED by a colour at
// draw time: the status lamps, the pipe frames, `ui_hover`, `ui_pixel`, the bitmap font. That
// is what buys thirty machines' worth of state animation for the cost of one sprite (§13).
//
// The part that is easy to get wrong: "near-white" is not white. The master palette's lightest
// value is `paper` (#efe2c6) — warm, and 6% down from white on the blue channel — because
// AGENTS.md requires every cooked pixel to be ON the palette and white is not on it. So a
// sprite tinted with the palette's own `lamp_running` does NOT come out as `lamp_running`; it
// comes out as `lamp_running × paper`, which is darker and warmer than the swatch the palette
// author picked and wrote a readability note about.
//
// That note is not decoration. `red_bright`'s role reads "chosen to survive as 3-4 pixels on
// soil_mid or metal_mid", and a promise like that only holds if the pixel on screen is actually
// that colour. So the tint is PRE-DIVIDED here: hand `overPaper` the colour you want to see and
// it returns the tint that produces it.
//
// The alternative — writing hand-tuned hexes into the renderer, which is what lamps.ts used to
// do — puts a second, drifting copy of the status palette in a file the palette gate never
// looks at. Two of the six had already drifted off their swatch by a visible amount.

/** The palette's lightest value, and the colour every tintable frame is drawn in. */
export const PAPER = 0xefe2c6;

/**
 * The tint that makes a `paper`-drawn sprite come out as `target`.
 *
 * Channels of `target` brighter than `paper` cannot be reached by a multiply — the two in the
 * palette that clip are `lamp_starved`'s red (242 vs 239) and `water_bright`'s blue (209 vs
 * 198), both under 5% and both invisible. They clamp to full rather than wrapping.
 */
export function overPaper(target: number): number {
  return (channel(target, 16) << 16) | (channel(target, 8) << 8) | channel(target, 0);
}

function channel(target: number, shift: number): number {
  const want = (target >> shift) & 0xff;
  const have = (PAPER >> shift) & 0xff;
  if (want >= have) return 0xff;
  return Math.round((want * 255) / have);
}
